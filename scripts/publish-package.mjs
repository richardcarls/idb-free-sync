'use strict';

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { x as extractTar } from 'tar';

import {
  EXPECTED_GITHUB_REPOSITORY,
  EXPECTED_REPOSITORY_URL,
  NPM_REGISTRY,
  STABLE_TAG_PATTERN,
  assertMinimumVersion,
  execCommand,
  manifestRepositoryUrl,
  spawnCommand,
} from './release-shared.mjs';

// Trusted Publishing (OIDC) landed in the npm CLI at 11.5.1. `yarn npm
// publish` never performs that exchange (it only knows classic token auth),
// so this script has npm itself do the publish; see the comment on
// createPublisherOperations().publish() below.
const MINIMUM_NPM_VERSION = '11.5.1';
const PROVENANCE_PREDICATE = 'https://slsa.dev/provenance/v1';
const REGISTRY_FIELDS = ['name', 'version', 'repository', 'dist.attestations'];
// npm can expose a new version before its provenance metadata finishes
// propagating. Its publish output warns that processing may take a few
// minutes, so keep verification bounded while allowing that delay.
const DEFAULT_POLL_ATTEMPTS = 60;
const DEFAULT_POLL_DELAY_MS = 5_000;

function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function parseJsonObject(output) {
  const trimmed = output.trim();

  if (!trimmed) {
    return undefined;
  }

  return JSON.parse(trimmed);
}

export function normalizeRegistryMetadata(payload) {
  const entries = Array.isArray(payload) ? payload : [payload];

  if (entries.length !== 1 || !entries[0] || typeof entries[0] !== 'object') {
    throw new Error(
      `npm view returned ${entries.length} metadata entries for an exact version`,
    );
  }

  const metadata = { ...entries[0] };
  const flatAttestations = metadata['dist.attestations'];

  if (flatAttestations) {
    metadata.dist = { ...metadata.dist, attestations: flatAttestations };
    delete metadata['dist.attestations'];
  }

  return metadata;
}

function npmErrorCode(result) {
  for (const output of [result.stderr, result.stdout]) {
    if (!output?.trim()) {
      continue;
    }

    try {
      const payload = JSON.parse(output);
      const code = payload?.error?.code ?? payload?.code;

      if (code) {
        return code;
      }
    } catch {
      // npm emits JSON for registry reads; a non-JSON failure is unsafe to classify as E404.
    }
  }

  return undefined;
}

function commandFailure(command, args, result) {
  const detail =
    result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;

  return new Error(`${command} ${args.join(' ')} failed: ${detail}`);
}

export function queryRegistryPackage({ cwd, env, name, version }) {
  const args = [
    'view',
    `${name}@${version}`,
    ...REGISTRY_FIELDS,
    '--json',
    '--registry',
    NPM_REGISTRY,
  ];
  const result = spawnCommand('npm', args, {
    cwd,
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw result.error;
  }

  return interpretRegistryResult(result, args);
}

export function interpretRegistryResult(result, args = ['view']) {
  if (result.status === 0) {
    return {
      metadata: normalizeRegistryMetadata(parseJsonObject(result.stdout)),
      state: 'found',
    };
  }

  if (npmErrorCode(result) === 'E404') {
    return { state: 'missing' };
  }

  throw commandFailure('npm', args, result);
}

function attestationEntries(metadata) {
  const attestations = metadata?.dist?.attestations;

  if (!attestations) {
    return [];
  }

  return Array.isArray(attestations) ? attestations : [attestations];
}

export function hasSlsaProvenance(metadata) {
  return attestationEntries(metadata).some(
    (attestation) =>
      attestation?.provenance?.predicateType === PROVENANCE_PREDICATE ||
      attestation?.predicateType === PROVENANCE_PREDICATE,
  );
}

export function validatePublishedManifest({
  manifest,
  packageName,
  requireProvenance = false,
  version,
}) {
  const errors = [];

  if (manifest?.name !== packageName) {
    errors.push(`name is ${manifest?.name ?? 'missing'}`);
  }

  if (manifest?.version !== version) {
    errors.push(`version is ${manifest?.version ?? 'missing'}`);
  }

  if (manifestRepositoryUrl(manifest ?? {}) !== EXPECTED_REPOSITORY_URL) {
    errors.push('repository URL is missing or incorrect');
  }

  if (requireProvenance && !hasSlsaProvenance(manifest)) {
    errors.push(`dist.attestations lacks ${PROVENANCE_PREDICATE}`);
  }

  if (errors.length > 0) {
    throw new Error(
      `${packageName}@${version} registry validation failed: ${errors.join('; ')}`,
    );
  }
}

export function inspectPackedManifest({
  extractDirectory,
  packageName,
  tarballPath,
}) {
  mkdirSync(extractDirectory, { recursive: true });

  extractTar({
    cwd: extractDirectory,
    file: tarballPath,
    filter: (entryPath) => entryPath === 'package/package.json',
    strict: true,
    sync: true,
  });

  const manifestPath = join(extractDirectory, 'package', 'package.json');

  if (!existsSync(manifestPath)) {
    throw new Error(
      `${packageName}: packed tarball has no package/package.json`,
    );
  }

  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

export function assertLiveEnvironment(env) {
  const credentialVariables = Object.entries(env)
    .filter(([, value]) => Boolean(value))
    .map(([name]) => name)
    .filter((name) => {
      const normalizedName = name.toUpperCase();

      return (
        [
          'NODE_AUTH_TOKEN',
          'NPM_AUTH_TOKEN',
          'NPM_TOKEN',
          'YARN_NPM_AUTH_IDENT',
          'YARN_NPM_AUTH_TOKEN',
        ].includes(normalizedName) ||
        /^NPM_CONFIG_.*(?:AUTH|OTP|PASSWORD|TOKEN|USERNAME)/i.test(name)
      );
    });

  if (credentialVariables.length > 0) {
    throw new Error(
      `Refusing token fallback; unset npm authentication variables: ${credentialVariables.join(', ')}`,
    );
  }

  if (env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Live publication is restricted to GitHub Actions');
  }

  if (env.GITHUB_REPOSITORY !== EXPECTED_GITHUB_REPOSITORY) {
    throw new Error(`GITHUB_REPOSITORY must be ${EXPECTED_GITHUB_REPOSITORY}`);
  }

  const tag =
    env.GITHUB_REF_NAME ?? env.GITHUB_REF?.replace(/^refs\/tags\//, '');
  const isTag =
    env.GITHUB_REF_TYPE === 'tag' || env.GITHUB_REF?.startsWith('refs/tags/');

  if (!isTag || !STABLE_TAG_PATTERN.test(tag ?? '')) {
    throw new Error('Live publication requires a stable vX.Y.Z GitHub tag ref');
  }

  if (
    !env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ) {
    throw new Error(
      'GitHub OIDC request variables are unavailable; grant id-token: write',
    );
  }

  return tag.slice(1);
}

function createNpmEnvironment(runtimeDirectory, env) {
  const userConfig = join(runtimeDirectory, 'user.npmrc');
  const globalConfig = join(runtimeDirectory, 'global.npmrc');

  writeFileSync(userConfig, '');
  writeFileSync(globalConfig, '');

  const npmEnvironment = Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !/^NPM_CONFIG_(?:CACHE|GLOBALCONFIG|PREFER_ONLINE|REGISTRY|USERCONFIG)$/i.test(
          name,
        ),
    ),
  );

  return {
    ...npmEnvironment,
    NPM_CONFIG_CACHE: join(runtimeDirectory, 'npm-cache'),
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_PREFER_ONLINE: 'true',
    NPM_CONFIG_REGISTRY: NPM_REGISTRY,
    NPM_CONFIG_USERCONFIG: userConfig,
  };
}

export function createPublisherOperations({
  env,
  packageName,
  root,
  runtimeDirectory,
}) {
  const npmEnvironment = createNpmEnvironment(runtimeDirectory, env);

  return {
    pack() {
      const tarballPath = join(runtimeDirectory, 'package.tgz');
      const extractDirectory = join(runtimeDirectory, 'unpacked');

      execCommand('yarn', ['pack', '--out', tarballPath], {
        cwd: root,
        encoding: 'utf8',
      });

      return {
        manifest: inspectPackedManifest({
          extractDirectory,
          packageName,
          tarballPath,
        }),
        tarballPath,
      };
    },

    // Yarn packs the tarball so any `workspace:*`-style ranges would already
    // be real versions, but npm performs the actual registry publish: Yarn
    // 4's `yarn npm publish` never exchanges this job's GitHub OIDC token for
    // a registry credential, while the npm CLI (>=11.5.1) does so
    // automatically for a Trusted Publisher-configured package running
    // under GitHub Actions with `id-token: write` — no NODE_AUTH_TOKEN and
    // no explicit --provenance flag needed.
    publish(tarballPath) {
      const args = [
        'publish',
        tarballPath,
        '--access',
        'public',
        '--tag',
        'latest',
        '--registry',
        NPM_REGISTRY,
      ];
      const result = spawnCommand('npm', args, {
        cwd: runtimeDirectory,
        env: npmEnvironment,
        stdio: 'inherit',
      });

      if (result.error) {
        throw result.error;
      }

      if (result.status !== 0) {
        throw new Error(`npm publish failed with exit ${result.status}`);
      }
    },

    query(version) {
      return queryRegistryPackage({
        cwd: runtimeDirectory,
        env: npmEnvironment,
        name: packageName,
        version,
      });
    },

    sleep,
  };
}

async function waitForVerifiedPackage({
  initialMetadata,
  operations,
  packageName,
  pollAttempts,
  pollDelayMs,
  version,
}) {
  let metadata = initialMetadata;

  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    if (metadata) {
      validatePublishedManifest({ manifest: metadata, packageName, version });

      if (hasSlsaProvenance(metadata)) {
        return;
      }
    }

    if (attempt === pollAttempts) {
      break;
    }

    await operations.sleep(pollDelayMs);

    const result = await operations.query(version);

    metadata = result.state === 'found' ? result.metadata : undefined;
  }

  throw new Error(
    `${packageName}@${version} did not expose SLSA provenance after ${pollAttempts} checks`,
  );
}

export async function executePublication({
  dryRun,
  log = console,
  manifest,
  operations,
  pollAttempts = DEFAULT_POLL_ATTEMPTS,
  pollDelayMs = DEFAULT_POLL_DELAY_MS,
}) {
  const packageName = manifest.name;
  const version = manifest.version;

  if (dryRun) {
    const packed = await operations.pack();

    validatePublishedManifest({
      manifest: packed.manifest,
      packageName,
      version,
    });

    log.log(`validated packed artifact: ${packageName}@${version}`);

    return { state: 'validated' };
  }

  const existing = await operations.query(version);

  if (existing.state === 'found') {
    await waitForVerifiedPackage({
      initialMetadata: existing.metadata,
      operations,
      packageName,
      pollAttempts,
      pollDelayMs,
      version,
    });

    log.log(`skip (published and verified): ${packageName}@${version}`);

    return { state: 'skipped' };
  }

  const packed = await operations.pack();

  validatePublishedManifest({
    manifest: packed.manifest,
    packageName,
    version,
  });

  log.log(`publishing with npm OIDC: ${packageName}@${version}`);

  try {
    await operations.publish(packed.tarballPath);
  } catch (publishError) {
    const raced = await operations.query(version);

    if (raced.state !== 'found') {
      throw publishError;
    }

    await waitForVerifiedPackage({
      initialMetadata: raced.metadata,
      operations,
      packageName,
      pollAttempts,
      pollDelayMs,
      version,
    });

    log.log(`publish race recovered: ${packageName}@${version}`);

    return { state: 'raceRecovered' };
  }

  await waitForVerifiedPackage({
    operations,
    packageName,
    pollAttempts,
    pollDelayMs,
    version,
  });

  return { state: 'published' };
}

function removeRuntimeDirectory(runtimeDirectory, parentDirectory) {
  const resolvedRuntime = resolve(runtimeDirectory);
  const resolvedParent = resolve(parentDirectory);

  if (
    dirname(resolvedRuntime) !== resolvedParent ||
    !basename(resolvedRuntime).startsWith('idb-free-sync-npm-publish-')
  ) {
    throw new Error(
      `Refusing to remove unexpected runtime directory: ${resolvedRuntime}`,
    );
  }

  rmSync(resolvedRuntime, { recursive: true });
}

function usage() {
  console.log('Usage: node scripts/publish-package.mjs [--dry-run]');
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.includes('--help')) {
    usage();

    return;
  }

  const unknownArgs = args.filter((argument) => argument !== '--dry-run');

  if (unknownArgs.length > 0) {
    throw new Error(`Unknown argument(s): ${unknownArgs.join(', ')}`);
  }

  const dryRun = args.includes('--dry-run');
  const root = process.cwd();
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

  if (!dryRun) {
    const expectedVersion = assertLiveEnvironment(env);

    if (manifest.version !== expectedVersion) {
      throw new Error(
        `package.json version ${manifest.version} does not match release tag ${expectedVersion}`,
      );
    }
  }

  if (manifest.private === true) {
    throw new Error(`${manifest.name}: package is private`);
  }

  if (manifest.publishConfig?.access !== 'public') {
    throw new Error(`${manifest.name}: publishConfig.access must be public`);
  }

  if (manifestRepositoryUrl(manifest) !== EXPECTED_REPOSITORY_URL) {
    throw new Error(
      `${manifest.name}: repository URL must be ${EXPECTED_REPOSITORY_URL}`,
    );
  }

  const runtimeParent = resolve(env.RUNNER_TEMP ?? tmpdir());
  const runtimeDirectory = mkdtempSync(
    join(runtimeParent, 'idb-free-sync-npm-publish-'),
  );

  try {
    if (!dryRun) {
      const npmVersion = execCommand('npm', ['--version'], {
        encoding: 'utf8',
      }).trim();

      assertMinimumVersion('npm', npmVersion, MINIMUM_NPM_VERSION);
    }

    const operations = createPublisherOperations({
      env,
      packageName: manifest.name,
      root,
      runtimeDirectory,
    });
    const result = await executePublication({ dryRun, manifest, operations });

    console.log(`\n${manifest.name}@${manifest.version}: ${result.state}`);
  } finally {
    removeRuntimeDirectory(runtimeDirectory, runtimeParent);
  }
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

'use strict';

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { c as createTar } from 'tar';

import {
  assertLiveEnvironment,
  executePublication,
  hasSlsaProvenance,
  inspectPackedManifest,
  interpretRegistryResult,
  normalizeRegistryMetadata,
  validatePublishedManifest,
} from './publish-package.mjs';
import { EXPECTED_REPOSITORY_URL } from './release-shared.mjs';

const VERSION = '1.2.3';
const PACKAGE_NAME = '@rcarls/idb-free-sync';
const repository = { type: 'git', url: EXPECTED_REPOSITORY_URL };
const quietLog = { log() {} };

function manifest(overrides = {}) {
  return { name: PACKAGE_NAME, repository, version: VERSION, ...overrides };
}

function registryManifest({ provenance = true } = {}) {
  return {
    ...manifest(),
    dist: provenance
      ? {
          attestations: [
            {
              provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
              url: 'https://registry.npmjs.org/-/npm/v1/attestations/example',
            },
          ],
        }
      : {},
  };
}

test('inspects the manifest contained in a packed tarball', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'idb-free-sync-packed-manifest-'));
  const packageDirectory = join(root, 'package');
  const extractDirectory = join(root, 'unpacked');
  const tarballPath = join(root, 'package.tgz');
  const packedManifest = { name: PACKAGE_NAME, version: VERSION };

  context.after(() => rmSync(root, { recursive: true }));
  mkdirSync(packageDirectory);
  writeFileSync(
    join(packageDirectory, 'package.json'),
    JSON.stringify(packedManifest),
  );
  createTar({ cwd: root, file: tarballPath, gzip: true, sync: true }, [
    'package/package.json',
  ]);

  assert.deepEqual(
    inspectPackedManifest({
      extractDirectory,
      packageName: packedManifest.name,
      tarballPath,
    }),
    packedManifest,
  );
});

test('rejects a mismatched name, version, or repository URL', () => {
  assert.throws(
    () =>
      validatePublishedManifest({
        manifest: manifest({ name: '@rcarls/wrong-name' }),
        packageName: PACKAGE_NAME,
        version: VERSION,
      }),
    /name is @rcarls\/wrong-name/,
  );

  assert.throws(
    () =>
      validatePublishedManifest({
        manifest: manifest({ version: '9.9.9' }),
        packageName: PACKAGE_NAME,
        version: VERSION,
      }),
    /version is 9\.9\.9/,
  );

  assert.throws(
    () =>
      validatePublishedManifest({
        manifest: manifest({
          repository: { type: 'git', url: 'git+https://example.test/x.git' },
        }),
        packageName: PACKAGE_NAME,
        version: VERSION,
      }),
    /repository URL is missing or incorrect/,
  );

  assert.doesNotThrow(() =>
    validatePublishedManifest({
      manifest: manifest(),
      packageName: PACKAGE_NAME,
      version: VERSION,
    }),
  );
});

test('requires an exact tag, OIDC context, and no token credentials for live publishing', () => {
  const environment = {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-request-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/oidc',
    GITHUB_ACTIONS: 'true',
    GITHUB_REF_NAME: 'v1.2.3',
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REPOSITORY: 'richardcarls/idb-free-sync',
  };

  assert.equal(assertLiveEnvironment(environment), VERSION);

  assert.throws(
    () =>
      assertLiveEnvironment({
        ...environment,
        NODE_AUTH_TOKEN: 'legacy-token',
      }),
    /Refusing token fallback.*NODE_AUTH_TOKEN/,
  );

  assert.throws(
    () =>
      assertLiveEnvironment({
        ...environment,
        npm_config_password: 'legacy-password',
      }),
    /Refusing token fallback.*npm_config_password/,
  );

  assert.throws(
    () => assertLiveEnvironment({ ...environment, NPM_CONFIG_OTP: '123456' }),
    /Refusing token fallback.*NPM_CONFIG_OTP/,
  );

  assert.throws(
    () =>
      assertLiveEnvironment({
        ...environment,
        GITHUB_REF_NAME: 'v1.2.3-beta.1',
      }),
    /stable vX\.Y\.Z/,
  );
});

test('treats only npm E404 responses as unpublished versions', () => {
  assert.deepEqual(
    interpretRegistryResult({
      status: 1,
      stderr: JSON.stringify({ error: { code: 'E404' } }),
      stdout: '',
    }),
    { state: 'missing' },
  );

  assert.throws(
    () =>
      interpretRegistryResult({
        status: 1,
        stderr: JSON.stringify({
          error: { code: 'E401', summary: 'authentication required' },
        }),
        stdout: '',
      }),
    /E401/,
  );
});

test('normalizes npm view arrays and dotted provenance fields', () => {
  const normalized = normalizeRegistryMetadata([
    {
      'dist.attestations': {
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
      name: PACKAGE_NAME,
      version: VERSION,
    },
  ]);

  assert.equal(normalized.name, PACKAGE_NAME);
  assert.equal(normalized['dist.attestations'], undefined);
  assert.equal(hasSlsaProvenance(normalized), true);
  assert.throws(() => normalizeRegistryMetadata([]), /0 metadata entries/);
});

test('dry run packs and validates without registry reads or publish attempts', async () => {
  const packed = [];

  const result = await executePublication({
    dryRun: true,
    log: quietLog,
    manifest: manifest(),
    operations: {
      async pack() {
        packed.push('pack');

        return { manifest: manifest(), tarballPath: 'package.tgz' };
      },
      publish() {
        assert.fail('dry run must not publish');
      },
      query() {
        assert.fail('dry run must not read the registry');
      },
    },
  });

  assert.deepEqual(packed, ['pack']);
  assert.equal(result.state, 'validated');
});

test('skips a version already published and verified on the registry', async () => {
  const calls = [];

  const result = await executePublication({
    dryRun: false,
    log: quietLog,
    manifest: manifest(),
    operations: {
      pack() {
        assert.fail('must not pack an already-published version');
      },
      publish() {
        assert.fail('must not publish an already-published version');
      },
      async query() {
        calls.push('query');

        return { metadata: registryManifest(), state: 'found' };
      },
      async sleep() {},
    },
  });

  assert.equal(result.state, 'skipped');
  assert.deepEqual(calls, ['query']);
});

test('publishes a missing version and verifies provenance afterward', async () => {
  const calls = [];

  const result = await executePublication({
    dryRun: false,
    log: quietLog,
    manifest: manifest(),
    operations: {
      async pack() {
        calls.push('pack');

        return { manifest: manifest(), tarballPath: 'package.tgz' };
      },
      async publish() {
        calls.push('publish');
      },
      async query() {
        calls.push('query');

        return calls.filter((call) => call === 'query').length > 1
          ? { metadata: registryManifest(), state: 'found' }
          : { state: 'missing' };
      },
      async sleep() {},
    },
    pollAttempts: 2,
    pollDelayMs: 0,
  });

  assert.equal(result.state, 'published');
  assert.deepEqual(calls, ['query', 'pack', 'publish', 'query']);
});

test('recovers when a failed publish raced with another successful publisher', async () => {
  let queryCount = 0;

  const result = await executePublication({
    dryRun: false,
    log: quietLog,
    manifest: manifest(),
    operations: {
      async pack() {
        return { manifest: manifest(), tarballPath: 'package.tgz' };
      },
      async publish() {
        throw new Error('immutable version already exists');
      },
      async query() {
        queryCount += 1;

        return queryCount === 1
          ? { state: 'missing' }
          : { metadata: registryManifest(), state: 'found' };
      },
      async sleep() {},
    },
    pollAttempts: 1,
    pollDelayMs: 0,
  });

  assert.equal(result.state, 'raceRecovered');
});

test('polls until registry provenance becomes visible', async () => {
  let queryCount = 0;
  let sleepCount = 0;

  const result = await executePublication({
    dryRun: false,
    log: quietLog,
    manifest: manifest(),
    operations: {
      async query() {
        queryCount += 1;

        return {
          metadata: registryManifest({ provenance: queryCount > 1 }),
          state: 'found',
        };
      },
      async sleep() {
        sleepCount += 1;
      },
    },
    pollAttempts: 2,
    pollDelayMs: 0,
  });

  assert.equal(result.state, 'skipped');
  assert.equal(queryCount, 2);
  assert.equal(sleepCount, 1);
});

test('stops provenance polling after the configured attempt bound', async () => {
  let queryCount = 0;
  let sleepCount = 0;

  await assert.rejects(
    executePublication({
      dryRun: false,
      log: quietLog,
      manifest: manifest(),
      operations: {
        async query() {
          queryCount += 1;

          return {
            metadata: registryManifest({ provenance: false }),
            state: 'found',
          };
        },
        async sleep() {
          sleepCount += 1;
        },
      },
      pollAttempts: 2,
      pollDelayMs: 0,
    }),
    /did not expose SLSA provenance after 2 checks/,
  );

  assert.equal(queryCount, 2);
  assert.equal(sleepCount, 1);
});

test('surfaces unknown registry failures', async () => {
  await assert.rejects(
    executePublication({
      dryRun: false,
      log: quietLog,
      manifest: manifest(),
      operations: {
        async query() {
          throw new Error('EAI_AGAIN registry.npmjs.org');
        },
      },
    }),
    /EAI_AGAIN/,
  );
});

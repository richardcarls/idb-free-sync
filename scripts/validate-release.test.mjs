import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const validator = resolve('scripts/validate-release.mjs');

function git(root, ...args) {
  execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
}

function createReleaseRepo({
  packageVersion = '1.2.3',
  pendingChangeset = false,
  releaseOnMain = true,
  tag,
}) {
  const root = mkdtempSync(join(tmpdir(), 'idb-free-sync-release-validation-'));

  mkdirSync(join(root, '.changeset'));

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@rcarls/idb-free-sync', version: packageVersion }),
  );

  writeFileSync(join(root, '.changeset', 'README.md'), '# Changesets\n');

  if (pendingChangeset) {
    writeFileSync(join(root, '.changeset', 'pending.md'), '---\n---\n');
  }

  git(root, 'init');
  git(root, 'config', 'user.name', 'Test User');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'chore: release');

  if (!releaseOnMain) {
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(root, 'release-marker.txt'), 'release\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'chore: release candidate');
  } else {
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  }

  if (tag) {
    git(root, 'tag', tag);
  }

  return root;
}

function validate(root) {
  const result = spawnSync(process.execPath, [validator], {
    cwd: root,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

test('accepts an exact semantic tag matching the package version', () => {
  const result = validate(createReleaseRepo({ tag: 'v1.2.3' }));

  assert.equal(result.status, 0, result.stderr);
});

test('rejects a release commit without an exact tag', () => {
  const result = validate(createReleaseRepo({}));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact stable semantic-version tag/);
});

test('rejects a tag that does not match the package version', () => {
  const result = validate(createReleaseRepo({ tag: 'v1.2.4' }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match v1\.2\.4/);
});

test('rejects pending changesets', () => {
  const result = validate(
    createReleaseRepo({ pendingChangeset: true, tag: 'v1.2.3' }),
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /pending changesets remain/);
});

test('rejects prerelease tags', () => {
  const result = validate(createReleaseRepo({ tag: 'v1.2.3-beta.1' }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a stable semantic version/);
});

test('rejects a tagged commit that is not contained in origin main', () => {
  const result = validate(
    createReleaseRepo({ releaseOnMain: false, tag: 'v1.2.3' }),
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be contained in origin\/main/);
});

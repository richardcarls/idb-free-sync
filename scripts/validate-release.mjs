import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { STABLE_TAG_PATTERN } from './release-shared.mjs';

const root = process.cwd();

function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

const errors = [];
let tag = '';

try {
  tag = git('describe', '--tags', '--exact-match', 'HEAD');
} catch {
  errors.push(
    'HEAD must have an exact stable semantic-version tag before publishing',
  );
}

if (tag && !STABLE_TAG_PATTERN.test(tag)) {
  errors.push(`HEAD tag is not a stable semantic version: ${tag}`);
}

try {
  git('rev-parse', '--verify', 'origin/main');

  try {
    execFileSync(
      'git',
      ['merge-base', '--is-ancestor', 'HEAD', 'origin/main'],
      {
        cwd: root,
        stdio: 'ignore',
      },
    );
  } catch {
    errors.push('tagged release commit must be contained in origin/main');
  }
} catch {
  errors.push('origin/main must be available for release validation');
}

const expectedVersion = tag.replace(/^v/, '');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (expectedVersion && manifest.version !== expectedVersion) {
  errors.push(
    `${manifest.name}: version ${manifest.version} does not match ${tag}`,
  );
}

const pendingChangesets = readdirSync(join(root, '.changeset')).filter(
  (name) => name.endsWith('.md') && name !== 'README.md',
);

if (pendingChangesets.length > 0) {
  errors.push(`pending changesets remain: ${pendingChangesets.join(', ')}`);
}

if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Validated release ${tag}.`);
}

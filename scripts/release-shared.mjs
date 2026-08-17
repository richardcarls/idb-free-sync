'use strict';

import { execFileSync, spawnSync } from 'node:child_process';

export const EXPECTED_REPOSITORY_URL =
  'git+https://github.com/richardcarls/idb-free-sync.git';
export const EXPECTED_GITHUB_REPOSITORY = 'richardcarls/idb-free-sync';
export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export const STABLE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

// Yarn/npm resolve to `<name>.cmd` shims on Windows; PATH lookup of the bare
// name only works through a shell. Route through cmd.exe there so this script
// also works for a local `yarn release:check` on Rick's Windows machine.
function commandInvocation(command, args) {
  if (process.platform !== 'win32') {
    return { command, args };
  }

  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `${command}.cmd`, ...args],
  };
}

export function execCommand(command, args, options = {}) {
  const invocation = commandInvocation(command, args);

  return execFileSync(invocation.command, invocation.args, options);
}

export function spawnCommand(command, args, options = {}) {
  const invocation = commandInvocation(command, args);

  return spawnSync(invocation.command, invocation.args, options);
}

export function compareVersions(actual, minimum) {
  const parse = (value) =>
    value.split('.').map((part) => Number.parseInt(part, 10));
  const actualParts = parse(actual);
  const minimumParts = parse(minimum);

  for (let index = 0; index < 3; index += 1) {
    const difference = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);

    if (difference !== 0) {
      return Math.sign(difference);
    }
  }

  return 0;
}

export function assertMinimumVersion(name, actual, minimum) {
  if (
    !STABLE_VERSION_PATTERN.test(actual) ||
    compareVersions(actual, minimum) < 0
  ) {
    throw new Error(`${name} ${minimum} or newer is required; found ${actual}`);
  }
}

export function manifestRepositoryUrl(manifest) {
  return typeof manifest.repository === 'string'
    ? manifest.repository
    : manifest.repository?.url;
}

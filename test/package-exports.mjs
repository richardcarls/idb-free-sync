'use strict';

import { access, readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));

for (const [subpath, conditions] of Object.entries(packageJson.exports)) {
  for (const target of Object.values(conditions)) {
    await access(target);
  }

  const specifier =
    subpath === '.'
      ? packageJson.name
      : `${packageJson.name}/${subpath.slice(2)}`;

  await import(specifier);
}

import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sources(path)));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) result.push(path);
  }
  return result;
}

const rules = [
  {
    directory: resolve('apps/web/src'),
    forbidden: [/drizzle-orm/, /node:/, /electron/],
    label: 'Web renderer',
  },
  {
    directory: resolve('apps/desktop/src/renderer'),
    forbidden: [/node:/, /electron/, /desktop-runtime\/src/],
    label: 'Desktop renderer',
  },
  {
    directory: resolve('apps/control-plane/src'),
    forbidden: [/apps\/desktop/, /services\/hub-agent\/src/],
    label: 'Control Plane',
  },
];
for (const rule of rules) {
  for (const file of await sources(rule.directory)) {
    const content = await readFile(file, 'utf8');
    for (const forbidden of rule.forbidden)
      if (forbidden.test(content))
        throw new Error(`${rule.label} dependency boundary violation in ${file}: ${forbidden}`);
  }
}
console.log('Dependency boundaries are valid.');

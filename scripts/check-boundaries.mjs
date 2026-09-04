import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function sources(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await sources(path)));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name)) result.push(path);
  }
  return result;
}

const rules = [
  {
    directory: resolve('apps/web/src'),
    forbidden: [
      /drizzle-orm/,
      /(?:from\s+|import\s+|require\()\s*['"]node:/,
      /electron/,
      /@kitesync\/node-service/,
    ],
    label: 'Web UI',
  },
  {
    directory: resolve('apps/node-service/src'),
    forbidden: [
      /better-sqlite3/,
      /drizzle-orm/,
      /from ['"]argon2['"]/,
      /apps\/control-plane/,
      /services\/(?:hub|backup|filebrowser)/,
    ],
    label: 'Node Service',
  },
];

for (const rule of rules) {
  for (const file of await sources(rule.directory)) {
    const content = await readFile(file, 'utf8');
    for (const forbidden of rule.forbidden) {
      if (forbidden.test(content)) {
        throw new Error(`${rule.label} dependency boundary violation in ${file}: ${forbidden}`);
      }
    }
  }
}

console.log('Dependency boundaries are valid.');

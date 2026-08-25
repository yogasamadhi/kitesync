import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function normalizeLicense(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : item?.type))
      .filter(Boolean)
      .join(' OR ');
  }
  return 'UNKNOWN';
}

export async function collectDependencies(root = resolve('node_modules')) {
  const packages = new Map();
  const visited = new Set();

  async function inspectPackage(directory) {
    let canonical;
    try {
      canonical = await realpath(directory);
    } catch {
      return;
    }
    if (visited.has(canonical)) return;
    visited.add(canonical);
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
        packages.set(`${manifest.name}@${manifest.version}`, {
          name: manifest.name,
          version: manifest.version,
          license: normalizeLicense(manifest.license ?? manifest.licenses),
        });
      }
    } catch {
      return;
    }
    await inspectNodeModules(join(directory, 'node_modules'));
  }

  async function inspectNodeModules(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const child = join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        let scoped = [];
        try {
          scoped = await readdir(child, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const packageEntry of scoped) {
          if (!packageEntry.name.startsWith('.')) {
            await inspectPackage(join(child, packageEntry.name));
          }
        }
      } else {
        await inspectPackage(child);
      }
    }
  }

  await inspectNodeModules(root);
  return [...packages.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}

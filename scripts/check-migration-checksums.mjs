import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve('apps/control-plane/migrations');
const expected = new Map(
  (await readFile(resolve(directory, 'checksums.sha256'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => {
      const [hash, file] = line.trim().split(/\s+/);
      return [file, hash];
    }),
);
const migrations = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
if (migrations.length !== expected.size)
  throw new Error('Migration checksum manifest does not cover every SQL migration');
for (const file of migrations) {
  const actual = createHash('sha256')
    .update(await readFile(resolve(directory, file)))
    .digest('hex');
  if (expected.get(file) !== actual)
    throw new Error(`Migration ${file} was changed after publication`);
}
console.log(`Verified ${migrations.length} immutable migration checksums.`);

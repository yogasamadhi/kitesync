import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve('apps/control-plane/migrations');
const published = new Map([
  ['0000_initial.sql', 'c663df059c62dde1fb253f8080a87c472bd95c25f35837c469878fcbf118655b'],
  [
    '0001_desktop_refresh_tokens.sql',
    '43782a1f8c16e95f9dc8eb5a5db8bb605ab932e6564e39610e53bab685d115a9',
  ],
  [
    '0002_account_lifecycle.sql',
    'd28a2809c4e05de431624c8aef349429511d9acb016d5966e5e7df23b5764b49',
  ],
  [
    '0003_syncthing_identity_bindings.sql',
    '9f8e40ecb1d0c7616207b53509c5b605b14612585e51b4604ef4068bf0d53f2e',
  ],
  ['0004_client_browser.sql', 'b6d822c3addf56e19774e12391f5b71690195da43af7928f0aaaa733351441bd'],
]);
const manifestLines = (await readFile(resolve(directory, 'checksums.sha256'), 'utf8'))
  .trim()
  .split('\n');
const manifestEntries = manifestLines.map((line) => {
  const match = line.match(/^([0-9a-f]{64}) {2}([0-9]{4}_[a-z0-9_]+\.sql)$/);
  if (!match) throw new Error(`Invalid legacy migration checksum entry: ${line}`);
  return [match[2], match[1]];
});
const expected = new Map(manifestEntries);
const migrations = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
const journal = JSON.parse(await readFile(resolve(directory, 'meta/_journal.json'), 'utf8'));
const journalTags = Array.isArray(journal.entries)
  ? journal.entries.map((entry) => `${entry.tag}.sql`)
  : [];
if (
  manifestEntries.length !== published.size ||
  migrations.length !== published.size ||
  expected.size !== published.size ||
  migrations.some((file) => expected.get(file) !== published.get(file)) ||
  JSON.stringify(journalTags) !== JSON.stringify(migrations)
) {
  throw new Error(
    'Legacy migration set, journal, or checksum manifest differs from the published baseline',
  );
}
for (const file of migrations) {
  const actual = createHash('sha256')
    .update(await readFile(resolve(directory, file)))
    .digest('hex');
  if (published.get(file) !== actual)
    throw new Error(`Migration ${file} was changed after publication`);
}
console.log(`Verified ${migrations.length} immutable migration checksums.`);

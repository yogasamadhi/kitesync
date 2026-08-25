import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson } from '@kitesync/contracts';

const arguments_ = process.argv.slice(2);
const inputName = arguments_[0];
const privateKeyName =
  arguments_.length === 3 ? arguments_[1] : process.env.KITESYNC_UPDATE_PRIVATE_KEY_FILE;
const outputName = arguments_.length === 3 ? arguments_[2] : arguments_[1];
if (!inputName || !privateKeyName || !outputName) {
  throw new Error(
    'Usage: KITESYNC_UPDATE_PRIVATE_KEY_FILE=private-key.pem node scripts/sign-update-manifest.mjs manifest.json signed-manifest.json (or pass the key as the middle argument)',
  );
}
const payload = JSON.parse(await readFile(resolve(inputName), 'utf8'));
if (
  payload.channel !== 'stable' ||
  typeof payload.version !== 'string' ||
  !Array.isArray(payload.assets) ||
  payload.assets.length === 0
) {
  throw new Error('Manifest requires version, channel="stable", and at least one asset');
}
for (const asset of payload.assets ?? []) {
  if (
    typeof asset.path !== 'string' ||
    typeof asset.platform !== 'string' ||
    typeof asset.arch !== 'string' ||
    typeof asset.url !== 'string'
  ) {
    throw new Error('Every asset requires path, platform, arch, and url');
  }
  const content = await readFile(resolve(asset.path));
  asset.sha512 = createHash('sha512').update(content).digest('base64');
  delete asset.path;
}
const signature = sign(
  null,
  Buffer.from(canonicalJson(payload)),
  createPrivateKey(await readFile(resolve(privateKeyName), 'utf8')),
).toString('base64');
await writeFile(resolve(outputName), JSON.stringify({ payload, signature }, null, 2) + '\n');
console.log(`Signed update manifest ${outputName}`);

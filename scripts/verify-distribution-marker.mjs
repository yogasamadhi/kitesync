#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { assertSyncthingBinaryModules } from './verify-syncthing-modules.mjs';

const [markerArgument, binaryArgument] = process.argv.slice(2);
if (!markerArgument || !binaryArgument) {
  throw new Error(
    '用法：bun scripts/verify-distribution-marker.mjs <SYNCTHING_BUILD.json> <syncthing>',
  );
}

const marker = JSON.parse(await readFile(resolve(markerArgument), 'utf8'));
const sourceMarker = JSON.parse(
  await readFile(
    resolve(
      'vendor/syncthing/bin',
      `${marker.platform}-${marker.arch}`,
      `.build-${marker.version}.json`,
    ),
    'utf8',
  ),
);
const distributedSha256 = createHash('sha256')
  .update(await readFile(resolve(binaryArgument)))
  .digest('hex');

for (const field of [
  'version',
  'sourceCommit',
  'sourceTree',
  'platform',
  'arch',
  'goVersion',
  'cgoEnabled',
  'buildTags',
  'sha256',
]) {
  if (JSON.stringify(marker[field]) !== JSON.stringify(sourceMarker[field])) {
    throw new Error(`随包 marker 的 ${field} 与已验证源码构建不一致`);
  }
}

if (marker.sourceBuildSha256 !== sourceMarker.sha256 || marker.sha256 !== sourceMarker.sha256) {
  throw new Error('随包 marker 的 source build SHA-256 与已验证构建产物不一致');
}
if (marker.distributedSha256 !== distributedSha256) {
  throw new Error('随包 Syncthing 的 distributed SHA-256 与 marker 不一致');
}
assertSyncthingBinaryModules(binaryArgument);
console.log(`Verified distributed Syncthing ${marker.version}: ${marker.distributedSha256}`);

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { verifyGoModuleArtifacts } from './go-module-licenses.mjs';
import { assertSyncthingSource, repositoryRoot, syncthingMetadata } from './syncthing-source.mjs';

const { commit, tree } = assertSyncthingSource();
const goModuleInventory = verifyGoModuleArtifacts();
const buildScript = readFileSync(resolve(repositoryRoot, 'scripts/build-syncthing.mjs'), 'utf8');
for (const required of [
  "'-no-upgrade'",
  "GOFLAGS: '-mod=readonly -buildvcs=false'",
  "CGO_ENABLED: '0'",
  'SOURCE_DATE_EPOCH',
]) {
  if (!buildScript.includes(required)) {
    throw new Error(`Syncthing source build is missing ${required}`);
  }
}

if (!syncthingMetadata.buildTags.includes('noupgrade')) {
  throw new Error('Syncthing source build must permanently disable upstream self-upgrade');
}

const dockerfile = resolve(repositoryRoot, 'deploy/docker/Dockerfile');
if (existsSync(dockerfile)) {
  const deployment = readFileSync(dockerfile, 'utf8');
  if (/syncthing\/syncthing:/i.test(deployment)) {
    throw new Error('Optional Node image must not use an upstream prebuilt Syncthing image');
  }
  for (const required of [
    `FROM golang:${syncthingMetadata.goVersion}-alpine AS syncthing`,
    'COPY vendor/syncthing/upstream ./',
    syncthingMetadata.licenseFileSha256,
    syncthingMetadata.goModSha256,
    syncthingMetadata.goSumSha256,
    'CGO_ENABLED=0',
    "GOFLAGS='-mod=readonly -buildvcs=false'",
    `SOURCE_DATE_EPOCH=${syncthingMetadata.sourceDateEpoch}`,
    `-version ${syncthingMetadata.version}`,
    '-no-upgrade',
    'scripts/verify-syncthing-modules.go',
    'vendor/syncthing/GO_MODULES.json',
    'vendor/syncthing/SYNCTHING_THIRD_PARTY_LICENSES.txt',
    ...syncthingMetadata.buildTags.filter((tag) => tag !== 'noupgrade'),
  ]) {
    if (!deployment.includes(required)) {
      throw new Error(`Optional Node image Syncthing build is missing ${required}`);
    }
  }
}

console.log(
  `Syncthing ${syncthingMetadata.version} source and ${goModuleInventory.modules.length} linked module licenses verified; commit=${commit}; tree=${tree}`,
);

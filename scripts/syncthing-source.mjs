import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertSyncthingBinaryModules } from './verify-syncthing-modules.mjs';

export const repositoryRoot = resolve(import.meta.dirname, '..');
export const syncthingRoot = resolve(repositoryRoot, 'vendor/syncthing');
export const syncthingSource = resolve(syncthingRoot, 'upstream');
export const syncthingMetadata = JSON.parse(
  readFileSync(resolve(syncthingRoot, 'UPSTREAM.json'), 'utf8'),
);

const reviewedMetadata = {
  repository: 'https://github.com/syncthing/syncthing.git',
  version: 'v2.1.3',
  commit: '946e2b83a1f6c6ae119427c09e0a5802940b82ff',
  tree: '70a7d277758efa38c6732191cf703fc9af8ae320',
  license: 'MPL-2.0',
  licenseFileSha256: '3f3d9e0024b1921b067d6f7f88deb4a60cbe7a78e76c64e3f1d7fc3b779b9d04',
  goModSha256: 'a129d6ae9cf20593fab4b1fb04ac09b176c4942d3a4bec9394f9c888fe2d1bd1',
  goSumSha256: '7e9606117eca33e9263181a3d0141e403c940c55022a061d8ed9e22d4bda2acd',
  goVersion: '1.26.0',
  sourceDateEpoch: 1785792965,
  cgoEnabled: false,
  buildTags: ['noupgrade', 'sqlite_omit_load_extension', 'sqlite_dbstat'],
};

const supportedTargets = {
  'darwin-arm64': { goos: 'darwin', goarch: 'arm64', executable: 'syncthing' },
  'darwin-x64': { goos: 'darwin', goarch: 'amd64', executable: 'syncthing' },
  'linux-arm64': { goos: 'linux', goarch: 'arm64', executable: 'syncthing' },
  'linux-x64': { goos: 'linux', goarch: 'amd64', executable: 'syncthing' },
  'win32-x64': { goos: 'windows', goarch: 'amd64', executable: 'syncthing.exe' },
};

function git(...args) {
  return execFileSync('git', ['-C', syncthingSource, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function resolveSyncthingTarget(
  platform = process.env.KITESYNC_SYNCTHING_PLATFORM ?? process.platform,
  arch = process.env.KITESYNC_SYNCTHING_ARCH ?? process.arch,
) {
  const key = `${platform}-${arch}`;
  const target = supportedTargets[key];
  if (!target) throw new Error(`Unsupported Syncthing build target ${key}`);
  const directory = resolve(syncthingRoot, 'bin', key);
  return {
    ...target,
    key,
    platform,
    arch,
    directory,
    binary: resolve(directory, target.executable),
    marker: resolve(directory, `.build-${syncthingMetadata.version}.json`),
  };
}

export function assertSyncthingSource() {
  if (JSON.stringify(syncthingMetadata) !== JSON.stringify(reviewedMetadata)) {
    throw new Error(
      'Syncthing metadata does not match the reviewed source and build configuration',
    );
  }
  if (!existsSync(resolve(syncthingSource, '.git'))) {
    throw new Error(
      'Syncthing submodule is not initialized; run git submodule update --init --recursive',
    );
  }

  const commit = git('rev-parse', 'HEAD');
  if (commit !== syncthingMetadata.commit) {
    throw new Error(
      `Syncthing commit mismatch: expected ${syncthingMetadata.commit}, got ${commit}`,
    );
  }
  const tree = git('rev-parse', 'HEAD^{tree}');
  if (tree !== syncthingMetadata.tree) {
    throw new Error(`Syncthing tree mismatch: expected ${syncthingMetadata.tree}, got ${tree}`);
  }
  const configuredRepository = execFileSync(
    'git',
    [
      'config',
      '-f',
      resolve(repositoryRoot, '.gitmodules'),
      '--get',
      'submodule.vendor/syncthing/upstream.url',
    ],
    { encoding: 'utf8' },
  ).trim();
  if (configuredRepository !== syncthingMetadata.repository) {
    throw new Error(
      `Syncthing submodule URL mismatch: expected ${syncthingMetadata.repository}, got ${configuredRepository}`,
    );
  }
  const configuredSubmodulePaths = execFileSync(
    'git',
    [
      'config',
      '-f',
      resolve(repositoryRoot, '.gitmodules'),
      '--get-regexp',
      '^submodule\\..*\\.path$',
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).at(-1))
    .sort();
  if (JSON.stringify(configuredSubmodulePaths) !== JSON.stringify(['vendor/syncthing/upstream'])) {
    throw new Error(
      `Syncthing must be the only submodule; found: ${configuredSubmodulePaths.join(', ')}`,
    );
  }
  // Shallow submodule initialization may omit tag objects. When the reviewed
  // tag is present locally, still require it to resolve to the pinned commit.
  let taggedCommit;
  try {
    taggedCommit = git('rev-parse', `${syncthingMetadata.version}^{commit}`);
  } catch {
    taggedCommit = undefined;
  }
  if (taggedCommit && taggedCommit !== commit) {
    throw new Error(
      `Syncthing tag ${syncthingMetadata.version} points to ${taggedCommit}, expected ${commit}`,
    );
  }
  const status = git('status', '--porcelain', '--untracked-files=all');
  if (status) throw new Error(`Syncthing submodule has local changes:\n${status}`);

  const hashes = [
    ['license', resolve(syncthingSource, 'LICENSE'), syncthingMetadata.licenseFileSha256],
    ['go.mod', resolve(syncthingSource, 'go.mod'), syncthingMetadata.goModSha256],
    ['go.sum', resolve(syncthingSource, 'go.sum'), syncthingMetadata.goSumSha256],
  ];
  for (const [name, path, expected] of hashes) {
    const actual = sha256(path);
    if (actual !== expected) {
      throw new Error(`Syncthing ${name} hash mismatch: expected ${expected}, got ${actual}`);
    }
  }
  return { commit, tree };
}

export function assertSyncthingBuild(target = resolveSyncthingTarget()) {
  if (!existsSync(target.binary) || !existsSync(target.marker)) {
    throw new Error(
      `Syncthing source build is missing for ${target.key}; run bun run syncthing:build`,
    );
  }
  const marker = JSON.parse(readFileSync(target.marker, 'utf8'));
  const expected = {
    version: syncthingMetadata.version,
    sourceCommit: syncthingMetadata.commit,
    sourceTree: syncthingMetadata.tree,
    platform: target.platform,
    arch: target.arch,
    cgoEnabled: syncthingMetadata.cgoEnabled,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (marker[field] !== value) {
      throw new Error(
        `Syncthing build marker ${field} mismatch: expected ${value}, got ${marker[field]}`,
      );
    }
  }
  if (JSON.stringify(marker.buildTags) !== JSON.stringify(syncthingMetadata.buildTags)) {
    throw new Error('Syncthing build marker tags do not match the reviewed configuration');
  }
  const requiredGoSeries = syncthingMetadata.goVersion.split('.').slice(0, 2).join('.');
  if (
    typeof marker.goVersion !== 'string' ||
    !marker.goVersion.startsWith(`${requiredGoSeries}.`)
  ) {
    throw new Error(`Syncthing build marker must use Go ${requiredGoSeries}.x`);
  }
  const actualHash = sha256(target.binary);
  if (actualHash !== marker.sha256) {
    throw new Error(`Syncthing binary hash mismatch: expected ${marker.sha256}, got ${actualHash}`);
  }
  assertSyncthingBinaryModules(target.binary);

  if (target.platform === process.platform && target.arch === process.arch) {
    const version = execFileSync(target.binary, ['--version'], { encoding: 'utf8' });
    if (
      !version.includes(`syncthing ${syncthingMetadata.version} `) ||
      !version.includes(`${target.goos}-${target.goarch}`) ||
      !version.includes('noupgrade')
    ) {
      throw new Error(`Unexpected Syncthing build identity: ${version.trim()}`);
    }
  }
  return marker;
}

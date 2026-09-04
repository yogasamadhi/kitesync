import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import {
  assertSyncthingBuild,
  assertSyncthingSource,
  resolveSyncthingTarget,
  sha256,
  syncthingMetadata,
  syncthingSource,
} from './syncthing-source.mjs';

assertSyncthingSource();
const target = resolveSyncthingTarget();
const goVersionOutput = execFileSync('go', ['version'], { encoding: 'utf8' }).trim();
const goVersion = goVersionOutput.match(/\bgo(\d+\.\d+\.\d+)\b/)?.[1];
if (!goVersion) throw new Error(`Unable to parse Go version: ${goVersionOutput}`);
const requiredSeries = syncthingMetadata.goVersion.split('.').slice(0, 2).join('.');
if (!goVersion.startsWith(`${requiredSeries}.`)) {
  throw new Error(
    `Syncthing requires Go ${requiredSeries}.x; found ${goVersion}. Formal releases use ${syncthingMetadata.goVersion}.`,
  );
}
if (process.env.CI && goVersion !== syncthingMetadata.goVersion) {
  throw new Error(
    `CI Syncthing builds require Go ${syncthingMetadata.goVersion}; found ${goVersion}.`,
  );
}

if (process.env.KITESYNC_SYNCTHING_FORCE_BUILD !== '1') {
  try {
    const existing = assertSyncthingBuild(target);
    if (existing.goVersion === goVersion) {
      console.log(`Syncthing source build already exists at ${target.binary}`);
      process.exit(0);
    }
  } catch {
    // Missing, stale, or damaged output is replaced below.
  }
}

mkdirSync(target.directory, { recursive: true });
const temporary = `${target.binary}.${process.pid}.tmp${target.executable.endsWith('.exe') ? '.exe' : ''}`;
rmSync(temporary, { force: true });

const extraTags = syncthingMetadata.buildTags.filter((tag) => tag !== 'noupgrade').join(' ');
const args = [
  'run',
  '-mod=readonly',
  'build.go',
  '-goos',
  target.goos,
  '-goarch',
  target.goarch,
  '-version',
  syncthingMetadata.version,
  '-no-upgrade',
  '-tags',
  extraTags,
  '-build-out',
  temporary,
  'build',
  'syncthing',
];
console.log(`Building Syncthing ${syncthingMetadata.version} from source for ${target.key}...`);
const result = spawnSync('go', args, {
  cwd: syncthingSource,
  env: {
    ...process.env,
    BUILD_HOST: 'build.kitesync.local',
    BUILD_USER: 'kitesync',
    CGO_ENABLED: '0',
    GOFLAGS: '-mod=readonly -buildvcs=false',
    GOWORK: 'off',
    SOURCE_DATE_EPOCH: String(syncthingMetadata.sourceDateEpoch),
  },
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(`Syncthing source build failed with exit code ${result.status}`);

if (!target.executable.endsWith('.exe')) chmodSync(temporary, 0o755);
rmSync(target.binary, { force: true });
renameSync(temporary, target.binary);
const marker = {
  version: syncthingMetadata.version,
  sourceCommit: syncthingMetadata.commit,
  sourceTree: syncthingMetadata.tree,
  platform: target.platform,
  arch: target.arch,
  goVersion,
  cgoEnabled: syncthingMetadata.cgoEnabled,
  buildTags: syncthingMetadata.buildTags,
  sha256: sha256(target.binary),
};
writeFileSync(target.marker, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o644 });

assertSyncthingSource();
assertSyncthingBuild(target);
console.log(`Built verified Syncthing at ${target.binary}; sha256=${marker.sha256}`);

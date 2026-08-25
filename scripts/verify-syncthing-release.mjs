import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readCleartextMessage, readKey, verify } from 'openpgp';

const version = '2.1.3';
const platformMap = {
  'darwin-arm64': 'syncthing-macos-arm64-v' + version + '.zip',
  'darwin-x64': 'syncthing-macos-amd64-v' + version + '.zip',
  'linux-arm64': 'syncthing-linux-arm64-v' + version + '.tar.gz',
  'linux-x64': 'syncthing-linux-amd64-v' + version + '.tar.gz',
  'win32-x64': 'syncthing-windows-amd64-v' + version + '.zip',
};
const targetPlatform = process.env.KITESYNC_SYNCTHING_PLATFORM ?? process.platform;
const targetArch = process.env.KITESYNC_SYNCTHING_ARCH ?? process.arch;
const key = targetPlatform + '-' + targetArch;
const asset = platformMap[key];
if (!asset) {
  console.warn('Syncthing bootstrap is not configured for ' + key + '.');
  process.exit(0);
}

const outputDirectory = resolve('vendor/syncthing/bin', key);
const executable = resolve(
  outputDirectory,
  targetPlatform === 'win32' ? 'syncthing.exe' : 'syncthing',
);
const verificationMarker = resolve(outputDirectory, `.verified-v${version}`);
if (existsSync(executable) && existsSync(verificationMarker)) {
  try {
    const isNative = targetPlatform === process.platform && targetArch === process.arch;
    const installedVersion = isNative
      ? execFileSync(executable, ['--version'], { encoding: 'utf8' })
      : `syncthing v${version}`;
    if (installedVersion.includes(`v${version}`)) {
      console.log('Syncthing executable already exists at ' + executable);
      process.exit(0);
    }
  } catch {
    // A partial prior extraction is replaced after verification below.
  }
}

mkdirSync(outputDirectory, { recursive: true });
const releaseBase = 'https://github.com/syncthing/syncthing/releases/download/v' + version + '/';
async function downloadWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt < 1; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      lastError = new Error(`Download returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  try {
    return execFileSync('curl', ['-fsSL', '--retry', '3', url], {
      maxBuffer: 200 * 1024 * 1024,
    });
  } catch {
    throw lastError;
  }
}
const [checksumFile, archive] = await Promise.all([
  downloadWithRetry(releaseBase + 'sha256sum.txt.asc'),
  downloadWithRetry(releaseBase + asset),
]);
const signedChecksums = checksumFile.toString('utf8');
const releaseKey = await readKey({
  armoredKey: readFileSync(resolve('vendor/syncthing/release-key.asc'), 'utf8'),
});
const signedMessage = await readCleartextMessage({ cleartextMessage: signedChecksums });
const verification = await verify({ message: signedMessage, verificationKeys: releaseKey });
if (!verification.signatures[0]) throw new Error('Syncthing checksum signature is missing');
await verification.signatures[0].verified;
const verifiedChecksums = signedMessage.getText();
const expectedLine = verifiedChecksums
  .split('\n')
  .find((line) => line.trim().endsWith('  ' + asset));
if (!expectedLine) throw new Error('Pinned asset is missing from the signed checksum list');
const expected = expectedLine.trim().split(/\s+/)[0];
const actual = createHash('sha256').update(archive).digest('hex');
if (expected !== actual) throw new Error('Syncthing checksum verification failed');

const archivePath = resolve(outputDirectory, basename(asset));
writeFileSync(archivePath, archive);
if (asset.endsWith('.zip')) {
  const executableName = targetPlatform === 'win32' ? 'syncthing.exe' : 'syncthing';
  execFileSync('unzip', [
    '-j',
    '-q',
    '-o',
    archivePath,
    asset.replace(/\.zip$/, '') + '/' + executableName,
    '-d',
    outputDirectory,
  ]);
} else {
  execFileSync('tar', ['-xzf', archivePath, '--strip-components=1', '-C', outputDirectory]);
}

const extracted = resolve(
  outputDirectory,
  targetPlatform === 'win32' ? 'syncthing.exe' : 'syncthing',
);
if (!existsSync(extracted)) throw new Error('Syncthing executable was not found in the release');
if (targetPlatform !== 'win32') chmodSync(extracted, 0o755);
if (targetPlatform === process.platform && targetArch === process.arch) {
  const installedVersion = execFileSync(extracted, ['--version'], { encoding: 'utf8' });
  if (!installedVersion.includes(`v${version}`)) {
    throw new Error('Extracted Syncthing executable has an unexpected version');
  }
}
rmSync(archivePath, { force: true });
writeFileSync(verificationMarker, `${asset}\n${expected}\n`, { mode: 0o644 });
console.log('Installed signature- and checksum-verified Syncthing v' + version + '.');

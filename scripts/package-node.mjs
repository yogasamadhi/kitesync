#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import { access, chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, posix, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  assertSyncthingBuild,
  assertSyncthingSource,
  resolveSyncthingTarget,
  sha256,
} from './syncthing-source.mjs';
import { verifyGoModuleArtifacts } from './go-module-licenses.mjs';
import { assertSyncthingBinaryModules } from './verify-syncthing-modules.mjs';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('用法：bun scripts/package-node.mjs [--compile-only --output <文件>]');
  process.exit(0);
}
const compileOnly = args.includes('--compile-only');
const requestedOutput = valueAfter('--output');
if (requestedOutput && !compileOnly) throw new Error('--output 只能与 --compile-only 一起使用');
const platform = process.platform;
const arch = process.arch;
const version = normalizeVersion(process.env.KITESYNC_VERSION ?? '1.0.0');
const applicationRoot = resolve(root, 'apps/node-service');
const entrypoint = resolve(applicationRoot, 'src/main.ts');
const packagingRoot = resolve(applicationRoot, 'packaging');
const releaseRoot = resolve(root, 'release');
const stageRoot = resolve(root, '.package', `${platform}-${arch}`);
const executableName = platform === 'win32' ? 'kitesync.exe' : 'kitesync';
const compiledExecutable = requestedOutput
  ? resolve(requestedOutput)
  : resolve(stageRoot, executableName);
const distributionMetadataNames = [
  'THIRD_PARTY_NOTICES.txt',
  'SYNCTHING_NOTICE.txt',
  'SYNCTHING_LICENSE.txt',
  'SYNCTHING_GO_MODULES.json',
  'SYNCTHING_BUILD.json',
];

if (!requestedOutput) await rm(stageRoot, { recursive: true, force: true });
await mkdir(dirname(compiledExecutable), { recursive: true });
await compileNode(compiledExecutable);

if (compileOnly) {
  console.log(compiledExecutable);
  process.exit(0);
}

if (!['win32', 'darwin', 'linux'].includes(platform)) {
  throw new Error(`不支持为 ${platform}-${arch} 构建 KiteSync 安装包`);
}
if (!['x64', 'arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) {
  throw new Error(`不支持为 ${platform}-${arch} 构建 KiteSync 安装包`);
}

assertSyncthingSource();
const syncthingTarget = resolveSyncthingTarget(platform, arch);
assertSyncthingBuild(syncthingTarget);
await mkdir(releaseRoot, { recursive: true });
await copyDistributionFiles(stageRoot, syncthingTarget);

if (platform === 'win32') await packageWindows(syncthingTarget);
if (platform === 'darwin') await packageMacos(syncthingTarget);
if (platform === 'linux') await packageLinux(syncthingTarget);

async function compileNode(output) {
  await rm(output, { force: true });
  const webAssets = await readWebAssets();
  const embeddedAssetsModule = resolve(applicationRoot, 'src/embedded-web-assets.ts');
  const target = bunTarget(platform, arch);
  const windows =
    platform === 'win32'
      ? {
          hideConsole: true,
          title: 'KiteSync',
          publisher: 'KiteSync',
          version: windowsVersion(version),
          description: 'KiteSync 局域网文件同步',
          copyright: `Copyright ${new Date().getUTCFullYear()} KiteSync`,
        }
      : undefined;
  const result = await Bun.build({
    entrypoints: [entrypoint],
    format: 'esm',
    minify: true,
    define: {
      __KITESYNC_COMPILED__: 'true',
      __KITESYNC_VERSION__: JSON.stringify(version),
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    plugins: [
      {
        name: 'kitesync-embedded-web-assets',
        setup(build) {
          build.onLoad({ filter: /embedded-web-assets\.ts$/ }, (loadArgs) => {
            if (resolve(loadArgs.path) !== embeddedAssetsModule) return undefined;
            return {
              contents: `export const embeddedWebAssets = ${JSON.stringify(webAssets)};`,
              loader: 'ts',
            };
          });
        },
      },
    ],
    compile: {
      target,
      outfile: output,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
      ...(windows ? { windows } : {}),
    },
  });
  if (!result.success) throw new AggregateError(result.logs, `Bun 无法编译 ${entrypoint}`);
  await chmod(output, 0o755);
  const built = await stat(output);
  if (!built.isFile() || built.size === 0) throw new Error(`编译产物无效：${output}`);
}

async function readWebAssets() {
  const webRoot = resolve(root, 'apps/web/dist');
  try {
    await access(resolve(webRoot, 'index.html'));
  } catch {
    throw new Error('缺少 apps/web/dist/index.html；请先执行 bun run --filter @kitesync/web build');
  }
  const files = await listFiles(webRoot);
  return Object.fromEntries(
    await Promise.all(
      files.map(async (path) => {
        const webPath = `/${relative(webRoot, path).split('\\').join('/')}`;
        return [
          posix.normalize(webPath),
          {
            contentType: contentType(path),
            base64: (await readFile(path)).toString('base64'),
          },
        ];
      }),
    ),
  );
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return listFiles(path);
        if (entry.isFile()) return [path];
        return [];
      }),
  );
  return nested.flat();
}

function contentType(path) {
  const types = {
    '.avif': 'image/avif',
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.otf': 'font/otf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function copyDistributionFiles(stage, syncthingTarget) {
  verifyGoModuleArtifacts();
  await cp(syncthingTarget.binary, resolve(stage, basename(syncthingTarget.binary)));
  await cp(
    resolve(root, 'vendor/syncthing/SYNCTHING_THIRD_PARTY_LICENSES.txt'),
    resolve(stage, 'THIRD_PARTY_NOTICES.txt'),
  );
  await cp(
    resolve(root, 'vendor/syncthing/NOTICE.kitesync.txt'),
    resolve(stage, 'SYNCTHING_NOTICE.txt'),
  );
  await cp(
    resolve(root, 'vendor/syncthing/upstream/LICENSE'),
    resolve(stage, 'SYNCTHING_LICENSE.txt'),
  );
  await cp(
    resolve(root, 'vendor/syncthing/GO_MODULES.json'),
    resolve(stage, 'SYNCTHING_GO_MODULES.json'),
  );
  await cp(syncthingTarget.marker, resolve(stage, 'SYNCTHING_BUILD.json'));
  await writeDistributionBuildMarker(
    resolve(stage, 'SYNCTHING_BUILD.json'),
    resolve(stage, basename(syncthingTarget.binary)),
  );
}

async function writeDistributionBuildMarker(markerPath, distributedBinary) {
  assertSyncthingBinaryModules(distributedBinary);
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  const sourceBuildSha256 = marker.sourceBuildSha256 ?? marker.sha256;
  if (typeof sourceBuildSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sourceBuildSha256)) {
    throw new Error(`Syncthing source build marker has no valid SHA-256: ${markerPath}`);
  }
  await writeFile(
    markerPath,
    `${JSON.stringify(
      {
        ...marker,
        sourceBuildSha256,
        distributedSha256: sha256(distributedBinary),
      },
      null,
      2,
    )}\n`,
  );
}

async function packageWindows(syncthingTarget) {
  await Promise.all([
    cp(resolve(packagingRoot, 'windows/service-task.ps1'), resolve(stageRoot, 'service-task.ps1')),
    cp(resolve(packagingRoot, 'windows/firewall.ps1'), resolve(stageRoot, 'firewall.ps1')),
  ]);
  const certificate = process.env.KITESYNC_WINDOWS_CERTIFICATE;
  const password = process.env.KITESYNC_WINDOWS_CERTIFICATE_PASSWORD;
  if (Boolean(certificate) !== Boolean(password)) {
    throw new Error('Windows 代码签名证书和密码必须同时提供');
  }
  if (process.env.CI && (!certificate || !password)) {
    throw new Error('Windows 发布构建必须提供代码签名证书和密码');
  }
  if (certificate && password) {
    await signWindows(compiledExecutable, certificate, password);
    await signWindows(resolve(stageRoot, basename(syncthingTarget.binary)), certificate, password);
  }
  await writeDistributionBuildMarker(
    resolve(stageRoot, 'SYNCTHING_BUILD.json'),
    resolve(stageRoot, basename(syncthingTarget.binary)),
  );
  const installer = resolve(releaseRoot, `KiteSync-${version}-windows-x64.exe`);
  await rm(installer, { force: true });
  await exec('makensis', [
    `/DVERSION=${version}`,
    `/DSTAGE=${stageRoot}`,
    `/DOUTPUT=${installer}`,
    resolve(packagingRoot, 'windows/KiteSync.nsi'),
  ]);
  if (certificate && password) await signWindows(installer, certificate, password);
  console.log(installer);
}

async function packageMacos(syncthingTarget) {
  const app = resolve(stageRoot, 'KiteSync.app');
  const contents = resolve(app, 'Contents');
  const macos = resolve(contents, 'MacOS');
  const resources = resolve(contents, 'Resources');
  const agents = resolve(contents, 'Library/LaunchAgents');
  await rm(app, { recursive: true, force: true });
  await Promise.all([
    mkdir(macos, { recursive: true }),
    mkdir(resources, { recursive: true }),
    mkdir(agents, { recursive: true }),
  ]);
  await cp(compiledExecutable, resolve(resources, 'kitesync'));
  await cp(syncthingTarget.binary, resolve(resources, 'syncthing'));
  for (const name of distributionMetadataNames) {
    await cp(resolve(stageRoot, name), resolve(resources, name));
  }
  const macosVersion = version.split('-')[0];
  const info = (await readFile(resolve(packagingRoot, 'macos/Info.plist'), 'utf8'))
    .replaceAll('@DISPLAY_VERSION@', version)
    .replaceAll('@MARKETING_VERSION@', macosVersion)
    .replaceAll('@BUNDLE_VERSION@', macosVersion);
  await writeFile(resolve(contents, 'Info.plist'), info);
  await cp(
    resolve(packagingRoot, 'macos/com.kitesync.node.plist'),
    resolve(agents, 'com.kitesync.node.plist'),
  );
  await exec('xcrun', [
    'swiftc',
    '-O',
    '-target',
    `${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos13.0`,
    '-framework',
    'AppKit',
    '-framework',
    'ServiceManagement',
    '-framework',
    'Security',
    resolve(packagingRoot, 'macos/Launcher.swift'),
    '-o',
    resolve(macos, 'KiteSync'),
  ]);
  await Promise.all([
    chmod(resolve(macos, 'KiteSync'), 0o755),
    chmod(resolve(resources, 'kitesync'), 0o755),
    chmod(resolve(resources, 'syncthing'), 0o755),
  ]);
  await exec('xattr', ['-cr', app]);

  const identity = process.env.KITESYNC_MACOS_APPLICATION_IDENTITY;
  if (process.env.CI && !identity) throw new Error('macOS 发布构建必须提供应用签名 identity');
  const signer = identity ?? '-';
  await exec('codesign', [
    '--force',
    '--options',
    'runtime',
    ...(identity ? ['--timestamp'] : []),
    '--entitlements',
    resolve(packagingRoot, 'macos/bun.entitlements.plist'),
    '--sign',
    signer,
    resolve(resources, 'kitesync'),
  ]);
  for (const executable of [resolve(resources, 'syncthing'), resolve(macos, 'KiteSync')]) {
    await exec('codesign', [
      '--force',
      '--options',
      'runtime',
      ...(identity ? ['--timestamp'] : []),
      '--sign',
      signer,
      executable,
    ]);
  }
  await writeDistributionBuildMarker(
    resolve(resources, 'SYNCTHING_BUILD.json'),
    resolve(resources, 'syncthing'),
  );
  await exec('codesign', [
    '--force',
    '--options',
    'runtime',
    ...(identity ? ['--timestamp'] : []),
    '--sign',
    signer,
    app,
  ]);
  await exec('xattr', ['-cr', app]);
  await exec('codesign', ['--verify', '--deep', '--strict', app]);

  const installer = resolve(releaseRoot, `KiteSync-${version}-macos-${arch}.pkg`);
  await rm(installer, { force: true });
  const packageArgs = [
    '--component',
    app,
    '--install-location',
    '/Applications',
    '--identifier',
    'com.kitesync.app',
    '--version',
    macosVersion,
  ];
  const installerIdentity = process.env.KITESYNC_MACOS_INSTALLER_IDENTITY;
  if (process.env.CI && !installerIdentity) {
    throw new Error('macOS 发布构建必须提供安装器签名 identity');
  }
  if (installerIdentity) packageArgs.push('--sign', installerIdentity);
  packageArgs.push(installer);
  await exec('pkgbuild', packageArgs, { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const notaryProfile = process.env.KITESYNC_MACOS_NOTARY_PROFILE;
  if (process.env.CI && !notaryProfile) {
    throw new Error('macOS 发布构建必须提供 KITESYNC_MACOS_NOTARY_PROFILE');
  }
  if (notaryProfile) {
    const notaryKeychain = process.env.KITESYNC_MACOS_NOTARY_KEYCHAIN;
    await exec('xcrun', [
      'notarytool',
      'submit',
      installer,
      '--keychain-profile',
      notaryProfile,
      ...(notaryKeychain ? ['--keychain', notaryKeychain] : []),
      '--wait',
    ]);
    await exec('xcrun', ['stapler', 'staple', installer]);
    await exec('xcrun', ['stapler', 'validate', installer]);
  }
  console.log(installer);
}

async function packageLinux(syncthingTarget) {
  const packageRoot = resolve(stageRoot, 'linux-root');
  const installRoot = resolve(packageRoot, 'opt/kitesync');
  await rm(packageRoot, { recursive: true, force: true });
  await Promise.all([
    mkdir(installRoot, { recursive: true }),
    mkdir(resolve(packageRoot, 'usr/share/applications'), { recursive: true }),
    mkdir(resolve(packageRoot, 'usr/lib/systemd/user'), { recursive: true }),
    mkdir(resolve(packageRoot, 'usr/lib/systemd/system'), { recursive: true }),
  ]);
  await cp(compiledExecutable, resolve(installRoot, 'kitesync'));
  await cp(syncthingTarget.binary, resolve(installRoot, 'syncthing'));
  for (const name of distributionMetadataNames) {
    await cp(resolve(stageRoot, name), resolve(installRoot, name));
  }
  await cp(
    resolve(packagingRoot, 'linux/kitesync.desktop'),
    resolve(packageRoot, 'usr/share/applications/kitesync.desktop'),
  );
  await cp(
    resolve(packagingRoot, 'linux/kitesync-user.service'),
    resolve(packageRoot, 'usr/lib/systemd/user/kitesync.service'),
  );
  await cp(
    resolve(packagingRoot, 'linux/kitesync-system.service'),
    resolve(packageRoot, 'usr/lib/systemd/system/kitesync.service'),
  );
  const environment = {
    ...process.env,
    KITESYNC_PACKAGE_ROOT: packageRoot,
    KITESYNC_PACKAGE_VERSION: version,
    KITESYNC_PACKAGE_ARCH: arch === 'x64' ? 'amd64' : 'arm64',
  };
  for (const packager of ['deb', 'rpm']) {
    const target = resolve(releaseRoot, `KiteSync-${version}-linux-${arch}.${packager}`);
    await rm(target, { force: true });
    await exec(
      'nfpm',
      [
        'package',
        '--packager',
        packager,
        '--config',
        resolve(packagingRoot, 'linux/nfpm.yaml'),
        '--target',
        target,
      ],
      { cwd: root, env: environment },
    );
    console.log(target);
  }
}

async function signWindows(path, certificate, password) {
  const signTool = process.env.KITESYNC_SIGNTOOL ?? 'signtool.exe';
  if (process.env.CI && !process.env.KITESYNC_SIGNTOOL) {
    throw new Error('Windows 发布构建必须显式提供 KITESYNC_SIGNTOOL');
  }
  if (process.env.KITESYNC_SIGNTOOL) await access(signTool);
  await exec(signTool, [
    'sign',
    '/fd',
    'SHA256',
    '/td',
    'SHA256',
    '/tr',
    'https://timestamp.digicert.com',
    '/f',
    certificate,
    '/p',
    password,
    path,
  ]);
}

function bunTarget(targetPlatform, targetArch) {
  const os = targetPlatform === 'win32' ? 'windows' : targetPlatform;
  const baseline = targetArch === 'x64' && ['windows', 'linux'].includes(os) ? '-baseline' : '';
  return `bun-${os}-${targetArch}${baseline}`;
}

function normalizeVersion(input) {
  const value = input.replace(/^v/, '').split('+')[0];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`无效的发布版本：${input}`);
  }
  return value;
}

function windowsVersion(input) {
  const values = input.split('-')[0].split('.');
  return [...values, '0'].slice(0, 4).join('.');
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} 需要路径参数`);
  return value;
}

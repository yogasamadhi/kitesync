import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isIP } from 'node:net';
import { delimiter, dirname, join, resolve } from 'node:path';

declare const __KITESYNC_COMPILED__: boolean | undefined;
declare const __KITESYNC_VERSION__: string | undefined;

const NODE_VERSION =
  (typeof __KITESYNC_VERSION__ !== 'undefined' ? __KITESYNC_VERSION__ : undefined) ??
  process.env.KITESYNC_VERSION ??
  '1.0.0-dev';

export interface NodeConfig {
  version: string;
  compiled: boolean;
  stateDirectory: string;
  statePath: string;
  lockPath: string;
  hostOverride?: string;
  portOverride?: number;
  syncthingBinary: string;
  syncthingHome: string;
  syncthingApiKeyFile: string;
  syncthingUrl: string;
  syncthingGuiPort: number;
  webRoot: string;
  headless: boolean;
  directoryRoots?: string[];
  adminPasswordFile?: string;
}

function standaloneExecutable() {
  return (
    (typeof __KITESYNC_COMPILED__ !== 'undefined' && __KITESYNC_COMPILED__) ||
    import.meta.url.includes('/$bunfs/') ||
    import.meta.url.includes('\\$bunfs\\')
  );
}

function developmentRoot() {
  return resolve(import.meta.dirname, '../../..');
}

interface SyncthingBinaryOptions {
  standalone: boolean;
  executablePath: string;
  platform: NodeJS.Platform;
  arch: string;
  override?: string;
}

export function resolveSyncthingBinary(
  options: SyncthingBinaryOptions,
  resolveSourceRoot: () => string = developmentRoot,
) {
  if (options.override) return options.override;
  const name = options.platform === 'win32' ? 'syncthing.exe' : 'syncthing';
  if (options.standalone) return join(dirname(options.executablePath), name);
  return join(
    resolveSourceRoot(),
    'vendor',
    'syncthing',
    'bin',
    `${options.platform}-${options.arch}`,
    name,
  );
}

interface StateDirectoryOptions {
  platform?: NodeJS.Platform;
  home?: string;
  environment?: NodeJS.ProcessEnv;
  pathExists?: (path: string) => boolean;
}

function hasLegacySyncthingState(root: string, pathExists: (path: string) => boolean) {
  const syncthing = join(root, 'syncthing');
  return ['config.xml', 'cert.pem', 'key.pem'].some((name) => pathExists(join(syncthing, name)));
}

export function productionStateDirectory(options: StateDirectoryOptions = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const environment = options.environment ?? process.env;
  const pathExists = options.pathExists ?? existsSync;
  if (platform === 'win32') {
    const legacy = join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'KiteSync');
    if (hasLegacySyncthingState(legacy, pathExists)) return legacy;
    return join(environment.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'KiteSync');
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'KiteSync');
  }
  if (home === '/var/lib/kitesync' || environment.USER === 'kitesync') {
    return '/var/lib/kitesync';
  }
  const legacy = join(environment.XDG_CONFIG_HOME ?? join(home, '.config'), 'KiteSync');
  if (hasLegacySyncthingState(legacy, pathExists)) return legacy;
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'kitesync');
}

function optionalPort(value: string | undefined) {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('KITESYNC_PORT 必须是 1 到 65535 之间的整数');
  }
  return port;
}

export function normalizeSyncthingUrl(value: string, expectedPort: number) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('KITESYNC_SYNCTHING_URL 必须是有效的本机 HTTP URL');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const version = isIP(hostname);
  const loopback =
    hostname === 'localhost' ||
    (version === 4 && Number(hostname.split('.')[0]) === 127) ||
    (version === 6 && hostname === '::1');
  if (
    parsed.protocol !== 'http:' ||
    !loopback ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    Number(parsed.port) !== expectedPort
  ) {
    throw new Error(
      `KITESYNC_SYNCTHING_URL 只能是不含凭据或路径的本机 HTTP 地址，且端口必须为 ${expectedPort}`,
    );
  }
  return parsed.origin;
}

export function isHeadlessEnvironment(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
) {
  return (
    environment.KITESYNC_HEADLESS === '1' ||
    (platform === 'linux' && !environment.DISPLAY && !environment.WAYLAND_DISPLAY)
  );
}

/** Packaged sidecars intentionally live beside process.execPath. */
export function loadConfig(): NodeConfig {
  const standalone = standaloneExecutable();
  const stateDirectory =
    process.env.KITESYNC_STATE_DIR ??
    (standalone ? productionStateDirectory() : join(developmentRoot(), '.kitesync-dev', 'node'));
  const executableDirectory = dirname(process.execPath);
  const portOverride = optionalPort(process.env.KITESYNC_UI_PORT ?? process.env.KITESYNC_PORT);
  const syncthingGuiPort = optionalPort(process.env.KITESYNC_SYNCTHING_GUI_PORT) ?? 8385;
  const hostOverride = process.env.KITESYNC_UI_HOST ?? process.env.KITESYNC_HOST;

  return {
    version: NODE_VERSION,
    compiled: standalone,
    stateDirectory,
    statePath: join(stateDirectory, 'state.json'),
    lockPath: join(stateDirectory, 'node.lock'),
    ...(hostOverride ? { hostOverride } : {}),
    ...(portOverride === undefined ? {} : { portOverride }),
    syncthingBinary: resolveSyncthingBinary({
      standalone,
      executablePath: process.execPath,
      platform: process.platform,
      arch: process.arch,
      ...(process.env.KITESYNC_SYNCTHING_BINARY
        ? { override: process.env.KITESYNC_SYNCTHING_BINARY }
        : {}),
    }),
    syncthingHome: process.env.KITESYNC_SYNCTHING_HOME ?? join(stateDirectory, 'syncthing'),
    syncthingApiKeyFile:
      process.env.KITESYNC_SYNCTHING_API_KEY_FILE ?? join(stateDirectory, 'syncthing-api-key'),
    syncthingUrl: normalizeSyncthingUrl(
      process.env.KITESYNC_SYNCTHING_URL ?? `http://127.0.0.1:${syncthingGuiPort}`,
      syncthingGuiPort,
    ),
    syncthingGuiPort,
    webRoot:
      process.env.KITESYNC_WEB_ROOT ??
      (standalone
        ? join(executableDirectory, 'web')
        : join(developmentRoot(), 'apps', 'web', 'dist')),
    headless: isHeadlessEnvironment(),
    ...(process.env.KITESYNC_DIRECTORY_ROOTS
      ? {
          directoryRoots: process.env.KITESYNC_DIRECTORY_ROOTS.split(delimiter)
            .map((value) => value.trim())
            .filter(Boolean),
        }
      : {}),
    ...(process.env.KITESYNC_ADMIN_PASSWORD_FILE
      ? { adminPasswordFile: process.env.KITESYNC_ADMIN_PASSWORD_FILE }
      : {}),
  };
}

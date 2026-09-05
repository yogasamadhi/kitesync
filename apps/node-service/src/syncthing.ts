import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createNetServer, isIP } from 'node:net';
import { createSocket } from 'node:dgram';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import type { FolderType } from '@kitesync/contracts';
import type { NodeConfig } from './config.js';
import { createSecretFile } from './secret-store.js';

export interface SyncthingDeviceConfig {
  deviceID: string;
  name?: string;
  addresses?: string[];
  paused?: boolean;
  autoAcceptFolders?: boolean;
  introducer?: boolean;
  ignoredFolders?: Array<{ id: string; label?: string; time?: string }>;
  [key: string]: unknown;
}

export interface SyncthingFolderConfig {
  id: string;
  label?: string;
  path: string;
  type?: FolderType;
  paused?: boolean;
  markerName?: string;
  devices?: Array<{ deviceID: string; [key: string]: unknown }>;
  versioning?: { type: string; params?: Record<string, string> };
  rescanIntervalS?: number;
}

export interface SyncthingFolderPathConflict {
  folderId: string;
  label: string;
  relation: 'same' | 'ancestor' | 'descendant';
}

export class FolderPathConflictError extends Error {
  constructor(readonly conflicts: SyncthingFolderPathConflict[]) {
    super('所选目录与已有同步文件夹重叠');
    this.name = 'FolderPathConflictError';
  }
}

export interface SyncthingSystemStatus {
  myID: string;
  uptime?: number;
  guiAddressUsed?: string;
  connectionServiceStatus?: Record<
    string,
    { error?: string | null; lanAddresses?: string[]; wanAddresses?: string[] }
  >;
}

interface SyncthingOptions {
  listenAddresses?: string[];
  localAnnounceEnabled?: boolean;
  [key: string]: unknown;
}

interface IgnoredDeviceValue {
  deviceID: string;
  name?: string;
  address?: string;
  time?: string;
}

interface SyncthingConfiguration {
  remoteIgnoredDevices?: IgnoredDeviceValue[];
  [key: string]: unknown;
}

interface PendingFolderValue {
  offeredBy?: Record<string, { time?: string; label?: string }>;
}

export interface SyncthingVersion {
  versionTime: string;
  modTime?: string;
  size: number;
}

interface SyncthingDbFileInfo {
  size?: number;
  blocksHash?: string;
  version?: string[];
  sequence?: number;
  deleted?: boolean;
  mustRescan?: boolean;
}

interface SyncthingDbFile {
  local?: SyncthingDbFileInfo;
  global?: SyncthingDbFileInfo;
}

const LEGACY_LOOPBACK_LISTENERS = new Set([
  'tcp://127.0.0.1:22000',
  'quic://127.0.0.1:22000',
  'tcp://[::1]:22000',
  'quic://[::1]:22000',
]);
function boundedPeerText(value: unknown, fallback: string, maximum: number) {
  const safe =
    typeof value === 'string'
      ? [...value]
          .map((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code <= 31 || code === 127 ? ' ' : character;
          })
          .join('')
          .trim()
      : '';
  return (safe || fallback).slice(0, maximum);
}

function safeListenAddress(address: string) {
  return address === 'default' || /^(?:tcp|quic)(?:4|6)?:\/\//i.test(address);
}

function replaceOption(xml: string, name: string, value: string) {
  const expression = new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${name}>`, 'g');
  const without = xml.replace(expression, '');
  return without.replace('</options>', `        <${name}>${value}</${name}>\n    </options>`);
}

export function hardenSyncthingXml(xml: string, fallbackToRandomPorts = false) {
  const match = xml.match(/<options(?:\s[^>]*)?>[\s\S]*?<\/options>/);
  if (!match) throw new Error('Syncthing config.xml 缺少 options');
  let options = match[0];
  const listeners = [...options.matchAll(/<listenAddress(?:\s[^>]*)?>([\s\S]*?)<\/listenAddress>/g)]
    .map((entry) => entry[1]?.trim() ?? '')
    .filter((address) => address && safeListenAddress(address));
  const onlyLegacy =
    listeners.length > 0 && listeners.every((address) => LEGACY_LOOPBACK_LISTENERS.has(address));
  const usesDefault = listeners.includes('default');
  const safeListeners =
    onlyLegacy || (fallbackToRandomPorts && usesDefault)
      ? fallbackToRandomPorts
        ? ['tcp://0.0.0.0:0', 'quic://0.0.0.0:0']
        : ['tcp://0.0.0.0:22000', 'quic://0.0.0.0:22000']
      : listeners.length
        ? listeners
        : ['tcp://0.0.0.0:0', 'quic://0.0.0.0:0'];
  options = options.replace(/\s*<listenAddress(?:\s[^>]*)?>[\s\S]*?<\/listenAddress>/g, '');
  options = options.replace(
    '</options>',
    `${safeListeners.map((address) => `\n        <listenAddress>${address}</listenAddress>`).join('')}\n    </options>`,
  );
  for (const [name, value] of [
    ['globalAnnounceEnabled', 'false'],
    ['localAnnounceEnabled', 'true'],
    ['relaysEnabled', 'false'],
    ['natEnabled', 'false'],
    ['announceLANAddresses', 'true'],
    ['startBrowser', 'false'],
    ['urAccepted', '-1'],
    ['crashReportingEnabled', 'false'],
    ['stunKeepaliveStartS', '0'],
    ['autoUpgradeIntervalH', '0'],
    ['releasesURL', ''],
  ] as const) {
    options = replaceOption(options, name, value);
  }
  options = options.replace(
    /\s*<globalAnnounceServer(?:\s[^>]*)?>[\s\S]*?<\/globalAnnounceServer>/g,
    '',
  );
  options = options.replace(/\s*<stunServer(?:\s[^>]*)?>[\s\S]*?<\/stunServer>/g, '');
  return xml.replace(match[0], options);
}

function tcpPortAvailable(port: number) {
  return new Promise<boolean>((resolvePromise) => {
    const server = createNetServer();
    server.unref();
    server.once('error', () => resolvePromise(false));
    server.listen({ host: '0.0.0.0', port, exclusive: true }, () =>
      server.close(() => resolvePromise(true)),
    );
  });
}

export function udpPortAvailable(port: number) {
  return new Promise<boolean>((resolvePromise) => {
    const socket = createSocket('udp4');
    socket.unref();
    socket.once('error', () => {
      try {
        socket.close();
      } catch {
        // A failed bind can already leave the datagram socket in a non-running state.
      }
      resolvePromise(false);
    });
    socket.bind(port, '0.0.0.0', () => {
      socket.close();
      resolvePromise(true);
    });
  });
}

export function safeRelativeChild(value: string) {
  return (
    value === '' ||
    (value !== '..' &&
      !value.startsWith(`..${sep}`) &&
      !isAbsolute(value) &&
      !win32.isAbsolute(value))
  );
}

export async function loadOrCreateSyncthingApiKey(path: string) {
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (!existing) throw new Error('Syncthing API Key 文件为空');
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await createSecretFile(path, randomBytes(32).toString('base64url'));
  const winner = (await readFile(path, 'utf8')).trim();
  if (!winner) throw new Error('Syncthing API Key 创建失败');
  return winner;
}

function inside(parent: string, child: string) {
  return safeRelativeChild(relative(parent, child));
}

function comparablePath(path: string) {
  const normalized = resolve(path).replace(/[\\/]+$/, '');
  return process.platform === 'darwin' || process.platform === 'win32'
    ? normalized.toLocaleLowerCase('en-US')
    : normalized;
}

export function folderPathRelation(
  candidate: string,
  existing: string,
): SyncthingFolderPathConflict['relation'] | undefined {
  const left = comparablePath(candidate);
  const right = comparablePath(existing);
  if (left === right) return 'same';
  if (inside(left, right)) return 'ancestor';
  if (inside(right, left)) return 'descendant';
  return undefined;
}

async function realFolderPath(path: string) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export function loopbackGuiAddress(value: string | undefined, expectedPort: number) {
  if (!value || value.includes('://')) return false;
  try {
    const parsed = new URL(`http://${value}`);
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const version = isIP(host);
    const loopback =
      host === 'localhost' ||
      (version === 4 && Number(host.split('.')[0]) === 127) ||
      (version === 6 && host === '::1');
    return (
      loopback &&
      Number(parsed.port) === expectedPort &&
      !parsed.username &&
      !parsed.password &&
      parsed.pathname === '/'
    );
  } catch {
    return false;
  }
}

function databaseFileSignature(value: SyncthingDbFileInfo | undefined) {
  if (!value) return '';
  return JSON.stringify([
    value.size,
    value.blocksHash,
    value.version,
    value.sequence,
    value.deleted,
    value.mustRescan,
  ]);
}

function databaseFilesEquivalent(
  left: SyncthingDbFileInfo | undefined,
  right: SyncthingDbFileInfo | undefined,
) {
  return Boolean(
    left &&
    right &&
    left.size === right.size &&
    left.blocksHash === right.blocksHash &&
    left.deleted === right.deleted &&
    JSON.stringify(left.version ?? []) === JSON.stringify(right.version ?? []),
  );
}

export function listenerHasBindError(status: SyncthingSystemStatus) {
  return Object.entries(status.connectionServiceStatus ?? {}).some(
    ([address, entry]) =>
      safeListenAddress(address) &&
      Boolean(entry.error && /address already in use|bind/i.test(entry.error)),
  );
}

export class LocalSyncthing {
  private child: ChildProcess | undefined;
  private starting: Promise<boolean> | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private stableTimer: NodeJS.Timeout | undefined;
  private restartAttempts = 0;
  private stopping = false;
  private adopted = false;
  private configMutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: NodeConfig,
    private readonly onEvent: (
      level: 'info' | 'warn' | 'error',
      message: string,
    ) => void = () => {},
  ) {}

  start() {
    this.stopping = false;
    if (this.starting) return this.starting;
    const operation = this.startOnce();
    this.starting = operation;
    const clear = () => {
      if (this.starting === operation) this.starting = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  private async startOnce() {
    const apiKey = await this.ensureApiKey();
    let alreadyRunning = false;
    try {
      await this.status();
      alreadyRunning = true;
    } catch {
      try {
        const health = await fetch(`${this.config.syncthingUrl}/rest/noauth/health`, {
          signal: AbortSignal.timeout(1_500),
        });
        if (health.ok) {
          throw new Error(
            `Syncthing REST 端口 ${this.config.syncthingGuiPort} 已被未知实例占用；请设置 KITESYNC_SYNCTHING_GUI_PORT`,
          );
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('未知实例占用')) throw error;
      }
    }
    if (alreadyRunning) {
      await this.assertOwnedInstance();
      this.adopted = true;
      await this.ensureLanOnlyConfiguration();
      this.onEvent('info', '已接管属于当前 KiteSync 实例的 Syncthing');
      return false;
    }

    this.adopted = false;
    await mkdir(this.config.syncthingHome, { recursive: true, mode: 0o700 });
    await this.generateAndHardenConfiguration();
    let spawnError: Error | undefined;
    const child = spawn(
      this.config.syncthingBinary,
      [
        'serve',
        `--home=${this.config.syncthingHome}`,
        `--gui-address=127.0.0.1:${this.config.syncthingGuiPort}`,
        `--gui-apikey=${apiKey}`,
        '--no-browser',
        '--no-restart',
        '--no-upgrade',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    this.child = child;
    let ready = false;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.onEvent(
        this.stopping ? 'info' : 'warn',
        `Syncthing 已退出（code=${code ?? 'null'}，signal=${signal ?? 'none'}）`,
      );
      if (ready && !this.stopping) this.scheduleRestart();
    });
    const errors: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      errors.push(String(chunk).slice(0, 1_000));
      if (errors.length > 16) errors.shift();
    });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (spawnError) throw new Error(`Syncthing 启动失败：${spawnError.message}`);
      if (child.exitCode !== null) {
        throw new Error(`Syncthing 启动失败：${errors.join('').slice(-2_000)}`);
      }
      try {
        await this.assertOwnedInstance();
        await this.ensureLanOnlyConfiguration();
        ready = true;
        this.onEvent('info', 'Syncthing 已就绪并应用 LAN-only 安全配置');
        this.scheduleStableReset();
        if (child.exitCode !== null && !this.stopping) this.scheduleRestart();
        return true;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error('等待 Syncthing 启动超时');
  }

  private async generateAndHardenConfiguration() {
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(
        this.config.syncthingBinary,
        ['generate', `--home=${this.config.syncthingHome}`],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
      );
      const errors: Buffer[] = [];
      child.stderr.on('data', (value: Buffer) => {
        errors.push(value.subarray(0, 1_000));
        if (errors.length > 16) errors.shift();
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolvePromise();
        else
          reject(
            new Error(
              `Syncthing 初始化失败：${Buffer.concat(errors).toString('utf8').slice(-2_000)}`,
            ),
          );
      });
    });
    const path = resolve(this.config.syncthingHome, 'config.xml');
    const original = await readFile(path, 'utf8');
    const defaultPortBusy = !(await tcpPortAvailable(22_000)) || !(await udpPortAvailable(22_000));
    const hardened = hardenSyncthingXml(original, defaultPortBusy);
    if (hardened === original) return;
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const mode = (await stat(path)).mode & 0o777;
    const handle = await open(temporary, 'wx', mode || 0o600);
    try {
      await handle.writeFile(hardened, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
      if (process.platform !== 'win32') {
        const directory = await open(dirname(path), 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async assertOwnedInstance() {
    const [paths, status] = await Promise.all([
      this.request<Record<string, string>>('/rest/system/paths'),
      this.status(),
    ]);
    const expected = resolve(this.config.syncthingHome);
    const bases = [paths['baseDir-config'], paths['baseDir-data']].filter(
      (value): value is string => typeof value === 'string',
    );
    if (!bases.length || bases.some((value) => !inside(expected, resolve(value)))) {
      throw new Error(
        `Syncthing REST 端口 ${this.config.syncthingGuiPort} 已被另一个实例占用；请设置 KITESYNC_SYNCTHING_GUI_PORT`,
      );
    }
    if (!loopbackGuiAddress(status.guiAddressUsed, this.config.syncthingGuiPort)) {
      throw new Error(
        `同一 home 的 Syncthing GUI/REST 未安全监听 loopback；请先停止该实例后再启动 KiteSync`,
      );
    }
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.restartTimer = undefined;
    this.stableTimer = undefined;
    const child = this.child;
    if (!child || child.exitCode !== null) {
      if (!this.adopted) return;
      // Revalidate immediately before shutdown so a process that merely reused the REST port
      // can never be terminated as an adopted KiteSync sidecar.
      await this.assertOwnedInstance();
      this.adopted = false;
      await this.request<void>('/rest/system/shutdown', { method: 'POST' }).catch(() => undefined);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          await this.status();
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        } catch {
          return;
        }
      }
      throw new Error('等待已接管的 Syncthing 退出超时');
    }
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }

  private scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    const delay = Math.min(1_000 * 2 ** this.restartAttempts, 30_000);
    this.restartAttempts = Math.min(this.restartAttempts + 1, 6);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start().catch((error: unknown) => {
        this.onEvent(
          'error',
          `Syncthing 自动重启失败：${error instanceof Error ? error.message : String(error)}`,
        );
        console.error(
          `Syncthing 自动重启失败：${error instanceof Error ? error.message : String(error)}`,
        );
        this.scheduleRestart();
      });
    }, delay);
  }

  private scheduleStableReset() {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.restartAttempts = 0;
      this.stableTimer = undefined;
    }, 5 * 60_000);
  }

  async ensureLanOnlyConfiguration() {
    const current = await this.options();
    const configuredListeners = (current.listenAddresses ?? ['default']).filter(safeListenAddress);
    const legacy =
      configuredListeners.length > 0 &&
      configuredListeners.every((address) => LEGACY_LOOPBACK_LISTENERS.has(address));
    const listenAddresses = legacy
      ? ['default']
      : configuredListeners.length
        ? configuredListeners
        : ['default'];
    await this.patchOptions({
      globalAnnounceEnabled: false,
      globalAnnounceServers: [],
      localAnnounceEnabled: true,
      announceLANAddresses: true,
      relaysEnabled: false,
      natEnabled: false,
      stunServers: [],
      stunKeepaliveStartS: 0,
      crashReportingEnabled: false,
      urAccepted: -1,
      startBrowser: false,
      releasesURL: '',
      autoUpgradeIntervalH: 0,
      listenAddresses,
    });

    let ephemeral = listenAddresses.some((address) => /:0$/.test(address));
    // A concrete port persisted on a previous run can later become occupied too. Inspect
    // only TCP/QUIC listener services before switching to Syncthing-selected ports.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    if (listenerHasBindError(await this.status())) {
      await this.patchOptions({
        listenAddresses: ['tcp://0.0.0.0:0', 'quic://0.0.0.0:0'],
      });
      ephemeral = true;
    }
    if (ephemeral) await this.persistChosenListenerPorts();
  }

  private async persistChosenListenerPorts() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await this.status();
      const listeners = new Map<string, string>();
      for (const entry of Object.values(status.connectionServiceStatus ?? {})) {
        for (const address of entry.lanAddresses ?? []) {
          try {
            const parsed = new URL(address);
            const protocol = parsed.protocol.slice(0, -1);
            if ((protocol === 'tcp' || protocol === 'quic') && Number(parsed.port) > 0) {
              listeners.set(protocol, `${protocol}://0.0.0.0:${parsed.port}`);
            }
          } catch {
            // Wait for a complete listener report below.
          }
        }
      }
      if (listeners.has('tcp') && listeners.has('quic')) {
        await this.patchOptions({ listenAddresses: [...listeners.values()] });
        return;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    throw new Error('Syncthing 未能报告动态选择的同步端口');
  }

  status() {
    return this.request<SyncthingSystemStatus>('/rest/system/status');
  }

  version() {
    return this.request<{ version: string }>('/rest/system/version');
  }

  options() {
    return this.request<SyncthingOptions>('/rest/config/options');
  }

  patchOptions(value: Partial<SyncthingOptions>) {
    return this.mutateConfiguration(() =>
      this.request<void>('/rest/config/options', {
        method: 'PATCH',
        body: JSON.stringify(value),
      }),
    );
  }

  connections() {
    return this.request<{
      connections: Record<string, { connected?: boolean; at?: string; address?: string }>;
    }>('/rest/system/connections');
  }

  deviceStats() {
    return this.request<Record<string, { lastSeen?: string }>>('/rest/stats/device');
  }

  folderStats() {
    return this.request<Record<string, { lastFile?: { at?: string } }>>('/rest/stats/folder');
  }

  discovery() {
    return this.request<Record<string, { addresses?: string[] }>>('/rest/system/discovery');
  }

  devices() {
    return this.request<SyncthingDeviceConfig[]>('/rest/config/devices');
  }

  device(id: string) {
    return this.request<SyncthingDeviceConfig>(`/rest/config/devices/${encodeURIComponent(id)}`);
  }

  putDevice(value: SyncthingDeviceConfig) {
    return this.mutateConfiguration(() =>
      this.request<void>(`/rest/config/devices/${encodeURIComponent(value.deviceID)}`, {
        method: 'PUT',
        body: JSON.stringify(value),
      }),
    );
  }

  patchDevice(id: string, value: Partial<SyncthingDeviceConfig>) {
    return this.mutateConfiguration(() =>
      this.request<void>(`/rest/config/devices/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(value),
      }),
    );
  }

  removeDevice(id: string) {
    return this.mutateConfiguration(() =>
      this.request<void>(`/rest/config/devices/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    );
  }

  pendingDevices() {
    return this.request<
      Record<string, { time?: string; name?: string; address?: string; deviceID?: string }>
    >('/rest/cluster/pending/devices');
  }

  dismissPendingDevice(id: string) {
    return this.request<void>(`/rest/cluster/pending/devices?device=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async ignoredDevices() {
    return (await this.configuration()).remoteIgnoredDevices ?? [];
  }

  async ignorePendingDevice(id: string) {
    const pending = (await this.pendingDevices())[id];
    if (!pending) throw new Error('待处理设备不存在');
    await this.mutateConfiguration(async () => {
      const configuration = await this.configuration();
      const existing = (configuration.remoteIgnoredDevices ?? []).filter(
        (item) => item.deviceID !== id,
      );
      configuration.remoteIgnoredDevices = [
        ...existing,
        {
          deviceID: id,
          name: boundedPeerText(pending.name, id.slice(0, 7), 64),
          address: boundedPeerText(pending.address, 'dynamic', 512),
          time: new Date().toISOString(),
        },
      ];
      await this.putConfiguration(configuration);
    });
    await this.dismissPendingDevice(id).catch(() => undefined);
  }

  async unignoreDevice(id: string) {
    await this.mutateConfiguration(async () => {
      const configuration = await this.configuration();
      configuration.remoteIgnoredDevices = (configuration.remoteIgnoredDevices ?? []).filter(
        (item) => item.deviceID !== id,
      );
      await this.putConfiguration(configuration);
    });
  }

  async removeAndIgnoreDevice(id: string) {
    await this.mutateConfiguration(async () => {
      const device = await this.request<SyncthingDeviceConfig>(
        `/rest/config/devices/${encodeURIComponent(id)}`,
      );
      const folders = await this.request<SyncthingFolderConfig[]>('/rest/config/folders');
      for (const folder of folders) {
        if (!(folder.devices ?? []).some((item) => item.deviceID === id)) continue;
        await this.request<void>(`/rest/config/folders/${encodeURIComponent(folder.id)}`, {
          method: 'PUT',
          body: JSON.stringify({
            ...folder,
            devices: (folder.devices ?? []).filter((item) => item.deviceID !== id),
          }),
        });
      }
      await this.request<void>(`/rest/config/devices/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      const configuration = await this.configuration();
      configuration.remoteIgnoredDevices = [
        ...(configuration.remoteIgnoredDevices ?? []).filter((item) => item.deviceID !== id),
        {
          deviceID: id,
          name: boundedPeerText(device.name, id.slice(0, 7), 64),
          address: boundedPeerText(device.addresses?.[0], 'dynamic', 512),
          time: new Date().toISOString(),
        },
      ];
      await this.putConfiguration(configuration);
    });
  }

  async pendingFolders() {
    const output: Array<{
      folderId: string;
      label: string;
      deviceId: string;
      offeredAt: string;
    }> = [];
    for (const device of await this.devices()) {
      const folders = await this.request<Record<string, PendingFolderValue>>(
        `/rest/cluster/pending/folders?device=${encodeURIComponent(device.deviceID)}`,
      );
      for (const [folderId, value] of Object.entries(folders)) {
        const offered = value.offeredBy?.[device.deviceID];
        output.push({
          folderId,
          label: offered?.label || folderId,
          deviceId: device.deviceID,
          offeredAt: offered?.time ?? new Date().toISOString(),
        });
      }
    }
    return output;
  }

  async ignoredFolders() {
    return (await this.devices()).flatMap((device) =>
      (device.ignoredFolders ?? []).map((folder) => ({
        folderId: folder.id,
        label: folder.label || folder.id,
        deviceId: device.deviceID,
        deviceName: device.name || device.deviceID.slice(0, 7),
        ignoredAt: folder.time ?? new Date(0).toISOString(),
      })),
    );
  }

  async ignorePendingFolder(deviceId: string, folderId: string) {
    await this.mutateConfiguration(async () => {
      const [device, pending] = await Promise.all([
        this.request<SyncthingDeviceConfig>(`/rest/config/devices/${encodeURIComponent(deviceId)}`),
        this.request<Record<string, PendingFolderValue>>(
          `/rest/cluster/pending/folders?device=${encodeURIComponent(deviceId)}`,
        ),
      ]);
      const offered = pending[folderId]?.offeredBy?.[deviceId];
      if (!pending[folderId]) throw new Error('待处理文件夹不存在');
      device.ignoredFolders = [
        ...(device.ignoredFolders ?? []).filter((folder) => folder.id !== folderId),
        {
          id: folderId,
          label: boundedPeerText(offered?.label, folderId, 128),
          time: new Date().toISOString(),
        },
      ];
      await this.request<void>(`/rest/config/devices/${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        body: JSON.stringify(device),
      });
    });
    await this.dismissPendingFolder(deviceId, folderId).catch(() => undefined);
  }

  async unignoreFolder(deviceId: string, folderId: string) {
    await this.mutateConfiguration(async () => {
      const device = await this.request<SyncthingDeviceConfig>(
        `/rest/config/devices/${encodeURIComponent(deviceId)}`,
      );
      device.ignoredFolders = (device.ignoredFolders ?? []).filter(
        (folder) => folder.id !== folderId,
      );
      await this.request<void>(`/rest/config/devices/${encodeURIComponent(deviceId)}`, {
        method: 'PUT',
        body: JSON.stringify(device),
      });
    });
  }

  dismissPendingFolder(deviceId: string, folderId: string) {
    const query = new URLSearchParams({ device: deviceId, folder: folderId });
    return this.request<void>(`/rest/cluster/pending/folders?${query}`, { method: 'DELETE' });
  }

  folders() {
    return this.request<SyncthingFolderConfig[]>('/rest/config/folders');
  }

  folder(id: string) {
    return this.request<SyncthingFolderConfig>(`/rest/config/folders/${encodeURIComponent(id)}`);
  }

  putFolder(value: SyncthingFolderConfig) {
    return this.mutateConfiguration(() =>
      this.request<void>(`/rest/config/folders/${encodeURIComponent(value.id)}`, {
        method: 'PUT',
        body: JSON.stringify(value),
      }),
    );
  }

  async folderPathConflicts(
    path: string,
    excludeFolderId?: string,
    folders?: SyncthingFolderConfig[],
  ) {
    return this.folderPathConflictsFor(folders ?? (await this.folders()), path, excludeFolderId);
  }

  putFolderChecked(value: SyncthingFolderConfig) {
    return this.mutateConfiguration(async () => {
      const folders = await this.request<SyncthingFolderConfig[]>('/rest/config/folders');
      const conflicts = await this.folderPathConflictsFor(folders, value.path, value.id);
      if (conflicts.length) throw new FolderPathConflictError(conflicts);
      await this.request<void>(`/rest/config/folders/${encodeURIComponent(value.id)}`, {
        method: 'PUT',
        body: JSON.stringify(value),
      });
    });
  }

  patchFolderPathChecked(id: string, path: string) {
    return this.mutateConfiguration(async () => {
      const folders = await this.request<SyncthingFolderConfig[]>('/rest/config/folders');
      const conflicts = await this.folderPathConflictsFor(folders, path, id);
      if (conflicts.length) throw new FolderPathConflictError(conflicts);
      await this.request<void>(`/rest/config/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ path }),
      });
    });
  }

  updateFolderChecked(id: string, value: Partial<SyncthingFolderConfig>) {
    return this.mutateConfiguration(async () => {
      const folders = await this.request<SyncthingFolderConfig[]>('/rest/config/folders');
      if (value.path !== undefined) {
        const conflicts = await this.folderPathConflictsFor(folders, value.path, id);
        if (conflicts.length) throw new FolderPathConflictError(conflicts);
      }
      await this.request<void>(`/rest/config/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(value),
      });
    });
  }

  shareFolderWithDevice(id: string, deviceId: string) {
    return this.mutateConfiguration(async () => {
      const folder = await this.request<SyncthingFolderConfig>(
        `/rest/config/folders/${encodeURIComponent(id)}`,
      );
      const devices = [...(folder.devices ?? [])];
      if (!devices.some((device) => device.deviceID === deviceId))
        devices.push({ deviceID: deviceId });
      await this.request<void>(`/rest/config/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ devices }),
      });
    });
  }

  private async folderPathConflictsFor(
    folders: SyncthingFolderConfig[],
    path: string,
    excludeFolderId?: string,
  ) {
    const output: SyncthingFolderPathConflict[] = [];
    const candidate = await realFolderPath(path);
    for (const folder of folders) {
      if (folder.id === excludeFolderId) continue;
      const relation = folderPathRelation(candidate, await realFolderPath(folder.path));
      if (relation)
        output.push({ folderId: folder.id, label: folder.label || folder.id, relation });
    }
    return output;
  }

  patchFolder(id: string, value: Partial<SyncthingFolderConfig>) {
    return this.mutateConfiguration(() =>
      this.request<void>(`/rest/config/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(value),
      }),
    );
  }

  removeFolder(id: string) {
    return this.mutateConfiguration(() =>
      this.request<void>(`/rest/config/folders/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    );
  }

  folderStatus(id: string) {
    return this.request<{
      state?: string;
      localBytes?: number;
      globalBytes?: number;
      needBytes?: number;
      needTotalItems?: number;
      needDeletes?: number;
      receiveOnlyChangedFiles?: number;
      receiveOnlyChangedDirectories?: number;
      receiveOnlyChangedSymlinks?: number;
      receiveOnlyChangedDeletes?: number;
      receiveOnlyChangedBytes?: number;
      error?: string;
      watchError?: string;
      errors?: number;
    }>(`/rest/db/status?folder=${encodeURIComponent(id)}`);
  }

  folderCompletion(deviceId: string, folderId: string) {
    const query = new URLSearchParams({ device: deviceId, folder: folderId });
    return this.request<{
      completion?: number;
      needBytes?: number;
      needItems?: number;
      needDeletes?: number;
      remoteState?: 'unknown' | 'paused' | 'notSharing' | 'valid';
    }>(`/rest/db/completion?${query}`);
  }

  scanFolder(id: string) {
    return this.request<void>(`/rest/db/scan?folder=${encodeURIComponent(id)}`, { method: 'POST' });
  }

  folderVersions(id: string) {
    return this.request<Record<string, SyncthingVersion[]>>(
      `/rest/folder/versions?folder=${encodeURIComponent(id)}`,
    );
  }

  folderIgnores(id: string) {
    return this.request<{ ignore?: string[]; expanded?: string[] }>(
      `/rest/db/ignores?folder=${encodeURIComponent(id)}`,
    );
  }

  setFolderIgnores(id: string, lines: string[]) {
    return this.request<void>(`/rest/db/ignores?folder=${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ ignore: lines }),
    });
  }

  folderErrors(id: string, page: number, perpage: number) {
    const query = new URLSearchParams({ folder: id, page: String(page), perpage: String(perpage) });
    return this.request<{
      errors?: Array<{ path?: string; error?: string }>;
      page?: number;
      perpage?: number;
    }>(`/rest/folder/errors?${query}`);
  }

  overrideFolder(id: string) {
    return this.request<void>(`/rest/db/override?folder=${encodeURIComponent(id)}`, {
      method: 'POST',
    });
  }

  revertFolder(id: string) {
    return this.request<void>(`/rest/db/revert?folder=${encodeURIComponent(id)}`, {
      method: 'POST',
    });
  }

  restoreVersion(id: string, path: string, versionTime: string) {
    return this.mutateConfiguration(async () => {
      const [folder, status, devices] = await Promise.all([
        this.request<SyncthingFolderConfig>(`/rest/config/folders/${encodeURIComponent(id)}`),
        this.status(),
        this.request<SyncthingDeviceConfig[]>('/rest/config/devices'),
      ]);
      const members = new Set((folder.devices ?? []).map((device) => device.deviceID));
      const temporarilyPaused = devices.filter(
        (device) =>
          device.deviceID !== status.myID && members.has(device.deviceID) && device.paused !== true,
      );
      const before = await this.databaseFile(id, path).catch(() => undefined);
      let restored: Record<string, string | null> | undefined;
      let restoreFailure: unknown;
      try {
        for (const device of temporarilyPaused) {
          await this.request<void>(`/rest/config/devices/${encodeURIComponent(device.deviceID)}`, {
            method: 'PATCH',
            body: JSON.stringify({ paused: true }),
          });
        }
        if (temporarilyPaused.length) {
          await this.waitUntilDisconnected(
            id,
            temporarilyPaused.map((device) => device.deviceID),
          );
        }
        restored = await this.request<Record<string, string | null>>(
          `/rest/folder/versions?folder=${encodeURIComponent(id)}`,
          { method: 'POST', body: JSON.stringify({ [path]: versionTime }) },
        );
        if (!Object.values(restored ?? {}).some(Boolean)) {
          await this.request<void>(`/rest/db/scan?folder=${encodeURIComponent(id)}`, {
            method: 'POST',
          });
          await this.waitUntilRestoredFileIndexed(id, path, before, folder.type);
        }
      } catch (error) {
        restoreFailure = error;
      }
      const resumed = await Promise.allSettled(
        temporarilyPaused.map((device) =>
          this.request<void>(`/rest/config/devices/${encodeURIComponent(device.deviceID)}`, {
            method: 'PATCH',
            body: JSON.stringify({ paused: false }),
          }),
        ),
      );
      const resumeFailure = resumed.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (restoreFailure && resumeFailure) {
        throw new AggregateError(
          [restoreFailure, resumeFailure.reason],
          '版本恢复失败，且无法重新连接文件夹成员',
        );
      }
      if (restoreFailure) throw restoreFailure;
      if (resumeFailure) {
        throw new Error('恢复版本后无法重新连接文件夹成员', {
          cause: resumeFailure.reason,
        });
      }
      return restored ?? {};
    });
  }

  private async waitUntilDisconnected(folderId: string, deviceIds: string[]) {
    let stableChecks = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [connections, status] = await Promise.all([
        this.connections(),
        this.folderStatus(folderId),
      ]);
      const disconnected = deviceIds.every(
        (deviceId) => connections.connections[deviceId]?.connected !== true,
      );
      if (disconnected && status.state === 'idle') {
        stableChecks += 1;
        if (stableChecks >= 10) return;
      } else {
        stableChecks = 0;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new Error('等待同步设备暂停超时，未执行版本恢复');
  }

  private databaseFile(folderId: string, path: string) {
    const query = new URLSearchParams({ folder: folderId, file: path });
    return this.request<SyncthingDbFile>(`/rest/db/file?${query}`);
  }

  private async waitUntilRestoredFileIndexed(
    folderId: string,
    path: string,
    before: SyncthingDbFile | undefined,
    folderType: FolderType | undefined,
  ) {
    const beforeSignature = databaseFileSignature(before?.local);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const current = await this.databaseFile(folderId, path);
        const local = current.local;
        const changed = Boolean(local) && databaseFileSignature(local) !== beforeSignature;
        const converged =
          folderType === 'receiveonly' || databaseFilesEquivalent(local, current.global);
        if (changed && local?.mustRescan !== true && converged) return;
      } catch {
        // The restored file may not have entered the local index yet.
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new Error('恢复的文件未在限时内进入 Syncthing 本地索引');
  }

  async identity() {
    const status = await this.status();
    const [version, options, self] = await Promise.all([
      this.version(),
      this.options(),
      this.device(status.myID),
    ]);
    const listenAddresses = Object.values(status.connectionServiceStatus ?? {}).flatMap(
      (entry) => entry.lanAddresses ?? [],
    );
    return {
      deviceId: status.myID,
      syncthingVersion: version.version,
      nodeName: self.name || status.myID.slice(0, 7),
      listenAddresses: [...new Set(listenAddresses)],
      localDiscoveryEnabled: options.localAnnounceEnabled === true,
    };
  }

  async identityOfRunningInstance() {
    await this.status();
    await this.assertOwnedInstance();
    return this.identity();
  }

  async setNodeName(name: string) {
    const status = await this.status();
    await this.patchDevice(status.myID, { name });
  }

  private configuration() {
    return this.request<SyncthingConfiguration>('/rest/config');
  }

  private putConfiguration(value: SyncthingConfiguration) {
    return this.request<void>('/rest/config', { method: 'PUT', body: JSON.stringify(value) });
  }

  private mutateConfiguration<T>(operation: () => Promise<T>) {
    const result = this.configMutationQueue.then(operation);
    this.configMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureApiKey() {
    return loadOrCreateSyncthingApiKey(this.config.syncthingApiKeyFile);
  }

  private async request<T>(path: string, init: RequestInit = {}) {
    const apiKey = (await readFile(this.config.syncthingApiKeyFile, 'utf8')).trim();
    const headers = new Headers(init.headers);
    headers.set('X-API-Key', apiKey);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(this.config.syncthingUrl + path, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 500);
      throw new Error(
        `本机 Syncthing 请求失败：HTTP ${response.status}${detail ? `（${detail}）` : ''}`,
      );
    }
    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}

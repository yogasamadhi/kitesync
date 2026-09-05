import { createHmac, randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Folder } from '@kitesync/contracts';
import type { NodeConfig } from './config.js';
import { DirectoryBrowser } from './directory-browser.js';
import type { FolderFiles } from './folder-files.js';
import {
  createServer,
  hostName,
  isLanAddress,
  isLoopbackAddress,
  type PasswordHasher,
} from './server.js';
import { StateStore } from './state-store.js';
import type { LocalSyncthing } from './syncthing.js';

const DEVICE_ID = Array.from({ length: 8 }, () => 'AAAAAAA').join('-');
const PEER_ID = Array.from({ length: 8 }, () => 'BBBBBBB').join('-');
const REMOVED_PEER_ID = Array.from({ length: 8 }, () => 'CCCCCCC').join('-');
const OFFERING_PEER_ID = Array.from({ length: 8 }, () => 'DDDDDDD').join('-');
const temporaryDirectories: string[] = [];

interface FixtureOptions {
  configure?: (store: StateStore) => Promise<void>;
  config?: Partial<NodeConfig>;
  syncthing?: Record<string, unknown>;
  directories?: DirectoryBrowser;
  files?: FolderFiles;
  pickDirectory?: () => Promise<string | undefined>;
  passwordHasher?: PasswordHasher;
}

async function fixture(options: FixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), `kitesync-${randomUUID()}-`));
  temporaryDirectories.push(root);
  const config: NodeConfig = {
    version: 'test',
    compiled: false,
    stateDirectory: root,
    statePath: join(root, 'state.json'),
    lockPath: join(root, 'node.lock'),
    syncthingBinary: join(root, 'syncthing'),
    syncthingHome: join(root, 'syncthing-home'),
    syncthingApiKeyFile: join(root, 'api-key'),
    syncthingUrl: 'http://127.0.0.1:8385',
    syncthingGuiPort: 8385,
    webRoot: join(root, 'web'),
    headless: false,
    ...options.config,
  };
  const store = await StateStore.open(config.statePath);
  await options.configure?.(store);
  const fake = {
    status: async () => ({ myID: DEVICE_ID }),
    identity: async () => ({
      deviceId: DEVICE_ID,
      fingerprint: 'AAAAAAAAAAAA',
      nodeName: '测试节点',
      syncthingVersion: 'v2.1.3',
      listenAddresses: ['tcp://192.168.1.2:22000'],
      localDiscoveryEnabled: true,
    }),
    connections: async () => ({ connections: {} }),
    devices: async () => [{ deviceID: DEVICE_ID, name: '测试节点', addresses: ['dynamic'] }],
    setNodeName: async () => undefined,
    ...options.syncthing,
  } as unknown as LocalSyncthing;
  const app = await createServer({
    config,
    store,
    syncthing: fake,
    openSecret: 'a'.repeat(32),
    ...(options.directories ? { directories: options.directories } : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(options.pickDirectory ? { pickDirectory: options.pickDirectory } : {}),
    passwordHasher: options.passwordHasher ?? {
      hash: async (password) => `hash:${password}`,
      verify: async (password, hash) => hash === `hash:${password}`,
    },
    sleep: async () => undefined,
  });
  return { app, config, fake, store };
}

async function configuredFixture(options: Omit<FixtureOptions, 'configure'> = {}) {
  return fixture({
    ...options,
    configure: async (store) => {
      await store.update((draft) => {
        draft.passwordHash = 'hash:correct horse battery staple';
      });
    },
  });
}

async function login(app: Awaited<ReturnType<typeof createServer>>) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { host: 'localhost:3210' },
    payload: { password: 'correct horse battery staple' },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: String(response.headers['set-cookie']).split(';')[0],
    csrf: response.json<{ csrfToken: string }>().csrfToken,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('节点 API 认证边界', () => {
  it('用 ETag 防止两个设置页面静默覆盖', async () => {
    const { app } = await configuredFixture();
    const session = await login(app);
    const headers = { host: 'localhost:3210', cookie: session.cookie };
    const first = await app.inject({ method: 'GET', url: '/api/v1/settings', headers });
    expect(first.statusCode).toBe(200);
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^".+"$/);
    const saved = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { ...headers, 'x-csrf-token': session.csrf, 'if-match': etag },
      payload: { versioningDays: 14 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers.etag).not.toBe(etag);
    const stale = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { ...headers, 'x-csrf-token': session.csrf, 'if-match': etag },
      payload: { versioningDays: 7 },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({ code: 'settings_version_conflict' });
    await app.close();
  });

  it('同步引擎不可用时仍可读取设置和诊断摘要', async () => {
    const { app } = await configuredFixture({
      syncthing: {
        identity: async () => {
          throw new Error('engine offline');
        },
        folders: async () => [],
        folderStatuses: async () => [],
      },
    });
    const session = await login(app);
    const headers = { host: 'localhost:3210', cookie: session.cookie };
    const settings = await app.inject({ method: 'GET', url: '/api/v1/settings', headers });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ nodeName: 'KiteSync 节点', versioningDays: 30 });
    const diagnostics = await app.inject({
      method: 'GET',
      url: '/api/v1/diagnostics/summary',
      headers,
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toMatchObject({ engine: { available: false } });
    await app.close();
  });

  it('改密期间完成的旧密码验证不能创建新会话', async () => {
    let releaseVerification: () => void = () => {};
    let signalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const { app } = await configuredFixture({
      passwordHasher: {
        hash: async (password) => `hash:${password}`,
        verify: async () => {
          signalStarted();
          await blocked;
          return true;
        },
      },
    });
    const pendingLogin = app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: 'localhost:3210' },
      payload: { password: 'correct horse battery staple' },
    });
    await started;
    const reset = await app.inject({
      method: 'POST',
      url: '/internal/password-reset',
      headers: {
        host: 'localhost:3210',
        'x-kitesync-open-secret': 'a'.repeat(32),
      },
      payload: { newPassword: 'new correct horse battery staple' },
    });
    expect(reset.statusCode).toBe(200);
    releaseVerification();
    expect((await pendingLogin).statusCode).toBe(401);
    await app.close();
  });

  it('修改密码后撤销旧会话和旧密码登录', async () => {
    const { app } = await configuredFixture();
    const session = await login(app);
    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: {
        host: 'localhost:3210',
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
      },
      payload: {
        currentPassword: 'correct horse battery staple',
        newPassword: 'new correct horse battery staple',
      },
    });
    expect(changed.statusCode).toBe(200);
    const revoked = await app.inject({
      method: 'GET',
      url: '/api/v1/node',
      headers: { host: 'localhost:3210', cookie: session.cookie },
    });
    expect(revoked.statusCode).toBe(401);
    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: 'localhost:3210' },
      payload: { password: 'correct horse battery staple' },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: 'localhost:3210' },
      payload: { password: 'new correct horse battery staple' },
    });
    expect(newLogin.statusCode).toBe(200);
    await app.close();
  });

  it('只公开认证状态，并为本机 setup 会话授予桌面能力', async () => {
    const { app } = await fixture();
    const status = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/status',
      headers: { host: 'localhost:3210' },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ setupRequired: true });
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/node',
      headers: { host: 'localhost:3210' },
    });
    expect(denied.statusCode).toBe(401);
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { host: 'localhost:3210' },
      payload: { password: 'correct horse battery staple' },
    });
    expect(setup.statusCode).toBe(200);
    const session = setup.json<{ csrfToken: string }>();
    const cookie = String(setup.headers['set-cookie']).split(';')[0];
    const node = await app.inject({
      method: 'GET',
      url: '/api/v1/node',
      headers: { host: 'localhost:3210', cookie },
    });
    expect(node.statusCode).toBe(200);
    expect(node.json()).toMatchObject({ canRevealFiles: true, name: '测试节点' });
    const noCsrf = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { host: 'localhost:3210', cookie },
      payload: { versioningDays: 7 },
    });
    expect(noCsrf.statusCode).toBe(403);
    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: { host: 'localhost:3210', cookie, 'x-csrf-token': session.csrfToken },
      payload: { versioningDays: 7 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ versioningDays: 7, nodeName: '测试节点' });
    await app.close();
  });

  it('只允许桌面会话通过系统弹窗取得不透明目录句柄', async () => {
    const root = await mkdtemp(join(tmpdir(), `kitesync-${randomUUID()}-`));
    temporaryDirectories.push(root);
    const music = join(root, 'Music');
    await mkdir(music);
    const directories = new DirectoryBrowser([root]);
    const pickDirectory = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(music)
      .mockResolvedValueOnce(undefined);
    const { app } = await fixture({ directories, pickDirectory });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { host: 'localhost:3210' },
      payload: { password: 'correct horse battery staple' },
    });
    const session = setup.json<{ csrfToken: string }>();
    const headers = {
      host: 'localhost:3210',
      cookie: String(setup.headers['set-cookie']).split(';')[0],
      'x-csrf-token': session.csrfToken,
    };

    const selected = await app.inject({
      method: 'POST',
      url: '/api/v1/directories/select',
      headers,
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({ label: 'Music' });
    const handle = selected.json<{ id: string }>().id;
    await expect(directories.resolveSelection(handle)).resolves.toEqual({
      path: await realpath(music),
      label: 'Music',
    });

    const cancelled = await app.inject({
      method: 'POST',
      url: '/api/v1/directories/select',
      headers,
    });
    expect(cancelled.statusCode).toBe(204);
    await app.close();

    const remotePicker = vi.fn(async () => music);
    const remote = await fixture({
      config: { hostOverride: '0.0.0.0' },
      configure: async (store) => {
        await store.update((draft) => {
          draft.passwordHash = 'hash:correct horse battery staple';
          draft.settings.lanAccessEnabled = true;
        });
      },
      directories: new DirectoryBrowser([root]),
      pickDirectory: remotePicker,
    });
    const remoteLogin = await remote.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '192.168.50.9',
      headers: { host: 'localhost:3210' },
      payload: { password: 'correct horse battery staple' },
    });
    expect(remoteLogin.statusCode).toBe(200);
    const remoteSession = {
      cookie: String(remoteLogin.headers['set-cookie']).split(';')[0],
      csrf: remoteLogin.json<{ csrfToken: string }>().csrfToken,
    };
    const denied = await remote.app.inject({
      method: 'POST',
      url: '/api/v1/directories/select',
      remoteAddress: '192.168.50.9',
      headers: {
        host: 'localhost:3210',
        cookie: remoteSession.cookie,
        'x-csrf-token': remoteSession.csrf,
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(remotePicker).not.toHaveBeenCalled();
    await remote.app.close();
  });

  it('解释安全标记丢失原因，并在本机确认后恢复标记和扫描', async () => {
    const root = await mkdtemp(join(tmpdir(), `kitesync-repair-${randomUUID()}-`));
    temporaryDirectories.push(root);
    const folder = {
      id: 'folder-repair',
      label: '照片',
      path: root,
      markerName: '.stfolder',
      type: 'sendreceive' as const,
      devices: [],
    };
    const markerMissing = {
      state: 'error',
      error:
        'folder marker missing (this indicates potential data loss, search docs/forum to get information about how to proceed)',
      errors: 0,
    };
    const folderStatus = vi
      .fn(async () => ({ state: 'idle' }))
      .mockResolvedValueOnce(markerMissing)
      .mockResolvedValueOnce(markerMissing);
    const scanFolder = vi.fn(async () => undefined);
    const { app } = await configuredFixture({
      syncthing: {
        folders: async () => [folder],
        folder: async () => folder,
        folderStatus,
        scanFolder,
      },
    });
    const session = await login(app);
    const headers = { host: 'localhost:3210', cookie: session.cookie };

    const folders = await app.inject({ method: 'GET', url: '/api/v1/folders', headers });
    expect(folders.statusCode).toBe(200);
    expect(folders.json<{ items: Folder[] }>().items[0]).toMatchObject({
      state: 'error',
      errorCode: 'marker_missing',
      errorCount: 0,
      error: expect.stringContaining('确认'),
    });
    expect(folders.body).not.toContain('search docs');

    const repaired = await app.inject({
      method: 'POST',
      url: '/api/v1/folders/folder-repair/repair-marker',
      headers: { ...headers, 'x-csrf-token': session.csrf },
    });
    expect(repaired.statusCode).toBe(200);
    expect((await stat(join(root, '.stfolder'))).isDirectory()).toBe(true);
    expect(scanFolder).toHaveBeenCalledWith('folder-repair');
    await app.close();
  });

  it('返回项目、删除、本机分歧和每台共享设备的完成情况', async () => {
    const folder = {
      id: 'folder-progress',
      label: '文档',
      path: '/safe/documents',
      type: 'receiveonly' as const,
      devices: [{ deviceID: DEVICE_ID }, { deviceID: PEER_ID }],
    };
    const { app } = await configuredFixture({
      syncthing: {
        folders: async () => [folder],
        folderStatus: async () => ({
          state: 'idle',
          needBytes: 512,
          needTotalItems: 4,
          needDeletes: 1,
          receiveOnlyChangedFiles: 2,
          receiveOnlyChangedDirectories: 1,
          receiveOnlyChangedSymlinks: 1,
          receiveOnlyChangedDeletes: 2,
          receiveOnlyChangedBytes: 128,
        }),
        folderCompletion: async () => ({
          completion: 95,
          needBytes: 0,
          needItems: 0,
          needDeletes: 1,
          remoteState: 'valid' as const,
        }),
      },
    });
    const session = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/folders',
      headers: { host: 'localhost:3210', cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: Folder[] }>().items[0]).toMatchObject({
      needBytes: 512,
      needItems: 4,
      needDeletes: 1,
      receiveOnlyChangedItems: 6,
      receiveOnlyChangedBytes: 128,
      peerProgress: [
        {
          deviceId: PEER_ID,
          completion: 95,
          needItems: 0,
          needDeletes: 1,
          remoteState: 'valid',
        },
      ],
    });
    await app.close();
  });

  it('忽略规则可保留已有 include，但拒绝新增外部读取入口', async () => {
    const setFolderIgnores = vi.fn(async () => undefined);
    const { app } = await configuredFixture({
      syncthing: {
        folderIgnores: async () => ({ ignore: ['#include existing.rules'] }),
        setFolderIgnores,
      },
    });
    const session = await login(app);
    const headers = {
      host: 'localhost:3210',
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    };
    const preserved = await app.inject({
      method: 'PUT',
      url: '/api/v1/folders/folder-rules/ignores',
      headers,
      payload: { lines: ['#include existing.rules', '*.tmp'] },
    });
    expect(preserved.statusCode).toBe(200);
    const added = await app.inject({
      method: 'PUT',
      url: '/api/v1/folders/folder-rules/ignores',
      headers,
      payload: { lines: ['#include /etc/passwd'] },
    });
    expect(added.statusCode).toBe(400);
    expect(added.json()).toMatchObject({ code: 'ignore_include_not_allowed' });
    expect(setFolderIgnores).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('区分回环、私有局域网和公网地址', () => {
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLanAddress('192.168.50.2')).toBe(true);
    expect(isLanAddress('fd00::12')).toBe(true);
    expect(isLanAddress('8.8.8.8')).toBe(false);
    expect(isLoopbackAddress('127.999.1.1')).toBe(false);
    expect(isLanAddress('fc-not-an-ip')).toBe(false);
    expect(hostName('[fe80::1%25en0]:3210')).toBe('fe80::1');
    expect(hostName('[fe80::1%en0]:3210')).toBe('fe80::1');
    expect(hostName('[fe80::1%25bad/host]:3210')).toBe('');
  });

  it('默认拒绝 LAN 客户端和畸形 Host，同时允许本机 hostname', async () => {
    const { app } = await fixture();
    const lan = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/status',
      remoteAddress: '192.168.50.9',
      headers: { host: 'localhost:3210' },
    });
    expect(lan.statusCode).toBe(403);
    const malformed = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/status',
      headers: { host: 'attacker@localhost:3210' },
    });
    expect(malformed.statusCode).toBe(403);
    const systemName = hostname();
    const shortName = systemName.toLowerCase().endsWith('.local')
      ? systemName.slice(0, -'.local'.length)
      : systemName;
    const localName = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/status',
      headers: { host: `${shortName}:3210` },
    });
    expect(localName.statusCode).toBe(200);
    const localMdns = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/status',
      headers: { host: `${shortName}.local:3210` },
    });
    expect(localMdns.statusCode).toBe(200);
    await app.close();
  });

  it('仅通过可信代理接受显式 HTTPS origin，并设置 Secure 会话', async () => {
    const { app } = await fixture({
      configure: async (store) => {
        await store.update((draft) => {
          draft.passwordHash = 'hash:correct horse battery staple';
          draft.settings.allowedOrigins = ['https://sync.example.com'];
        });
      },
    });
    const proxyHeaders = {
      host: 'localhost:3210',
      'x-forwarded-for': '203.0.113.7',
      'x-forwarded-host': 'sync.example.com',
      'x-forwarded-proto': 'https',
      origin: 'https://sync.example.com',
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: proxyHeaders,
      payload: { password: 'correct horse battery staple' },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toMatch(/HttpOnly/i);
    expect(String(response.headers['set-cookie'])).toMatch(/SameSite=Strict/i);
    expect(String(response.headers['set-cookie'])).toMatch(/Secure/i);

    const originWithPath = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/status',
      headers: { ...proxyHeaders, origin: 'https://sync.example.com/path' },
    });
    expect(originWithPath.statusCode).toBe(403);

    const forgedForwarding = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/status',
      remoteAddress: '192.168.50.9',
      headers: {
        host: 'evil.invalid',
        'x-forwarded-host': 'sync.example.com',
        'x-forwarded-proto': 'https',
      },
    });
    expect(forgedForwarding.statusCode).toBe(403);
    await app.close();
  });

  it('允许显式配置的非私有代理，但仍强制 HTTPS 和公开 origin', async () => {
    const { app } = await fixture({
      configure: async (store) => {
        await store.update((draft) => {
          draft.passwordHash = 'hash:correct horse battery staple';
          draft.settings.allowedOrigins = ['https://sync.example.com'];
          draft.settings.trustedProxies = ['198.51.100.10'];
        });
      },
    });
    const accepted = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/status',
      remoteAddress: '198.51.100.10',
      headers: {
        host: 'localhost:3210',
        'x-forwarded-for': '203.0.113.7',
        'x-forwarded-host': 'sync.example.com',
        'x-forwarded-proto': 'https',
        origin: 'https://sync.example.com',
      },
    });
    expect(accepted.statusCode).toBe(200);
    const insecure = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/status',
      remoteAddress: '198.51.100.10',
      headers: {
        host: 'localhost:3210',
        'x-forwarded-for': '203.0.113.7',
        'x-forwarded-host': 'sync.example.com',
        'x-forwarded-proto': 'http',
      },
    });
    expect(insecure.statusCode).toBe(403);
    await app.close();
  });

  it('用 HMAC 识别已有实例，且 open token 只能本机单次兑换', async () => {
    const { app, store } = await configuredFixture();
    await store.update((draft) => {
      draft.settings.allowedOrigins = ['https://sync.example.com'];
    });
    const challenge = 'challenge_1234567890';
    const health = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: 'localhost:3210', 'x-kitesync-health-challenge': challenge },
    });
    expect(health.headers['x-kitesync-service']).toBe('node');
    expect(health.headers['x-kitesync-health-proof']).toBe(
      createHmac('sha256', 'a'.repeat(32)).update(challenge).digest('base64url'),
    );
    const remote = await app.inject({
      method: 'POST',
      url: '/internal/open-token',
      remoteAddress: '192.168.50.9',
      headers: { host: 'localhost:3210', 'x-kitesync-open-secret': 'a'.repeat(32) },
    });
    expect(remote.statusCode).toBe(403);
    const forwardedRemote = await app.inject({
      method: 'POST',
      url: '/internal/open-token',
      headers: {
        host: 'localhost:3210',
        'x-forwarded-for': '203.0.113.7',
        'x-forwarded-host': 'sync.example.com',
        'x-forwarded-proto': 'https',
        'x-kitesync-open-secret': 'a'.repeat(32),
      },
    });
    expect(forwardedRemote.statusCode).toBe(403);
    const issued = await app.inject({
      method: 'POST',
      url: '/internal/open-token',
      headers: { host: 'localhost:3210', 'x-kitesync-open-secret': 'a'.repeat(32) },
    });
    expect(issued.statusCode).toBe(200);
    const token = issued.json<{ token: string }>().token;
    const forwardedRedeem = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/open-token',
      headers: {
        host: 'localhost:3210',
        'x-forwarded-for': '203.0.113.7',
        'x-forwarded-host': 'sync.example.com',
        'x-forwarded-proto': 'https',
        origin: 'https://sync.example.com',
      },
      payload: { token },
    });
    expect(forwardedRedeem.statusCode).toBe(403);
    const redeemed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/open-token',
      headers: { host: 'localhost:3210' },
      payload: { token },
    });
    expect(redeemed.statusCode).toBe(200);
    const sessionCookie = String(redeemed.headers['set-cookie']).split(';')[0];
    const csrfToken = redeemed.json<{ csrfToken: string }>().csrfToken;
    expect(sessionCookie).toBeTruthy();

    const secondIssue = await app.inject({
      method: 'POST',
      url: '/internal/open-token',
      headers: { host: 'localhost:3210', 'x-kitesync-open-secret': 'a'.repeat(32) },
    });
    const secondToken = secondIssue.json<{ token: string }>().token;
    const secondRedeem = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/open-token',
      headers: { host: 'localhost:3210', cookie: sessionCookie },
      payload: { token: secondToken },
    });
    expect(secondRedeem.statusCode).toBe(200);
    expect(secondRedeem.headers['set-cookie']).toBeUndefined();
    expect(secondRedeem.json<{ csrfToken: string }>().csrfToken).toBe(csrfToken);

    const unchangedSession = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      headers: { host: 'localhost:3210', cookie: sessionCookie },
    });
    expect(unchangedSession.statusCode).toBe(200);
    expect(unchangedSession.json<{ csrfToken: string }>().csrfToken).toBe(csrfToken);
    const replayed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/open-token',
      headers: { host: 'localhost:3210' },
      payload: { token },
    });
    expect(replayed.statusCode).toBe(401);
    await app.close();
  });

  it('限制连续失败的登录尝试', async () => {
    const { app } = await configuredFixture();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { host: 'localhost:3210' },
        payload: { password: 'wrong' },
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { host: 'localhost:3210' },
      payload: { password: 'wrong' },
    });
    expect(limited.statusCode).toBe(429);
    await app.close();
  });

  it('并发登录会预占单一客户端额度并限制 Argon2 全局并发', async () => {
    let active = 0;
    let maximumActive = 0;
    let verificationCount = 0;
    const { app } = await configuredFixture({
      passwordHasher: {
        hash: async (password) => `hash:${password}`,
        verify: async () => {
          verificationCount += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
          active -= 1;
          return false;
        },
      },
    });
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          headers: { host: 'localhost:3210' },
          payload: { password: 'wrong' },
        }),
      ),
    );

    expect(responses.filter((response) => response.statusCode === 401)).toHaveLength(5);
    expect(responses.filter((response) => response.statusCode === 429)).toHaveLength(5);
    expect(verificationCount).toBe(5);
    expect(maximumActive).toBeLessThanOrEqual(2);
    await app.close();
  });

  it('版本 API 隐藏元数据并在调用 Syncthing 前拒绝越界恢复', async () => {
    const restoreVersion = vi.fn(async () => ({}));
    const { app } = await configuredFixture({
      syncthing: {
        folderVersions: async () => ({
          'visible.txt': [{ versionTime: '2026-09-03T10:00:00.000Z', size: 7 }],
          '.stignore': [{ versionTime: '2026-09-03T10:00:00.000Z', size: 8 }],
          '.stversions/../visible.txt': [{ versionTime: '2026-09-03T10:00:00.000Z', size: 9 }],
          '../outside.txt': [{ versionTime: '2026-09-03T10:00:00.000Z', size: 10 }],
        }),
        restoreVersion,
      },
    });
    const session = await login(app);
    const versions = await app.inject({
      method: 'GET',
      url: '/api/v1/folders/folder/versions',
      headers: { host: 'localhost:3210', cookie: session.cookie },
    });
    expect(versions.statusCode).toBe(200);
    expect(versions.json()).toEqual({
      items: [{ path: 'visible.txt', versionTime: '2026-09-03T10:00:00.000Z', size: 7 }],
    });
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/folders/folder/restore',
      headers: {
        host: 'localhost:3210',
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
      },
      payload: { path: '../outside.txt', versionTime: '2026-09-03T10:00:00.000Z' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(restoreVersion).not.toHaveBeenCalled();

    const restored = await app.inject({
      method: 'POST',
      url: '/api/v1/folders/folder/restore',
      headers: {
        host: 'localhost:3210',
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
      },
      payload: {
        path: 'visible.txt',
        versionTime: '2026-09-03T10:00:00.000Z',
      },
    });
    expect(restored.statusCode).toBe(200);
    expect(restoreVersion).toHaveBeenCalledWith(
      'folder',
      'visible.txt',
      '2026-09-03T10:00:00.000Z',
    );
    await app.close();
  });

  it('受认证的下载支持 HEAD 和单段 Range', async () => {
    const root = await mkdtemp(join(tmpdir(), `kitesync-files-${randomUUID()}-`));
    temporaryDirectories.push(root);
    await writeFile(join(root, 'hello.txt'), '0123456789');
    const { app } = await configuredFixture({
      syncthing: {
        folder: async () => ({ id: 'folder', label: 'folder', path: root, devices: [] }),
      },
    });
    const session = await login(app);
    const ranged = await app.inject({
      method: 'GET',
      url: '/api/v1/folders/folder/download?path=hello.txt',
      headers: { host: 'localhost:3210', cookie: session.cookie, range: 'bytes=2-5' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe('2345');
    expect(ranged.headers['content-range']).toBe('bytes 2-5/10');
    const head = await app.inject({
      method: 'HEAD',
      url: '/api/v1/folders/folder/download?path=hello.txt',
      headers: { host: 'localhost:3210', cookie: session.cookie },
    });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    expect(head.headers['content-length']).toBe('10');
    await app.close();
  });

  it('HEAD 和无效 Range 都会关闭已打开的文件句柄', async () => {
    const close = vi.fn(async () => undefined);
    const files = {
      file: vi.fn(async () => ({
        path: '/safe/report.txt',
        info: { size: 10, mtime: new Date('2026-09-03T00:00:00.000Z') },
        close,
        stream: vi.fn(() => {
          throw new Error('不应建立下载流');
        }),
      })),
    } as unknown as FolderFiles;
    const { app } = await configuredFixture({
      files,
      syncthing: {
        folder: async () => ({ id: 'folder', label: 'folder', path: '/safe', devices: [] }),
      },
    });
    const session = await login(app);
    const headers = { host: 'localhost:3210', cookie: session.cookie };

    const head = await app.inject({
      method: 'HEAD',
      url: '/api/v1/folders/folder/download?path=report.txt',
      headers,
    });
    expect(head.statusCode).toBe(200);
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/folders/folder/download?path=report.txt',
      headers: { ...headers, range: 'bytes=20-30' },
    });
    expect(invalid.statusCode).toBe(416);
    expect(close).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('环境监听覆盖完全决定 LAN 状态并拒绝界面修改', async () => {
    const { app } = await configuredFixture({ config: { hostOverride: '127.0.0.1' } });
    const session = await login(app);
    const settings = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { host: 'localhost:3210', cookie: session.cookie },
    });
    expect(settings.json()).toMatchObject({ lanAccessEnabled: false });
    const update = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: {
        host: 'localhost:3210',
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
      },
      payload: { lanAccessEnabled: true },
    });
    expect(update.statusCode).toBe(409);
    expect(update.json()).toMatchObject({ code: 'listen_override_active' });
    await app.close();
  });

  it('环境监听覆盖下允许完整表单回传相同 LAN 状态并保存其他设置', async () => {
    const setNodeName = vi.fn(async () => undefined);
    const { app, store } = await configuredFixture({
      config: { hostOverride: '0.0.0.0' },
      syncthing: { setNodeName },
    });
    const session = await login(app);
    const update = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: {
        host: 'localhost:3210',
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
      },
      payload: {
        nodeName: '容器节点',
        lanAccessEnabled: true,
        versioningDays: 14,
      },
    });

    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({
      nodeName: '测试节点',
      lanAccessEnabled: true,
      versioningDays: 14,
    });
    expect(store.snapshot().settings).toMatchObject({
      // The environment override remains the source of the effective LAN state.
      lanAccessEnabled: false,
      versioningDays: 14,
    });
    expect(setNodeName).toHaveBeenCalledWith('容器节点');
    await app.close();
  });

  it('修改 folder 成员时保留 Syncthing 已有成员的扩展字段', async () => {
    const folder = {
      id: 'folder',
      label: '文档',
      path: '/safe/documents',
      type: 'sendreceive' as const,
      devices: [
        { deviceID: DEVICE_ID, introducedBy: 'LOCAL-METADATA' },
        { deviceID: PEER_ID, encryptionPassword: 'preserve-me' },
        { deviceID: REMOVED_PEER_ID, introducedBy: 'removed' },
      ],
    };
    const patchFolder = vi.fn(async () => undefined);
    const { app } = await configuredFixture({
      syncthing: {
        devices: async () => [
          { deviceID: DEVICE_ID, name: '本机' },
          { deviceID: PEER_ID, name: '同伴' },
          { deviceID: REMOVED_PEER_ID, name: '移除的同伴' },
        ],
        folder: async () => folder,
        folderStatus: async () => ({ state: 'idle' }),
        patchFolder,
      },
    });
    const session = await login(app);
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/folders/folder',
      headers: {
        host: 'localhost:3210',
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
      },
      payload: { deviceIds: [PEER_ID] },
    });
    expect(response.statusCode).toBe(200);
    expect(patchFolder).toHaveBeenCalledWith('folder', {
      devices: [
        { deviceID: DEVICE_ID, introducedBy: 'LOCAL-METADATA' },
        { deviceID: PEER_ID, encryptionPassword: 'preserve-me' },
      ],
    });
    await app.close();
  });

  it('将远端 pending/discovery 输入限制在共享契约边界内', async () => {
    const { app } = await configuredFixture({
      syncthing: {
        devices: async () => [
          { deviceID: DEVICE_ID, name: '本机' },
          { deviceID: OFFERING_PEER_ID, name: 'n'.repeat(1_000) },
        ],
        ignoredDevices: async () => [],
        pendingDevices: async () => ({
          [PEER_ID]: {
            name: 'p'.repeat(1_000),
            address: 'a'.repeat(1_000),
            time: '2026-09-03T00:00:00.000Z',
          },
          malformed: { name: '不应返回' },
        }),
        discovery: async () => ({
          [REMOVED_PEER_ID]: {
            addresses: [
              'tcp://192.168.1.20:22000',
              'relay://relay.invalid:22067',
              'x'.repeat(513),
              '',
            ],
          },
          malformed: { addresses: ['tcp://192.168.1.21:22000'] },
        }),
        pendingFolders: async () => [
          {
            folderId: 'offered-folder',
            label: 'l'.repeat(1_000),
            deviceId: OFFERING_PEER_ID,
            offeredAt: '2026-09-03T00:00:00.000Z',
          },
          {
            folderId: 'x'.repeat(65),
            label: '不应返回',
            deviceId: OFFERING_PEER_ID,
            offeredAt: '2026-09-03T00:00:00.000Z',
          },
          {
            folderId: '../header\nvalue',
            label: '路径或控制字符不得进入节点 API',
            deviceId: OFFERING_PEER_ID,
            offeredAt: '2026-09-03T00:00:00.000Z',
          },
        ],
        ignoredFolders: async () => [],
      },
    });
    const session = await login(app);
    const headers = { host: 'localhost:3210', cookie: session.cookie };
    const pendingDevices = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/pending',
      headers,
    });
    expect(
      pendingDevices.json<{ items: Array<{ name: string; address: string }> }>().items,
    ).toEqual([expect.objectContaining({ name: 'p'.repeat(64), address: 'a'.repeat(512) })]);
    const discovered = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/discovered',
      headers,
    });
    expect(discovered.json()).toEqual({
      items: [{ id: REMOVED_PEER_ID, addresses: ['tcp://192.168.1.20:22000'] }],
    });
    const pendingFolders = await app.inject({
      method: 'GET',
      url: '/api/v1/folders/pending',
      headers,
    });
    expect(
      pendingFolders.json<{ items: Array<{ label: string; deviceName: string }> }>().items,
    ).toEqual([expect.objectContaining({ label: 'l'.repeat(128), deviceName: 'n'.repeat(64) })]);
    await app.close();
  });

  it('拒绝用同 ID 的远端 folder 邀请覆盖本机既有配置', async () => {
    const putFolder = vi.fn(async () => undefined);
    const { app } = await configuredFixture({
      syncthing: {
        pendingFolders: async () => [
          {
            folderId: 'existing-folder',
            label: '伪装邀请',
            deviceId: OFFERING_PEER_ID,
            offeredAt: '2026-09-03T00:00:00.000Z',
          },
        ],
        folders: async () => [
          { id: 'existing-folder', label: '本机目录', path: '/safe', devices: [] },
        ],
        putFolder,
      },
    });
    const session = await login(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/folders/pending/${OFFERING_PEER_ID}/existing-folder/accept`,
      headers: {
        host: 'localhost:3210',
        cookie: session.cookie,
        'x-csrf-token': session.csrf,
      },
      payload: { directoryId: 'opaque-directory-handle' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'folder_already_configured' });
    expect(putFolder).not.toHaveBeenCalled();
    await app.close();
  });
});

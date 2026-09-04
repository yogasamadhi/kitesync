import { createServer as createTcpServer } from 'node:net';
import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createSocket as createUdpSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NodeConfig } from '../../apps/node-service/src/config.js';
import { DirectoryBrowser } from '../../apps/node-service/src/directory-browser.js';
import { FolderFiles } from '../../apps/node-service/src/folder-files.js';
import { createServer } from '../../apps/node-service/src/server.js';
import { StateStore } from '../../apps/node-service/src/state-store.js';
import { hardenSyncthingXml, LocalSyncthing } from '../../apps/node-service/src/syncthing.js';

const projectRoot = resolve(import.meta.dirname, '../..');
const syncthingExecutable = process.platform === 'win32' ? 'syncthing.exe' : 'syncthing';
const syncthingBinary = join(
  projectRoot,
  'vendor',
  'syncthing',
  'bin',
  `${process.platform}-${process.arch}`,
  syncthingExecutable,
);
const openSecret = 'integration-open-secret-' + randomBytes(16).toString('hex');
const execFileAsync = promisify(execFile);

async function freeTcpPort() {
  const server = createTcpServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配测试端口');
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return address.port;
}

async function freeUdpPort(): Promise<number> {
  const socket = createUdpSocket('udp4');
  await new Promise<void>((resolvePromise, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => resolvePromise());
  });
  const port = socket.address().port;
  await new Promise<void>((resolvePromise) => socket.close(() => resolvePromise()));
  if (port === 21_027 || port === 22_000) return freeUdpPort();
  return port;
}

async function prepareIsolatedSyncthingHome(home: string) {
  await mkdir(home, { recursive: true });
  await execFileAsync(syncthingBinary, ['generate', `--home=${home}`]);
  const path = join(home, 'config.xml');
  const original = await readFile(path, 'utf8');
  const announcePort = await freeUdpPort();
  let isolated = hardenSyncthingXml(original, true);
  if (/<localAnnouncePort(?:\s[^>]*)?>[\s\S]*?<\/localAnnouncePort>/.test(isolated)) {
    isolated = isolated.replace(
      /<localAnnouncePort(?:\s[^>]*)?>[\s\S]*?<\/localAnnouncePort>/,
      `<localAnnouncePort>${announcePort}</localAnnouncePort>`,
    );
  } else {
    isolated = isolated.replace(
      '</options>',
      `        <localAnnouncePort>${announcePort}</localAnnouncePort>\n    </options>`,
    );
  }
  await writeFile(path, isolated, 'utf8');
}

function cookieFrom(response: Response) {
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('节点没有返回会话 Cookie');
  return cookie;
}

interface Session {
  cookie: string;
  csrfToken: string;
}

describe('真实无 Docker KiteSync Node', () => {
  let root = '';
  let dataRoot = '';
  let outsideFile = '';
  let config: NodeConfig;
  let store: StateStore;
  let syncthing: LocalSyncthing;
  let app: Awaited<ReturnType<typeof createServer>>;
  let baseUrl = '';
  let identityBeforeRestart = '';
  let listenerAddressesBeforeRestart: string[] = [];
  let folderId = '';
  let session: Session;

  async function startNode(currentSyncthing: LocalSyncthing) {
    await currentSyncthing.start();
    const instance = await createServer({
      config,
      store,
      syncthing: currentSyncthing,
      openSecret,
      directories: new DirectoryBrowser([dataRoot]),
      files: new FolderFiles(),
      // The test checks the limiter state transition without spending several seconds in backoff.
      sleep: async () => undefined,
    });
    const port = config.portOverride;
    if (port === undefined) throw new Error('测试节点缺少 UI 端口');
    await instance.listen({ host: '127.0.0.1', port });
    return instance;
  }

  async function authenticate(password: string) {
    const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { csrfToken: string };
    return { cookie: cookieFrom(response), csrfToken: body.csrfToken };
  }

  beforeAll(async () => {
    if (!existsSync(syncthingBinary)) {
      throw new Error(
        `缺少当前平台的固定 Syncthing sidecar：${syncthingBinary}；请先运行 bun run syncthing:build`,
      );
    }
    root = await mkdtemp(join(tmpdir(), 'kitesync-node-integration-'));
    dataRoot = join(root, 'sync-data');
    outsideFile = join(root, 'outside-secret.txt');
    await mkdir(join(dataRoot, '.stversions'), { recursive: true });
    await writeFile(join(dataRoot, 'visible.txt'), '0123456789abcdef', 'utf8');
    await writeFile(join(dataRoot, 'another.txt'), 'another visible file', 'utf8');
    await writeFile(join(dataRoot, '.stignore'), 'never expose this', 'utf8');
    await writeFile(join(dataRoot, '.syncthing.private'), 'never expose this either', 'utf8');
    await writeFile(outsideFile, 'outside secret', 'utf8');
    if (process.platform !== 'win32') {
      await symlink(outsideFile, join(dataRoot, 'outside-link.txt'));
    }

    const [uiPort, syncthingGuiPort] = await Promise.all([freeTcpPort(), freeTcpPort()]);
    const stateDirectory = join(root, 'state');
    const syncthingHome = join(stateDirectory, 'syncthing');
    await prepareIsolatedSyncthingHome(syncthingHome);
    config = {
      version: 'integration',
      compiled: false,
      stateDirectory,
      statePath: join(stateDirectory, 'state.json'),
      lockPath: join(stateDirectory, 'node.lock'),
      hostOverride: '127.0.0.1',
      portOverride: uiPort,
      syncthingBinary,
      syncthingHome,
      syncthingApiKeyFile: join(stateDirectory, 'syncthing-api-key'),
      syncthingUrl: `http://127.0.0.1:${syncthingGuiPort}`,
      syncthingGuiPort,
      webRoot: join(root, 'web'),
      headless: true,
      directoryRoots: [dataRoot],
    };
    store = await StateStore.open(config.statePath, uiPort);
    syncthing = new LocalSyncthing(config);
    app = await startNode(syncthing);
    baseUrl = `http://127.0.0.1:${uiPort}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    await syncthing?.stop().catch(() => undefined);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('启动真实 sidecar，并在写入配置前保持 LAN-only 安全选项', async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const challenge = randomBytes(24).toString('base64url');
    const challengedHealth = await fetch(`${baseUrl}/health`, {
      headers: { 'X-KiteSync-Health-Challenge': challenge },
    });
    expect(challengedHealth.status).toBe(200);
    expect(challengedHealth.headers.get('x-kitesync-health-proof')).toBe(
      createHmac('sha256', openSecret).update(challenge).digest('base64url'),
    );

    const apiHealth = await fetch(`${baseUrl}/api/v1/health`);
    expect(apiHealth.status).toBe(200);
    expect(await apiHealth.json()).toEqual({ status: 'ok' });

    const identity = await syncthing.identity();
    const options = await syncthing.options();
    identityBeforeRestart = identity.deviceId;
    listenerAddressesBeforeRestart = [...(options.listenAddresses ?? [])].sort();
    expect(identity.syncthingVersion).toBe('v2.1.3');
    expect(identity.localDiscoveryEnabled).toBe(true);
    expect(identity.listenAddresses.length).toBeGreaterThan(0);
    expect(identity.listenAddresses.every((address) => new URL(address).port !== '22000')).toBe(
      true,
    );
    expect(options.globalAnnounceEnabled).toBe(false);
    expect(options.globalAnnounceServers).toEqual([]);
    expect(options.localAnnounceEnabled).toBe(true);
    expect(options.announceLANAddresses).toBe(true);
    expect(options.relaysEnabled).toBe(false);
    expect(options.natEnabled).toBe(false);
    expect(options.stunServers).toEqual([]);
    expect(options.stunKeepaliveStartS).toBe(0);
    expect(options.crashReportingEnabled).toBe(false);
    expect(options.urAccepted).toBe(-1);
    expect(options.autoUpgradeIntervalH).toBe(0);
    expect(options.releasesURL).toBe('');
    expect(listenerAddressesBeforeRestart).not.toContain(
      'dynamic+https://relays.syncthing.net/endpoint',
    );
  });

  it('完成首次设置，并执行会话、CSRF、open token 与登录限速边界', async () => {
    const status = await fetch(`${baseUrl}/api/v1/auth/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ setupRequired: true });

    const denied = await fetch(`${baseUrl}/api/v1/node`);
    expect(denied.status).toBe(401);

    const setup = await fetch(`${baseUrl}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'integration-password-123' }),
    });
    expect(setup.status).toBe(200);
    const setupBody = (await setup.json()) as { csrfToken: string };
    session = { cookie: cookieFrom(setup), csrfToken: setupBody.csrfToken };

    const duplicateSetup = await fetch(`${baseUrl}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'another-integration-password' }),
    });
    expect(duplicateSetup.status).toBe(409);

    const missingSecret = await fetch(`${baseUrl}/internal/open-token`, { method: 'POST' });
    expect(missingSecret.status).toBe(401);

    const tokenResponse = await fetch(`${baseUrl}/internal/open-token`, {
      method: 'POST',
      headers: { 'X-KiteSync-Open-Secret': openSecret },
    });
    expect(tokenResponse.status).toBe(200);
    const { token } = (await tokenResponse.json()) as { token: string };
    const tokenLogin = await fetch(`${baseUrl}/api/v1/auth/open-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(tokenLogin.status).toBe(200);
    expect(cookieFrom(tokenLogin)).toContain('kitesync_session=');
    const tokenReplay = await fetch(`${baseUrl}/api/v1/auth/open-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(tokenReplay.status).toBe(401);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failure = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong password' }),
      });
      expect(failure.status).toBe(401);
    }
    const limited = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'integration-password-123' }),
    });
    expect(limited.status).toBe(429);

    const state = JSON.parse(await readFile(config.statePath, 'utf8')) as Record<string, unknown>;
    expect(String(state.passwordHash)).toMatch(/^\$argon2id\$/);
    expect(state).not.toHaveProperty('openSecret');
    if (process.platform !== 'win32') {
      expect((await stat(config.statePath)).mode & 0o777).toBe(0o600);
    }
  });

  it('创建文件夹，并安全地分页浏览、HEAD 与 Range 下载', async () => {
    const rootsResponse = await fetch(`${baseUrl}/api/v1/directory-roots`, {
      headers: { Cookie: session.cookie },
    });
    expect(rootsResponse.status).toBe(200);
    const roots = (await rootsResponse.json()) as { items: Array<{ id: string; label: string }> };
    expect(roots.items).toHaveLength(1);

    const noCsrf = await fetch(`${baseUrl}/api/v1/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: session.cookie },
      body: JSON.stringify({ label: '集成测试', directoryId: roots.items[0]?.id }),
    });
    expect(noCsrf.status).toBe(403);

    const created = await fetch(`${baseUrl}/api/v1/folders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.cookie,
        'X-CSRF-Token': session.csrfToken,
      },
      body: JSON.stringify({
        label: '集成测试',
        directoryId: roots.items[0]?.id,
        type: 'sendreceive',
        deviceIds: [],
      }),
    });
    expect(created.status).toBe(200);
    const folder = (await created.json()) as {
      id: string;
      pathLabel: string;
      versioningDays: number;
    };
    folderId = folder.id;
    expect(folder.pathLabel).toBe(basename(dataRoot));
    expect(folder.versioningDays).toBe(30);
    expect(JSON.stringify(folder)).not.toContain(dataRoot);

    const configured = await syncthing.folder(folderId);
    expect(configured.type).toBe('sendreceive');
    expect(configured.versioning).toMatchObject({
      type: 'staggered',
      params: { maxAge: '2592000' },
    });
    expect(configured.devices?.map((device) => device.deviceID)).toEqual([identityBeforeRestart]);

    const firstPageResponse = await fetch(`${baseUrl}/api/v1/folders/${folderId}/files?limit=1`, {
      headers: { Cookie: session.cookie },
    });
    expect(firstPageResponse.status).toBe(200);
    const firstPage = (await firstPageResponse.json()) as {
      items: Array<{ name: string }>;
      nextCursor: string | null;
    };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTypeOf('string');
    const secondPageResponse = await fetch(
      `${baseUrl}/api/v1/folders/${folderId}/files?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      { headers: { Cookie: session.cookie } },
    );
    expect(secondPageResponse.status).toBe(200);
    const secondPage = (await secondPageResponse.json()) as { items: Array<{ name: string }> };
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.name).not.toBe(firstPage.items[0]?.name);

    const listingResponse = await fetch(`${baseUrl}/api/v1/folders/${folderId}/files?limit=100`, {
      headers: { Cookie: session.cookie },
    });
    expect(listingResponse.status).toBe(200);
    const listing = (await listingResponse.json()) as {
      items: Array<{ name: string; type: string }>;
    };
    const names = listing.items.map((item) => item.name);
    expect(names).toContain('visible.txt');
    expect(names).not.toContain('.stfolder');
    expect(names).not.toContain('.stignore');
    expect(names).not.toContain('.stversions');
    expect(names).not.toContain('.syncthing.private');
    if (process.platform !== 'win32') {
      expect(listing.items).toContainEqual(
        expect.objectContaining({ name: 'outside-link.txt', type: 'symlink' }),
      );
    }

    const unauthenticated = await fetch(
      `${baseUrl}/api/v1/folders/${folderId}/download?path=visible.txt`,
    );
    expect(unauthenticated.status).toBe(401);

    const head = await fetch(`${baseUrl}/api/v1/folders/${folderId}/download?path=visible.txt`, {
      method: 'HEAD',
      headers: { Cookie: session.cookie },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('16');

    const range = await fetch(`${baseUrl}/api/v1/folders/${folderId}/download?path=visible.txt`, {
      headers: { Cookie: session.cookie, Range: 'bytes=2-5' },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 2-5/16');
    expect(await range.text()).toBe('2345');

    const traversal = await fetch(
      `${baseUrl}/api/v1/folders/${folderId}/download?path=${encodeURIComponent('../outside-secret.txt')}`,
      { headers: { Cookie: session.cookie } },
    );
    expect(traversal.status).not.toBe(200);
    expect(await traversal.text()).not.toContain('outside secret');

    const hidden = await fetch(`${baseUrl}/api/v1/folders/${folderId}/download?path=.stignore`, {
      headers: { Cookie: session.cookie },
    });
    expect(hidden.status).not.toBe(200);
    expect(await hidden.text()).not.toContain('never expose this');

    if (process.platform !== 'win32') {
      const link = await fetch(
        `${baseUrl}/api/v1/folders/${folderId}/download?path=outside-link.txt`,
        { headers: { Cookie: session.cookie } },
      );
      expect(link.status).not.toBe(200);
      expect(await link.text()).not.toContain('outside secret');
    }
  });

  it('重启后保留 Device ID、端口选择和文件夹，但清空 Web 会话', async () => {
    await app.close();
    await syncthing.stop();

    syncthing = new LocalSyncthing(config);
    app = await startNode(syncthing);

    const identity = await syncthing.identity();
    const options = await syncthing.options();
    expect(identity.deviceId).toBe(identityBeforeRestart);
    expect([...(options.listenAddresses ?? [])].sort()).toEqual(listenerAddressesBeforeRestart);
    expect((await syncthing.folders()).map((folder) => folder.id)).toContain(folderId);

    const expiredSession = await fetch(`${baseUrl}/api/v1/node`, {
      headers: { Cookie: session.cookie },
    });
    expect(expiredSession.status).toBe(401);

    session = await authenticate('integration-password-123');
    const removed = await fetch(`${baseUrl}/api/v1/folders/${folderId}`, {
      method: 'DELETE',
      headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken },
    });
    expect(removed.status).toBe(200);
    expect(await readFile(join(dataRoot, 'visible.txt'), 'utf8')).toBe('0123456789abcdef');
    expect((await syncthing.folders()).map((folder) => folder.id)).not.toContain(folderId);
  }, 60_000);
});

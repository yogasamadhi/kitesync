import { createServer as createTcpServer } from 'node:net';
import { execFile } from 'node:child_process';
import { createSocket as createUdpSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NodeConfig } from '../../apps/node-service/src/config.js';
import { DirectoryBrowser } from '../../apps/node-service/src/directory-browser.js';
import { FolderFiles } from '../../apps/node-service/src/folder-files.js';
import { createServer } from '../../apps/node-service/src/server.js';
import { StateStore } from '../../apps/node-service/src/state-store.js';
import { hardenSyncthingXml, LocalSyncthing } from '../../apps/node-service/src/syncthing.js';

const projectRoot = resolve(import.meta.dirname, '../..');
const executable = process.platform === 'win32' ? 'syncthing.exe' : 'syncthing';
const syncthingBinary = join(
  projectRoot,
  'vendor',
  'syncthing',
  'bin',
  `${process.platform}-${process.arch}`,
  executable,
);
const execFileAsync = promisify(execFile);

interface Session {
  cookie: string;
  csrfToken: string;
}

interface TestNode {
  config: NodeConfig;
  dataRoot: string;
  baseUrl: string;
  syncthing: LocalSyncthing;
  app: Awaited<ReturnType<typeof createServer>>;
  session: Session;
  deviceId: string;
  syncAddress: string;
  directoryId: string;
}

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

async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  description: string,
  timeout = 30_000,
) {
  const deadline = Date.now() + timeout;
  let lastValue: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      lastValue = await read();
      if (accept(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `${description}超时；最后状态=${JSON.stringify(lastValue)}${lastError ? `；错误=${String(lastError)}` : ''}`,
  );
}

function cookieFrom(response: Response) {
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('节点没有返回会话 Cookie');
  return cookie;
}

async function authenticatedRequest(
  node: Pick<TestNode, 'baseUrl' | 'session'>,
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set('Cookie', node.session.cookie);
  if (!['GET', 'HEAD'].includes(init.method ?? 'GET')) {
    headers.set('X-CSRF-Token', node.session.csrfToken);
  }
  return fetch(node.baseUrl + path, { ...init, headers });
}

async function setFolderType(
  node: TestNode,
  folderId: string,
  type: 'sendreceive' | 'sendonly' | 'receiveonly',
) {
  const response = await authenticatedRequest(node, `/api/v1/folders/${folderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type }),
  });
  const body = await response.text();
  expect(response.status, body).toBe(200);
  expect(JSON.parse(body)).toMatchObject({ id: folderId, type });
  await eventually(
    () => node.syncthing.folder(folderId),
    (folder) => folder.type === type,
    `等待 Syncthing 应用 ${type} 模式`,
  );
}

async function scanFolder(node: TestNode, folderId: string) {
  await eventually(
    async () => {
      await node.syncthing.scanFolder(folderId);
      return true;
    },
    Boolean,
    '等待文件夹可扫描',
  );
}

async function expectFileMissingFor(path: string, duration: number, description: string) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      throw new Error(`${description}：文件意外出现`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

async function startNode(root: string, name: string): Promise<TestNode> {
  const dataRoot = join(root, 'data');
  const stateDirectory = join(root, 'state');
  const syncthingHome = join(stateDirectory, 'syncthing');
  await mkdir(dataRoot, { recursive: true });
  await prepareIsolatedSyncthingHome(syncthingHome);
  const [uiPort, guiPort] = await Promise.all([freeTcpPort(), freeTcpPort()]);
  const config: NodeConfig = {
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
    syncthingUrl: `http://127.0.0.1:${guiPort}`,
    syncthingGuiPort: guiPort,
    webRoot: join(root, 'web'),
    headless: true,
    directoryRoots: [dataRoot],
  };
  const store = await StateStore.open(config.statePath, uiPort);
  const syncthing = new LocalSyncthing(config);
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    await syncthing.start();
    await syncthing.setNodeName(name);
    const identity = await syncthing.identity();
    const tcpListener = identity.listenAddresses.find((address) => address.startsWith('tcp://'));
    if (!tcpListener) throw new Error(`${name} 没有可用的 TCP 同步监听地址`);
    const port = new URL(tcpListener).port;
    if (!port) throw new Error(`${name} 的 TCP 同步监听地址没有端口`);
    if (port === '22000') throw new Error(`${name} 错误占用了非隔离同步端口 22000`);
    app = await createServer({
      config,
      store,
      syncthing,
      openSecret: `${name}-integration-open-secret`,
      directories: new DirectoryBrowser([dataRoot]),
      files: new FolderFiles(),
    });
    await app.listen({ host: '127.0.0.1', port: uiPort });
    const baseUrl = `http://127.0.0.1:${uiPort}`;
    const setup = await fetch(`${baseUrl}/api/v1/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: `${name}-integration-password` }),
    });
    if (!setup.ok) throw new Error(`${name} 初始化失败：HTTP ${setup.status}`);
    const setupBody = (await setup.json()) as { csrfToken: string };
    const session = { cookie: cookieFrom(setup), csrfToken: setupBody.csrfToken };
    const roots = await authenticatedRequest({ baseUrl, session }, '/api/v1/directory-roots');
    const rootsBody = (await roots.json()) as { items: Array<{ id: string }> };
    const directoryId = rootsBody.items[0]?.id;
    if (!directoryId) throw new Error(`${name} 没有可选的同步目录`);
    return {
      config,
      dataRoot,
      baseUrl,
      syncthing,
      app,
      session,
      deviceId: identity.deviceId,
      syncAddress: `tcp://127.0.0.1:${port}`,
      directoryId,
    };
  } catch (error) {
    await app?.close().catch(() => undefined);
    await syncthing.stop().catch(() => undefined);
    throw error;
  }
}

describe('两个真实节点的静态地址同步', () => {
  let root = '';
  let first: TestNode;
  let second: TestNode;

  beforeAll(async () => {
    if (!existsSync(syncthingBinary)) {
      throw new Error(
        `缺少当前平台的固定 Syncthing sidecar：${syncthingBinary}；请先运行 bun run syncthing:build`,
      );
    }
    root = await mkdtemp(join(tmpdir(), 'kitesync-two-node-integration-'));
    first = await startNode(join(root, 'first'), '测试节点 A');
    second = await startNode(join(root, 'second'), '测试节点 B');
    if (first.syncAddress === second.syncAddress) throw new Error('两个测试节点使用了相同同步地址');
  }, 60_000);

  afterAll(async () => {
    await Promise.all([
      first?.app.close().catch(() => undefined),
      second?.app.close().catch(() => undefined),
    ]);
    await Promise.all([
      first?.syncthing.stop().catch(() => undefined),
      second?.syncthing.stop().catch(() => undefined),
    ]);
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('配对、明确接受邀请、双向同步并在节点重启后续传', async () => {
    // Disable broadcast discovery only for this scenario so a successful connection proves that
    // the explicit address path works across discovery domains. The default-on behavior is
    // asserted separately in node-real.test.ts.
    await Promise.all([
      first.syncthing.patchOptions({ localAnnounceEnabled: false }),
      second.syncthing.patchOptions({ localAnnounceEnabled: false }),
    ]);

    const addSecond = await authenticatedRequest(first, '/api/v1/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: second.deviceId,
        name: '测试节点 B',
        addresses: [second.syncAddress],
      }),
    });
    const addSecondBody = await addSecond.text();
    expect(addSecond.status, addSecondBody).toBe(200);
    expect(JSON.parse(addSecondBody)).toMatchObject({
      id: second.deviceId,
      addresses: [second.syncAddress],
    });
    expect(await first.syncthing.device(second.deviceId)).toMatchObject({
      addresses: [second.syncAddress],
      autoAcceptFolders: false,
      introducer: false,
    });

    const configuredBeforeAccept = await authenticatedRequest(second, '/api/v1/devices');
    expect(configuredBeforeAccept.status).toBe(200);
    expect(
      ((await configuredBeforeAccept.json()) as { items: Array<{ id: string }> }).items,
    ).not.toContainEqual(expect.objectContaining({ id: first.deviceId }));
    expect((await second.syncthing.connections()).connections[first.deviceId]?.connected).not.toBe(
      true,
    );

    const pendingDevice = await eventually(
      async () => {
        const response = await authenticatedRequest(second, '/api/v1/devices/pending');
        if (!response.ok) throw new Error(`pending device API 返回 HTTP ${response.status}`);
        return (await response.json()) as {
          items: Array<{ id: string; name: string; address: string }>;
        };
      },
      (value) => value.items.some((item) => item.id === first.deviceId),
      '等待第二个节点收到未知设备请求',
      45_000,
    );
    expect(pendingDevice.items).toContainEqual(expect.objectContaining({ id: first.deviceId }));
    expect((await second.syncthing.devices()).map((device) => device.deviceID)).not.toContain(
      first.deviceId,
    );
    expect((await second.syncthing.connections()).connections[first.deviceId]?.connected).not.toBe(
      true,
    );

    const rejectedDevice = await authenticatedRequest(
      second,
      `/api/v1/devices/pending/${first.deviceId}/reject`,
      { method: 'POST' },
    );
    const rejectedDeviceBody = await rejectedDevice.text();
    expect(rejectedDevice.status, rejectedDeviceBody).toBe(200);
    const ignoredDevice = await eventually(
      async () => {
        const response = await authenticatedRequest(second, '/api/v1/devices/pending');
        if (!response.ok) throw new Error(`ignored device API 返回 HTTP ${response.status}`);
        return (await response.json()) as {
          items: Array<{ id: string }>;
          ignored: Array<{ id: string }>;
        };
      },
      (value) =>
        !value.items.some((item) => item.id === first.deviceId) &&
        value.ignored.some((item) => item.id === first.deviceId),
      '等待拒绝的设备进入 ignore 记录',
    );
    expect(ignoredDevice.ignored).toContainEqual(expect.objectContaining({ id: first.deviceId }));
    expect((await second.syncthing.ignoredDevices()).map((device) => device.deviceID)).toContain(
      first.deviceId,
    );

    const allowPairingAgain = await authenticatedRequest(
      second,
      `/api/v1/devices/ignored/${first.deviceId}`,
      { method: 'DELETE' },
    );
    const allowPairingAgainBody = await allowPairingAgain.text();
    expect(allowPairingAgain.status, allowPairingAgainBody).toBe(200);
    expect(
      (await second.syncthing.ignoredDevices()).map((device) => device.deviceID),
    ).not.toContain(first.deviceId);

    // Force a fresh outbound dial instead of depending on Syncthing's retry backoff timer.
    for (const paused of [true, false]) {
      const toggled = await authenticatedRequest(first, `/api/v1/devices/${second.deviceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused }),
      });
      const toggledBody = await toggled.text();
      expect(toggled.status, toggledBody).toBe(200);
      expect(JSON.parse(toggledBody)).toMatchObject({ id: second.deviceId, paused });
    }
    await eventually(
      async () => {
        const response = await authenticatedRequest(second, '/api/v1/devices/pending');
        if (!response.ok) throw new Error(`pending device API 返回 HTTP ${response.status}`);
        return (await response.json()) as { items: Array<{ id: string }> };
      },
      (value) => value.items.some((item) => item.id === first.deviceId),
      '等待取消忽略后再次收到设备请求',
      45_000,
    );

    const acceptFirst = await authenticatedRequest(
      second,
      `/api/v1/devices/pending/${first.deviceId}/accept`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '测试节点 A' }),
      },
    );
    const acceptFirstBody = await acceptFirst.text();
    expect(acceptFirst.status, acceptFirstBody).toBe(200);
    expect(JSON.parse(acceptFirstBody)).toMatchObject({
      id: first.deviceId,
      addresses: ['dynamic'],
    });
    expect(await second.syncthing.device(first.deviceId)).toMatchObject({
      addresses: ['dynamic'],
      autoAcceptFolders: false,
      introducer: false,
    });

    // Model the manual Device ID + tcp://IP:port flow on both sides after acceptance. This is the
    // supported path when UDP discovery cannot cross a VLAN or guest Wi-Fi boundary.
    const setFirstStaticAddress = await authenticatedRequest(
      second,
      `/api/v1/devices/${first.deviceId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addresses: [first.syncAddress] }),
      },
    );
    const setFirstStaticAddressBody = await setFirstStaticAddress.text();
    expect(setFirstStaticAddress.status, setFirstStaticAddressBody).toBe(200);
    expect(JSON.parse(setFirstStaticAddressBody)).toMatchObject({
      id: first.deviceId,
      addresses: [first.syncAddress],
    });

    await eventually(
      async () => ({
        first: (await first.syncthing.connections()).connections[second.deviceId]?.connected,
        second: (await second.syncthing.connections()).connections[first.deviceId]?.connected,
      }),
      (connections) => connections.first === true && connections.second === true,
      '等待两个节点建立静态地址连接',
    );

    await writeFile(join(first.dataRoot, 'from-first.txt'), 'first version', 'utf8');
    const created = await authenticatedRequest(first, '/api/v1/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label: '双节点同步',
        directoryId: first.directoryId,
        deviceIds: [second.deviceId],
        type: 'sendreceive',
      }),
    });
    const createdBody = await created.text();
    expect(created.status, createdBody).toBe(200);
    const folder = JSON.parse(createdBody) as { id: string; versioningDays: number };
    expect(folder.versioningDays).toBe(30);

    await scanFolder(first, folder.id);

    const pending = await eventually(
      async () => {
        const response = await authenticatedRequest(second, '/api/v1/folders/pending');
        if (!response.ok) throw new Error(`pending API 返回 HTTP ${response.status}`);
        return (await response.json()) as {
          items: Array<{ folderId: string; deviceId: string }>;
        };
      },
      (value) =>
        value.items.some((item) => item.folderId === folder.id && item.deviceId === first.deviceId),
      '等待第二个节点收到文件夹邀请',
    );
    expect(pending.items).toContainEqual(
      expect.objectContaining({ folderId: folder.id, deviceId: first.deviceId }),
    );
    expect((await second.syncthing.folders()).map((item) => item.id)).not.toContain(folder.id);
    await expect(stat(join(second.dataRoot, 'from-first.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const accepted = await authenticatedRequest(
      second,
      `/api/v1/folders/pending/${first.deviceId}/${folder.id}/accept`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directoryId: second.directoryId, type: 'sendreceive' }),
      },
    );
    const acceptedBody = await accepted.text();
    expect(accepted.status, acceptedBody).toBe(200);
    expect((await second.syncthing.folder(folder.id)).path).toBe(await realpath(second.dataRoot));

    await eventually(
      () => readFile(join(second.dataRoot, 'from-first.txt'), 'utf8'),
      (contents) => contents === 'first version',
      '等待第一个节点的文件同步到第二个节点',
    );

    await setFolderType(first, folder.id, 'sendonly');
    const sendOnlyOutbound = join(first.dataRoot, 'sendonly-outbound.txt');
    const sendOnlyOutboundOnSecond = join(second.dataRoot, 'sendonly-outbound.txt');
    await writeFile(sendOnlyOutbound, 'sendonly outbound v1', 'utf8');
    await scanFolder(first, folder.id);
    await eventually(
      () => readFile(sendOnlyOutboundOnSecond, 'utf8'),
      (contents) => contents === 'sendonly outbound v1',
      '等待 sendonly 节点向对端发送新增文件',
    );

    const sendOnlyBlockedOnFirst = join(first.dataRoot, 'sendonly-blocked-inbound.txt');
    const sendOnlyBlockedOnSecond = join(second.dataRoot, 'sendonly-blocked-inbound.txt');
    await writeFile(sendOnlyBlockedOnSecond, 'must not enter sendonly node', 'utf8');
    await scanFolder(second, folder.id);
    await writeFile(sendOnlyOutbound, 'sendonly outbound v2 after remote scan', 'utf8');
    await scanFolder(first, folder.id);
    await eventually(
      () => readFile(sendOnlyOutboundOnSecond, 'utf8'),
      (contents) => contents === 'sendonly outbound v2 after remote scan',
      '等待 sendonly 连接在对端扫描后继续正向同步',
    );
    await expectFileMissingFor(sendOnlyBlockedOnFirst, 1_500, 'sendonly 节点不应接收对端新增文件');
    await unlink(sendOnlyBlockedOnSecond);
    await scanFolder(second, folder.id);
    await unlink(sendOnlyOutbound);
    await scanFolder(first, folder.id);
    await eventually(
      async () => {
        try {
          await stat(sendOnlyOutboundOnSecond);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
          throw error;
        }
      },
      Boolean,
      '等待清理 sendonly 正向测试文件',
    );

    await setFolderType(first, folder.id, 'receiveonly');
    const receiveOnlyInbound = join(first.dataRoot, 'receiveonly-inbound.txt');
    const receiveOnlyInboundOnSecond = join(second.dataRoot, 'receiveonly-inbound.txt');
    await writeFile(receiveOnlyInboundOnSecond, 'receiveonly inbound v1', 'utf8');
    await scanFolder(second, folder.id);
    await eventually(
      () => readFile(receiveOnlyInbound, 'utf8'),
      (contents) => contents === 'receiveonly inbound v1',
      '等待 receiveonly 节点接收对端新增文件',
    );

    const receiveOnlyBlocked = join(first.dataRoot, 'receiveonly-blocked-outbound.txt');
    const receiveOnlyBlockedOnSecond = join(second.dataRoot, 'receiveonly-blocked-outbound.txt');
    await writeFile(receiveOnlyBlocked, 'must not leave receiveonly node', 'utf8');
    await scanFolder(first, folder.id);
    expect(await readFile(receiveOnlyBlocked, 'utf8')).toBe('must not leave receiveonly node');
    await writeFile(receiveOnlyInboundOnSecond, 'receiveonly inbound v2 after local scan', 'utf8');
    await scanFolder(second, folder.id);
    await eventually(
      () => readFile(receiveOnlyInbound, 'utf8'),
      (contents) => contents === 'receiveonly inbound v2 after local scan',
      '等待 receiveonly 连接在本地扫描后继续反向同步',
    );
    await expectFileMissingFor(
      receiveOnlyBlockedOnSecond,
      1_500,
      'receiveonly 节点不应向对端发送本地新增文件',
    );
    await unlink(receiveOnlyBlocked);
    await scanFolder(first, folder.id);
    await unlink(receiveOnlyInboundOnSecond);
    await scanFolder(second, folder.id);
    await eventually(
      async () => {
        try {
          await stat(receiveOnlyInbound);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
          throw error;
        }
      },
      Boolean,
      '等待清理 receiveonly 反向测试文件',
    );
    await setFolderType(first, folder.id, 'sendreceive');

    // A remote replacement makes Syncthing's staggered versioner retain the old content on the
    // receiving node. Exercise the public list/restore APIs against that real local version.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_100));
    await writeFile(join(first.dataRoot, 'from-first.txt'), 'second version from first', 'utf8');
    await first.syncthing.scanFolder(folder.id);
    await eventually(
      () => readFile(join(second.dataRoot, 'from-first.txt'), 'utf8'),
      (contents) => contents === 'second version from first',
      '等待第二个节点接收用于版本恢复的新内容',
    );

    const version = await eventually(
      async () => {
        const response = await authenticatedRequest(
          second,
          `/api/v1/folders/${folder.id}/versions`,
        );
        if (!response.ok) throw new Error(`versions API 返回 HTTP ${response.status}`);
        const body = (await response.json()) as {
          items: Array<{ path: string; versionTime: string; size: number }>;
        };
        return body.items.find((item) => item.path === 'from-first.txt');
      },
      (value) => value !== undefined,
      '等待第二个节点列出本地 staggered 版本',
      45_000,
    );
    if (!version) throw new Error('版本列表缺少 from-first.txt');
    expect(version.size).toBe(Buffer.byteLength('first version'));

    const restored = await authenticatedRequest(second, `/api/v1/folders/${folder.id}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: version.path, versionTime: version.versionTime }),
    });
    const restoredBody = await restored.text();
    expect(restored.status, restoredBody).toBe(200);
    await eventually(
      () => readFile(join(second.dataRoot, 'from-first.txt'), 'utf8'),
      (contents) => contents === 'first version',
      '等待第二个节点恢复本地历史版本',
    );
    expect((await second.syncthing.device(first.deviceId)).paused).toBe(false);
    await eventually(
      async () => ({
        first: (await first.syncthing.connections()).connections[second.deviceId]?.connected,
        second: (await second.syncthing.connections()).connections[first.deviceId]?.connected,
      }),
      (connections) => connections.first === true && connections.second === true,
      '等待版本恢复后重新连接 peer',
    );
    await eventually(
      () => readFile(join(first.dataRoot, 'from-first.txt'), 'utf8'),
      (contents) => contents === 'first version',
      '等待恢复的版本同步回第一个节点',
    );

    await writeFile(join(second.dataRoot, 'from-first.txt'), 'changed by second node', 'utf8');
    await second.syncthing.scanFolder(folder.id);
    await eventually(
      () => readFile(join(first.dataRoot, 'from-first.txt'), 'utf8'),
      (contents) => contents === 'changed by second node',
      '等待第二个节点的修改同步回第一个节点',
    );

    await unlink(join(second.dataRoot, 'from-first.txt'));
    await second.syncthing.scanFolder(folder.id);
    await eventually(
      async () => {
        try {
          await stat(join(first.dataRoot, 'from-first.txt'));
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
          throw error;
        }
      },
      (missing) => missing,
      '等待删除同步回第一个节点',
    );

    const oldSession = second.session.cookie;
    await second.app.close();
    await second.syncthing.stop();
    const restartedStore = await StateStore.open(second.config.statePath);
    second.syncthing = new LocalSyncthing(second.config);
    await second.syncthing.start();
    const restartedIdentity = await second.syncthing.identity();
    expect(restartedIdentity.deviceId).toBe(second.deviceId);
    expect(
      restartedIdentity.listenAddresses.some((address) =>
        address.includes(new URL(second.syncAddress).port),
      ),
    ).toBe(true);
    second.app = await createServer({
      config: second.config,
      store: restartedStore,
      syncthing: second.syncthing,
      openSecret: '测试节点 B-integration-open-secret',
      directories: new DirectoryBrowser([second.dataRoot]),
      files: new FolderFiles(),
    });
    const restartedUiPort = second.config.portOverride;
    if (restartedUiPort === undefined) throw new Error('重启节点缺少 UI 端口');
    await second.app.listen({ host: '127.0.0.1', port: restartedUiPort });
    expect((await second.syncthing.folders()).map((item) => item.id)).toContain(folder.id);

    const expiredSession = await fetch(`${second.baseUrl}/api/v1/node`, {
      headers: { Cookie: oldSession },
    });
    expect(expiredSession.status).toBe(401);
    const login = await fetch(`${second.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: '测试节点 B-integration-password' }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { csrfToken: string };
    second.session = { cookie: cookieFrom(login), csrfToken: loginBody.csrfToken };

    await eventually(
      async () => ({
        first: (await first.syncthing.connections()).connections[second.deviceId]?.connected,
        second: (await second.syncthing.connections()).connections[first.deviceId]?.connected,
      }),
      (connections) => connections.first === true && connections.second === true,
      '等待第二个节点重启后恢复连接',
      45_000,
    );
    await writeFile(join(first.dataRoot, 'after-restart.txt'), 'resume-ok', 'utf8');
    await first.syncthing.scanFolder(folder.id);
    await eventually(
      () => readFile(join(second.dataRoot, 'after-restart.txt'), 'utf8'),
      (contents) => contents === 'resume-ok',
      '等待重启后的文件续传',
      45_000,
    );
  }, 90_000);
});

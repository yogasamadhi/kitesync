import { describe, expect, it, vi } from 'vitest';
import { createSocket } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeConfig } from './config.js';
import {
  hardenSyncthingXml,
  listenerHasBindError,
  loadOrCreateSyncthingApiKey,
  LocalSyncthing,
  loopbackGuiAddress,
  safeRelativeChild,
  udpPortAvailable,
} from './syncthing.js';

function containsControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

describe('Syncthing 离线安全配置', () => {
  it('只把实际绑定到指定端口 loopback 的 GUI/REST 视为可接管', () => {
    expect(loopbackGuiAddress('127.0.0.1:8385', 8385)).toBe(true);
    expect(loopbackGuiAddress('127.0.0.2:8385', 8385)).toBe(true);
    expect(loopbackGuiAddress('[::1]:8385', 8385)).toBe(true);
    expect(loopbackGuiAddress('localhost:8385', 8385)).toBe(true);
    expect(loopbackGuiAddress('0.0.0.0:8385', 8385)).toBe(false);
    expect(loopbackGuiAddress('192.168.1.2:8385', 8385)).toBe(false);
    expect(loopbackGuiAddress('127.0.0.1:9999', 8385)).toBe(false);
  });

  it('即使 home 匹配也拒绝接管暴露在 LAN 的 GUI/REST', async () => {
    const syncthing = new LocalSyncthing({
      syncthingHome: '/expected-home',
      syncthingGuiPort: 8385,
    } as NodeConfig);
    const internal = syncthing as unknown as {
      assertOwnedInstance: () => Promise<void>;
      request: (path: string, init?: RequestInit) => Promise<unknown>;
    };
    vi.spyOn(internal, 'request').mockImplementation(async (path) => {
      if (path === '/rest/system/paths') {
        return {
          'baseDir-config': '/expected-home',
          'baseDir-data': '/expected-home',
        };
      }
      if (path === '/rest/system/status') {
        return { myID: 'SELF', guiAddressUsed: '0.0.0.0:8385' };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    await expect(internal.assertOwnedInstance()).rejects.toThrow('未安全监听 loopback');
  });

  it('在启动前关闭公网发现、relay、NAT、遥测和自动升级入口', () => {
    const source = `<configuration><options>
      <listenAddress>tcp://0.0.0.0:60247</listenAddress>
      <listenAddress>dynamic+https://relays.syncthing.net/endpoint</listenAddress>
      <listenAddress>dynamic+http://relay.invalid/endpoint</listenAddress>
      <listenAddress>relay://relay.invalid:22067</listenAddress>
      <listenAddress>https://unexpected.invalid/listener</listenAddress>
      <listenAddress>quic://0.0.0.0:60247</listenAddress>
      <globalAnnounceEnabled>true</globalAnnounceEnabled>
      <localAnnounceEnabled>true</localAnnounceEnabled>
      <relaysEnabled>true</relaysEnabled>
      <natEnabled>true</natEnabled>
      <startBrowser>true</startBrowser>
      <urAccepted>0</urAccepted>
      <crashReportingEnabled>true</crashReportingEnabled>
      <stunKeepaliveStartS>180</stunKeepaliveStartS>
    </options></configuration>`;
    const result = hardenSyncthingXml(source);
    expect(result).toContain('<listenAddress>tcp://0.0.0.0:60247</listenAddress>');
    expect(result).toContain('<listenAddress>quic://0.0.0.0:60247</listenAddress>');
    expect(result).not.toContain('relays.syncthing.net');
    expect(result).not.toContain('relay.invalid');
    expect(result).not.toContain('unexpected.invalid');
    expect(result).toContain('<globalAnnounceEnabled>false</globalAnnounceEnabled>');
    expect(result).toContain('<localAnnounceEnabled>true</localAnnounceEnabled>');
    expect(result).toContain('<relaysEnabled>false</relaysEnabled>');
    expect(result).toContain('<natEnabled>false</natEnabled>');
    expect(result).toContain('<announceLANAddresses>true</announceLANAddresses>');
    expect(result).toContain('<startBrowser>false</startBrowser>');
    expect(result).toContain('<urAccepted>-1</urAccepted>');
    expect(result).toContain('<crashReportingEnabled>false</crashReportingEnabled>');
    expect(result).toContain('<stunKeepaliveStartS>0</stunKeepaliveStartS>');
    expect(result).toContain('<autoUpgradeIntervalH>0</autoUpgradeIntervalH>');
    expect(result).toContain('<releasesURL></releasesURL>');
  });

  it('端口冲突时在离线配置中改用随机 LAN 端口', () => {
    const source =
      '<configuration><options><listenAddress>default</listenAddress></options></configuration>';
    const result = hardenSyncthingXml(source, true);
    expect(result).toContain('<listenAddress>tcp://0.0.0.0:0</listenAddress>');
    expect(result).toContain('<listenAddress>quic://0.0.0.0:0</listenAddress>');
    expect(result).not.toContain('<listenAddress>default</listenAddress>');
  });

  it('迁移旧的回环同步监听，但不改写已有的 LAN 端口', () => {
    const legacy =
      '<configuration><options><listenAddress>tcp://127.0.0.1:22000</listenAddress></options></configuration>';
    expect(hardenSyncthingXml(legacy)).toContain('tcp://0.0.0.0:22000');
    const configured =
      '<configuration><options><listenAddress>tcp://0.0.0.0:34567</listenAddress></options></configuration>';
    expect(hardenSyncthingXml(configured)).toContain('tcp://0.0.0.0:34567');
  });

  it('只使同步 listener 的 bind 失败触发端口重选', () => {
    expect(
      listenerHasBindError({
        myID: 'id',
        connectionServiceStatus: {
          'tcp://0.0.0.0:34567': { error: 'listen tcp: bind: address already in use' },
          'relay://relay.invalid': { error: 'bind: address already in use' },
        },
      }),
    ).toBe(true);
    expect(
      listenerHasBindError({
        myID: 'id',
        connectionServiceStatus: {
          'relay://relay.invalid': { error: 'bind: address already in use' },
        },
      }),
    ).toBe(false);
  });

  it('不把 Windows 跨盘绝对路径当作 Syncthing home 子目录', () => {
    expect(safeRelativeChild('folder/config')).toBe(true);
    expect(safeRelativeChild('D:\\OtherSyncthing')).toBe(false);
  });

  it('在 UDP 端口被占用时安全返回 false', async () => {
    const socket = createSocket('udp4');
    await new Promise<void>((resolvePromise, reject) => {
      socket.once('error', reject);
      socket.bind(0, '127.0.0.1', resolvePromise);
    });
    try {
      const address = socket.address();
      expect(await udpPortAvailable(address.port)).toBe(false);
    } finally {
      socket.close();
    }
  });

  it('并发初始化 API Key 时统一读回首个发布者的值', async () => {
    const root = await mkdtemp(join(tmpdir(), `kitesync-api-key-${randomUUID()}-`));
    try {
      const path = join(root, 'private', 'api-key');
      const values = await Promise.all(
        Array.from({ length: 16 }, () => loadOrCreateSyncthingApiKey(path)),
      );
      expect(new Set(values).size).toBe(1);
      expect((await readFile(path, 'utf8')).trim()).toBe(values[0]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('版本恢复会隔离在线 peer，索引恢复内容后再保持原暂停状态恢复连接', async () => {
    const syncthing = new LocalSyncthing({} as NodeConfig);
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    let connectionChecks = 0;
    let databaseChecks = 0;
    const request = vi
      .spyOn(
        syncthing as unknown as {
          request: (path: string, init?: RequestInit) => Promise<unknown>;
        },
        'request',
      )
      .mockImplementation(async (path, init) => {
        calls.push({ path, ...(init ? { init } : {}) });
        if (path === '/rest/config/folders/folder') {
          return {
            id: 'folder',
            path: '/folder',
            devices: [{ deviceID: 'SELF' }, { deviceID: 'ACTIVE' }, { deviceID: 'PAUSED' }],
          };
        }
        if (path === '/rest/system/status') return { myID: 'SELF' };
        if (path === '/rest/config/devices') {
          return [
            { deviceID: 'SELF' },
            { deviceID: 'ACTIVE', paused: false },
            { deviceID: 'PAUSED', paused: true },
          ];
        }
        if (path === '/rest/system/connections') {
          connectionChecks += 1;
          return { connections: { ACTIVE: { connected: connectionChecks === 1 } } };
        }
        if (path === '/rest/db/status?folder=folder') return { state: 'idle' };
        if (path.startsWith('/rest/db/file?')) {
          databaseChecks += 1;
          const sequence = databaseChecks === 1 ? 1 : 2;
          return {
            local: {
              size: sequence,
              blocksHash: `hash-${sequence}`,
              version: [`SELF:${sequence}`],
              sequence,
              deleted: false,
              mustRescan: false,
            },
            global: {
              size: sequence,
              blocksHash: `hash-${sequence}`,
              version: [`SELF:${sequence}`],
              sequence,
              deleted: false,
              mustRescan: false,
            },
          };
        }
        if (path.startsWith('/rest/folder/versions?')) return {};
        return undefined;
      });

    await expect(
      syncthing.restoreVersion('folder', 'report.txt', '2026-09-03T00:00:00.000Z'),
    ).resolves.toEqual({});

    const simplified = calls.map(({ path, init }) => [path, init?.method, init?.body]);
    const pause = simplified.findIndex(
      ([path, method, body]) =>
        path === '/rest/config/devices/ACTIVE' && method === 'PATCH' && body === '{"paused":true}',
    );
    const restore = simplified.findIndex(([path]) =>
      String(path).startsWith('/rest/folder/versions?folder=folder'),
    );
    const scan = simplified.findIndex(([path]) => path === '/rest/db/scan?folder=folder');
    const resume = simplified.findIndex(
      ([path, method, body]) =>
        path === '/rest/config/devices/ACTIVE' && method === 'PATCH' && body === '{"paused":false}',
    );
    expect(pause).toBeGreaterThanOrEqual(0);
    expect(restore).toBeGreaterThan(pause);
    expect(scan).toBeGreaterThan(restore);
    expect(resume).toBeGreaterThan(scan);
    expect(simplified.some(([path]) => path === '/rest/config/devices/PAUSED')).toBe(false);
    expect(connectionChecks).toBe(11);
    expect(databaseChecks).toBe(2);
    request.mockRestore();
  });

  it('解除配对严格先移除 folder 引用，再删设备，最后记录 ignore', async () => {
    const syncthing = new LocalSyncthing({} as NodeConfig);
    const calls: Array<{ path: string; method?: string }> = [];
    vi.spyOn(
      syncthing as unknown as {
        request: (path: string, init?: RequestInit) => Promise<unknown>;
      },
      'request',
    ).mockImplementation(async (path, init) => {
      calls.push({ path, ...(init?.method ? { method: init.method } : {}) });
      if (path === '/rest/config/devices/PEER' && !init?.method) {
        return { deviceID: 'PEER', name: '同伴', addresses: ['dynamic'] };
      }
      if (path === '/rest/config/folders') {
        return [
          {
            id: 'shared',
            path: '/shared',
            devices: [{ deviceID: 'SELF' }, { deviceID: 'PEER', introducedBy: 'KEEP' }],
          },
        ];
      }
      if (path === '/rest/config') return { remoteIgnoredDevices: [] };
      return undefined;
    });

    await syncthing.removeAndIgnoreDevice('PEER');
    const folderPut = calls.findIndex(
      (call) => call.path === '/rest/config/folders/shared' && call.method === 'PUT',
    );
    const deviceDelete = calls.findIndex(
      (call) => call.path === '/rest/config/devices/PEER' && call.method === 'DELETE',
    );
    const configurationPut = calls.findIndex(
      (call) => call.path === '/rest/config' && call.method === 'PUT',
    );
    expect(folderPut).toBeGreaterThanOrEqual(0);
    expect(deviceDelete).toBeGreaterThan(folderPut);
    expect(configurationPut).toBeGreaterThan(deviceDelete);

    const failing = new LocalSyncthing({} as NodeConfig);
    const failedCalls: Array<{ path: string; method?: string }> = [];
    vi.spyOn(
      failing as unknown as {
        request: (path: string, init?: RequestInit) => Promise<unknown>;
      },
      'request',
    ).mockImplementation(async (path, init) => {
      failedCalls.push({ path, ...(init?.method ? { method: init.method } : {}) });
      if (path === '/rest/config/devices/PEER' && !init?.method) return { deviceID: 'PEER' };
      if (path === '/rest/config/folders') {
        return [{ id: 'shared', path: '/shared', devices: [{ deviceID: 'PEER' }] }];
      }
      if (path === '/rest/config/folders/shared') throw new Error('folder update failed');
      return undefined;
    });
    await expect(failing.removeAndIgnoreDevice('PEER')).rejects.toThrow('folder update failed');
    expect(
      failedCalls.some(
        (call) => call.path === '/rest/config/devices/PEER' && call.method === 'DELETE',
      ),
    ).toBe(false);
    expect(failedCalls.some((call) => call.path === '/rest/config')).toBe(false);
  });

  it('忽略 folder 邀请的读改写位于队列内并保留设备其他字段', async () => {
    const syncthing = new LocalSyncthing({} as NodeConfig);
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.spyOn(
      syncthing as unknown as {
        request: (path: string, init?: RequestInit) => Promise<unknown>;
      },
      'request',
    ).mockImplementation(async (path, init) => {
      calls.push({ path, ...(init ? { init } : {}) });
      if (path === '/rest/config/devices/PEER' && !init?.method) {
        return {
          deviceID: 'PEER',
          name: '同伴',
          paused: true,
          customField: 'keep',
          ignoredFolders: [{ id: 'existing', label: '已有记录' }],
        };
      }
      if (path.startsWith('/rest/cluster/pending/folders?') && !init?.method) {
        return {
          offered: { offeredBy: { PEER: { label: `远端\n${'标'.repeat(200)}` } } },
        };
      }
      return undefined;
    });

    await Promise.all([
      syncthing.ignorePendingFolder('PEER', 'offered'),
      syncthing.patchDevice('PEER', { paused: false }),
    ]);
    const put = calls.findIndex(
      (call) => call.path === '/rest/config/devices/PEER' && call.init?.method === 'PUT',
    );
    const patch = calls.findIndex(
      (call) => call.path === '/rest/config/devices/PEER' && call.init?.method === 'PATCH',
    );
    expect(put).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThan(put);
    const body = JSON.parse(String(calls[put]?.init?.body));
    expect(body).toMatchObject({
      deviceID: 'PEER',
      paused: true,
      customField: 'keep',
      ignoredFolders: [{ id: 'existing', label: '已有记录' }, { id: 'offered' }],
    });
    expect(body.ignoredFolders[1].label).toHaveLength(128);
    expect(containsControlCharacter(body.ignoredFolders[1].label)).toBe(false);
  });

  it('持久化忽略设备前会限制并清理远端名称和地址', async () => {
    const syncthing = new LocalSyncthing({} as NodeConfig);
    let written: Record<string, unknown> | undefined;
    vi.spyOn(
      syncthing as unknown as {
        request: (path: string, init?: RequestInit) => Promise<unknown>;
      },
      'request',
    ).mockImplementation(async (path, init) => {
      if (path === '/rest/cluster/pending/devices' && !init?.method) {
        return {
          PEER: {
            name: `名称\n${'n'.repeat(200)}`,
            address: `tcp://192.168.1.2:22000\r${'a'.repeat(600)}`,
          },
        };
      }
      if (path === '/rest/config' && !init?.method) return { remoteIgnoredDevices: [] };
      if (path === '/rest/config' && init?.method === 'PUT') {
        written = JSON.parse(String(init.body));
      }
      return undefined;
    });

    await syncthing.ignorePendingDevice('PEER');
    const ignored = written?.remoteIgnoredDevices as Array<{ name: string; address: string }>;
    expect(ignored[0]?.name).toHaveLength(64);
    expect(ignored[0]?.address).toHaveLength(512);
    expect(containsControlCharacter(ignored[0]?.name ?? '')).toBe(false);
    expect(containsControlCharacter(ignored[0]?.address ?? '')).toBe(false);
  });

  it('仅在重新确认 home 归属后停止已接管的孤儿进程', async () => {
    const syncthing = new LocalSyncthing({} as NodeConfig);
    const internal = syncthing as unknown as {
      adopted: boolean;
      assertOwnedInstance: () => Promise<void>;
      request: (path: string, init?: RequestInit) => Promise<void>;
    };
    internal.adopted = true;
    const ownership = vi.spyOn(internal, 'assertOwnedInstance').mockResolvedValue();
    const request = vi.spyOn(internal, 'request').mockResolvedValue();
    vi.spyOn(syncthing, 'status').mockRejectedValue(new Error('已停止'));
    await syncthing.stop();
    expect(ownership).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('/rest/system/shutdown', { method: 'POST' });
  });

  it('归属重验失败时绝不关闭其他 Syncthing', async () => {
    const syncthing = new LocalSyncthing({} as NodeConfig);
    const internal = syncthing as unknown as {
      adopted: boolean;
      assertOwnedInstance: () => Promise<void>;
      request: (path: string, init?: RequestInit) => Promise<void>;
    };
    internal.adopted = true;
    vi.spyOn(internal, 'assertOwnedInstance').mockRejectedValue(new Error('home 不匹配'));
    const request = vi.spyOn(internal, 'request').mockResolvedValue();
    await expect(syncthing.stop()).rejects.toThrow(/home 不匹配/);
    expect(request).not.toHaveBeenCalled();
  });
});

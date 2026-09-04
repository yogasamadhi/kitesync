import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enableLinuxUserService,
  ensureOpenRuntime,
  ensureSetupRuntime,
  findEnabledLinuxUserService,
  identityFromSyncthing,
  runServe,
  setSystemServiceMarker,
  startInstalledWindowsTask,
} from './main.js';
import type { NodeConfig } from './config.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Windows 计划任务启动', () => {
  it('优先启动已安装的计划任务，只在明确未安装时允许回退', async () => {
    const root = join(tmpdir(), `kitesync-main-${randomUUID()}`);
    temporaryDirectories.push(root);
    await mkdir(root, { recursive: true });
    const executablePath = join(root, 'kitesync.exe');
    await writeFile(join(root, 'service-task.ps1'), '# fixture\n');
    const execute = vi.fn(async () => ({ code: 0, output: 'started' }));

    await expect(
      startInstalledWindowsTask({ compiled: true, executablePath }, execute),
    ).resolves.toBe(true);
    expect(execute).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-File', join(root, 'service-task.ps1'), '-StartIfInstalled']),
    );

    execute.mockResolvedValueOnce({ code: 0, output: 'not-installed' });
    await expect(
      startInstalledWindowsTask({ compiled: true, executablePath }, execute),
    ).resolves.toBe(false);
  });

  it('源码运行可回退，但打包态缺少查询脚本时拒绝冒险启动第二实例', async () => {
    const execute = vi.fn(async () => ({ code: 0, output: 'started' }));
    await expect(
      startInstalledWindowsTask(
        { compiled: false, executablePath: '/missing/kitesync.exe' },
        execute,
      ),
    ).resolves.toBe(false);
    await expect(
      startInstalledWindowsTask(
        { compiled: true, executablePath: '/missing/kitesync.exe' },
        execute,
      ),
    ).rejects.toThrow('找不到 Windows 后台服务脚本');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('Linux 用户级服务启动', () => {
  it('持久 system-mode 标记存在时不查询或启动用户级服务', async () => {
    const execute = vi.fn(async () => ({ code: 1, output: '' }));
    await expect(
      enableLinuxUserService(
        { syncthingGuiPort: 8385 },
        3210,
        execute,
        async () => false,
        () => true,
      ),
    ).rejects.toThrow('系统级 KiteSync 服务标记');
    expect(execute).not.toHaveBeenCalled();
  });

  it('扫描 getent 用户 home 与全局 user wants，发现其他用户启用的 unit', async () => {
    const execute = vi.fn(async () => ({
      code: 0,
      output: 'root:x:0:0:root:/root:/bin/bash\nalice:x:1000:1000::/home/alice:/bin/bash',
    }));
    const found = await findEnabledLinuxUserService(
      execute,
      (path) => path === '/home/alice/.config/systemd/user/default.target.wants/kitesync.service',
    );
    expect(found).toBe('/home/alice/.config/systemd/user/default.target.wants/kitesync.service');
  });

  it('原子写入并移除 system-mode 标记', async () => {
    const root = join(tmpdir(), `kitesync-marker-${randomUUID()}`);
    temporaryDirectories.push(root);
    const marker = join(root, 'etc/kitesync/system-service-enabled');
    await setSystemServiceMarker(marker, true);
    expect(await readFile(marker, 'utf8')).toMatch(/^\d{4}-/);
    await setSystemServiceMarker(marker, false);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('只有明确未安装 unit 时才允许回退到手工进程', async () => {
    const execute = vi.fn(async (scope: 'user' | 'system', args: string[]) => {
      if (scope === 'user' && args[0] === 'show') return { code: 0, output: 'not-found' };
      return { code: 1, output: 'inactive' };
    });
    await expect(
      enableLinuxUserService({ syncthingGuiPort: 8385 }, 3210, execute, async () => false),
    ).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalledWith('user', ['enable', '--now', 'kitesync.service']);
  });

  it('已安装 unit 启动失败时报错，不把失败伪装成未安装', async () => {
    const execute = vi.fn(async (scope: 'user' | 'system', args: string[]) => {
      if (scope === 'user' && args[0] === 'show') return { code: 0, output: 'loaded' };
      if (scope === 'user' && args[0] === 'enable') return { code: 1, output: 'start failed' };
      return { code: 1, output: 'inactive' };
    });
    await expect(
      enableLinuxUserService({ syncthingGuiPort: 8385 }, 3210, execute, async () => false),
    ).rejects.toThrow('start failed');
  });
});

describe('identity 启动竞态', () => {
  it('未取得节点锁时只等待并接管已有 sidecar，绝不另行 spawn', async () => {
    const identity = {
      deviceId: 'device',
      fingerprint: 'fingerprint',
      nodeName: 'node',
      syncthingVersion: 'v2.1.3',
      listenAddresses: [],
      localDiscoveryEnabled: true,
    };
    const syncthing = {
      start: vi.fn(async () => true),
      identity: vi.fn(async () => identity),
      identityOfRunningInstance: vi
        .fn<() => Promise<typeof identity>>()
        .mockRejectedValueOnce(new Error('尚未就绪'))
        .mockResolvedValue(identity),
    };
    await expect(identityFromSyncthing(syncthing, false, async () => undefined)).resolves.toBe(
      identity,
    );
    expect(syncthing.start).not.toHaveBeenCalled();
    expect(syncthing.identity).not.toHaveBeenCalled();
    expect(syncthing.identityOfRunningInstance).toHaveBeenCalledTimes(2);
  });
});

describe('setup 启动竞态', () => {
  it('已有活锁时只等待现有服务健康，不启动临时 serve', async () => {
    const startTemporary = vi.fn(() => ({ pid: 42 }));
    const waitHealthy = vi.fn(async () => undefined);

    await expect(
      ensureSetupRuntime(
        async () => false,
        async () => 1234,
        startTemporary,
        waitHealthy,
      ),
    ).resolves.toBeUndefined();

    expect(startTemporary).not.toHaveBeenCalled();
    expect(waitHealthy).toHaveBeenCalledOnce();
  });

  it('无健康实例且没有活锁时启动可追踪的临时 serve', async () => {
    const child = { pid: 42 };
    const startTemporary = vi.fn(() => child);
    const waitHealthy = vi.fn(async () => undefined);

    await expect(
      ensureSetupRuntime(
        async () => false,
        async () => undefined,
        startTemporary,
        waitHealthy,
      ),
    ).resolves.toBe(child);

    expect(startTemporary).toHaveBeenCalledOnce();
    expect(waitHealthy).toHaveBeenCalledOnce();
  });
});

describe('open 启动竞态', () => {
  it('活锁存在时等待原服务，不再 spawn 第二个 serve', async () => {
    const start = vi.fn();
    const waitHealthy = vi.fn(async () => undefined);

    await ensureOpenRuntime(
      async () => false,
      async () => 4321,
      start,
      waitHealthy,
    );

    expect(start).not.toHaveBeenCalled();
    expect(waitHealthy).toHaveBeenCalledOnce();
  });

  it('持锁服务始终不健康时返回包含 owner PID 的诊断', async () => {
    await expect(
      ensureOpenRuntime(
        async () => false,
        async () => 4321,
        vi.fn(),
        async () => {
          throw new Error('timeout');
        },
      ),
    ).rejects.toThrow('进程 4321 持有单实例锁');
  });
});

describe('serve 初始化失败清理', () => {
  it('state.json 损坏时仍释放已经取得的单实例锁', async () => {
    const root = join(tmpdir(), `kitesync-serve-${randomUUID()}`);
    temporaryDirectories.push(root);
    await mkdir(root, { recursive: true });
    const statePath = join(root, 'state.json');
    const lockPath = join(root, 'node.lock');
    await writeFile(statePath, '{invalid json', 'utf8');
    const config: NodeConfig = {
      version: 'test',
      compiled: false,
      stateDirectory: root,
      statePath,
      lockPath,
      syncthingBinary: join(root, 'missing-syncthing'),
      syncthingHome: join(root, 'syncthing'),
      syncthingApiKeyFile: join(root, 'syncthing-api-key'),
      syncthingUrl: 'http://127.0.0.1:65534',
      syncthingGuiPort: 65_534,
      webRoot: join(root, 'web'),
      headless: true,
    };

    await expect(runServe(config)).rejects.toThrow();
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

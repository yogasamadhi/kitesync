import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceLock } from './instance-lock.js';
import { StateStore } from './state-store.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), `kitesync-${randomUUID()}-`));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('原子节点状态', () => {
  it('串行合并并发更新，且不复制 Syncthing 或 vault 的事实源', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'state.json');
    const store = await StateStore.open(path);
    await Promise.all([
      store.update((draft) => {
        draft.settings.lanAccessEnabled = true;
      }),
      store.update((draft) => {
        draft.settings.versioningDays = 90;
      }),
    ]);
    expect(store.snapshot().settings).toMatchObject({ lanAccessEnabled: true, versioningDays: 90 });
    const persisted = await readFile(path, 'utf8');
    expect(persisted).not.toContain('openSecret');
    expect(persisted).not.toContain('ignoredDevices');
    expect(persisted).not.toContain('nodeName');
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('拒绝把无效可信代理写入状态', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'state.json');
    const store = await StateStore.open(path);
    await expect(
      store.update((draft) => {
        draft.settings.trustedProxies = ['not-an-ip'];
      }),
    ).rejects.toThrow(/格式或版本无效/);
    expect(store.snapshot().settings.trustedProxies).toEqual([]);
  });
});

describe('单实例锁', () => {
  it('拒绝活锁，并可回收失效锁', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'node.lock');
    const first = await InstanceLock.acquire(path);
    await expect(InstanceLock.acquire(path)).rejects.toThrow(/已在运行/);
    await first.release();
    await writeFile(path, JSON.stringify({ pid: 2_147_483_647, token: 'stale' }));
    const replacement = await InstanceLock.acquire(path);
    await replacement.release();
  });
});

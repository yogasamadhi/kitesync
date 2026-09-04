import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceLock } from './instance-lock.js';

const temporaryDirectories: string[] = [];

async function lockPath() {
  const root = await mkdtemp(join(tmpdir(), `kitesync-lock-${randomUUID()}-`));
  temporaryDirectories.push(root);
  return join(root, 'node.lock');
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('单实例锁', () => {
  it('高并发首次启动时只允许一个进程语义上的获胜者', async () => {
    const path = await lockPath();
    const results = await Promise.allSettled(
      Array.from({ length: 32 }, () => InstanceLock.acquire(path)),
    );
    const winners = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    expect(winners).toHaveLength(1);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ pid: process.pid });
    await winners[0]!.release();
  });

  it('可原子替换已退出进程留下的锁', async () => {
    const path = await lockPath();
    await writeFile(
      path,
      `${JSON.stringify({ pid: 2_147_483_647, token: randomUUID(), startedAt: new Date(0) })}\n`,
      { mode: 0o600 },
    );
    const lock = await InstanceLock.acquire(path);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ pid: process.pid });
    await lock.release();
  });
});

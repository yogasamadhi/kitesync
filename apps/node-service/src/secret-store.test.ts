import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createSecretFile } from './secret-store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('本机打开密钥', () => {
  it('并发首次初始化时不覆盖先创建的密钥', async () => {
    const root = await mkdtemp(join(tmpdir(), `kitesync-${randomUUID()}-`));
    temporaryDirectories.push(root);
    const path = join(root, 'open-secret');
    const results = await Promise.all([
      createSecretFile(path, 'first-secret'),
      createSecretFile(path, 'second-secret'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(['first-secret\n', 'second-secret\n']).toContain(await readFile(path, 'utf8'));
  });
});

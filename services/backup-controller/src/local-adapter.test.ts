import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { localSnapshot } from './local-adapter.js';

describe('local backup adapter', () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  test('publishes an atomic snapshot with a verified inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kitesync-backup-'));
    temporary.push(root);
    const source = join(root, 'source');
    const destination = join(root, 'destination');
    await mkdir(source);
    await writeFile(join(source, 'hello.txt'), 'hello KiteSync');

    const result = await localSnapshot(source, destination);
    const manifest = JSON.parse(await readFile(join(result.path, 'manifest.json'), 'utf8')) as {
      files: Array<{ path: string; bytes: number; sha256: string }>;
    };

    expect(result.files).toBe(1);
    expect(result.bytes).toBe(14);
    expect(manifest.files[0]).toMatchObject({ path: 'hello.txt', bytes: 14 });
    expect(manifest.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

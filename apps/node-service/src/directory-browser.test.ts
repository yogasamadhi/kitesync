import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { DirectoryBrowser } from './directory-browser.js';

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

describe('本机目录选择', () => {
  it('在有效期内可复用旧游标往返分页', async () => {
    const root = await temporaryDirectory();
    await Promise.all(['one', 'two', 'three', 'four'].map((name) => mkdir(join(root, name))));
    const browser = new DirectoryBrowser([root]);
    const rootId = (await browser.roots()).items[0]?.id;
    expect(rootId).toBeTypeOf('string');

    const first = await browser.list(rootId!, 1);
    const secondCursor = first.nextCursor ?? undefined;
    const second = await browser.list(rootId!, 1, secondCursor);
    const third = await browser.list(rootId!, 1, second.nextCursor ?? undefined);
    expect(third.items).toHaveLength(1);

    const secondAgain = await browser.list(rootId!, 1, secondCursor);
    expect(secondAgain.items).toEqual(second.items);
  });
});

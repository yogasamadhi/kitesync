import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
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

  it('把系统选择结果转换为受范围约束的不透明目录句柄', async () => {
    const root = await temporaryDirectory();
    const selectedPath = join(root, 'Music');
    await mkdir(selectedPath);
    const browser = new DirectoryBrowser([root]);

    const selected = await browser.registerSelection(selectedPath);
    expect(selected).toMatchObject({ label: 'Music' });
    expect(selected.id).not.toContain(selectedPath);
    await expect(browser.resolveSelection(selected.id)).resolves.toEqual({
      path: await realpath(selectedPath),
      label: 'Music',
    });

    const outside = await temporaryDirectory();
    await expect(browser.registerSelection(outside)).rejects.toThrow('超出允许范围');
  });
});

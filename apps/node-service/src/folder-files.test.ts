import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';
import { afterEach, describe, expect, it } from 'vitest';
import { FolderFiles, safeRelativePath } from './folder-files.js';

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

describe('只读文件浏览', () => {
  it('使用不一次性加载整个目录的游标分页', async () => {
    const root = await temporaryDirectory();
    await Promise.all(
      ['one.txt', 'two.txt', 'three.txt'].map((name) => writeFile(join(root, name), name)),
    );
    const browser = new FolderFiles();
    const first = await browser.list('folder', root, '', 1);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf('string');
    const secondCursor = first.nextCursor ?? undefined;
    const second = await browser.list('folder', root, '', 1, secondCursor);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.path).not.toBe(first.items[0]?.path);
    const third = await browser.list('folder', root, '', 1, second.nextCursor ?? undefined);
    expect(third.items).toHaveLength(1);
    const secondAgain = await browser.list('folder', root, '', 1, secondCursor);
    expect(secondAgain.items).toEqual(second.items);
  });

  it('隐藏并拒绝访问 Syncthing 元数据和路径穿越', async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, '.stignore'), 'secret');
    await mkdir(join(root, '.stversions'));
    await writeFile(join(root, '.syncthing.note'), 'secret');
    await writeFile(join(root, 'visible.txt'), 'ok');
    const browser = new FolderFiles();
    const listing = await browser.list('folder', root, '', 100);
    expect(listing.items.map((item) => item.name)).toEqual(['visible.txt']);
    await expect(browser.file(root, '.stignore')).rejects.toThrow(/元数据/);
    expect(() => safeRelativePath('.stversions/../visible.txt')).toThrow(/元数据/);
    expect(() => safeRelativePath('folder\\.syncthing.tmp\\../visible.txt')).toThrow(/元数据/);
    expect(() => safeRelativePath('../outside')).toThrow(/超出/);
    expect(() => safeRelativePath(decodeURIComponent('%2e%2e/outside'))).toThrow(/超出/);
  });

  it.skipIf(process.platform === 'win32')('可展示但绝不跟随符号链接', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const browser = new FolderFiles();
    const listing = await browser.list('folder', root, '', 100);
    expect(listing.items).toContainEqual(
      expect.objectContaining({ name: 'link.txt', type: 'symlink' }),
    );
    await expect(browser.file(root, 'link.txt')).rejects.toThrow(/符号链接/);
  });

  it('拒绝通过目录符号链接或 Windows junction 逃逸根目录', async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(join(outside, 'secret.txt'), 'secret');
    const linkedDirectory = join(root, 'outside-link');
    await symlink(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const browser = new FolderFiles();
    const listing = await browser.list('folder', root, '', 100);
    expect(listing.items).toContainEqual(
      expect.objectContaining({ name: 'outside-link', type: 'symlink' }),
    );
    await expect(browser.list('folder', root, 'outside-link', 100)).rejects.toThrow(/符号链接/);
    await expect(browser.file(root, 'outside-link/secret.txt')).rejects.toThrow(/符号链接/);
  });

  it('拒绝升级旧配置中以符号链接或 junction 作为根的文件夹', async () => {
    const parent = await temporaryDirectory();
    const actual = await temporaryDirectory();
    await writeFile(join(actual, 'secret.txt'), 'secret');
    const linkedRoot = join(parent, 'linked-root');
    await symlink(actual, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const browser = new FolderFiles();
    await expect(browser.list('folder', linkedRoot, '', 100)).rejects.toThrow(/符号链接/);
    await expect(browser.file(linkedRoot, 'secret.txt')).rejects.toThrow(/符号链接/);
  });

  it('下载始终读取校验时打开的同一文件句柄', async () => {
    const root = await temporaryDirectory();
    const path = join(root, 'report.txt');
    const original = join(root, 'report.original.txt');
    await writeFile(path, 'validated bytes');
    const browser = new FolderFiles();
    const file = await browser.file(root, 'report.txt');

    await rename(path, original);
    await writeFile(path, 'replacement bytes');

    expect(await text(file.stream())).toBe('validated bytes');
  });
});

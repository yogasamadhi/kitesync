import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreFolderMarker } from './folder-marker.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), `kitesync-marker-${randomUUID()}-`));
  temporaryDirectories.push(path);
  return path;
}

describe('Syncthing 文件夹安全标记恢复', () => {
  it('只在同步根目录创建与固定 folder ID 对应的标记', async () => {
    const root = await temporaryDirectory();
    const folderId = 'folder-test';
    await expect(restoreFolderMarker(root, folderId)).resolves.toEqual({ created: true });
    const marker = join(root, '.stfolder', 'syncthing-folder-070ffa.txt');
    await expect(readFile(marker, 'utf8')).resolves.toContain(`folderID: ${folderId}`);
    await expect(restoreFolderMarker(root, folderId)).resolves.toEqual({ created: false });
  });

  it('拒绝用符号链接或普通文件冒充安全标记', async () => {
    const root = await temporaryDirectory();
    const target = await temporaryDirectory();
    await symlink(target, join(root, '.stfolder'));
    await expect(restoreFolderMarker(root, 'folder-test')).rejects.toThrow('安全标记');

    await rm(join(root, '.stfolder'));
    await writeFile(join(root, '.stfolder'), 'occupied');
    expect((await lstat(join(root, '.stfolder'))).isFile()).toBe(true);
    await expect(restoreFolderMarker(root, 'folder-test')).rejects.toThrow('安全标记');
  });
});

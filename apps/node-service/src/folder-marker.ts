import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MARKER_DIRECTORY = '.stfolder';

export async function restoreFolderMarker(configuredRoot: string, folderId: string) {
  const configuredInfo = await lstat(configuredRoot);
  if (configuredInfo.isSymbolicLink()) throw new Error('同步目录不能是符号链接或目录联接');
  const root = await realpath(configuredRoot);
  if (!(await stat(root)).isDirectory()) throw new Error('同步路径不是目录');

  const marker = join(root, MARKER_DIRECTORY);
  try {
    const markerInfo = await lstat(marker);
    if (markerInfo.isSymbolicLink() || !markerInfo.isDirectory()) {
      throw new Error('同步安全标记被其他文件占用');
    }
    return { created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  try {
    await mkdir(marker, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const markerInfo = await lstat(marker);
    if (markerInfo.isSymbolicLink() || !markerInfo.isDirectory()) {
      throw new Error('同步安全标记被其他文件占用');
    }
    return { created: false };
  }
  const shortHash = createHash('sha256').update(folderId).digest('hex').slice(0, 6);
  const markerFile = join(marker, `syncthing-folder-${shortHash}.txt`);
  const contents =
    '# This directory is a Syncthing folder marker.\n' +
    '# Do not delete.\n\n' +
    `folderID: ${folderId}\n` +
    `created: ${new Date().toISOString()}\n`;
  try {
    await writeFile(markerFile, contents, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
  } catch (error) {
    await rm(markerFile, { force: true }).catch(() => undefined);
    await rm(marker, { recursive: false }).catch(() => undefined);
    throw error;
  }
  return { created: true };
}

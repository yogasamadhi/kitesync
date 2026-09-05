import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import type { FolderConflictList, FolderFileList } from '@kitesync/contracts';
import { isWithinRoot } from './directory-browser.js';

interface Cursor {
  folderId: string;
  relativePath: string;
  offset: number;
  expiresAt: number;
}

function hiddenName(name: string) {
  const value = name.toLocaleLowerCase('en-US');
  return (
    value === '.stfolder' ||
    value === '.stversions' ||
    value === '.stignore' ||
    value.startsWith('.syncthing.') ||
    value.startsWith('~syncthing~')
  );
}

export function safeRelativePath(value: string) {
  if (value.includes('\0') || isAbsolute(value)) throw new Error('文件路径无效');
  // Check the caller-provided segments before normalization. Otherwise a path such as
  // `.stversions/../visible.txt` would normalize to a visible path after first traversing
  // Syncthing's private metadata namespace.
  if (value.split(/[\\/]+/).some(hiddenName)) {
    throw new Error('不能访问 Syncthing 内部元数据');
  }
  const normalized = normalize(value || '.');
  if (normalized === '..' || normalized.startsWith(`..${sep}`))
    throw new Error('文件路径超出同步目录');
  if (normalized.split(sep).some(hiddenName)) throw new Error('不能访问 Syncthing 内部元数据');
  return normalized === '.' ? '' : normalized;
}

function visible(name: string) {
  return !hiddenName(name);
}

export class FolderFiles {
  private readonly cursors = new Map<string, Cursor>();

  async list(
    folderId: string,
    configuredRoot: string,
    relativePath: string,
    limit: number,
    cursor?: string,
  ): Promise<FolderFileList> {
    const path = safeRelativePath(relativePath);
    const { root, target } = await this.resolve(configuredRoot, path, true);
    const offset = this.consumeCursor(folderId, path, cursor);
    const items: FolderFileList['items'] = [];
    let accepted = 0;
    let hasMore = false;
    const directory = await opendir(target);
    try {
      for await (const entry of directory) {
        if (!visible(entry.name)) continue;
        const itemPath = path ? `${path}/${entry.name}` : entry.name;
        const absolute = join(target, entry.name);
        let info;
        try {
          info = await lstat(absolute);
          if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) continue;
          if (!info.isSymbolicLink()) {
            const canonical = await realpath(absolute);
            if (!isWithinRoot(root, canonical)) continue;
          }
        } catch {
          continue;
        }
        if (accepted < offset) {
          accepted += 1;
          continue;
        }
        if (items.length >= limit) {
          hasMore = true;
          break;
        }
        items.push({
          name: entry.name,
          path: itemPath.split(sep).join('/'),
          type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : 'file',
          size: info.isFile() ? info.size : 0,
          modifiedAt: info.mtime.toISOString(),
        });
        accepted += 1;
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    const normalizedPath = path.split(sep).join('/');
    const parent = normalizedPath ? dirname(normalizedPath).split(sep).join('/') : null;
    return {
      path: normalizedPath,
      parentPath: parent === '.' ? '' : parent,
      items,
      nextCursor: hasMore ? this.issueCursor(folderId, path, offset + items.length) : null,
    };
  }

  async file(configuredRoot: string, relativePath: string) {
    const path = safeRelativePath(relativePath);
    if (!path) throw new Error('请选择一个文件');
    const resolved = await this.resolve(configuredRoot, path, false);
    const handle = await open(resolved.target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const [info, pathInfo, canonical] = await Promise.all([
        handle.stat(),
        stat(resolved.target),
        realpath(resolved.target),
      ]);
      if (
        !info.isFile() ||
        info.dev !== pathInfo.dev ||
        info.ino !== pathInfo.ino ||
        !isWithinRoot(resolved.root, canonical)
      ) {
        throw new Error('目标不是同步目录内的普通文件');
      }
      return {
        path: resolved.target,
        info,
        close: () => handle.close(),
        stream: (range?: { start: number; end: number }) =>
          handle.createReadStream({ autoClose: true, ...(range ?? {}) }),
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  async conflicts(
    folderId: string,
    configuredRoot: string,
    limit: number,
    cursor?: string,
  ): Promise<FolderConflictList> {
    const { root } = await this.resolve(configuredRoot, '', true);
    const cursorPath = '__conflicts__';
    const offset = this.consumeCursor(folderId, cursorPath, cursor);
    const items: FolderConflictList['items'] = [];
    let matched = 0;
    let hasMore = false;
    const directories = [''];
    while (directories.length && !hasMore) {
      const relativeDirectory = directories.pop() ?? '';
      const absoluteDirectory = relativeDirectory ? join(root, relativeDirectory) : root;
      const entries = (await readdir(absoluteDirectory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (!visible(entry.name) || entry.isSymbolicLink()) continue;
        const relative = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
        if (entry.isDirectory()) {
          directories.push(relative);
          continue;
        }
        if (!entry.isFile()) continue;
        const conflict = /^(.*)\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]{7}(.*)$/i.exec(entry.name);
        if (!conflict) continue;
        if (matched < offset) {
          matched += 1;
          continue;
        }
        if (items.length >= limit) {
          hasMore = true;
          break;
        }
        const absolute = join(root, relative);
        const info = await lstat(absolute);
        const originalName = `${conflict[1] ?? ''}${conflict[2] ?? ''}`;
        const originalRelative = relativeDirectory
          ? join(relativeDirectory, originalName)
          : originalName;
        let originalPath: string | null = null;
        try {
          const original = await lstat(join(root, originalRelative));
          if (original.isFile() && !original.isSymbolicLink()) {
            originalPath = originalRelative.split(sep).join('/');
          }
        } catch {
          // A conflict copy can remain after its presumed original was removed.
        }
        items.push({
          conflictPath: relative.split(sep).join('/'),
          originalPath,
          size: Math.max(0, info.size),
          modifiedAt: info.mtime.toISOString(),
        });
        matched += 1;
      }
    }
    return {
      items,
      nextCursor: hasMore ? this.issueCursor(folderId, cursorPath, offset + items.length) : null,
    };
  }

  async reveal(configuredRoot: string, relativePath: string) {
    const path = safeRelativePath(relativePath);
    const { target } = await this.resolve(configuredRoot, path, false);
    const opener =
      process.platform === 'darwin'
        ? { file: 'open', args: ['-R', target] }
        : process.platform === 'win32'
          ? { file: 'explorer.exe', args: [`/select,${target}`] }
          : { file: 'xdg-open', args: [dirname(target)] };
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(opener.file, opener.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolvePromise();
      });
    });
  }

  private async resolve(configuredRoot: string, relativePath: string, requireDirectory: boolean) {
    if ((await lstat(configuredRoot)).isSymbolicLink()) {
      throw new Error('不能通过符号链接或目录联接访问文件');
    }
    const root = await realpath(configuredRoot);
    let candidate = root;
    for (const segment of relativePath.split(sep).filter(Boolean)) {
      candidate = join(candidate, segment);
      const segmentInfo = await lstat(candidate);
      if (segmentInfo.isSymbolicLink()) throw new Error('不能通过符号链接或目录联接访问文件');
    }
    const target = await realpath(candidate);
    if (!isWithinRoot(root, target)) throw new Error('文件路径超出同步目录');
    const info = await stat(target);
    if (requireDirectory && !info.isDirectory()) throw new Error('目标不是目录');
    return { root, target };
  }

  private consumeCursor(folderId: string, relativePath: string, value: string | undefined) {
    if (!value) return 0;
    const cursor = this.cursors.get(value);
    if (
      !cursor ||
      cursor.folderId !== folderId ||
      cursor.relativePath !== relativePath ||
      cursor.expiresAt < Date.now()
    ) {
      if (cursor) this.cursors.delete(value);
      throw new Error('分页游标无效或已过期');
    }
    return cursor.offset;
  }

  private issueCursor(folderId: string, relativePath: string, offset: number) {
    const now = Date.now();
    if (this.cursors.size >= 1_000) {
      for (const [key, value] of this.cursors) {
        if (value.expiresAt < now) this.cursors.delete(key);
      }
      if (this.cursors.size >= 1_000) {
        const oldest = this.cursors.keys().next().value as string | undefined;
        if (oldest) this.cursors.delete(oldest);
      }
    }
    const id = randomUUID();
    this.cursors.set(id, {
      folderId,
      relativePath,
      offset,
      expiresAt: now + 5 * 60_000,
    });
    return id;
  }
}

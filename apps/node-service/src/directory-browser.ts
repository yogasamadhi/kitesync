import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import type { DirectoryList, DirectoryRoot } from '@kitesync/contracts';

interface Handle {
  path: string;
  root: string;
  label: string;
  expiresAt: number;
}

interface Cursor {
  handleId: string;
  offset: number;
  expiresAt: number;
}

const HANDLE_TTL_MS = 10 * 60_000;
const CURSOR_TTL_MS = 5 * 60_000;
const MAX_HANDLES = 4_096;
const MAX_CURSORS = 1_000;

function preserveWindowsDriveRoot(requested: string, canonical: string) {
  return process.platform === 'win32' &&
    /^[A-Za-z]:[\\/]$/.test(requested) &&
    /^[A-Za-z]:$/.test(canonical)
    ? `${canonical}\\`
    : canonical;
}

async function canonicalPath(path: string) {
  return preserveWindowsDriveRoot(path, await realpath(path));
}

export function isWithinRoot(root: string, candidate: string) {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

async function availableRoots(configured?: string[]) {
  const candidates: Array<{ path: string; label: string }> = configured
    ? configured.map((path) => ({ path, label: basename(path) || path }))
    : [{ path: homedir(), label: '个人文件夹' }];
  if (!configured && process.platform === 'darwin') {
    candidates.push({ path: '/Volumes', label: '磁盘与卷' });
  } else if (!configured && process.platform === 'linux') {
    candidates.push({ path: '/mnt', label: '挂载目录' }, { path: '/media', label: '可移动媒体' });
  } else if (!configured && process.platform === 'win32') {
    for (let code = 65; code <= 90; code += 1) {
      candidates.push({
        path: `${String.fromCharCode(code)}:\\`,
        label: `${String.fromCharCode(code)}:`,
      });
    }
  }

  const roots: Array<{ path: string; label: string }> = [];
  for (const candidate of candidates) {
    try {
      const canonical = await canonicalPath(candidate.path);
      if ((await stat(canonical)).isDirectory() && !roots.some((item) => item.path === canonical)) {
        roots.push({ path: canonical, label: candidate.label });
      }
    } catch {
      // Optional mounts and Windows drive letters may not exist.
    }
  }
  return roots;
}

export class DirectoryBrowser {
  private readonly handles = new Map<string, Handle>();
  private readonly pathHandles = new Map<string, string>();
  private readonly cursors = new Map<string, Cursor>();
  private rootIds: string[] | undefined;

  constructor(private readonly configuredRoots?: string[]) {}

  async roots(): Promise<{ items: DirectoryRoot[] }> {
    this.purgeExpired();
    if (!this.rootIds) {
      this.rootIds = [];
      for (const root of await availableRoots(this.configuredRoots)) {
        this.rootIds.push(this.addHandle(root.path, root.path, root.label));
      }
    }
    return {
      items: this.rootIds.map((id) => ({ id, label: this.getHandle(id).label })),
    };
  }

  async list(handleId: string, limit: number, cursor?: string): Promise<DirectoryList> {
    const handle = this.getHandle(handleId);
    const offset = this.consumeCursor(handleId, cursor);
    const entries: Array<{ id: string; name: string }> = [];
    let accepted = 0;
    let hasMore = false;
    const directory = await opendir(handle.path);
    try {
      for await (const entry of directory) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        let canonical: string;
        try {
          const candidate = join(handle.path, entry.name);
          if ((await lstat(candidate)).isSymbolicLink()) continue;
          canonical = await realpath(candidate);
          if (!(await stat(canonical)).isDirectory() || !isWithinRoot(handle.root, canonical))
            continue;
        } catch {
          continue;
        }
        if (accepted < offset) {
          accepted += 1;
          continue;
        }
        if (entries.length >= limit) {
          hasMore = true;
          break;
        }
        entries.push({ id: this.addHandle(canonical, handle.root, entry.name), name: entry.name });
        accepted += 1;
      }
    } finally {
      await directory.close().catch(() => undefined);
    }

    const parentPath = dirname(handle.path);
    const parentId =
      handle.path === handle.root
        ? null
        : this.addHandle(parentPath, handle.root, basename(parentPath) || handle.label);
    return {
      current: { id: handleId, label: handle.label },
      parentId,
      items: entries,
      nextCursor: hasMore ? this.issueCursor(handleId, offset + entries.length) : null,
    };
  }

  async resolveDirectory(handleId: string) {
    const handle = this.getHandle(handleId);
    await this.assertNoSymlink(handle.root, handle.path);
    const canonical = await canonicalPath(handle.path);
    if (!isWithinRoot(handle.root, canonical) || !(await stat(canonical)).isDirectory()) {
      throw new Error('目录已失效或超出允许范围');
    }
    return canonical;
  }

  async resolveSelection(handleId: string) {
    const handle = this.getHandle(handleId);
    const path = await this.resolveDirectory(handleId);
    return { path, label: handle.label };
  }

  async registerSelection(path: string): Promise<DirectoryRoot> {
    if (!isAbsolute(path)) throw new Error('系统目录选择器返回了无效路径');
    const canonical = await canonicalPath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('选择的路径不是目录');

    let root = canonical;
    if (this.configuredRoots) {
      const allowedRoots = await availableRoots(this.configuredRoots);
      const allowed = allowedRoots.find((candidate) => isWithinRoot(candidate.path, canonical));
      if (!allowed) throw new Error('选择的目录超出允许范围');
      root = allowed.path;
    }
    const label = (basename(canonical) || canonical).slice(0, 128);
    return { id: this.addHandle(canonical, root, label), label };
  }

  private addHandle(path: string, root: string, label: string) {
    this.purgeExpired();
    const key = `${root}\0${path}`;
    const existing = this.pathHandles.get(key);
    if (existing) {
      const handle = this.handles.get(existing);
      if (handle && handle.expiresAt >= Date.now()) {
        handle.expiresAt = Date.now() + HANDLE_TTL_MS;
        return existing;
      }
      this.removeHandle(existing, handle);
    }
    while (this.handles.size >= MAX_HANDLES) {
      const oldest = this.handles.entries().next().value as [string, Handle] | undefined;
      if (!oldest) break;
      this.removeHandle(oldest[0], oldest[1]);
    }
    const id = randomUUID();
    this.handles.set(id, { path, root, label, expiresAt: Date.now() + HANDLE_TTL_MS });
    this.pathHandles.set(key, id);
    return id;
  }

  private getHandle(id: string) {
    const handle = this.handles.get(id);
    if (!handle || handle.expiresAt < Date.now()) {
      if (handle) this.removeHandle(id, handle);
      throw new Error('目录句柄无效或已过期');
    }
    handle.expiresAt = Date.now() + HANDLE_TTL_MS;
    return handle;
  }

  private consumeCursor(handleId: string, value: string | undefined) {
    if (!value) return 0;
    const cursor = this.cursors.get(value);
    if (!cursor || cursor.handleId !== handleId || cursor.expiresAt < Date.now()) {
      if (cursor) this.cursors.delete(value);
      throw new Error('分页游标无效或已过期');
    }
    return cursor.offset;
  }

  private issueCursor(handleId: string, offset: number) {
    this.purgeExpired();
    const id = randomUUID();
    this.cursors.set(id, { handleId, offset, expiresAt: Date.now() + CURSOR_TTL_MS });
    while (this.cursors.size > MAX_CURSORS) {
      const oldest = this.cursors.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cursors.delete(oldest);
    }
    return id;
  }

  private removeHandle(id: string, handle?: Handle) {
    const existing = handle ?? this.handles.get(id);
    if (!existing) return;
    this.handles.delete(id);
    this.pathHandles.delete(`${existing.root}\0${existing.path}`);
    if (this.rootIds?.includes(id)) this.rootIds = undefined;
  }

  private purgeExpired() {
    const now = Date.now();
    for (const [id, handle] of this.handles) {
      if (handle.expiresAt < now) this.removeHandle(id, handle);
    }
    for (const [id, cursor] of this.cursors) {
      if (cursor.expiresAt < now || !this.handles.has(cursor.handleId)) this.cursors.delete(id);
    }
  }

  private async assertNoSymlink(root: string, candidate: string) {
    const child = relative(root, candidate);
    if (child === '') return;
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error('目录已失效或超出允许范围');
    }
    let current = root;
    for (const segment of child.split(sep)) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('不允许选择符号链接目录');
    }
  }
}

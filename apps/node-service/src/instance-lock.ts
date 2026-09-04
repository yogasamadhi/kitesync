import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';

interface LockContents {
  pid: number;
  token: string;
  startedAt: string;
}

function running(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class InstanceLock {
  private released = false;

  private constructor(
    readonly path: string,
    readonly contents: LockContents,
  ) {}

  static async acquire(path: string) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const contents: LockContents = {
        pid: process.pid,
        token: randomUUID(),
        startedAt: new Date().toISOString(),
      };
      const candidate = `${path}.${process.pid}.${contents.token}.candidate`;
      try {
        const handle = await open(candidate, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(contents)}\n`, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        // Publishing a hard link is create-only and atomic. Every observer therefore sees
        // either no lock or the complete owner record, never a half-written JSON file.
        await link(candidate, path);
        await rm(candidate, { force: true });
        return new InstanceLock(path, contents);
      } catch (error) {
        await rm(candidate, { force: true }).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let current: Partial<LockContents> = {};
        try {
          current = JSON.parse(await readFile(path, 'utf8')) as Partial<LockContents>;
        } catch {
          // An unreadable lock cannot protect a live process; treat it as stale.
        }
        if (typeof current.pid === 'number' && running(current.pid)) {
          throw new Error(`KiteSync 已在运行（进程 ${current.pid}）`);
        }
        if (typeof current.token !== 'string') {
          throw new Error(`KiteSync 单实例锁损坏，请确认无节点运行后删除：${path}`);
        }
        const reclaimPath = `${path}.reclaim`;
        const reclaim = await tryAcquireReclaim(reclaimPath);
        if (!reclaim) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
          continue;
        }
        try {
          const latest = JSON.parse(await readFile(path, 'utf8')) as Partial<LockContents>;
          if (latest.token !== current.token) continue;
          if (typeof latest.pid === 'number' && running(latest.pid)) {
            throw new Error(`KiteSync 已在运行（进程 ${latest.pid}）`);
          }
          // The reclaim marker serializes stale replacement. rename keeps the lock path
          // continuously occupied, so another launcher cannot slip into a remove/create gap.
          const replacement = `${path}.${process.pid}.${contents.token}.replacement`;
          const handle = await open(replacement, 'wx', 0o600);
          try {
            await handle.writeFile(`${JSON.stringify(contents)}\n`, 'utf8');
            await handle.sync();
          } finally {
            await handle.close();
          }
          try {
            await rename(replacement, path);
          } catch (replaceError) {
            await rm(replacement, { force: true }).catch(() => undefined);
            throw replaceError;
          }
          return new InstanceLock(path, contents);
        } finally {
          await releaseReclaim(reclaimPath, reclaim);
        }
      }
    }
    throw new Error('无法取得 KiteSync 单实例锁');
  }

  async release() {
    if (this.released) return;
    this.released = true;
    try {
      const current = JSON.parse(await readFile(this.path, 'utf8')) as Partial<LockContents>;
      if (current.token === this.contents.token) await rm(this.path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function tryAcquireReclaim(path: string) {
  const owner: LockContents = {
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  const candidate = `${path}.${owner.token}.candidate`;
  const handle = await open(candidate, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(candidate, path);
    return owner;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const existing = JSON.parse(await readFile(path, 'utf8')) as Partial<LockContents>;
      if (typeof existing.pid === 'number' && !running(existing.pid)) {
        // A previous process died during stale-lock replacement. Token-check before removal
        // narrows cleanup to that orphan rather than a newly published reclaim marker.
        const latest = JSON.parse(await readFile(path, 'utf8')) as Partial<LockContents>;
        if (latest.token === existing.token) await rm(path, { force: true });
      }
    } catch {
      // A live contender may be publishing/removing the short-lived marker right now.
    }
    return undefined;
  } finally {
    await rm(candidate, { force: true }).catch(() => undefined);
  }
}

async function releaseReclaim(path: string, owner: LockContents) {
  try {
    const current = JSON.parse(await readFile(path, 'utf8')) as Partial<LockContents>;
    if (current.token === owner.token) await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function readLockedPid(path: string) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<LockContents>;
    return typeof value.pid === 'number' && running(value.pid) ? value.pid : undefined;
  } catch {
    return undefined;
  }
}

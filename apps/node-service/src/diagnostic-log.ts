import { dirname } from 'node:path';
import { appendFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import type { DiagnosticLogList } from '@kitesync/contracts';

export type DiagnosticLevel = 'info' | 'warn' | 'error';

const SECRET_PATTERN =
  /(password|cookie|csrf|open[ _-]?secret|api[ _-]?key)(\s*[=:]\s*)([^\s,;]+)/gi;

function safeMessage(value: unknown) {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(SECRET_PATTERN, '$1$2[已移除]')
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s,:;"']+[\\/])+[^\s,:;"']*/g, '[路径已移除]')
    .slice(0, 4096);
}

interface Entry {
  timestamp: string;
  level: DiagnosticLevel;
  message: string;
}

export class DiagnosticLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly path?: string,
    private readonly maxBytes = 5 * 1024 * 1024,
    private readonly retainedFiles = 3,
  ) {}

  write(level: DiagnosticLevel, message: unknown) {
    const entry: Entry = {
      timestamp: new Date().toISOString(),
      level,
      message: safeMessage(message) || '未提供详情',
    };
    if (!this.path) return;
    const operation = this.queue.then(async () => {
      await mkdir(dirname(this.path as string), { recursive: true, mode: 0o700 });
      const bytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`);
      const currentSize = await stat(this.path as string)
        .then((value) => value.size)
        .catch(() => 0);
      if (currentSize + bytes > this.maxBytes) await this.rotate();
      await appendFile(this.path as string, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    });
    this.queue = operation.catch(() => undefined);
  }

  async recent(limit: number, offset = 0): Promise<DiagnosticLogList> {
    await this.queue;
    if (!this.path) return { items: [], nextCursor: null };
    const entries: Entry[] = [];
    for (let index = this.retainedFiles - 1; index >= 0; index -= 1) {
      const path = index === 0 ? this.path : `${this.path}.${index}`;
      const content = await readFile(path, 'utf8').catch(() => '');
      for (const line of content.split('\n')) {
        if (!line) continue;
        try {
          const value = JSON.parse(line) as Entry;
          if (
            typeof value.timestamp === 'string' &&
            ['info', 'warn', 'error'].includes(value.level) &&
            typeof value.message === 'string'
          ) {
            entries.push({ ...value, message: safeMessage(value.message) });
          }
        } catch {
          // Ignore damaged trailing records instead of failing diagnostics.
        }
      }
    }
    entries.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
    const items = entries.slice(offset, offset + limit);
    return {
      items,
      nextCursor: offset + items.length < entries.length ? String(offset + items.length) : null,
    };
  }

  private async rotate() {
    if (!this.path) return;
    await rm(`${this.path}.${this.retainedFiles - 1}`, { force: true });
    for (let index = this.retainedFiles - 2; index >= 0; index -= 1) {
      const from = index === 0 ? this.path : `${this.path}.${index}`;
      const to = `${this.path}.${index + 1}`;
      await rename(from, to).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}

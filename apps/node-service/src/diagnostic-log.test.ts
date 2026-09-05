import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DiagnosticLog } from './diagnostic-log.js';

describe('诊断日志', () => {
  it('轮转日志并移除凭据和绝对路径', async () => {
    const root = await mkdtemp(join(tmpdir(), `kitesync-log-${randomUUID()}-`));
    try {
      const path = join(root, 'node.log');
      const log = new DiagnosticLog(path, 180, 3);
      log.write('error', 'password=super-secret /Users/test/private/file.txt');
      const redacted = JSON.stringify(await log.recent(10));
      expect(redacted).not.toContain('super-secret');
      expect(redacted).not.toContain('/Users/test/private');
      expect(redacted).toContain('[已移除]');
      for (let index = 0; index < 8; index += 1) {
        log.write('info', `事件 ${index} ${'x'.repeat(60)}`);
      }
      const recent = await log.recent(100);
      expect((await readdir(root)).filter((name) => name.startsWith('node.log'))).toHaveLength(3);
      expect(recent.items.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

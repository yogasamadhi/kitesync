import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { NodeServiceDevSupervisor, serviceInvocation, waitForChildExit } from './dev-supervisor.js';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid: number;
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals | number) {
    this.signals.push(signal);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

function asChild(value: FakeChild) {
  return value as unknown as ChildProcess;
}

describe('Node Service 开发监督器', () => {
  it('热重载会等待旧进程完全退出后才启动新进程', async () => {
    const children: FakeChild[] = [];
    const report = vi.fn();
    const supervisor = new NodeServiceDevSupervisor(
      () => {
        const child = new FakeChild(100 + children.length);
        children.push(child);
        return asChild(child);
      },
      1_000,
      report,
    );

    supervisor.start();
    const restarting = supervisor.requestRestart();
    await vi.waitFor(() => expect(children[0]?.signals).toEqual(['SIGTERM']));
    expect(children).toHaveLength(1);

    children[0]!.finish(null, 'SIGTERM');
    await restarting;
    expect(children).toHaveLength(2);
    expect(report).not.toHaveBeenCalled();

    const shuttingDown = supervisor.shutdown();
    await vi.waitFor(() => expect(children[1]?.signals).toEqual(['SIGTERM']));
    children[1]!.finish(null, 'SIGTERM');
    await shuttingDown;
  });

  it('等待已退出子进程时立即完成', async () => {
    const child = new FakeChild(200);
    child.finish(0);
    await expect(waitForChildExit(asChild(child), 1_000)).resolves.toBe(true);
  });

  it('inspect 参数只传给独立的服务子进程', () => {
    expect(serviceInvocation({ KITESYNC_INSPECT: '1' }).args).toContain('--inspect');
    expect(serviceInvocation({}).args).not.toContain('--inspect');
  });
});

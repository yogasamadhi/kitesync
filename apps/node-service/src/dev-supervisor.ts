#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(serviceRoot, '..', '..');

function exited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function serviceInvocation(environment: NodeJS.ProcessEnv = process.env) {
  return {
    file: process.execPath,
    args: [
      '--no-env-file',
      ...(environment.KITESYNC_INSPECT === '1' ? ['--inspect'] : []),
      resolve(serviceRoot, 'src', 'main.ts'),
      'serve',
    ],
  };
}

export function waitForChildExit(child: ChildProcess, timeout: number) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const finish = (didExit: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolvePromise(didExit);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    child.once('exit', onExit);
    if (exited(child)) finish(true);
  });
}

export class NodeServiceDevSupervisor {
  private child: ChildProcess | undefined;
  private terminating: ChildProcess | undefined;
  private restartRequested = false;
  private transition: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly spawnService: () => ChildProcess,
    private readonly stopTimeout = 30_000,
    private readonly report: (message: string) => void = (message) => console.error(message),
  ) {}

  start() {
    if (this.stopping || (this.child && !exited(this.child))) return;
    const child = this.spawnService();
    this.child = child;
    child.once('error', (error) => {
      if (!this.stopping && this.terminating !== child) {
        this.report(`KiteSync Node Service 启动失败：${error.message}`);
      }
    });
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      if (!this.stopping && this.terminating !== child) {
        const reason = signal ? `信号 ${signal}` : `退出码 ${code ?? '未知'}`;
        this.report(`KiteSync Node Service 已退出（${reason}）；等待文件变化后重试`);
      }
    });
  }

  requestRestart() {
    if (this.stopping) return Promise.resolve();
    this.restartRequested = true;
    if (!this.transition) {
      const transition = this.drainRestarts();
      this.transition = transition;
      const finished = () => {
        if (this.transition === transition) this.transition = undefined;
        if (this.restartRequested && !this.stopping) void this.requestRestart();
      };
      void transition.then(finished, finished);
    }
    return this.transition;
  }

  async shutdown() {
    this.stopping = true;
    this.restartRequested = false;
    await this.transition?.catch(() => undefined);
    await this.stopCurrent();
  }

  private async drainRestarts() {
    while (this.restartRequested && !this.stopping) {
      this.restartRequested = false;
      await this.stopCurrent();
      if (!this.stopping) this.start();
    }
  }

  private async stopCurrent() {
    const child = this.child;
    if (!child) return;
    this.terminating = child;
    try {
      if (!exited(child)) {
        const gracefulExit = waitForChildExit(child, this.stopTimeout);
        child.kill('SIGTERM');
        if (!(await gracefulExit)) {
          const forcedExit = waitForChildExit(child, 2_000);
          child.kill('SIGKILL');
          if (!(await forcedExit)) {
            throw new Error(`无法停止 Node Service 子进程 ${child.pid ?? '未知'}`);
          }
        }
      }
      if (this.child === child) this.child = undefined;
    } finally {
      if (this.terminating === child) this.terminating = undefined;
    }
  }
}

function spawnNodeService() {
  const invocation = serviceInvocation();
  return spawn(invocation.file, invocation.args, {
    cwd: serviceRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
}

async function run() {
  const supervisor = new NodeServiceDevSupervisor(spawnNodeService);
  const watchers: FSWatcher[] = [];
  let restartTimer: NodeJS.Timeout | undefined;
  let resolveDone: (() => void) | undefined;
  let rejectDone: ((error: Error) => void) | undefined;
  const done = new Promise<void>((resolvePromise, reject) => {
    resolveDone = resolvePromise;
    rejectDone = reject;
  });
  const scheduleRestart = () => {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void supervisor.requestRestart().catch((error: unknown) => {
        rejectDone?.(error instanceof Error ? error : new Error(String(error)));
      });
    }, 150);
  };

  for (const path of [
    resolve(serviceRoot, 'src'),
    resolve(repositoryRoot, 'packages', 'contracts', 'dist'),
  ]) {
    const watcher = watch(path, { recursive: true }, scheduleRestart);
    watcher.once('error', (error) => rejectDone?.(error));
    watchers.push(watcher);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (restartTimer) clearTimeout(restartTimer);
    for (const watcher of watchers) watcher.close();
    await supervisor.shutdown();
    resolveDone?.();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  supervisor.start();
  try {
    await done;
  } finally {
    await shutdown();
  }
}

if (import.meta.main) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

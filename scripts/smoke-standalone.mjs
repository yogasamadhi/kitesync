#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { chmod, copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';

const [executableArgument, syncthingArgument] = process.argv.slice(2);
if (!executableArgument || !syncthingArgument) {
  throw new Error('用法：bun scripts/smoke-standalone.mjs <kitesync> <syncthing>');
}
if (process.platform !== 'linux') {
  throw new Error('隔离 standalone smoke 仅在 Linux gate 运行，避免触碰桌面平台凭据存储');
}

const executableSource = resolve(executableArgument);
const syncthingSource = resolve(syncthingArgument);
for (const path of [executableSource, syncthingSource]) {
  if (!(await stat(path).catch(() => undefined))?.isFile()) throw new Error(`文件不存在：${path}`);
}

function availablePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('无法分配 smoke test 端口'));
        else resolvePromise(port);
      });
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function signalProcessGroup(processId, signal) {
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

const stage = await mkdtemp(join(tmpdir(), 'kitesync-standalone-'));
const executable = join(stage, process.platform === 'win32' ? 'kitesync.exe' : 'kitesync');
const syncthing = join(stage, basename(syncthingSource));
const state = join(stage, 'state');
const data = join(stage, 'data');
const workingDirectory = join(stage, 'empty-cwd');
let child;
let logs = '';

try {
  await Promise.all([
    copyFile(executableSource, executable),
    copyFile(syncthingSource, syncthing),
    mkdir(state),
    mkdir(data),
    mkdir(workingDirectory),
  ]);
  await Promise.all([chmod(executable, 0o755), chmod(syncthing, 0o755)]);
  const [uiPort, syncthingGuiPort] = await Promise.all([availablePort(), availablePort()]);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('KITESYNC_')),
  );
  Object.assign(environment, {
    KITESYNC_HEADLESS: '1',
    KITESYNC_STATE_DIR: state,
    KITESYNC_DIRECTORY_ROOTS: data,
    KITESYNC_UI_PORT: String(uiPort),
    KITESYNC_SYNCTHING_GUI_PORT: String(syncthingGuiPort),
  });

  child = spawn(executable, ['serve'], {
    cwd: workingDirectory,
    detached: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const appendLog = (chunk) => {
    logs = `${logs}${chunk.toString('utf8')}`.slice(-32_768);
  };
  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);
  child.once('error', appendLog);

  const baseUrl = `http://127.0.0.1:${uiPort}`;
  let healthy = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      // The compiled service and generated Syncthing configuration are still starting.
    }
    await delay(250);
  }
  if (!healthy) throw new Error(`standalone 服务未就绪\n${logs}`);

  const page = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2_000) });
  const html = await page.text();
  if (!page.ok || !/^\s*<!doctype html>/i.test(html)) {
    throw new Error(`standalone 未提供嵌入式 Web UI：HTTP ${page.status}`);
  }
  console.log(`Standalone smoke passed from isolated cwd (${uiPort}/${syncthingGuiPort}).`);
} finally {
  if (child?.pid) {
    signalProcessGroup(child.pid, 'SIGTERM');
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolvePromise) => child.once('exit', resolvePromise)),
        delay(5_000),
      ]);
    }
    signalProcessGroup(child.pid, 'SIGKILL');
  }
  await rm(stage, { recursive: true, force: true });
}

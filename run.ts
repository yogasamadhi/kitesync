#!/usr/bin/env bun

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Options {
  help: boolean;
  inspect: boolean;
}

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const nodeServiceRoot = resolve(repositoryRoot, 'apps', 'node-service');
const isWindows = process.platform === 'win32';
let child: ChildProcess | undefined;
let receivedSignal: NodeJS.Signals | undefined;

function printHelp() {
  console.log(`
KiteSync P2P Node 本地开发启动器

用法：
  bun run dev:all [--inspect]

选项：
  --inspect    为 Node Service 开启 Bun Inspector
  -h, --help   显示帮助

默认直接在宿主机启动 contracts、API client、Web UI 和 Node Service。
开发不需要 Docker；可选容器部署请使用 bun run docker:up。
`);
}

function parseArguments(arguments_: string[]): Options {
  const options: Options = { help: false, inspect: false };
  for (const argument of arguments_) {
    if (argument === '--inspect') options.inspect = true;
    else if (argument === '-h' || argument === '--help') options.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  return options;
}

function capture(command: string, arguments_: string[]) {
  return spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
  });
}

function assertToolchain() {
  if (!existsSync(resolve(repositoryRoot, 'bun.lock'))) {
    throw new Error('缺少 bun.lock，请从仓库根目录运行');
  }
  if (!existsSync(resolve(repositoryRoot, 'node_modules/typescript'))) {
    throw new Error('依赖尚未安装，请先运行 bun install --frozen-lockfile');
  }

  const result = capture('bun', ['--version']);
  if (result.error || result.status !== 0) throw new Error('需要 Bun 1.4 或更高版本');
  const match = result.stdout.trim().match(/^(\d+)\.(\d+)/);
  if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 4)) {
    throw new Error(`Bun 版本过低：需要 >= 1.4，当前为 ${result.stdout.trim()}`);
  }

  const platform = process.platform;
  const architecture = process.arch;
  const executable = process.platform === 'win32' ? 'syncthing.exe' : 'syncthing';
  const binary = resolve(
    repositoryRoot,
    'vendor/syncthing/bin',
    `${platform}-${architecture}`,
    executable,
  );
  if (!existsSync(binary)) {
    throw new Error(`缺少本机 Syncthing：${binary}\n请先运行 bun run syncthing:build`);
  }
}

function configuredDevelopmentPort(environment: NodeJS.ProcessEnv) {
  const override = environment.KITESYNC_UI_PORT ?? environment.KITESYNC_PORT;
  if (override !== undefined) {
    const value = Number(override);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new Error('KITESYNC_UI_PORT 必须是 1 到 65535 之间的整数');
    }
    return value;
  }
  const configuredDirectory = environment.KITESYNC_STATE_DIR;
  const stateDirectory = configuredDirectory
    ? isAbsolute(configuredDirectory)
      ? configuredDirectory
      : resolve(nodeServiceRoot, configuredDirectory)
    : resolve(repositoryRoot, '.kitesync-dev', 'node');
  try {
    const state = JSON.parse(readFileSync(resolve(stateDirectory, 'state.json'), 'utf8')) as {
      settings?: { uiPort?: unknown };
    };
    const value = Number(state.settings?.uiPort);
    return Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : 3210;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 3210;
    throw new Error(
      `无法读取开发节点端口配置：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function forward(signal: NodeJS.Signals) {
  receivedSignal = signal;
  signalDevelopmentGroup(signal);
}

function signalDevelopmentGroup(signal: NodeJS.Signals) {
  if (!child || child.killed) return;
  try {
    if (isWindows) child.kill();
    else process.kill(-child.pid!, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function waitForDevelopmentExit(timeout: number) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolvePromise) => {
    const current = child!;
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      current.off('exit', onExit);
      resolvePromise(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    current.once('exit', onExit);
    if (current.exitCode !== null || current.signalCode !== null) finish(true);
  });
}

async function stopDevelopmentGroup() {
  signalDevelopmentGroup('SIGTERM');
  if (await waitForDevelopmentExit(5_000)) return;
  if (isWindows) {
    if (child?.pid) capture('taskkill.exe', ['/pid', String(child.pid), '/t', '/f']);
    return;
  }
  try {
    if (child?.pid) process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForNodeService(port: number, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      const reason = child.signalCode ? `信号 ${child.signalCode}` : `退出码 ${child.exitCode}`;
      throw new Error(`开发进程已提前退出（${reason}）`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok && response.headers.get('x-kitesync-service') === 'node') return;
    } catch {
      // Node Service and its Syncthing sidecar can take a few seconds on first start.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  const stateDirectory = process.env.KITESYNC_STATE_DIR
    ? isAbsolute(process.env.KITESYNC_STATE_DIR)
      ? process.env.KITESYNC_STATE_DIR
      : resolve(nodeServiceRoot, process.env.KITESYNC_STATE_DIR)
    : resolve(repositoryRoot, '.kitesync-dev', 'node');
  let lockHint = '';
  try {
    const lock = JSON.parse(readFileSync(resolve(stateDirectory, 'node.lock'), 'utf8')) as {
      pid?: unknown;
    };
    if (Number.isInteger(lock.pid)) {
      lockHint = `；单实例锁当前由进程 ${String(lock.pid)} 持有，请先停止旧的开发进程`;
    }
  } catch {
    // The service can fail before creating a lock; the foreground logs carry that cause.
  }
  throw new Error(`KiteSync Node Service 未能在 127.0.0.1:${port} 就绪${lockHint}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  assertToolchain();

  const environment = { ...process.env };
  if (options.inspect) environment.KITESYNC_INSPECT = '1';
  const port = configuredDevelopmentPort(environment);
  // Vite and Node Service must use the same effective development port, including when
  // state.json was edited explicitly between runs.
  environment.KITESYNC_UI_PORT = String(port);
  child = spawn('bun', ['run', 'dev'], {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
    detached: !isWindows,
  });

  try {
    await waitForNodeService(port);
    console.log(`KiteSync Node Service 已就绪：http://127.0.0.1:${port}`);
  } catch (error) {
    if (receivedSignal) return;
    await stopDevelopmentGroup();
    throw error;
  }

  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    if (child!.exitCode !== null) {
      resolvePromise(child!.exitCode ?? 1);
      return;
    }
    child!.once('error', reject);
    child!.once('exit', (code, signal) => {
      if (receivedSignal || signal) resolvePromise(0);
      else resolvePromise(code ?? 1);
    });
  });
  process.exitCode = exitCode;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => forward(signal));
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

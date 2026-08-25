#!/usr/bin/env bun

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Options {
  dependencies: boolean;
  headless: boolean;
  help: boolean;
  inspect: boolean;
  keepDependencies: boolean;
}

interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Endpoint {
  label: string;
  url: string;
}

interface DevelopmentCredentials {
  displayName: string;
  password: string;
  username: string;
}

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const composeFile = resolve(repositoryRoot, 'deploy/compose/docker-compose.yml');
const composeArguments = ['compose', '-f', composeFile];
const isWindows = process.platform === 'win32';
const useColor = Boolean(process.stdout.isTTY && process.env.NO_COLOR === undefined);
const defaultDevelopmentCredentials: DevelopmentCredentials = {
  displayName: 'KiteSync 开发管理员',
  password: 'kitesync-development',
  username: 'admin',
};

const color = {
  blue: (value: string) => (useColor ? `\u001B[34m${value}\u001B[0m` : value),
  bold: (value: string) => (useColor ? `\u001B[1m${value}\u001B[0m` : value),
  green: (value: string) => (useColor ? `\u001B[32m${value}\u001B[0m` : value),
  yellow: (value: string) => (useColor ? `\u001B[33m${value}\u001B[0m` : value),
};

let activeProcess: ChildProcess | undefined;
let receivedSignal: NodeJS.Signals | undefined;

function printHelp() {
  console.log(`
${color.bold('KiteSync 本地开发调试启动器')}

用法：
  bun run run.ts [选项]
  bun run dev:all

选项：
  --headless   不启动 Electron，保留 Control Plane、Web 和 Desktop Runtime
  --inspect    为 Node.js 子进程开启随机端口 Inspector，并启用 source map
  --no-deps    不启动或检查 Docker Compose 依赖
  --keep-deps  退出时保留本次启动的 Compose 容器
  -h, --help   显示帮助

默认行为会启动 Compose 依赖和所有宿主机应用。按 Ctrl+C 后，启动器会停止
本次启动的进程并保留 named volumes；启动前已经运行的 Compose 容器不会被停止。
`);
}

function parseArguments(arguments_: string[]): Options {
  const options: Options = {
    dependencies: true,
    headless: false,
    help: false,
    inspect: false,
    keepDependencies: false,
  };

  for (const argument of arguments_) {
    switch (argument) {
      case '--headless':
        options.headless = true;
        break;
      case '--inspect':
        options.inspect = true;
        break;
      case '--no-deps':
        options.dependencies = false;
        break;
      case '--keep-deps':
        options.keepDependencies = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`未知参数：${argument}`);
    }
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

function commandOutput(command: string, arguments_: string[], label: string): string {
  const result = capture(command, arguments_);
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr.trim() || `退出码 ${result.status}`);
    throw new Error(`${label} 不可用：${detail}`);
  }
  return result.stdout.trim();
}

function assertMinimumVersion(label: string, actual: string, required: [number, number]) {
  const match = actual.match(/v?(\d+)\.(\d+)/);
  if (!match) throw new Error(`无法识别 ${label} 版本：${actual}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < required[0] || (major === required[0] && minor < required[1])) {
    throw new Error(`${label} 版本过低：需要 >= ${required.join('.')}，当前为 ${actual}`);
  }
}

function preflight(options: Options) {
  if (!existsSync(resolve(repositoryRoot, 'bun.lock'))) {
    throw new Error('缺少 bun.lock，请确认从仓库根目录运行');
  }
  if (!existsSync(resolve(repositoryRoot, 'node_modules/typescript'))) {
    throw new Error('依赖尚未安装，请先运行 bun run bootstrap');
  }

  const bunVersion = commandOutput('bun', ['--version'], 'Bun');
  const nodeVersion = commandOutput('node', ['--version'], 'Node.js');
  assertMinimumVersion('Bun', bunVersion, [1, 4]);
  assertMinimumVersion('Node.js', nodeVersion, [24, 0]);

  if (options.dependencies) {
    commandOutput('docker', ['compose', 'version', '--short'], 'Docker Compose');
    commandOutput('docker', ['info', '--format', '{{.ServerVersion}}'], 'Docker Desktop');
  }

  const credentials = developmentCredentials(process.env);
  if (credentials.username.length < 3) {
    throw new Error('KITESYNC_DEV_USERNAME 至少需要 3 个字符');
  }
  if (credentials.password.length < 12) {
    throw new Error('KITESYNC_DEV_PASSWORD 至少需要 12 个字符');
  }

  console.log(
    `${color.green('✓')} 环境检查通过（Bun ${bunVersion.replace(/^v/, '')}，Node.js ${nodeVersion.replace(/^v/, '')}）`,
  );
}

function developmentCredentials(environment: NodeJS.ProcessEnv): DevelopmentCredentials {
  return {
    displayName: environment.KITESYNC_DEV_DISPLAY_NAME ?? defaultDevelopmentCredentials.displayName,
    password: environment.KITESYNC_DEV_PASSWORD ?? defaultDevelopmentCredentials.password,
    username: environment.KITESYNC_DEV_USERNAME ?? defaultDevelopmentCredentials.username,
  };
}

function runningComposeServices(): string[] {
  const result = capture('docker', [
    ...composeArguments,
    'ps',
    '--services',
    '--status',
    'running',
  ]);
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (result.stderr.trim() || `退出码 ${result.status}`);
    throw new Error(`无法读取 Compose 状态：${detail}`);
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function signalExitCode(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 143;
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (isWindows) {
      const arguments_ = ['/PID', String(child.pid), '/T'];
      if (signal === 'SIGKILL') arguments_.push('/F');
      spawnSync('taskkill', arguments_, { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw error;
  }
}

function installSignalHandlers() {
  const handle = (signal: NodeJS.Signals) => {
    if (receivedSignal) {
      if (activeProcess) terminateProcessTree(activeProcess, 'SIGKILL');
      return;
    }
    receivedSignal = signal;
    console.log(`\n${color.yellow('正在停止开发环境…')}`);
    if (activeProcess) {
      const child = activeProcess;
      terminateProcessTree(child, signal);
      const forceTimer = setTimeout(() => terminateProcessTree(child, 'SIGKILL'), 5_000);
      forceTimer.unref();
    }
  };

  process.on('SIGINT', handle);
  process.on('SIGTERM', handle);
}

function runForeground(
  command: string,
  arguments_: string[],
  environment: NodeJS.ProcessEnv = process.env,
  onStart?: (child: ChildProcess) => void,
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryRoot,
      detached: !isWindows,
      env: environment,
      stdio: 'inherit',
    });
    activeProcess = child;
    onStart?.(child);

    child.once('error', (error) => {
      if (activeProcess === child) activeProcess = undefined;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (activeProcess === child) activeProcess = undefined;
      resolvePromise({ code, signal });
    });
  });
}

async function assertPortAvailable(port: number, label: string) {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`${label} 端口 ${port} 已被占用，请先停止旧的开发进程`));
      } else {
        reject(error);
      }
    });
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise()));
  });
}

async function assertApplicationPorts(options: Options) {
  const ports: Array<[number, string]> = [
    [Number(process.env.KITESYNC_PORT ?? '3000'), 'Control Plane'],
    [5173, 'Web'],
    [Number(process.env.KITESYNC_DESKTOP_RUNTIME_PORT ?? '3210'), 'Desktop Runtime'],
  ];
  if (!options.headless) ports.push([5174, 'Electron Renderer']);
  for (const [port, label] of ports) await assertPortAvailable(port, label);
}

function developmentEnvironment(options: Options): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  const credentials = developmentCredentials(environment);
  environment.VITE_KITESYNC_DEV_USERNAME = credentials.username;
  environment.VITE_KITESYNC_DEV_PASSWORD = credentials.password;
  if (options.inspect) {
    const inspectorOptions = '--enable-source-maps --inspect=127.0.0.1:0';
    environment.NODE_OPTIONS = [environment.NODE_OPTIONS, inspectorOptions]
      .filter(Boolean)
      .join(' ');
  }
  return environment;
}

function applicationArguments(options: Options): string[] {
  if (!options.headless) return ['run', '--no-orphans', 'dev'];
  return [
    'run',
    '--no-orphans',
    '--parallel',
    '--filter',
    '@kitesync/contracts',
    '--filter',
    '@kitesync/ui',
    '--filter',
    '@kitesync/api-client',
    '--filter',
    '@kitesync/control-plane',
    '--filter',
    '@kitesync/web',
    '--filter',
    '@kitesync/desktop-runtime',
    'dev',
  ];
}

function endpoints(options: Options): Endpoint[] {
  const controlPlanePort = Number(process.env.KITESYNC_PORT ?? '3000');
  const runtimePort = Number(process.env.KITESYNC_DESKTOP_RUNTIME_PORT ?? '3210');
  const result = [
    { label: 'Control Plane', url: `http://127.0.0.1:${controlPlanePort}/health/ready` },
    { label: 'Web', url: 'http://127.0.0.1:5173' },
    { label: 'Desktop Runtime', url: `http://127.0.0.1:${runtimePort}/health` },
  ];
  if (!options.headless) {
    result.push({ label: 'Electron Renderer', url: 'http://127.0.0.1:5174' });
  }
  return result;
}

async function waitForEndpoint(endpoint: Endpoint, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return true;
    } catch {
      // The watch processes start at different speeds; retry until the shared deadline.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  return false;
}

async function ensureDevelopmentAdministrator(
  controlPlaneUrl: string,
  environment: NodeJS.ProcessEnv,
): Promise<'created' | 'existing'> {
  const credentials = developmentCredentials(environment);
  const response = await fetch(new URL('/api/v1/auth/bootstrap', controlPlaneUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: environment.KITESYNC_BOOTSTRAP_TOKEN ?? 'development-bootstrap-token-change-me',
      username: credentials.username,
      displayName: credentials.displayName,
      password: credentials.password,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = (await response.json().catch(() => ({}))) as {
    code?: string;
    detail?: string;
    title?: string;
  };
  if (response.status === 201) return 'created';
  if (response.status === 409 && result.code === 'ALREADY_BOOTSTRAPPED') return 'existing';
  throw new Error(result.detail ?? result.title ?? `Control Plane 返回了 HTTP ${response.status}`);
}

async function reportReadiness(
  child: ChildProcess,
  options: Options,
  stopsDependencies: boolean,
  environment: NodeJS.ProcessEnv,
) {
  const results = await Promise.all(
    endpoints(options).map(async (endpoint) => ({
      endpoint,
      ready: await waitForEndpoint(endpoint, child),
    })),
  );
  if (child.exitCode !== null || child.signalCode !== null || receivedSignal) return;

  const ready = results.filter((result) => result.ready);
  const unavailable = results.filter((result) => !result.ready);
  const controlPlane = ready.find(({ endpoint }) => endpoint.label === 'Control Plane');
  if (controlPlane) {
    try {
      const status = await ensureDevelopmentAdministrator(controlPlane.endpoint.url, environment);
      const credentials = developmentCredentials(environment);
      console.log(
        status === 'created'
          ? `${color.green('✓')} 已创建开发管理员，桌面登录信息已自动填充（${credentials.username}）`
          : `${color.blue('开发管理员已存在且未被修改')}，桌面登录框已按开发配置填充（${credentials.username}）`,
      );
    } catch (error) {
      console.warn(
        color.yellow(
          `无法准备开发管理员：${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  if (ready.length > 0) {
    console.log(`\n${color.green('开发服务已就绪：')}`);
    for (const { endpoint } of ready) console.log(`  ${endpoint.label.padEnd(16)} ${endpoint.url}`);
    console.log(
      stopsDependencies
        ? '按 Ctrl+C 停止本次启动的应用和 Compose 容器（named volumes 会保留）。'
        : '按 Ctrl+C 停止宿主机应用；Compose 或外部依赖将继续运行。',
    );
    if (!options.headless) {
      console.log('开发登录框中的用户名和密码已由 run.ts 自动填充。');
    }
  }
  if (unavailable.length > 0) {
    console.warn(
      color.yellow(
        `60 秒内未就绪：${unavailable.map(({ endpoint }) => endpoint.label).join('、')}`,
      ),
    );
  }
}

async function stopOwnedDependencies() {
  console.log(color.blue('停止本次启动的 Compose 容器（保留 named volumes）…'));
  const result = await runForeground('bun', ['run', 'dev:stop']);
  if (result.code !== 0)
    console.warn(color.yellow('Compose 容器未能完全停止，请运行 bun run dev:stop'));
}

async function main(): Promise<number> {
  let options: Options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(color.yellow(error instanceof Error ? error.message : String(error)));
    printHelp();
    return 2;
  }

  if (options.help) {
    printHelp();
    return 0;
  }

  preflight(options);
  installSignalHandlers();

  let ownsDependencies = false;
  let exitCode = 0;
  try {
    if (options.dependencies) {
      const alreadyRunning = runningComposeServices();
      ownsDependencies = alreadyRunning.length === 0;
      if (alreadyRunning.length > 0) {
        console.log(color.blue(`复用已运行的 Compose 服务：${alreadyRunning.sort().join('、')}`));
      }

      const dependencies = await runForeground('bun', ['run', 'dev:deps']);
      if (dependencies.code !== 0) {
        throw new Error(
          `开发依赖启动失败（${dependencies.code ?? dependencies.signal ?? 'unknown'}）`,
        );
      }
    }

    if (receivedSignal) return signalExitCode(receivedSignal);
    await assertApplicationPorts(options);
    if (options.headless) {
      const prebuild = await runForeground('bun', ['run', 'predev']);
      if (prebuild.code !== 0) {
        throw new Error(`共享包预构建失败（${prebuild.code ?? prebuild.signal ?? 'unknown'}）`);
      }
    }

    if (receivedSignal) return signalExitCode(receivedSignal);
    console.log(
      color.blue(
        options.inspect
          ? '启动热重载应用；Node Inspector 将为各子进程选择空闲端口…'
          : '启动热重载应用…',
      ),
    );
    const environment = developmentEnvironment(options);
    const application = await runForeground(
      'bun',
      applicationArguments(options),
      environment,
      (child) =>
        void reportReadiness(
          child,
          options,
          ownsDependencies && !options.keepDependencies,
          environment,
        ),
    );
    exitCode = application.code ?? (application.signal ? signalExitCode(application.signal) : 1);
  } finally {
    if (ownsDependencies && !options.keepDependencies) await stopOwnedDependencies();
  }

  return receivedSignal ? signalExitCode(receivedSignal) : exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(color.yellow(error instanceof Error ? error.message : String(error)));
    process.exitCode = receivedSignal ? signalExitCode(receivedSignal) : 1;
  });

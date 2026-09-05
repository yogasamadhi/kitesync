#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { StringDecoder } from 'node:string_decoder';
import { loadConfig, type NodeConfig } from './config.js';
import { DirectoryBrowser } from './directory-browser.js';
import { DiagnosticLog } from './diagnostic-log.js';
import { FolderFiles } from './folder-files.js';
import { InstanceLock, readLockedPid } from './instance-lock.js';
import { SecretStore } from './secret-store.js';
import {
  applyAdminPassword,
  assertLanHasPassword,
  createServer,
  createServerRuntime,
} from './server.js';
import { StateStore } from './state-store.js';
import { LocalSyncthing } from './syncthing.js';

const HELP = `KiteSync 局域网文件同步节点

用法：kitesync <命令>

命令：
  open                         启动节点（如需要）并在浏览器中打开
  setup [--system]             交互式设置（--system 用于 Linux 常驻节点）
  password reset [--system]    在本机交互式重置管理员密码
  serve                        在前台运行节点服务
  identity                     输出本机 Syncthing 身份信息
  service install [--user|--system]   安装并启动平台自启动服务
  service remove [--user|--system]    停用并移除平台自启动服务
  service status [--user|--system]    查看平台自启动服务状态
  help                         显示本帮助
`;

function runtimePort(config: NodeConfig, store: StateStore) {
  return config.portOverride ?? store.snapshot().settings.uiPort;
}

export function listenHosts(config: NodeConfig, store: StateStore) {
  if (config.hostOverride) return [config.hostOverride];
  return store.snapshot().settings.lanAccessEnabled ? ['0.0.0.0', '::'] : ['127.0.0.1', '::1'];
}

function selfInvocation(config: NodeConfig, args: string[]) {
  return {
    file: process.execPath,
    args: config.compiled ? args : [import.meta.path, ...args],
  };
}

function spawnDetached(config: NodeConfig, args: string[]) {
  const invocation = selfInvocation(config, args);
  const child = spawn(invocation.file, invocation.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.once('error', () => undefined);
  child.unref();
}

function spawnManaged(config: NodeConfig, args: string[]) {
  const invocation = selfInvocation(config, args);
  const child = spawn(invocation.file, invocation.args, {
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
  child.once('error', () => undefined);
  return child;
}

async function stopManaged(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise())),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

export async function ensureSetupRuntime<T>(
  isHealthy: () => Promise<boolean>,
  lockedPid: () => Promise<number | undefined>,
  startTemporary: () => T,
  waitHealthy: () => Promise<void>,
) {
  if (await isHealthy()) return undefined;
  // A live lock means the supervised service is already starting. Spawning a temporary
  // `serve` here would only race for the same Syncthing home and can obscure its failure.
  const child = (await lockedPid()) ? undefined : startTemporary();
  await waitHealthy();
  return child;
}

export async function ensureOpenRuntime(
  isHealthy: () => Promise<boolean>,
  lockedPid: () => Promise<number | undefined>,
  start: () => Promise<void> | void,
  waitHealthy: () => Promise<void>,
) {
  if (await isHealthy()) return;
  const pid = await lockedPid();
  if (!pid) await start();
  try {
    await waitHealthy();
  } catch (error) {
    if (!pid) throw error;
    throw new Error(`KiteSync 进程 ${pid} 持有单实例锁，但管理服务未能就绪`, {
      cause: error,
    });
  }
}

function sameProof(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

async function healthy(port: number, secret: string) {
  try {
    const challenge = randomBytes(24).toString('base64url');
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { 'X-KiteSync-Health-Challenge': challenge },
      signal: AbortSignal.timeout(1_000),
    });
    const expected = createHmac('sha256', secret).update(challenge).digest('base64url');
    const proof = response.headers.get('x-kitesync-health-proof') ?? '';
    return (
      response.ok &&
      response.headers.get('x-kitesync-service') === 'node' &&
      sameProof(proof, expected)
    );
  } catch {
    return false;
  }
}

async function waitUntilHealthy(port: number, secret: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await healthy(port, secret)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`KiteSync 未能在端口 ${port} 启动；请运行“kitesync serve”查看具体错误`);
}

export async function runServe(config: NodeConfig) {
  const lock = await InstanceLock.acquire(config.lockPath);
  let syncthing: LocalSyncthing | undefined;

  try {
    const store = await StateStore.open(config.statePath, config.portOverride ?? 3210);
    const secrets = new SecretStore(config.stateDirectory);
    const diagnostics = new DiagnosticLog(join(config.stateDirectory, 'logs', 'node.log'));
    syncthing = new LocalSyncthing(config, (level, message) => diagnostics.write(level, message));
    const runtime = createServerRuntime();
    const directories = new DirectoryBrowser(config.directoryRoots);
    const files = new FolderFiles();
    diagnostics.write('info', `KiteSync ${config.version} 节点服务启动`);
    let stopping = false;
    let wake: ((reason: 'rebind' | 'stop') => void) | undefined;
    const stop = () => {
      stopping = true;
      wake?.('stop');
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    await applyAdminPassword(config, store);
    assertLanHasPassword(config, store);
    const openSecret = await secrets.openSecret();
    await syncthing.start();

    while (!stopping) {
      assertLanHasPassword(config, store);
      let requestRebind: () => void = () => {};
      const cycle = new Promise<'rebind' | 'stop'>((resolvePromise) => {
        wake = resolvePromise;
        requestRebind = () => resolvePromise('rebind');
      });
      const apps = [];
      const port = runtimePort(config, store);
      try {
        for (const host of listenHosts(config, store)) {
          const app = await createServer({
            config,
            store,
            syncthing,
            openSecret,
            runtime,
            directories,
            files,
            diagnostics,
            onRebindRequested: requestRebind,
          });
          try {
            await app.listen({ host, port, ...(host.includes(':') ? { ipv6Only: true } : {}) });
            apps.push(app);
          } catch (error) {
            await app.close().catch(() => undefined);
            const code = (error as NodeJS.ErrnoException).code;
            if (
              apps.length &&
              ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EADDRINUSE'].includes(code ?? '')
            ) {
              continue;
            }
            throw new Error(
              `无法监听 KiteSync 管理端口 ${host}:${port}${code ? `（${code}）` : ''}；请检查是否已有实例或设置 KITESYNC_UI_PORT`,
              { cause: error },
            );
          }
        }
        if (!apps.length) throw new Error('当前系统没有可用的 IP 监听地址');
        console.log(
          `KiteSync ${config.version} 正在监听 ${listenHosts(config, store).join('、')}:${port}`,
        );
        const reason = await cycle;
        await Promise.all(apps.map((app) => app.close()));
        if (reason === 'stop') break;
      } catch (error) {
        await Promise.all(apps.map((app) => app.close().catch(() => undefined)));
        throw error;
      }
    }
  } finally {
    await syncthing?.stop().catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
}

async function requestOpenToken(config: NodeConfig, store: StateStore, managed = false) {
  const port = runtimePort(config, store);
  const secret = await new SecretStore(config.stateDirectory).openSecret();
  await ensureOpenRuntime(
    () => healthy(port, secret),
    () => readLockedPid(config.lockPath),
    async () => {
      if (managed) throw new Error('KiteSync 后台服务尚未启动');
      const enabled = config.compiled
        ? process.platform === 'win32'
          ? await startInstalledWindowsTask(config)
          : process.platform === 'linux'
            ? await enableLinuxUserService(config, port)
            : false
        : false;
      if (!enabled) spawnDetached(config, ['serve']);
    },
    () => waitUntilHealthy(port, secret),
  );
  const response = await fetch(`http://127.0.0.1:${port}/internal/open-token`, {
    method: 'POST',
    headers: { 'X-KiteSync-Open-Secret': secret },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('无法从本机节点取得浏览器打开令牌');
  return (await response.json()) as { token: string };
}

function hiddenPassword(prompt: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error('交互式设置需要终端；无终端环境请配置 KITESYNC_ADMIN_PASSWORD_FILE');
  }
  return new Promise<string>((resolvePromise, reject) => {
    process.stdout.write(prompt);
    let value = '';
    const decoder = new StringDecoder('utf8');
    const finish = (error?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolvePromise(value);
    };
    const onData = (chunk: Buffer) => {
      for (const character of decoder.write(chunk)) {
        const code = character.codePointAt(0);
        if (code === 3) return finish(new Error('已取消设置'));
        if (code === 13 || code === 10) return finish();
        if (code === 8 || code === 127) {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function runInteractiveSetup(config: NodeConfig) {
  const store = await StateStore.open(config.statePath, config.portOverride ?? 3210);
  const port = runtimePort(config, store);
  const secret = await new SecretStore(config.stateDirectory).openSecret();
  let temporaryService: ChildProcess | undefined;
  try {
    temporaryService = await ensureSetupRuntime(
      () => healthy(port, secret),
      () => readLockedPid(config.lockPath),
      () => spawnManaged(config, ['serve']),
      () => waitUntilHealthy(port, secret),
    );
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      if (config.adminPasswordFile) {
        console.log('已从 KITESYNC_ADMIN_PASSWORD_FILE 初始化管理员密码');
        return;
      }
      throw new Error('无终端环境请通过 KITESYNC_ADMIN_PASSWORD_FILE 初始化管理员密码');
    }
    const base = `http://127.0.0.1:${port}`;
    const status = (await (await fetch(`${base}/api/v1/auth/status`)).json()) as {
      setupRequired: boolean;
    };
    const password = await hiddenPassword(
      status.setupRequired ? '设置管理员密码：' : '管理员密码：',
    );
    if (status.setupRequired) {
      const confirmation = await hiddenPassword('再次输入管理员密码：');
      if (password !== confirmation) throw new Error('两次输入的密码不一致');
    }
    const authentication = await fetch(
      `${base}/api/v1/auth/${status.setupRequired ? 'setup' : 'login'}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      },
    );
    if (!authentication.ok) {
      const problem = (await authentication.json().catch(() => undefined)) as
        { detail?: string } | undefined;
      throw new Error(problem?.detail ?? '管理员密码设置失败');
    }
    const session = (await authentication.json()) as { csrfToken: string };
    const cookie = authentication.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('节点没有返回管理会话');
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await terminal.question('允许局域网访问管理界面？[y/N] '))
        .trim()
        .toLowerCase();
      const lanAccessEnabled = answer === 'y' || answer === 'yes';
      const origins = lanAccessEnabled
        ? (await terminal.question('额外允许的 HTTPS 来源（逗号分隔，可留空）：'))
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      const response = await fetch(`${base}/api/v1/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': session.csrfToken,
        },
        body: JSON.stringify({ lanAccessEnabled, allowedOrigins: origins }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => undefined)) as
          { detail?: string } | undefined;
        throw new Error(problem?.detail ?? '节点网络设置失败');
      }
      console.log('KiteSync 设置完成');
    } finally {
      terminal.close();
    }
  } finally {
    await stopManaged(temporaryService);
  }
}

async function runPasswordReset(config: NodeConfig) {
  const password = await hiddenPassword('输入新管理员密码：');
  if (password.length < 12 || password.length > 256) {
    throw new Error('管理员密码必须为 12 到 256 个字符');
  }
  const confirmation = await hiddenPassword('再次输入新管理员密码：');
  if (password !== confirmation) throw new Error('两次输入的密码不一致');
  const store = await StateStore.open(config.statePath, config.portOverride ?? 3210);
  const port = runtimePort(config, store);
  const secret = await new SecretStore(config.stateDirectory).openSecret();
  if (await healthy(port, secret)) {
    const response = await fetch(`http://127.0.0.1:${port}/internal/password-reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-KiteSync-Open-Secret': secret,
      },
      body: JSON.stringify({ newPassword: password }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const problem = (await response.json().catch(() => undefined)) as
        { detail?: string } | undefined;
      throw new Error(problem?.detail ?? '运行中的节点拒绝密码重置');
    }
    console.log('管理员密码已重置，全部旧会话已撤销');
    return;
  }
  if (await readLockedPid(config.lockPath)) {
    throw new Error('节点正在启动但内部接口尚未就绪，请稍后重试');
  }
  const lock = await InstanceLock.acquire(config.lockPath);
  try {
    const hash = await Bun.password.hash(password, {
      algorithm: 'argon2id',
      memoryCost: 65_536,
      timeCost: 3,
    });
    await store.update((draft) => {
      draft.passwordHash = hash;
    });
  } finally {
    await lock.release();
  }
  console.log('管理员密码已重置；节点身份、配对和同步目录保持不变');
}

async function runOpen(config: NodeConfig, managed = false) {
  const store = await StateStore.open(config.statePath, config.portOverride ?? 3210);
  const { token } = await requestOpenToken(config, store, managed);
  const url = `http://127.0.0.1:${runtimePort(config, store)}/#token=${encodeURIComponent(token)}`;
  const opener =
    process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] };
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

async function runIdentity(config: NodeConfig) {
  let lock: InstanceLock | undefined;
  try {
    lock = await InstanceLock.acquire(config.lockPath);
  } catch (error) {
    if (!(await readLockedPid(config.lockPath))) throw error;
  }
  const syncthing = new LocalSyncthing(config);
  try {
    const identity = await identityFromSyncthing(syncthing, Boolean(lock));
    console.log(
      JSON.stringify(
        {
          deviceId: identity.deviceId,
          fingerprint: identity.deviceId.replaceAll('-', '').slice(0, 12),
          name: identity.nodeName,
          syncthingVersion: identity.syncthingVersion,
          listenAddresses: identity.listenAddresses,
          localDiscoveryEnabled: identity.localDiscoveryEnabled,
        },
        null,
        2,
      ),
    );
  } finally {
    if (lock) {
      await syncthing.stop().catch(() => undefined);
      await lock.release();
    }
  }
}

export async function identityFromSyncthing(
  syncthing: Pick<LocalSyncthing, 'start' | 'identity' | 'identityOfRunningInstance'>,
  mayStart: boolean,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
) {
  if (mayStart) {
    await syncthing.start();
    return syncthing.identity();
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return await syncthing.identityOfRunningInstance();
    } catch {
      await sleep(250);
    }
  }
  throw new Error('已有 KiteSync 节点持有锁，但 Syncthing 未在限时内就绪');
}

function command(file: string, args: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolvePromise, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const output: Buffer[] = [];
    child.stdout.on('data', (value: Buffer) => output.push(value));
    child.stderr.on('data', (value: Buffer) => output.push(value));
    child.once('error', reject);
    child.once('exit', (code) =>
      resolvePromise({ code, output: Buffer.concat(output).toString('utf8').trim() }),
    );
  });
}

async function tcpPortOccupied(port: number) {
  return new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once('error', () => resolvePromise(false));
  });
}

type CommandRunner = typeof command;

export async function startInstalledWindowsTask(
  config: Pick<NodeConfig, 'compiled'> & { executablePath?: string },
  execute: CommandRunner = command,
) {
  if (!config.compiled) return false;
  const executablePath = config.executablePath ?? process.execPath;
  const script = join(dirname(executablePath), 'service-task.ps1');
  if (!existsSync(script)) {
    throw new Error(`找不到 Windows 后台服务脚本：${script}`);
  }
  const result = await execute('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-StartIfInstalled',
  ]);
  if (result.code !== 0) {
    throw new Error(result.output || 'Windows 后台服务启动失败');
  }
  if (result.output === 'started') return true;
  if (result.output === 'not-installed') return false;
  throw new Error(`Windows 后台服务返回了未知状态：${result.output || '空响应'}`);
}

async function systemctl(scope: 'user' | 'system', args: string[]) {
  return command('systemctl', [...(scope === 'user' ? ['--user'] : []), ...args]);
}

type SystemctlRunner = typeof systemctl;

function systemServiceMarkerPath() {
  return process.env.KITESYNC_SYSTEM_SERVICE_MARKER ?? '/etc/kitesync/system-service-enabled';
}

export async function setSystemServiceMarker(path: string, enabled: boolean) {
  if (!enabled) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o644);
  try {
    await handle.writeFile(`${new Date().toISOString()}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function findEnabledLinuxUserService(
  execute: CommandRunner = command,
  pathExists: (path: string) => boolean = existsSync,
) {
  const candidates = new Set(['/etc/systemd/user/default.target.wants/kitesync.service']);
  const passwd = await execute('getent', ['passwd']).catch(() => ({ code: 1, output: '' }));
  if (passwd.code === 0) {
    for (const line of passwd.output.split('\n')) {
      const home = line.split(':')[5];
      if (!home || !isAbsolute(home)) continue;
      candidates.add(join(home, '.config/systemd/user/default.target.wants/kitesync.service'));
    }
  }
  return [...candidates].find(pathExists);
}

export async function enableLinuxUserService(
  config: Pick<NodeConfig, 'syncthingGuiPort'>,
  port: number,
  execute: SystemctlRunner = systemctl,
  portOccupied: (port: number) => Promise<boolean> = tcpPortOccupied,
  systemMarkerPresent: () => boolean = () => existsSync(systemServiceMarkerPath()),
) {
  if (systemMarkerPresent()) {
    throw new Error('检测到系统级 KiteSync 服务标记，拒绝再启动用户级实例');
  }
  const [systemActive, systemEnabled] = await Promise.all([
    execute('system', ['is-active', 'kitesync.service']).catch(() => ({ code: 1, output: '' })),
    execute('system', ['is-enabled', 'kitesync.service']).catch(() => ({ code: 1, output: '' })),
  ]);
  if (systemActive.code === 0 || systemEnabled.code === 0) {
    throw new Error('检测到系统级 KiteSync 服务，拒绝再启动用户级实例');
  }
  const loadState = await execute('user', [
    'show',
    'kitesync.service',
    '--property=LoadState',
    '--value',
  ]).catch((error: unknown) => ({
    code: 1,
    output: error instanceof Error ? error.message : String(error),
  }));
  if (loadState.code !== 0) {
    if (
      /failed to connect to bus|not been booted with systemd|no medium found/i.test(
        loadState.output,
      )
    ) {
      return false;
    }
    throw new Error(loadState.output || '无法查询用户级 KiteSync systemd unit');
  }
  if (loadState.output.trim() === 'not-found') return false;
  if (loadState.output.trim() !== 'loaded') {
    throw new Error(`KiteSync systemd unit 状态异常：${loadState.output || '空响应'}`);
  }
  if ((await portOccupied(port)) || (await portOccupied(config.syncthingGuiPort))) {
    throw new Error(`端口 ${port} 或 ${config.syncthingGuiPort} 已被其他程序占用`);
  }
  const result = await execute('user', ['enable', '--now', 'kitesync.service']);
  if (result.code !== 0) throw new Error(result.output || '用户级 KiteSync 服务启动失败');
  return true;
}

async function runService(config: NodeConfig, args: string[]) {
  const action = args[0];
  if (!['install', 'remove', 'status'].includes(action ?? '')) {
    throw new Error('用法：kitesync service <install|remove|status> [--user|--system]');
  }

  if (process.platform === 'win32') {
    if (args.slice(1).length) throw new Error('Windows 不支持 --user 或 --system 参数');
    const script = join(dirname(process.execPath), 'service-task.ps1');
    if (!existsSync(script)) throw new Error(`找不到后台服务脚本：${script}`);
    const scriptArgs = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      ...(action === 'install'
        ? ['-Executable', process.execPath]
        : action === 'remove'
          ? ['-Remove']
          : ['-Status']),
    ];
    const result = await command('powershell.exe', scriptArgs);
    if (result.code !== 0) throw new Error(result.output || 'Windows 后台服务操作失败');
    console.log(
      action === 'install'
        ? 'KiteSync 登录自启动任务已启用'
        : action === 'remove'
          ? 'KiteSync 登录自启动任务已移除'
          : result.output,
    );
    return;
  }

  if (process.platform === 'darwin') {
    if (args.slice(1).length) throw new Error('macOS 不支持 --user 或 --system 参数');
    const launcher = resolve(dirname(process.execPath), '..', 'MacOS', 'KiteSync');
    if (!existsSync(launcher)) throw new Error(`找不到 KiteSync 应用启动器：${launcher}`);
    const flag = `--service-${action}`;
    const result = await command(launcher, [flag]);
    if (result.code !== 0) throw new Error(result.output || 'macOS 后台服务操作失败');
    console.log(result.output);
    return;
  }

  if (process.platform !== 'linux') {
    throw new Error(`当前平台不支持后台服务管理：${process.platform}`);
  }

  const scope: 'user' | 'system' = args.includes('--system') ? 'system' : 'user';
  if (args.slice(1).some((value) => value !== '--user' && value !== '--system')) {
    throw new Error('用法：kitesync service <install|remove|status> [--user|--system]');
  }
  if (args.includes('--user') && args.includes('--system')) {
    throw new Error('--user 与 --system 不能同时使用');
  }
  if (action === 'status') {
    const [active, enabled] = await Promise.all([
      systemctl(scope, ['is-active', 'kitesync.service']),
      systemctl(scope, ['is-enabled', 'kitesync.service']),
    ]);
    console.log(
      `${scope === 'user' ? '用户级' : '系统级'} KiteSync 服务：${enabled.code === 0 ? '已启用' : '未启用'}，${active.code === 0 ? '正在运行' : '未运行'}`,
    );
    return;
  }

  const other: 'user' | 'system' = scope === 'user' ? 'system' : 'user';
  if (action === 'install') {
    if (scope === 'user' && existsSync(systemServiceMarkerPath())) {
      throw new Error('检测到系统级 KiteSync 服务标记；请先执行 service remove --system');
    }
    if (scope === 'system') {
      const userService = await findEnabledLinuxUserService();
      if (userService) {
        throw new Error(`检测到已启用的用户级 KiteSync unit：${userService}`);
      }
    }
    const port = await configuredUiPort(config);
    const [active, enabled] = await Promise.all([
      systemctl(other, ['is-active', 'kitesync.service']),
      systemctl(other, ['is-enabled', 'kitesync.service']),
    ]);
    if (active.code === 0 || enabled.code === 0) {
      throw new Error(
        `检测到 ${other === 'user' ? '用户级' : '系统级'} KiteSync unit；请先停用，避免两个实例冲突`,
      );
    }
    const occupied = await Promise.all([
      tcpPortOccupied(port),
      tcpPortOccupied(config.syncthingGuiPort),
    ]);
    if (occupied.some(Boolean)) {
      throw new Error(
        `端口 ${port} 或 ${config.syncthingGuiPort} 已被占用，拒绝启用第二个服务实例`,
      );
    }
  }
  const result = await systemctl(scope, [
    action === 'install' ? 'enable' : 'disable',
    '--now',
    'kitesync.service',
  ]);
  if (result.code !== 0) throw new Error(result.output || 'systemctl 执行失败');
  if (scope === 'system') {
    await setSystemServiceMarker(systemServiceMarkerPath(), action === 'install');
  }
  console.log(action === 'install' ? 'KiteSync systemd 服务已启用' : 'KiteSync systemd 服务已停用');
}

async function configuredUiPort(config: NodeConfig) {
  if (config.portOverride !== undefined) return config.portOverride;
  try {
    const state = JSON.parse(await readFile(config.statePath, 'utf8')) as {
      settings?: { uiPort?: unknown };
    };
    const port = state.settings?.uiPort;
    return Number.isInteger(port) && Number(port) >= 1 && Number(port) <= 65_535
      ? Number(port)
      : 3210;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 3210;
    throw new Error(
      `无法读取已有节点端口配置：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function main(argv = process.argv.slice(2)) {
  const action = argv[0] ?? 'open';
  if (action === 'help' || action === '--help' || action === '-h') {
    process.stdout.write(HELP);
    return;
  }
  if (action === 'version' || action === '--version' || action === '-v') {
    process.stdout.write(`${loadConfig().version}\n`);
    return;
  }
  const systemScope =
    process.platform === 'linux' &&
    ((action === 'service' && argv.includes('--system')) ||
      (action === 'setup' && argv[1] === '--system') ||
      (action === 'password' && argv[1] === 'reset' && argv[2] === '--system'));
  if (systemScope && !process.env.KITESYNC_STATE_DIR) {
    process.env.KITESYNC_STATE_DIR = '/var/lib/kitesync';
  }
  const config = loadConfig();
  if (action === 'serve') return runServe(config);
  if (action === 'open') {
    if (argv.slice(1).some((value) => value !== '--managed') || argv.slice(1).length > 1) {
      throw new Error('用法：kitesync open');
    }
    if (argv.includes('--managed') && !(process.platform === 'darwin' && config.compiled)) {
      throw new Error('--managed 仅供 macOS 应用启动器使用');
    }
    return runOpen(config, argv.includes('--managed'));
  }
  if (action === 'setup') {
    if (argv.slice(1).some((value) => value !== '--system') || argv.slice(1).length > 1) {
      throw new Error('用法：kitesync setup [--system]');
    }
    if (argv.includes('--system') && process.platform !== 'linux') {
      throw new Error('--system 仅用于 Linux 常驻节点');
    }
    if (argv.includes('--system') && process.getuid?.() === 0) {
      throw new Error('请以服务用户运行：sudo -u kitesync kitesync setup --system');
    }
    return process.platform === 'linux' || config.headless
      ? runInteractiveSetup(config)
      : runOpen(config);
  }
  if (action === 'identity') return runIdentity(config);
  if (action === 'password') {
    if (
      argv[1] !== 'reset' ||
      argv.slice(2).some((value) => value !== '--system') ||
      argv.slice(2).length > 1
    ) {
      throw new Error('用法：kitesync password reset [--system]');
    }
    if (argv.includes('--system') && process.platform !== 'linux') {
      throw new Error('--system 仅用于 Linux 常驻节点');
    }
    if (argv.includes('--system') && process.getuid?.() === 0) {
      throw new Error('请以服务用户运行：sudo -u kitesync kitesync password reset --system');
    }
    return runPasswordReset(config);
  }
  if (action === 'service') return runService(config, argv.slice(1));
  throw new Error(`未知命令：${action}\n\n${HELP}`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

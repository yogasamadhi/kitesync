import { execFileSync, fork, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ElectronCredentialVault } from './credential-vault.js';

export class RuntimeSupervisor {
  private child: ChildProcess | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private restartAttempts = 0;
  private stopping = false;

  constructor(
    private readonly entry: string,
    private readonly tokenFile: string,
    private readonly vault: ElectronCredentialVault,
    private readonly environment: Record<string, string>,
  ) {}

  start() {
    this.stopping = false;
    this.launch();
  }

  private launch() {
    if (this.child || this.stopping) return;
    this.child = fork(this.entry, [], {
      env: { ...process.env, ...this.environment, KITESYNC_RUNTIME_TOKEN_FILE: this.tokenFile },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    this.child.stdout?.on('data', (data: Buffer) => process.stdout.write(data));
    this.child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
    this.child.once('exit', (code, signal) => {
      this.child = undefined;
      if (this.stopping) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.restartAttempts++, 5));
      console.error(
        `Local Runtime exited (${code ?? signal ?? 'unknown'}); restarting in ${delay}ms`,
      );
      this.restartTimer = setTimeout(() => this.launch(), delay);
      this.restartTimer.unref();
    });
    this.child.on('message', (message: unknown) => {
      const request = message as {
        kind?: string;
        requestId?: string;
        action?: 'get' | 'set' | 'delete';
        key?: string;
        value?: string;
      };
      if (request.kind !== 'vault:request' || !request.requestId || !request.key) return;
      try {
        const value = request.action === 'get' ? this.vault.get(request.key) : undefined;
        if (request.action === 'set' && request.value !== undefined)
          this.vault.set(request.key, request.value);
        if (request.action === 'delete') this.vault.delete(request.key);
        this.child?.send({ kind: 'vault:response', requestId: request.requestId, value });
      } catch (error) {
        this.child?.send({
          kind: 'vault:response',
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

export class SyncthingSupervisor {
  private child: ChildProcess | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private restartAttempts = 0;
  private stopping = false;

  constructor(
    private readonly executable: string,
    private readonly home: string,
    private readonly apiKey: string,
    private readonly apiKeyFile: string,
  ) {}

  start() {
    this.stopping = false;
    this.launch();
  }

  private launch() {
    if (this.child || this.stopping) return;
    if (!existsSync(this.executable))
      throw new Error(`Pinned Syncthing executable is missing: ${this.executable}`);
    mkdirSync(this.home, { recursive: true });
    writeFileSync(this.apiKeyFile, this.apiKey, { mode: 0o600 });
    const configPath = join(this.home, 'config.xml');
    if (!existsSync(configPath))
      execFileSync(this.executable, ['generate', `--home=${this.home}`], { stdio: 'ignore' });
    let config = readFileSync(configPath, 'utf8');
    config = config
      .replace(/<address>[^<]*<\/address>/, '<address>127.0.0.1:8385</address>')
      .replace(/<apikey>[^<]*<\/apikey>/, `<apikey>${this.apiKey}</apikey>`)
      .replace(
        /<globalAnnounceEnabled>true<\/globalAnnounceEnabled>/g,
        '<globalAnnounceEnabled>false</globalAnnounceEnabled>',
      )
      .replace(
        /<localAnnounceEnabled>true<\/localAnnounceEnabled>/g,
        '<localAnnounceEnabled>false</localAnnounceEnabled>',
      )
      .replace(/<relaysEnabled>true<\/relaysEnabled>/g, '<relaysEnabled>false</relaysEnabled>')
      .replace(/<natEnabled>true<\/natEnabled>/g, '<natEnabled>false</natEnabled>')
      .replace(/<listenAddress>[^<]*<\/listenAddress>/g, '')
      .replace('</options>', '<listenAddress>tcp://127.0.0.1:22000</listenAddress></options>');
    writeFileSync(configPath, config, { mode: 0o600 });
    this.child = spawn(
      this.executable,
      ['serve', `--home=${this.home}`, '--no-browser', '--no-restart', '--no-upgrade'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child.stdout?.on('data', (data: Buffer) => process.stdout.write(data));
    this.child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));
    this.child.once('exit', (code, signal) => {
      this.child = undefined;
      if (this.stopping) return;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.restartAttempts++, 5));
      console.error(`Syncthing exited (${code ?? signal ?? 'unknown'}); restarting in ${delay}ms`);
      this.restartTimer = setTimeout(() => this.launch(), delay);
      this.restartTimer.unref();
    });
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
}

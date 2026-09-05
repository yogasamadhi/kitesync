import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';

class CommandError extends Error {
  constructor(
    readonly exitCode: number | null,
    message: string,
  ) {
    super(message);
  }
}

const windowsDpapiPrelude =
  '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);' +
  'Add-Type -AssemblyName System.Security;';

function run(file: string, args: string[], input?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (value: Buffer) => stdout.push(value));
    child.stderr.on('data', (value: Buffer) => stderr.push(value));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8').trim());
      else
        reject(
          new CommandError(
            code,
            Buffer.concat(stderr).toString('utf8').trim() || `${file} 退出 ${code}`,
          ),
        );
    });
    child.stdin.end(input);
  });
}

export async function createSecretFile(path: string, value: string) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${value}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  let created = false;
  try {
    // A hard link publishes the fully written inode and, unlike rename, never replaces a
    // winner created by another concurrently opened KiteSync process.
    await link(temporary, path);
    created = true;
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return created;
}

export class SecretStore {
  private readonly account: string;
  private openSecretPromise: Promise<string> | undefined;

  constructor(private readonly stateDirectory: string) {
    this.account = createHash('sha256').update(stateDirectory).digest('hex').slice(0, 24);
  }

  async openSecret() {
    this.openSecretPromise ??= this.loadOrCreate();
    return this.openSecretPromise;
  }

  private async loadOrCreate() {
    let existing: string | undefined;
    try {
      existing = await this.read();
    } catch (error) {
      const missing =
        (error as NodeJS.ErrnoException).code === 'ENOENT' ||
        (process.platform === 'darwin' && error instanceof CommandError && error.exitCode === 44);
      if (!missing) throw error;
    }
    if (existing) return existing;
    const secret = randomBytes(32).toString('base64url');
    await this.write(secret);
    return this.read();
  }

  private async read() {
    if (process.platform === 'darwin') {
      const helper = this.keychainHelper();
      if (helper) return run(helper, ['--keychain-read', this.account]);
      return run('security', [
        'find-generic-password',
        '-s',
        'com.kitesync.node.open-secret',
        '-a',
        this.account,
        '-w',
      ]);
    }
    if (process.platform === 'win32') {
      const encrypted = await readFile(join(this.stateDirectory, 'open-secret.dpapi'), 'utf8');
      const script =
        windowsDpapiPrelude +
        '$v=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($v.Trim());' +
        '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);' +
        '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))';
      return run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        encrypted,
      );
    }
    return (await readFile(join(this.stateDirectory, 'open-secret'), 'utf8')).trim();
  }

  private async write(secret: string) {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    if (process.platform === 'darwin') {
      const helper = this.keychainHelper();
      if (helper) {
        await run(helper, ['--keychain-write', this.account], secret);
      } else {
        // Source checkouts do not contain the signed app launcher. The security CLI only
        // accepts non-interactive writes when the value is an argument; production packages
        // always use the Security.framework helper above so the secret never enters argv.
        try {
          await run('security', [
            'add-generic-password',
            '-s',
            'com.kitesync.node.open-secret',
            '-a',
            this.account,
            '-w',
            secret,
          ]);
        } catch (error) {
          // A simultaneous process may have won creation. Only suppress the error when the
          // winner can actually be read back.
          if (!(await this.read().catch(() => ''))) throw error;
        }
      }
      return;
    }
    if (process.platform === 'win32') {
      const script =
        windowsDpapiPrelude +
        '$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);' +
        '$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);' +
        '[Console]::Out.Write([Convert]::ToBase64String($p))';
      const encrypted = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        secret,
      );
      await createSecretFile(join(this.stateDirectory, 'open-secret.dpapi'), encrypted);
      return;
    }
    await createSecretFile(join(this.stateDirectory, 'open-secret'), secret);
  }

  private keychainHelper() {
    const path = resolve(dirname(process.execPath), '..', 'MacOS', 'KiteSync');
    return existsSync(path) ? path : undefined;
  }
}

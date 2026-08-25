import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CredentialVault {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class FileCredentialVault implements CredentialVault {
  constructor(private readonly path: string) {}

  private async load(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  async get(key: string) {
    return (await this.load())[key];
  }

  async set(key: string, value: string) {
    const values = await this.load();
    values[key] = value;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(values), { mode: 0o600 });
  }

  async delete(key: string) {
    const values = await this.load();
    delete values[key];
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(values), { mode: 0o600 });
  }
}

export class IpcCredentialVault implements CredentialVault {
  private readonly pending = new Map<
    string,
    { resolve: (value: string | undefined) => void; reject: (error: Error) => void }
  >();

  constructor() {
    process.on('message', (message: unknown) => {
      const response = message as {
        kind?: string;
        requestId?: string;
        value?: string;
        error?: string;
      };
      if (response.kind !== 'vault:response' || !response.requestId) return;
      const pending = this.pending.get(response.requestId);
      if (!pending) return;
      this.pending.delete(response.requestId);
      if (response.error) pending.reject(new Error(response.error));
      else pending.resolve(response.value);
    });
  }

  get(key: string) {
    return this.call('get', key);
  }
  async set(key: string, value: string) {
    await this.call('set', key, value);
  }
  async delete(key: string) {
    await this.call('delete', key);
  }

  private call(action: 'get' | 'set' | 'delete', key: string, value?: string) {
    const requestId = crypto.randomUUID();
    return new Promise<string | undefined>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      process.send?.({ kind: 'vault:request', requestId, action, key, value });
      setTimeout(() => {
        if (this.pending.delete(requestId)) reject(new Error('Credential host timed out'));
      }, 10_000).unref();
    });
  }
}

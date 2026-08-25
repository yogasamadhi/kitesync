import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { safeStorage } from 'electron';

export class ElectronCredentialVault {
  constructor(private readonly path: string) {}

  private load(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>;
  }

  get(key: string) {
    const encrypted = this.load()[key];
    if (!encrypted) return undefined;
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  }

  set(key: string, value: string) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('System credential encryption is unavailable');
    const values = this.load();
    values[key] = safeStorage.encryptString(value).toString('base64');
    writeFileSync(this.path, JSON.stringify(values), { mode: 0o600 });
  }

  delete(key: string) {
    const values = this.load();
    delete values[key];
    writeFileSync(this.path, JSON.stringify(values), { mode: 0o600 });
  }
}

import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import type { NodeSettings } from '@kitesync/contracts';

export type StoredNodeSettings = Omit<NodeSettings, 'nodeName'>;

export interface NodeState {
  version: 1;
  passwordHash?: string;
  settings: StoredNodeSettings;
}

function defaultState(port: number): NodeState {
  return {
    version: 1,
    settings: {
      lanAccessEnabled: false,
      allowedOrigins: [],
      trustedProxies: [],
      versioningDays: 30,
      uiPort: port,
    },
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isTrustedProxy(value: string) {
  const candidate = value.trim().toLowerCase();
  if (candidate === 'loopback') return true;
  const parts = candidate.split('/');
  if (parts.length > 2) return false;
  const address = parts[0] ?? '';
  const version = isIP(address);
  if (!version) return false;
  if (parts.length === 1) return true;
  const prefix = Number(parts[1]);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= (version === 4 ? 32 : 128);
}

function parseState(value: unknown): NodeState {
  if (!value || typeof value !== 'object') throw new Error('state.json 不是对象');
  const state = value as Partial<NodeState>;
  const settings = state.settings as Partial<StoredNodeSettings> | undefined;
  if (
    state.version !== 1 ||
    (state.passwordHash !== undefined && typeof state.passwordHash !== 'string') ||
    !settings ||
    typeof settings.lanAccessEnabled !== 'boolean' ||
    !isStringArray(settings.allowedOrigins) ||
    !isStringArray(settings.trustedProxies) ||
    !Number.isInteger(settings.versioningDays) ||
    (settings.versioningDays as number) < 0 ||
    (settings.versioningDays as number) > 3_650 ||
    !Number.isInteger(settings.uiPort) ||
    (settings.uiPort as number) < 1 ||
    (settings.uiPort as number) > 65_535 ||
    settings.allowedOrigins.some((origin) => {
      try {
        const parsed = new URL(origin);
        return parsed.protocol !== 'https:' || parsed.origin !== origin;
      } catch {
        return true;
      }
    }) ||
    settings.trustedProxies.some((proxy) => !isTrustedProxy(proxy))
  ) {
    throw new Error('state.json 的格式或版本无效');
  }
  return {
    version: 1,
    ...(state.passwordHash === undefined ? {} : { passwordHash: state.passwordHash }),
    settings: {
      lanAccessEnabled: settings.lanAccessEnabled,
      allowedOrigins: [...settings.allowedOrigins],
      trustedProxies: [...settings.trustedProxies],
      versioningDays: settings.versioningDays,
      uiPort: settings.uiPort,
    } as StoredNodeSettings,
  };
}

export class StateStore {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private state: NodeState,
  ) {}

  static async open(path: string, defaultPort = 3210) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const state = parseState(JSON.parse(await readFile(path, 'utf8')) as unknown);
      return new StateStore(path, state);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const store = new StateStore(path, defaultState(defaultPort));
      await store.persist();
      return store;
    }
  }

  snapshot(): NodeState {
    return structuredClone(this.state);
  }

  async update(mutator: (draft: NodeState) => void | Promise<void>) {
    let result: NodeState | undefined;
    const operation = this.writeQueue.then(async () => {
      const draft = structuredClone(this.state);
      await mutator(draft);
      const persisted = await this.persistValue(draft);
      this.state = persisted;
      result = this.snapshot();
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return result as NodeState;
  }

  private persist() {
    return this.persistValue(this.state);
  }

  private async persistValue(value: NodeState) {
    const validated = parseState(value);
    const temporary = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    const bytes = `${JSON.stringify(validated, null, 2)}\n`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(bytes, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
      if (process.platform !== 'win32') {
        const directory = await open(dirname(this.path), 'r');
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
    return validated;
  }
}

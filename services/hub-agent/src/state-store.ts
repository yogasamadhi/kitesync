import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HubDesiredState } from '@kitesync/contracts';

const EMPTY_STATE: HubDesiredState = { revision: 0, devices: [], folders: [] };

export class StateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<HubDesiredState> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as HubDesiredState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_STATE;
      throw error;
    }
  }

  async save(state: HubDesiredState) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = this.path + '.tmp';
    await writeFile(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporaryPath, this.path);
  }
}

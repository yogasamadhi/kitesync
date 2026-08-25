import type { HubDesiredState, HubOperation } from '@kitesync/contracts';
import { randomUUID } from 'node:crypto';
import type { StateStore } from './state-store.js';
import type { SyncthingClient, SyncthingDevice, SyncthingFolder } from './syncthing-client.js';

export class HubReconciler {
  private readonly operations = new Map<string, HubOperation>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly syncthing: SyncthingClient,
    private readonly store: StateStore,
  ) {}

  async submit(desired: HubDesiredState): Promise<HubOperation> {
    const current = await this.store.load();
    if (desired.revision < current.revision) {
      throw new Error('Desired revision is older than the applied revision');
    }
    if (desired.revision === current.revision) {
      return {
        id: randomUUID(),
        revision: desired.revision,
        state: 'succeeded',
        error: null,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    const operation: HubOperation = {
      id: randomUUID(),
      revision: desired.revision,
      state: 'queued',
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    this.operations.set(operation.id, operation);
    this.queue = this.queue.then(() => this.apply(operation.id, desired));
    return operation;
  }

  getOperation(id: string) {
    return this.operations.get(id);
  }

  private async apply(operationId: string, desired: HubDesiredState) {
    const operation = this.operations.get(operationId);
    if (!operation) return;
    operation.state = 'running';
    try {
      await this.syncthing.configureLanOnly();
      const [currentDevices, currentFolders] = await Promise.all([
        this.syncthing.devices(),
        this.syncthing.folders(),
      ]);

      const desiredDeviceIds = new Set(desired.devices.map((item) => item.id));
      const desiredFolderIds = new Set(desired.folders.map((item) => item.id));

      // Devices must exist before a folder can reference them.
      for (const device of desired.devices) {
        const config: SyncthingDevice = {
          deviceID: device.id,
          name: device.name,
          addresses: device.addresses,
          paused: device.paused,
          group: 'KiteSync',
          autoAcceptFolders: false,
        };
        await this.syncthing.upsertDevice(config);
      }

      for (const folder of desired.folders) {
        const config: SyncthingFolder = {
          id: folder.id,
          label: folder.label,
          path: folder.path,
          type: 'sendreceive',
          paused: folder.paused,
          group: 'KiteSync',
          devices: folder.deviceIds.map((deviceID) => ({ deviceID })),
          minDiskFree: { value: 5, unit: '%' },
          versioning: {
            type: 'staggered',
            params: { maxAge: String(folder.versionMaxAgeDays * 86_400) },
            cleanupIntervalS: 3_600,
          },
        };
        await this.syncthing.upsertFolder(config);
      }

      for (const folder of currentFolders) {
        if (folder.group === 'KiteSync' && !desiredFolderIds.has(folder.id)) {
          await this.syncthing.deleteFolder(folder.id);
        }
      }
      for (const device of currentDevices) {
        if (device.group === 'KiteSync' && !desiredDeviceIds.has(device.deviceID)) {
          await this.syncthing.deleteDevice(device.deviceID);
        }
      }

      await this.store.save(desired);
      operation.state = 'succeeded';
    } catch (error) {
      operation.state = 'failed';
      operation.error = error instanceof Error ? error.message : String(error);
    } finally {
      operation.completedAt = new Date().toISOString();
    }
  }
}

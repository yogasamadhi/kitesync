import { readFile } from 'node:fs/promises';
import type { RuntimeConfig } from './config.js';

export class LocalSyncthing {
  constructor(private readonly config: RuntimeConfig) {}

  private async request<T>(path: string, init: RequestInit = {}) {
    const apiKey = (await readFile(this.config.syncthingApiKeyFile, 'utf8')).trim();
    const response = await fetch(this.config.syncthingUrl + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, ...init.headers },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Local Syncthing request failed with ${response.status}`);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  status() {
    return this.request<{ myID: string }>('/rest/system/status');
  }

  async configureHub(hub: { syncthingDeviceId: string; addresses: string[] }) {
    await this.request('/rest/config/options', {
      method: 'PATCH',
      body: JSON.stringify({
        globalAnnounceEnabled: false,
        localAnnounceEnabled: false,
        relaysEnabled: false,
        natEnabled: false,
        announceLANAddresses: false,
        listenAddresses: ['tcp://127.0.0.1:22000'],
        stunKeepaliveStartS: 0,
        urAccepted: -1,
        crashReportingEnabled: false,
        upgradeAllowedManual: false,
        upgradeAllowedAuto: false,
      }),
    });
    const configured = await this.request<Array<{ deviceID: string }>>('/rest/config/devices');
    for (const device of configured) {
      if (device.deviceID !== hub.syncthingDeviceId) {
        await this.request(`/rest/config/devices/${encodeURIComponent(device.deviceID)}`, {
          method: 'DELETE',
        });
      }
    }
    await this.request(`/rest/config/devices/${encodeURIComponent(hub.syncthingDeviceId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        deviceID: hub.syncthingDeviceId,
        name: 'KiteSync Hub',
        addresses: hub.addresses,
        paused: false,
        autoAcceptFolders: false,
      }),
    });
  }

  configureFolder(input: {
    id: string;
    label: string;
    path: string;
    hubDeviceId: string;
    paused?: boolean;
  }) {
    return this.request(`/rest/config/folders/${encodeURIComponent(input.id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: input.id,
        label: input.label,
        path: input.path,
        type: 'sendreceive',
        paused: input.paused ?? false,
        devices: [{ deviceID: input.hubDeviceId }],
        versioning: { type: '' },
      }),
    });
  }

  removeFolder(id: string) {
    return this.request(`/rest/config/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
  setFolderPaused(id: string, paused: boolean) {
    return this.request(`/rest/config/folders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ paused }),
    });
  }
  folderStatus(id: string) {
    return this.request<Record<string, unknown>>(
      `/rest/db/status?folder=${encodeURIComponent(id)}`,
    );
  }
}

export interface SyncthingSystemStatus {
  myID: string;
  uptime: number;
}

export interface SyncthingVersion {
  version: string;
}

export interface SyncthingDevice {
  deviceID: string;
  name: string;
  addresses: string[];
  paused: boolean;
  group?: string;
  autoAcceptFolders?: boolean;
}

export interface SyncthingFolder {
  id: string;
  label: string;
  path: string;
  type: string;
  paused: boolean;
  devices: Array<{ deviceID: string }>;
  group?: string;
  versioning?: {
    type: string;
    params: Record<string, string>;
    cleanupIntervalS?: number;
  };
  minDiskFree?: { value: number; unit: string };
}

export interface SyncthingFolderStatus {
  state: string;
  localBytes: number;
  globalBytes: number;
  needBytes: number;
}

export interface SyncthingConnectionStatus {
  connections: Record<string, { connected: boolean }>;
}

export class SyncthingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey,
        ...init?.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error('Syncthing request ' + path + ' failed with status ' + response.status);
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  status() {
    return this.request<SyncthingSystemStatus>('/rest/system/status');
  }

  version() {
    return this.request<SyncthingVersion>('/rest/system/version');
  }

  connections() {
    return this.request<SyncthingConnectionStatus>('/rest/system/connections');
  }

  devices() {
    return this.request<SyncthingDevice[]>('/rest/config/devices');
  }

  folders() {
    return this.request<SyncthingFolder[]>('/rest/config/folders');
  }

  folderStatus(folderId: string) {
    return this.request<SyncthingFolderStatus>(
      '/rest/db/status?folder=' + encodeURIComponent(folderId),
    );
  }

  upsertDevice(device: SyncthingDevice) {
    return this.request<void>('/rest/config/devices', {
      method: 'POST',
      body: JSON.stringify(device),
    });
  }

  deleteDevice(deviceId: string) {
    return this.request<void>('/rest/config/devices/' + encodeURIComponent(deviceId), {
      method: 'DELETE',
    });
  }

  upsertFolder(folder: SyncthingFolder) {
    return this.request<void>('/rest/config/folders', {
      method: 'POST',
      body: JSON.stringify(folder),
    });
  }

  deleteFolder(folderId: string) {
    return this.request<void>('/rest/config/folders/' + encodeURIComponent(folderId), {
      method: 'DELETE',
    });
  }

  configureLanOnly() {
    return this.request<void>('/rest/config/options', {
      method: 'PATCH',
      body: JSON.stringify({
        globalAnnounceEnabled: false,
        globalAnnounceServers: [],
        localAnnounceEnabled: false,
        relaysEnabled: false,
        natEnabled: false,
        stunServers: [],
        crashReportingEnabled: false,
        urAccepted: -1,
        startBrowser: false,
        releasesURL: '',
        upgradeAllowedManual: false,
        upgradeAllowedAuto: false,
        listenAddresses: ['tcp://0.0.0.0:22000', 'quic://0.0.0.0:22000'],
      }),
    });
  }

  versions(folderId: string) {
    return this.request<
      Record<string, Array<{ versionTime: string; modTime: string; size: number }>>
    >('/rest/folder/versions?folder=' + encodeURIComponent(folderId));
  }

  restore(folderId: string, files: Record<string, string>) {
    return this.request<void>('/rest/folder/versions?folder=' + encodeURIComponent(folderId), {
      method: 'POST',
      body: JSON.stringify(files),
    });
  }

  events(since: number, timeoutSeconds: number, signal?: AbortSignal) {
    return fetch(
      this.baseUrl + '/rest/events?since=' + since + '&timeout=' + timeoutSeconds + '&limit=100',
      {
        headers: { 'X-API-Key': this.apiKey },
        ...(signal ? { signal } : {}),
      },
    ).then(async (response) => {
      if (!response.ok) throw new Error('Syncthing events failed with ' + response.status);
      return (await response.json()) as Array<{
        id: number;
        globalID: number;
        time: string;
        type: string;
        data: Record<string, unknown>;
      }>;
    });
  }
}

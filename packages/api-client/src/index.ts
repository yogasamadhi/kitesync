import type {
  Device,
  DeviceSpaceBinding,
  RuntimeMetadata,
  SyncSpace,
  User,
} from '@kitesync/contracts';

export class KiteSyncApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly credential: () => string | undefined,
  ) {}

  async request<T>(path: string, init: RequestInit = {}) {
    const token = this.credential();
    const response = await fetch(this.baseUrl.replace(/\/$/, '') + path, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Object.assign(
        new Error((body as { title?: string }).title ?? 'KiteSync request failed'),
        { status: response.status, problem: body },
      );
    return body as T;
  }

  runtime = () => this.request<RuntimeMetadata>('/api/v1/runtime');
  users = () => this.request<{ items: User[] }>('/api/v1/users');
  devices = () => this.request<{ items: Device[] }>('/api/v1/devices');
  spaces = () => this.request<{ items: SyncSpace[] }>('/api/v1/sync-spaces');
  offers = () => this.request<{ items: SyncSpace[] }>('/api/v1/offers');
  bindings = (deviceId: string) =>
    this.request<{ items: DeviceSpaceBinding[] }>(
      `/api/v1/device-bindings?deviceId=${encodeURIComponent(deviceId)}`,
    );
}

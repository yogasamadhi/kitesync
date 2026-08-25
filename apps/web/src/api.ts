import type { Device, RuntimeMetadata, SyncSpace, User } from '@kitesync/contracts';

export interface Session {
  user: User;
  csrfToken: string;
  expiresAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  current: boolean;
  expiresAt: string;
  lastUsedAt: string;
  createdAt: string;
}

let csrfToken = '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken
        ? { 'X-CSRF-Token': csrfToken }
        : {}),
      ...init.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof body.code === 'string' ? body.code : 'REQUEST_FAILED',
      typeof body.title === 'string' ? body.title : '请求失败',
    );
  }
  return body as T;
}

function rememberSession(session: Session) {
  csrfToken = session.csrfToken;
  return session;
}

export const api = {
  runtime: () => request<RuntimeMetadata>('/api/v1/runtime'),
  session: () => request<Session>('/api/v1/auth/session').then(rememberSession),
  login: (username: string, password: string) =>
    request<Session>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }).then(rememberSession),
  bootstrap: (input: { token: string; username: string; displayName: string; password: string }) =>
    request<Session>('/api/v1/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then(rememberSession),
  acceptInvitation: (token: string, password: string) =>
    request<Session>('/api/v1/user-invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }).then(rememberSession),
  resetPassword: (token: string, password: string) =>
    request<{ message: string }>('/api/v1/password-resets', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),
  logout: () => request<{ message: string }>('/api/v1/auth/logout', { method: 'POST' }),
  users: () => request<{ items: User[] }>('/api/v1/users'),
  createUser: (input: { username: string; displayName: string; password: string }) =>
    request<User>('/api/v1/users', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(input),
    }),
  createInvitation: (input: { username: string; displayName: string; role: 'admin' | 'member' }) =>
    request<{ id: string; username: string; token: string; expiresAt: string }>(
      '/api/v1/user-invitations',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(input),
      },
    ),
  issuePasswordReset: (userId: string) =>
    request<{ token: string; expiresAt: string }>(`/api/v1/users/${userId}/password-reset-token`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    }),
  sessions: () => request<{ items: SessionRecord[] }>('/api/v1/sessions'),
  revokeSession: (sessionId: string) =>
    request<{ message: string }>(`/api/v1/sessions/${sessionId}`, { method: 'DELETE' }),
  devices: () => request<{ items: Device[] }>('/api/v1/devices'),
  approveDevice: (device: Device) =>
    request(`/api/v1/devices/${device.id}/approve`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': crypto.randomUUID(),
        'If-Match': `"${device.revision}"`,
      },
    }),
  suspendDevice: (device: Device) =>
    request(`/api/v1/devices/${device.id}/suspend`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': crypto.randomUUID(),
        'If-Match': `"${device.revision}"`,
      },
    }),
  resumeDevice: (device: Device) =>
    request(`/api/v1/devices/${device.id}/resume`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': crypto.randomUUID(),
        'If-Match': `"${device.revision}"`,
      },
    }),
  revokeDevice: (device: Device) =>
    request(`/api/v1/devices/${device.id}`, {
      method: 'DELETE',
      headers: {
        'Idempotency-Key': crypto.randomUUID(),
        'If-Match': `"${device.revision}"`,
      },
    }),
  spaces: () => request<{ items: SyncSpace[] }>('/api/v1/sync-spaces'),
  createSpace: (label: string, quotaBytes: number) =>
    request('/api/v1/sync-spaces', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ label, quotaBytes }),
    }),
  deleteSpace: (space: SyncSpace) =>
    request(`/api/v1/sync-spaces/${space.id}`, {
      method: 'DELETE',
      headers: {
        'Idempotency-Key': crypto.randomUUID(),
        'If-Match': `"${space.revision}"`,
      },
    }),
  restoreSpace: (space: SyncSpace) =>
    request(`/api/v1/sync-spaces/${space.id}/restore`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': crypto.randomUUID(),
        'If-Match': `"${space.revision}"`,
      },
    }),
  updateSpaceQuota: (space: SyncSpace, quotaBytes: number) =>
    request(`/api/v1/sync-spaces/${space.id}/quota`, {
      method: 'PATCH',
      headers: { 'If-Match': `"${space.revision}"` },
      body: JSON.stringify({ quotaBytes }),
    }),
  spaceShares: (spaceId: string) =>
    request<{
      items: Array<{
        id: string;
        syncSpaceId: string;
        userId: string;
        state: 'invited' | 'accepted' | 'revoked';
        createdAt: string;
      }>;
    }>(`/api/v1/sync-spaces/${spaceId}/shares`),
  shareSpace: (space: SyncSpace, userId: string) =>
    request(`/api/v1/sync-spaces/${space.id}/shares`, {
      method: 'POST',
      headers: {
        'Idempotency-Key': crypto.randomUUID(),
        'If-Match': `"${space.revision}"`,
      },
      body: JSON.stringify({ userId }),
    }),
  removeSpaceShare: (space: SyncSpace, shareId: string) =>
    request(`/api/v1/sync-spaces/${space.id}/shares/${shareId}`, {
      method: 'DELETE',
      headers: {
        'Idempotency-Key': crypto.randomUUID(),
        'If-Match': `"${space.revision}"`,
      },
    }),
  versions: (spaceId: string) =>
    request<{
      items: Array<{ path: string; versionTime: string; modifiedAt: string; sizeBytes: number }>;
    }>(`/api/v1/sync-spaces/${spaceId}/versions`),
  restoreVersion: (spaceId: string, version: { path: string; versionTime: string }) =>
    request(`/api/v1/sync-spaces/${spaceId}/restore-operations`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ files: [version] }),
    }),
  hubs: () => request<{ items: Array<Record<string, any>> }>('/api/v1/hubs'),
  auditEvents: () =>
    request<{ items: Array<Record<string, any>>; page: { nextCursor: string | null } }>(
      '/api/v1/audit-events?limit=50',
    ),
  backupRuns: () => request<{ items: Array<Record<string, any>> }>('/api/v1/backup-runs'),
  updateReleases: () => request<{ items: Array<Record<string, any>> }>('/api/v1/update-releases'),
};

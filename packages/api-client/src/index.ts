import type {
  AcceptPendingDeviceRequest,
  AcceptPendingFolderRequest,
  AuthStatus,
  AuthSession,
  ChangePasswordRequest,
  CreateDeviceRequest,
  CreateFolderRequest,
  Device,
  DeviceList,
  DirectoryList,
  DirectoryQuery,
  DirectoryRoot,
  DirectoryRootList,
  DiscoveredDeviceList,
  Folder,
  FolderFileList,
  FolderConflictList,
  FolderErrorList,
  FolderFilesQuery,
  FolderIgnoreList,
  FolderList,
  Health,
  LoginRequest,
  MessageResponse,
  DiagnosticLogList,
  DiagnosticSummary,
  NodeInfo,
  NodeSettings,
  OpenTokenLoginRequest,
  PendingDeviceList,
  PendingFolderList,
  ProblemDetails,
  RevealFileRequest,
  RestoreVersionsRequest,
  SetupRequest,
  UpdateDeviceRequest,
  UpdateFolderRequest,
  UpdateFolderIgnoresRequest,
  UpdateNodeSettings,
  VersionList,
  VersionListQuery,
} from '@kitesync/contracts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problem?: ProblemDetails,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class KiteSyncApiClient {
  private csrfToken: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly unauthorizedHandlers = new Set<() => void>();
  private settingsEtag: string | undefined;

  constructor(
    private readonly baseUrl = '',
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  private rememberSession(session: AuthSession) {
    this.csrfToken = session.csrfToken;
    return session;
  }

  /**
   * Subscribe to loss of an authenticated server-side session. This is intentionally
   * process-local: the HttpOnly cookie remains owned by the browser and the CSRF token
   * is forgotten as soon as a protected request is rejected.
   */
  onUnauthorized(handler: () => void) {
    this.unauthorizedHandlers.add(handler);
    return () => this.unauthorizedHandlers.delete(handler);
  }

  clearSession() {
    this.csrfToken = undefined;
  }

  private async errorFor(response: Response) {
    const problem = (await response.json().catch(() => undefined)) as ProblemDetails | undefined;
    return new ApiError(
      problem?.detail ?? problem?.title ?? `KiteSync 请求失败（${response.status}）`,
      response.status,
      problem,
    );
  }

  private async raw(path: string, init: RequestInit = {}) {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && this.csrfToken) {
      headers.set('X-CSRF-Token', this.csrfToken);
    }

    const response = await this.fetchImpl(this.url(path), {
      ...init,
      credentials: 'include',
      headers,
    });
    if (response.status === 401 && !isCredentialExchange(path)) {
      this.clearSession();
      for (const handler of this.unauthorizedHandlers) {
        try {
          handler();
        } catch {
          // A UI observer must not change the HTTP error reported to the caller.
        }
      }
    }
    if (!response.ok) throw await this.errorFor(response);
    return response;
  }

  private async request<T>(path: string, init: RequestInit = {}) {
    const response = await this.raw(path, init);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private json(method: string, body?: unknown): RequestInit {
    return {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
  }

  setup = (input: SetupRequest) =>
    this.request<AuthSession>('/api/v1/auth/setup', this.json('POST', input)).then((session) =>
      this.rememberSession(session),
    );

  authStatus = () => this.request<AuthStatus>('/api/v1/auth/status');

  login = (input: LoginRequest) =>
    this.request<AuthSession>('/api/v1/auth/login', this.json('POST', input)).then((session) =>
      this.rememberSession(session),
    );

  loginWithOpenToken = (input: OpenTokenLoginRequest) =>
    this.request<AuthSession>('/api/v1/auth/open-token', this.json('POST', input)).then((session) =>
      this.rememberSession(session),
    );

  logout = async () => {
    try {
      return await this.request<MessageResponse>('/api/v1/auth/logout', this.json('POST'));
    } finally {
      this.clearSession();
    }
  };

  changePassword = (input: ChangePasswordRequest) =>
    this.request<MessageResponse>('/api/v1/auth/password', this.json('POST', input));

  session = () =>
    this.request<AuthSession>('/api/v1/auth/session').then((session) =>
      this.rememberSession(session),
    );

  health = () => this.request<Health>('/api/v1/health');

  node = () => this.request<NodeInfo>('/api/v1/node');

  settings = async () => {
    const response = await this.raw('/api/v1/settings');
    this.settingsEtag = response.headers.get('etag') ?? undefined;
    return (await response.json()) as NodeSettings;
  };

  updateSettings = async (input: UpdateNodeSettings) => {
    const init = this.json('PATCH', input);
    if (this.settingsEtag) init.headers = { 'If-Match': this.settingsEtag };
    const response = await this.raw('/api/v1/settings', init);
    this.settingsEtag = response.headers.get('etag') ?? undefined;
    return (await response.json()) as NodeSettings;
  };

  devices = () => this.request<DeviceList>('/api/v1/devices');

  createDevice = (input: CreateDeviceRequest) =>
    this.request<Device>('/api/v1/devices', this.json('POST', input));

  updateDevice = (id: string, input: UpdateDeviceRequest) =>
    this.request<Device>(`/api/v1/devices/${encodeURIComponent(id)}`, this.json('PATCH', input));

  discoveredDevices = () => this.request<DiscoveredDeviceList>('/api/v1/devices/discovered');

  pendingDevices = () => this.request<PendingDeviceList>('/api/v1/devices/pending');

  acceptPendingDevice = (id: string, input: AcceptPendingDeviceRequest = {}) =>
    this.request<Device>(
      `/api/v1/devices/pending/${encodeURIComponent(id)}/accept`,
      this.json('POST', input),
    );

  rejectPendingDevice = (id: string) =>
    this.request<MessageResponse>(
      `/api/v1/devices/pending/${encodeURIComponent(id)}/reject`,
      this.json('POST'),
    );

  removeDevice = (id: string) =>
    this.request<MessageResponse>(`/api/v1/devices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

  unignoreDevice = (id: string) =>
    this.request<MessageResponse>(`/api/v1/devices/ignored/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

  folders = () => this.request<FolderList>('/api/v1/folders');

  createFolder = (input: CreateFolderRequest) =>
    this.request<Folder>('/api/v1/folders', this.json('POST', input));

  pendingFolders = () => this.request<PendingFolderList>('/api/v1/folders/pending');

  acceptPendingFolder = (deviceId: string, folderId: string, input: AcceptPendingFolderRequest) =>
    this.request<Folder>(
      `/api/v1/folders/pending/${encodeURIComponent(deviceId)}/${encodeURIComponent(folderId)}/accept`,
      this.json('POST', input),
    );

  rejectPendingFolder = (deviceId: string, folderId: string) =>
    this.request<MessageResponse>(
      `/api/v1/folders/pending/${encodeURIComponent(deviceId)}/${encodeURIComponent(folderId)}/reject`,
      this.json('POST'),
    );

  unignoreFolder = (deviceId: string, folderId: string) =>
    this.request<MessageResponse>(
      `/api/v1/folders/ignored/${encodeURIComponent(deviceId)}/${encodeURIComponent(folderId)}`,
      { method: 'DELETE' },
    );

  updateFolder = (id: string, input: UpdateFolderRequest) =>
    this.request<Folder>(`/api/v1/folders/${encodeURIComponent(id)}`, this.json('PATCH', input));

  removeFolder = (id: string) =>
    this.request<MessageResponse>(`/api/v1/folders/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

  pauseFolder = (id: string) =>
    this.request<Folder>(`/api/v1/folders/${encodeURIComponent(id)}/pause`, this.json('POST'));

  resumeFolder = (id: string) =>
    this.request<Folder>(`/api/v1/folders/${encodeURIComponent(id)}/resume`, this.json('POST'));

  scanFolder = (id: string) =>
    this.request<MessageResponse>(
      `/api/v1/folders/${encodeURIComponent(id)}/scan`,
      this.json('POST'),
    );

  repairFolderMarker = (id: string) =>
    this.request<Folder>(
      `/api/v1/folders/${encodeURIComponent(id)}/repair-marker`,
      this.json('POST'),
    );

  folderVersions = (id: string, options: VersionListQuery = {}) => {
    const query = new URLSearchParams();
    if (options.search) query.set('search', options.search);
    if (options.path) query.set('path', options.path);
    query.set('limit', String(options.limit ?? 50));
    if (options.cursor) query.set('cursor', options.cursor);
    return this.request<VersionList>(
      `/api/v1/folders/${encodeURIComponent(id)}/versions?${query.toString()}`,
    );
  };

  restoreFolderVersion = (id: string, input: RestoreVersionsRequest) =>
    this.request<MessageResponse>(
      `/api/v1/folders/${encodeURIComponent(id)}/restore`,
      this.json('POST', input),
    );

  folderFiles = (id: string, path = '', options: Omit<FolderFilesQuery, 'path'> = {}) => {
    const query = new URLSearchParams({ path, limit: String(options.limit ?? 100) });
    if (options.cursor) query.set('cursor', options.cursor);
    return this.request<FolderFileList>(
      `/api/v1/folders/${encodeURIComponent(id)}/files?${query.toString()}`,
    );
  };

  folderDownloadUrl = (id: string, path: string) =>
    this.url(`/api/v1/folders/${encodeURIComponent(id)}/download?path=${encodeURIComponent(path)}`);

  downloadFolderFile = (id: string, path: string) =>
    this.raw(
      `/api/v1/folders/${encodeURIComponent(id)}/download?path=${encodeURIComponent(path)}`,
      { headers: { Accept: 'application/octet-stream' } },
    );

  headFolderDownload = (id: string, path: string) =>
    this.raw(
      `/api/v1/folders/${encodeURIComponent(id)}/download?path=${encodeURIComponent(path)}`,
      { method: 'HEAD', headers: { Accept: 'application/octet-stream' } },
    );

  revealFolderFile = (id: string, input: RevealFileRequest) =>
    this.request<MessageResponse>(
      `/api/v1/folders/${encodeURIComponent(id)}/reveal`,
      this.json('POST', input),
    );

  folderIgnores = (id: string) =>
    this.request<FolderIgnoreList>(`/api/v1/folders/${encodeURIComponent(id)}/ignores`);

  updateFolderIgnores = (id: string, input: UpdateFolderIgnoresRequest) =>
    this.request<FolderIgnoreList>(
      `/api/v1/folders/${encodeURIComponent(id)}/ignores`,
      this.json('PUT', input),
    );

  folderErrors = (id: string, options: { limit?: number; cursor?: string } = {}) => {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.cursor) query.set('cursor', options.cursor);
    return this.request<FolderErrorList>(
      `/api/v1/folders/${encodeURIComponent(id)}/errors?${query.toString()}`,
    );
  };

  folderConflicts = (id: string, options: { limit?: number; cursor?: string } = {}) => {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.cursor) query.set('cursor', options.cursor);
    return this.request<FolderConflictList>(
      `/api/v1/folders/${encodeURIComponent(id)}/conflicts?${query.toString()}`,
    );
  };

  overrideFolder = (id: string) =>
    this.request<MessageResponse>(
      `/api/v1/folders/${encodeURIComponent(id)}/override`,
      this.json('POST'),
    );

  revertFolder = (id: string) =>
    this.request<MessageResponse>(
      `/api/v1/folders/${encodeURIComponent(id)}/revert`,
      this.json('POST'),
    );

  diagnosticLogs = (options: { limit?: number; cursor?: string } = {}) => {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.cursor) query.set('cursor', options.cursor);
    return this.request<DiagnosticLogList>(`/api/v1/diagnostics/logs?${query.toString()}`);
  };

  diagnosticSummary = () => this.request<DiagnosticSummary>('/api/v1/diagnostics/summary');

  diagnosticExportUrl = () => this.url('/api/v1/diagnostics/export');

  directoryRoots = () => this.request<DirectoryRootList>('/api/v1/directory-roots');

  pickDirectory = () =>
    this.request<DirectoryRoot | undefined>('/api/v1/directories/select', this.json('POST'));

  directories = (parentId: string, options: Omit<DirectoryQuery, 'parentId'> = {}) => {
    const query = new URLSearchParams({ parentId, limit: String(options.limit ?? 100) });
    if (options.cursor) query.set('cursor', options.cursor);
    return this.request<DirectoryList>(`/api/v1/directories?${query.toString()}`);
  };
}

function isCredentialExchange(path: string) {
  const pathname = path.split('?', 1)[0] ?? path;
  return CREDENTIAL_EXCHANGE_PATHS.has(pathname);
}

const CREDENTIAL_EXCHANGE_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/setup',
  '/api/v1/auth/open-token',
]);

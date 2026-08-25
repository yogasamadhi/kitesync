export class ControlPlaneClient {
  private accessToken: string | undefined;
  private refreshHandler: (() => Promise<string | undefined>) | undefined;
  private refreshPromise: Promise<string | undefined> | undefined;

  constructor(private serverUrl: string) {}

  setServerUrl(url: string) {
    this.serverUrl = url.replace(/\/$/, '');
  }
  setAccessToken(token: string | undefined) {
    this.accessToken = token;
  }
  setRefreshHandler(handler: () => Promise<string | undefined>) {
    this.refreshHandler = handler;
  }

  async request<T>(path: string, init: RequestInit = {}, allowRefresh = true): Promise<T> {
    const response = await fetch(this.serverUrl + path, {
      ...init,
      headers: {
        Accept: 'application/json',
        'X-KiteSync-Client-Version': '1.0.0',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (
      response.status === 401 &&
      allowRefresh &&
      this.refreshHandler &&
      path !== '/api/v1/auth/desktop/refresh'
    ) {
      this.refreshPromise ??= this.refreshHandler().finally(() => {
        this.refreshPromise = undefined;
      });
      const accessToken = await this.refreshPromise;
      if (accessToken) {
        this.accessToken = accessToken;
        return this.request<T>(path, init, false);
      }
    }
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok)
      throw new Error(
        typeof result.title === 'string'
          ? result.title
          : `Control Plane returned ${response.status}`,
      );
    return result as T;
  }
}

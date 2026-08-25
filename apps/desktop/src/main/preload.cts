import electron = require('electron');

const { contextBridge, ipcRenderer } = electron;

const runtimeConnection = ipcRenderer.invoke('host:runtime-connection') as Promise<{
  url: string;
  token: string;
}>;

async function runtimeRequest(path: string, init?: { method?: string; body?: unknown }) {
  const connection = await runtimeConnection;
  const response = await fetch(connection.url + path, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${connection.token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      (result as { title?: string }).title ?? `Local Runtime returned ${response.status}`,
    );
  return result;
}

contextBridge.exposeInMainWorld('kitesync', {
  request: runtimeRequest,
  chooseDirectory: () => ipcRenderer.invoke('host:choose-directory'),
  openGrant: (grantId: string) => ipcRenderer.invoke('host:open-grant', grantId),
  revokeGrant: (grantId: string) => ipcRenderer.invoke('host:revoke-grant', grantId),
  exportDiagnostics: () => ipcRenderer.invoke('host:export-diagnostics'),
  getAutoStart: () => ipcRenderer.invoke('host:get-auto-start'),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke('host:set-auto-start', enabled),
  platform: process.platform,
});

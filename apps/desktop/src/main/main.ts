import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { ElectronCredentialVault } from './credential-vault.js';
import { RuntimeSupervisor, SyncthingSupervisor } from './supervisors.js';
import { startUpdater } from './updater.js';

let window: BrowserWindow | undefined;
let quitting = false;
let runtimeSupervisor: RuntimeSupervisor | undefined;
let syncthingSupervisor: SyncthingSupervisor | undefined;
let credentialVault: ElectronCredentialVault | undefined;
const grants = new Map<string, string>();
let runtimeEventTimer: NodeJS.Timeout | undefined;
let runtimeEventCursor = 0;
const runtimeToken = app.isPackaged
  ? randomBytes(32).toString('base64url')
  : (process.env.KITESYNC_RUNTIME_TOKEN ?? 'development-runtime-token');
const rendererToken = app.isPackaged
  ? randomBytes(32).toString('base64url')
  : (process.env.KITESYNC_RENDERER_RUNTIME_TOKEN ?? 'development-renderer-runtime-token');
const runtimeUrl = 'http://127.0.0.1:3210';

async function runtimeRequest(path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(runtimeUrl + path, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${runtimeToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      (result as { title?: string }).title ?? `Local Runtime returned ${response.status}`,
    );
  return result;
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f2f5f8',
    webPreferences: {
      preload: join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (app.isPackaged) await window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  else await window.loadURL('http://127.0.0.1:5174');
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
}

function revokeHostGrant(grantId: string) {
  grants.delete(grantId);
  credentialVault?.delete(`directory-grant:${grantId}`);
  credentialVault?.set('directory-grant-index', JSON.stringify([...grants.keys()]));
}

function startRuntimeEventBridge() {
  let active = true;
  const poll = async () => {
    try {
      const result = (await runtimeRequest(`/api/v1/events?cursor=${runtimeEventCursor}`)) as {
        items: Array<{ cursor: number; type: string; payload: { grantId?: string } }>;
      };
      for (const event of result.items) {
        runtimeEventCursor = Math.max(runtimeEventCursor, event.cursor);
        if (event.type === 'directory-binding.removed-by-server' && event.payload.grantId)
          revokeHostGrant(event.payload.grantId);
      }
    } catch {
      // Runtime restarts are supervised; the next poll resumes from the durable cursor.
    } finally {
      if (active) {
        runtimeEventTimer = setTimeout(poll, 5_000);
        runtimeEventTimer.unref();
      }
    }
  };
  void poll();
  return () => {
    active = false;
    if (runtimeEventTimer) clearTimeout(runtimeEventTimer);
    runtimeEventTimer = undefined;
  };
}

app.setName('KiteSync');
console.info('KiteSync Electron host waiting for app readiness');

async function startApplication() {
  console.info('KiteSync Electron host is ready');
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  const developmentState = resolve(import.meta.dirname, '../../../../.kitesync-dev');
  const stateRoot = app.isPackaged ? userData : developmentState;
  mkdirSync(stateRoot, { recursive: true });
  const tokenFile = join(stateRoot, 'runtime-token');
  const rendererTokenFile = join(stateRoot, 'renderer-token');
  const apiKeyFile = join(stateRoot, 'syncthing-api-key');
  writeFileSync(tokenFile, runtimeToken, { mode: 0o600 });
  writeFileSync(rendererTokenFile, rendererToken, { mode: 0o600 });
  const syncthingApiKey = randomBytes(32).toString('base64url');
  if (app.isPackaged) {
    credentialVault = new ElectronCredentialVault(join(userData, 'credentials.enc.json'));
    const grantIds = JSON.parse(credentialVault.get('directory-grant-index') ?? '[]') as string[];
    for (const grantId of grantIds) {
      const path = credentialVault.get(`directory-grant:${grantId}`);
      if (path) grants.set(grantId, path);
    }
  }
  const syncthingExecutable = app.isPackaged
    ? join(
        process.resourcesPath,
        'syncthing',
        process.platform === 'win32' ? 'syncthing.exe' : 'syncthing',
      )
    : resolve(
        '../../vendor/syncthing/bin',
        `${process.platform}-${process.arch}`,
        process.platform === 'win32' ? 'syncthing.exe' : 'syncthing',
      );
  if (existsSync(syncthingExecutable)) {
    console.info('Starting verified Syncthing sidecar');
    syncthingSupervisor = new SyncthingSupervisor(
      syncthingExecutable,
      join(stateRoot, 'syncthing'),
      syncthingApiKey,
      apiKeyFile,
    );
    syncthingSupervisor.start();
  } else {
    console.error('Verified Syncthing sidecar is missing');
  }
  if (app.isPackaged) {
    runtimeSupervisor = new RuntimeSupervisor(
      join(process.resourcesPath, 'runtime', 'main.js'),
      tokenFile,
      credentialVault!,
      {
        KITESYNC_DESKTOP_DATABASE: join(userData, 'runtime.sqlite'),
        KITESYNC_LOCAL_SYNCTHING_API_KEY_FILE: apiKeyFile,
        KITESYNC_RENDERER_TOKEN_FILE: rendererTokenFile,
      },
    );
    runtimeSupervisor.start();
  }

  ipcMain.handle('host:runtime-connection', () => ({ url: runtimeUrl, token: rendererToken }));
  ipcMain.handle('host:choose-directory', async () => {
    const selected = await dialog.showOpenDialog(window!, {
      properties: ['openDirectory', 'createDirectory'],
    });
    const path = selected.filePaths[0];
    if (selected.canceled || !path) return null;
    const grantId = randomUUID();
    grants.set(grantId, path);
    if (credentialVault) {
      credentialVault.set(`directory-grant:${grantId}`, path);
      credentialVault.set('directory-grant-index', JSON.stringify([...grants.keys()]));
    }
    await runtimeRequest('/internal/directory-grants', {
      method: 'POST',
      body: { grantId, path },
    });
    return { grantId };
  });
  ipcMain.handle('host:open-grant', async (_event, grantId: string) => {
    const path = grants.get(grantId);
    if (!path) throw new Error('Directory grant is no longer available');
    return shell.openPath(path);
  });
  ipcMain.handle('host:revoke-grant', async (_event, grantId: string) => {
    revokeHostGrant(grantId);
    await runtimeRequest(`/internal/directory-grants/${grantId}`, { method: 'DELETE' });
  });
  ipcMain.handle('host:export-diagnostics', async () => {
    const diagnostics = await runtimeRequest('/api/v1/diagnostics');
    const selected = await dialog.showSaveDialog(window!, {
      title: '导出 KiteSync 诊断信息',
      defaultPath: `kitesync-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (selected.canceled || !selected.filePath) return null;
    writeFileSync(selected.filePath, JSON.stringify(diagnostics, null, 2), { mode: 0o600 });
    return selected.filePath;
  });
  ipcMain.handle('host:get-auto-start', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('host:set-auto-start', (_event, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    return app.getLoginItemSettings().openAtLogin;
  });

  await createWindow();
  for (const [grantId, path] of grants) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await runtimeRequest('/internal/directory-grants', {
          method: 'POST',
          body: { grantId, path },
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  const stopUpdater = startUpdater();
  const stopRuntimeEvents = startRuntimeEventBridge();
  const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="black" d="M5 3h6v10L21 3h8L17 15l12 14h-8L11 17v12H5z"/></svg>`;
  const trayImage = nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(traySvg).toString('base64')}`)
    .resize({ width: 18, height: 18 });
  if (process.platform === 'darwin') trayImage.setTemplateImage(true);
  const tray = new Tray(trayImage);
  tray.setToolTip('KiteSync');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 KiteSync', click: () => window?.show() },
      { label: '暂停全部同步', enabled: false },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('double-click', () => window?.show());

  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') window?.hide();
  });
  app.on('activate', () => {
    window?.show();
  });
  app.once('will-quit', (event) => {
    stopUpdater();
    stopRuntimeEvents();
    if (runtimeSupervisor || syncthingSupervisor) {
      event.preventDefault();
      void Promise.all([runtimeSupervisor?.stop(), syncthingSupervisor?.stop()]).finally(() => {
        runtimeSupervisor = undefined;
        syncthingSupervisor = undefined;
        app.exit(0);
      });
    }
  });
}

void app
  .whenReady()
  .then(startApplication)
  .catch((error: unknown) => {
    console.error('KiteSync Electron startup failed', error);
    app.exit(1);
  });

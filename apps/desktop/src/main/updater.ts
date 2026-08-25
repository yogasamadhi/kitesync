import { app, dialog, Notification } from 'electron';
import electronUpdater from 'electron-updater';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  authorizesUpdate,
  parseAndVerifyUpdateManifest,
  type SignedUpdateManifest,
} from './update-manifest.js';

const { autoUpdater } = electronUpdater;

export function startUpdater() {
  const feedUrl = process.env.KITESYNC_UPDATE_FEED_URL;
  if (!app.isPackaged || !feedUrl) return () => undefined;
  const publicKeyFile =
    process.env.KITESYNC_UPDATE_PUBLIC_KEY_FILE ??
    join(process.resourcesPath, 'update-public-key.pem');
  let authorizedManifest: SignedUpdateManifest | undefined;
  let checking = false;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl, channel: 'stable' });
  autoUpdater.on('update-available', async (info) => {
    if (
      !authorizedManifest ||
      !authorizesUpdate(authorizedManifest, info, process.platform, process.arch)
    ) {
      console.error('Updater rejected metadata not authorized by the signed manifest');
      return;
    }
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'KiteSync 更新',
      message: `KiteSync ${info.version} 已可用`,
      detail: '安装包会校验 SHA-512 和平台代码签名。是否现在下载？',
      buttons: ['下载', '稍后'],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response === 0) await autoUpdater.downloadUpdate();
  });
  autoUpdater.on('update-downloaded', () => {
    new Notification({ title: 'KiteSync 更新已就绪', body: '退出应用时将自动安装。' }).show();
  });
  autoUpdater.on('error', (error) => console.error('Updater error:', error.message));
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const manifestUrl = new URL(
        'signed-manifest.json',
        feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`,
      );
      const [response, publicKey] = await Promise.all([
        fetch(manifestUrl, { cache: 'no-store', signal: AbortSignal.timeout(15_000) }),
        readFile(publicKeyFile, 'utf8'),
      ]);
      if (!response.ok) throw new Error(`Signed manifest returned HTTP ${response.status}`);
      authorizedManifest = parseAndVerifyUpdateManifest(await response.text(), publicKey);
      await autoUpdater.checkForUpdates();
    } catch (error) {
      authorizedManifest = undefined;
      console.error(
        'Updater preflight failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
    } finally {
      checking = false;
    }
  };
  const runCheck = () => void check();
  const initial = setTimeout(runCheck, 30_000);
  const interval = setInterval(runCheck, 6 * 60 * 60 * 1_000);
  initial.unref();
  interval.unref();
  return () => {
    clearTimeout(initial);
    clearInterval(interval);
    autoUpdater.removeAllListeners();
  };
}

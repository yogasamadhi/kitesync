import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const developmentState = resolve(sourceDirectory, '../../../.kitesync-dev');

export interface RuntimeConfig {
  databasePath: string;
  host: string;
  port: number;
  rendererToken: string;
  runtimeToken: string;
  syncthingApiKeyFile: string;
  syncthingUrl: string;
}

export function loadConfig(): RuntimeConfig {
  const tokenFile = process.env.KITESYNC_RUNTIME_TOKEN_FILE;
  const rendererTokenFile = process.env.KITESYNC_RENDERER_TOKEN_FILE;
  return {
    databasePath:
      process.env.KITESYNC_DESKTOP_DATABASE ?? resolve(developmentState, 'runtime.sqlite'),
    host: process.env.KITESYNC_DESKTOP_RUNTIME_HOST ?? '127.0.0.1',
    port: Number(process.env.KITESYNC_DESKTOP_RUNTIME_PORT ?? '3210'),
    rendererToken: rendererTokenFile
      ? readFileSync(rendererTokenFile, 'utf8').trim()
      : (process.env.KITESYNC_RENDERER_RUNTIME_TOKEN ?? 'development-renderer-runtime-token'),
    runtimeToken: tokenFile
      ? readFileSync(tokenFile, 'utf8').trim()
      : (process.env.KITESYNC_RUNTIME_TOKEN ?? 'development-runtime-token'),
    syncthingApiKeyFile:
      process.env.KITESYNC_LOCAL_SYNCTHING_API_KEY_FILE ??
      resolve(developmentState, 'syncthing-api-key'),
    syncthingUrl: process.env.KITESYNC_LOCAL_SYNCTHING_URL ?? 'http://127.0.0.1:8385',
  };
}

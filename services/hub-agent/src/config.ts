import { readFileSync } from 'node:fs';

export interface HubAgentConfig {
  host: string;
  port: number;
  statePath: string;
  syncthingApiKey: string;
  syncthingUrl: string;
  tlsCa?: Buffer;
  tlsCert?: Buffer;
  tlsKey?: Buffer;
}

function file(name: string): Buffer | undefined {
  const path = process.env[name];
  return path ? readFileSync(path) : undefined;
}

export function loadConfig(): HubAgentConfig {
  const tlsCa = file('KITESYNC_HUB_AGENT_TLS_CA');
  const tlsCert = file('KITESYNC_HUB_AGENT_TLS_CERT');
  const tlsKey = file('KITESYNC_HUB_AGENT_TLS_KEY');
  return {
    host: process.env.KITESYNC_HUB_AGENT_HOST ?? '0.0.0.0',
    port: Number(process.env.KITESYNC_HUB_AGENT_PORT ?? '9443'),
    statePath:
      process.env.KITESYNC_HUB_AGENT_STATE_PATH ?? '/var/lib/kitesync-agent/desired-state.json',
    syncthingApiKey: process.env.KITESYNC_SYNCTHING_API_KEY ?? 'kitesync-development-api-key',
    syncthingUrl: process.env.KITESYNC_SYNCTHING_URL ?? 'http://127.0.0.1:8384',
    ...(tlsCa ? { tlsCa } : {}),
    ...(tlsCert ? { tlsCert } : {}),
    ...(tlsKey ? { tlsKey } : {}),
  };
}

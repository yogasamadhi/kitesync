import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const developmentCertificate = (name: string) =>
  resolve(sourceDirectory, '../../../deploy/compose/certs', name);

export interface ControlPlaneConfig {
  backupControllerToken: string;
  bootstrapToken: string;
  cookieSecret: string;
  databaseUrl: string;
  desktopAccessTtlMinutes: number;
  desktopRefreshTtlDays: number;
  host: string;
  hubAgentCa?: Buffer;
  hubAgentCert?: Buffer;
  hubAgentKey?: Buffer;
  hubAgentUrl: string;
  hubPublicAddress: string;
  port: number;
  publicUrl: string;
  sessionTtlHours: number;
  updatePublicKey?: string;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error('Missing required environment variable ' + name);
  }
  return value;
}

export function loadConfig(): ControlPlaneConfig {
  const hubAgentCa = readOptionalFile(
    process.env.KITESYNC_HUB_AGENT_CA ?? developmentCertificate('ca.crt'),
  );
  const hubAgentCert = readOptionalFile(
    process.env.KITESYNC_HUB_AGENT_CERT ?? developmentCertificate('control-plane.crt'),
  );
  const hubAgentKey = readOptionalFile(
    process.env.KITESYNC_HUB_AGENT_KEY ?? developmentCertificate('control-plane.key'),
  );
  const updatePublicKey = readOptionalFile(process.env.KITESYNC_UPDATE_PUBLIC_KEY_FILE);
  return {
    backupControllerToken: required(
      'KITESYNC_BACKUP_CONTROLLER_TOKEN',
      'development-backup-controller-token-change-me',
    ),
    bootstrapToken: required('KITESYNC_BOOTSTRAP_TOKEN', 'development-bootstrap-token-change-me'),
    cookieSecret: required(
      'KITESYNC_COOKIE_SECRET',
      'development-cookie-secret-change-me-32-characters',
    ),
    databaseUrl: required(
      'KITESYNC_DATABASE_URL',
      'postgres://kitesync:kitesync@127.0.0.1:5432/kitesync',
    ),
    desktopAccessTtlMinutes: Number(process.env.KITESYNC_DESKTOP_ACCESS_TTL_MINUTES ?? '15'),
    desktopRefreshTtlDays: Number(process.env.KITESYNC_DESKTOP_REFRESH_TTL_DAYS ?? '30'),
    host: process.env.KITESYNC_HOST ?? '127.0.0.1',
    ...(hubAgentCa ? { hubAgentCa } : {}),
    ...(hubAgentCert ? { hubAgentCert } : {}),
    ...(hubAgentKey ? { hubAgentKey } : {}),
    hubAgentUrl: process.env.KITESYNC_HUB_AGENT_URL ?? 'https://localhost:9443',
    hubPublicAddress: process.env.KITESYNC_HUB_PUBLIC_ADDRESS ?? 'tcp://127.0.0.1:22000',
    port: Number(process.env.KITESYNC_PORT ?? '3000'),
    publicUrl: process.env.KITESYNC_PUBLIC_URL ?? 'http://127.0.0.1:3000',
    sessionTtlHours: Number(process.env.KITESYNC_SESSION_TTL_HOURS ?? '12'),
    ...(updatePublicKey ? { updatePublicKey: updatePublicKey.toString('utf8') } : {}),
  };
}

export function readOptionalFile(path: string | undefined): Buffer | undefined {
  return path && existsSync(path) ? readFileSync(path) : undefined;
}

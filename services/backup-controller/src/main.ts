import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { HubAgentBackupClient } from './hub-agent-client.js';
import { localSnapshot } from './local-adapter.js';
import { KubernetesSnapshotAdapter } from './kubernetes-adapter.js';

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[2] !== 'backup')
  throw new Error('Usage: backup-controller backup [--adapter local|kubernetes]');
const adapter =
  argument('--adapter') ?? (process.env.KUBERNETES_SERVICE_HOST ? 'kubernetes' : 'local');
if (adapter === 'local') {
  const source = resolve(
    argument('--source') ??
      process.env.KITESYNC_LOCAL_BACKUP_SOURCE ??
      'deploy/compose/dev-backup-source',
  );
  const destination = resolve(
    argument('--destination') ??
      process.env.KITESYNC_LOCAL_BACKUP_DESTINATION ??
      '.kitesync-dev/backups',
  );
  console.log(JSON.stringify(await localSnapshot(source, destination)));
} else {
  const revision = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const runId = randomUUID();
  const report = async (
    state: 'running' | 'succeeded' | 'failed',
    details: Record<string, unknown>,
  ) => {
    const url = process.env.KITESYNC_CONTROL_PLANE_URL;
    const token = process.env.KITESYNC_BACKUP_CONTROLLER_TOKEN;
    if (!url || !token) throw new Error('Backup status callback is not configured');
    const response = await fetch(`${url.replace(/\/$/, '')}/internal/backup-runs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: runId, state, snapshotRevision: revision, details }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Backup status callback failed with ${response.status}`);
  };
  const integerEnv = (name: string, fallback: number) =>
    Number.parseInt(process.env[name] ?? String(fallback), 10);
  const adapter = new KubernetesSnapshotAdapter({
    namespace: process.env.POD_NAMESPACE ?? 'default',
    dataPvc: process.env.KITESYNC_HUB_DATA_PVC ?? 'data-kitesync-hub-0',
    statePvc: process.env.KITESYNC_HUB_STATE_PVC ?? 'state-kitesync-hub-0',
    snapshotClass: process.env.KITESYNC_SNAPSHOT_CLASS ?? 'default',
    resticImage: process.env.KITESYNC_RESTIC_IMAGE ?? 'restic/restic:0.18.1',
    s3SecretName: process.env.KITESYNC_S3_SECRET_NAME ?? 'kitesync-application',
    s3Endpoint: process.env.KITESYNC_S3_ENDPOINT ?? '',
    s3Bucket: process.env.KITESYNC_S3_BUCKET ?? '',
    dataRestoreSize: process.env.KITESYNC_HUB_DATA_RESTORE_SIZE ?? '10Ti',
    stateRestoreSize: process.env.KITESYNC_HUB_STATE_RESTORE_SIZE ?? '20Gi',
    ...(process.env.KITESYNC_STORAGE_CLASS
      ? { storageClass: process.env.KITESYNC_STORAGE_CLASS }
      : {}),
    retention: {
      daily: integerEnv('KITESYNC_RETENTION_DAILY', 30),
      weekly: integerEnv('KITESYNC_RETENTION_WEEKLY', 12),
      monthly: integerEnv('KITESYNC_RETENTION_MONTHLY', 12),
    },
  });
  try {
    await report('running', { phase: 'quiesce' });
    const hub = await HubAgentBackupClient.create({
      url: process.env.KITESYNC_HUB_AGENT_URL ?? 'https://kitesync-hub-agent:9443',
      caFile: process.env.KITESYNC_HUB_AGENT_CA ?? '/tls/ca.crt',
      certFile: process.env.KITESYNC_HUB_AGENT_CERT ?? '/tls/tls.crt',
      keyFile: process.env.KITESYNC_HUB_AGENT_KEY ?? '/tls/tls.key',
    });
    const quiesced = await hub.quiesce();
    let snapshots: Awaited<ReturnType<typeof adapter.snapshot>>;
    try {
      snapshots = await adapter.snapshot(revision);
    } finally {
      await hub.resume(quiesced.token);
    }
    const upload = await adapter.upload(snapshots);
    const retention = await adapter.pruneSnapshots();
    await report('succeeded', { upload, retention });
    console.log(JSON.stringify({ runId, upload, retention }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await report('failed', { reason: reason.slice(0, 2_000) }).catch(() => undefined);
    throw error;
  }
}

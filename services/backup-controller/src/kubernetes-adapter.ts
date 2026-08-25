import { readFile } from 'node:fs/promises';

interface KubernetesOptions {
  namespace: string;
  dataPvc: string;
  statePvc: string;
  snapshotClass: string;
  resticImage: string;
  s3SecretName: string;
  s3Endpoint: string;
  s3Bucket: string;
  dataRestoreSize: string;
  stateRestoreSize: string;
  storageClass?: string;
  retention: { daily: number; weekly: number; monthly: number };
}

interface SnapshotPair {
  revision: string;
  data: string;
  state: string;
}

export class KubernetesSnapshotAdapter {
  private readonly baseUrl = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT_HTTPS ?? '443'}`;

  constructor(private readonly options: KubernetesOptions) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    acceptedStatuses: number[] = [],
  ): Promise<T> {
    const token = await readFile('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      throw new Error(
        `Kubernetes API ${method} ${path} failed: ${response.status} ${await response.text()}`,
      );
    }
    if (response.status === 204 || response.status === 404) return undefined as T;
    return (await response.json()) as T;
  }

  private resourceName(revision: string, suffix: string) {
    return `kitesync-${revision}-${suffix}`
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]/g, '-')
      .slice(0, 63)
      .replaceAll(/-+$/g, '');
  }

  private async createSnapshot(sourcePvc: string, revision: string, suffix: string) {
    const name = this.resourceName(revision, suffix);
    await this.request(
      'POST',
      `/apis/snapshot.storage.k8s.io/v1/namespaces/${this.options.namespace}/volumesnapshots`,
      {
        apiVersion: 'snapshot.storage.k8s.io/v1',
        kind: 'VolumeSnapshot',
        metadata: {
          name,
          labels: { 'app.kubernetes.io/name': 'kitesync', 'kitesync.io/revision': revision },
        },
        spec: {
          volumeSnapshotClassName: this.options.snapshotClass,
          source: { persistentVolumeClaimName: sourcePvc },
        },
      },
    );
    for (let attempt = 0; attempt < 120; attempt++) {
      const snapshot = await this.request<{
        status?: { readyToUse?: boolean; error?: { message?: string } };
      }>(
        'GET',
        `/apis/snapshot.storage.k8s.io/v1/namespaces/${this.options.namespace}/volumesnapshots/${name}`,
      );
      if (snapshot.status?.error) {
        throw new Error(snapshot.status.error.message ?? `CSI snapshot ${name} failed`);
      }
      if (snapshot.status?.readyToUse) return name;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`CSI snapshot ${name} did not become ready within four minutes`);
  }

  async snapshot(revision: string): Promise<SnapshotPair> {
    const [state, data] = await Promise.all([
      this.createSnapshot(this.options.statePvc, revision, 'state'),
      this.createSnapshot(this.options.dataPvc, revision, 'data'),
    ]);
    return { revision, state, data };
  }

  private async createClone(name: string, snapshot: string, size: string) {
    await this.request(
      'POST',
      `/api/v1/namespaces/${this.options.namespace}/persistentvolumeclaims`,
      {
        apiVersion: 'v1',
        kind: 'PersistentVolumeClaim',
        metadata: {
          name,
          labels: { 'app.kubernetes.io/name': 'kitesync', 'kitesync.io/temporary': 'backup' },
        },
        spec: {
          accessModes: ['ReadWriteOnce'],
          ...(this.options.storageClass ? { storageClassName: this.options.storageClass } : {}),
          resources: { requests: { storage: size } },
          dataSource: {
            apiGroup: 'snapshot.storage.k8s.io',
            kind: 'VolumeSnapshot',
            name: snapshot,
          },
        },
      },
    );
  }

  async upload(snapshots: SnapshotPair) {
    if (!this.options.resticImage || !this.options.s3Endpoint || !this.options.s3Bucket) {
      throw new Error('Restic image, S3 endpoint and bucket are required for production backup');
    }
    const dataClone = this.resourceName(snapshots.revision, 'data-clone');
    const stateClone = this.resourceName(snapshots.revision, 'state-clone');
    const job = this.resourceName(snapshots.revision, 'upload');
    const pvcPath = `/api/v1/namespaces/${this.options.namespace}/persistentvolumeclaims`;
    const jobPath = `/apis/batch/v1/namespaces/${this.options.namespace}/jobs`;
    try {
      await Promise.all([
        this.createClone(dataClone, snapshots.data, this.options.dataRestoreSize),
        this.createClone(stateClone, snapshots.state, this.options.stateRestoreSize),
      ]);
      const repository = `s3:${this.options.s3Endpoint.replace(/\/$/, '')}/${this.options.s3Bucket}`;
      await this.request('POST', jobPath, {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          name: job,
          labels: {
            'app.kubernetes.io/name': 'kitesync',
            'kitesync.io/revision': snapshots.revision,
          },
        },
        spec: {
          backoffLimit: 1,
          activeDeadlineSeconds: 10_800,
          template: {
            metadata: {
              labels: {
                'app.kubernetes.io/name': 'kitesync',
                'app.kubernetes.io/component': 'backup',
              },
            },
            spec: {
              restartPolicy: 'Never',
              securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
              containers: [
                {
                  name: 'restic',
                  image: this.options.resticImage,
                  command: ['/bin/sh', '-ec'],
                  args: [
                    [
                      'restic snapshots >/dev/null 2>&1 || restic init',
                      `restic backup /snapshot-data /snapshot-state --tag ${snapshots.revision}`,
                      `restic forget --keep-daily ${this.options.retention.daily} --keep-weekly ${this.options.retention.weekly} --keep-monthly ${this.options.retention.monthly} --prune`,
                      'restic check',
                    ].join(' && '),
                  ],
                  env: [
                    { name: 'RESTIC_REPOSITORY', value: repository },
                    { name: 'RESTIC_CACHE_DIR', value: '/tmp/restic-cache' },
                    {
                      name: 'RESTIC_PASSWORD',
                      valueFrom: {
                        secretKeyRef: { name: this.options.s3SecretName, key: 'restic-password' },
                      },
                    },
                    {
                      name: 'AWS_ACCESS_KEY_ID',
                      valueFrom: {
                        secretKeyRef: { name: this.options.s3SecretName, key: 's3-access-key' },
                      },
                    },
                    {
                      name: 'AWS_SECRET_ACCESS_KEY',
                      valueFrom: {
                        secretKeyRef: { name: this.options.s3SecretName, key: 's3-secret-key' },
                      },
                    },
                  ],
                  volumeMounts: [
                    { name: 'data', mountPath: '/snapshot-data', readOnly: true },
                    { name: 'state', mountPath: '/snapshot-state', readOnly: true },
                    { name: 'tmp', mountPath: '/tmp' },
                  ],
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ['ALL'] },
                  },
                },
              ],
              volumes: [
                { name: 'data', persistentVolumeClaim: { claimName: dataClone, readOnly: true } },
                { name: 'state', persistentVolumeClaim: { claimName: stateClone, readOnly: true } },
                { name: 'tmp', emptyDir: {} },
              ],
            },
          },
        },
      });

      for (let attempt = 0; attempt < 1_800; attempt++) {
        const observed = await this.request<{
          status?: {
            succeeded?: number;
            failed?: number;
            conditions?: Array<{ message?: string }>;
          };
        }>('GET', `${jobPath}/${job}`);
        if (observed.status?.succeeded) return { job, repository, snapshots };
        if (observed.status?.failed) {
          throw new Error(
            observed.status.conditions?.at(-1)?.message ?? 'Restic backup job failed',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      throw new Error('Restic backup did not finish within 150 minutes');
    } finally {
      await Promise.allSettled([
        this.request('DELETE', `${jobPath}/${job}?propagationPolicy=Background`, undefined, [404]),
        this.request('DELETE', `${pvcPath}/${dataClone}`, undefined, [404]),
        this.request('DELETE', `${pvcPath}/${stateClone}`, undefined, [404]),
      ]);
    }
  }

  async pruneSnapshots() {
    const path = `/apis/snapshot.storage.k8s.io/v1/namespaces/${this.options.namespace}/volumesnapshots`;
    const result = await this.request<{
      items: Array<{
        metadata: {
          name: string;
          creationTimestamp?: string;
          labels?: Record<string, string>;
        };
      }>;
    }>('GET', `${path}?labelSelector=app.kubernetes.io%2Fname%3Dkitesync`);
    const revisions = new Map<string, Date>();
    for (const item of result.items) {
      const revision = item.metadata.labels?.['kitesync.io/revision'];
      const createdAt = item.metadata.creationTimestamp;
      if (!revision || !createdAt) continue;
      const date = new Date(createdAt);
      const prior = revisions.get(revision);
      if (!prior || date > prior) revisions.set(revision, date);
    }
    const ordered = [...revisions.entries()].sort((a, b) => b[1].getTime() - a[1].getTime());
    const keep = new Set<string>();
    const selectBuckets = (count: number, bucket: (date: Date) => string) => {
      const selected = new Set<string>();
      for (const [revision, date] of ordered) {
        const key = bucket(date);
        if (selected.has(key)) continue;
        selected.add(key);
        keep.add(revision);
        if (selected.size >= count) break;
      }
    };
    selectBuckets(this.options.retention.daily, (date) => date.toISOString().slice(0, 10));
    selectBuckets(this.options.retention.weekly, (date) => {
      const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
      const week = Math.floor((date.getTime() - firstThursday.getTime()) / 604_800_000);
      return `${date.getUTCFullYear()}-${week}`;
    });
    selectBuckets(
      this.options.retention.monthly,
      (date) => `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`,
    );

    const deletions = result.items.filter((item) => {
      const revision = item.metadata.labels?.['kitesync.io/revision'];
      return revision !== undefined && !keep.has(revision);
    });
    await Promise.all(
      deletions.map((item) =>
        this.request('DELETE', `${path}/${item.metadata.name}`, undefined, [404]),
      ),
    );
    return { retainedRevisions: keep.size, deletedSnapshots: deletions.length };
  }
}

import { randomUUID } from 'node:crypto';
import {
  HubDesiredStateSchema,
  HubOperationSchema,
  HubSnapshotSchema,
  ProblemDetailsSchema,
} from '@kitesync/contracts';
import { Type } from '@sinclair/typebox';
import Fastify from 'fastify';
import type { HubAgentConfig } from './config.js';
import { EventMonitor } from './event-monitor.js';
import { HubReconciler } from './reconciler.js';
import { StateStore } from './state-store.js';
import { SyncthingClient } from './syncthing-client.js';

export async function createServer(config: HubAgentConfig) {
  const generation = randomUUID();
  const syncthing = new SyncthingClient(config.syncthingUrl, config.syncthingApiKey);
  const store = new StateStore(config.statePath);
  const reconciler = new HubReconciler(syncthing, store);
  const monitor = new EventMonitor(syncthing);
  const quiesceTokens = new Map<string, Array<{ id: string; paused: boolean }>>();
  const tlsEnabled = Boolean(config.tlsCa && config.tlsCert && config.tlsKey);

  const app = Fastify({
    logger: {
      level: process.env.KITESYNC_LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    ...(tlsEnabled
      ? {
          https: {
            ca: config.tlsCa!,
            cert: config.tlsCert!,
            key: config.tlsKey!,
            requestCert: true,
            rejectUnauthorized: true,
          },
        }
      : {}),
  });

  app.get('/health', async (_request, reply) => {
    try {
      await syncthing.status();
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'degraded' });
    }
  });

  app.get('/api/v1/runtime', async () => ({
    runtimeId: 'hub-agent',
    generation,
    version: '1.0.0',
    apiVersion: 'v1',
    startedAt: new Date().toISOString(),
    capabilities: ['desired-state', 'snapshot', 'events', 'versions', 'restore'],
  }));

  app.get('/api/v1/snapshot', { schema: { response: { 200: HubSnapshotSchema } } }, async () => {
    const [desired, status, version, devices, folders, connections] = await Promise.all([
      store.load(),
      syncthing.status(),
      syncthing.version(),
      syncthing.devices(),
      syncthing.folders(),
      syncthing.connections(),
    ]);
    const folderStates = await Promise.all(
      folders.map(async (folder) => {
        const state = await syncthing.folderStatus(folder.id);
        return {
          id: folder.id,
          label: folder.label,
          state: state.state,
          localBytes: state.localBytes,
          globalBytes: state.globalBytes,
          needBytes: state.needBytes,
        };
      }),
    );
    return {
      generation,
      observedRevision: desired.revision,
      syncthing: {
        deviceId: status.myID,
        version: version.version,
        uptimeSeconds: status.uptime,
      },
      devices: devices.map((device) => ({
        id: device.deviceID,
        name: device.name,
        paused: device.paused,
        connected: connections.connections[device.deviceID]?.connected ?? false,
      })),
      folders: folderStates,
    };
  });

  app.put(
    '/api/v1/desired-state/:revision',
    {
      schema: {
        params: Type.Object({ revision: Type.Integer({ minimum: 1 }) }),
        body: HubDesiredStateSchema,
        response: { 202: HubOperationSchema, 400: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const params = request.params as { revision: number };
      const body = request.body as import('@kitesync/contracts').HubDesiredState;
      if (body.revision !== params.revision) {
        return reply.status(400).send({
          type: 'about:blank',
          title: 'Revision mismatch',
          status: 400,
          traceId: request.id,
          code: 'REVISION_MISMATCH',
        });
      }
      return reply.status(202).send(await reconciler.submit(body));
    },
  );

  app.get(
    '/api/v1/operations/:id',
    {
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 200: HubOperationSchema, 404: Type.Object({ message: Type.String() }) },
      },
    },
    async (request, reply) => {
      const operation = reconciler.getOperation((request.params as { id: string }).id);
      if (!operation) return reply.status(404).send({ message: 'Operation not found' });
      return operation;
    },
  );

  app.get('/api/v1/events', async (request) => {
    const cursor = Number((request.query as { cursor?: string }).cursor ?? '0');
    return { items: monitor.after(Number.isSafeInteger(cursor) ? cursor : 0) };
  });

  app.get('/api/v1/folders/:id/versions', async (request) => {
    const { id } = request.params as { id: string };
    const versions = await syncthing.versions(id);
    return {
      items: Object.entries(versions).flatMap(([path, entries]) =>
        entries.map((entry) => ({
          path,
          versionTime: entry.versionTime,
          modifiedAt: entry.modTime,
          sizeBytes: entry.size,
        })),
      ),
    };
  });

  app.post('/api/v1/folders/:id/restore', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { files: Array<{ path: string; versionTime: string }> };
    await syncthing.restore(
      id,
      Object.fromEntries(body.files.map((file) => [file.path, file.versionTime])),
    );
    return reply.status(202).send({ operationId: randomUUID(), state: 'accepted' });
  });

  app.post('/api/v1/quiesce', async (_request, reply) => {
    const token = randomUUID();
    const folders = await syncthing.folders();
    quiesceTokens.set(
      token,
      folders.map((folder) => ({ id: folder.id, paused: folder.paused })),
    );
    for (const folder of folders) await syncthing.upsertFolder({ ...folder, paused: true });
    return reply.status(202).send({ token, state: 'quiesced', at: new Date().toISOString() });
  });

  app.post('/api/v1/resume', async (request, reply) => {
    const { token } = request.body as { token: string };
    const previous = quiesceTokens.get(token);
    if (!previous) return reply.status(409).send({ code: 'QUIESCE_TOKEN_INVALID' });
    const folders = await syncthing.folders();
    for (const folder of folders) {
      const state = previous.find((item) => item.id === folder.id);
      if (state) await syncthing.upsertFolder({ ...folder, paused: state.paused });
    }
    quiesceTokens.delete(token);
    return { state: 'running', at: new Date().toISOString() };
  });

  app.addHook('onReady', async () => {
    await syncthing.configureLanOnly();
    monitor.start();
  });
  app.addHook('onClose', async () => {
    monitor.stop();
  });

  return app;
}

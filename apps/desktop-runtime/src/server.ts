import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readdir, stat, statfs } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Type } from '@sinclair/typebox';
import Fastify from 'fastify';
import {
  canonicalJson,
  type Device,
  type DeviceSpaceBinding,
  type SyncSpace,
  type User,
} from '@kitesync/contracts';
import type { RuntimeConfig } from './config.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { RuntimeDatabase } from './database.js';
import { LocalSyncthing } from './syncthing.js';
import type { CredentialVault } from './vault.js';

export async function createServer(config: RuntimeConfig, vault: CredentialVault) {
  const generation = randomUUID();
  const runtimeId = randomUUID();
  const startedAt = new Date().toISOString();
  const database = new RuntimeDatabase(config.databasePath);
  const control = new ControlPlaneClient(database.get('serverUrl') ?? 'http://127.0.0.1:3000');
  const syncthing = new LocalSyncthing(config);
  const grants = new Map<string, string>();
  let reconciliationRunning = false;
  let account: User | undefined;
  let device: Device | undefined;
  await vault.delete('access-token');
  const refreshAccessToken = async () => {
    const refreshToken = await vault.get('refresh-token');
    if (!refreshToken) return undefined;
    const session = await control.request<{
      user: User;
      accessToken: string;
      refreshToken: string;
    }>('/api/v1/auth/desktop/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
    await vault.set('refresh-token', session.refreshToken);
    account = session.user;
    return session.accessToken;
  };
  control.setRefreshHandler(refreshAccessToken);
  if (await vault.get('refresh-token')) {
    try {
      control.setAccessToken(await refreshAccessToken());
    } catch {
      control.setAccessToken(undefined);
    }
  }

  const app = Fastify({
    logger: {
      level: process.env.KITESYNC_LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'body.password', 'body.path'],
    },
  });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin === 'null' || origin === 'http://127.0.0.1:5174') {
      reply
        .header('Access-Control-Allow-Origin', origin)
        .header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        .header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
        .header('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') return reply.status(204).send();
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    const authorization = request.headers.authorization;
    const authorized = request.url.startsWith('/internal/')
      ? authorization === `Bearer ${config.runtimeToken}`
      : [config.runtimeToken, config.rendererToken].some(
          (token) => authorization === `Bearer ${token}`,
        );
    if (!authorized) return reply.status(401).send({ code: 'RUNTIME_AUTH_REQUIRED' });
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/api/v1/runtime', async () => ({
    runtimeId,
    generation,
    version: '1.0.0',
    apiVersion: 'v1',
    startedAt,
    capabilities: [
      'account',
      'device',
      'offers',
      'directory-grants',
      'bindings',
      'activity',
      'diagnostics',
    ],
  }));
  app.get('/api/v1/capabilities', async () => ({
    capabilities: { localRuntime: true, directoryGrants: true, conflicts: true, diagnostics: true },
  }));

  app.post(
    '/internal/directory-grants',
    {
      schema: {
        body: Type.Object({
          grantId: Type.String({ format: 'uuid' }),
          path: Type.String({ minLength: 1 }),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as { grantId: string; path: string };
      grants.set(body.grantId, body.path);
      return reply.status(204).send();
    },
  );
  app.delete(
    '/internal/directory-grants/:grantId',
    { schema: { params: Type.Object({ grantId: Type.String({ format: 'uuid' }) }) } },
    async (request, reply) => {
      grants.delete((request.params as { grantId: string }).grantId);
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/v1/account/login',
    {
      schema: {
        body: Type.Object({
          serverUrl: Type.String(),
          username: Type.String(),
          password: Type.String(),
        }),
      },
    },
    async (request) => {
      const body = request.body as { serverUrl: string; username: string; password: string };
      control.setServerUrl(body.serverUrl);
      const session = await control.request<{
        user: User;
        accessToken: string;
        refreshToken: string;
      }>('/api/v1/auth/desktop/login', {
        method: 'POST',
        body: JSON.stringify({ username: body.username, password: body.password }),
      });
      control.setAccessToken(session.accessToken);
      await vault.set('refresh-token', session.refreshToken);
      database.set('serverUrl', body.serverUrl.replace(/\/$/, ''));
      database.set('accountUserId', session.user.id);
      account = session.user;
      database.event('account.logged-in', { userId: account.id });
      return { account };
    },
  );
  app.get('/api/v1/account', async () => ({
    account: account ?? null,
    serverUrl: database.get('serverUrl') ?? null,
  }));

  app.post(
    '/api/v1/device/register',
    {
      schema: {
        body: Type.Object({
          displayName: Type.String({ minLength: 1 }),
          platform: Type.Union([
            Type.Literal('windows'),
            Type.Literal('macos'),
            Type.Literal('linux'),
          ]),
        }),
      },
    },
    async (request, reply) => {
      let productPublicKey = await vault.get('device-public-key');
      if (!productPublicKey) {
        const keyPair = generateKeyPairSync('ed25519');
        productPublicKey = keyPair.publicKey
          .export({ type: 'spki', format: 'der' })
          .toString('base64');
        await vault.set('device-public-key', productPublicKey);
        await vault.set(
          'device-private-key',
          keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        );
      }
      const status = await syncthing.status();
      const registrationNonce = randomUUID();
      const registration = {
        ...(request.body as {
          displayName: string;
          platform: 'windows' | 'macos' | 'linux';
        }),
        productPublicKey,
        syncthingDeviceId: status.myID,
        registrationNonce,
      };
      const privateKey = await vault.get('device-private-key');
      if (!privateKey) throw new Error('Product device private key is unavailable');
      const signature = sign(
        null,
        Buffer.from(canonicalJson(registration)),
        createPrivateKey({
          key: Buffer.from(privateKey, 'base64'),
          format: 'der',
          type: 'pkcs8',
        }),
      ).toString('base64');
      const result = await control.request<{ device: Device }>('/api/v1/device-registrations', {
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: JSON.stringify({ ...registration, signature }),
      });
      device = result.device;
      database.set('deviceId', device.id);
      database.event('device.registered', { deviceId: device.id });
      return reply.status(202).send(result);
    },
  );
  app.get('/api/v1/device', async () => {
    const deviceId = database.get('deviceId');
    if (!deviceId) return { device: null };
    const list = await control.request<{ items: Device[] }>('/api/v1/devices');
    device = list.items.find((item) => item.id === deviceId);
    return { device: device ?? null };
  });

  app.get('/api/v1/offers', async () => control.request<{ items: SyncSpace[] }>('/api/v1/offers'));
  app.get('/api/v1/directory-bindings', async () => {
    const rows = database.sqlite
      .prepare(
        "SELECT id, server_binding_id AS serverBindingId, sync_space_id AS syncSpaceId, grant_id AS grantId, revision, state, created_at AS createdAt FROM directory_bindings WHERE state != 'removed' ORDER BY created_at",
      )
      .all();
    return { items: rows };
  });
  app.post(
    '/api/v1/directory-bindings',
    {
      schema: {
        body: Type.Object({
          syncSpaceId: Type.String({ format: 'uuid' }),
          grantId: Type.String({ format: 'uuid' }),
        }),
      },
    },
    async (request, reply) => {
      const body = request.body as { syncSpaceId: string; grantId: string };
      const path = grants.get(body.grantId);
      if (!path)
        return reply
          .status(409)
          .send({ code: 'DIRECTORY_GRANT_INVALID', title: 'Directory grant is unavailable' });
      const deviceId = database.get('deviceId');
      if (!deviceId)
        return reply
          .status(409)
          .send({ code: 'DEVICE_NOT_REGISTERED', title: 'Register this device first' });
      const configuration = await control.request<{
        device: { state: string };
        hub: { syncthingDeviceId: string; addresses: string[] };
      }>(`/api/v1/desktop/configuration?deviceId=${deviceId}`);
      if (configuration.device.state !== 'active')
        return reply
          .status(409)
          .send({ code: 'DEVICE_NOT_APPROVED', title: 'Device approval is pending' });
      const offers = await control.request<{ items: SyncSpace[] }>('/api/v1/offers');
      const space = offers.items.find((item) => item.id === body.syncSpaceId);
      if (!space)
        return reply.status(404).send({ code: 'OFFER_NOT_FOUND', title: 'Space offer not found' });
      await syncthing.configureHub(configuration.hub);
      await syncthing.configureFolder({
        id: space.syncthingFolderId,
        label: space.label,
        path,
        hubDeviceId: configuration.hub.syncthingDeviceId,
      });
      const result = await control.request<{ binding: DeviceSpaceBinding }>(
        '/api/v1/device-bindings',
        {
          method: 'POST',
          headers: { 'Idempotency-Key': randomUUID() },
          body: JSON.stringify({ syncSpaceId: body.syncSpaceId, deviceId }),
        },
      );
      const now = new Date().toISOString();
      const previous = database.sqlite
        .prepare('SELECT id FROM directory_bindings WHERE server_binding_id = ? LIMIT 1')
        .get(result.binding.id) as { id: string } | undefined;
      const localId = previous?.id ?? randomUUID();
      if (previous) {
        database.sqlite
          .prepare(
            'UPDATE directory_bindings SET sync_space_id = ?, grant_id = ?, revision = ?, state = ?, updated_at = ? WHERE id = ?',
          )
          .run(
            body.syncSpaceId,
            body.grantId,
            result.binding.revision,
            'provisioning',
            now,
            localId,
          );
      } else {
        database.sqlite
          .prepare(
            'INSERT INTO directory_bindings (id, server_binding_id, sync_space_id, grant_id, revision, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            localId,
            result.binding.id,
            body.syncSpaceId,
            body.grantId,
            result.binding.revision,
            'provisioning',
            now,
            now,
          );
      }
      database.event('directory-binding.created', {
        bindingId: localId,
        syncSpaceId: body.syncSpaceId,
      });
      return reply.status(202).send({ id: localId, state: 'provisioning' });
    },
  );

  app.post(
    '/api/v1/directory-bindings/:id/:action',
    {
      schema: {
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          action: Type.Union([Type.Literal('pause'), Type.Literal('resume')]),
        }),
      },
    },
    async (request, reply) =>
      mutateBinding(request.params as { id: string; action: 'pause' | 'resume' }, reply),
  );
  app.delete(
    '/api/v1/directory-bindings/:id',
    { schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }) } },
    async (request, reply) =>
      mutateBinding({ ...(request.params as { id: string }), action: 'unbind' }, reply),
  );

  async function mutateBinding(
    input: { id: string; action: 'pause' | 'resume' | 'unbind' },
    reply: any,
  ) {
    const row = database.sqlite
      .prepare(
        'SELECT server_binding_id AS serverBindingId, sync_space_id AS syncSpaceId, revision FROM directory_bindings WHERE id = ?',
      )
      .get(input.id) as
      { serverBindingId: string; syncSpaceId: string; revision: number } | undefined;
    if (!row) return reply.status(404).send({ code: 'BINDING_NOT_FOUND' });
    const method = input.action === 'unbind' ? 'DELETE' : 'POST';
    const suffix = input.action === 'unbind' ? '' : `/${input.action}`;
    const result = await control.request<{ binding: DeviceSpaceBinding }>(
      `/api/v1/device-bindings/${row.serverBindingId}${suffix}`,
      {
        method,
        headers: {
          'If-Match': `"${row.revision}"`,
          ...(input.action === 'unbind' ? { 'Idempotency-Key': randomUUID() } : {}),
        },
      },
    );
    const space = (await control.request<{ items: SyncSpace[] }>('/api/v1/offers')).items.find(
      (item) => item.id === row.syncSpaceId,
    );
    if (space && input.action === 'unbind') await syncthing.removeFolder(space.syncthingFolderId);
    if (space && input.action !== 'unbind')
      await syncthing.setFolderPaused(space.syncthingFolderId, input.action === 'pause');
    database.sqlite
      .prepare('UPDATE directory_bindings SET revision = ?, state = ?, updated_at = ? WHERE id = ?')
      .run(result.binding.revision, result.binding.state, new Date().toISOString(), input.id);
    return reply.status(202).send(result);
  }

  app.get('/api/v1/activity', async () => {
    const rows = database.sqlite
      .prepare(
        'SELECT sync_space_id AS syncSpaceId, grant_id AS grantId, state FROM directory_bindings WHERE state != ?',
      )
      .all('removed') as Array<{ syncSpaceId: string; grantId: string; state: string }>;
    const offers = account
      ? await control.request<{ items: SyncSpace[] }>('/api/v1/offers')
      : { items: [] };
    const items = await Promise.all(
      rows.map(async (row) => {
        const space = offers.items.find((item) => item.id === row.syncSpaceId);
        const path = grants.get(row.grantId);
        if (!path) return { ...row, status: 'DirectoryGrantUnavailable' };
        try {
          const disk = await statfs(path);
          const status = space
            ? await syncthing.folderStatus(space.syncthingFolderId)
            : ({} as Record<string, unknown>);
          return {
            ...row,
            status: status.state ?? row.state,
            needBytes: status.needBytes ?? 0,
            needFiles: status.needFiles ?? 0,
            diskFreeBytes: disk.bavail * disk.bsize,
          };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return {
            ...row,
            status: code === 'ENOENT' || code === 'ENODEV' ? 'StorageUnavailable' : 'degraded',
          };
        }
      }),
    );
    return { items };
  });
  app.get('/api/v1/conflicts', async () => {
    const items: Array<{
      grantId: string;
      relativePath: string;
      sizeBytes: number;
      modifiedAt: string;
    }> = [];
    async function scan(root: string, directory: string, grantId: string) {
      if (items.length >= 10_000) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await scan(root, path, grantId);
        else if (entry.isFile() && entry.name.includes('.sync-conflict-')) {
          const details = await stat(path);
          items.push({
            grantId,
            relativePath: relative(root, path),
            sizeBytes: details.size,
            modifiedAt: details.mtime.toISOString(),
          });
        }
      }
    }
    for (const [grantId, path] of grants) {
      try {
        await scan(path, path, grantId);
      } catch {
        // Removable storage may be absent; activity reports StorageUnavailable.
      }
    }
    return { items, detection: 'filesystem-scan-on-demand' };
  });
  app.get('/api/v1/diagnostics', async () => ({
    generation,
    startedAt,
    serverUrl: database.get('serverUrl') ?? null,
    deviceId: database.get('deviceId') ?? null,
    bindings: database.sqlite
      .prepare('SELECT sync_space_id AS syncSpaceId, state, revision FROM directory_bindings')
      .all(),
  }));
  app.get('/api/v1/events', async (request) => {
    const cursor = Number((request.query as { cursor?: string }).cursor ?? '0');
    const items = database.sqlite
      .prepare(
        'SELECT cursor, type, payload, occurred_at AS occurredAt FROM events WHERE cursor > ? ORDER BY cursor LIMIT 200',
      )
      .all(cursor) as Array<{ cursor: number; type: string; payload: string; occurredAt: string }>;
    return { items: items.map((item) => ({ ...item, payload: JSON.parse(item.payload) })) };
  });

  async function reconcileLocalState() {
    if (reconciliationRunning || !account) return;
    const deviceId = database.get('deviceId');
    if (!deviceId) return;
    const local = database.sqlite
      .prepare(
        'SELECT id, server_binding_id AS serverBindingId, sync_space_id AS syncSpaceId, grant_id AS grantId, revision, state FROM directory_bindings',
      )
      .all() as Array<{
      id: string;
      serverBindingId: string;
      syncSpaceId: string;
      grantId: string;
      revision: number;
      state: string;
    }>;
    if (!local.length) return;
    reconciliationRunning = true;
    try {
      const [server, offers, configuration] = await Promise.all([
        control.request<{ items: DeviceSpaceBinding[] }>(
          `/api/v1/device-bindings?deviceId=${deviceId}`,
        ),
        control.request<{ items: SyncSpace[] }>('/api/v1/offers'),
        control.request<{
          device: { state: string };
          hub: { syncthingDeviceId: string; addresses: string[] };
        }>(`/api/v1/desktop/configuration?deviceId=${deviceId}`),
      ]);
      for (const row of local) {
        const desired = server.items.find((binding) => binding.id === row.serverBindingId);
        if (
          !desired ||
          desired.revision < row.revision ||
          (desired.revision === row.revision && desired.state === row.state)
        )
          continue;
        const space = offers.items.find((item) => item.id === row.syncSpaceId);
        const folderId =
          space?.syncthingFolderId ?? `ks-${row.syncSpaceId.replaceAll('-', '').slice(0, 20)}`;
        if (desired.state === 'removing' || desired.state === 'removed') {
          await syncthing.removeFolder(folderId).catch(() => undefined);
          grants.delete(row.grantId);
          database.sqlite
            .prepare(
              'UPDATE directory_bindings SET revision = ?, state = ?, updated_at = ? WHERE id = ?',
            )
            .run(desired.revision, 'removed', new Date().toISOString(), row.id);
          database.event('directory-binding.removed-by-server', {
            bindingId: row.id,
            grantId: row.grantId,
            localFilesRetained: true,
          });
          continue;
        }
        const path = grants.get(row.grantId);
        if (!space || !path || configuration.device.state === 'revoked') continue;
        await syncthing.configureHub(configuration.hub);
        await syncthing.configureFolder({
          id: space.syncthingFolderId,
          label: space.label,
          path,
          hubDeviceId: configuration.hub.syncthingDeviceId,
          paused: desired.state === 'paused',
        });
        database.sqlite
          .prepare(
            'UPDATE directory_bindings SET revision = ?, state = ?, updated_at = ? WHERE id = ?',
          )
          .run(desired.revision, desired.state, new Date().toISOString(), row.id);
      }
    } catch (error) {
      database.event('local-reconciliation.deferred', {
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      reconciliationRunning = false;
    }
  }

  const reconciliationTimer = setInterval(() => void reconcileLocalState(), 10_000);
  reconciliationTimer.unref();
  app.addHook('onReady', async () => void reconcileLocalState());
  app.addHook('onClose', async () => {
    clearInterval(reconciliationTimer);
    database.close();
  });
  return app;
}

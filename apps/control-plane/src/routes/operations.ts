import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import {
  canonicalJson,
  ProblemDetailsSchema,
  RestoreVersionsRequestSchema,
  VersionEntrySchema,
} from '@kitesync/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gt, or } from 'drizzle-orm';
import { HubAgentClient } from '../application/hub-agent-client.js';
import { queueReconciliation, recordAuditEvent, recordDomainEvent } from '../application/events.js';
import { hashRequest, replayIdempotent, saveIdempotent } from '../application/idempotency.js';
import type { ControlPlaneConfig } from '../config.js';
import type { Database } from '../db/index.js';
import {
  auditEvents,
  backupRuns,
  hubs,
  idempotencyRecords,
  spaceShares,
  syncSpaces,
  updateReleases,
} from '../db/schema.js';
import { constantTimeStringEqual, requireAuth } from '../http/auth.js';
import { HttpProblem } from '../http/problem.js';
import { serializeSyncSpace } from '../http/serializers.js';

export function registerOperationRoutes(
  app: FastifyInstance,
  db: Database,
  agent: HubAgentClient,
  config: ControlPlaneConfig,
) {
  app.post(
    '/internal/backup-runs',
    {
      schema: {
        body: Type.Object({
          id: Type.String({ format: 'uuid' }),
          state: Type.Union([
            Type.Literal('running'),
            Type.Literal('succeeded'),
            Type.Literal('failed'),
          ]),
          snapshotRevision: Type.String({ minLength: 1, maxLength: 256 }),
          details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        }),
      },
    },
    async (request, reply) => {
      const authorization = request.headers.authorization;
      const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!constantTimeStringEqual(token, config.backupControllerToken)) {
        throw new HttpProblem(
          401,
          'BACKUP_CONTROLLER_UNAUTHORIZED',
          'Backup controller token invalid',
        );
      }
      const body = request.body as {
        id: string;
        state: 'running' | 'succeeded' | 'failed';
        snapshotRevision: string;
        details?: Record<string, unknown>;
      };
      const completedAt = ['succeeded', 'failed'].includes(body.state) ? new Date() : null;
      const [run] = await db
        .insert(backupRuns)
        .values({
          id: body.id,
          type: 'scheduled',
          state: body.state,
          snapshotRevision: body.snapshotRevision,
          completedAt,
          details: body.details ?? {},
        })
        .onConflictDoUpdate({
          target: backupRuns.id,
          set: {
            state: body.state,
            snapshotRevision: body.snapshotRevision,
            completedAt,
            details: body.details ?? {},
          },
        })
        .returning();
      return reply.status(run ? 200 : 500).send(run ?? { code: 'BACKUP_RUN_WRITE_FAILED' });
    },
  );

  async function authorizedSpace(id: string, userId: string, admin: boolean) {
    const [row] = await db
      .select({ space: syncSpaces })
      .from(syncSpaces)
      .leftJoin(spaceShares, eq(spaceShares.syncSpaceId, syncSpaces.id))
      .where(
        and(
          eq(syncSpaces.id, id),
          admin
            ? undefined
            : or(eq(syncSpaces.ownerUserId, userId), eq(spaceShares.userId, userId)),
        ),
      )
      .limit(1);
    if (!row) throw new HttpProblem(404, 'SPACE_NOT_FOUND', 'Sync space was not found');
    return row.space;
  }

  app.get(
    '/api/v1/sync-spaces/:id/versions',
    {
      preHandler: requireAuth(db),
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 200: Type.Object({ items: Type.Array(VersionEntrySchema) }) },
      },
    },
    async (request) => {
      const space = await authorizedSpace(
        (request.params as { id: string }).id,
        request.authUser!.id,
        request.authUser!.role === 'admin',
      );
      if (request.authUser!.role !== 'admin' && space.ownerUserId !== request.authUser!.id) {
        throw new HttpProblem(
          403,
          'RESTORE_FORBIDDEN',
          'Only the owner or an admin can view server versions',
        );
      }
      return agent.versions(space.syncthingFolderId);
    },
  );

  app.post(
    '/api/v1/sync-spaces/:id/restore-operations',
    {
      preHandler: requireAuth(db),
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 8, maxLength: 128 }) }),
        body: RestoreVersionsRequestSchema,
        response: {
          202: Type.Object({ operationId: Type.String({ format: 'uuid' }), state: Type.String() }),
          403: ProblemDetailsSchema,
        },
      },
    },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const body = request.body as { files: Array<{ path: string; versionTime: string }> };
      const key = request.headers['idempotency-key'] as string;
      const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const [prior] = await db
        .select()
        .from(idempotencyRecords)
        .where(
          and(eq(idempotencyRecords.userId, request.authUser!.id), eq(idempotencyRecords.key, key)),
        )
        .limit(1);
      if (prior) {
        if (prior.requestHash !== hash)
          throw new HttpProblem(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was reused');
        return reply.status(202).send(prior.responseBody);
      }
      const space = await authorizedSpace(
        id,
        request.authUser!.id,
        request.authUser!.role === 'admin',
      );
      if (request.authUser!.role !== 'admin' && space.ownerUserId !== request.authUser!.id)
        throw new HttpProblem(
          403,
          'RESTORE_FORBIDDEN',
          'Only the owner or an admin can restore versions',
        );
      const restored = await agent.restore(space.syncthingFolderId, body.files);
      const response = { operationId: restored.operationId, state: 'accepted' };
      await db.transaction(async (tx) => {
        await tx.insert(idempotencyRecords).values({
          id: randomUUID(),
          userId: request.authUser!.id,
          key,
          operationId: restored.operationId,
          requestHash: hash,
          responseStatus: 202,
          responseBody: response,
          expiresAt: new Date(Date.now() + 86_400_000),
        });
        await recordAuditEvent(tx, {
          actorUserId: request.authUser!.id,
          action: 'versions.restore',
          targetType: 'sync-space',
          targetId: space.id,
          traceId: request.id,
          metadata: { fileCount: body.files.length },
        });
        await recordDomainEvent(tx, {
          type: 'versions.restore-requested',
          aggregateId: space.id,
          payload: { operationId: restored.operationId, fileCount: body.files.length },
        });
      });
      return reply.status(202).send(response);
    },
  );

  app.post(
    '/api/v1/sync-spaces/:id/restore',
    {
      preHandler: requireAuth(db),
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 8 }),
          'if-match': Type.String(),
        }),
      },
    },
    async (request, reply) => {
      const id = (request.params as { id: string }).id;
      const key = request.headers['idempotency-key'] as string;
      const expected = Number(request.headers['if-match']?.replaceAll('"', ''));
      const requestHash = hashRequest({ action: 'restore-space', id, expected });
      const prior = await replayIdempotent(db, request.authUser!.id, key, requestHash);
      if (prior) return reply.status(202).send(prior.responseBody);
      const space = await authorizedSpace(
        id,
        request.authUser!.id,
        request.authUser!.role === 'admin',
      );
      if (space.state !== 'retained')
        throw new HttpProblem(409, 'SPACE_NOT_RETAINED', 'Only a retained space can be restored');
      if (expected !== space.revision)
        throw new HttpProblem(412, 'ETAG_STALE', 'The space changed; refresh and retry');
      const result = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(syncSpaces)
          .set({
            state: 'provisioning',
            deleteAfter: null,
            revision: expected + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(syncSpaces.id, id), eq(syncSpaces.revision, expected)))
          .returning();
        if (!updated)
          throw new HttpProblem(412, 'ETAG_STALE', 'The space changed; refresh and retry');
        const operationId = await queueReconciliation(tx, 'sync-space', id, updated.revision);
        const response = {
          space: serializeSyncSpace(updated),
          operationId,
          state: 'accepted' as const,
        };
        await saveIdempotent(tx, {
          userId: request.authUser!.id,
          key,
          operationId,
          requestHash,
          responseStatus: 202,
          responseBody: response,
        });
        await recordAuditEvent(tx, {
          actorUserId: request.authUser!.id,
          action: 'sync-space.restore',
          targetType: 'sync-space',
          targetId: id,
          traceId: request.id,
        });
        return response;
      });
      return reply.status(202).send(result);
    },
  );

  app.get('/api/v1/hubs', { preHandler: requireAuth(db, ['admin']) }, async () => ({
    items: await db.select().from(hubs),
  }));
  app.get('/api/v1/audit-events', { preHandler: requireAuth(db, ['admin']) }, async (request) => {
    const query = request.query as { cursor?: string; limit?: string };
    const cursor = query.cursor ? new Date(query.cursor) : new Date(0);
    const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50)));
    const items = await db
      .select()
      .from(auditEvents)
      .where(gt(auditEvents.occurredAt, cursor))
      .orderBy(asc(auditEvents.occurredAt))
      .limit(limit + 1);
    return {
      items: items.slice(0, limit),
      page: {
        hasMore: items.length > limit,
        nextCursor: items.length > limit ? items[limit - 1]!.occurredAt.toISOString() : null,
      },
    };
  });
  app.get('/api/v1/backup-runs', { preHandler: requireAuth(db, ['admin']) }, async () => ({
    items: await db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(100),
  }));
  app.post(
    '/api/v1/backup-runs',
    {
      preHandler: requireAuth(db, ['admin']),
      schema: {
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 8, maxLength: 128 }),
        }),
      },
    },
    async (request, reply) => {
      const key = request.headers['idempotency-key'] as string;
      const requestHash = hashRequest({ action: 'backup.request' });
      const prior = await replayIdempotent(db, request.authUser!.id, key, requestHash);
      if (prior) return reply.status(202).send(prior.responseBody);
      const run = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(backupRuns)
          .values({
            id: randomUUID(),
            type: 'manual',
            state: 'queued',
            details: { requestedBy: request.authUser!.id },
          })
          .returning();
        if (!created) throw new Error('Failed to queue backup run');
        await saveIdempotent(tx, {
          userId: request.authUser!.id,
          key,
          operationId: created.id,
          requestHash,
          responseStatus: 202,
          responseBody: created,
        });
        await recordDomainEvent(tx, {
          type: 'backup.requested',
          aggregateId: created.id,
          payload: { requestedBy: request.authUser!.id },
        });
        await recordAuditEvent(tx, {
          actorUserId: request.authUser!.id,
          action: 'backup.request',
          targetType: 'backup-run',
          targetId: created.id,
          traceId: request.id,
        });
        return created;
      });
      return reply.status(202).send(run);
    },
  );
  app.get('/api/v1/update-releases', { preHandler: requireAuth(db) }, async () => ({
    items: await db.select().from(updateReleases).orderBy(desc(updateReleases.publishedAt)),
  }));
  app.post(
    '/api/v1/update-releases',
    {
      preHandler: requireAuth(db, ['admin']),
      schema: {
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 8, maxLength: 128 }),
        }),
        body: Type.Object({
          version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$' }),
          channel: Type.Optional(Type.Literal('stable')),
          minimumClientVersion: Type.Optional(Type.String()),
          manifest: Type.Object({
            payload: Type.Record(Type.String(), Type.Unknown()),
            signature: Type.String(),
          }),
        }),
      },
    },
    async (request, reply) => {
      if (!config.updatePublicKey) {
        throw new HttpProblem(
          503,
          'UPDATE_KEY_NOT_CONFIGURED',
          'Update verification key is not configured',
        );
      }
      const body = request.body as {
        version: string;
        channel?: string;
        minimumClientVersion?: string;
        manifest: { payload: Record<string, unknown>; signature: string };
      };
      const key = request.headers['idempotency-key'] as string;
      const requestHash = hashRequest(body);
      const prior = await replayIdempotent(db, request.authUser!.id, key, requestHash);
      if (prior) return reply.status(201).send(prior.responseBody);
      const payload = body.manifest.payload;
      const assets = payload.assets;
      const payloadMatchesRelease =
        payload.version === body.version &&
        payload.channel === (body.channel ?? 'stable') &&
        payload.minimumClientVersion === body.minimumClientVersion &&
        Array.isArray(assets) &&
        assets.length > 0 &&
        assets.every(
          (asset) =>
            typeof asset === 'object' &&
            asset !== null &&
            ['platform', 'arch', 'url', 'sha512'].every(
              (field) =>
                typeof (asset as Record<string, unknown>)[field] === 'string' &&
                ((asset as Record<string, unknown>)[field] as string).length > 0,
            ),
        );
      if (!payloadMatchesRelease) {
        throw new HttpProblem(
          400,
          'UPDATE_MANIFEST_MISMATCH',
          'Signed manifest does not match the release metadata',
        );
      }
      let valid = false;
      try {
        valid = verify(
          null,
          Buffer.from(canonicalJson(payload)),
          createPublicKey(config.updatePublicKey),
          Buffer.from(body.manifest.signature, 'base64'),
        );
      } catch {
        valid = false;
      }
      if (!valid) {
        throw new HttpProblem(
          400,
          'UPDATE_SIGNATURE_INVALID',
          'Update manifest signature is invalid',
        );
      }
      const release = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(updateReleases)
          .values({
            id: randomUUID(),
            version: body.version,
            channel: body.channel ?? 'stable',
            minimumClientVersion: body.minimumClientVersion,
            manifest: body.manifest,
          })
          .returning();
        if (!created) throw new Error('Failed to publish update release');
        await saveIdempotent(tx, {
          userId: request.authUser!.id,
          key,
          operationId: created.id,
          requestHash,
          responseStatus: 201,
          responseBody: created,
        });
        await recordAuditEvent(tx, {
          actorUserId: request.authUser!.id,
          action: 'update-release.publish',
          targetType: 'update-release',
          targetId: created.id,
          traceId: request.id,
          metadata: { version: body.version },
        });
        return created;
      });
      return reply.status(201).send(release);
    },
  );
}

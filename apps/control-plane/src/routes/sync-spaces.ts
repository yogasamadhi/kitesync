import { createHash, randomUUID } from 'node:crypto';
import {
  CreateSpaceShareRequestSchema,
  CreateSyncSpaceRequestSchema,
  ProblemDetailsSchema,
  SpaceShareSchema,
  SyncSpaceOperationSchema,
  SyncSpaceSchema,
} from '@kitesync/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, notInArray, or, sql, sum } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import {
  devices,
  deviceSpaceBindings,
  hubs,
  idempotencyRecords,
  spaceShares,
  syncSpaces,
  users,
} from '../db/schema.js';
import { queueReconciliation, recordAuditEvent, recordDomainEvent } from '../application/events.js';
import {
  hashRequest,
  parseIfMatch,
  replayIdempotent,
  saveIdempotent,
} from '../application/idempotency.js';
import { requireAuth } from '../http/auth.js';
import { HttpProblem } from '../http/problem.js';
import { serializeSyncSpace } from '../http/serializers.js';

function folderId(id: string) {
  return 'ks-' + id.replaceAll('-', '').slice(0, 20);
}

export function registerSyncSpaceRoutes(app: FastifyInstance, db: Database) {
  app.get(
    '/api/v1/sync-spaces',
    {
      preHandler: requireAuth(db),
      schema: {
        operationId: 'listSyncSpaces',
        response: { 200: Type.Object({ items: Type.Array(SyncSpaceSchema) }) },
      },
    },
    async (request) => {
      const rows =
        request.authUser!.role === 'admin'
          ? await db.select().from(syncSpaces).orderBy(asc(syncSpaces.createdAt))
          : await db
              .selectDistinct({ space: syncSpaces })
              .from(syncSpaces)
              .leftJoin(spaceShares, eq(spaceShares.syncSpaceId, syncSpaces.id))
              .where(
                or(
                  eq(syncSpaces.ownerUserId, request.authUser!.id),
                  and(
                    eq(spaceShares.userId, request.authUser!.id),
                    eq(spaceShares.state, 'accepted'),
                  ),
                ),
              )
              .orderBy(asc(syncSpaces.createdAt));
      return {
        items: rows.map((row) => serializeSyncSpace('space' in row ? row.space : row)),
      };
    },
  );

  app.get(
    '/api/v1/sync-spaces/:id/shares',
    {
      preHandler: requireAuth(db),
      schema: {
        operationId: 'listSpaceShares',
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 200: Type.Object({ items: Type.Array(SpaceShareSchema) }) },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const [space] = await db.select().from(syncSpaces).where(eq(syncSpaces.id, id)).limit(1);
      if (!space) throw new HttpProblem(404, 'SPACE_NOT_FOUND', 'Sync space was not found');
      if (request.authUser!.role !== 'admin' && space.ownerUserId !== request.authUser!.id) {
        throw new HttpProblem(403, 'FORBIDDEN', 'Only the owner or an admin can list shares');
      }
      const shares = await db.select().from(spaceShares).where(eq(spaceShares.syncSpaceId, id));
      return {
        items: shares.map((share) => ({
          id: share.id,
          syncSpaceId: share.syncSpaceId,
          userId: share.userId,
          state: share.state,
          createdAt: share.createdAt.toISOString(),
        })),
      };
    },
  );

  app.post(
    '/api/v1/sync-spaces',
    {
      preHandler: requireAuth(db),
      schema: {
        operationId: 'createSyncSpace',
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 8, maxLength: 128 }),
        }),
        body: CreateSyncSpaceRequestSchema,
        response: { 202: SyncSpaceOperationSchema, 409: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as { label: string; quotaBytes?: number };
      const key = request.headers['idempotency-key'] as string;
      const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const prior = await db
        .select()
        .from(idempotencyRecords)
        .where(
          and(eq(idempotencyRecords.userId, request.authUser!.id), eq(idempotencyRecords.key, key)),
        )
        .limit(1);
      if (prior[0]) {
        if (prior[0].requestHash !== requestHash) {
          throw new HttpProblem(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key was used with a different request',
          );
        }
        return reply.status(202).send(prior[0].responseBody);
      }

      const [hub] = await db.select().from(hubs).limit(1);
      if (!hub) throw new HttpProblem(503, 'HUB_UNAVAILABLE', 'No Hub is configured');
      const [allocation] = await db
        .select({ allocated: sum(syncSpaces.quotaBytes) })
        .from(syncSpaces)
        .where(and(eq(syncSpaces.hubId, hub.id), notInArray(syncSpaces.state, ['deleted'])));
      const requestedQuota = body.quotaBytes ?? 107_374_182_400;
      if (Number(allocation?.allocated ?? 0) + requestedQuota > hub.capacityBytes) {
        throw new HttpProblem(409, 'ORGANIZATION_QUOTA_EXCEEDED', 'Organization quota exceeded');
      }
      const id = randomUUID();
      const response = await db.transaction(async (tx) => {
        const [space] = await tx
          .insert(syncSpaces)
          .values({
            id,
            ownerUserId: request.authUser!.id,
            hubId: hub.id,
            label: body.label,
            syncthingFolderId: folderId(id),
            quotaBytes: requestedQuota,
          })
          .returning();
        if (!space) throw new Error('Failed to create sync space');
        const operationId = await queueReconciliation(tx, 'sync-space', id, space.revision);
        await recordDomainEvent(tx, {
          type: 'sync-space.created',
          aggregateId: id,
          payload: { label: space.label, ownerUserId: space.ownerUserId },
        });
        await recordAuditEvent(tx, {
          actorUserId: request.authUser!.id,
          action: 'sync-space.create',
          targetType: 'sync-space',
          targetId: id,
          traceId: request.id,
        });
        const result = {
          space: serializeSyncSpace(space),
          operationId,
          state: 'accepted' as const,
        };
        await tx.insert(idempotencyRecords).values({
          id: randomUUID(),
          userId: request.authUser!.id,
          key,
          operationId,
          requestHash,
          responseStatus: 202,
          responseBody: result,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        return result;
      });
      return reply.status(202).send(response);
    },
  );

  app.delete(
    '/api/v1/sync-spaces/:id/shares/:shareId',
    {
      preHandler: requireAuth(db),
      schema: {
        operationId: 'removeSpaceShare',
        params: Type.Object({
          id: Type.String({ format: 'uuid' }),
          shareId: Type.String({ format: 'uuid' }),
        }),
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 8 }),
          'if-match': Type.String(),
        }),
        response: { 200: SpaceShareSchema, 412: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const { id, shareId } = request.params as { id: string; shareId: string };
      const revision = parseIfMatch(request.headers['if-match']);
      const key = request.headers['idempotency-key'] as string;
      const requestHash = hashRequest({ action: 'remove-share', id, shareId, revision });
      const prior = await replayIdempotent(db, request.authUser!.id, key, requestHash);
      if (prior) return reply.status(200).send(prior.responseBody);
      const result = await db.transaction(async (tx) => {
        const [space] = await tx
          .select()
          .from(syncSpaces)
          .where(eq(syncSpaces.id, id))
          .limit(1)
          .for('update');
        if (!space) throw new HttpProblem(404, 'SPACE_NOT_FOUND', 'Sync space was not found');
        if (space.revision !== revision) {
          throw new HttpProblem(412, 'ETAG_STALE', 'The space changed; refresh and retry');
        }
        if (request.authUser!.role !== 'admin' && space.ownerUserId !== request.authUser!.id) {
          throw new HttpProblem(403, 'FORBIDDEN', 'Only the owner or an admin can remove shares');
        }
        const [share] = await tx
          .update(spaceShares)
          .set({ state: 'revoked', updatedAt: new Date() })
          .where(and(eq(spaceShares.id, shareId), eq(spaceShares.syncSpaceId, id)))
          .returning();
        if (!share) throw new HttpProblem(404, 'SHARE_NOT_FOUND', 'Space share was not found');

        const affected = await tx
          .select({ id: deviceSpaceBindings.id, revision: deviceSpaceBindings.revision })
          .from(deviceSpaceBindings)
          .innerJoin(devices, eq(devices.id, deviceSpaceBindings.deviceId))
          .where(
            and(
              eq(deviceSpaceBindings.syncSpaceId, id),
              eq(devices.userId, share.userId),
              notInArray(deviceSpaceBindings.state, ['removing', 'removed']),
            ),
          );
        if (affected.length) {
          await tx
            .update(deviceSpaceBindings)
            .set({
              state: 'removing',
              revision: sql`${deviceSpaceBindings.revision} + 1`,
              updatedAt: new Date(),
            })
            .where(
              inArray(
                deviceSpaceBindings.id,
                affected.map((binding) => binding.id),
              ),
            );
          for (const binding of affected) {
            await queueReconciliation(tx, 'device-binding', binding.id, binding.revision + 1);
          }
        }
        await tx
          .update(syncSpaces)
          .set({ revision: revision + 1, updatedAt: new Date() })
          .where(and(eq(syncSpaces.id, id), eq(syncSpaces.revision, revision)));
        await recordAuditEvent(tx, {
          actorUserId: request.authUser!.id,
          action: 'space-share.remove',
          targetType: 'space-share',
          targetId: share.id,
          traceId: request.id,
          metadata: { localFilesRetained: true, affectedBindings: affected.length },
        });
        const response = {
          id: share.id,
          syncSpaceId: share.syncSpaceId,
          userId: share.userId,
          state: share.state,
          createdAt: share.createdAt.toISOString(),
        };
        await saveIdempotent(tx, {
          userId: request.authUser!.id,
          key,
          operationId: share.id,
          requestHash,
          responseStatus: 200,
          responseBody: response,
        });
        return response;
      });
      return reply.status(200).send(result);
    },
  );

  app.post(
    '/api/v1/sync-spaces/:id/shares',
    {
      preHandler: requireAuth(db),
      schema: {
        operationId: 'shareSyncSpace',
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 8 }),
          'if-match': Type.String(),
        }),
        body: CreateSpaceShareRequestSchema,
        response: { 201: SpaceShareSchema, 403: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { userId: string };
      const revision = parseIfMatch(request.headers['if-match']);
      const key = request.headers['idempotency-key'] as string;
      const requestHash = hashRequest({ id, body, revision });
      const prior = await replayIdempotent(db, request.authUser!.id, key, requestHash);
      if (prior) return reply.status(201).send(prior.responseBody);
      const [space] = await db.select().from(syncSpaces).where(eq(syncSpaces.id, id)).limit(1);
      if (!space) throw new HttpProblem(404, 'SPACE_NOT_FOUND', 'Sync space was not found');
      if (space.revision !== revision) {
        throw new HttpProblem(412, 'ETAG_STALE', 'The space changed; refresh and retry');
      }
      if (request.authUser!.role !== 'admin' && space.ownerUserId !== request.authUser!.id) {
        throw new HttpProblem(403, 'FORBIDDEN', 'Only the owner or an admin can share this space');
      }
      const [targetUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, body.userId))
        .limit(1);
      if (!targetUser) throw new HttpProblem(404, 'USER_NOT_FOUND', 'User was not found');

      const shareId = randomUUID();
      const response = await db.transaction(async (tx) => {
        const [share] = await tx
          .insert(spaceShares)
          .values({ id: shareId, syncSpaceId: id, userId: body.userId })
          .returning();
        if (!share) throw new Error('Failed to share sync space');
        await tx
          .update(syncSpaces)
          .set({ revision: revision + 1, updatedAt: new Date() })
          .where(and(eq(syncSpaces.id, id), eq(syncSpaces.revision, revision)));
        const result = {
          id: share.id,
          syncSpaceId: share.syncSpaceId,
          userId: share.userId,
          state: share.state,
          createdAt: share.createdAt.toISOString(),
        };
        await saveIdempotent(tx, {
          userId: request.authUser!.id,
          key,
          operationId: share.id,
          requestHash,
          responseStatus: 201,
          responseBody: result,
        });
        return result;
      });
      return reply.status(201).send(response);
    },
  );

  app.patch(
    '/api/v1/sync-spaces/:id/quota',
    {
      preHandler: requireAuth(db, ['admin']),
      schema: {
        operationId: 'updateSyncSpaceQuota',
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        headers: Type.Object({ 'if-match': Type.String() }),
        body: Type.Object({ quotaBytes: Type.Integer({ minimum: 1 }) }),
        response: { 202: SyncSpaceOperationSchema, 412: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { quotaBytes } = request.body as { quotaBytes: number };
      const revision = parseIfMatch(request.headers['if-match']);
      const [space] = await db.select().from(syncSpaces).where(eq(syncSpaces.id, id)).limit(1);
      if (!space) throw new HttpProblem(404, 'SPACE_NOT_FOUND', 'Sync space was not found');
      if (space.revision !== revision) {
        throw new HttpProblem(412, 'ETAG_STALE', 'The space changed; refresh and retry');
      }
      const [hub] = await db.select().from(hubs).where(eq(hubs.id, space.hubId)).limit(1);
      if (!hub) throw new HttpProblem(503, 'HUB_UNAVAILABLE', 'Hub is not configured');
      const [allocation] = await db
        .select({ allocated: sum(syncSpaces.quotaBytes) })
        .from(syncSpaces)
        .where(and(eq(syncSpaces.hubId, hub.id), notInArray(syncSpaces.state, ['deleted'])));
      if (Number(allocation?.allocated ?? 0) - space.quotaBytes + quotaBytes > hub.capacityBytes) {
        throw new HttpProblem(409, 'ORGANIZATION_QUOTA_EXCEEDED', 'Organization quota exceeded');
      }
      const result = await db.transaction(async (tx) => {
        const nextRevision = revision + 1;
        const [updated] = await tx
          .update(syncSpaces)
          .set({
            quotaBytes,
            state:
              space.usedBytes > quotaBytes
                ? 'paused'
                : space.state === 'paused'
                  ? 'provisioning'
                  : space.state,
            revision: nextRevision,
            updatedAt: new Date(),
          })
          .where(and(eq(syncSpaces.id, id), eq(syncSpaces.revision, revision)))
          .returning();
        if (!updated)
          throw new HttpProblem(412, 'ETAG_STALE', 'The space changed; refresh and retry');
        const operationId = await queueReconciliation(tx, 'sync-space', id, nextRevision);
        await recordAuditEvent(tx, {
          actorUserId: request.authUser!.id,
          action: 'sync-space.quota-update',
          targetType: 'sync-space',
          targetId: id,
          traceId: request.id,
          metadata: { previousQuotaBytes: space.quotaBytes, quotaBytes },
        });
        return {
          space: serializeSyncSpace(updated),
          operationId,
          state: 'accepted' as const,
        };
      });
      return reply.status(202).send(result);
    },
  );

  app.delete(
    '/api/v1/sync-spaces/:id',
    {
      preHandler: requireAuth(db),
      schema: {
        operationId: 'deleteSyncSpace',
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 8 }),
          'if-match': Type.String(),
        }),
        response: { 202: SyncSpaceOperationSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const expectedRevision = parseIfMatch(request.headers['if-match']);
      const key = request.headers['idempotency-key'] as string;
      const requestHash = hashRequest({ action: 'delete', id, revision: expectedRevision });
      const prior = await replayIdempotent(db, request.authUser!.id, key, requestHash);
      if (prior) return reply.status(202).send(prior.responseBody);
      const [existing] = await db.select().from(syncSpaces).where(eq(syncSpaces.id, id)).limit(1);
      if (!existing) throw new HttpProblem(404, 'SPACE_NOT_FOUND', 'Sync space was not found');
      if (existing.revision !== expectedRevision) {
        throw new HttpProblem(412, 'ETAG_STALE', 'The space changed; refresh and retry');
      }
      if (request.authUser!.role !== 'admin' && existing.ownerUserId !== request.authUser!.id) {
        throw new HttpProblem(403, 'FORBIDDEN', 'Only the owner or an admin can delete this space');
      }
      const result = await db.transaction(async (tx) => {
        const revision = expectedRevision + 1;
        const [space] = await tx
          .update(syncSpaces)
          .set({
            state: 'retained',
            deleteAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            revision,
            updatedAt: new Date(),
          })
          .where(and(eq(syncSpaces.id, id), eq(syncSpaces.revision, expectedRevision)))
          .returning();
        if (!space) throw new Error('Failed to retain sync space');
        const operationId = await queueReconciliation(tx, 'sync-space', id, revision);
        await recordDomainEvent(tx, {
          type: 'sync-space.retained',
          aggregateId: id,
          payload: { deleteAfter: space.deleteAfter?.toISOString() },
        });
        const response = {
          space: serializeSyncSpace(space),
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
        return response;
      });
      return reply.status(202).send(result);
    },
  );
}

import { createHash, randomUUID } from 'node:crypto';
import {
  CreateDeviceSpaceBindingRequestSchema,
  DeviceSpaceBindingOperationSchema,
  DeviceSpaceBindingSchema,
  ProblemDetailsSchema,
} from '@kitesync/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, or, sql } from 'drizzle-orm';
import { queueReconciliation, recordAuditEvent, recordDomainEvent } from '../application/events.js';
import { hashRequest, replayIdempotent, saveIdempotent } from '../application/idempotency.js';
import type { Database } from '../db/index.js';
import {
  devices,
  deviceSpaceBindings,
  idempotencyRecords,
  spaceShares,
  syncSpaces,
} from '../db/schema.js';
import { requireAuth } from '../http/auth.js';
import { requireSupportedDesktopVersion } from '../http/client-version.js';
import { HttpProblem } from '../http/problem.js';
import { serializeBinding } from '../http/serializers.js';

function expectedRevision(header: string | string[] | undefined) {
  const raw = Array.isArray(header) ? header[0] : header;
  const match = raw?.match(/^(?:W\/)?"?(\d+)"?$/);
  if (!match)
    throw new HttpProblem(428, 'IF_MATCH_REQUIRED', 'A valid If-Match revision is required');
  return Number(match[1]);
}

export function registerDeviceBindingRoutes(app: FastifyInstance, db: Database) {
  app.get(
    '/api/v1/device-bindings',
    {
      preHandler: requireAuth(db),
      schema: {
        querystring: Type.Object({ deviceId: Type.Optional(Type.String({ format: 'uuid' })) }),
        response: { 200: Type.Object({ items: Type.Array(DeviceSpaceBindingSchema) }) },
      },
    },
    async (request) => {
      const query = request.query as { deviceId?: string };
      const rows = await db
        .select({ binding: deviceSpaceBindings, ownerUserId: devices.userId })
        .from(deviceSpaceBindings)
        .innerJoin(devices, eq(devices.id, deviceSpaceBindings.deviceId))
        .where(
          and(
            query.deviceId ? eq(deviceSpaceBindings.deviceId, query.deviceId) : undefined,
            request.authUser!.role === 'admin'
              ? undefined
              : eq(devices.userId, request.authUser!.id),
          ),
        );
      return { items: rows.map((row) => serializeBinding(row.binding)) };
    },
  );

  app.post(
    '/api/v1/device-bindings',
    {
      preHandler: [requireAuth(db), requireSupportedDesktopVersion(db)],
      schema: {
        headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 8, maxLength: 128 }) }),
        body: CreateDeviceSpaceBindingRequestSchema,
        response: { 202: DeviceSpaceBindingOperationSchema, 403: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as { syncSpaceId: string; deviceId: string };
      const key = request.headers['idempotency-key'] as string;
      const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const [prior] = await db
        .select()
        .from(idempotencyRecords)
        .where(
          and(eq(idempotencyRecords.userId, request.authUser!.id), eq(idempotencyRecords.key, key)),
        )
        .limit(1);
      if (prior) {
        if (prior.requestHash !== requestHash)
          throw new HttpProblem(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was reused');
        return reply.status(202).send(prior.responseBody);
      }

      const [device] = await db
        .select()
        .from(devices)
        .where(eq(devices.id, body.deviceId))
        .limit(1);
      if (
        !device ||
        (request.authUser!.role !== 'admin' && device.userId !== request.authUser!.id)
      ) {
        throw new HttpProblem(403, 'DEVICE_NOT_ALLOWED', 'The device does not belong to this user');
      }
      if (device.state !== 'active')
        throw new HttpProblem(409, 'DEVICE_NOT_READY', 'The device is not active');
      const [space] = await db
        .select({ space: syncSpaces, share: spaceShares })
        .from(syncSpaces)
        .leftJoin(
          spaceShares,
          and(
            eq(spaceShares.syncSpaceId, syncSpaces.id),
            eq(spaceShares.userId, request.authUser!.id),
          ),
        )
        .where(
          and(
            eq(syncSpaces.id, body.syncSpaceId),
            or(
              eq(syncSpaces.ownerUserId, request.authUser!.id),
              eq(spaceShares.userId, request.authUser!.id),
            ),
          ),
        )
        .limit(1);
      if (!space)
        throw new HttpProblem(403, 'SPACE_NOT_ALLOWED', 'This space was not offered to the user');

      const result = await db.transaction(async (tx) => {
        if (space.share?.state === 'invited') {
          await tx
            .update(spaceShares)
            .set({ state: 'accepted', updatedAt: new Date() })
            .where(eq(spaceShares.id, space.share.id));
        }
        const [binding] = await tx
          .insert(deviceSpaceBindings)
          .values({
            id: randomUUID(),
            syncSpaceId: body.syncSpaceId,
            deviceId: body.deviceId,
            state: 'provisioning',
          })
          .onConflictDoUpdate({
            target: [deviceSpaceBindings.syncSpaceId, deviceSpaceBindings.deviceId],
            set: {
              state: 'provisioning',
              revision: sql`${deviceSpaceBindings.revision} + 1`,
              updatedAt: new Date(),
            },
          })
          .returning();
        if (!binding) throw new Error('Failed to create device binding');
        const operationId = await queueReconciliation(
          tx,
          'device-binding',
          binding.id,
          binding.revision,
        );
        await recordDomainEvent(tx, {
          type: 'device-binding.created',
          aggregateId: binding.id,
          payload: body,
        });
        await recordAuditEvent(tx, {
          actorUserId: request.authUser!.id,
          action: 'device-binding.create',
          targetType: 'device-binding',
          targetId: binding.id,
          traceId: request.id,
        });
        const response = {
          binding: serializeBinding(binding),
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
          responseBody: response,
          expiresAt: new Date(Date.now() + 86_400_000),
        });
        return response;
      });
      return reply.status(202).send(result);
    },
  );

  for (const action of ['pause', 'resume'] as const) {
    app.post(
      `/api/v1/device-bindings/:id/${action}`,
      {
        preHandler: [requireAuth(db), requireSupportedDesktopVersion(db)],
        schema: {
          params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
          headers: Type.Object({ 'if-match': Type.String() }),
          response: { 202: DeviceSpaceBindingOperationSchema, 412: ProblemDetailsSchema },
        },
      },
      async (request, reply) =>
        mutateBinding(request, reply, action === 'pause' ? 'paused' : 'provisioning'),
    );
  }

  app.delete(
    '/api/v1/device-bindings/:id',
    {
      preHandler: [requireAuth(db), requireSupportedDesktopVersion(db)],
      schema: {
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 8 }),
          'if-match': Type.String(),
        }),
        response: { 202: DeviceSpaceBindingOperationSchema, 412: ProblemDetailsSchema },
      },
    },
    async (request, reply) => mutateBinding(request, reply, 'removing'),
  );

  async function mutateBinding(
    request: FastifyRequest,
    reply: FastifyReply,
    state: 'paused' | 'provisioning' | 'removing',
  ) {
    const id = (request.params as { id: string }).id;
    const revision = expectedRevision(request.headers['if-match']);
    const key = state === 'removing' ? (request.headers['idempotency-key'] as string) : undefined;
    const requestHash = key ? hashRequest({ action: 'unbind', id, revision }) : undefined;
    if (key && requestHash) {
      const prior = await replayIdempotent(db, request.authUser!.id, key, requestHash);
      if (prior) return reply.status(202).send(prior.responseBody);
    }
    const [owned] = await db
      .select({ binding: deviceSpaceBindings, ownerUserId: devices.userId })
      .from(deviceSpaceBindings)
      .innerJoin(devices, eq(devices.id, deviceSpaceBindings.deviceId))
      .where(eq(deviceSpaceBindings.id, id))
      .limit(1);
    if (!owned) throw new HttpProblem(404, 'BINDING_NOT_FOUND', 'Device binding was not found');
    if (request.authUser!.role !== 'admin' && owned.ownerUserId !== request.authUser!.id)
      throw new HttpProblem(403, 'FORBIDDEN', 'This binding belongs to another user');
    if (owned.binding.revision !== revision)
      throw new HttpProblem(412, 'ETAG_STALE', 'The binding changed; refresh and retry');
    const nextRevision = revision + 1;
    const result = await db.transaction(async (tx) => {
      const [binding] = await tx
        .update(deviceSpaceBindings)
        .set({ state, revision: nextRevision, updatedAt: new Date() })
        .where(and(eq(deviceSpaceBindings.id, id), eq(deviceSpaceBindings.revision, revision)))
        .returning();
      if (!binding)
        throw new HttpProblem(412, 'ETAG_STALE', 'The binding changed; refresh and retry');
      const operationId = await queueReconciliation(tx, 'device-binding', id, nextRevision);
      const response = {
        binding: serializeBinding(binding),
        operationId,
        state: 'accepted' as const,
      };
      if (key && requestHash) {
        await saveIdempotent(tx, {
          userId: request.authUser!.id,
          key,
          operationId,
          requestHash,
          responseStatus: 202,
          responseBody: response,
        });
      }
      return response;
    });
    return reply.status(202).send(result);
  }
}

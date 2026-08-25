import { createPublicKey, randomUUID, verify } from 'node:crypto';
import {
  DeviceActionResponseSchema,
  DeviceSchema,
  canonicalJson,
  ProblemDetailsSchema,
  RegisterDeviceRequestSchema,
} from '@kitesync/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { devices, hubs } from '../db/schema.js';
import { queueReconciliation, recordAuditEvent, recordDomainEvent } from '../application/events.js';
import {
  hashRequest,
  parseIfMatch,
  replayIdempotent,
  saveIdempotent,
} from '../application/idempotency.js';
import { requireAuth } from '../http/auth.js';
import { requireSupportedDesktopVersion } from '../http/client-version.js';
import { HttpProblem } from '../http/problem.js';
import { serializeDevice } from '../http/serializers.js';

export function registerDeviceRoutes(app: FastifyInstance, db: Database) {
  app.get(
    '/api/v1/devices',
    {
      preHandler: requireAuth(db),
      schema: {
        operationId: 'listDevices',
        response: { 200: Type.Object({ items: Type.Array(DeviceSchema) }) },
      },
    },
    async (request) => {
      const rows =
        request.authUser!.role === 'admin'
          ? await db.select().from(devices).orderBy(asc(devices.createdAt))
          : await db
              .select()
              .from(devices)
              .where(eq(devices.userId, request.authUser!.id))
              .orderBy(asc(devices.createdAt));
      return { items: rows.map(serializeDevice) };
    },
  );

  for (const action of ['suspend', 'resume'] as const) {
    app.post(
      `/api/v1/devices/:id/${action}`,
      {
        preHandler: requireAuth(db, ['admin']),
        schema: {
          operationId: action === 'suspend' ? 'suspendDevice' : 'resumeDevice',
          params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
          headers: Type.Object({
            'idempotency-key': Type.String({ minLength: 8 }),
            'if-match': Type.String(),
          }),
          response: { 202: DeviceActionResponseSchema, 412: ProblemDetailsSchema },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const revision = parseIfMatch(request.headers['if-match']);
        const key = request.headers['idempotency-key'] as string;
        const requestHash = hashRequest({ action, id, revision });
        const prior = await replayIdempotent(db, request.authUser!.id, key, requestHash);
        if (prior) return reply.status(202).send(prior.responseBody);
        const result = await db.transaction(async (tx) => {
          const [existing] = await tx
            .select()
            .from(devices)
            .where(eq(devices.id, id))
            .limit(1)
            .for('update');
          if (!existing) throw new HttpProblem(404, 'DEVICE_NOT_FOUND', 'Device was not found');
          if (existing.revision !== revision) {
            throw new HttpProblem(412, 'ETAG_STALE', 'The device changed; refresh and retry');
          }
          if (action === 'suspend' && existing.state !== 'active') {
            throw new HttpProblem(409, 'DEVICE_NOT_ACTIVE', 'Only an active device can be paused');
          }
          if (action === 'resume' && existing.state !== 'suspended') {
            throw new HttpProblem(409, 'DEVICE_NOT_SUSPENDED', 'Only a paused device can resume');
          }
          const [device] = await tx
            .update(devices)
            .set({
              state: action === 'suspend' ? 'suspended' : 'verifying_syncthing_identity',
              revision: revision + 1,
              updatedAt: new Date(),
            })
            .where(and(eq(devices.id, id), eq(devices.revision, revision)))
            .returning();
          if (!device) throw new HttpProblem(412, 'ETAG_STALE', 'The device changed; retry');
          const operationId = await queueReconciliation(tx, 'device', id, device.revision);
          await recordDomainEvent(tx, {
            type: action === 'suspend' ? 'device.suspended' : 'device.resumed',
            aggregateId: id,
            payload: { state: device.state },
          });
          await recordAuditEvent(tx, {
            actorUserId: request.authUser!.id,
            action: `device.${action}`,
            targetType: 'device',
            targetId: id,
            traceId: request.id,
          });
          const response = { device: serializeDevice(device), operationId };
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

  app.post(
    '/api/v1/device-registrations',
    {
      preHandler: [requireAuth(db), requireSupportedDesktopVersion(db)],
      schema: {
        operationId: 'registerDevice',
        headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 8 }) }),
        body: RegisterDeviceRequestSchema,
        response: { 202: DeviceActionResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        displayName: string;
        platform: 'windows' | 'macos' | 'linux';
        productPublicKey: string;
        syncthingDeviceId: string;
        registrationNonce: string;
        signature: string;
      };
      const key = request.headers['idempotency-key'] as string;
      const requestHash = hashRequest(body);
      const prior = await replayIdempotent(db, request.authUser!.id, key, requestHash);
      if (prior) return reply.status(202).send(prior.responseBody);
      const { signature, ...registration } = body;
      let proofValid = false;
      try {
        proofValid = verify(
          null,
          Buffer.from(canonicalJson(registration)),
          createPublicKey({
            key: Buffer.from(body.productPublicKey, 'base64'),
            format: 'der',
            type: 'spki',
          }),
          Buffer.from(signature, 'base64'),
        );
      } catch {
        proofValid = false;
      }
      if (!proofValid) {
        throw new HttpProblem(400, 'DEVICE_PROOF_INVALID', 'Product device key proof is invalid');
      }
      const deviceId = randomUUID();
      const [hub] = await db.select({ id: hubs.id }).from(hubs).limit(1);
      const result = await db.transaction(async (tx) => {
        const [device] = await tx
          .insert(devices)
          .values({
            id: deviceId,
            userId: request.authUser!.id,
            hubId: hub?.id,
            displayName: body.displayName,
            platform: body.platform,
            productPublicKey: body.productPublicKey,
            syncthingDeviceId: body.syncthingDeviceId,
          })
          .returning();
        if (!device) throw new Error('Failed to create device');
        const operationId = await queueReconciliation(tx, 'device', device.id, device.revision);
        await recordDomainEvent(tx, {
          type: 'device.registered',
          aggregateId: device.id,
          payload: { userId: device.userId, platform: device.platform },
        });
        const response = { device: serializeDevice(device), operationId };
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

  app.post(
    '/api/v1/devices/:id/approve',
    {
      preHandler: requireAuth(db, ['admin']),
      schema: {
        operationId: 'approveDevice',
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 8 }),
          'if-match': Type.String(),
        }),
        response: { 202: DeviceActionResponseSchema, 404: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const revision = parseIfMatch(request.headers['if-match']);
      const key = request.headers['idempotency-key'] as string;
      const requestHash = hashRequest({ action: 'approve', id, revision });
      const prior = await replayIdempotent(db, request.authUser!.id, key, requestHash);
      if (prior) return reply.status(202).send(prior.responseBody);
      const result = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(devices)
          .where(eq(devices.id, id))
          .limit(1)
          .for('update');
        if (!existing) throw new HttpProblem(404, 'DEVICE_NOT_FOUND', 'Device was not found');
        if (existing.revision !== revision) {
          throw new HttpProblem(412, 'ETAG_STALE', 'The device changed; refresh and retry');
        }
        const [device] = await tx
          .update(devices)
          .set({
            state: 'verifying_syncthing_identity',
            revision: revision + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(devices.id, id), eq(devices.revision, revision)))
          .returning();
        if (!device) throw new HttpProblem(412, 'ETAG_STALE', 'The device changed; retry');
        const operationId = await queueReconciliation(tx, 'device', id, device.revision);
        await recordDomainEvent(tx, {
          type: 'device.approved',
          aggregateId: id,
          payload: { state: device.state },
        });
        await recordAuditEvent(tx, {
          actorUserId: request.authUser!.id,
          action: 'device.approve',
          targetType: 'device',
          targetId: id,
          traceId: request.id,
        });
        const response = { device: serializeDevice(device), operationId };
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

  app.delete(
    '/api/v1/devices/:id',
    {
      preHandler: requireAuth(db, ['admin']),
      schema: {
        operationId: 'revokeDevice',
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        headers: Type.Object({
          'idempotency-key': Type.String({ minLength: 8 }),
          'if-match': Type.String(),
        }),
        response: { 202: DeviceActionResponseSchema, 404: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const revision = parseIfMatch(request.headers['if-match']);
      const key = request.headers['idempotency-key'] as string;
      const requestHash = hashRequest({ action: 'revoke', id, revision });
      const prior = await replayIdempotent(db, request.authUser!.id, key, requestHash);
      if (prior) return reply.status(202).send(prior.responseBody);
      const result = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(devices)
          .where(eq(devices.id, id))
          .limit(1)
          .for('update');
        if (!existing) throw new HttpProblem(404, 'DEVICE_NOT_FOUND', 'Device was not found');
        if (existing.revision !== revision) {
          throw new HttpProblem(412, 'ETAG_STALE', 'The device changed; refresh and retry');
        }
        const [device] = await tx
          .update(devices)
          .set({ state: 'revoking', revision: revision + 1, updatedAt: new Date() })
          .where(and(eq(devices.id, id), eq(devices.revision, revision)))
          .returning();
        if (!device) throw new HttpProblem(412, 'ETAG_STALE', 'The device changed; retry');
        const operationId = await queueReconciliation(tx, 'device', id, device.revision);
        await recordDomainEvent(tx, {
          type: 'device.revocation.requested',
          aggregateId: id,
          payload: {},
        });
        await recordAuditEvent(tx, {
          actorUserId: request.authUser!.id,
          action: 'device.revoke',
          targetType: 'device',
          targetId: id,
          traceId: request.id,
        });
        const response = { device: serializeDevice(device), operationId };
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

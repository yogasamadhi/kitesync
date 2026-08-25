import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { and, eq, or } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { devices, hubs, spaceShares, syncSpaces } from '../db/schema.js';
import { requireAuth } from '../http/auth.js';
import { HttpProblem } from '../http/problem.js';
import { serializeSyncSpace } from '../http/serializers.js';

export function registerDesktopRoutes(app: FastifyInstance, db: Database) {
  app.get(
    '/api/v1/desktop/configuration',
    {
      preHandler: requireAuth(db),
      schema: { querystring: Type.Object({ deviceId: Type.String({ format: 'uuid' }) }) },
    },
    async (request) => {
      const { deviceId } = request.query as { deviceId: string };
      const [device] = await db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
      if (!device || device.userId !== request.authUser!.id)
        throw new HttpProblem(403, 'DEVICE_NOT_ALLOWED', 'Device does not belong to this account');
      if (!device.hubId) throw new HttpProblem(503, 'HUB_UNAVAILABLE', 'Hub is not assigned');
      const [hub] = await db.select().from(hubs).where(eq(hubs.id, device.hubId)).limit(1);
      if (!hub) throw new HttpProblem(503, 'HUB_UNAVAILABLE', 'Hub is not configured');
      return {
        device: { id: device.id, state: device.state },
        hub: { id: hub.id, syncthingDeviceId: hub.syncthingDeviceId, addresses: [hub.endpoint] },
      };
    },
  );

  app.get('/api/v1/offers', { preHandler: requireAuth(db) }, async (request) => {
    const rows = await db
      .selectDistinct({ space: syncSpaces })
      .from(syncSpaces)
      .leftJoin(spaceShares, eq(spaceShares.syncSpaceId, syncSpaces.id))
      .where(
        and(
          or(
            eq(syncSpaces.ownerUserId, request.authUser!.id),
            eq(spaceShares.userId, request.authUser!.id),
          ),
          or(
            eq(spaceShares.state, 'invited'),
            eq(spaceShares.state, 'accepted'),
            eq(syncSpaces.ownerUserId, request.authUser!.id),
          ),
        ),
      );
    return { items: rows.map((row) => serializeSyncSpace(row.space)) };
  });
}

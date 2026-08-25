import type { FastifyInstance } from 'fastify';
import { asc, gt } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { domainEvents } from '../db/schema.js';
import { requireAuth } from '../http/auth.js';

export function registerEventRoutes(app: FastifyInstance, db: Database) {
  app.get(
    '/api/v1/events',
    {
      preHandler: requireAuth(db),
      schema: { operationId: 'streamEvents' },
    },
    async (request, reply) => {
      const query = request.query as { cursor?: string };
      let cursor = Number(query.cursor ?? '0');
      if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;

      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let closed = false;
      request.raw.once('close', () => {
        closed = true;
      });

      while (!closed) {
        const events = await db
          .select()
          .from(domainEvents)
          .where(gt(domainEvents.cursor, cursor))
          .orderBy(asc(domainEvents.cursor))
          .limit(100);

        for (const event of events) {
          cursor = event.cursor;
          reply.raw.write('id: ' + event.cursor + '\n');
          reply.raw.write('event: ' + event.type + '\n');
          reply.raw.write(
            'data: ' +
              JSON.stringify({
                id: event.id,
                cursor: event.cursor,
                type: event.type,
                schemaVersion: event.schemaVersion,
                occurredAt: event.occurredAt.toISOString(),
                producer: event.producer,
                aggregateId: event.aggregateId,
                payload: event.payload,
              }) +
              '\n\n',
          );
        }

        if (events.length === 0) {
          reply.raw.write(': heartbeat\n\n');
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
      reply.raw.end();
    },
  );
}

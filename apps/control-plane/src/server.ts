import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import type { FastifyError } from 'fastify';
import type { ControlPlaneConfig } from './config.js';
import { HubAgentClient } from './application/hub-agent-client.js';
import { ReconciliationWorker } from './application/reconciliation-worker.js';
import { createDatabase } from './db/index.js';
import { hubs } from './db/schema.js';
import { HttpProblem, sendProblem } from './http/problem.js';
import { safeErrorLog } from './logging.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAccountLifecycleRoutes } from './routes/account-lifecycle.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerDeviceBindingRoutes } from './routes/device-bindings.js';
import { registerDesktopRoutes } from './routes/desktop.js';
import { registerEventRoutes } from './routes/events.js';
import { registerSyncSpaceRoutes } from './routes/sync-spaces.js';
import { registerOperationRoutes } from './routes/operations.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerUserRoutes } from './routes/users.js';

export async function createServer(config: ControlPlaneConfig) {
  const app = Fastify({
    logger: {
      level: process.env.KITESYNC_LOG_LEVEL ?? 'info',
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers.set-cookie',
        'body.password',
        'body.token',
      ],
    },
    genReqId: () => randomUUID(),
  });
  const database = createDatabase(config);
  await database.db.update(hubs).set({ endpoint: config.hubPublicAddress, updatedAt: new Date() });
  const hubAgent = new HubAgentClient(config);
  const worker = new ReconciliationWorker(database.db, hubAgent, app.log);
  const runtime = {
    runtimeId: randomUUID(),
    generation: randomUUID(),
    startedAt: new Date(),
  };

  await app.register(sensible);
  await app.register(cookie, { secret: config.cookieSecret });
  await app.register(cors, {
    credentials: true,
    origin: (origin, callback) => {
      if (!origin || origin === config.publicUrl || /^https?:\/\/localhost:\d+$/.test(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Origin not allowed'), false);
      }
    },
  });
  await app.register(rateLimit, { global: false });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Trace-ID', request.id);
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    if (reply.hasHeader('ETag')) return payload;
    try {
      const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
      if (typeof text !== 'string' || !text.startsWith('{')) return payload;
      const body = JSON.parse(text) as {
        revision?: number;
        device?: { revision?: number };
        space?: { revision?: number };
        binding?: { revision?: number };
      };
      const revision =
        body.revision ?? body.device?.revision ?? body.space?.revision ?? body.binding?.revision;
      if (Number.isInteger(revision)) reply.header('ETag', `"${revision}"`);
    } catch {
      // Streaming and non-JSON responses do not carry a resource ETag.
    }
    return payload;
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'KiteSync Control Plane API', version: '1.0.0' },
      servers: [{ url: config.publicUrl }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpProblem) return sendProblem(request, reply, error);
    if ('validation' in error && error.validation) {
      return sendProblem(
        request,
        reply,
        new HttpProblem(400, 'VALIDATION_ERROR', 'Request validation failed', error.message),
      );
    }
    request.log.error({ error: safeErrorLog(error) }, 'Unhandled request error');
    return sendProblem(
      request,
      reply,
      new HttpProblem(500, 'INTERNAL_ERROR', 'Internal server error'),
    );
  });

  registerSystemRoutes(app, { db: database.db, ...runtime });
  registerAuthRoutes(app, { db: database.db, config });
  registerAccountLifecycleRoutes(app, { db: database.db, config });
  registerUserRoutes(app, database.db);
  registerDeviceRoutes(app, database.db);
  registerDeviceBindingRoutes(app, database.db);
  registerDesktopRoutes(app, database.db);
  registerSyncSpaceRoutes(app, database.db);
  registerOperationRoutes(app, database.db, hubAgent, config);
  registerEventRoutes(app, database.db);

  app.addHook('onReady', async () => worker.start());

  app.addHook('onClose', async () => {
    await worker.stop();
    await database.pool.end();
  });

  return app;
}

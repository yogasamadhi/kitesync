import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { CreateUserRequestSchema, ProblemDetailsSchema, UserSchema } from '@kitesync/contracts';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { users } from '../db/schema.js';
import { recordAuditEvent, recordDomainEvent } from '../application/events.js';
import { hashRequest, replayIdempotent, saveIdempotent } from '../application/idempotency.js';
import { requireAuth } from '../http/auth.js';
import { HttpProblem } from '../http/problem.js';
import { serializeUser } from '../http/serializers.js';

export function registerUserRoutes(app: FastifyInstance, db: Database) {
  app.get(
    '/api/v1/users',
    {
      preHandler: requireAuth(db),
      schema: {
        operationId: 'listUsers',
        response: { 200: Type.Object({ items: Type.Array(UserSchema) }) },
      },
    },
    async () => {
      const rows = await db.select().from(users).orderBy(asc(users.username));
      return { items: rows.map(serializeUser) };
    },
  );

  app.post(
    '/api/v1/users',
    {
      preHandler: requireAuth(db, ['admin']),
      schema: {
        operationId: 'createUser',
        headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 8 }) }),
        body: CreateUserRequestSchema,
        response: { 201: UserSchema, 409: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        username: string;
        displayName: string;
        password: string;
        role?: 'admin' | 'member';
      };
      const key = request.headers['idempotency-key'] as string;
      const requestHash = hashRequest(body);
      const prior = await replayIdempotent(db, request.authUser!.id, key, requestHash);
      if (prior) return reply.status(201).send(prior.responseBody);
      const exists = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, body.username.toLowerCase()))
        .limit(1);
      if (exists.length) throw new HttpProblem(409, 'USERNAME_EXISTS', 'Username already exists');

      const userId = randomUUID();
      const [user] = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(users)
          .values({
            id: userId,
            username: body.username.toLowerCase(),
            displayName: body.displayName,
            passwordHash: await argon2.hash(body.password, { type: argon2.argon2id }),
            role: body.role ?? 'member',
          })
          .returning();
        await recordDomainEvent(tx, {
          type: 'user.created',
          aggregateId: userId,
          payload: { username: body.username.toLowerCase(), role: body.role ?? 'member' },
        });
        await recordAuditEvent(tx, {
          actorUserId: request.authUser!.id,
          action: 'user.create',
          targetType: 'user',
          targetId: userId,
          traceId: request.id,
        });
        if (inserted[0]) {
          await saveIdempotent(tx, {
            userId: request.authUser!.id,
            key,
            operationId: userId,
            requestHash,
            responseStatus: 201,
            responseBody: serializeUser(inserted[0]),
          });
        }
        return inserted;
      });
      if (!user) throw new Error('Failed to create user');
      return reply.status(201).send(serializeUser(user));
    },
  );
}

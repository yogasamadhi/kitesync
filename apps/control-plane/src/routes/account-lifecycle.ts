import { createHmac, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import {
  AcceptInvitationRequestSchema,
  CreateInvitationRequestSchema,
  InvitationSchema,
  MessageResponseSchema,
  PasswordResetTokenSchema,
  ProblemDetailsSchema,
  ResetPasswordRequestSchema,
  SessionSchema,
  UserSessionSchema,
} from '@kitesync/contracts';
import { Type } from '@sinclair/typebox';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ControlPlaneConfig } from '../config.js';
import type { Database } from '../db/index.js';
import { accountTokens, desktopRefreshTokens, sessions, users } from '../db/schema.js';
import { recordAuditEvent, recordDomainEvent } from '../application/events.js';
import { hashRequest, replayIdempotent, saveIdempotent } from '../application/idempotency.js';
import { createSession, hashToken, requireAuth } from '../http/auth.js';
import { HttpProblem } from '../http/problem.js';
import { serializeUser } from '../http/serializers.js';
import { sessionCookieOptions } from './auth.js';

function deterministicToken(
  secret: string,
  purpose: string,
  actor: string,
  key: string,
  hash: string,
) {
  return createHmac('sha256', secret)
    .update(`${purpose}:${actor}:${key}:${hash}`)
    .digest('base64url');
}

export function registerAccountLifecycleRoutes(
  app: FastifyInstance,
  context: { db: Database; config: ControlPlaneConfig },
) {
  app.post(
    '/api/v1/user-invitations',
    {
      preHandler: requireAuth(context.db, ['admin']),
      schema: {
        operationId: 'createUserInvitation',
        headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 8 }) }),
        body: CreateInvitationRequestSchema,
        response: { 201: InvitationSchema, 409: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        username: string;
        displayName: string;
        role?: 'admin' | 'member';
      };
      const normalized = {
        ...body,
        username: body.username.toLowerCase(),
        role: body.role ?? 'member',
      };
      const key = request.headers['idempotency-key'] as string;
      const requestHash = hashRequest(normalized);
      const token = deterministicToken(
        context.config.cookieSecret,
        'invite',
        request.authUser!.id,
        key,
        requestHash,
      );
      const prior = await replayIdempotent(context.db, request.authUser!.id, key, requestHash);
      if (prior) {
        return reply.status(201).send({ ...prior.responseBody, token });
      }
      const [existing] = await context.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, normalized.username))
        .limit(1);
      if (existing) throw new HttpProblem(409, 'USERNAME_EXISTS', 'Username already exists');

      const invitationId = randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 86_400_000);
      await context.db.transaction(async (tx) => {
        await tx.insert(accountTokens).values({
          id: invitationId,
          type: 'invitation',
          tokenHash: hashToken(token),
          payload: normalized,
          expiresAt,
          createdBy: request.authUser!.id,
        });
        await recordAuditEvent(tx, {
          actorUserId: request.authUser!.id,
          action: 'user.invite',
          targetType: 'user-invitation',
          targetId: invitationId,
          traceId: request.id,
          metadata: { username: normalized.username, role: normalized.role },
        });
        await saveIdempotent(tx, {
          userId: request.authUser!.id,
          key,
          operationId: invitationId,
          requestHash,
          responseStatus: 201,
          responseBody: {
            id: invitationId,
            username: normalized.username,
            expiresAt: expiresAt.toISOString(),
          },
        });
      });
      return reply.status(201).send({
        id: invitationId,
        username: normalized.username,
        token,
        expiresAt: expiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/api/v1/user-invitations/accept',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        operationId: 'acceptUserInvitation',
        body: AcceptInvitationRequestSchema,
        response: { 201: SessionSchema, 401: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as { token: string; password: string };
      const [user] = await context.db.transaction(async (tx) => {
        const [invitation] = await tx
          .select()
          .from(accountTokens)
          .where(
            and(
              eq(accountTokens.type, 'invitation'),
              eq(accountTokens.tokenHash, hashToken(body.token)),
              isNull(accountTokens.usedAt),
              gt(accountTokens.expiresAt, new Date()),
            ),
          )
          .limit(1)
          .for('update');
        if (!invitation) {
          throw new HttpProblem(401, 'INVITATION_INVALID', 'Invitation is invalid or expired');
        }
        const payload = invitation.payload as {
          username: string;
          displayName: string;
          role: 'admin' | 'member';
        };
        const inserted = await tx
          .insert(users)
          .values({
            id: randomUUID(),
            username: payload.username,
            displayName: payload.displayName,
            role: payload.role,
            passwordHash: await argon2.hash(body.password, { type: argon2.argon2id }),
          })
          .returning();
        await tx
          .update(accountTokens)
          .set({ usedAt: new Date() })
          .where(eq(accountTokens.id, invitation.id));
        if (inserted[0]) {
          await recordDomainEvent(tx, {
            type: 'user.invitation-accepted',
            aggregateId: inserted[0].id,
            payload: { invitationId: invitation.id },
          });
        }
        return inserted;
      });
      if (!user) throw new Error('Failed to accept invitation');
      const session = await createSession(context.db, user.id, context.config.sessionTtlHours);
      reply.setCookie(
        'kitesync_session',
        session.accessToken,
        sessionCookieOptions(context.config, session.expiresAt),
      );
      return reply.status(201).send({
        user: serializeUser(user),
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/api/v1/users/:id/password-reset-token',
    {
      preHandler: requireAuth(context.db, ['admin']),
      schema: {
        operationId: 'createPasswordResetToken',
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        headers: Type.Object({ 'idempotency-key': Type.String({ minLength: 8 }) }),
        response: { 201: PasswordResetTokenSchema, 404: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const key = request.headers['idempotency-key'] as string;
      const requestHash = hashRequest({ action: 'password-reset', id });
      const token = deterministicToken(
        context.config.cookieSecret,
        'password-reset',
        request.authUser!.id,
        key,
        requestHash,
      );
      const prior = await replayIdempotent(context.db, request.authUser!.id, key, requestHash);
      if (prior) return reply.status(201).send({ ...prior.responseBody, token });
      const [user] = await context.db.select().from(users).where(eq(users.id, id)).limit(1);
      if (!user) throw new HttpProblem(404, 'USER_NOT_FOUND', 'User was not found');
      const expiresAt = new Date(Date.now() + 60 * 60_000);
      const operationId = randomUUID();
      await context.db.transaction(async (tx) => {
        await tx
          .update(accountTokens)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(accountTokens.type, 'password-reset'),
              eq(accountTokens.userId, id),
              isNull(accountTokens.usedAt),
            ),
          );
        await tx.insert(accountTokens).values({
          id: operationId,
          type: 'password-reset',
          tokenHash: hashToken(token),
          userId: id,
          expiresAt,
          createdBy: request.authUser!.id,
        });
        await recordAuditEvent(tx, {
          actorUserId: request.authUser!.id,
          action: 'password-reset.issue',
          targetType: 'user',
          targetId: id,
          traceId: request.id,
        });
        await saveIdempotent(tx, {
          userId: request.authUser!.id,
          key,
          operationId,
          requestHash,
          responseStatus: 201,
          responseBody: { expiresAt: expiresAt.toISOString() },
        });
      });
      return reply.status(201).send({ token, expiresAt: expiresAt.toISOString() });
    },
  );

  app.post(
    '/api/v1/password-resets',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        operationId: 'resetPassword',
        body: ResetPasswordRequestSchema,
        response: { 200: MessageResponseSchema, 401: ProblemDetailsSchema },
      },
    },
    async (request) => {
      const body = request.body as { token: string; password: string };
      await context.db.transaction(async (tx) => {
        const [reset] = await tx
          .select()
          .from(accountTokens)
          .where(
            and(
              eq(accountTokens.type, 'password-reset'),
              eq(accountTokens.tokenHash, hashToken(body.token)),
              isNull(accountTokens.usedAt),
              gt(accountTokens.expiresAt, new Date()),
            ),
          )
          .limit(1)
          .for('update');
        if (!reset?.userId) {
          throw new HttpProblem(401, 'PASSWORD_RESET_INVALID', 'Reset token is invalid or expired');
        }
        await tx
          .update(users)
          .set({
            passwordHash: await argon2.hash(body.password, { type: argon2.argon2id }),
            updatedAt: new Date(),
          })
          .where(eq(users.id, reset.userId));
        await tx
          .update(accountTokens)
          .set({ usedAt: new Date() })
          .where(eq(accountTokens.id, reset.id));
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(eq(sessions.userId, reset.userId));
        await tx
          .update(desktopRefreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(desktopRefreshTokens.userId, reset.userId));
        await recordDomainEvent(tx, {
          type: 'user.password-reset',
          aggregateId: reset.userId,
          payload: {},
        });
      });
      return { message: 'Password reset; all sessions were revoked' };
    },
  );

  app.get(
    '/api/v1/sessions',
    {
      preHandler: requireAuth(context.db),
      schema: {
        operationId: 'listSessions',
        response: { 200: Type.Object({ items: Type.Array(UserSessionSchema) }) },
      },
    },
    async (request) => ({
      items: (
        await context.db
          .select()
          .from(sessions)
          .where(and(eq(sessions.userId, request.authUser!.id), isNull(sessions.revokedAt)))
          .orderBy(asc(sessions.createdAt))
      ).map((session) => ({
        id: session.id,
        userId: session.userId,
        current: session.id === request.authUser!.sessionId,
        expiresAt: session.expiresAt.toISOString(),
        lastUsedAt: session.lastUsedAt.toISOString(),
        createdAt: session.createdAt.toISOString(),
      })),
    }),
  );

  app.delete(
    '/api/v1/sessions/:id',
    {
      preHandler: requireAuth(context.db),
      schema: {
        operationId: 'revokeSession',
        params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
        response: { 200: MessageResponseSchema, 404: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [session] = await context.db
        .select()
        .from(sessions)
        .where(eq(sessions.id, id))
        .limit(1);
      if (!session || session.userId !== request.authUser!.id) {
        throw new HttpProblem(404, 'SESSION_NOT_FOUND', 'Session was not found');
      }
      await context.db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, session.id));
      if (session.id === request.authUser!.sessionId) {
        reply.clearCookie('kitesync_session', { path: '/' });
      }
      return { message: 'Session revoked' };
    },
  );
}

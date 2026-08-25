import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import {
  BootstrapAdminRequestSchema,
  DesktopSessionSchema,
  LoginRequestSchema,
  MessageResponseSchema,
  ProblemDetailsSchema,
  RefreshDesktopSessionRequestSchema,
  SessionSchema,
} from '@kitesync/contracts';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { ControlPlaneConfig } from '../config.js';
import type { Database } from '../db/index.js';
import { desktopRefreshTokens, sessions, users } from '../db/schema.js';
import { constantTimeStringEqual, createSession, hashToken, requireAuth } from '../http/auth.js';
import { HttpProblem } from '../http/problem.js';
import { serializeUser } from '../http/serializers.js';

export function sessionCookieOptions(config: ControlPlaneConfig, expiresAt: Date) {
  return {
    path: '/',
    httpOnly: true,
    secure: config.publicUrl.startsWith('https://'),
    sameSite: 'strict' as const,
    expires: expiresAt,
  };
}

export function registerAuthRoutes(
  app: FastifyInstance,
  context: { db: Database; config: ControlPlaneConfig },
) {
  async function verifyCredentials(username: string, password: string) {
    const [user] = await context.db
      .select()
      .from(users)
      .where(eq(users.username, username.toLowerCase()))
      .limit(1);
    if (!user?.active || !(await argon2.verify(user.passwordHash, password))) {
      throw new HttpProblem(401, 'CREDENTIALS_INVALID', 'Username or password is invalid');
    }
    return user;
  }

  async function issueDesktopSession(
    user: typeof users.$inferSelect,
    familyId: string = randomUUID(),
  ) {
    const access = await createSession(
      context.db,
      user.id,
      context.config.desktopAccessTtlMinutes / 60,
    );
    const refreshToken = randomBytes(48).toString('base64url');
    await context.db.insert(desktopRefreshTokens).values({
      id: randomUUID(),
      userId: user.id,
      familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + context.config.desktopRefreshTtlDays * 86_400_000),
    });
    return {
      user: serializeUser(user),
      csrfToken: access.csrfToken,
      expiresAt: access.expiresAt.toISOString(),
      accessToken: access.accessToken,
      refreshToken,
    };
  }

  app.post(
    '/api/v1/auth/bootstrap',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        operationId: 'bootstrapAdmin',
        body: BootstrapAdminRequestSchema,
        response: { 201: SessionSchema, 400: ProblemDetailsSchema, 409: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        token: string;
        username: string;
        displayName: string;
        password: string;
      };
      if (!constantTimeStringEqual(body.token, context.config.bootstrapToken)) {
        throw new HttpProblem(401, 'BOOTSTRAP_TOKEN_INVALID', 'Bootstrap token is invalid');
      }
      const existing = await context.db.select({ id: users.id }).from(users).limit(1);
      if (existing.length > 0) {
        throw new HttpProblem(409, 'ALREADY_BOOTSTRAPPED', 'Administrator already exists');
      }

      const id = randomUUID();
      const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
      const [user] = await context.db
        .insert(users)
        .values({
          id,
          username: body.username.toLowerCase(),
          displayName: body.displayName,
          role: 'admin',
          passwordHash,
        })
        .returning();
      if (!user) throw new Error('Failed to create administrator');

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
    '/api/v1/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        operationId: 'login',
        body: LoginRequestSchema,
        response: { 200: SessionSchema, 401: ProblemDetailsSchema },
      },
    },
    async (request, reply) => {
      const body = request.body as { username: string; password: string };
      const user = await verifyCredentials(body.username, body.password);
      const session = await createSession(context.db, user.id, context.config.sessionTtlHours);
      reply.setCookie(
        'kitesync_session',
        session.accessToken,
        sessionCookieOptions(context.config, session.expiresAt),
      );
      return {
        user: serializeUser(user),
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );

  app.post(
    '/api/v1/auth/desktop/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        operationId: 'desktopLogin',
        body: LoginRequestSchema,
        response: { 200: DesktopSessionSchema, 401: ProblemDetailsSchema },
      },
    },
    async (request) => {
      const body = request.body as { username: string; password: string };
      return issueDesktopSession(await verifyCredentials(body.username, body.password));
    },
  );

  app.post(
    '/api/v1/auth/desktop/refresh',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: {
        operationId: 'refreshDesktopSession',
        body: RefreshDesktopSessionRequestSchema,
        response: { 200: DesktopSessionSchema, 401: ProblemDetailsSchema },
      },
    },
    async (request) => {
      const body = request.body as { refreshToken: string };
      const [token] = await context.db
        .select()
        .from(desktopRefreshTokens)
        .where(eq(desktopRefreshTokens.tokenHash, hashToken(body.refreshToken)))
        .limit(1);
      if (!token || token.expiresAt <= new Date())
        throw new HttpProblem(401, 'REFRESH_TOKEN_INVALID', 'Refresh token is invalid or expired');
      if (token.rotatedAt || token.revokedAt) {
        await context.db
          .update(desktopRefreshTokens)
          .set({ revokedAt: new Date() })
          .where(eq(desktopRefreshTokens.familyId, token.familyId));
        throw new HttpProblem(
          401,
          'REFRESH_TOKEN_REPLAYED',
          'Refresh token replay detected; the token family was revoked',
        );
      }
      const [user] = await context.db
        .select()
        .from(users)
        .where(and(eq(users.id, token.userId), eq(users.active, true)))
        .limit(1);
      if (!user) throw new HttpProblem(401, 'USER_DISABLED', 'User is no longer active');
      await context.db
        .update(desktopRefreshTokens)
        .set({ rotatedAt: new Date() })
        .where(eq(desktopRefreshTokens.id, token.id));
      return issueDesktopSession(user, token.familyId);
    },
  );

  app.get(
    '/api/v1/auth/session',
    {
      preHandler: requireAuth(context.db),
      schema: { operationId: 'getSession', response: { 200: SessionSchema } },
    },
    async (request) => {
      const auth = request.authUser!;
      const [user] = await context.db.select().from(users).where(eq(users.id, auth.id)).limit(1);
      if (!user) throw new HttpProblem(401, 'USER_NOT_FOUND', 'User no longer exists');
      return {
        user: serializeUser(user),
        csrfToken: auth.csrfToken,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
    },
  );

  app.post(
    '/api/v1/auth/logout',
    {
      preHandler: requireAuth(context.db),
      schema: { operationId: 'logout', response: { 200: MessageResponseSchema } },
    },
    async (request, reply) => {
      await context.db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, request.authUser!.sessionId));
      reply.clearCookie('kitesync_session', { path: '/' });
      return { message: 'Logged out' };
    },
  );
}

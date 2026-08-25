import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { UserRole } from '@kitesync/contracts';
import type { Database } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import { HttpProblem } from './problem.js';

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  sessionId: string;
  csrfToken: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthenticatedUser;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function constantTimeStringEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

export async function createSession(
  db: Database,
  userId: string,
  ttlHours: number,
): Promise<{ accessToken: string; csrfToken: string; expiresAt: Date }> {
  const accessToken = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await db.insert(sessions).values({
    id: randomUUID(),
    userId,
    tokenHash: hashToken(accessToken),
    csrfToken,
    expiresAt,
  });
  return { accessToken, csrfToken, expiresAt };
}

function rawToken(request: FastifyRequest): { token?: string; fromCookie: boolean } {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith('Bearer ')) {
    return { token: authorization.slice('Bearer '.length), fromCookie: false };
  }
  const token = request.cookies.kitesync_session;
  return { ...(token ? { token } : {}), fromCookie: Boolean(token) };
}

export function requireAuth(db: Database, roles?: UserRole[]) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const token = rawToken(request);
    if (!token.token) {
      throw new HttpProblem(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    const rows = await db
      .select({
        sessionId: sessions.id,
        csrfToken: sessions.csrfToken,
        userId: users.id,
        username: users.username,
        displayName: users.displayName,
        role: users.role,
        active: users.active,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, hashToken(token.token)),
          gt(sessions.expiresAt, new Date()),
          isNull(sessions.revokedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row?.active) {
      throw new HttpProblem(401, 'SESSION_INVALID', 'Session is invalid or expired');
    }
    if (roles && !roles.includes(row.role)) {
      throw new HttpProblem(403, 'FORBIDDEN', 'Insufficient permissions');
    }

    if (
      token.fromCookie &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers['x-csrf-token'] !== row.csrfToken
    ) {
      throw new HttpProblem(403, 'CSRF_INVALID', 'CSRF token is missing or invalid');
    }

    request.authUser = {
      id: row.userId,
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      sessionId: row.sessionId,
      csrfToken: row.csrfToken,
    };
  };
}

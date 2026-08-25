import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '@kitesync/contracts';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { idempotencyRecords } from '../db/schema.js';
import { HttpProblem } from '../http/problem.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export function hashRequest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export async function replayIdempotent(
  db: Database,
  userId: string,
  key: string,
  requestHash: string,
) {
  const [prior] = await db
    .select()
    .from(idempotencyRecords)
    .where(and(eq(idempotencyRecords.userId, userId), eq(idempotencyRecords.key, key)))
    .limit(1);
  if (!prior) return undefined;
  if (prior.requestHash !== requestHash) {
    throw new HttpProblem(
      409,
      'IDEMPOTENCY_CONFLICT',
      'Idempotency key was used with a different request',
    );
  }
  return prior;
}

export async function saveIdempotent(
  tx: Transaction,
  input: {
    userId: string;
    key: string;
    operationId: string;
    requestHash: string;
    responseStatus: number;
    responseBody: Record<string, unknown>;
  },
) {
  await tx.insert(idempotencyRecords).values({
    id: randomUUID(),
    ...input,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
  });
}

export function parseIfMatch(header: string | string[] | undefined) {
  const raw = Array.isArray(header) ? header[0] : header;
  const match = raw?.match(/^(?:W\/)?"?(\d+)"?$/);
  if (!match) {
    throw new HttpProblem(428, 'IF_MATCH_REQUIRED', 'A valid If-Match revision is required');
  }
  return Number(match[1]);
}

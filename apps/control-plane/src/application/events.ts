import { randomUUID } from 'node:crypto';
import type { Database } from '../db/index.js';
import { auditEvents, domainEvents, reconciliationJobs } from '../db/schema.js';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export async function recordDomainEvent(
  tx: Transaction,
  event: {
    type: string;
    aggregateId?: string;
    payload: Record<string, unknown>;
  },
) {
  await tx.insert(domainEvents).values({
    id: randomUUID(),
    type: event.type,
    producer: 'control-plane',
    aggregateId: event.aggregateId,
    payload: event.payload,
  });
}

export async function recordAuditEvent(
  tx: Transaction,
  event: {
    actorUserId?: string;
    action: string;
    targetType: string;
    targetId?: string;
    traceId: string;
    metadata?: Record<string, unknown>;
  },
) {
  await tx.insert(auditEvents).values({
    id: randomUUID(),
    actorUserId: event.actorUserId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    traceId: event.traceId,
    metadata: event.metadata ?? {},
  });
}

export async function queueReconciliation(
  tx: Transaction,
  aggregateType: string,
  aggregateId: string,
  desiredRevision: number,
) {
  const operationId = randomUUID();
  await tx.insert(reconciliationJobs).values({
    id: operationId,
    aggregateType,
    aggregateId,
    desiredRevision,
  });
  return operationId;
}

import { randomUUID } from 'node:crypto';
import {
  CapabilitySchema,
  HealthSchema,
  ProblemDetailsSchema,
  RuntimeMetadataSchema,
} from '@kitesync/contracts';
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { backupRuns, hubs, reconciliationJobs } from '../db/schema.js';
import { requireAuth } from '../http/auth.js';

export function registerSystemRoutes(
  app: FastifyInstance,
  context: { db: Database; runtimeId: string; generation: string; startedAt: Date },
) {
  app.get(
    '/health',
    {
      schema: {
        operationId: 'getHealth',
        response: { 200: HealthSchema },
      },
    },
    async () => ({ status: 'ok' as const }),
  );
  app.get('/health/live', async () => ({ status: 'ok' as const }));
  app.get('/health/ready', async () => {
    await context.db.select({ id: hubs.id }).from(hubs).limit(1);
    return { status: 'ok' as const };
  });

  app.get('/metrics', async (_request, reply) => {
    const [hub] = await context.db.select().from(hubs).limit(1);
    const failed = await context.db
      .select({ id: reconciliationJobs.id })
      .from(reconciliationJobs)
      .where(eq(reconciliationJobs.state, 'failed'));
    const [lastBackup] = await context.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.state, 'succeeded'))
      .orderBy(desc(backupRuns.completedAt))
      .limit(1);
    const lines = [
      '# HELP kitesync_hub_up Whether the configured Hub is active.',
      '# TYPE kitesync_hub_up gauge',
      `kitesync_hub_up ${hub?.state === 'active' ? 1 : 0}`,
      '# TYPE kitesync_hub_desired_revision gauge',
      `kitesync_hub_desired_revision ${hub?.desiredRevision ?? 0}`,
      '# TYPE kitesync_hub_observed_revision gauge',
      `kitesync_hub_observed_revision ${hub?.observedRevision ?? 0}`,
      '# TYPE kitesync_hub_used_bytes gauge',
      `kitesync_hub_used_bytes ${hub?.usedBytes ?? 0}`,
      '# TYPE kitesync_hub_capacity_bytes gauge',
      `kitesync_hub_capacity_bytes ${hub?.capacityBytes ?? 0}`,
      '# TYPE kitesync_reconciliation_failed_jobs gauge',
      `kitesync_reconciliation_failed_jobs ${failed.length}`,
      '# TYPE kitesync_backup_last_success_timestamp_seconds gauge',
      `kitesync_backup_last_success_timestamp_seconds ${lastBackup?.completedAt ? Math.floor(lastBackup.completedAt.getTime() / 1_000) : 0}`,
      '',
    ];
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(lines.join('\n'));
  });

  app.get(
    '/api/v1/runtime',
    {
      preHandler: requireAuth(context.db),
      schema: {
        operationId: 'getRuntimeMetadata',
        response: { 200: RuntimeMetadataSchema, 401: ProblemDetailsSchema },
      },
    },
    async () => ({
      runtimeId: context.runtimeId,
      generation: context.generation,
      version: '1.0.0',
      apiVersion: 'v1' as const,
      startedAt: context.startedAt.toISOString(),
      capabilities: ['users', 'devices', 'sync-spaces', 'audit', 'events', 'hub-reconciliation'],
    }),
  );

  app.get(
    '/api/v1/capabilities',
    {
      preHandler: requireAuth(context.db),
      schema: {
        operationId: 'getCapabilities',
        response: { 200: CapabilitySchema },
      },
    },
    async () => ({
      capabilities: {
        users: true,
        devices: true,
        syncSpaces: true,
        versionRestore: true,
        backup: true,
        desktopUpdates: true,
      },
    }),
  );

  app.get('/api/v1/version', { preHandler: requireAuth(context.db) }, async () => ({
    version: '1.0.0',
    apiVersion: 'v1',
    buildId: process.env.KITESYNC_BUILD_ID ?? randomUUID(),
  }));
}

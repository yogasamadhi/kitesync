import { randomUUID } from 'node:crypto';
import type { HubOperation, HubSnapshot } from '@kitesync/contracts';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/index.js';
import { safeErrorLog } from '../logging.js';
import {
  deviceSpaceBindings,
  devices,
  hubs,
  reconciliationJobs,
  syncthingIdentityBindings,
  syncSpaces,
} from '../db/schema.js';
import { buildHubDesiredState } from './desired-state.js';
import { queueReconciliation, recordDomainEvent } from './events.js';
import { HubAgentClient } from './hub-agent-client.js';

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class ReconciliationWorker {
  private stopped = true;
  private wake: NodeJS.Timeout | undefined;
  private loopPromise: Promise<void> | undefined;
  private lastSnapshotAt = 0;

  constructor(
    private readonly db: Database,
    private readonly agent: HubAgentClient,
    private readonly log: FastifyBaseLogger,
  ) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.loopPromise = this.loop();
  }

  async stop() {
    this.stopped = true;
    await this.loopPromise;
  }

  private async loop() {
    while (!this.stopped) {
      try {
        const job = await this.claim();
        if (job) await this.process(job);
        if (Date.now() - this.lastSnapshotAt > 5_000) await this.refreshSnapshot();
      } catch (error) {
        this.log.error({ error: safeErrorLog(error) }, 'Reconciliation loop iteration failed');
      }
      if (!this.stopped) await this.wait(1_000);
    }
  }

  private wait(milliseconds: number) {
    return new Promise<void>((resolve) => {
      this.wake = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, milliseconds);
    });
  }

  private claim() {
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(reconciliationJobs)
        .where(
          and(
            inArray(reconciliationJobs.state, ['queued', 'failed']),
            lte(reconciliationJobs.nextAttemptAt, new Date()),
          ),
        )
        .orderBy(asc(reconciliationJobs.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!job) return undefined;
      const [claimed] = await tx
        .update(reconciliationJobs)
        .set({
          state: 'running',
          attempts: job.attempts + 1,
          lockedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(reconciliationJobs.id, job.id))
        .returning();
      return claimed;
    });
  }

  private async process(job: typeof reconciliationJobs.$inferSelect) {
    try {
      const [hub] = await this.db.select().from(hubs).limit(1);
      if (!hub) throw new Error('No Hub configured');
      const revision = hub.desiredRevision + 1;
      const desired = await buildHubDesiredState(this.db, hub.id, revision);
      await this.db
        .update(hubs)
        .set({ desiredRevision: revision, updatedAt: new Date() })
        .where(eq(hubs.id, hub.id));
      let operation = await this.agent.submit(desired);
      operation = await this.waitForOperation(operation);
      if (operation.state !== 'succeeded') {
        throw new Error(operation.error ?? 'Hub reconciliation failed');
      }
      const snapshot = await this.agent.snapshot();
      await this.applySnapshot(hub.id, snapshot);
      await this.db
        .update(reconciliationJobs)
        .set({ state: 'succeeded', lockedAt: null, lastError: null, updatedAt: new Date() })
        .where(eq(reconciliationJobs.id, job.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const backoffSeconds = Math.min(300, 2 ** Math.min(job.attempts, 8));
      await this.db
        .update(reconciliationJobs)
        .set({
          state: 'failed',
          lockedAt: null,
          lastError: message.slice(0, 2_000),
          nextAttemptAt: new Date(Date.now() + backoffSeconds * 1_000),
          updatedAt: new Date(),
        })
        .where(eq(reconciliationJobs.id, job.id));
      this.log.warn(
        { error: safeErrorLog(error), jobId: job.id, backoffSeconds },
        'Reconciliation failed',
      );
    }
  }

  private async waitForOperation(initial: HubOperation) {
    let operation = initial;
    for (
      let attempt = 0;
      attempt < 60 && !['succeeded', 'failed'].includes(operation.state);
      attempt++
    ) {
      await delay(250);
      operation = await this.agent.operation(operation.id);
    }
    return operation;
  }

  private async refreshSnapshot() {
    this.lastSnapshotAt = Date.now();
    const [hub] = await this.db.select().from(hubs).limit(1);
    if (!hub) return;
    const snapshot = await this.agent.snapshot();
    await this.applySnapshot(hub.id, snapshot);
  }

  private async applySnapshot(hubId: string, snapshot: HubSnapshot) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(hubs)
        .set({
          syncthingDeviceId: snapshot.syncthing.deviceId,
          generation: snapshot.generation,
          observedRevision: snapshot.observedRevision,
          state: 'active',
          usedBytes: snapshot.folders.reduce((total, folder) => total + folder.localBytes, 0),
          updatedAt: new Date(),
        })
        .where(eq(hubs.id, hubId));

      for (const observed of snapshot.devices) {
        if (observed.connected) {
          const [verifiedDevice] = await tx
            .update(devices)
            .set({ state: 'active', lastSeenAt: new Date(), updatedAt: new Date() })
            .where(
              and(
                eq(devices.syncthingDeviceId, observed.id),
                eq(devices.state, 'verifying_syncthing_identity'),
              ),
            )
            .returning();
          if (verifiedDevice) {
            await tx
              .insert(syncthingIdentityBindings)
              .values({
                id: randomUUID(),
                productDeviceId: verifiedDevice.id,
                hubId,
                syncthingDeviceId: observed.id,
                state: 'verified',
              })
              .onConflictDoUpdate({
                target: syncthingIdentityBindings.productDeviceId,
                set: {
                  hubId,
                  syncthingDeviceId: observed.id,
                  state: 'verified',
                  verifiedAt: new Date(),
                  lastObservedAt: new Date(),
                  revokedAt: null,
                },
              });
          } else {
            await tx
              .update(syncthingIdentityBindings)
              .set({ lastObservedAt: new Date() })
              .where(eq(syncthingIdentityBindings.syncthingDeviceId, observed.id));
          }
        }
      }

      const observedDeviceIds = snapshot.devices.map((device) => device.id);
      const revoking = await tx.select().from(devices).where(eq(devices.state, 'revoking'));
      for (const device of revoking) {
        if (!observedDeviceIds.includes(device.syncthingDeviceId)) {
          await tx
            .update(devices)
            .set({ state: 'revoked', updatedAt: new Date() })
            .where(eq(devices.id, device.id));
          await tx
            .update(syncthingIdentityBindings)
            .set({ state: 'revoked', revokedAt: new Date() })
            .where(eq(syncthingIdentityBindings.productDeviceId, device.id));
        }
      }

      for (const folder of snapshot.folders) {
        const [space] = await tx
          .select()
          .from(syncSpaces)
          .where(eq(syncSpaces.syncthingFolderId, folder.id))
          .limit(1);
        if (!space) continue;

        const quotaExceeded = folder.localBytes > space.quotaBytes;
        const shouldPause = quotaExceeded && space.state !== 'paused';
        const nextState =
          space.state === 'paused' || shouldPause
            ? 'paused'
            : folder.state === 'error'
              ? 'degraded'
              : 'active';
        const nextRevision = shouldPause ? space.revision + 1 : space.revision;
        await tx
          .update(syncSpaces)
          .set({
            state: nextState,
            usedBytes: folder.localBytes,
            revision: nextRevision,
            updatedAt: new Date(),
          })
          .where(eq(syncSpaces.id, space.id));
        if (shouldPause) {
          await queueReconciliation(tx, 'sync-space', space.id, nextRevision);
          await recordDomainEvent(tx, {
            type: 'sync-space.quota-exceeded',
            aggregateId: space.id,
            payload: { quotaBytes: space.quotaBytes, usedBytes: folder.localBytes },
          });
          this.log.warn(
            { syncSpaceId: space.id, quotaBytes: space.quotaBytes, usedBytes: folder.localBytes },
            'Sync space paused after exceeding quota',
          );
        }
      }

      const observedFolderIds = snapshot.folders.map((folder) => folder.id);
      if (observedFolderIds.length > 0) {
        await tx
          .update(deviceSpaceBindings)
          .set({ state: 'syncing', updatedAt: new Date() })
          .where(
            and(
              eq(deviceSpaceBindings.state, 'provisioning'),
              sql`${deviceSpaceBindings.syncSpaceId} IN (
                SELECT ${syncSpaces.id} FROM ${syncSpaces}
                WHERE ${syncSpaces.syncthingFolderId} IN (${sql.join(
                  observedFolderIds.map((id) => sql`${id}`),
                  sql`, `,
                )})
              )`,
            ),
          );
      }

      const removedBindings = await tx
        .select({ bindingId: deviceSpaceBindings.id, folderId: syncSpaces.syncthingFolderId })
        .from(deviceSpaceBindings)
        .innerJoin(syncSpaces, eq(syncSpaces.id, deviceSpaceBindings.syncSpaceId))
        .where(eq(deviceSpaceBindings.state, 'removing'));
      for (const binding of removedBindings) {
        if (!observedFolderIds.includes(binding.folderId)) {
          await tx
            .update(deviceSpaceBindings)
            .set({ state: 'removed', updatedAt: new Date() })
            .where(eq(deviceSpaceBindings.id, binding.bindingId));
        }
      }
    });
  }
}

import type { InferSelectModel } from 'drizzle-orm';
import type { deviceSpaceBindings, devices, syncSpaces, users } from '../db/schema.js';

export function serializeUser(row: InferSelectModel<typeof users>) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeDevice(row: InferSelectModel<typeof devices>) {
  return {
    id: row.id,
    userId: row.userId,
    displayName: row.displayName,
    platform: row.platform as 'windows' | 'macos' | 'linux',
    productPublicKey: row.productPublicKey,
    syncthingDeviceId: row.syncthingDeviceId,
    state: row.state,
    revision: row.revision,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeSyncSpace(row: InferSelectModel<typeof syncSpaces>) {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    hubId: row.hubId,
    label: row.label,
    syncthingFolderId: row.syncthingFolderId,
    quotaBytes: row.quotaBytes,
    usedBytes: row.usedBytes,
    state: row.state,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    deleteAfter: row.deleteAfter?.toISOString() ?? null,
  };
}

export function serializeBinding(row: InferSelectModel<typeof deviceSpaceBindings>) {
  return {
    id: row.id,
    syncSpaceId: row.syncSpaceId,
    deviceId: row.deviceId,
    state: row.state,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
  };
}

import type { HubDesiredState } from '@kitesync/contracts';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { deviceSpaceBindings, devices, syncSpaces } from '../db/schema.js';

export async function buildHubDesiredState(
  db: Database,
  hubId: string,
  revision: number,
): Promise<HubDesiredState> {
  const desiredDevices = await db
    .select()
    .from(devices)
    .where(
      and(
        eq(devices.hubId, hubId),
        notInArray(devices.state, ['pending_approval', 'revoking', 'revoked']),
      ),
    );
  const desiredSpaces = await db
    .select()
    .from(syncSpaces)
    .where(
      and(
        eq(syncSpaces.hubId, hubId),
        inArray(syncSpaces.state, ['provisioning', 'active', 'paused', 'degraded']),
      ),
    );
  const bindings = await db
    .select({
      syncSpaceId: deviceSpaceBindings.syncSpaceId,
      syncthingDeviceId: devices.syncthingDeviceId,
    })
    .from(deviceSpaceBindings)
    .innerJoin(devices, eq(devices.id, deviceSpaceBindings.deviceId))
    .where(
      and(
        inArray(deviceSpaceBindings.state, ['provisioning', 'syncing', 'paused']),
        inArray(devices.state, ['active', 'suspended']),
      ),
    );

  return {
    revision,
    devices: desiredDevices.map((device) => ({
      id: device.syncthingDeviceId,
      name: `KiteSync ${device.displayName}`,
      addresses: ['dynamic'],
      paused: device.state === 'suspended',
    })),
    folders: desiredSpaces.map((space) => ({
      id: space.syncthingFolderId,
      label: space.label,
      path: `/var/syncthing/data/spaces/${space.id}`,
      paused: space.state === 'paused',
      deviceIds: bindings
        .filter((binding) => binding.syncSpaceId === space.id)
        .map((binding) => binding.syncthingDeviceId),
      quotaBytes: space.quotaBytes,
      versionMaxAgeDays: 30,
    })),
  };
}

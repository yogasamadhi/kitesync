import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, IsoDateTimeSchema, OperationStateSchema, RevisionSchema } from './common.js';

export const SyncSpaceStateSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('provisioning'),
  Type.Literal('active'),
  Type.Literal('paused'),
  Type.Literal('deleting'),
  Type.Literal('retained'),
  Type.Literal('deleted'),
  Type.Literal('degraded'),
]);

export type SyncSpaceState = Static<typeof SyncSpaceStateSchema>;

export const SyncSpaceSchema = Type.Object(
  {
    id: IdSchema,
    ownerUserId: IdSchema,
    hubId: IdSchema,
    label: Type.String({ minLength: 1, maxLength: 128 }),
    syncthingFolderId: Type.String({ minLength: 1, maxLength: 64 }),
    quotaBytes: Type.Integer({ minimum: 1 }),
    usedBytes: Type.Integer({ minimum: 0 }),
    state: SyncSpaceStateSchema,
    revision: RevisionSchema,
    createdAt: IsoDateTimeSchema,
    deleteAfter: Type.Union([IsoDateTimeSchema, Type.Null()]),
  },
  { $id: 'SyncSpace' },
);

export type SyncSpace = Static<typeof SyncSpaceSchema>;

export const CreateSyncSpaceRequestSchema = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 128 }),
  quotaBytes: Type.Optional(Type.Integer({ minimum: 1, default: 107_374_182_400 })),
});

export const SyncSpaceOperationSchema = Type.Object({
  space: SyncSpaceSchema,
  operationId: IdSchema,
  state: OperationStateSchema,
});

export const ShareStateSchema = Type.Union([
  Type.Literal('invited'),
  Type.Literal('accepted'),
  Type.Literal('revoked'),
]);

export const SpaceShareSchema = Type.Object({
  id: IdSchema,
  syncSpaceId: IdSchema,
  userId: IdSchema,
  state: ShareStateSchema,
  createdAt: IsoDateTimeSchema,
});

export const CreateSpaceShareRequestSchema = Type.Object({
  userId: IdSchema,
});

export const BindingStateSchema = Type.Union([
  Type.Literal('offered'),
  Type.Literal('awaiting_directory'),
  Type.Literal('provisioning'),
  Type.Literal('syncing'),
  Type.Literal('paused'),
  Type.Literal('removing'),
  Type.Literal('removed'),
  Type.Literal('degraded'),
]);

export const DeviceSpaceBindingSchema = Type.Object({
  id: IdSchema,
  syncSpaceId: IdSchema,
  deviceId: IdSchema,
  state: BindingStateSchema,
  revision: RevisionSchema,
  createdAt: IsoDateTimeSchema,
});

export type DeviceSpaceBinding = Static<typeof DeviceSpaceBindingSchema>;

export const CreateDeviceSpaceBindingRequestSchema = Type.Object({
  syncSpaceId: IdSchema,
  deviceId: IdSchema,
});

export const DeviceSpaceBindingOperationSchema = Type.Object({
  binding: DeviceSpaceBindingSchema,
  operationId: IdSchema,
  state: OperationStateSchema,
});

export const VersionEntrySchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  versionTime: IsoDateTimeSchema,
  modifiedAt: IsoDateTimeSchema,
  sizeBytes: Type.Integer({ minimum: 0 }),
});

export const RestoreVersionsRequestSchema = Type.Object({
  files: Type.Array(
    Type.Object({
      path: Type.String({ minLength: 1 }),
      versionTime: IsoDateTimeSchema,
    }),
    { minItems: 1, maxItems: 1000 },
  ),
});

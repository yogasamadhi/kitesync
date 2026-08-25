import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, IsoDateTimeSchema, RevisionSchema } from './common.js';

export const HubDesiredDeviceSchema = Type.Object({
  id: Type.String({ minLength: 32, maxLength: 80 }),
  name: Type.String({ minLength: 1, maxLength: 128 }),
  addresses: Type.Array(Type.String(), { minItems: 1 }),
  paused: Type.Boolean(),
});

export const HubDesiredFolderSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  label: Type.String({ minLength: 1, maxLength: 128 }),
  path: Type.String({ minLength: 1 }),
  paused: Type.Boolean(),
  deviceIds: Type.Array(Type.String({ minLength: 32, maxLength: 80 })),
  quotaBytes: Type.Integer({ minimum: 1 }),
  versionMaxAgeDays: Type.Integer({ minimum: 1, maximum: 3650 }),
});

export const HubDesiredStateSchema = Type.Object(
  {
    revision: RevisionSchema,
    devices: Type.Array(HubDesiredDeviceSchema),
    folders: Type.Array(HubDesiredFolderSchema),
  },
  { $id: 'HubDesiredState' },
);

export type HubDesiredState = Static<typeof HubDesiredStateSchema>;

export const HubOperationSchema = Type.Object({
  id: IdSchema,
  revision: RevisionSchema,
  state: Type.Union([
    Type.Literal('queued'),
    Type.Literal('running'),
    Type.Literal('succeeded'),
    Type.Literal('failed'),
  ]),
  error: Type.Union([Type.String(), Type.Null()]),
  createdAt: IsoDateTimeSchema,
  completedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
});

export type HubOperation = Static<typeof HubOperationSchema>;

export const HubSnapshotSchema = Type.Object({
  generation: IdSchema,
  observedRevision: RevisionSchema,
  syncthing: Type.Object({
    deviceId: Type.String(),
    version: Type.String(),
    uptimeSeconds: Type.Integer({ minimum: 0 }),
  }),
  devices: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      connected: Type.Boolean(),
      paused: Type.Boolean(),
    }),
  ),
  folders: Type.Array(
    Type.Object({
      id: Type.String(),
      label: Type.String(),
      state: Type.String(),
      localBytes: Type.Integer({ minimum: 0 }),
      globalBytes: Type.Integer({ minimum: 0 }),
      needBytes: Type.Integer({ minimum: 0 }),
    }),
  ),
});

export type HubSnapshot = Static<typeof HubSnapshotSchema>;

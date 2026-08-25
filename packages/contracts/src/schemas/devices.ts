import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, IsoDateTimeSchema, RevisionSchema } from './common.js';

export const DeviceStateSchema = Type.Union([
  Type.Literal('pending_approval'),
  Type.Literal('verifying_syncthing_identity'),
  Type.Literal('active'),
  Type.Literal('suspended'),
  Type.Literal('revoking'),
  Type.Literal('revoked'),
]);

export type DeviceState = Static<typeof DeviceStateSchema>;

export const DeviceSchema = Type.Object(
  {
    id: IdSchema,
    userId: IdSchema,
    displayName: Type.String({ minLength: 1, maxLength: 128 }),
    platform: Type.Union([Type.Literal('windows'), Type.Literal('macos'), Type.Literal('linux')]),
    productPublicKey: Type.String({ minLength: 32, maxLength: 256 }),
    syncthingDeviceId: Type.String({ minLength: 32, maxLength: 80 }),
    state: DeviceStateSchema,
    revision: RevisionSchema,
    lastSeenAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    createdAt: IsoDateTimeSchema,
  },
  { $id: 'Device' },
);

export type Device = Static<typeof DeviceSchema>;

export const RegisterDeviceRequestSchema = Type.Object({
  displayName: Type.String({ minLength: 1, maxLength: 128 }),
  platform: Type.Union([Type.Literal('windows'), Type.Literal('macos'), Type.Literal('linux')]),
  productPublicKey: Type.String({ minLength: 32, maxLength: 256 }),
  syncthingDeviceId: Type.String({ minLength: 32, maxLength: 80 }),
  registrationNonce: Type.String({ format: 'uuid' }),
  signature: Type.String({ minLength: 64, maxLength: 256 }),
});

export const DeviceActionResponseSchema = Type.Object({
  device: DeviceSchema,
  operationId: IdSchema,
});

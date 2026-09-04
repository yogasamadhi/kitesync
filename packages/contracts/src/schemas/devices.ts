import { Type, type Static } from '@sinclair/typebox';
import { DeviceIdSchema, IsoDateTimeSchema } from './common.js';

const StaticDeviceAddressSchema = Type.String({
  pattern: '^(?:tcp|quic)://(?:\\[[0-9A-Fa-f:.]+\\]|[^\\s/?#:@]+):[1-9][0-9]{0,4}/?$',
  maxLength: 512,
  description: '显式的 tcp://host:port 或 quic://host:port 地址',
});

const DeviceAddressSchema = Type.String({ minLength: 1, maxLength: 512 });
const ObservedDeviceAddressSchema = Type.String({ minLength: 1, maxLength: 512 });

export const DeviceSchema = Type.Object(
  {
    id: DeviceIdSchema,
    name: Type.String({ minLength: 1, maxLength: 64 }),
    addresses: Type.Array(DeviceAddressSchema, { minItems: 1, maxItems: 32 }),
    connected: Type.Boolean(),
    paused: Type.Boolean(),
    lastSeenAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  },
  { $id: 'Device', additionalProperties: false },
);

export type Device = Static<typeof DeviceSchema>;

export const DeviceListSchema = Type.Object(
  { items: Type.Array(DeviceSchema) },
  { $id: 'DeviceList', additionalProperties: false },
);

export type DeviceList = Static<typeof DeviceListSchema>;

export const CreateDeviceRequestSchema = Type.Object(
  {
    deviceId: DeviceIdSchema,
    name: Type.String({ minLength: 1, maxLength: 64 }),
    addresses: Type.Optional(
      Type.Array(StaticDeviceAddressSchema, { minItems: 1, maxItems: 32, uniqueItems: true }),
    ),
  },
  { $id: 'CreateDeviceRequest', additionalProperties: false },
);

export type CreateDeviceRequest = Static<typeof CreateDeviceRequestSchema>;

export const UpdateDeviceRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    /** An empty list switches the device back to Syncthing's dynamic addressing. */
    addresses: Type.Optional(
      Type.Array(StaticDeviceAddressSchema, { maxItems: 32, uniqueItems: true }),
    ),
    paused: Type.Optional(Type.Boolean()),
  },
  { $id: 'UpdateDeviceRequest', additionalProperties: false, minProperties: 1 },
);

export type UpdateDeviceRequest = Static<typeof UpdateDeviceRequestSchema>;

export const DiscoveredDeviceSchema = Type.Object(
  {
    id: DeviceIdSchema,
    addresses: Type.Array(DeviceAddressSchema, { maxItems: 32 }),
  },
  { $id: 'DiscoveredDevice', additionalProperties: false },
);

export type DiscoveredDevice = Static<typeof DiscoveredDeviceSchema>;

export const DiscoveredDeviceListSchema = Type.Object(
  { items: Type.Array(DiscoveredDeviceSchema) },
  { $id: 'DiscoveredDeviceList', additionalProperties: false },
);

export type DiscoveredDeviceList = Static<typeof DiscoveredDeviceListSchema>;

export const PendingDeviceSchema = Type.Object(
  {
    id: DeviceIdSchema,
    name: Type.String({ minLength: 1, maxLength: 64 }),
    address: ObservedDeviceAddressSchema,
    seenAt: IsoDateTimeSchema,
  },
  { $id: 'PendingDevice', additionalProperties: false },
);

export type PendingDevice = Static<typeof PendingDeviceSchema>;

export const IgnoredDeviceSchema = Type.Object(
  {
    id: DeviceIdSchema,
    name: Type.String({ minLength: 1, maxLength: 64 }),
    address: ObservedDeviceAddressSchema,
    ignoredAt: IsoDateTimeSchema,
  },
  { $id: 'IgnoredDevice', additionalProperties: false },
);

export type IgnoredDevice = Static<typeof IgnoredDeviceSchema>;

export const PendingDeviceListSchema = Type.Object(
  {
    items: Type.Array(PendingDeviceSchema),
    ignored: Type.Array(IgnoredDeviceSchema),
  },
  { $id: 'PendingDeviceList', additionalProperties: false },
);

export type PendingDeviceList = Static<typeof PendingDeviceListSchema>;

export const AcceptPendingDeviceRequestSchema = Type.Object(
  { name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })) },
  { $id: 'AcceptPendingDeviceRequest', additionalProperties: false },
);

export type AcceptPendingDeviceRequest = Static<typeof AcceptPendingDeviceRequestSchema>;

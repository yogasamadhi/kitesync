import { Type, type Static } from '@sinclair/typebox';
import { DeviceIdSchema, IsoDateTimeSchema } from './common.js';

export const NodePlatformSchema = Type.Union([
  Type.Literal('windows'),
  Type.Literal('macos'),
  Type.Literal('linux'),
]);

export type NodePlatform = Static<typeof NodePlatformSchema>;

export const NodeInfoSchema = Type.Object(
  {
    deviceId: DeviceIdSchema,
    fingerprint: Type.String({ minLength: 4, maxLength: 32 }),
    name: Type.String({ minLength: 1, maxLength: 64 }),
    platform: NodePlatformSchema,
    version: Type.String({ minLength: 1 }),
    syncthingVersion: Type.String({ minLength: 1 }),
    startedAt: IsoDateTimeSchema,
    setupRequired: Type.Boolean(),
    listenAddresses: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 }),
    localDiscoveryEnabled: Type.Boolean(),
    connectedPeers: Type.Integer({ minimum: 0 }),
    canRevealFiles: Type.Boolean(),
  },
  { $id: 'NodeInfo', additionalProperties: false },
);

export type NodeInfo = Static<typeof NodeInfoSchema>;

const AllowedOriginSchema = Type.String({
  pattern: '^https://(?:\\[[0-9A-Fa-f:.]+\\]|[^/?#:@\\s]+)(?::[0-9]{1,5})?/?$',
  maxLength: 2048,
  description: 'Explicit HTTPS origin without credentials, path, query, or fragment',
});

const TrustedProxySchema = Type.String({
  pattern:
    '^(?:loopback|(?:(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(?:/(?:3[0-2]|[12]?[0-9]))?|(?=[0-9A-Fa-f:.]*:)[0-9A-Fa-f:.]+(?:/(?:12[0-8]|1[01][0-9]|[1-9]?[0-9]))?)$',
  maxLength: 255,
  description: '可信代理的 IP、CIDR 或 loopback',
});

export const NodeSettingsSchema = Type.Object(
  {
    nodeName: Type.String({ minLength: 1, maxLength: 64 }),
    lanAccessEnabled: Type.Boolean(),
    allowedOrigins: Type.Array(AllowedOriginSchema, { maxItems: 32, uniqueItems: true }),
    trustedProxies: Type.Array(TrustedProxySchema, { maxItems: 32, uniqueItems: true }),
    versioningDays: Type.Integer({ minimum: 0, maximum: 3650 }),
    uiPort: Type.Integer({ minimum: 1, maximum: 65535 }),
  },
  { $id: 'NodeSettings', additionalProperties: false },
);

export type NodeSettings = Static<typeof NodeSettingsSchema>;

export const UpdateNodeSettingsSchema = Type.Object(
  {
    nodeName: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    lanAccessEnabled: Type.Optional(Type.Boolean()),
    allowedOrigins: Type.Optional(
      Type.Array(AllowedOriginSchema, { maxItems: 32, uniqueItems: true }),
    ),
    trustedProxies: Type.Optional(
      Type.Array(TrustedProxySchema, { maxItems: 32, uniqueItems: true }),
    ),
    versioningDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 3650 })),
  },
  { $id: 'UpdateNodeSettings', additionalProperties: false, minProperties: 1 },
);

export type UpdateNodeSettings = Static<typeof UpdateNodeSettingsSchema>;

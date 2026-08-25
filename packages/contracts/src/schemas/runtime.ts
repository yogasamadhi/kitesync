import { Type, type Static } from '@sinclair/typebox';
import { IsoDateTimeSchema } from './common.js';

export const HealthSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('ok'), Type.Literal('degraded'), Type.Literal('unavailable')]),
  },
  { $id: 'Health' },
);

export const RuntimeMetadataSchema = Type.Object(
  {
    runtimeId: Type.String({ format: 'uuid' }),
    generation: Type.String({ format: 'uuid' }),
    version: Type.String(),
    apiVersion: Type.Literal('v1'),
    startedAt: IsoDateTimeSchema,
    capabilities: Type.Array(Type.String()),
  },
  { $id: 'RuntimeMetadata' },
);

export type RuntimeMetadata = Static<typeof RuntimeMetadataSchema>;

export const CapabilitySchema = Type.Object(
  {
    capabilities: Type.Record(Type.String(), Type.Boolean()),
  },
  { $id: 'Capabilities' },
);

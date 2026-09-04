import { Type, type Static } from '@sinclair/typebox';

export const HealthSchema = Type.Object(
  {
    status: Type.Union([Type.Literal('ok'), Type.Literal('degraded'), Type.Literal('unavailable')]),
  },
  { $id: 'Health', additionalProperties: false },
);

export type Health = Static<typeof HealthSchema>;

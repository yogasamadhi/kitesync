import { Type, type Static } from '@sinclair/typebox';
import { IsoDateTimeSchema } from './common.js';

export const DomainEventSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    cursor: Type.Integer({ minimum: 1 }),
    type: Type.String({ minLength: 1, maxLength: 128 }),
    schemaVersion: Type.Integer({ minimum: 1 }),
    occurredAt: IsoDateTimeSchema,
    producer: Type.String(),
    aggregateId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { $id: 'DomainEvent' },
);

export type DomainEvent = Static<typeof DomainEventSchema>;

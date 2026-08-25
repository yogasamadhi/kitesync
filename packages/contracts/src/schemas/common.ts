import { Type, type Static } from '@sinclair/typebox';

export const IdSchema = Type.String({
  format: 'uuid',
  description: 'Stable UUID identifier',
});

export const IsoDateTimeSchema = Type.String({ format: 'date-time' });

export const RevisionSchema = Type.Integer({ minimum: 0 });

export const ProblemDetailsSchema = Type.Object(
  {
    type: Type.String({ format: 'uri-reference' }),
    title: Type.String(),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    detail: Type.Optional(Type.String()),
    instance: Type.Optional(Type.String({ format: 'uri-reference' })),
    traceId: Type.String(),
    code: Type.String(),
    errors: Type.Optional(
      Type.Array(
        Type.Object({
          path: Type.String(),
          message: Type.String(),
        }),
      ),
    ),
  },
  { $id: 'ProblemDetails' },
);

export type ProblemDetails = Static<typeof ProblemDetailsSchema>;

export const PageInfoSchema = Type.Object({
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
});

export const OperationStateSchema = Type.Union([
  Type.Literal('accepted'),
  Type.Literal('applied'),
  Type.Literal('degraded'),
  Type.Literal('failed'),
]);

export type OperationState = Static<typeof OperationStateSchema>;

export const MessageResponseSchema = Type.Object({
  message: Type.String(),
});

import { Type, type Static } from '@sinclair/typebox';
import { IsoDateTimeSchema } from './common.js';
import { NodePlatformSchema } from './node.js';

export const DiagnosticLogEntrySchema = Type.Object(
  {
    timestamp: IsoDateTimeSchema,
    level: Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')]),
    message: Type.String({ minLength: 1, maxLength: 4096 }),
  },
  { $id: 'DiagnosticLogEntry', additionalProperties: false },
);

export const DiagnosticLogListSchema = Type.Object(
  {
    items: Type.Array(DiagnosticLogEntrySchema),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'DiagnosticLogList', additionalProperties: false },
);

export type DiagnosticLogList = Static<typeof DiagnosticLogListSchema>;

export const DiagnosticSummarySchema = Type.Object(
  {
    generatedAt: IsoDateTimeSchema,
    node: Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 64 }),
        platform: NodePlatformSchema,
        version: Type.String({ minLength: 1 }),
        uptimeSeconds: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    engine: Type.Object(
      {
        available: Type.Boolean(),
        version: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    counts: Type.Object(
      {
        folders: Type.Integer({ minimum: 0 }),
        devices: Type.Integer({ minimum: 0 }),
        connectedDevices: Type.Integer({ minimum: 0 }),
        folderErrors: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    problems: Type.Array(Type.String({ maxLength: 1024 })),
  },
  { $id: 'DiagnosticSummary', additionalProperties: false },
);

export type DiagnosticSummary = Static<typeof DiagnosticSummarySchema>;

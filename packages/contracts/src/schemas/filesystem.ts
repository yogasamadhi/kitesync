import { Type, type Static } from '@sinclair/typebox';

export const DirectoryRootSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 512 }),
    label: Type.String({ minLength: 1, maxLength: 128 }),
  },
  { $id: 'DirectoryRoot', additionalProperties: false },
);

export type DirectoryRoot = Static<typeof DirectoryRootSchema>;

export const DirectoryRootListSchema = Type.Object(
  { items: Type.Array(DirectoryRootSchema) },
  { $id: 'DirectoryRootList', additionalProperties: false },
);

export type DirectoryRootList = Static<typeof DirectoryRootListSchema>;

export const DirectoryEntrySchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 512 }),
    name: Type.String({ minLength: 1, maxLength: 255 }),
  },
  { $id: 'DirectoryEntry', additionalProperties: false },
);

export type DirectoryEntry = Static<typeof DirectoryEntrySchema>;

export const DirectoryQuerySchema = Type.Object(
  {
    parentId: Type.String({ minLength: 1, maxLength: 512 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { $id: 'DirectoryQuery', additionalProperties: false },
);

export type DirectoryQuery = Static<typeof DirectoryQuerySchema>;

export const DirectoryListSchema = Type.Object(
  {
    current: DirectoryRootSchema,
    parentId: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
    items: Type.Array(DirectoryEntrySchema),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'DirectoryList', additionalProperties: false },
);

export type DirectoryList = Static<typeof DirectoryListSchema>;

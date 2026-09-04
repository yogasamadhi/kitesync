import { Type, type Static } from '@sinclair/typebox';
import { DeviceIdSchema, FolderIdSchema, IsoDateTimeSchema, RelativePathSchema } from './common.js';

export const FolderTypeSchema = Type.Union([
  Type.Literal('sendreceive'),
  Type.Literal('sendonly'),
  Type.Literal('receiveonly'),
]);

export type FolderType = Static<typeof FolderTypeSchema>;

export const FolderStateSchema = Type.Union([
  Type.Literal('idle'),
  Type.Literal('scanning'),
  Type.Literal('syncing'),
  Type.Literal('paused'),
  Type.Literal('error'),
]);

export type FolderState = Static<typeof FolderStateSchema>;

export const FolderSchema = Type.Object(
  {
    id: FolderIdSchema,
    label: Type.String({ minLength: 1, maxLength: 128 }),
    pathLabel: Type.String({ minLength: 1, maxLength: 255 }),
    type: FolderTypeSchema,
    paused: Type.Boolean(),
    deviceIds: Type.Array(DeviceIdSchema, { uniqueItems: true }),
    state: FolderStateSchema,
    localBytes: Type.Integer({ minimum: 0 }),
    globalBytes: Type.Integer({ minimum: 0 }),
    needBytes: Type.Integer({ minimum: 0 }),
    error: Type.Union([Type.String(), Type.Null()]),
    versioningDays: Type.Integer({ minimum: 0, maximum: 3650 }),
  },
  { $id: 'Folder', additionalProperties: false },
);

export type Folder = Static<typeof FolderSchema>;

export const FolderListSchema = Type.Object(
  { items: Type.Array(FolderSchema) },
  { $id: 'FolderList', additionalProperties: false },
);

export type FolderList = Static<typeof FolderListSchema>;

export const CreateFolderRequestSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 128 }),
    directoryId: Type.String({ minLength: 1, maxLength: 512 }),
    deviceIds: Type.Optional(Type.Array(DeviceIdSchema, { uniqueItems: true })),
    type: Type.Optional(FolderTypeSchema),
  },
  { $id: 'CreateFolderRequest', additionalProperties: false },
);

export type CreateFolderRequest = Static<typeof CreateFolderRequestSchema>;

export const UpdateFolderRequestSchema = Type.Object(
  {
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    deviceIds: Type.Optional(Type.Array(DeviceIdSchema, { uniqueItems: true })),
    type: Type.Optional(FolderTypeSchema),
    versioningDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 3650 })),
  },
  { $id: 'UpdateFolderRequest', additionalProperties: false, minProperties: 1 },
);

export type UpdateFolderRequest = Static<typeof UpdateFolderRequestSchema>;

export const PendingFolderSchema = Type.Object(
  {
    folderId: FolderIdSchema,
    label: Type.String({ minLength: 1, maxLength: 128 }),
    deviceId: DeviceIdSchema,
    deviceName: Type.String({ minLength: 1, maxLength: 64 }),
    offeredAt: IsoDateTimeSchema,
  },
  { $id: 'PendingFolder', additionalProperties: false },
);

export type PendingFolder = Static<typeof PendingFolderSchema>;

export const IgnoredFolderSchema = Type.Object(
  {
    folderId: FolderIdSchema,
    label: Type.String({ minLength: 1, maxLength: 128 }),
    deviceId: DeviceIdSchema,
    deviceName: Type.String({ minLength: 1, maxLength: 64 }),
    ignoredAt: IsoDateTimeSchema,
  },
  { $id: 'IgnoredFolder', additionalProperties: false },
);

export type IgnoredFolder = Static<typeof IgnoredFolderSchema>;

export const PendingFolderListSchema = Type.Object(
  { items: Type.Array(PendingFolderSchema), ignored: Type.Array(IgnoredFolderSchema) },
  { $id: 'PendingFolderList', additionalProperties: false },
);

export type PendingFolderList = Static<typeof PendingFolderListSchema>;

export const AcceptPendingFolderRequestSchema = Type.Object(
  {
    directoryId: Type.String({ minLength: 1, maxLength: 512 }),
    type: Type.Optional(FolderTypeSchema),
  },
  { $id: 'AcceptPendingFolderRequest', additionalProperties: false },
);

export type AcceptPendingFolderRequest = Static<typeof AcceptPendingFolderRequestSchema>;

export const FolderFileSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    path: RelativePathSchema,
    type: Type.Union([Type.Literal('file'), Type.Literal('directory'), Type.Literal('symlink')]),
    size: Type.Integer({ minimum: 0 }),
    modifiedAt: IsoDateTimeSchema,
  },
  { $id: 'FolderFile', additionalProperties: false },
);

export type FolderFile = Static<typeof FolderFileSchema>;

export const FolderFilesQuerySchema = Type.Object(
  {
    path: Type.Optional(RelativePathSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { $id: 'FolderFilesQuery', additionalProperties: false },
);

export type FolderFilesQuery = Static<typeof FolderFilesQuerySchema>;

export const FolderFileListSchema = Type.Object(
  {
    path: RelativePathSchema,
    parentPath: Type.Union([RelativePathSchema, Type.Null()]),
    items: Type.Array(FolderFileSchema),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'FolderFileList', additionalProperties: false },
);

export type FolderFileList = Static<typeof FolderFileListSchema>;

export const VersionEntrySchema = Type.Object(
  {
    path: RelativePathSchema,
    versionTime: IsoDateTimeSchema,
    size: Type.Integer({ minimum: 0 }),
  },
  { $id: 'VersionEntry', additionalProperties: false },
);

export type VersionEntry = Static<typeof VersionEntrySchema>;

export const VersionListSchema = Type.Object(
  { items: Type.Array(VersionEntrySchema) },
  { $id: 'VersionList', additionalProperties: false },
);

export type VersionList = Static<typeof VersionListSchema>;

export const RestoreVersionsRequestSchema = Type.Object(
  {
    path: RelativePathSchema,
    versionTime: IsoDateTimeSchema,
  },
  { $id: 'RestoreVersionsRequest', additionalProperties: false },
);

export type RestoreVersionsRequest = Static<typeof RestoreVersionsRequestSchema>;

export const RevealFileRequestSchema = Type.Object(
  { path: RelativePathSchema },
  { $id: 'RevealFileRequest', additionalProperties: false },
);

export type RevealFileRequest = Static<typeof RevealFileRequestSchema>;

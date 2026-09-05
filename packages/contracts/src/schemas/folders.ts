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

export const FolderErrorCodeSchema = Type.Union([
  Type.Literal('marker_missing'),
  Type.Literal('path_missing'),
  Type.Literal('access_denied'),
  Type.Literal('disk_full'),
  Type.Literal('watch_failed'),
  Type.Literal('file_errors'),
  Type.Literal('status_unavailable'),
  Type.Literal('unknown'),
]);

export type FolderErrorCode = Static<typeof FolderErrorCodeSchema>;

export const FolderPeerProgressSchema = Type.Object(
  {
    deviceId: DeviceIdSchema,
    completion: Type.Number({ minimum: 0, maximum: 100 }),
    needBytes: Type.Integer({ minimum: 0 }),
    needItems: Type.Integer({ minimum: 0 }),
    needDeletes: Type.Integer({ minimum: 0 }),
    remoteState: Type.Union([
      Type.Literal('unknown'),
      Type.Literal('paused'),
      Type.Literal('notSharing'),
      Type.Literal('valid'),
    ]),
  },
  { $id: 'FolderPeerProgress', additionalProperties: false },
);

export type FolderPeerProgress = Static<typeof FolderPeerProgressSchema>;

export const FolderPathConflictSchema = Type.Object(
  {
    folderId: FolderIdSchema,
    label: Type.String({ minLength: 1, maxLength: 128 }),
    relation: Type.Union([
      Type.Literal('same'),
      Type.Literal('ancestor'),
      Type.Literal('descendant'),
    ]),
  },
  { $id: 'FolderPathConflict', additionalProperties: false },
);

export type FolderPathConflict = Static<typeof FolderPathConflictSchema>;

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
    needItems: Type.Optional(Type.Integer({ minimum: 0 })),
    needDeletes: Type.Optional(Type.Integer({ minimum: 0 })),
    receiveOnlyChangedItems: Type.Optional(Type.Integer({ minimum: 0 })),
    receiveOnlyChangedBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    peerProgress: Type.Optional(Type.Array(FolderPeerProgressSchema)),
    pathConflicts: Type.Optional(Type.Array(FolderPathConflictSchema)),
    rescanIntervalSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
    lastCompletedAt: Type.Optional(IsoDateTimeSchema),
    error: Type.Union([Type.String(), Type.Null()]),
    errorCode: Type.Union([FolderErrorCodeSchema, Type.Null()]),
    errorCount: Type.Integer({ minimum: 0 }),
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
    directoryId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    confirmDirectoryMove: Type.Optional(Type.Boolean()),
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
    directoryId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    type: Type.Optional(FolderTypeSchema),
    useExisting: Type.Optional(Type.Boolean()),
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

export const VersionListQuerySchema = Type.Object(
  {
    search: Type.Optional(Type.String({ maxLength: 255 })),
    path: Type.Optional(RelativePathSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { $id: 'VersionListQuery', additionalProperties: false },
);

export type VersionListQuery = Static<typeof VersionListQuerySchema>;

export const VersionListSchema = Type.Object(
  {
    items: Type.Array(VersionEntrySchema),
    nextCursor: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
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

export const FolderIgnoreListSchema = Type.Object(
  {
    lines: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 10_000 }),
    hasIncludes: Type.Boolean(),
  },
  { $id: 'FolderIgnoreList', additionalProperties: false },
);

export type FolderIgnoreList = Static<typeof FolderIgnoreListSchema>;

export const UpdateFolderIgnoresRequestSchema = Type.Object(
  { lines: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 10_000 }) },
  { $id: 'UpdateFolderIgnoresRequest', additionalProperties: false },
);

export type UpdateFolderIgnoresRequest = Static<typeof UpdateFolderIgnoresRequestSchema>;

export const FolderItemErrorSchema = Type.Object(
  { path: RelativePathSchema, message: Type.String({ minLength: 1, maxLength: 2048 }) },
  { $id: 'FolderItemError', additionalProperties: false },
);

export const FolderErrorListSchema = Type.Object(
  {
    items: Type.Array(FolderItemErrorSchema),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'FolderErrorList', additionalProperties: false },
);

export type FolderErrorList = Static<typeof FolderErrorListSchema>;

export const FolderConflictSchema = Type.Object(
  {
    conflictPath: RelativePathSchema,
    originalPath: Type.Union([RelativePathSchema, Type.Null()]),
    size: Type.Integer({ minimum: 0 }),
    modifiedAt: IsoDateTimeSchema,
  },
  { $id: 'FolderConflict', additionalProperties: false },
);

export const FolderConflictListSchema = Type.Object(
  {
    items: Type.Array(FolderConflictSchema),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'FolderConflictList', additionalProperties: false },
);

export type FolderConflictList = Static<typeof FolderConflictListSchema>;

export const PagedFolderQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { $id: 'PagedFolderQuery', additionalProperties: false },
);

export type PagedFolderQuery = Static<typeof PagedFolderQuerySchema>;

import { Type, type Static } from '@sinclair/typebox';

export const IsoDateTimeSchema = Type.String({ format: 'date-time' });

/** Syncthing device identifier, kept intentionally opaque to callers. */
export const DeviceIdSchema = Type.String({
  pattern: '^[A-Za-z2-7]{7}(?:-[A-Za-z2-7]{7}){7}$',
  description: '完整的 Syncthing Device ID；输入时允许小写，服务端会规范化为大写',
});

/**
 * Syncthing itself accepts almost any non-empty folder ID. KiteSync keeps that
 * interoperability while excluding path separators, control characters and the two
 * path-navigation-only values before an ID can enter HTTP routes or the UI.
 */
export const FolderIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: '^(?!\\.{1,2}$)[^\\\\/\\u0000-\\u001F\\u007F]{1,64}$',
});

/** A path relative to a shared folder. An empty string denotes its root. */
export const RelativePathSchema = Type.String({
  maxLength: 4096,
  pattern: '^(?![\\\\/])(?![A-Za-z]:[\\\\/])(?!.*(?:^|[\\\\/])\\.\\.?(?:[\\\\/]|$))[^\\u0000]*$',
  description: '使用相对路径；空字符串表示文件夹根目录',
});

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
  { $id: 'ProblemDetails', additionalProperties: false },
);

export type ProblemDetails = Static<typeof ProblemDetailsSchema>;

export const MessageResponseSchema = Type.Object(
  { message: Type.String() },
  { $id: 'MessageResponse', additionalProperties: false },
);

export type MessageResponse = Static<typeof MessageResponseSchema>;

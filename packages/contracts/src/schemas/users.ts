import { Type, type Static } from '@sinclair/typebox';
import { IdSchema, IsoDateTimeSchema } from './common.js';

export const UserRoleSchema = Type.Union([Type.Literal('admin'), Type.Literal('member')]);
export type UserRole = Static<typeof UserRoleSchema>;

export const UserSchema = Type.Object(
  {
    id: IdSchema,
    username: Type.String({ minLength: 3, maxLength: 64 }),
    displayName: Type.String({ minLength: 1, maxLength: 128 }),
    role: UserRoleSchema,
    active: Type.Boolean(),
    createdAt: IsoDateTimeSchema,
  },
  { $id: 'User' },
);

export type User = Static<typeof UserSchema>;

export const BootstrapAdminRequestSchema = Type.Object({
  token: Type.String({ minLength: 16, maxLength: 512 }),
  username: Type.String({ minLength: 3, maxLength: 64 }),
  displayName: Type.String({ minLength: 1, maxLength: 128 }),
  password: Type.String({ minLength: 12, maxLength: 256 }),
});

export const LoginRequestSchema = Type.Object({
  username: Type.String({ minLength: 3, maxLength: 64 }),
  password: Type.String({ minLength: 1, maxLength: 256 }),
});

export const SessionSchema = Type.Object({
  user: UserSchema,
  csrfToken: Type.String(),
  expiresAt: IsoDateTimeSchema,
});

export const DesktopSessionSchema = Type.Intersect([
  SessionSchema,
  Type.Object({
    accessToken: Type.String({ minLength: 32 }),
    refreshToken: Type.String({ minLength: 32 }),
  }),
]);

export const RefreshDesktopSessionRequestSchema = Type.Object({
  refreshToken: Type.String({ minLength: 32 }),
});

export const CreateUserRequestSchema = Type.Object({
  username: Type.String({ minLength: 3, maxLength: 64 }),
  displayName: Type.String({ minLength: 1, maxLength: 128 }),
  role: Type.Optional(
    Type.Union([Type.Literal('admin'), Type.Literal('member')], {
      default: 'member',
    }),
  ),
  password: Type.String({ minLength: 12, maxLength: 256 }),
});

export const CreateInvitationRequestSchema = Type.Object({
  username: Type.String({ minLength: 3, maxLength: 64 }),
  displayName: Type.String({ minLength: 1, maxLength: 128 }),
  role: Type.Optional(
    Type.Union([Type.Literal('admin'), Type.Literal('member')], { default: 'member' }),
  ),
});

export const InvitationSchema = Type.Object({
  id: IdSchema,
  username: Type.String(),
  token: Type.String({ minLength: 32 }),
  expiresAt: IsoDateTimeSchema,
});

export const AcceptInvitationRequestSchema = Type.Object({
  token: Type.String({ minLength: 32 }),
  password: Type.String({ minLength: 12, maxLength: 256 }),
});

export const PasswordResetTokenSchema = Type.Object({
  token: Type.String({ minLength: 32 }),
  expiresAt: IsoDateTimeSchema,
});

export const ResetPasswordRequestSchema = Type.Object({
  token: Type.String({ minLength: 32 }),
  password: Type.String({ minLength: 12, maxLength: 256 }),
});

export const UserSessionSchema = Type.Object({
  id: IdSchema,
  userId: IdSchema,
  current: Type.Boolean(),
  expiresAt: IsoDateTimeSchema,
  lastUsedAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
});

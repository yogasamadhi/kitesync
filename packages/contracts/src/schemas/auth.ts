import { Type, type Static } from '@sinclair/typebox';
import { IsoDateTimeSchema } from './common.js';

export const PasswordSchema = Type.String({ minLength: 12, maxLength: 256 });

export const AuthStatusSchema = Type.Object(
  { setupRequired: Type.Boolean() },
  { $id: 'AuthStatus', additionalProperties: false },
);

export type AuthStatus = Static<typeof AuthStatusSchema>;

export const SetupRequestSchema = Type.Object(
  { password: PasswordSchema },
  { $id: 'SetupRequest', additionalProperties: false },
);

export type SetupRequest = Static<typeof SetupRequestSchema>;

export const LoginRequestSchema = Type.Object(
  { password: Type.String({ minLength: 1, maxLength: 256 }) },
  { $id: 'LoginRequest', additionalProperties: false },
);

export type LoginRequest = Static<typeof LoginRequestSchema>;

export const ChangePasswordRequestSchema = Type.Object(
  {
    currentPassword: Type.String({ minLength: 1, maxLength: 256 }),
    newPassword: PasswordSchema,
  },
  { $id: 'ChangePasswordRequest', additionalProperties: false },
);

export type ChangePasswordRequest = Static<typeof ChangePasswordRequestSchema>;

export const ResetPasswordRequestSchema = Type.Object(
  { newPassword: PasswordSchema },
  { $id: 'ResetPasswordRequest', additionalProperties: false },
);

export type ResetPasswordRequest = Static<typeof ResetPasswordRequestSchema>;

export const OpenTokenLoginRequestSchema = Type.Object(
  { token: Type.String({ minLength: 16, maxLength: 512 }) },
  { $id: 'OpenTokenLoginRequest', additionalProperties: false },
);

export type OpenTokenLoginRequest = Static<typeof OpenTokenLoginRequestSchema>;

export const AuthSessionSchema = Type.Object(
  {
    authenticated: Type.Literal(true),
    csrfToken: Type.String({ minLength: 16 }),
    expiresAt: IsoDateTimeSchema,
  },
  { $id: 'AuthSession', additionalProperties: false },
);

export type AuthSession = Static<typeof AuthSessionSchema>;

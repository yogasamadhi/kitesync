import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { BootstrapAdminRequestSchema, HealthSchema } from './index.js';

describe('contracts', () => {
  it('accepts valid health payloads', () => {
    expect(Value.Check(HealthSchema, { status: 'ok' })).toBe(true);
  });

  it('requires a strong bootstrap password', () => {
    expect(
      Value.Check(BootstrapAdminRequestSchema, {
        token: '1234567890123456',
        username: 'admin',
        displayName: 'Administrator',
        password: 'too-short',
      }),
    ).toBe(false);
  });
});

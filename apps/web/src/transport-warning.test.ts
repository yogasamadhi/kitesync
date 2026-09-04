import { describe, expect, it } from 'vitest';
import { shouldShowUnencryptedLanWarning } from './transport-warning.js';

describe('局域网 HTTP 警告', () => {
  it('只对非 loopback 的直接 HTTP 地址显示', () => {
    expect(shouldShowUnencryptedLanWarning('http:', '192.168.1.20')).toBe(true);
    expect(shouldShowUnencryptedLanWarning('http:', 'kitesync.local')).toBe(true);
    expect(shouldShowUnencryptedLanWarning('https:', '192.168.1.20')).toBe(false);
    expect(shouldShowUnencryptedLanWarning('http:', 'localhost')).toBe(false);
    expect(shouldShowUnencryptedLanWarning('http:', '127.0.0.2')).toBe(false);
    expect(shouldShowUnencryptedLanWarning('http:', '[::1]')).toBe(false);
    expect(shouldShowUnencryptedLanWarning('http:', '[::ffff:127.0.0.1]')).toBe(false);
  });
});

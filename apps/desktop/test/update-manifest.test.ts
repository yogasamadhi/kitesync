import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson } from '@kitesync/contracts';
import { describe, expect, it } from 'vitest';
import { authorizesUpdate, parseAndVerifyUpdateManifest } from '../src/main/update-manifest.js';

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const payload = {
    version: '1.2.3',
    channel: 'stable' as const,
    minimumClientVersion: '1.0.0',
    assets: [
      {
        platform: 'darwin',
        arch: 'arm64',
        url: 'https://updates.example/KiteSync-1.2.3-arm64.dmg',
        sha512: 'signed-sha512',
      },
    ],
  };
  const signature = sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64');
  return {
    document: JSON.stringify({ payload, signature }),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

describe('desktop update manifest', () => {
  it('authorizes only the signed platform artifact and checksum', () => {
    const value = fixture();
    const manifest = parseAndVerifyUpdateManifest(value.document, value.publicKey);
    expect(
      authorizesUpdate(
        manifest,
        {
          version: '1.2.3',
          files: [{ url: 'KiteSync-1.2.3-arm64.dmg', sha512: 'signed-sha512' }],
        },
        'darwin',
        'arm64',
      ),
    ).toBe(true);
    expect(
      authorizesUpdate(
        manifest,
        {
          version: '1.2.3',
          files: [{ url: 'KiteSync-1.2.3-arm64.dmg', sha512: 'tampered' }],
        },
        'darwin',
        'arm64',
      ),
    ).toBe(false);
  });

  it('rejects a payload changed after signing', () => {
    const value = fixture();
    const changed = value.document.replace('1.2.3', '1.2.4');
    expect(() => parseAndVerifyUpdateManifest(changed, value.publicKey)).toThrow(
      'signature is invalid',
    );
  });
});

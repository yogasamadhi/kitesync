import { createPublicKey, verify } from 'node:crypto';
import { basename } from 'node:path';
import { canonicalJson } from '@kitesync/contracts';

export interface UpdateManifestAsset {
  platform: string;
  arch: string;
  url: string;
  sha512: string;
}

export interface UpdateManifestPayload {
  version: string;
  channel: 'stable';
  minimumClientVersion?: string;
  assets: UpdateManifestAsset[];
}

export interface SignedUpdateManifest {
  payload: UpdateManifestPayload;
  signature: string;
}

export interface UpdateDescriptor {
  version: string;
  files: Array<{ url: string; sha512?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAsset(value: unknown): value is UpdateManifestAsset {
  if (!isRecord(value)) return false;
  return ['platform', 'arch', 'url', 'sha512'].every(
    (key) => typeof value[key] === 'string' && value[key].length > 0,
  );
}

export function parseAndVerifyUpdateManifest(
  input: string,
  publicKeyPem: string,
): SignedUpdateManifest {
  const document: unknown = JSON.parse(input);
  if (
    !isRecord(document) ||
    !isRecord(document.payload) ||
    typeof document.signature !== 'string'
  ) {
    throw new Error('Update manifest envelope is invalid');
  }
  const payload = document.payload;
  if (
    typeof payload.version !== 'string' ||
    payload.channel !== 'stable' ||
    !Array.isArray(payload.assets) ||
    payload.assets.length === 0 ||
    !payload.assets.every(isAsset) ||
    (payload.minimumClientVersion !== undefined && typeof payload.minimumClientVersion !== 'string')
  ) {
    throw new Error('Update manifest payload is invalid');
  }
  const valid = verify(
    null,
    Buffer.from(canonicalJson(payload)),
    createPublicKey(publicKeyPem),
    Buffer.from(document.signature, 'base64'),
  );
  if (!valid) throw new Error('Update manifest signature is invalid');
  return document as unknown as SignedUpdateManifest;
}

function assetName(url: string): string {
  try {
    return basename(decodeURIComponent(new URL(url, 'https://updates.invalid/').pathname));
  } catch {
    return '';
  }
}

export function authorizesUpdate(
  manifest: SignedUpdateManifest,
  update: UpdateDescriptor,
  platform: NodeJS.Platform,
  arch: string,
): boolean {
  if (manifest.payload.version !== update.version) return false;
  const assets = manifest.payload.assets.filter(
    (asset) => asset.platform === platform && asset.arch === arch,
  );
  if (assets.length === 0 || update.files.length === 0) return false;
  return update.files.some((file) =>
    assets.some(
      (asset) =>
        assetName(asset.url) === assetName(file.url) &&
        asset.sha512.length > 0 &&
        asset.sha512 === file.sha512,
    ),
  );
}

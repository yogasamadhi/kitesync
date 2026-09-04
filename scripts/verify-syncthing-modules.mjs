#!/usr/bin/env bun

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const verifier = resolve(import.meta.dirname, 'verify-syncthing-modules.go');
const defaultInventory = resolve(repositoryRoot, 'vendor/syncthing/GO_MODULES.json');

export function assertSyncthingBinaryModules(binary, inventory = defaultInventory) {
  execFileSync('go', ['run', verifier, resolve(inventory), resolve(binary)], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: { ...process.env, GOWORK: 'off' },
  });
}

if (import.meta.main) {
  const [binaryArgument, inventoryArgument] = process.argv.slice(2);
  if (!binaryArgument) {
    throw new Error('用法：bun scripts/verify-syncthing-modules.mjs <syncthing> [GO_MODULES.json]');
  }
  assertSyncthingBinaryModules(binaryArgument, inventoryArgument);
}

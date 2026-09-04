#!/usr/bin/env bun

import { writeFile } from 'node:fs/promises';

import {
  collectGoModuleArtifacts,
  goModuleInventoryPath,
  goModuleNoticesPath,
} from './go-module-licenses.mjs';

const artifacts = collectGoModuleArtifacts();
await Promise.all([
  writeFile(goModuleInventoryPath, artifacts.inventoryText),
  writeFile(goModuleNoticesPath, artifacts.noticesText),
]);
console.log(
  `Wrote ${artifacts.inventory.modules.length} reviewed Go modules to ${goModuleInventoryPath}`,
);
console.log(`Wrote complete Go module license texts to ${goModuleNoticesPath}`);

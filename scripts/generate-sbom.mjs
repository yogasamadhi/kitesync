import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectDependencies } from './dependency-inventory.mjs';
import {
  deniedLicensePattern,
  goModuleInventoryPath,
  loadGoModuleInventory,
} from './go-module-licenses.mjs';

const dependencies = await collectDependencies();
const goModuleInventory = loadGoModuleInventory();
for (const module of goModuleInventory.modules) {
  if (module.license === 'UNKNOWN' || deniedLicensePattern.test(module.license)) {
    throw new Error(`${module.path}@${module.version} 使用未知或不允许的许可证：${module.license}`);
  }
}
const rootManifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
const syncthing = JSON.parse(await readFile(resolve('vendor/syncthing/UPSTREAM.json'), 'utf8'));
const applicationVersion = (process.env.KITESYNC_VERSION ?? '1.0.0')
  .replace(/^v/, '')
  .split('+')[0];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(applicationVersion)) {
  throw new Error(`无效的 SBOM 版本：${process.env.KITESYNC_VERSION}`);
}

function npmPurlName(name) {
  if (!name.startsWith('@')) return encodeURIComponent(name);
  const separator = name.indexOf('/');
  if (separator < 2 || separator === name.length - 1) return encodeURIComponent(name);
  const scope = name.slice(0, separator);
  const packageName = name.slice(separator + 1);
  return `${encodeURIComponent(scope)}/${encodeURIComponent(packageName)}`;
}

function goPurl(path, version) {
  return `pkg:golang/${path}@${encodeURIComponent(version)}`;
}

function licenseChoice(expression) {
  return expression === 'UNKNOWN' ? [] : [{ expression }];
}

function deterministicUuid(value) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const bunVersion = String(rootManifest.packageManager ?? '').match(/^bun@(.+)$/)?.[1];
if (!bunVersion) throw new Error('package.json 必须固定 Bun packageManager 版本');

const components = [
  ...dependencies.map((dependency) => ({
    type: 'library',
    name: dependency.name,
    version: dependency.version,
    licenses: licenseChoice(dependency.license),
    purl: `pkg:npm/${npmPurlName(dependency.name)}@${dependency.version}`,
  })),
  ...goModuleInventory.modules.map((module) => ({
    type: 'library',
    name: module.path,
    version: module.version,
    scope: 'required',
    licenses: licenseChoice(module.license),
    purl: goPurl(module.path, module.version),
    properties: [
      { name: 'kitesync:goBuildTargets', value: module.targets.join(',') },
      ...module.licenseFiles.map((file) => ({
        name: `kitesync:licenseFileSha256:${file.path}`,
        value: file.sha256,
      })),
      ...(module.replacement
        ? [
            { name: 'kitesync:goReplacementPath', value: module.replacement.path },
            { name: 'kitesync:goReplacementVersion', value: module.replacement.version },
            {
              name: 'kitesync:goReplacementPurl',
              value: goPurl(module.replacement.path, module.replacement.version),
            },
          ]
        : []),
    ],
  })),
  {
    type: 'application',
    name: 'syncthing',
    version: syncthing.version.replace(/^v/, ''),
    licenses: licenseChoice(syncthing.license),
    purl: `pkg:golang/github.com/syncthing/syncthing@${syncthing.version}`,
    properties: [
      { name: 'kitesync:sourceCommit', value: syncthing.commit },
      { name: 'kitesync:sourceTree', value: syncthing.tree },
      {
        name: 'kitesync:goModuleInventorySha256',
        value: createHash('sha256')
          .update(await readFile(goModuleInventoryPath))
          .digest('hex'),
      },
    ],
  },
  {
    type: 'framework',
    name: 'Bun',
    version: bunVersion,
    licenses: licenseChoice('MIT'),
    purl: `pkg:generic/bun@${bunVersion}`,
  },
];
const serialSeed = JSON.stringify({ applicationVersion, components });
const document = {
  $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${deterministicUuid(serialSeed)}`,
  version: 1,
  metadata: {
    component: { type: 'application', name: 'kitesync', version: applicationVersion },
  },
  components,
};
const output = resolve('kitesync-sbom.cdx.json');
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${components.length} components to ${output}`);

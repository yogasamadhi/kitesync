import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectDependencies } from './dependency-inventory.mjs';

const dependencies = await collectDependencies();
const document = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: { type: 'application', name: 'kitesync', version: '1.0.0' },
  },
  components: dependencies.map((dependency) => ({
    type: 'library',
    name: dependency.name,
    version: dependency.version,
    licenses:
      dependency.license === 'UNKNOWN' ? [] : [{ license: { expression: dependency.license } }],
    purl: `pkg:npm/${encodeURIComponent(dependency.name)}@${dependency.version}`,
  })),
};
const output = resolve('kitesync-sbom.cdx.json');
await writeFile(output, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${dependencies.length} components to ${output}`);

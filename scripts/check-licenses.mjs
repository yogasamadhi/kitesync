import { collectDependencies } from './dependency-inventory.mjs';

const denied = /\b(?:AGPL-1\.0|AGPL-3\.0|SSPL-1\.0|BUSL-1\.1)(?:-only|-or-later)?\b/;
const findings = (await collectDependencies())
  .filter((dependency) => denied.test(dependency.license))
  .map((dependency) => `${dependency.license}: ${dependency.name}@${dependency.version}`);
if (findings.length) throw new Error(`Denied dependency licenses found:\n${findings.join('\n')}`);
console.log('Dependency licenses passed the deny-list gate.');

import { collectDependencies } from './dependency-inventory.mjs';
import { deniedLicensePattern, verifyGoModuleArtifacts } from './go-module-licenses.mjs';

const dependencies = await collectDependencies();
const unknown = dependencies
  .filter(
    (dependency) => dependency.license === 'UNKNOWN' && !dependency.name.startsWith('@kitesync/'),
  )
  .map((dependency) => `${dependency.name}@${dependency.version}`);
if (unknown.length) throw new Error(`Dependencies with unknown licenses:\n${unknown.join('\n')}`);

const findings = dependencies
  .filter((dependency) => deniedLicensePattern.test(dependency.license))
  .map((dependency) => `${dependency.license}: ${dependency.name}@${dependency.version}`);
if (findings.length) throw new Error(`Denied dependency licenses found:\n${findings.join('\n')}`);

const goInventory = verifyGoModuleArtifacts();
const invalidGoModules = goInventory.modules
  .filter(
    (module) =>
      module.license === 'UNKNOWN' ||
      deniedLicensePattern.test(module.license) ||
      !Array.isArray(module.licenseFiles) ||
      module.licenseFiles.length === 0,
  )
  .map((module) => `${module.license}: ${module.path}@${module.version}`);
if (invalidGoModules.length) {
  throw new Error(`Go modules with missing or denied licenses:\n${invalidGoModules.join('\n')}`);
}
console.log(
  `Dependency licenses passed: ${dependencies.length} Bun packages and ${goInventory.modules.length} linked Go modules.`,
);

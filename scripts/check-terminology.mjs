import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const activeRoots = ['apps/node-service', 'apps/web', 'packages', 'deploy', '.github/workflows'];
const forbidden = [
  /@kitesync\/(?:client-service|control-plane|hub-controller|backup-controller)/i,
  /services\/(?:hub-controller|backup-controller|filebrowser-quantum|postgresql)/i,
  /vendor\/filebrowser-quantum/i,
  /syncthing-hub/i,
  /deploy\/(?:compose|helm)/i,
  /@testcontainers\//i,
  /KITESYNC_DATABASE_URL/i,
  /minio\/minio:/i,
];
const forbiddenRuntimePaths = [
  'apps/client-service',
  'apps/desktop',
  'apps/control-plane/package.json',
  'apps/control-plane/Dockerfile',
  'apps/control-plane/src',
  'services/hub-controller',
  'services/backup-controller',
  'services/postgresql',
  'deploy/compose',
  'deploy/helm',
  'vendor/filebrowser-quantum',
];

async function visit(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (['node_modules', 'dist', 'release', '.package'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await visit(path)));
    else files.push(path);
  }
  return files;
}

const violations = [];
for (const name of forbiddenRuntimePaths) {
  const path = resolve(root, name);
  if (existsSync(path)) violations.push(relative(root, path));
}
for (const name of activeRoots) {
  for (const path of await visit(resolve(root, name))) {
    if (/\.(?:png|jpg|jpeg|gif|ico|zip|gz|pdf)$/i.test(path)) continue;
    const content = await readFile(path, 'utf8').catch(() => '');
    if (forbidden.some((pattern) => pattern.test(content))) violations.push(relative(root, path));
  }
}

const packageJson = await readFile(resolve(root, 'package.json'), 'utf8');
if (forbidden.some((pattern) => pattern.test(packageJson))) violations.push('package.json');

if (violations.length) {
  throw new Error(`活动运行路径仍引用已删除的中心组件：\n${[...new Set(violations)].join('\n')}`);
}
console.log('KiteSync P2P Node 术语检查通过。');

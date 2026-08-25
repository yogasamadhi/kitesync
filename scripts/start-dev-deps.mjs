import { run } from './command.mjs';
import { execFileSync } from 'node:child_process';

run('bun', ['run', 'dev:certs']);
run('docker', ['compose', '-f', 'deploy/compose/docker-compose.yml', 'up', '-d', '--build']);

const composeArguments = ['compose', '-f', 'deploy/compose/docker-compose.yml'];
const required = new Set(['postgres', 'minio', 'syncthing-hub', 'hub-agent']);
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  const lines = execFileSync('docker', [...composeArguments, 'ps', '--format', 'json'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  const services = new Map(
    lines.map((line) => {
      const item = JSON.parse(line);
      return [item.Service, item];
    }),
  );
  const ready = [...required].every((name) => {
    const item = services.get(name);
    return item?.State === 'running' && (!item.Health || item.Health === 'healthy');
  });
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
const finalState = execFileSync('docker', [...composeArguments, 'ps', '--format', 'json'], {
  encoding: 'utf8',
});
const finalServices = new Map(
  finalState
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const item = JSON.parse(line);
      return [item.Service, item];
    }),
);
for (const name of required) {
  const item = finalServices.get(name);
  if (item?.State !== 'running' || (item.Health && item.Health !== 'healthy')) {
    throw new Error(`Development dependency ${name} did not become ready`);
  }
}
run('bun', ['run', '--filter', '@kitesync/control-plane', 'db:migrate']);
console.log('Development dependencies are ready.');

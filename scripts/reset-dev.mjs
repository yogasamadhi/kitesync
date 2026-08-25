import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { run } from './command.mjs';

const argumentConfirmed = process.argv.includes('--yes');
let confirmed = argumentConfirmed;

if (!confirmed) {
  const prompt = createInterface({ input: stdin, output: stdout });
  const answer = await prompt.question(
    'This removes KiteSync development PostgreSQL, MinIO and Hub volumes. Type RESET to continue: ',
  );
  prompt.close();
  confirmed = answer === 'RESET';
}

if (!confirmed) {
  console.log('Reset canceled.');
  process.exit(1);
}

run('docker', ['compose', '-f', 'deploy/compose/docker-compose.yml', 'down', '-v']);
run('bun', ['run', 'dev:deps']);

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const url = process.env.KITESYNC_OPENAPI_URL ?? 'http://127.0.0.1:3000/docs/json';
const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`OpenAPI endpoint returned ${response.status}`);
const document = await response.json();
const output = resolve('packages/api-client/openapi.json');
await mkdir(resolve('packages/api-client'), { recursive: true });
await writeFile(output, JSON.stringify(document, null, 2) + '\n');
console.log(`Generated ${output}`);

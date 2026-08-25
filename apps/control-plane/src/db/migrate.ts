import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config.js';
import { createDatabase } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const { db, pool } = createDatabase(config);

await migrate(db, { migrationsFolder: resolve(here, '../../migrations') });
await pool.end();

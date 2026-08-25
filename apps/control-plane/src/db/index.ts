import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { ControlPlaneConfig } from '../config.js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>['db'];

export function createDatabase(config: Pick<ControlPlaneConfig, 'databaseUrl'>) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
  });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

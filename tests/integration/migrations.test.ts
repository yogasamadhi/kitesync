import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

describe('PostgreSQL migrations', () => {
  let container: StartedPostgreSqlContainer;
  let client: pg.Client;
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    client = new pg.Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    for (const name of [
      '0000_initial.sql',
      '0001_desktop_refresh_tokens.sql',
      '0002_account_lifecycle.sql',
      '0003_syncthing_identity_bindings.sql',
    ]) {
      await client.query(await readFile(resolve('apps/control-plane/migrations', name), 'utf8'));
    }
  });
  afterAll(async () => {
    await client?.end();
    await container?.stop();
  });

  test('creates the server-centric domain schema and stable development hub', async () => {
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'users',
        'devices',
        'sync_spaces',
        'device_space_bindings',
        'reconciliation_jobs',
        'desktop_refresh_tokens',
        'account_tokens',
        'syncthing_identity_bindings',
      ]),
    );
    const hub = await client.query('SELECT syncthing_device_id, capacity_bytes FROM hubs');
    expect(hub.rows).toHaveLength(1);
    expect(Number(hub.rows[0].capacity_bytes)).toBe(10 * 1024 ** 4);
  });
});

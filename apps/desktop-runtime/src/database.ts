import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class RuntimeDatabase {
  readonly sqlite: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS directory_bindings (
        id TEXT PRIMARY KEY,
        server_binding_id TEXT,
        sync_space_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  get(key: string) {
    const row = this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  set(key: string, value: string) {
    this.sqlite
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  event(type: string, payload: Record<string, unknown>) {
    this.sqlite
      .prepare('INSERT INTO events (type, payload, occurred_at) VALUES (?, ?, ?)')
      .run(type, JSON.stringify(payload), new Date().toISOString());
  }

  close() {
    this.sqlite.close();
  }
}

import { getDb } from './db.js';

/* Simple typed key/value store backed by the `kv` table. */

export function kvSet(key: string, value: unknown): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, JSON.stringify(value));
}

export function kvGet<T>(key: string): T | undefined {
  const db = getDb();
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  return JSON.parse(row.value) as T;
}

export function kvDelete(key: string): void {
  getDb().prepare('DELETE FROM kv WHERE key = ?').run(key);
}

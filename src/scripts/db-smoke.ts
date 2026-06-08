/* Smoke test for the SQLite layer: migrate, write, read, list tables. */
import { getDb, closeDb } from '../state/db.js';
import { kvSet, kvGet } from '../state/kv.js';
import { log } from '../util/logger.js';

const db = getDb();

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all() as { name: string }[];
log.info('tables:', tables.map((t) => t.name).join(', '));

kvSet('smoke', { ok: true, at: new Date().toISOString() });
const back = kvGet<{ ok: boolean; at: string }>('smoke');
log.info('kv round-trip:', back);

const version = db.prepare('SELECT MAX(version) AS v FROM _schema_version').get();
log.info('schema version:', version);

closeDb();
log.info('db smoke test complete');

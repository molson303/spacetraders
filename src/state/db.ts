import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('db');

/*
 * Schema for the bot's persisted world + fleet state.
 * Bumping SCHEMA_VERSION and adding a migration block keeps existing DBs upgradable.
 */
const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS waypoints (
    symbol       TEXT PRIMARY KEY,
    system       TEXT NOT NULL,
    type         TEXT NOT NULL,
    x            INTEGER NOT NULL,
    y            INTEGER NOT NULL,
    traits       TEXT NOT NULL DEFAULT '[]',  -- json array of trait symbols
    is_under_construction INTEGER NOT NULL DEFAULT 0,
    charted      INTEGER NOT NULL DEFAULT 0,
    raw          TEXT,                          -- full json
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_waypoints_system ON waypoints(system);
  CREATE INDEX IF NOT EXISTS idx_waypoints_type   ON waypoints(type);

  CREATE TABLE IF NOT EXISTS markets (
    symbol       TEXT PRIMARY KEY,             -- waypoint symbol
    system       TEXT NOT NULL,
    imports      TEXT NOT NULL DEFAULT '[]',   -- json array of trade symbols
    exports      TEXT NOT NULL DEFAULT '[]',
    exchange     TEXT NOT NULL DEFAULT '[]',
    raw          TEXT,
    last_scanned TEXT
  );

  -- Time-series of observed prices per good per market.
  CREATE TABLE IF NOT EXISTS market_prices (
    waypoint      TEXT NOT NULL,
    system        TEXT NOT NULL,
    trade_symbol  TEXT NOT NULL,
    type          TEXT,                        -- IMPORT / EXPORT / EXCHANGE
    trade_volume  INTEGER,
    supply        TEXT,
    activity      TEXT,
    purchase_price INTEGER,                    -- price we pay to buy
    sell_price    INTEGER,                     -- price we get to sell
    observed_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_prices_good ON market_prices(trade_symbol);
  CREATE INDEX IF NOT EXISTS idx_prices_wp   ON market_prices(waypoint);
  CREATE INDEX IF NOT EXISTS idx_prices_time ON market_prices(observed_at);

  -- Latest snapshot per (waypoint, good) for fast route-finding.
  CREATE TABLE IF NOT EXISTS market_latest (
    waypoint      TEXT NOT NULL,
    system        TEXT NOT NULL,
    trade_symbol  TEXT NOT NULL,
    type          TEXT,
    trade_volume  INTEGER,
    supply        TEXT,
    activity      TEXT,
    purchase_price INTEGER,
    sell_price    INTEGER,
    observed_at   TEXT NOT NULL,
    PRIMARY KEY (waypoint, trade_symbol)
  );
  CREATE INDEX IF NOT EXISTS idx_latest_good ON market_latest(trade_symbol);

  CREATE TABLE IF NOT EXISTS shipyards (
    symbol       TEXT PRIMARY KEY,
    system       TEXT NOT NULL,
    ship_types   TEXT NOT NULL DEFAULT '[]',
    ships        TEXT,                          -- json with prices (only when a ship is present)
    raw          TEXT,
    last_scanned TEXT
  );

  CREATE TABLE IF NOT EXISTS ships (
    symbol        TEXT PRIMARY KEY,
    role          TEXT,                         -- assigned bot role
    registration_role TEXT,
    frame         TEXT,
    nav_status    TEXT,
    nav_system    TEXT,
    nav_waypoint  TEXT,
    flight_mode   TEXT,
    fuel_current  INTEGER,
    fuel_capacity INTEGER,
    cargo_units   INTEGER,
    cargo_capacity INTEGER,
    cooldown_until TEXT,
    arrival_at    TEXT,
    task          TEXT,                         -- current task / target json
    raw           TEXT,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contracts (
    id           TEXT PRIMARY KEY,
    faction      TEXT,
    type         TEXT,
    accepted     INTEGER NOT NULL DEFAULT 0,
    fulfilled    INTEGER NOT NULL DEFAULT 0,
    deadline     TEXT,
    terms        TEXT,                          -- json
    raw          TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    observed_at  TEXT NOT NULL DEFAULT (datetime('now')),
    ship         TEXT,
    kind         TEXT,                          -- BUY_CARGO / SELL_CARGO / BUY_SHIP / REFUEL / DELIVER / FULFILL ...
    waypoint     TEXT,
    trade_symbol TEXT,
    units        INTEGER,
    price_per    INTEGER,
    total        INTEGER,                       -- signed: negative = spent, positive = earned
    credits_after INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tx_time ON transactions(observed_at);
  CREATE INDEX IF NOT EXISTS idx_tx_ship ON transactions(ship);
  `,
  // v2 — cross-system travel: systems + jump gate topology
  `
  CREATE TABLE IF NOT EXISTS systems (
    symbol     TEXT PRIMARY KEY,
    sector     TEXT,
    type       TEXT,
    x          INTEGER NOT NULL,
    y          INTEGER NOT NULL,
    raw        TEXT,                          -- full json (incl. waypoints)
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A jump gate waypoint and the gate waypoints it connects to (other systems).
  CREATE TABLE IF NOT EXISTS jump_gates (
    symbol       TEXT PRIMARY KEY,            -- gate waypoint symbol
    system       TEXT NOT NULL,
    connections  TEXT NOT NULL DEFAULT '[]',  -- json array of connected gate waypoint symbols
    last_scanned TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jump_gates_system ON jump_gates(system);
  `,
];

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;

  if (config.databasePath !== ':memory:') {
    mkdirSync(dirname(config.databasePath), { recursive: true });
  }

  const db = new DatabaseSync(config.databasePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  runMigrations(db);

  dbInstance = db;
  log.info(`opened database at ${config.databasePath}`);
  return db;
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL);`);
  const row = db.prepare('SELECT MAX(version) AS v FROM _schema_version').get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;

  for (let i = current; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i]!;
    log.info(`applying migration v${i + 1}`);
    db.exec(sql);
    db.prepare('INSERT INTO _schema_version (version) VALUES (?)').run(i + 1);
  }
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

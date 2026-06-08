import { getDb } from './db.js';
import type {
  Contract,
  Market,
  MarketTradeGood,
  Ship,
  Shipyard,
  Waypoint,
} from '../types/index.js';

/* Upsert helpers translating API models into persisted rows. */

export function upsertWaypoint(wp: Waypoint): void {
  const db = getDb();
  const traits = wp.traits?.map((t) => t.symbol) ?? [];
  const charted = traits.includes('UNCHARTED') ? 0 : 1;
  db.prepare(
    `INSERT INTO waypoints (symbol, system, type, x, y, traits, is_under_construction, charted, raw, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(symbol) DO UPDATE SET
       system=excluded.system, type=excluded.type, x=excluded.x, y=excluded.y,
       traits=excluded.traits, is_under_construction=excluded.is_under_construction,
       charted=excluded.charted, raw=excluded.raw, updated_at=datetime('now')`,
  ).run(
    wp.symbol,
    wp.systemSymbol,
    wp.type,
    wp.x,
    wp.y,
    JSON.stringify(traits),
    wp.isUnderConstruction ? 1 : 0,
    charted,
    JSON.stringify(wp),
  );
}

export function upsertMarket(system: string, market: Market): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO markets (symbol, system, imports, exports, exchange, raw, last_scanned)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(symbol) DO UPDATE SET
       imports=excluded.imports, exports=excluded.exports, exchange=excluded.exchange,
       raw=excluded.raw, last_scanned=datetime('now')`,
  ).run(
    market.symbol,
    system,
    JSON.stringify(market.imports.map((i) => i.symbol)),
    JSON.stringify(market.exports.map((e) => e.symbol)),
    JSON.stringify(market.exchange.map((e) => e.symbol)),
    JSON.stringify(market),
  );

  // Persist price observations when the market is being read by a present ship.
  if (market.tradeGoods?.length) {
    recordPrices(system, market.symbol, market.tradeGoods);
  }
}

export function recordPrices(
  system: string,
  waypoint: string,
  goods: MarketTradeGood[],
): void {
  const db = getDb();
  const now = new Date().toISOString();
  const insHist = db.prepare(
    `INSERT INTO market_prices
       (waypoint, system, trade_symbol, type, trade_volume, supply, activity, purchase_price, sell_price, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upLatest = db.prepare(
    `INSERT INTO market_latest
       (waypoint, system, trade_symbol, type, trade_volume, supply, activity, purchase_price, sell_price, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(waypoint, trade_symbol) DO UPDATE SET
       type=excluded.type, trade_volume=excluded.trade_volume, supply=excluded.supply,
       activity=excluded.activity, purchase_price=excluded.purchase_price,
       sell_price=excluded.sell_price, observed_at=excluded.observed_at`,
  );
  const tx = db.prepare('BEGIN');
  tx.run();
  try {
    for (const g of goods) {
      insHist.run(
        waypoint,
        system,
        g.symbol,
        g.type,
        g.tradeVolume,
        g.supply,
        g.activity ?? null,
        g.purchasePrice,
        g.sellPrice,
        now,
      );
      upLatest.run(
        waypoint,
        system,
        g.symbol,
        g.type,
        g.tradeVolume,
        g.supply,
        g.activity ?? null,
        g.purchasePrice,
        g.sellPrice,
        now,
      );
    }
    db.prepare('COMMIT').run();
  } catch (e) {
    db.prepare('ROLLBACK').run();
    throw e;
  }
}

export function upsertShipyard(system: string, yard: Shipyard): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO shipyards (symbol, system, ship_types, ships, raw, last_scanned)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(symbol) DO UPDATE SET
       ship_types=excluded.ship_types, ships=excluded.ships, raw=excluded.raw,
       last_scanned=datetime('now')`,
  ).run(
    yard.symbol,
    system,
    JSON.stringify(yard.shipTypes.map((t) => t.type)),
    yard.ships ? JSON.stringify(yard.ships) : null,
    JSON.stringify(yard),
  );
}

export function upsertShip(ship: Ship, role?: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO ships
       (symbol, role, registration_role, frame, nav_status, nav_system, nav_waypoint, flight_mode,
        fuel_current, fuel_capacity, cargo_units, cargo_capacity, cooldown_until, arrival_at, raw, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(symbol) DO UPDATE SET
       role=COALESCE(excluded.role, ships.role),
       registration_role=excluded.registration_role, frame=excluded.frame,
       nav_status=excluded.nav_status, nav_system=excluded.nav_system, nav_waypoint=excluded.nav_waypoint,
       flight_mode=excluded.flight_mode, fuel_current=excluded.fuel_current, fuel_capacity=excluded.fuel_capacity,
       cargo_units=excluded.cargo_units, cargo_capacity=excluded.cargo_capacity,
       cooldown_until=excluded.cooldown_until, arrival_at=excluded.arrival_at,
       raw=excluded.raw, updated_at=datetime('now')`,
  ).run(
    ship.symbol,
    role ?? null,
    ship.registration.role,
    ship.frame.symbol,
    ship.nav.status,
    ship.nav.systemSymbol,
    ship.nav.waypointSymbol,
    ship.nav.flightMode,
    ship.fuel.current,
    ship.fuel.capacity,
    ship.cargo.units,
    ship.cargo.capacity,
    ship.cooldown.expiration ?? null,
    ship.nav.route?.arrival ?? null,
    JSON.stringify(ship),
  );
}

export function setShipRole(symbol: string, role: string): void {
  getDb().prepare('UPDATE ships SET role = ? WHERE symbol = ?').run(role, symbol);
}

export function setShipTask(symbol: string, task: unknown): void {
  getDb()
    .prepare('UPDATE ships SET task = ? WHERE symbol = ?')
    .run(task == null ? null : JSON.stringify(task), symbol);
}

export function upsertContract(c: Contract): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO contracts (id, faction, type, accepted, fulfilled, deadline, terms, raw, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       faction=excluded.faction, type=excluded.type, accepted=excluded.accepted,
       fulfilled=excluded.fulfilled, deadline=excluded.deadline, terms=excluded.terms,
       raw=excluded.raw, updated_at=datetime('now')`,
  ).run(
    c.id,
    c.factionSymbol,
    c.type,
    c.accepted ? 1 : 0,
    c.fulfilled ? 1 : 0,
    c.terms.deadline,
    JSON.stringify(c.terms),
    JSON.stringify(c),
  );
}

export interface TxnRecord {
  ship?: string;
  kind: string;
  waypoint?: string;
  tradeSymbol?: string;
  units?: number;
  pricePer?: number;
  total?: number;
  creditsAfter?: number;
}

export function recordTransaction(t: TxnRecord): void {
  getDb()
    .prepare(
      `INSERT INTO transactions (ship, kind, waypoint, trade_symbol, units, price_per, total, credits_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.ship ?? null,
      t.kind,
      t.waypoint ?? null,
      t.tradeSymbol ?? null,
      t.units ?? null,
      t.pricePer ?? null,
      t.total ?? null,
      t.creditsAfter ?? null,
    );
}

// ---------- Query helpers ----------

export interface WaypointRow {
  symbol: string;
  system: string;
  type: string;
  x: number;
  y: number;
  traits: string[];
}

function parseWaypointRow(r: {
  symbol: string;
  system: string;
  type: string;
  x: number;
  y: number;
  traits: string;
}): WaypointRow {
  return { ...r, traits: JSON.parse(r.traits) as string[] };
}

export function findWaypointsByTrait(system: string, trait: string): WaypointRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT symbol, system, type, x, y, traits FROM waypoints
       WHERE system = ? AND traits LIKE ?`,
    )
    .all(system, `%"${trait}"%`) as {
    symbol: string;
    system: string;
    type: string;
    x: number;
    y: number;
    traits: string;
  }[];
  return rows.map(parseWaypointRow);
}

export function findWaypointsByType(system: string, type: string): WaypointRow[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT symbol, system, type, x, y, traits FROM waypoints WHERE system = ? AND type = ?')
    .all(system, type) as {
    symbol: string;
    system: string;
    type: string;
    x: number;
    y: number;
    traits: string;
  }[];
  return rows.map(parseWaypointRow);
}

export function getWaypointRow(symbol: string): WaypointRow | undefined {
  const db = getDb();
  const r = db
    .prepare('SELECT symbol, system, type, x, y, traits FROM waypoints WHERE symbol = ?')
    .get(symbol) as
    | { symbol: string; system: string; type: string; x: number; y: number; traits: string }
    | undefined;
  return r ? parseWaypointRow(r) : undefined;
}

/** Waypoints with a market that sells FUEL (exports or exchange). For routing. */
export function findFuelWaypoints(system: string): WaypointRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT w.symbol, w.system, w.type, w.x, w.y, w.traits
       FROM markets m JOIN waypoints w ON w.symbol = m.symbol
       WHERE m.system = ? AND (m.exports LIKE ? OR m.exchange LIKE ?)`,
    )
    .all(system, '%"FUEL"%', '%"FUEL"%') as {
    symbol: string;
    system: string;
    type: string;
    x: number;
    y: number;
    traits: string;
  }[];
  return rows.map(parseWaypointRow);
}

// ---------- Market trade-graph queries ----------

/** Markets in a system that EXPORT a good (cheap source to buy from). */
export function findExporters(system: string, good: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT symbol FROM markets WHERE system = ? AND exports LIKE ?`)
    .all(system, `%"${good}"%`) as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

/** Markets in a system that IMPORT a good (demand sink to sell to). */
export function findImporters(system: string, good: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT symbol FROM markets WHERE system = ? AND imports LIKE ?`)
    .all(system, `%"${good}"%`) as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

/** Markets that buy a good (imports OR exchange) — where we can sell it. */
export function findBuyers(system: string, good: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT symbol FROM markets WHERE system = ? AND (imports LIKE ? OR exchange LIKE ?)`,
    )
    .all(system, `%"${good}"%`, `%"${good}"%`) as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

export interface PriceRow {
  waypoint: string;
  system: string;
  trade_symbol: string;
  type: string | null;
  trade_volume: number | null;
  supply: string | null;
  activity: string | null;
  purchase_price: number | null;
  sell_price: number | null;
  observed_at: string;
}

/** Latest known price for a good at a specific waypoint. */
export function getLatestPrice(waypoint: string, good: string): PriceRow | undefined {
  return getDb()
    .prepare('SELECT * FROM market_latest WHERE waypoint = ? AND trade_symbol = ?')
    .get(waypoint, good) as PriceRow | undefined;
}

/** All latest price rows for a good across the system. */
export function getLatestPricesForGood(system: string, good: string): PriceRow[] {
  return getDb()
    .prepare('SELECT * FROM market_latest WHERE system = ? AND trade_symbol = ?')
    .all(system, good) as unknown as PriceRow[];
}

export interface MarketStructureRow {
  symbol: string;
  system: string;
  imports: string[];
  exports: string[];
  exchange: string[];
}

export function getMarketStructure(symbol: string): MarketStructureRow | undefined {
  const r = getDb()
    .prepare('SELECT symbol, system, imports, exports, exchange FROM markets WHERE symbol = ?')
    .get(symbol) as
    | { symbol: string; system: string; imports: string; exports: string; exchange: string }
    | undefined;
  if (!r) return undefined;
  return {
    symbol: r.symbol,
    system: r.system,
    imports: JSON.parse(r.imports) as string[],
    exports: JSON.parse(r.exports) as string[],
    exchange: JSON.parse(r.exchange) as string[],
  };
}

export interface ArbitrageRoute {
  good: string;
  buyAt: string;
  buyPrice: number;
  sellAt: string;
  sellPrice: number;
  profitPerUnit: number;
  tradeVolume: number | null;
}

/**
 * Best buy-low / sell-high route in a system from cached latest prices: buy a
 * good where its purchase price is low and sell where its sell price is high,
 * across two different waypoints. Only considers spreads >= `minProfit`.
 */
export function findBestArbitrage(system: string, minProfit = 1): ArbitrageRoute | undefined {
  const r = getDb()
    .prepare(
      `SELECT b.trade_symbol AS good, b.waypoint AS buyAt, b.purchase_price AS buyPrice,
              s.waypoint AS sellAt, s.sell_price AS sellPrice,
              (s.sell_price - b.purchase_price) AS profitPerUnit, b.trade_volume AS tradeVolume
       FROM market_latest b
       JOIN market_latest s
         ON s.trade_symbol = b.trade_symbol AND s.system = b.system AND s.waypoint <> b.waypoint
       WHERE b.system = ? AND b.purchase_price > 0 AND s.sell_price > 0
         AND (s.sell_price - b.purchase_price) >= ?
       ORDER BY profitPerUnit DESC
       LIMIT 1`,
    )
    .get(system, minProfit) as ArbitrageRoute | undefined;
  return r;
}

/** Marketplace waypoints in a system that have NO captured prices yet. */
export function findUnpricedMarkets(system: string): WaypointRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT w.symbol, w.system, w.type, w.x, w.y, w.traits
       FROM waypoints w
       WHERE w.system = ? AND w.traits LIKE '%"MARKETPLACE"%'
         AND w.symbol NOT IN (SELECT DISTINCT waypoint FROM market_latest WHERE system = ?)`,
    )
    .all(system, system) as {
    symbol: string;
    system: string;
    type: string;
    x: number;
    y: number;
    traits: string;
  }[];
  return rows.map(parseWaypointRow);
}

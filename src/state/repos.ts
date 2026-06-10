import { getDb } from './db.js';
import { setWallet } from './wallet.js';
import type {
  Contract,
  JumpGate,
  Market,
  MarketTradeGood,
  Ship,
  Shipyard,
  System,
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

export interface ShipyardSeller {
  symbol: string;
  x: number;
  y: number;
}

/**
 * Shipyards in `system` known (from a prior scan) to sell `shipType`, with their
 * waypoint coordinates so a caller can pick the nearest. Reads cached
 * `ship_types` — which a shipyard scan records even without a ship present — so
 * we can route straight to a yard that stocks e.g. SHIP_PROBE instead of
 * ferrying to the nearest yard that may not sell it at all.
 */
export function findShipyardsSellingShipType(system: string, shipType: string): ShipyardSeller[] {
  return getDb()
    .prepare(
      `SELECT y.symbol AS symbol, w.x AS x, w.y AS y
       FROM shipyards y
       JOIN waypoints w ON w.symbol = y.symbol
       WHERE y.system = ? AND y.ship_types LIKE ?`,
    )
    .all(system, `%"${shipType}"%`) as unknown as ShipyardSeller[];
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
  // Keep the live-wallet mirror current so the per-trade spend cap can size
  // against the real balance instead of a stale round-start snapshot.
  setWallet(t.creditsAfter);
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

/**
 * Whether a waypoint is flagged as under construction in the local DB.
 * Unknown waypoints (not yet hydrated) are treated as NOT under construction.
 */
export function isWaypointUnderConstruction(symbol: string): boolean {
  const r = getDb()
    .prepare('SELECT is_under_construction FROM waypoints WHERE symbol = ?')
    .get(symbol) as { is_under_construction: number } | undefined;
  return r ? r.is_under_construction === 1 : false;
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
  /** Buy market's per-fill trade volume (one purchase "step"). */
  tradeVolume: number | null;
  /**
   * Sell market's per-fill trade volume — how much the destination can absorb
   * per price "step". Used to size buys so a full hold isn't dumped into a thin
   * market below the profit floor.
   */
  sellVolume: number | null;
}

/**
 * Goods the arbitrage trader must NEVER route. These are jump-gate construction
 * inputs: they are only ever moved via `supplyConstruction` (see supplyGate.ts),
 * never bought/sold on the open market by traders. When we drain their EXPORT
 * markets to supply the gate, the export price spikes wildly and an unrelated
 * IMPORT row makes the route finder believe there's a huge spread (e.g. buy ADV
 * at an importer, "sell" into the spiked EXPORT). EXPORT markets refuse to buy
 * the good back, so the trip earns 0 and burns the whole purchase — this drained
 * ~1.1M before it was caught. Excluding them at the source kills the phantom.
 */
export const NON_ARBITRAGE_GOODS: readonly string[] = [
  'ADVANCED_CIRCUITRY',
  'FAB_MATS',
  'QUANTUM_STABILIZERS',
];

/** Positional `?` placeholders for {@link NON_ARBITRAGE_GOODS} in a `NOT IN`. */
const NON_ARBITRAGE_PLACEHOLDERS = NON_ARBITRAGE_GOODS.map(() => '?').join(', ');

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
              (s.sell_price - b.purchase_price) AS profitPerUnit, b.trade_volume AS tradeVolume,
              s.trade_volume AS sellVolume
       FROM market_latest b
       JOIN market_latest s
         ON s.trade_symbol = b.trade_symbol AND s.system = b.system AND s.waypoint <> b.waypoint
       WHERE b.system = ? AND b.purchase_price > 0 AND s.sell_price > 0
         AND (s.sell_price - b.purchase_price) >= ?
         AND b.trade_symbol NOT IN (${NON_ARBITRAGE_PLACEHOLDERS})
       ORDER BY (s.sell_price - b.purchase_price) *
                MIN(COALESCE(b.trade_volume, 1000000), COALESCE(s.trade_volume, 1000000)) DESC
       LIMIT 1`,
    )
    .get(system, minProfit, ...NON_ARBITRAGE_GOODS) as ArbitrageRoute | undefined;
  return r;
}

/**
 * Top buy-low / sell-high routes in a system, ranked by per-unit spread. Unlike
 * {@link findBestArbitrage} this returns up to `limit` candidates (a good/route
 * may appear more than once via different waypoint pairs) so callers can hand
 * distinct, non-overlapping routes to concurrent traders.
 */
export function findArbitrageRoutes(
  system: string,
  minProfit = 1,
  limit = 20,
): ArbitrageRoute[] {
  return getDb()
    .prepare(
      `SELECT b.trade_symbol AS good, b.waypoint AS buyAt, b.purchase_price AS buyPrice,
              s.waypoint AS sellAt, s.sell_price AS sellPrice,
              (s.sell_price - b.purchase_price) AS profitPerUnit, b.trade_volume AS tradeVolume,
              s.trade_volume AS sellVolume
       FROM market_latest b
       JOIN market_latest s
         ON s.trade_symbol = b.trade_symbol AND s.system = b.system AND s.waypoint <> b.waypoint
       WHERE b.system = ? AND b.purchase_price > 0 AND s.sell_price > 0
         AND (s.sell_price - b.purchase_price) >= ?
         AND b.trade_symbol NOT IN (${NON_ARBITRAGE_PLACEHOLDERS})
       ORDER BY (s.sell_price - b.purchase_price) *
                MIN(COALESCE(b.trade_volume, 1000000), COALESCE(s.trade_volume, 1000000)) DESC
       LIMIT ?`,
    )
    .all(system, minProfit, ...NON_ARBITRAGE_GOODS, limit) as unknown as ArbitrageRoute[];
}

/**
 * Buy-low / sell-high candidates where the buy and sell waypoints live in
 * DIFFERENT systems. Mirrors {@link findArbitrageRoutes} but drops the
 * same-system constraint and carries the buy/sell system symbols so a caller
 * can rank by net profit after jump costs (see `rankCrossRoutes`). Reachability
 * is NOT considered here — only hydrated prices — so the caller must filter by
 * jump topology. Ranked by raw per-unit spread.
 */
export function findCrossSystemArbitrageRoutes(
  minProfit = 1,
  limit = 50,
): (ArbitrageRoute & { buySystem: string; sellSystem: string })[] {
  return getDb()
    .prepare(
      `SELECT b.trade_symbol AS good, b.waypoint AS buyAt, b.purchase_price AS buyPrice,
              s.waypoint AS sellAt, s.sell_price AS sellPrice,
              (s.sell_price - b.purchase_price) AS profitPerUnit, b.trade_volume AS tradeVolume,
              s.trade_volume AS sellVolume,
              b.system AS buySystem, s.system AS sellSystem
       FROM market_latest b
       JOIN market_latest s
         ON s.trade_symbol = b.trade_symbol AND s.system <> b.system
       WHERE b.purchase_price > 0 AND s.sell_price > 0
         AND (s.sell_price - b.purchase_price) >= ?
         AND b.trade_symbol NOT IN (${NON_ARBITRAGE_PLACEHOLDERS})
       ORDER BY (s.sell_price - b.purchase_price) *
                MIN(COALESCE(b.trade_volume, 1000000), COALESCE(s.trade_volume, 1000000)) DESC
       LIMIT ?`,
    )
    .all(minProfit, ...NON_ARBITRAGE_GOODS, limit) as unknown as (ArbitrageRoute & {
    buySystem: string;
    sellSystem: string;
  })[];
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

// ---------- Systems / Jump gates (cross-system travel) ----------

export interface SystemRow {
  symbol: string;
  sector: string | null;
  type: string | null;
  x: number;
  y: number;
}

export function upsertSystem(sys: System): void {
  getDb()
    .prepare(
      `INSERT INTO systems (symbol, sector, type, x, y, raw, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(symbol) DO UPDATE SET
         sector=excluded.sector, type=excluded.type, x=excluded.x, y=excluded.y,
         raw=excluded.raw, updated_at=datetime('now')`,
    )
    .run(sys.symbol, sys.sectorSymbol, sys.type, sys.x, sys.y, JSON.stringify(sys));
}

export function getSystemRow(symbol: string): SystemRow | undefined {
  return getDb()
    .prepare('SELECT symbol, sector, type, x, y FROM systems WHERE symbol = ?')
    .get(symbol) as SystemRow | undefined;
}

export interface JumpGateRow {
  symbol: string;
  system: string;
  connections: string[];
}

function parseJumpGateRow(r: {
  symbol: string;
  system: string;
  connections: string;
}): JumpGateRow {
  return { ...r, connections: JSON.parse(r.connections) as string[] };
}

export function upsertJumpGate(system: string, gate: JumpGate): void {
  getDb()
    .prepare(
      `INSERT INTO jump_gates (symbol, system, connections, last_scanned)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(symbol) DO UPDATE SET
         system=excluded.system, connections=excluded.connections, last_scanned=datetime('now')`,
    )
    .run(gate.symbol, system, JSON.stringify(gate.connections ?? []));
}

/** A specific jump gate waypoint's connections, if known. */
export function getJumpGateRow(symbol: string): JumpGateRow | undefined {
  const r = getDb()
    .prepare('SELECT symbol, system, connections FROM jump_gates WHERE symbol = ?')
    .get(symbol) as { symbol: string; system: string; connections: string } | undefined;
  return r ? parseJumpGateRow(r) : undefined;
}

/** The jump gate(s) recorded for a system (usually one). */
export function findJumpGatesBySystem(system: string): JumpGateRow[] {
  const rows = getDb()
    .prepare('SELECT symbol, system, connections FROM jump_gates WHERE system = ?')
    .all(system) as { symbol: string; system: string; connections: string }[];
  return rows.map(parseJumpGateRow);
}

import type { SpaceTradersApi } from '../client/api.js';
import { createLogger } from '../util/logger.js';
import { kvGet, kvSet } from './kv.js';
import {
  findJumpGatesBySystem,
  findWaypointsByType,
  upsertContract,
  upsertJumpGate,
  upsertMarket,
  upsertShip,
  upsertShipyard,
  upsertSystem,
  upsertWaypoint,
} from './repos.js';

const log = createLogger('world');

/**
 * Pull all owned ships into the DB. Returns them. Delegates to the resilient
 * `listAllShips()` so a single server-corrupted ship (which makes the API 500
 * on a bulk page) can't brick the whole fleet boot — that ship is skipped and
 * picked up automatically once the server recovers it.
 */
export async function hydrateShips(api: SpaceTradersApi) {
  const all = await api.listAllShips();
  for (const s of all) upsertShip(s);
  log.info(`hydrated ${all.length} ships`);
  return all;
}

/** Pull all contracts into the DB. */
export async function hydrateContracts(api: SpaceTradersApi) {
  const all = [];
  let page = 1;
  for (;;) {
    const res = await api.listContracts({ page, limit: 20 });
    for (const c of res.data) {
      upsertContract(c);
      all.push(c);
    }
    if (res.data.length < res.meta.limit || all.length >= res.meta.total) break;
    page++;
  }
  log.info(`hydrated ${all.length} contracts`);
  return all;
}

/**
 * Pull every waypoint in a system into the DB (paginated).
 * Caches a "scanned" flag so repeat runs can skip unless forced.
 */
export async function hydrateSystemWaypoints(
  api: SpaceTradersApi,
  system: string,
  force = false,
) {
  const cacheKey = `system_scanned:${system}`;
  if (!force && kvGet<boolean>(cacheKey)) {
    log.info(`system ${system} already scanned (cached)`);
    return;
  }
  const all = [];
  let page = 1;
  for (;;) {
    const res = await api.getSystemWaypoints(system, { page, limit: 20 });
    for (const wp of res.data) {
      upsertWaypoint(wp);
      all.push(wp);
    }
    if (res.data.length < res.meta.limit || all.length >= res.meta.total) break;
    page++;
  }
  kvSet(cacheKey, true);
  log.info(`hydrated ${all.length} waypoints in ${system}`);
  return all;
}

/**
 * Read & persist market data for a waypoint (records price history when the
 * caller's ship is present, which the API requires for tradeGoods).
 */
export async function scanMarket(api: SpaceTradersApi, system: string, waypoint: string) {
  const market = await api.getMarket(system, waypoint);
  upsertMarket(system, market);
  return market;
}

/**
 * Scan the public import/export/exchange structure of every marketplace in a
 * system (no ship presence required — prices are NOT captured here). Populates
 * the trade graph so route-finding can run before any ship visits.
 */
export async function hydrateMarketStructures(
  api: SpaceTradersApi,
  system: string,
  force = false,
) {
  const cacheKey = `market_structures:${system}`;
  if (!force && kvGet<boolean>(cacheKey)) {
    log.info(`market structures for ${system} already scanned (cached)`);
    return;
  }
  const { findWaypointsByTrait } = await import('./repos.js');
  const markets = findWaypointsByTrait(system, 'MARKETPLACE');
  let count = 0;
  for (const m of markets) {
    try {
      const market = await api.getMarket(system, m.symbol);
      upsertMarket(system, market);
      count++;
    } catch (err) {
      log.debug(`market structure scan failed for ${m.symbol}: ${(err as Error).message}`);
    }
  }
  kvSet(cacheKey, true);
  log.info(`scanned ${count} market structures in ${system}`);
}

/** Read & persist shipyard data for a waypoint. */
export async function scanShipyard(api: SpaceTradersApi, system: string, waypoint: string) {
  const yard = await api.getShipyard(system, waypoint);
  upsertShipyard(system, yard);
  return yard;
}

export function systemOf(waypoint: string): string {
  // Waypoint symbols look like X1-A20-A1 -> system is X1-A20.
  const parts = waypoint.split('-');
  return parts.slice(0, 2).join('-');
}

/** Read & persist a system's summary record (symbol, coords, type, sector). */
export async function hydrateSystem(api: SpaceTradersApi, system: string) {
  const sys = await api.getSystem(system);
  upsertSystem(sys);
  return sys;
}

/**
 * Discover and persist the jump-gate topology for a system: find its JUMP_GATE
 * waypoint(s) and record the gate waypoints each one connects to (the seeds for
 * cross-system routing). Cached so repeat rounds skip unless forced.
 */
export async function hydrateJumpGates(
  api: SpaceTradersApi,
  system: string,
  force = false,
) {
  const cacheKey = `jump_gates_scanned:${system}`;
  if (!force && kvGet<boolean>(cacheKey)) {
    log.info(`jump gates for ${system} already scanned (cached)`);
    return findJumpGatesBySystem(system);
  }
  const gates = findWaypointsByType(system, 'JUMP_GATE');
  for (const g of gates) {
    try {
      const jg = await api.getJumpGate(system, g.symbol);
      upsertJumpGate(system, jg);
      log.info(`jump gate ${g.symbol} -> [${(jg.connections ?? []).join(', ')}]`);
    } catch (err) {
      log.debug(`jump gate scan failed for ${g.symbol}: ${(err as Error).message}`);
    }
  }
  kvSet(cacheKey, true);
  return findJumpGatesBySystem(system);
}

import type { SpaceTradersApi } from '../client/api.js';
import { findUnpricedMarkets, findWaypointsByTrait, getWaypointRow, type WaypointRow } from '../state/repos.js';
import { scanMarket } from '../state/world.js';
import { distance, travelTo } from '../util/nav.js';
import { createLogger } from '../util/logger.js';
import type { Ship } from '../types/index.js';

const log = createLogger('scanner');

export interface ScannerOptions {
  /** Max markets to scan before stopping. */
  limit?: number;
  /** Re-scan already-priced markets too (refresh), not just unpriced ones. */
  refreshAll?: boolean;
}

/**
 * Drive a (typically fuel-free) probe around the system's marketplaces, reading
 * live prices into the DB so traders can find arbitrage. Visits nearest-first,
 * preferring markets with no captured prices yet. Returns how many it scanned.
 */
export async function runScanner(
  api: SpaceTradersApi,
  ship: Ship,
  system: string,
  opts: ScannerOptions = {},
): Promise<number> {
  const limit = opts.limit ?? 30;
  let scanned = 0;

  // Scan where we're standing first.
  try {
    await scanMarket(api, system, ship.nav.waypointSymbol);
    scanned++;
  } catch {
    /* not a market here */
  }

  while (scanned < limit) {
    const pool: WaypointRow[] = opts.refreshAll
      ? findWaypointsByTrait(system, 'MARKETPLACE')
      : findUnpricedMarkets(system);
    const remaining = pool.filter((w) => w.symbol !== ship.nav.waypointSymbol);
    if (remaining.length === 0) break;

    const here = getWaypointRow(ship.nav.waypointSymbol);
    const next = here
      ? remaining.sort((a, b) => distance(here, a) - distance(here, b))[0]!
      : remaining[0]!;

    ship = await travelTo(api, ship, next.symbol);
    try {
      await scanMarket(api, system, next.symbol);
      scanned++;
      log.info(`${ship.symbol} scanned ${next.symbol} (${scanned})`);
    } catch (err) {
      log.debug(`${ship.symbol} scan ${next.symbol} failed: ${(err as Error).message}`);
    }
  }

  log.info(`${ship.symbol} scanner done: ${scanned} market(s)`);
  return scanned;
}

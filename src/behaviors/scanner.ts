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
  /** Stop scanning once this many ms have elapsed (time budget). */
  budgetMs?: number;
  /** External stop signal, checked each iteration (e.g. earners finished). */
  shouldStop?: () => boolean;
  /** Skip candidate markets farther than this from the probe's position. */
  maxHopDistance?: number;
}

/**
 * Drive a (typically fuel-free) probe around the system's marketplaces, reading
 * live prices into the DB so traders can find arbitrage. Visits nearest-first,
 * preferring markets with no captured prices yet and falling back to refreshing
 * the nearest already-priced markets so the price map near the trading cluster
 * stays current. Stops at the soonest of: the scan `limit`, the `budgetMs` time
 * budget, exhausting candidates, or `shouldStop()` returning true. The time
 * budget keeps the probe from ever becoming the long pole that gates a round.
 * Returns how many it scanned.
 */
export async function runScanner(
  api: SpaceTradersApi,
  ship: Ship,
  system: string,
  opts: ScannerOptions = {},
): Promise<number> {
  const limit = opts.limit ?? 30;
  const deadline = opts.budgetMs && opts.budgetMs > 0 ? Date.now() + opts.budgetMs : Infinity;
  const stop = () => (opts.shouldStop?.() ?? false) || Date.now() >= deadline;
  let scanned = 0;
  const recent: string[] = [];

  // Scan where we're standing first — but only if we're actually there, not
  // mid-transit (an in-transit ship's waypointSymbol is its destination).
  if (ship.nav.status !== 'IN_TRANSIT' && !stop()) {
    try {
      await scanMarket(api, system, ship.nav.waypointSymbol);
      scanned++;
    } catch {
      /* not a market here */
    }
  }

  while (scanned < limit && !stop()) {
    // Prefer unpriced markets; fall back to refreshing all marketplaces so the
    // probe keeps nearby prices fresh instead of chasing distant unpriced ones.
    let pool: WaypointRow[] = opts.refreshAll ? findWaypointsByTrait(system, 'MARKETPLACE') : findUnpricedMarkets(system);
    if (pool.length === 0) pool = findWaypointsByTrait(system, 'MARKETPLACE');

    const here = getWaypointRow(ship.nav.waypointSymbol);
    let remaining = pool.filter(
      (w) => w.symbol !== ship.nav.waypointSymbol && !recent.includes(w.symbol),
    );
    // Avoid long detours when a hop cap is set.
    if (here && opts.maxHopDistance != null) {
      const near = remaining.filter((w) => distance(here, w) <= opts.maxHopDistance!);
      if (near.length > 0) remaining = near;
    }
    if (remaining.length === 0) break;

    const next = here
      ? remaining.sort((a, b) => distance(here, a) - distance(here, b))[0]!
      : remaining[0]!;

    if (stop()) break;
    ship = await travelTo(api, ship, next.symbol);
    try {
      await scanMarket(api, system, next.symbol);
      scanned++;
      log.info(`${ship.symbol} scanned ${next.symbol} (${scanned})`);
    } catch (err) {
      log.debug(`${ship.symbol} scan ${next.symbol} failed: ${(err as Error).message}`);
    }
    // Remember the last few stops so the refresh fallback rotates instead of
    // ping-ponging between the two closest markets.
    recent.push(next.symbol);
    if (recent.length > 3) recent.shift();
  }

  log.info(`${ship.symbol} scanner done: ${scanned} market(s)`);
  return scanned;
}

/*
 * Mining role: extract ore at an asteroid until the hold is full, then haul it
 * to the best-paying buyer(s) in the system and sell. Built on the existing
 * `mine` extraction loop and `sellCargoHere`, with a few small pure helpers
 * (canMine / pickMiningSite / bestBuyer) that are unit-tested in isolation.
 *
 * Opt-in: the orchestrator only assigns miners when MINERS >= 1, so default
 * fleet behavior is unchanged. Stage A targets the single mining-capable
 * frigate; dedicated miners arrive once cross-system shipyards are reachable.
 */
import type { SpaceTradersApi } from '../client/api.js';
import { findWaypointsByType, getLatestPricesForGood } from '../state/repos.js';
import { navigateTo } from '../util/nav.js';
import { mine } from './miner.js';
import { sellCargoHere } from './trade.js';
import type { Ship } from '../types/index.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('miner-trader');

/** True when a ship carries an extraction mount (mining laser / extractor). */
export function canMine(ship: Ship): boolean {
  return ship.mounts.some((m) => {
    const s = m.symbol.toUpperCase();
    return s.includes('MINING_LASER') || s.includes('EXTRACTOR');
  });
}

export interface MiningSite {
  symbol: string;
  type: string;
}

/**
 * Choose where to mine: prefer an engineered asteroid (richest yields), then a
 * plain asteroid, then anything supplied. Returns undefined for an empty list.
 */
export function pickMiningSite(sites: MiningSite[]): string | undefined {
  return (
    sites.find((s) => s.type === 'ENGINEERED_ASTEROID')?.symbol ??
    sites.find((s) => s.type === 'ASTEROID')?.symbol ??
    sites[0]?.symbol
  );
}

export interface SellQuote {
  waypoint: string;
  sellPrice: number | null;
}

/**
 * Pick the waypoint paying the highest sell price for a good. Ignores quotes
 * with a missing or non-positive price. Stable: on ties the earlier quote wins.
 */
export function bestBuyer(quotes: SellQuote[]): string | undefined {
  let best: SellQuote | undefined;
  for (const q of quotes) {
    if (q.sellPrice == null || q.sellPrice <= 0) continue;
    if (!best || q.sellPrice > best.sellPrice!) best = q;
  }
  return best?.waypoint;
}

export interface MinerOptions {
  /** Max extraction cycles before hauling to market (safety bound). */
  maxCycles?: number;
  /** Max haul-and-sell trips after a fill (safety bound). default 4. */
  maxSellTrips?: number;
}

export interface MinerResult {
  /** Units sold to markets. */
  sold: number;
  /** Credits earned from selling mined ore. */
  earned: number;
}

/** The most-stocked good currently in the hold (drives which buyer to target). */
function largestCargoGood(ship: Ship): string | undefined {
  let best: { symbol: string; units: number } | undefined;
  for (const it of ship.cargo.inventory) {
    if (it.units <= 0) continue;
    if (!best || it.units > best.units) best = it;
  }
  return best?.symbol;
}

/**
 * Run one mining job: travel to the best asteroid, fill the hold, then sell the
 * ore at the highest-paying markets in the system. Returns units sold and the
 * credits earned. A no-op (returns zeros) for ships that cannot mine.
 */
export async function runMiner(
  api: SpaceTradersApi,
  ship: Ship,
  system: string,
  opts: MinerOptions = {},
): Promise<MinerResult> {
  if (!canMine(ship)) {
    log.warn(`${ship.symbol} has no mining mount; skipping`);
    return { sold: 0, earned: 0 };
  }

  const maxSellTrips = opts.maxSellTrips ?? 4;

  // 1. Pick an asteroid and go there.
  const sites: MiningSite[] = [
    ...findWaypointsByType(system, 'ENGINEERED_ASTEROID'),
    ...findWaypointsByType(system, 'ASTEROID'),
  ].map((w) => ({ symbol: w.symbol, type: w.type }));
  const site = pickMiningSite(sites);
  if (!site) {
    log.warn(`${ship.symbol} no asteroid in ${system}; skipping`);
    return { sold: 0, earned: 0 };
  }
  ship = await navigateTo(api, ship, site);

  // 2. Fill the hold (don't sell at the asteroid; haul to a real market).
  ship = await mine(api, ship, {
    sellHere: false,
    survey: true,
    maxCycles: opts.maxCycles,
  });

  // 3. Haul to the best buyer(s) and sell, good by good, until the hold is
  //    empty or no buyer exists for what remains.
  let earned = 0;
  let sold = 0;
  for (let trip = 0; trip < maxSellTrips; trip++) {
    const good = largestCargoGood(ship);
    if (!good) break;

    const quotes: SellQuote[] = getLatestPricesForGood(system, good).map((p) => ({
      waypoint: p.waypoint,
      sellPrice: p.sell_price,
    }));
    const dest = bestBuyer(quotes);
    if (!dest) {
      log.info(`${ship.symbol} no known buyer for ${good}; holding ${ship.cargo.units} unit(s)`);
      break;
    }

    const before = ship.cargo.units;
    ship = await navigateTo(api, ship, dest);
    const res = await sellCargoHere(api, ship);
    ship = res.ship;
    earned += res.earned;
    sold += before - ship.cargo.units;

    // Nothing moved (market wouldn't take it) -> avoid an infinite loop.
    if (ship.cargo.units >= before) break;
  }

  log.info(`${ship.symbol} miner done: sold ${sold} unit(s) for ${earned}`);
  return { sold, earned };
}

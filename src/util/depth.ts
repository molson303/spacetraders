/*
 * Pure helpers for depth-aware trade sizing.
 *
 * SpaceTraders markets have finite depth: every unit you buy nudges the
 * purchase price up, and every unit you sell nudges the sell price down. The
 * per-good `tradeVolume` is the size of one "step" on that curve. Dumping a
 * full hold into a single market craters the realized price and burns profit.
 *
 * These helpers are intentionally side-effect free so they can be unit tested
 * without a live API. The behaviors layer feeds them the *realized*
 * `pricePerUnit` returned by each buy/sell transaction and uses the decisions
 * here to stop trading a good before it stops being profitable.
 */

import type { PriceRow } from '../state/repos.js';

/**
 * Split `total` units into a sequence of chunk sizes no larger than
 * `tradeVolume`. A non-positive `tradeVolume` means "no limit" (one chunk).
 */
export function planChunks(total: number, tradeVolume: number | null | undefined): number[] {
  if (total <= 0) return [];
  const step = tradeVolume && tradeVolume > 0 ? tradeVolume : total;
  const chunks: number[] = [];
  let remaining = total;
  while (remaining > 0) {
    const units = Math.min(remaining, step);
    chunks.push(units);
    remaining -= units;
  }
  return chunks;
}

/**
 * Minimum acceptable realized sell price for a good: the average price we paid
 * to acquire it plus a required per-unit profit margin. Selling below this
 * loses money once you account for what the cargo cost.
 */
export function sellFloor(avgBuyCost: number, minMargin: number): number {
  return avgBuyCost + minMargin;
}

/**
 * Maximum acceptable realized purchase price for a good: the price we expect to
 * sell it for minus the required per-unit margin. Buying above this can't clear
 * a profit at the target sell market.
 */
export function buyCeiling(expectedSellPrice: number, minMargin: number): number {
  return expectedSellPrice - minMargin;
}

/**
 * Decide whether to keep selling a good. Stops once the most recent realized
 * chunk price falls below the floor — the market has been pushed too deep.
 */
export function keepSelling(lastRealizedPrice: number, floor: number): boolean {
  return lastRealizedPrice >= floor;
}

/**
 * Decide whether to keep buying a good. Stops once the most recent realized
 * chunk price rises above the ceiling — the market has been pushed too high.
 */
export function keepBuying(lastRealizedPrice: number, ceiling: number): boolean {
  return lastRealizedPrice <= ceiling;
}

export interface AltSellMarket {
  waypoint: string;
  sellPrice: number;
  tradeVolume: number | null;
}

/**
 * Pick the best alternate market to offload leftover cargo: the highest cached
 * sell price for `good`, excluding any waypoints already visited and any market
 * whose sell price is below `minPrice`. Returns undefined when none qualify.
 */
export function bestSellMarket(
  rows: PriceRow[],
  exclude: Iterable<string>,
  minPrice: number,
): AltSellMarket | undefined {
  const skip = new Set(exclude);
  let best: AltSellMarket | undefined;
  for (const r of rows) {
    if (skip.has(r.waypoint)) continue;
    const price = r.sell_price ?? 0;
    if (price < minPrice) continue;
    if (!best || price > best.sellPrice) {
      best = { waypoint: r.waypoint, sellPrice: price, tradeVolume: r.trade_volume };
    }
  }
  return best;
}

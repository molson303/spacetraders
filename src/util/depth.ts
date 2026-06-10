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
 * Default number of sell-market depth "steps" a single buy may span. Shared by
 * the trader (execution cap) and route ranking (so scoring matches behavior).
 *
 * Held at 1: a market's `sellVolume` is how many units it absorbs at the quoted
 * price; every step past the first pushes the realized sell price down a notch.
 * For high per-unit goods (JEWELRY, ASSAULT_RIFLES, FOOD) even the second step
 * can sink below the profit floor, stranding cargo at a loss — buying two or
 * three steps repeatedly drained the wallet (JEWELRY -75.8k, FOOD ~-46k) before
 * this was clamped. One step keeps each fill inside the depth the sink can clear
 * near full price; deeper goods (sellVolume >= hold) still fill the whole bay.
 */
export const DEFAULT_SELL_DEPTH_MULTIPLE = 1;

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

/**
 * Cap how many units to buy so the destination sell market can actually absorb
 * the hold near full price. The sell market's depth is one `sellVolume` "step";
 * pushing many steps deep craters the realized price below the profit floor and
 * strands cargo (the `-9` SHIP_PARTS trap: high per-unit good, thin sell depth,
 * full hold bought, only a fraction sold above floor).
 *
 * Buy at most `depthMultiple` sell-steps' worth, always bounded by `freeCargo`.
 * A non-positive `sellVolume` is treated as "unknown depth" → no extra cap
 * beyond the hold. `depthMultiple` is clamped to at least 1 so we never refuse
 * to buy a single step.
 */
export function depthCappedBuyUnits(
  freeCargo: number,
  sellVolume: number | null | undefined,
  depthMultiple: number,
): number {
  if (freeCargo <= 0) return 0;
  if (!sellVolume || sellVolume <= 0) return freeCargo;
  const steps = Math.max(1, depthMultiple);
  const cap = Math.max(1, Math.floor(sellVolume * steps));
  return Math.min(freeCargo, cap);
}

/**
 * Cap how many units to buy so a single buy->sell cycle can't commit more than
 * `maxSpend` credits at the expected per-unit purchase price. Bounds per-trade
 * capital at risk: without it, one trader (with REINVEST off) dumps the entire
 * wallet into a single position, which both starves sibling traders of capital
 * and turns one bad fill into a large realized loss.
 *
 * A non-positive `maxSpend` means "no budget cap". A non-positive/unknown
 * `estPricePerUnit` is treated as "unknown cost" → no cap. When the budget can't
 * afford even one unit the result is 0, signalling the caller to skip the route
 * rather than force an unaffordable buy.
 */
export function budgetCappedBuyUnits(
  units: number,
  estPricePerUnit: number | null | undefined,
  maxSpend: number | null | undefined,
): number {
  if (units <= 0) return 0;
  if (!maxSpend || maxSpend <= 0) return units;
  if (!estPricePerUnit || estPricePerUnit <= 0) return units;
  const affordable = Math.floor(maxSpend / estPricePerUnit);
  return Math.max(0, Math.min(units, affordable));
}

export interface HoldItem {
  symbol: string;
  units: number;
}

/**
 * Cargo that should be liquidated before a hauler starts fresh arbitrage: every
 * good in the hold with units > 0, optionally excluding `keep` (the good the
 * ship is actively routing and will sell on its own). Ordered by units
 * descending so the biggest frozen-capital sinks are freed first.
 *
 * Why: ships persist their cargo across process restarts. A hauler that ended a
 * prior run holding unsold goods starts the next run with a full hold that
 * doesn't match its newly assigned good — every buy silently no-ops (freeSpace
 * is 0) and the ship churns "bought nothing" forever while its capital stays
 * frozen in stale cargo. Draining the hold first unblocks it.
 */
export function strandedGoods<T extends HoldItem>(inventory: T[], keep?: string): T[] {
  return inventory
    .filter((i) => i.units > 0 && i.symbol !== keep)
    .sort((a, b) => b.units - a.units);
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

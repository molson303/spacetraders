import type { ArbitrageRoute } from '../state/repos.js';

/**
 * Profit-per-trip proxy for ranking routes. Per-unit spread alone favours thin,
 * high-margin goods that a market can only clear a few units of; multiplying by
 * the number of units a single hold-fill can actually move (bounded by the
 * market's trade volume) rewards routes that turn the whole cargo bay over at a
 * profit. A missing/zero trade volume is treated as "fills the hold".
 */
export function routeScore(route: ArbitrageRoute, holdSize = 40): number {
  const vol = route.tradeVolume && route.tradeVolume > 0 ? route.tradeVolume : holdSize;
  const movable = Math.min(vol, holdSize);
  return route.profitPerUnit * movable;
}

/**
 * Pick up to `count` distinct, non-overlapping routes for concurrent traders.
 *
 * Candidates are ranked by {@link routeScore} (best profit-per-trip first). To
 * stop two traders from draining the same market and collapsing the spread, a
 * chosen route must use a good AND a sell waypoint not already claimed by an
 * earlier pick. The result preserves rank order and contains at most `count`
 * routes (fewer if the candidate pool lacks enough distinct goods/sinks).
 */
export function assignRoutes(
  routes: ArbitrageRoute[],
  count: number,
  holdSize = 40,
): ArbitrageRoute[] {
  if (count <= 0) return [];
  const ranked = [...routes].sort((a, b) => routeScore(b, holdSize) - routeScore(a, holdSize));
  const chosen: ArbitrageRoute[] = [];
  const goods = new Set<string>();
  const sells = new Set<string>();
  for (const r of ranked) {
    if (chosen.length >= count) break;
    if (goods.has(r.good) || sells.has(r.sellAt)) continue;
    goods.add(r.good);
    sells.add(r.sellAt);
    chosen.push(r);
  }
  return chosen;
}

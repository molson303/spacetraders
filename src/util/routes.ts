import type { ArbitrageRoute } from '../state/repos.js';
import type { FlightMode } from '../types/index.js';

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
 * SpaceTraders v2 travel-time model. A leg's duration grows with distance and
 * the flight mode's time multiplier, shrinks with engine speed, plus a fixed
 * per-navigation overhead: `round(max(1,d) * multiplier / speed) + 15` seconds.
 * BURN is fastest (and burns 2x fuel), DRIFT slowest (but only 1 fuel).
 */
const MODE_TIME_MULTIPLIER: Record<FlightMode, number> = {
  BURN: 12.5,
  CRUISE: 25,
  STEALTH: 30,
  DRIFT: 250,
};

export function tripSeconds(distance: number, mode: FlightMode = 'CRUISE', engineSpeed = 30): number {
  const d = Math.max(1, distance);
  return Math.round((d * MODE_TIME_MULTIPLIER[mode]) / engineSpeed) + 15;
}

export interface CreditsPerSecondOptions {
  holdSize?: number;
  mode?: FlightMode;
  engineSpeed?: number;
}

/**
 * Rank routes by realized credits per second rather than raw profit-per-trip.
 * A short, fat-volume hop that turns over quickly can out-earn a long, thin
 * high-margin haul even when the latter has a bigger per-trip profit. Time is
 * the round trip (out to buy, back to sell) so the fixed per-navigation
 * overhead is counted for both legs. `distanceOf` is injected so this stays
 * pure and unit-testable.
 */
export function routeCreditsPerSecond(
  route: ArbitrageRoute,
  distanceOf: (from: string, to: string) => number,
  opts: CreditsPerSecondOptions = {},
): number {
  const profit = routeScore(route, opts.holdSize ?? 40);
  const legDistance = distanceOf(route.buyAt, route.sellAt);
  const seconds = 2 * tripSeconds(legDistance, opts.mode, opts.engineSpeed);
  return seconds > 0 ? profit / seconds : 0;
}

/**
 * Pick the fastest flight mode that the available fuel can sustain for a leg of
 * the given distance. BURN (2x fuel) when we can afford it for the speed,
 * CRUISE (1x fuel) normally, and DRIFT (1 fuel, very slow) only as a last
 * resort when even a CRUISE hop would run the tank dry. Pure and injectable.
 */
export function selectFlightMode(distance: number, fuel: number): FlightMode {
  const d = Math.max(1, Math.round(distance));
  if (2 * d <= fuel) return 'BURN';
  if (d <= fuel) return 'CRUISE';
  return 'DRIFT';
}

/**
 * Pick up to `count` distinct, non-overlapping routes for concurrent traders.
 *
 * Candidates are ranked by {@link routeScore} by default (best profit-per-trip
 * first), or by an injected `score` function — pass a
 * {@link routeCreditsPerSecond}-based scorer to rank by throughput instead. To
 * stop two traders from draining the same market and collapsing the spread, a
 * chosen route must use a good AND a sell waypoint not already claimed by an
 * earlier pick. The result preserves rank order and contains at most `count`
 * routes (fewer if the candidate pool lacks enough distinct goods/sinks).
 */
export interface AssignRoutesOptions {
  holdSize?: number;
  /** Custom ranking score; defaults to {@link routeScore}. Higher is better. */
  score?: (route: ArbitrageRoute) => number;
}

export function assignRoutes(
  routes: ArbitrageRoute[],
  count: number,
  opts: AssignRoutesOptions = {},
): ArbitrageRoute[] {
  if (count <= 0) return [];
  const holdSize = opts.holdSize ?? 40;
  const score = opts.score ?? ((r: ArbitrageRoute) => routeScore(r, holdSize));
  const ranked = [...routes].sort((a, b) => score(b) - score(a));
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

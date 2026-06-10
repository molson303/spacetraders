import type { ArbitrageRoute } from '../state/repos.js';
import type { FlightMode } from '../types/index.js';
import { depthCappedBuyUnits, DEFAULT_SELL_DEPTH_MULTIPLE } from './depth.js';

/**
 * Profit-per-trip proxy for ranking routes. Per-unit spread alone favours thin,
 * high-margin goods that a market can only clear a few units of; multiplying by
 * the number of units a single hold-fill can actually move rewards routes that
 * turn the whole cargo bay over at a profit.
 *
 * Movable units are bounded by three limits: the hold size, the buy market's
 * per-fill `tradeVolume`, and — crucially — how much the destination can absorb
 * near full price (`sellVolume`, allowing a few depth steps). Ignoring sell
 * depth is what over-ranked the thin high-value goods that stranded cargo (the
 * `-9` SHIP_PARTS trap). A missing/zero volume on either side is treated as "no
 * limit" for that side.
 */
export function routeScore(
  route: ArbitrageRoute,
  holdSize = 40,
  sellDepthMultiple = DEFAULT_SELL_DEPTH_MULTIPLE,
): number {
  const buyVol = route.tradeVolume && route.tradeVolume > 0 ? route.tradeVolume : holdSize;
  const byBuy = Math.min(buyVol, holdSize);
  const movable = depthCappedBuyUnits(byBuy, route.sellVolume, sellDepthMultiple);
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

/**
 * Choose a single best route for one trader, honoring its assigned good and an
 * avoid-set. Used by the per-cycle trader loop so route re-selection stays
 * throughput-aware (the orchestrator ranks initial assignments the same way,
 * but every subsequent cycle and the idle-contractor fallback used to fall back
 * to raw profit order — which over-picked far, thin sinks that crater
 * credits-per-second).
 *
 * Preference order:
 *  1. The `assignedGood` if it still has a candidate route (the trader sticks to
 *     its lane so concurrent traders don't collapse the same spread).
 *  2. Otherwise the highest-scored route whose good isn't in `avoid`.
 *  3. As a last resort (every remaining good avoided) the highest-scored route.
 *
 * `score` defaults to {@link routeScore}; pass a {@link routeCreditsPerSecond}
 * scorer to rank by throughput. Returns undefined only when `routes` is empty.
 */
export interface BestRouteOptions {
  holdSize?: number;
  score?: (route: ArbitrageRoute) => number;
  assignedGood?: string;
  avoid?: Iterable<string>;
}

export function bestRouteFor(
  routes: ArbitrageRoute[],
  opts: BestRouteOptions = {},
): ArbitrageRoute | undefined {
  if (routes.length === 0) return undefined;
  const holdSize = opts.holdSize ?? 40;
  const score = opts.score ?? ((r: ArbitrageRoute) => routeScore(r, holdSize));
  const avoid = new Set(opts.avoid ?? []);
  const ranked = [...routes].sort((a, b) => score(b) - score(a));
  if (opts.assignedGood) {
    const mine = ranked.find((r) => r.good === opts.assignedGood);
    if (mine) return mine;
  }
  return ranked.find((r) => !avoid.has(r.good)) ?? ranked[0];
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

/**
 * Count the distinct profitable routes available — distinct by both good and
 * sell waypoint, matching {@link assignRoutes}' non-overlap rule. This is the
 * natural ceiling on how many traders can work concurrently without colliding:
 * beyond it, extra ships pile onto goods already being traded and collapse the
 * spread (depth-capped saturation). Order-sensitive only in the same way
 * {@link assignRoutes} is, so pass routes in the same ranked order.
 */
export function countDistinctRoutes(routes: ArbitrageRoute[]): number {
  const goods = new Set<string>();
  const sells = new Set<string>();
  for (const r of routes) {
    if (goods.has(r.good) || sells.has(r.sellAt)) continue;
    goods.add(r.good);
    sells.add(r.sellAt);
  }
  return goods.size;
}

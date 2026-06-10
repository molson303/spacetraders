/*
 * Local-fleet route source: picks the best UNCLAIMED in-system arbitrage route
 * for a ship, ranked by credits-per-second (short, fat-volume hops that turn the
 * hold over fast beat long, thin high-margin hauls).
 *
 * Pure and injectable: the candidate routes and a `distanceOf` function are
 * passed in, so this is unit-testable with no DB. Claim collisions are resolved
 * against the shared {@link ClaimRegistry} — a route is eligible only when
 * neither its good nor its sell waypoint is held by another ship.
 */

import type { ArbitrageRoute } from '../state/repos.js';
import { bestRouteFor, routeCreditsPerSecond } from '../util/routes.js';
import type { ClaimRegistry } from './claimRegistry.js';

export interface LocalPickOptions {
  /** The ship asking for work — its own claim is ignored when filtering. */
  ship: string;
  holdSize?: number;
  /** Sticky lane: prefer this good while it still has a free, profitable route. */
  assignedGood?: string;
  distanceOf: (from: string, to: string) => number;
}

/**
 * Best unclaimed local route for a ship, cr/s-ranked. Filters out every route
 * whose good OR sell waypoint is already claimed by another ship, then applies
 * the sticky assigned-good preference via {@link bestRouteFor}. Returns
 * undefined when no free route remains.
 */
export function pickLocalRoute(
  candidates: ArbitrageRoute[],
  registry: ClaimRegistry,
  opts: LocalPickOptions,
): ArbitrageRoute | undefined {
  const holdSize = opts.holdSize ?? 40;
  const takenGoods = registry.claimedGoods(opts.ship);
  const takenSells = registry.claimedSells(opts.ship);
  const free = candidates.filter((r) => !takenGoods.has(r.good) && !takenSells.has(r.sellAt));
  if (free.length === 0) return undefined;
  return bestRouteFor(free, {
    holdSize,
    assignedGood: opts.assignedGood,
    score: (r) => routeCreditsPerSecond(r, opts.distanceOf, { holdSize }),
  });
}

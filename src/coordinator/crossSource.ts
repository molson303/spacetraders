/*
 * Cross-gate fleet route source: picks the best UNCLAIMED cross-system route for
 * a ship, ranked by net profit after round-trip antimatter (its native metric —
 * a cross spread is only worth a jump when a full hold clears the jump cost).
 *
 * Pure and injectable: candidate routes, a `hopsBetween` reachability function,
 * and a `gateOpen` flag are passed in, so this is unit-testable with no live
 * gate graph or DB. When the home jump gate is under construction `gateOpen` is
 * false and this always returns undefined — the cross fleet then falls back to
 * local trading (handled by the ship agent), so no ship idles while jumps are
 * impossible.
 */

import {
  rankCrossRoutes,
  type CrossSystemRoute,
  type RankedCrossRoute,
} from '../util/crossRoutes.js';
import type { ClaimRegistry } from './claimRegistry.js';

export interface CrossPickOptions {
  /** The ship asking for work — its own claim is ignored when filtering. */
  ship: string;
  holdSize?: number;
  /** Approx credits spent on antimatter per jump. */
  antimatterCost?: number;
  /** False while the home jump gate is under construction (no jumps possible). */
  gateOpen: boolean;
  hopsBetween: (fromSystem: string, toSystem: string) => number | undefined;
}

/**
 * Best unclaimed cross-system route for a ship, net-profit ranked. Returns
 * undefined when the gate is blocked or every reachable, net-positive cross
 * route is already claimed by another ship. Reachability and net-profit come
 * from {@link rankCrossRoutes}; the claim filter then drops any good or sell
 * waypoint another ship holds.
 */
export function pickCrossRoute(
  candidates: CrossSystemRoute[],
  registry: ClaimRegistry,
  opts: CrossPickOptions,
): RankedCrossRoute | undefined {
  if (!opts.gateOpen) return undefined;
  const ranked = rankCrossRoutes(candidates, opts.hopsBetween, {
    holdSize: opts.holdSize ?? 40,
    antimatterCost: opts.antimatterCost ?? 0,
  });
  const takenGoods = registry.claimedGoods(opts.ship);
  const takenSells = registry.claimedSells(opts.ship);
  for (const r of ranked) {
    if (takenGoods.has(r.route.good) || takenSells.has(r.route.sellAt)) continue;
    return r;
  }
  return undefined;
}

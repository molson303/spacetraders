/*
 * Pure cross-system arbitrage ranking.
 *
 * Single-system arbitrage (`findArbitrageRoutes`) only pairs buy/sell waypoints
 * inside one system. Once jump-gate topology is hydrated a trader can buy in
 * system A and sell in system B, but each jump auto-buys antimatter, so a
 * cross-system spread is only worth taking when the per-hold profit clears the
 * round-trip jump cost. This module ranks such routes.
 *
 * It is fully pure: the hop count between systems is injected (compose with
 * `findJumpPath(...).length`), so it can be unit tested without a live graph or
 * any DB. Profit-per-trip reuses {@link routeScore} from `routes.ts`.
 */

import type { ArbitrageRoute } from '../state/repos.js';
import { routeScore } from './routes.js';

export interface CrossSystemRoute extends ArbitrageRoute {
  buySystem: string;
  sellSystem: string;
}

export interface CrossRouteOptions {
  /** Cargo hold size used to bound per-trip volume (default 40). */
  holdSize?: number;
  /** Approx credits spent on antimatter per jump (default 0). */
  antimatterCost?: number;
}

export interface RankedCrossRoute {
  route: CrossSystemRoute;
  /** Jumps one-way from the buy system to the sell system. */
  hops: number;
  /** Gross profit for a full hold, before jump costs. */
  grossProfit: number;
  /** Net profit after the round-trip antimatter spend. */
  netProfit: number;
}

/**
 * Net profit for running a full hold along a cross-system route. Returns
 * `undefined` when the sell system is unreachable from the buy system
 * (`hopsBetween` returns undefined) or when the systems are identical (use the
 * single-system finder for those). Jump cost is charged for the round trip:
 * out to deliver and back to reload, so `2 * hops` antimatter buys.
 */
export function crossRouteNetProfit(
  route: CrossSystemRoute,
  hopsBetween: (fromSystem: string, toSystem: string) => number | undefined,
  opts: CrossRouteOptions = {},
): number | undefined {
  if (route.buySystem === route.sellSystem) return undefined;
  const hops = hopsBetween(route.buySystem, route.sellSystem);
  if (hops === undefined || hops <= 0) return undefined;
  const gross = routeScore(route, opts.holdSize ?? 40);
  const jumpCost = 2 * hops * (opts.antimatterCost ?? 0);
  return gross - jumpCost;
}

/**
 * Rank cross-system routes by net profit, keeping only reachable routes whose
 * full-hold profit clears the round-trip jump cost (net > 0). Ties broken by
 * fewer hops (closer destinations turn over faster). Pure and injectable.
 */
export function rankCrossRoutes(
  routes: CrossSystemRoute[],
  hopsBetween: (fromSystem: string, toSystem: string) => number | undefined,
  opts: CrossRouteOptions = {},
): RankedCrossRoute[] {
  const holdSize = opts.holdSize ?? 40;
  const ranked: RankedCrossRoute[] = [];
  for (const route of routes) {
    if (route.buySystem === route.sellSystem) continue;
    const hops = hopsBetween(route.buySystem, route.sellSystem);
    if (hops === undefined || hops <= 0) continue;
    const grossProfit = routeScore(route, holdSize);
    const netProfit = grossProfit - 2 * hops * (opts.antimatterCost ?? 0);
    if (netProfit <= 0) continue;
    ranked.push({ route, hops, grossProfit, netProfit });
  }
  ranked.sort((a, b) => b.netProfit - a.netProfit || a.hops - b.hops);
  return ranked;
}

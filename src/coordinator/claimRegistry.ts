/*
 * Shared route-claim registry — the single coordination point between the local
 * and cross-gate fleets.
 *
 * Two ships may never work the same good or sell into the same waypoint
 * concurrently, or they collapse that market's spread (the same non-overlap rule
 * the per-round `assignRoutes` enforced, but now live and continuous). Every
 * method is synchronous: a claim decision (read current claims -> pick a route
 * -> record it) must never yield the event loop mid-decision, which keeps the
 * whole thing race-free in Node's single thread even with many concurrent ship
 * loops reading and writing it.
 */

import type { ArbitrageRoute } from '../state/repos.js';
import { countDistinctRoutes } from '../util/routes.js';

export interface Claim {
  ship: string;
  good: string;
  sellAt: string;
}

export class ClaimRegistry {
  private byShip = new Map<string, Claim>();

  /** Record (or replace) a ship's active claim. */
  set(ship: string, good: string, sellAt: string): void {
    this.byShip.set(ship, { ship, good, sellAt });
  }

  /** Drop a ship's claim — call when its trip ends so the lane frees up. */
  release(ship: string): void {
    this.byShip.delete(ship);
  }

  /** The good a ship currently holds a claim on, if any. */
  goodOf(ship: string): string | undefined {
    return this.byShip.get(ship)?.good;
  }

  /** Goods claimed by any ship other than `exceptShip`. */
  claimedGoods(exceptShip?: string): Set<string> {
    const out = new Set<string>();
    for (const c of this.byShip.values()) {
      if (c.ship === exceptShip) continue;
      out.add(c.good);
    }
    return out;
  }

  /** Sell waypoints claimed by any ship other than `exceptShip`. */
  claimedSells(exceptShip?: string): Set<string> {
    const out = new Set<string>();
    for (const c of this.byShip.values()) {
      if (c.ship === exceptShip) continue;
      out.add(c.sellAt);
    }
    return out;
  }

  /** True when `good` or `sellAt` is already taken by some other ship. */
  isTaken(good: string, sellAt: string, exceptShip?: string): boolean {
    for (const c of this.byShip.values()) {
      if (c.ship === exceptShip) continue;
      if (c.good === good || c.sellAt === sellAt) return true;
    }
    return false;
  }

  /** Number of active claims. */
  size(): number {
    return this.byShip.size;
  }

  /** Snapshot of all active claims (for stats/logging). */
  activeClaims(): Claim[] {
    return [...this.byShip.values()];
  }

  /**
   * How many distinct routes remain unclaimed in `candidates` — routes whose
   * good and sell waypoint aren't already taken by some other ship. The reinvest
   * timer uses this to decide whether buying another earner actually has a free
   * lane to work (beyond it, a new ship just doubles up and collapses a spread).
   */
  unclaimedHeadroom(candidates: ArbitrageRoute[]): number {
    const goods = this.claimedGoods();
    const sells = this.claimedSells();
    const free = candidates.filter((r) => !goods.has(r.good) && !sells.has(r.sellAt));
    return countDistinctRoutes(free);
  }
}

/*
 * Fleet partitioning for the continuous (round-free) supervisor. Splits the
 * cargo-earning ships into three role buckets that each get a perpetual agent:
 *
 *   - contractor : the single largest-hold earner, runs the contract pipeline
 *                  (and falls back to local trading between contracts).
 *   - cross      : the `crossShips` highest-fuel earners (excluding the
 *                  contractor) — long-range haulers picked for the legs they can
 *                  cover; they work cross-gate routes and fall back to local.
 *   - local      : every remaining earner, in-system arbitrage only.
 *
 * Probes (fuel-capacity 0) are not earners and are excluded here — they're
 * handled by the probe agents. Pure and deterministic: ranking ties break by
 * cargo then symbol so the same fleet always partitions the same way.
 */

import type { Ship } from '../types/index.js';

/** A ship that can haul cargo and move under its own fuel. */
export function isEarner(s: Ship): boolean {
  return s.cargo.capacity > 0 && s.fuel.capacity > 0;
}

export interface FleetPartition {
  contractor?: Ship;
  cross: Ship[];
  local: Ship[];
}

export interface PartitionOptions {
  /** How many earners to dedicate to cross-gate hauling (default 0). */
  crossShips?: number;
  /** Whether the largest earner is reserved as the contractor (default true). */
  enableContractor?: boolean;
  /**
   * Ship symbols to drop from every bucket — dedicated to an out-of-band job
   * (e.g. feeding a factory's inputs or supplying the jump gate) so the trade
   * fleet never fights over them. Mirrors the orchestrator's EXCLUDE_SHIPS.
   */
  excludeShips?: string[];
}

/** Descending by fuel, then cargo, then symbol — deterministic tiebreaks. */
function byRange(a: Ship, b: Ship): number {
  return (
    b.fuel.capacity - a.fuel.capacity ||
    b.cargo.capacity - a.cargo.capacity ||
    a.symbol.localeCompare(b.symbol)
  );
}

/** Descending by cargo, then fuel, then symbol. */
function byHold(a: Ship, b: Ship): number {
  return (
    b.cargo.capacity - a.cargo.capacity ||
    b.fuel.capacity - a.fuel.capacity ||
    a.symbol.localeCompare(b.symbol)
  );
}

/**
 * Partition earners into contractor / cross / local buckets. Non-earners
 * (probes) are dropped. The contractor is the largest-hold earner; the cross
 * fleet is the next `crossShips` highest-fuel earners; the rest trade local.
 */
export function partitionFleet(ships: Ship[], opts: PartitionOptions = {}): FleetPartition {
  const crossShips = Math.max(0, opts.crossShips ?? 0);
  const enableContractor = opts.enableContractor ?? true;
  const excluded = new Set(opts.excludeShips ?? []);

  const earners = ships.filter((s) => isEarner(s) && !excluded.has(s.symbol));
  if (earners.length === 0) return { cross: [], local: [] };

  let contractor: Ship | undefined;
  let pool = earners;
  if (enableContractor) {
    contractor = [...earners].sort(byHold)[0];
    pool = earners.filter((s) => s.symbol !== contractor!.symbol);
  }

  const ranked = [...pool].sort(byRange);
  const cross = ranked.slice(0, crossShips);
  const local = ranked.slice(crossShips);
  return { contractor, cross, local };
}

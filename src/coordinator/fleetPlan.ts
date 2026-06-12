/*
 * Fleet partitioning for the continuous (round-free) supervisor. Splits the
 * cargo-earning ships into four role buckets that each get a perpetual agent:
 *
 *   - contractor : the single largest-hold earner, runs the contract pipeline
 *                  (and falls back to local trading between contracts).
 *   - cross      : the `crossShips` highest-fuel earners (excluding the
 *                  contractor) — long-range haulers picked for the legs they can
 *                  cover; they work cross-gate routes and fall back to local.
 *   - remote     : earners relocated to live in a *remote* system and run
 *                  in-system arbitrage there (no jump back home per trade), one
 *                  per `remoteSystems` quota. Picked next-highest-range after
 *                  cross since they make a one-time relocation jump and must
 *                  self-refuel out there.
 *   - local      : every remaining earner, in-system arbitrage in the home system.
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

/** A remote system and how many earners to station there as in-system traders. */
export interface RemoteSystemSpec {
  system: string;
  ships: number;
}

/** An earner assigned to trade in-system within a specific (remote) system. */
export interface RemoteTrader {
  ship: Ship;
  system: string;
}

export interface FleetPartition {
  contractor?: Ship;
  cross: Ship[];
  remote: RemoteTrader[];
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
  /**
   * Remote systems to station in-system traders in. Each spec pulls `ships`
   * earners from the top of the remaining (highest-range) pool, filled in list
   * order. Defaults to none — when empty the partition behaves exactly as before.
   */
  remoteSystems?: RemoteSystemSpec[];
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
 * Partition earners into contractor / cross / remote / local buckets. Non-earners
 * (probes) are dropped. The contractor is the largest-hold earner; the cross
 * fleet is the next `crossShips` highest-fuel earners; remote traders are the
 * next-highest-range earners (filled per `remoteSystems` quota, list order); the
 * rest trade local in the home system.
 */
export function partitionFleet(ships: Ship[], opts: PartitionOptions = {}): FleetPartition {
  const crossShips = Math.max(0, opts.crossShips ?? 0);
  const enableContractor = opts.enableContractor ?? true;
  const excluded = new Set(opts.excludeShips ?? []);
  const remoteSystems = opts.remoteSystems ?? [];

  const earners = ships.filter((s) => isEarner(s) && !excluded.has(s.symbol));
  if (earners.length === 0) return { cross: [], remote: [], local: [] };

  let contractor: Ship | undefined;
  let pool = earners;
  if (enableContractor) {
    contractor = [...earners].sort(byHold)[0];
    pool = earners.filter((s) => s.symbol !== contractor!.symbol);
  }

  const ranked = [...pool].sort(byRange);
  const cross = ranked.slice(0, crossShips);
  const rest = ranked.slice(crossShips);

  // Remote in-system traders: drawn from the top of the remaining range-ranked
  // pool, filled system-by-system in list order until each quota or the pool runs out.
  const remote: RemoteTrader[] = [];
  let cursor = 0;
  for (const spec of remoteSystems) {
    const n = Math.max(0, spec.ships);
    for (let i = 0; i < n && cursor < rest.length; i++, cursor++) {
      remote.push({ ship: rest[cursor]!, system: spec.system });
    }
  }
  const local = rest.slice(cursor);
  return { contractor, cross, remote, local };
}

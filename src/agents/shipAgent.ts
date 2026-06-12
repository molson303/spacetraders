/*
 * Per-ship perpetual agent — the unit of work in the continuous (round-free)
 * fleet model. One agent drives one ship forever: each iteration it claims a
 * fresh route from its fleet's source, runs the trip, releases the claim, and
 * loops. Because every ship owns its own loop there is no round barrier — a ship
 * on a long leg never holds up siblings, and a ship that finishes early picks up
 * its next trip immediately instead of idling until the round rolls over.
 *
 * Three roles share the same loop:
 *   - `local`      : in-system arbitrage, cr/s-ranked ({@link pickLocalRoute}).
 *   - `remote`     : identical in-system arbitrage, but the ship lives in a
 *                    remote system and its `localCandidates` are that system's
 *                    routes — no jump back home per trade. Tracked separately
 *                    for stats; control-flow is the same as `local`.
 *   - `cross`      : cross-gate arbitrage, net-profit-ranked
 *                    ({@link pickCrossRoute}); falls back to a local trip when
 *                    the gate is shut or every cross lane is claimed, so a cross
 *                    ship never idles waiting for the jump gate.
 *   - `contractor` : runs the contract pipeline; when no contract is workable it
 *                    falls back to a local trip too.
 *
 * The agent is pure of I/O: every side-effecting capability (route execution,
 * candidate fetch, gate/stop predicates, ship refetch, idle delay) is injected,
 * so the whole control-flow is unit-testable with no API, DB, or real clock.
 * Claim safety relies on the pick→`registry.set` step running synchronously with
 * no `await` between read and write — the single-thread race-free contract the
 * {@link ClaimRegistry} documents.
 */

import type { ArbitrageRoute } from '../state/repos.js';
import type { CrossSystemRoute } from '../util/crossRoutes.js';
import type { Ship } from '../types/index.js';
import type { ClaimRegistry } from '../coordinator/claimRegistry.js';
import { pickLocalRoute } from '../coordinator/localSource.js';
import { pickCrossRoute } from '../coordinator/crossSource.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('shipAgent');

export type ShipRole = 'local' | 'cross' | 'contractor' | 'remote';

export interface ShipAgentDeps {
  /** Fresh in-system arbitrage candidates for this trip (live prices). */
  localCandidates: () => ArbitrageRoute[];
  /** Fresh cross-system arbitrage candidates for this trip. */
  crossCandidates: () => CrossSystemRoute[];
  /** Execute one local route; returns the moved ship, realized profit, and whether a trade actually happened. */
  execLocal: (ship: Ship, route: ArbitrageRoute) => Promise<{ ship: Ship; profit: number; traded: boolean }>;
  /** Execute one cross-system route; returns the moved ship, realized profit, and whether a trade actually happened. */
  execCross: (ship: Ship, route: CrossSystemRoute) => Promise<{ ship: Ship; profit: number; traded: boolean }>;
  /** Run the contract pipeline once; returns the number of contracts completed. */
  execContract?: (ship: Ship) => Promise<number>;
  /** Re-fetch live ship state (the contract pipeline moves the ship internally). */
  refetchShip: (symbol: string) => Promise<Ship>;
  /**
   * Self-repair check run between trips. Self-gating: a no-op (cheap, no I/O)
   * when the ship is healthy, otherwise diverts the ship to a shipyard and
   * returns it repaired. Omit to disable mid-loop repair.
   */
  repairIfWorn?: (ship: Ship) => Promise<Ship>;
  distanceOf: (from: string, to: string) => number;
  hopsBetween: (fromSystem: string, toSystem: string) => number | undefined;
  /** False while the home jump gate is under construction. */
  gateOpen: () => boolean;
  /** Cooperative stop signal — the loop exits before starting a new trip. */
  stopping: () => boolean;
  /** Awaited when a trip yields no work, so an idle ship doesn't busy-spin. */
  idleDelay?: () => Promise<void>;
  /** Reported after every trip (for fleet stats / logging). */
  onTrip?: (info: { ship: string; role: ShipRole; kind: TripKind; profit: number }) => void;
}

export type TripKind = 'local' | 'cross' | 'contract' | 'idle';

export interface ShipAgentOptions {
  role: ShipRole;
  system: string;
  minProfit?: number;
  /** Sticky lane for local trips. */
  assignedGood?: string;
  antimatterCost?: number;
  holdSize?: number;
  /** Bound on trips — defaults to Infinity (perpetual). Tests pass a small N. */
  maxTrips?: number;
}

export interface ShipAgentResult {
  trips: number;
  profit: number;
  contracts: number;
}

/**
 * Drive one ship forever (or for `maxTrips`). Returns aggregate counters once the
 * stop signal fires or the trip bound is hit.
 */
export async function runShipAgent(
  ship: Ship,
  registry: ClaimRegistry,
  deps: ShipAgentDeps,
  opts: ShipAgentOptions,
): Promise<ShipAgentResult> {
  const maxTrips = opts.maxTrips ?? Number.POSITIVE_INFINITY;
  const holdSize = opts.holdSize ?? ship.cargo.capacity;

  let trips = 0;
  let profit = 0;
  let contracts = 0;

  // Run one in-system arbitrage trip: claim the best unclaimed local route,
  // execute it, release the claim. Returns the trip profit and whether a trade
  // actually executed, or undefined when no free local route exists. A route that
  // was claimed but no-opped (budget cap, bought nothing) reports traded=false so
  // the caller idles with backoff instead of busy-spinning on the same dead route.
  // The pick→set pair is synchronous (no await between) to keep claiming race-free
  // across concurrent agents.
  const tradeLocalOnce = async (): Promise<{ profit: number; traded: boolean } | undefined> => {
    const route = pickLocalRoute(deps.localCandidates(), registry, {
      ship: ship.symbol,
      holdSize,
      assignedGood: opts.assignedGood,
      distanceOf: deps.distanceOf,
    });
    if (!route) return undefined;
    registry.set(ship.symbol, route.good, route.sellAt);
    try {
      const res = await deps.execLocal(ship, route);
      ship = res.ship;
      return { profit: res.profit, traded: res.traded };
    } finally {
      registry.release(ship.symbol);
    }
  };

  while (!deps.stopping() && trips < maxTrips) {
    let kind: TripKind = 'idle';
    let tripProfit = 0;

    // Between trips, divert to repair if a component has worn past the
    // threshold. Self-gating, so this is a cheap no-op while the ship is healthy.
    if (deps.repairIfWorn) {
      try {
        ship = await deps.repairIfWorn(ship);
      } catch (err) {
        log.warn(`${ship.symbol} repair check failed: ${(err as Error).message}`);
      }
    }

    try {
      if (opts.role === 'contractor') {
        const n = deps.execContract ? await deps.execContract(ship) : 0;
        if (n > 0) {
          contracts += n;
          kind = 'contract';
          // The pipeline moved the ship internally; resync before the next trip.
          ship = await deps.refetchShip(ship.symbol);
        } else {
          const p = await tradeLocalOnce();
          if (p?.traded) {
            tripProfit = p.profit;
            kind = 'local';
          }
        }
      } else if (opts.role === 'cross') {
        const ranked = pickCrossRoute(deps.crossCandidates(), registry, {
          ship: ship.symbol,
          holdSize,
          antimatterCost: opts.antimatterCost,
          gateOpen: deps.gateOpen(),
          hopsBetween: deps.hopsBetween,
        });
        if (ranked) {
          registry.set(ship.symbol, ranked.route.good, ranked.route.sellAt);
          try {
            const res = await deps.execCross(ship, ranked.route);
            ship = res.ship;
            if (res.traded) {
              tripProfit = res.profit;
              kind = 'cross';
            }
          } finally {
            registry.release(ship.symbol);
          }
        } else {
          // Gate shut or every cross lane claimed — don't idle, trade local.
          const p = await tradeLocalOnce();
          if (p?.traded) {
            tripProfit = p.profit;
            kind = 'local';
          }
        }
      } else {
        const p = await tradeLocalOnce();
        if (p?.traded) {
          tripProfit = p.profit;
          kind = 'local';
        }
      }
    } catch (err) {
      log.error(`${ship.symbol} trip errored: ${(err as Error).message}`);
      kind = 'idle';
    }

    profit += tripProfit;
    trips++;
    deps.onTrip?.({ ship: ship.symbol, role: opts.role, kind, profit: tripProfit });

    if (kind === 'idle' && deps.idleDelay) {
      await deps.idleDelay();
    }
  }

  log.info(
    `${ship.symbol} agent done: ${trips} trip(s), profit=${profit}, contracts=${contracts}`,
  );
  return { trips, profit, contracts };
}

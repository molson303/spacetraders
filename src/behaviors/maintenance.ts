/*
 * Ship maintenance: ships accumulate wear as they fly, mine, and trade. Each
 * component (frame / reactor / engine) reports a `condition` in [0,1]; as it
 * falls the ship loses performance and eventually the component fails. Repairing
 * at a shipyard restores condition. These helpers decide when a repair is worth
 * the detour and drive it. The pure scoring functions are unit-tested; the
 * `maybeRepair` orchestration handles the live navigation + transaction.
 */
import type { SpaceTradersApi } from '../client/api.js';
import { ensureDocked, travelTo } from '../util/nav.js';
import { recordTransaction, upsertShip } from '../state/repos.js';
import type { Ship } from '../types/index.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('maint');

/** Default condition at/below which a component is considered worth repairing. */
export const DEFAULT_REPAIR_THRESHOLD = 0.4;

/** All defined component conditions (frame/reactor/engine) for a ship. */
export function componentConditions(ship: Ship): number[] {
  return [ship.frame.condition, ship.reactor.condition, ship.engine.condition].filter(
    (c): c is number => typeof c === 'number',
  );
}

/** The worst component condition on a ship, or undefined if none are reported. */
export function lowestCondition(ship: Ship): number | undefined {
  const conds = componentConditions(ship);
  return conds.length > 0 ? Math.min(...conds) : undefined;
}

/**
 * True when any component has fallen to/below `threshold`. Returns false when
 * the API reports no condition data (older snapshots) so we never block on
 * missing information. Condition is on the API's [0,1] scale.
 */
export function needsRepair(ship: Ship, threshold: number = DEFAULT_REPAIR_THRESHOLD): boolean {
  const low = lowestCondition(ship);
  return low !== undefined && low <= threshold;
}

export interface RepairOptions {
  /** Waypoint with a shipyard where the repair can be performed. */
  shipyard: string;
  /** Condition at/below which to repair (default {@link DEFAULT_REPAIR_THRESHOLD}). */
  threshold?: number;
  /** Skip the repair if it would cost more than this (e.g. credits - reserve). */
  maxSpend?: number;
}

/**
 * Repair a ship if any component has worn below the threshold: route it to the
 * shipyard, dock, preview the cost, and (if within `maxSpend`) repair to full.
 * Returns the ship — repaired when work was done, otherwise unchanged. Safe to
 * call every round; it no-ops when the ship is healthy or repair is unaffordable.
 */
export async function maybeRepair(api: SpaceTradersApi, ship: Ship, opts: RepairOptions): Promise<Ship> {
  const threshold = opts.threshold ?? DEFAULT_REPAIR_THRESHOLD;
  if (!needsRepair(ship, threshold)) return ship;

  const low = lowestCondition(ship);
  log.info(`${ship.symbol} worn (condition ${low?.toFixed(2)} <= ${threshold}); repairing at ${opts.shipyard}`);
  ship = await travelTo(api, ship, opts.shipyard);
  ship = await ensureDocked(api, ship);

  let cost: number;
  try {
    cost = (await api.getRepairCost(ship.symbol)).transaction.totalPrice;
  } catch (err) {
    log.warn(`${ship.symbol} repair cost preview failed: ${(err as Error).message}`);
    return ship;
  }
  if (opts.maxSpend != null && cost > opts.maxSpend) {
    log.warn(`${ship.symbol} repair costs ${cost} > budget ${opts.maxSpend}; deferring`);
    return ship;
  }

  try {
    const res = await api.repairShip(ship.symbol);
    upsertShip(res.ship);
    recordTransaction({
      ship: res.ship.symbol,
      kind: 'REPAIR',
      waypoint: opts.shipyard,
      total: -cost,
      creditsAfter: res.agent.credits,
    });
    log.info(`${ship.symbol} repaired for ${cost} (credits=${res.agent.credits})`);
    return res.ship;
  } catch (err) {
    log.warn(`${ship.symbol} repair failed: ${(err as Error).message}`);
    return ship;
  }
}

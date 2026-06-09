/*
 * Live cross-system travel orchestration.
 *
 * Ships without a warp drive move between systems by hopping jump gate ->
 * jump gate until they reach a gate in the destination system, then fly
 * intra-system to the final waypoint. This module wires the pure BFS planner
 * (`findJumpPath`) to the imperative nav/jump primitives. It performs LIVE API
 * calls; the decision logic it relies on lives in `jumpPath.ts` and is unit
 * tested there.
 *
 * Flow:
 *   1. Already in the destination system -> intra-system `travelTo`.
 *   2. Otherwise find the local jump gate, plan a gate path to the target
 *      system, fly to the departure gate, then jump gate-by-gate (refuel +
 *      cooldown between hops).
 *   3. Land on a gate in the destination system -> intra-system `travelTo`.
 *
 * Defensive: returns the ship unmoved (with a warning) when the system has no
 * known jump gate or no path can be planned from the hydrated topology.
 */

import type { SpaceTradersApi } from '../client/api.js';
import { findJumpGatesBySystem, getJumpGateRow, recordTransaction, upsertShip } from '../state/repos.js';
import { systemOf } from '../state/world.js';
import type { Ship } from '../types/index.js';
import { findJumpPath } from './jumpPath.js';
import { createLogger } from './logger.js';
import { ensureOrbit, travelTo, tryRefuel, waitForArrival, waitForCooldown } from './nav.js';

const log = createLogger('crossNav');

/**
 * Travel a ship to `destination`, which may be in another system. Returns the
 * ship IN_ORBIT at the destination, or unmoved if no jump path is known.
 */
export async function crossSystemTravelTo(
  api: SpaceTradersApi,
  ship: Ship,
  destination: string,
): Promise<Ship> {
  if (ship.nav.status === 'IN_TRANSIT') ship = await waitForArrival(api, ship);

  const targetSystem = systemOf(destination);
  const here = ship.nav.systemSymbol;

  // Same system: plain intra-system travel handles it.
  if (here === targetSystem) return travelTo(api, ship, destination);

  // Find the jump gate we depart from.
  const localGate = findJumpGatesBySystem(here)[0];
  if (!localGate) {
    log.warn(`${ship.symbol} cannot leave ${here}: no known jump gate (hydrate gates first)`);
    return ship;
  }

  // Plan the gate hops using the hydrated topology.
  const neighbors = (gate: string): string[] => getJumpGateRow(gate)?.connections ?? [];
  const path = findJumpPath(localGate.symbol, targetSystem, neighbors, systemOf);
  if (path === undefined) {
    log.warn(
      `${ship.symbol} no jump path from ${localGate.symbol} to ${targetSystem} (topology not hydrated / unreachable)`,
    );
    return ship;
  }

  // Fly to the departure gate (intra-system, fuel-aware).
  ship = await travelTo(api, ship, localGate.symbol);

  // Jump gate-by-gate toward the destination system.
  for (const targetGate of path) {
    ship = await tryRefuel(api, ship);
    ship = await ensureOrbit(api, ship);

    const res = await api.jumpShip(ship.symbol, targetGate);
    ship.nav = res.nav;
    upsertShip(ship);

    const total = res.transaction?.totalPrice;
    recordTransaction({
      ship: ship.symbol,
      kind: 'JUMP',
      waypoint: targetGate,
      total: total != null ? -total : undefined,
      creditsAfter: res.agent?.credits,
    });
    log.info(
      `${ship.symbol} jumped to ${targetGate} (${systemOf(targetGate)})${total != null ? `, antimatter -${total}` : ''}`,
    );

    await waitForCooldown(api, ship.symbol);
  }

  // Now somewhere in the destination system; finish intra-system.
  return travelTo(api, ship, destination);
}

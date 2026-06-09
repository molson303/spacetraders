/*
 * Station keeper. Stationed probes sit permanently at a marketplace; each round
 * this refreshes their market prices into the DB with an in-place scan (no
 * travel) so traders compute routes against live data. A probe that has drifted
 * off its station (e.g. borrowed for ferrying, or a freshly bought probe) is
 * relocated to its assigned waypoint first, then scanned.
 *
 * Cross-system stations are only serviced when jumps are available; otherwise a
 * probe assigned to a neighbor system is left in place this round. Each probe is
 * handled independently so one failure never sinks the rest of the pass.
 */

import type { SpaceTradersApi } from '../client/api.js';
import { scanMarket, systemOf } from '../state/world.js';
import { travelTo } from '../util/nav.js';
import { crossSystemTravelTo } from '../util/crossNav.js';
import { createLogger } from '../util/logger.js';
import type { StationAssignment } from '../util/stations.js';
import type { Ship } from '../types/index.js';

const log = createLogger('stationKeeper');

export interface StationKeeperOptions {
  /** Whether jumps are currently possible (home gate operational). */
  allowCrossSystem?: boolean;
  /** Stop servicing further probes once this returns true. */
  shouldStop?: () => boolean;
}

export interface StationKeeperResult {
  /** Markets refreshed this pass. */
  refreshed: number;
  /** Probes moved back onto their station this pass. */
  relocated: number;
}

/**
 * Refresh every stationed probe's market. Probes already on station scan in
 * place; drifted probes travel to their station first. Returns counts of
 * markets refreshed and probes relocated.
 */
export async function runStationKeeping(
  api: SpaceTradersApi,
  probes: Ship[],
  stations: StationAssignment[],
  opts: StationKeeperOptions = {},
): Promise<StationKeeperResult> {
  const allowCross = opts.allowCrossSystem ?? false;
  const bySymbol = new Map(probes.map((p) => [p.symbol, p]));
  const result: StationKeeperResult = { refreshed: 0, relocated: 0 };

  for (const station of stations) {
    if (opts.shouldStop?.()) break;
    let ship = bySymbol.get(station.ship);
    if (!ship) continue;

    const targetSystem = systemOf(station.waypoint);
    const sameSystem = ship.nav.systemSymbol === targetSystem;
    if (!sameSystem && !allowCross) {
      log.debug(`${ship.symbol} station ${station.waypoint} is cross-system; jumps unavailable, skipping`);
      continue;
    }

    try {
      const onStation =
        ship.nav.status !== 'IN_TRANSIT' && ship.nav.waypointSymbol === station.waypoint;
      if (!onStation) {
        ship = sameSystem
          ? await travelTo(api, ship, station.waypoint)
          : await crossSystemTravelTo(api, ship, station.waypoint);
        if (ship.nav.waypointSymbol !== station.waypoint) {
          log.warn(`${ship.symbol} failed to reach station ${station.waypoint}; skipping`);
          continue;
        }
        result.relocated++;
      }
      await scanMarket(api, targetSystem, station.waypoint);
      result.refreshed++;
    } catch (err) {
      log.warn(`${station.ship} station-keeping at ${station.waypoint} failed: ${(err as Error).message}`);
    }
  }

  log.info(`station keeping: refreshed ${result.refreshed} market(s), relocated ${result.relocated} probe(s)`);
  return result;
}

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
  /** Skip the whole pass when this returns true (checked once, before launch). */
  shouldStop?: () => boolean;
}

export interface StationKeeperResult {
  /** Markets refreshed this pass. */
  refreshed: number;
  /** Probes moved back onto their station this pass. */
  relocated: number;
}

/**
 * Collaborators, injectable so the concurrency behavior can be unit-tested
 * without real travel or live market scans. Defaults wire the real helpers.
 */
export interface StationKeeperDeps {
  travel: (api: SpaceTradersApi, ship: Ship, destination: string) => Promise<Ship>;
  crossTravel: (api: SpaceTradersApi, ship: Ship, destination: string) => Promise<Ship>;
  scan: (api: SpaceTradersApi, system: string, waypoint: string) => Promise<unknown>;
}

const defaultDeps: StationKeeperDeps = {
  travel: travelTo,
  crossTravel: crossSystemTravelTo,
  scan: scanMarket,
};

/** Outcome of servicing a single station; both counts are 0 or 1. */
interface StationOutcome {
  refreshed: number;
  relocated: number;
}

/**
 * Relocate (if drifted) and refresh one stationed probe's market. Throws on
 * failure so the caller's `Promise.allSettled` isolates it from siblings.
 */
async function serviceStation(
  api: SpaceTradersApi,
  ship: Ship,
  station: StationAssignment,
  sameSystem: boolean,
  deps: StationKeeperDeps,
): Promise<StationOutcome> {
  const targetSystem = systemOf(station.waypoint);
  let relocated = 0;
  const onStation =
    ship.nav.status !== 'IN_TRANSIT' && ship.nav.waypointSymbol === station.waypoint;
  if (!onStation) {
    ship = sameSystem
      ? await deps.travel(api, ship, station.waypoint)
      : await deps.crossTravel(api, ship, station.waypoint);
    if (ship.nav.waypointSymbol !== station.waypoint) {
      log.warn(`${ship.symbol} failed to reach station ${station.waypoint}; skipping`);
      return { refreshed: 0, relocated: 0 };
    }
    relocated = 1;
  }
  await deps.scan(api, targetSystem, station.waypoint);
  return { refreshed: 1, relocated };
}

/**
 * Refresh every stationed probe's market. Probes already on station scan in
 * place; drifted probes travel to their station first. Every probe is serviced
 * concurrently — each is independent and the client rate-limits, so navigation
 * legs overlap instead of serializing (12 probes ferrying from a shipyard
 * settle in roughly one max leg rather than the sum of all legs). Returns
 * counts of markets refreshed and probes relocated.
 */
export async function runStationKeeping(
  api: SpaceTradersApi,
  probes: Ship[],
  stations: StationAssignment[],
  opts: StationKeeperOptions = {},
  deps: StationKeeperDeps = defaultDeps,
): Promise<StationKeeperResult> {
  const result: StationKeeperResult = { refreshed: 0, relocated: 0 };
  if (opts.shouldStop?.()) return result;

  const allowCross = opts.allowCrossSystem ?? false;
  const bySymbol = new Map(probes.map((p) => [p.symbol, p]));

  // Resolve which stations are serviceable this pass before launching any work.
  const serviceable: Array<{ ship: Ship; station: StationAssignment; sameSystem: boolean }> = [];
  for (const station of stations) {
    const ship = bySymbol.get(station.ship);
    if (!ship) continue;
    const sameSystem = ship.nav.systemSymbol === systemOf(station.waypoint);
    if (!sameSystem && !allowCross) {
      log.debug(
        `${ship.symbol} station ${station.waypoint} is cross-system; jumps unavailable, skipping`,
      );
      continue;
    }
    serviceable.push({ ship, station, sameSystem });
  }

  const outcomes = await Promise.allSettled(
    serviceable.map(({ ship, station, sameSystem }) =>
      serviceStation(api, ship, station, sameSystem, deps),
    ),
  );

  outcomes.forEach((outcome, i) => {
    if (outcome.status === 'fulfilled') {
      result.refreshed += outcome.value.refreshed;
      result.relocated += outcome.value.relocated;
    } else {
      const { station } = serviceable[i]!;
      log.warn(
        `${station.ship} station-keeping at ${station.waypoint} failed: ${
          (outcome.reason as Error)?.message ?? outcome.reason
        }`,
      );
    }
  });

  log.info(
    `station keeping: refreshed ${result.refreshed} market(s), relocated ${result.relocated} probe(s)`,
  );
  return result;
}

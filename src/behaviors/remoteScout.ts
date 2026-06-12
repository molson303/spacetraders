/*
 * Remote market scout. A fuel-free probe can't earn, but it can ride the jump
 * gates into directly-reachable neighbor systems and read their market prices
 * into the DB — the prerequisite for any cross-system arbitrage, since the API
 * only returns live prices when a ship is physically present at the market.
 *
 * Each invocation: ensure the home gate topology is known, pick neighbor
 * systems not yet scanned, and for each (within the system limit) jump over,
 * hydrate its waypoints + gate, scan its marketplaces, then return home.
 *
 * Budgeting: a fuel-free probe is slow — the leg out to the gate alone can run
 * tens of minutes. The scan `budgetMs` therefore bounds only the in-system
 * scanning work, measured fresh from arrival in each neighbor; cross-gate travel
 * is never charged against it. (The old behavior set one deadline at entry, so a
 * probe that spent the whole budget just reaching the gate arrived with the
 * clock already blown and scanned nothing.) The total run is still bounded by
 * `maxSystems` and `marketsPerSystem`.
 *
 * Defensive: a probe has no fuel tank so it can't strand on fuel; the only risk
 * is a failed jump (no antimatter / unhydrated topology), in which case the
 * system is skipped and the probe attempts to return home. Every external
 * capability is injected (see {@link RemoteScoutDeps}) so the budget/routing
 * logic is unit-testable without real travel or a live DB.
 */

import type { SpaceTradersApi } from '../client/api.js';
import {
  findJumpGatesBySystem,
  findWaypointsByTrait,
  getJumpGateRow,
  isWaypointUnderConstruction,
} from '../state/repos.js';
import { kvGet } from '../state/kv.js';
import {
  hydrateJumpGates,
  hydrateSystemWaypoints,
  scanMarket,
  systemOf,
} from '../state/world.js';
import { pickScoutTargets } from '../util/jumpPath.js';
import { crossSystemTravelTo } from '../util/crossNav.js';
import { travelTo } from '../util/nav.js';
import { createLogger } from '../util/logger.js';
import type { Ship } from '../types/index.js';

const log = createLogger('remoteScout');

export interface RemoteScoutOptions {
  /** Max neighbor systems to scout this invocation (default 2). */
  maxSystems?: number;
  /** Max marketplaces to scan per neighbor system (default 6). */
  marketsPerSystem?: number;
  /** Per-system scanning budget in ms, measured from arrival (not travel). */
  budgetMs?: number;
  /** External stop signal checked between systems and between scans. */
  shouldStop?: () => boolean;
}

/**
 * Collaborators, injectable so the budget/routing behavior can be unit-tested
 * without real travel or a live DB. Defaults wire the real helpers.
 */
export interface RemoteScoutDeps {
  hydrateGates: (api: SpaceTradersApi, system: string) => Promise<unknown>;
  hydrateWaypoints: (api: SpaceTradersApi, system: string) => Promise<unknown>;
  /** Home-system jump gate waypoint symbol, if one is known. */
  homeGate: (system: string) => string | undefined;
  /** Waypoint symbols this gate connects to (neighbor + same-system gates). */
  gateConnections: (gateSymbol: string) => string[];
  underConstruction: (symbol: string) => boolean;
  /** A neighbor system already has captured market structures/prices. */
  isScanned: (system: string) => boolean;
  /** Marketplace waypoint symbols in a system. */
  marketsIn: (system: string) => string[];
  crossTravel: (api: SpaceTradersApi, ship: Ship, destination: string) => Promise<Ship>;
  travel: (api: SpaceTradersApi, ship: Ship, destination: string) => Promise<Ship>;
  scan: (api: SpaceTradersApi, system: string, waypoint: string) => Promise<unknown>;
  /** Wall clock, injectable so tests can advance time across fake travel. */
  now: () => number;
}

/** A neighbor system already has captured market structures/prices. */
function defaultIsScanned(system: string): boolean {
  return (
    Boolean(kvGet<boolean>(`market_structures:${system}`)) ||
    Boolean(kvGet<boolean>(`system_scanned:${system}`))
  );
}

const defaultDeps: RemoteScoutDeps = {
  hydrateGates: hydrateJumpGates,
  hydrateWaypoints: hydrateSystemWaypoints,
  homeGate: (system) => findJumpGatesBySystem(system)[0]?.symbol,
  gateConnections: (gateSymbol) => getJumpGateRow(gateSymbol)?.connections ?? [],
  underConstruction: isWaypointUnderConstruction,
  isScanned: defaultIsScanned,
  marketsIn: (system) => findWaypointsByTrait(system, 'MARKETPLACE').map((w) => w.symbol),
  crossTravel: crossSystemTravelTo,
  travel: travelTo,
  scan: scanMarket,
  now: () => Date.now(),
};

/**
 * Scout unscanned neighbor systems, capturing their market prices. Returns how
 * many neighbor systems were reached this run. The `budgetMs` bounds scanning
 * within each system (from arrival), never the travel between systems.
 */
export async function runRemoteScout(
  api: SpaceTradersApi,
  ship: Ship,
  homeSystem: string,
  opts: RemoteScoutOptions = {},
  deps: RemoteScoutDeps = defaultDeps,
): Promise<{ scannedSystems: number }> {
  const maxSystems = opts.maxSystems ?? 2;
  const marketsPerSystem = opts.marketsPerSystem ?? 6;
  const budgetMs = opts.budgetMs && opts.budgetMs > 0 ? opts.budgetMs : 0;
  const shouldStop = (): boolean => opts.shouldStop?.() ?? false;

  await deps.hydrateGates(api, homeSystem);
  const homeGate = deps.homeGate(homeSystem);
  if (!homeGate) {
    log.warn(`no jump gate known in ${homeSystem}; cannot scout`);
    return { scannedSystems: 0 };
  }

  // A gate under construction rejects every jump, so a remote scout can only
  // waste a probe trip out to a dead gate. Bail before moving.
  if (deps.underConstruction(homeGate)) {
    log.info(`jump gate ${homeGate} under construction; remote scout disabled`);
    return { scannedSystems: 0 };
  }

  const neighbors = (g: string): string[] => deps.gateConnections(g);
  const targets = pickScoutTargets(homeGate, neighbors, systemOf, deps.isScanned).slice(0, maxSystems);
  if (targets.length === 0) {
    log.info(`all neighbors of ${homeSystem} already scanned`);
    return { scannedSystems: 0 };
  }
  log.info(`${ship.symbol} scouting ${targets.length} neighbor system(s): [${targets.join(', ')}]`);

  let scannedSystems = 0;
  for (const sys of targets) {
    if (shouldStop()) break;
    const gateThere = neighbors(homeGate).find((c) => systemOf(c) === sys);
    if (!gateThere) continue;

    ship = await deps.crossTravel(api, ship, gateThere);
    if (ship.nav.systemSymbol !== sys) {
      log.warn(`${ship.symbol} failed to reach ${sys}; skipping`);
      continue;
    }

    await deps.hydrateWaypoints(api, sys);
    await deps.hydrateGates(api, sys);

    // Start the scan budget now that we've arrived — the long cross-gate travel
    // must never eat it, or a slow fuel-free probe would arrive with the
    // deadline already blown and scan nothing.
    const scanDeadline = budgetMs > 0 ? deps.now() + budgetMs : Infinity;
    const markets = deps.marketsIn(sys).slice(0, marketsPerSystem);
    let scanned = 0;
    for (const m of markets) {
      if (shouldStop() || deps.now() >= scanDeadline) break;
      ship = await deps.travel(api, ship, m);
      try {
        await deps.scan(api, sys, m);
        scanned++;
      } catch (err) {
        log.debug(`${ship.symbol} scan ${m} failed: ${(err as Error).message}`);
      }
    }
    log.info(`${ship.symbol} scouted ${sys}: ${scanned} market(s)`);
    scannedSystems++;
  }

  // Head home so the probe is positioned to scan the local cluster next round.
  ship = await deps.crossTravel(api, ship, homeGate);
  log.info(`${ship.symbol} remote scout done: ${scannedSystems} system(s)`);
  return { scannedSystems };
}

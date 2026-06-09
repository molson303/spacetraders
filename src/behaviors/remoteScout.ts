/*
 * Remote market scout. A fuel-free probe can't earn, but it can ride the jump
 * gates into directly-reachable neighbor systems and read their market prices
 * into the DB — the prerequisite for any cross-system arbitrage, since the API
 * only returns live prices when a ship is physically present at the market.
 *
 * Each invocation: ensure the home gate topology is known, pick neighbor
 * systems not yet scanned, and for each (within the limit / time budget) jump
 * over, hydrate its waypoints + gate, scan its marketplaces, then return home.
 *
 * Defensive: a probe has no fuel tank so it can't strand on fuel; the only risk
 * is a failed jump (no antimatter / unhydrated topology), in which case the
 * system is skipped and the probe attempts to return home.
 */

import type { SpaceTradersApi } from '../client/api.js';
import { findJumpGatesBySystem, findWaypointsByTrait, getJumpGateRow } from '../state/repos.js';
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
  /** Time budget across the whole scout run. */
  budgetMs?: number;
  /** External stop signal checked between systems. */
  shouldStop?: () => boolean;
}

/** A neighbor system already has captured market structures/prices. */
function isScanned(system: string): boolean {
  return Boolean(kvGet<boolean>(`market_structures:${system}`)) ||
    Boolean(kvGet<boolean>(`system_scanned:${system}`));
}

/**
 * Scout unscanned neighbor systems, capturing their market prices. Returns how
 * many neighbor systems were scanned this run.
 */
export async function runRemoteScout(
  api: SpaceTradersApi,
  ship: Ship,
  homeSystem: string,
  opts: RemoteScoutOptions = {},
): Promise<{ scannedSystems: number }> {
  const maxSystems = opts.maxSystems ?? 2;
  const marketsPerSystem = opts.marketsPerSystem ?? 6;
  const deadline = opts.budgetMs && opts.budgetMs > 0 ? Date.now() + opts.budgetMs : Infinity;
  const stop = (): boolean => (opts.shouldStop?.() ?? false) || Date.now() >= deadline;

  await hydrateJumpGates(api, homeSystem);
  const homeGate = findJumpGatesBySystem(homeSystem)[0];
  if (!homeGate) {
    log.warn(`no jump gate known in ${homeSystem}; cannot scout`);
    return { scannedSystems: 0 };
  }

  const neighbors = (g: string): string[] => getJumpGateRow(g)?.connections ?? [];
  const targets = pickScoutTargets(homeGate.symbol, neighbors, systemOf, isScanned).slice(0, maxSystems);
  if (targets.length === 0) {
    log.info(`all neighbors of ${homeSystem} already scanned`);
    return { scannedSystems: 0 };
  }
  log.info(`${ship.symbol} scouting ${targets.length} neighbor system(s): [${targets.join(', ')}]`);

  let scannedSystems = 0;
  for (const sys of targets) {
    if (stop()) break;
    const gateThere = neighbors(homeGate.symbol).find((c) => systemOf(c) === sys);
    if (!gateThere) continue;

    ship = await crossSystemTravelTo(api, ship, gateThere);
    if (ship.nav.systemSymbol !== sys) {
      log.warn(`${ship.symbol} failed to reach ${sys}; skipping`);
      continue;
    }

    await hydrateSystemWaypoints(api, sys);
    await hydrateJumpGates(api, sys);

    const markets = findWaypointsByTrait(sys, 'MARKETPLACE').slice(0, marketsPerSystem);
    let scanned = 0;
    for (const m of markets) {
      if (stop()) break;
      ship = await travelTo(api, ship, m.symbol);
      try {
        await scanMarket(api, sys, m.symbol);
        scanned++;
      } catch (err) {
        log.debug(`${ship.symbol} scan ${m.symbol} failed: ${(err as Error).message}`);
      }
    }
    log.info(`${ship.symbol} scouted ${sys}: ${scanned} market(s)`);
    scannedSystems++;
  }

  // Head home so the probe is positioned to scan the local cluster next round.
  ship = await crossSystemTravelTo(api, ship, homeGate.symbol);
  log.info(`${ship.symbol} remote scout done: ${scannedSystems} system(s)`);
  return { scannedSystems };
}

/*
 * Hydrate every neighbor system one jump from the home gate into the local DB:
 * waypoint rows (so their marketplaces become station-candidate-eligible) plus
 * public market structures (imports/exports — no ship presence required, so the
 * trade graph lights up for route-finding before any probe arrives). Live prices
 * are still captured later when a stationed probe is relocated there and scans.
 *
 * This is the fast unlock for cross-system coverage: `gatherStationMarkets` only
 * sees a neighbor's markets once its waypoints are in the DB, and `runRemoteScout`
 * hydrates them only slowly (fuel-free probes, a couple systems per loop). Running
 * this once expands the station-candidate pool to all one-hop neighbors at once.
 *
 * Safe to run alongside the live fleet: the DB is WAL-mode (busy_timeout 5s), so
 * these writes land in the shared WAL and the running process picks them up.
 */
import { SpaceTradersApi } from '../client/api.js';
import { closeDb } from '../state/db.js';
import {
  hydrateJumpGates,
  hydrateMarketStructures,
  hydrateSystemWaypoints,
  systemOf,
} from '../state/world.js';
import { findJumpGatesBySystem, findWaypointsByTrait, getJumpGateRow } from '../state/repos.js';
import { directNeighborSystems } from '../util/jumpPath.js';
import { log } from '../util/logger.js';

async function main(): Promise<void> {
  const api = new SpaceTradersApi();
  const agent = await api.getMyAgent();
  const homeSystem = systemOf(agent.headquarters);

  // Ensure the home gate + its connections are known before we read them.
  await hydrateJumpGates(api, homeSystem);
  const homeGate = findJumpGatesBySystem(homeSystem)[0];
  if (!homeGate) {
    log.error(`no jump gate known in ${homeSystem}; cannot hydrate neighbors`);
    closeDb();
    process.exitCode = 1;
    return;
  }

  const neighbors = directNeighborSystems(
    homeGate.symbol,
    (g) => getJumpGateRow(g)?.connections ?? [],
    systemOf,
  );
  log.info(`home gate ${homeGate.symbol} -> ${neighbors.length} neighbor system(s): [${neighbors.join(', ')}]`);

  for (const sys of neighbors) {
    try {
      await hydrateSystemWaypoints(api, sys, true);
      await hydrateMarketStructures(api, sys, true);
      const markets = findWaypointsByTrait(sys, 'MARKETPLACE');
      log.info(`${sys}: ${markets.length} marketplace(s) hydrated`);
    } catch (err) {
      log.error(`failed to hydrate ${sys}: ${(err as Error).message}`);
    }
  }

  // Report the resulting station-candidate pool size across home + neighbors.
  let total = findWaypointsByTrait(homeSystem, 'MARKETPLACE').length;
  for (const sys of neighbors) total += findWaypointsByTrait(sys, 'MARKETPLACE').length;
  log.info(`station-candidate pool now spans ${total} marketplace(s) across ${neighbors.length + 1} system(s)`);

  closeDb();
  log.info('neighbor hydration complete');
}

main().catch((err) => {
  log.error('neighbor hydration failed', err);
  process.exitCode = 1;
});

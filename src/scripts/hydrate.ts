/* Hydrate world state: ships, contracts, home-system waypoints, and key markets. */
import { SpaceTradersApi } from '../client/api.js';
import { closeDb } from '../state/db.js';
import {
  hydrateContracts,
  hydrateShips,
  hydrateSystemWaypoints,
  systemOf,
} from '../state/world.js';
import { findWaypointsByTrait, findWaypointsByType } from '../state/repos.js';
import { log } from '../util/logger.js';

async function main(): Promise<void> {
  const api = new SpaceTradersApi();

  const agent = await api.getMyAgent();
  const homeSystem = systemOf(agent.headquarters);
  log.info(`agent ${agent.symbol} credits=${agent.credits} home=${homeSystem}`);

  await hydrateShips(api);
  await hydrateContracts(api);
  await hydrateSystemWaypoints(api, homeSystem, true);

  const markets = findWaypointsByTrait(homeSystem, 'MARKETPLACE');
  const shipyards = findWaypointsByTrait(homeSystem, 'SHIPYARD');
  const engineered = findWaypointsByType(homeSystem, 'ENGINEERED_ASTEROID');
  const asteroids = findWaypointsByType(homeSystem, 'ASTEROID');

  log.info(`markets: ${markets.length} -> ${markets.map((m) => m.symbol).join(', ')}`);
  log.info(`shipyards: ${shipyards.length} -> ${shipyards.map((s) => s.symbol).join(', ')}`);
  log.info(`engineered asteroids: ${engineered.map((e) => e.symbol).join(', ')}`);
  log.info(`asteroids: ${asteroids.length}`);

  closeDb();
  log.info('hydration complete');
}

main().catch((err) => {
  log.error('hydration failed', err);
  process.exitCode = 1;
});

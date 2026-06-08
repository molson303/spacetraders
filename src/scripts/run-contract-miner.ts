/*
 * Contract-miner driver: accept the best contract, mine its procurement good at
 * the engineered asteroid (selling other ore as we go), deliver, fulfill, then
 * negotiate the next contract. This is the bootstrap money loop.
 */
import { SpaceTradersApi } from '../client/api.js';
import { closeDb } from '../state/db.js';
import { findWaypointsByType } from '../state/repos.js';
import {
  hydrateContracts,
  hydrateShips,
  hydrateSystemWaypoints,
  systemOf,
} from '../state/world.js';
import {
  acceptIfNeeded,
  deliverFromShip,
  pickBestContract,
  procurementGood,
  remainingNeed,
} from '../behaviors/contract.js';
import { mine } from '../behaviors/miner.js';
import { navigateTo } from '../util/nav.js';
import { log } from '../util/logger.js';
import type { Contract, Ship } from '../types/index.js';

const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS ?? 50);

async function main(): Promise<void> {
  const api = new SpaceTradersApi();

  const agent = await api.getMyAgent();
  const system = systemOf(agent.headquarters);
  log.info(`starting contract-miner | agent=${agent.symbol} credits=${agent.credits} system=${system}`);

  const ships = await hydrateShips(api);
  await hydrateContracts(api);
  await hydrateSystemWaypoints(api, system);

  // Use the command frigate (has mining + survey mounts).
  let ship = ships.find((s) => s.registration.role === 'COMMAND') ?? ships[0];
  if (!ship) throw new Error('no ship available');
  log.info(`using ship ${ship.symbol} (${ship.frame.symbol})`);

  // Choose a mining waypoint: prefer an engineered asteroid.
  const engineered = findWaypointsByType(system, 'ENGINEERED_ASTEROID');
  const asteroids = findWaypointsByType(system, 'ASTEROID');
  const mineWaypoint = engineered[0]?.symbol ?? asteroids[0]?.symbol;
  if (!mineWaypoint) throw new Error('no asteroid to mine in system');
  log.info(`mining site: ${mineWaypoint}`);

  let contracts = await hydrateContracts(api);
  let contract: Contract | undefined = pickBestContract(contracts);

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (!contract) {
      log.info('no active contract; negotiating a new one');
      // Must be docked at a faction-controlled waypoint to negotiate.
      ship = await navigateTo(api, ship, ship.nav.waypointSymbol);
      try {
        const res = await api.negotiateContract(ship.symbol);
        contract = res.contract;
        log.info(`negotiated contract ${contract.id}`);
      } catch (err) {
        log.warn(`negotiate failed: ${(err as Error).message}; stopping`);
        break;
      }
    }

    contract = await acceptIfNeeded(api, contract);
    const good = procurementGood(contract);
    if (!good) {
      log.warn(`contract ${contract.id} is not a procurement contract; skipping`);
      break;
    }

    const need = remainingNeed(contract, good);
    if (need <= 0) {
      const result = await deliverFromShip(api, ship, contract);
      ship = result.ship;
      contract = result.fulfilled ? undefined : result.contract;
      continue;
    }

    log.info(`contract ${contract.id}: need ${need} more ${good}`);

    // Go mine the good.
    ship = await navigateTo(api, ship, mineWaypoint);
    const target = Math.min(need, ship.cargo.capacity);
    ship = await mine(api, ship, {
      reserve: new Set([good]),
      sellHere: true,
      survey: true,
      targetReservedUnits: target,
    });

    // Deliver whatever we gathered.
    const result = await deliverFromShip(api, ship, contract);
    ship = result.ship;
    if (result.fulfilled) {
      contract = undefined; // will negotiate next
    } else {
      contract = result.contract;
    }

    const a = await api.getMyAgent();
    log.info(`iteration ${iter} done | credits=${a.credits}`);
  }

  const final = await api.getMyAgent();
  log.info(`contract-miner finished | credits=${final.credits}`);
  closeDb();
}

main().catch((err) => {
  log.error('contract-miner failed', err);
  process.exitCode = 1;
});

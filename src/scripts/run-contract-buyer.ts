/*
 * Contract-buyer driver: accept the best procurement contract, buy its goods at
 * the cheapest exporter market, haul to the delivery destination, and fulfill.
 * Far faster than mining for goods available on the open market.
 */
import { SpaceTradersApi } from '../client/api.js';
import { closeDb } from '../state/db.js';
import { findExporters, getWaypointRow } from '../state/repos.js';
import {
  hydrateContracts,
  hydrateMarketStructures,
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
import { buyGoodHere, clearCargoExcept } from '../behaviors/buyer.js';
import { cargoUnitsOf } from '../behaviors/trade.js';
import { distance, navigateTo, travelTo } from '../util/nav.js';
import { log } from '../util/logger.js';
import type { Contract } from '../types/index.js';

const MAX_CONTRACTS = Number(process.env.MAX_CONTRACTS ?? 1);

function nearestExporter(system: string, good: string, from: string): string | undefined {
  const exporters = findExporters(system, good);
  const origin = getWaypointRow(from);
  if (!origin) return exporters[0];
  return exporters
    .map((sym) => ({ sym, wp: getWaypointRow(sym) }))
    .filter((e) => e.wp)
    .sort((a, b) => distance(origin, a.wp!) - distance(origin, b.wp!))[0]?.sym;
}

async function main(): Promise<void> {
  const api = new SpaceTradersApi();
  const agent = await api.getMyAgent();
  const system = systemOf(agent.headquarters);
  log.info(`contract-buyer start | credits=${agent.credits} system=${system}`);

  const ships = await hydrateShips(api);
  await hydrateSystemWaypoints(api, system);
  await hydrateMarketStructures(api, system);

  let ship = ships.find((s) => s.registration.role === 'COMMAND') ?? ships[0];
  if (!ship) throw new Error('no ship available');
  log.info(`using ship ${ship.symbol} cargo=${ship.cargo.capacity}`);

  let completed = 0;
  let contract: Contract | undefined = pickBestContract(await hydrateContracts(api));

  while (completed < MAX_CONTRACTS) {
    if (!contract) {
      log.info('negotiating new contract');
      ship = await navigateTo(api, ship, ship.nav.waypointSymbol);
      await api.dockShip(ship.symbol).catch(() => undefined);
      try {
        contract = (await api.negotiateContract(ship.symbol)).contract;
      } catch (err) {
        log.warn(`negotiate failed: ${(err as Error).message}`);
        break;
      }
    }

    contract = await acceptIfNeeded(api, contract);
    const good = procurementGood(contract);
    if (!good) {
      log.warn('non-procurement contract; stopping');
      break;
    }

    const payoutPerUnit =
      contract.terms.payment.onFulfilled /
      Math.max(1, (contract.terms.deliver ?? []).reduce((s, d) => s + d.unitsRequired, 0));

    // Drop any non-contract cargo so we can carry a full load of the good.
    ship = await clearCargoExcept(api, ship, good);

    // Buy + deliver until all terms satisfied.
    for (let guard = 0; guard < 50; guard++) {
      const need = remainingNeed(contract, good);
      if (need <= 0) break;

      // Deliver anything we're already carrying before sourcing more.
      if (cargoUnitsOf(ship, good) > 0) {
        const deliver = await deliverFromShip(api, ship, contract);
        ship = deliver.ship;
        contract = deliver.contract;
        if (deliver.fulfilled) break;
        continue;
      }

      const source = nearestExporter(system, good, ship.nav.waypointSymbol);
      if (!source) {
        log.error(`no exporter of ${good} found in ${system}; cannot fulfill`);
        return;
      }

      ship = await travelTo(api, ship, source);
      const buyQty = Math.min(need, ship.cargo.capacity - ship.cargo.units);
      const res = await buyGoodHere(api, ship, good, buyQty, {
        maxPricePerUnit: Math.floor(payoutPerUnit * 0.9),
      });
      ship = res.ship;
      if (res.unitsBought === 0) {
        log.error(`could not buy ${good} at ${source}; aborting contract loop`);
        return;
      }
      // Next iteration delivers the load.
    }

    if (contract.fulfilled) {
      completed++;
      const a = await api.getMyAgent();
      log.info(`contract complete (${completed}/${MAX_CONTRACTS}) | credits=${a.credits}`);
      contract = undefined;
    } else {
      break;
    }
  }

  const final = await api.getMyAgent();
  log.info(`contract-buyer done | credits=${final.credits}`);
  closeDb();
}

main().catch((err) => {
  log.error('contract-buyer failed', err);
  process.exitCode = 1;
});

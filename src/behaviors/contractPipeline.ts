import type { SpaceTradersApi } from '../client/api.js';
import { findExporters, getWaypointRow } from '../state/repos.js';
import { distance, travelTo } from '../util/nav.js';
import { createLogger } from '../util/logger.js';
import {
  acceptIfNeeded,
  deliverFromShip,
  procurementGood,
  remainingNeed,
} from './contract.js';
import { buyGoodHere, clearCargoExcept } from './buyer.js';
import { cargoUnitsOf } from './trade.js';
import type { Contract, Ship } from '../types/index.js';

const log = createLogger('pipeline');

/** Nearest exporter market of `good` to `from`, by Euclidean distance. */
export function nearestExporter(
  system: string,
  good: string,
  from: string,
): string | undefined {
  const exporters = findExporters(system, good);
  const origin = getWaypointRow(from);
  if (!origin) return exporters[0];
  return exporters
    .map((sym) => ({ sym, wp: getWaypointRow(sym) }))
    .filter((e) => e.wp)
    .sort((a, b) => distance(origin, a.wp!) - distance(origin, b.wp!))[0]?.sym;
}

export interface PipelineOptions {
  /** How many contracts this ship should complete before stopping. */
  maxContracts?: number;
  /** Shared set of contract ids already claimed by other ships. */
  claimed?: Set<string>;
  /** HQ / marketplace waypoint to fall back to for negotiation. */
  hq?: string;
}

/**
 * Drive a single ship through procurement contracts: claim or negotiate a
 * contract, buy the required good at the cheapest exporter, haul it to the
 * delivery destination, and fulfill — repeating until `maxContracts` are done.
 * Designed to run concurrently for multiple ships; `claimed` prevents two ships
 * from working the same contract.
 */
export async function runContractPipeline(
  api: SpaceTradersApi,
  ship: Ship,
  system: string,
  opts: PipelineOptions = {},
): Promise<number> {
  const maxContracts = opts.maxContracts ?? 1;
  const claimed = opts.claimed ?? new Set<string>();
  let completed = 0;

  while (completed < maxContracts) {
    // 1. Find an unclaimed, workable contract or negotiate a new one.
    let contract = await claimOrNegotiate(api, ship, claimed, opts.hq);
    if (!contract) {
      log.warn(`${ship.symbol} no contract available; stopping`);
      break;
    }

    contract = await acceptIfNeeded(api, contract);
    const good = procurementGood(contract);
    if (!good) {
      log.warn(`${ship.symbol} contract ${contract.id} is not procurement; skipping`);
      claimed.delete(contract.id);
      break;
    }

    const totalUnits = (contract.terms.deliver ?? []).reduce((s, d) => s + d.unitsRequired, 0);
    const payoutPerUnit = contract.terms.payment.onFulfilled / Math.max(1, totalUnits);

    // 2. Buy + deliver until satisfied.
    ship = await clearCargoExcept(api, ship, good);
    for (let guard = 0; guard < 80; guard++) {
      const need = remainingNeed(contract, good);
      if (need <= 0) break;

      if (cargoUnitsOf(ship, good) > 0) {
        const d = await deliverFromShip(api, ship, contract);
        ship = d.ship;
        contract = d.contract;
        if (d.fulfilled) break;
        continue;
      }

      const source = nearestExporter(system, good, ship.nav.waypointSymbol);
      if (!source) {
        log.error(`${ship.symbol} no exporter of ${good} in ${system}; abandoning contract`);
        break;
      }
      ship = await travelTo(api, ship, source);
      const buyQty = Math.min(need, ship.cargo.capacity - ship.cargo.units);
      const res = await buyGoodHere(api, ship, good, buyQty, {
        maxPricePerUnit: Math.floor(payoutPerUnit * 0.9),
      });
      ship = res.ship;
      if (res.unitsBought === 0) {
        log.error(`${ship.symbol} could not buy ${good} at ${source}; abandoning contract`);
        break;
      }
    }

    if (contract.fulfilled) {
      completed++;
      claimed.delete(contract.id);
      const a = await api.getMyAgent();
      log.info(`${ship.symbol} contract complete (${completed}/${maxContracts}) | credits=${a.credits}`);
    } else {
      // Couldn't finish (e.g. price cap or no exporter); release and stop.
      claimed.delete(contract.id);
      break;
    }
  }

  return completed;
}

/**
 * Claim an existing unclaimed, unfulfilled contract, or negotiate a fresh one.
 * Mutates `claimed` to reserve the chosen contract for this ship.
 */
async function claimOrNegotiate(
  api: SpaceTradersApi,
  ship: Ship,
  claimed: Set<string>,
  hq?: string,
): Promise<Contract | undefined> {
  const now = Date.now();
  const existing = (await api.listContracts()).data
    .filter((c) => !c.fulfilled && !claimed.has(c.id))
    .filter((c) => new Date(c.terms.deadline).getTime() > now)
    .filter((c) => procurementGood(c))
    .sort(
      (a, b) =>
        b.terms.payment.onAccepted +
        b.terms.payment.onFulfilled -
        (a.terms.payment.onAccepted + a.terms.payment.onFulfilled),
    );

  if (existing.length > 0) {
    const c = existing[0]!;
    claimed.add(c.id);
    log.info(`${ship.symbol} claimed existing contract ${c.id}`);
    return c;
  }

  // Negotiate a new one — ship must be docked, ideally at a marketplace/HQ.
  try {
    await api.dockShip(ship.symbol).catch(() => undefined);
    const { contract } = await api.negotiateContract(ship.symbol);
    claimed.add(contract.id);
    log.info(`${ship.symbol} negotiated new contract ${contract.id}`);
    return contract;
  } catch (err) {
    log.warn(`${ship.symbol} negotiate failed at ${ship.nav.waypointSymbol}: ${(err as Error).message}`);
    if (hq && ship.nav.waypointSymbol !== hq) {
      ship = await travelTo(api, ship, hq);
      await api.dockShip(ship.symbol).catch(() => undefined);
      try {
        const { contract } = await api.negotiateContract(ship.symbol);
        claimed.add(contract.id);
        log.info(`${ship.symbol} negotiated new contract ${contract.id} at HQ`);
        return contract;
      } catch (err2) {
        log.warn(`${ship.symbol} negotiate at HQ failed: ${(err2 as Error).message}`);
      }
    }
    return undefined;
  }
}

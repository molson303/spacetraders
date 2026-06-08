import type { SpaceTradersApi } from '../client/api.js';
import { travelTo } from '../util/nav.js';
import { recordTransaction, upsertContract } from '../state/repos.js';
import type { Contract, Ship } from '../types/index.js';
import { createLogger } from '../util/logger.js';
import { cargoUnitsOf } from './trade.js';

const log = createLogger('contract');

/** Pick the most valuable not-yet-fulfilled contract. */
export function pickBestContract(contracts: Contract[]): Contract | undefined {
  return contracts
    .filter((c) => !c.fulfilled)
    .filter((c) => new Date(c.terms.deadline).getTime() > Date.now())
    .sort(
      (a, b) =>
        b.terms.payment.onAccepted +
        b.terms.payment.onFulfilled -
        (a.terms.payment.onAccepted + a.terms.payment.onFulfilled),
    )[0];
}

export async function acceptIfNeeded(api: SpaceTradersApi, contract: Contract): Promise<Contract> {
  if (contract.accepted) return contract;
  const res = await api.acceptContract(contract.id);
  upsertContract(res.contract);
  recordTransaction({
    kind: 'CONTRACT_ACCEPT',
    total: res.contract.terms.payment.onAccepted,
    creditsAfter: res.agent.credits,
  });
  log.info(
    `accepted contract ${contract.id} (+${res.contract.terms.payment.onAccepted}, credits=${res.agent.credits})`,
  );
  return res.contract;
}

export interface DeliverResult {
  ship: Ship;
  contract: Contract;
  fulfilled: boolean;
}

/**
 * For a PROCUREMENT contract, deliver any matching goods currently in the
 * ship's cargo, navigating to each delivery destination as needed. Fulfills
 * the contract automatically once all terms are met.
 */
export async function deliverFromShip(
  api: SpaceTradersApi,
  ship: Ship,
  contract: Contract,
): Promise<DeliverResult> {
  const deliver = contract.terms.deliver ?? [];
  for (const term of deliver) {
    const remaining = term.unitsRequired - term.unitsFulfilled;
    if (remaining <= 0) continue;
    const have = cargoUnitsOf(ship, term.tradeSymbol);
    if (have <= 0) continue;

    const units = Math.min(have, remaining);
    ship = await travelTo(api, ship, term.destinationSymbol);
    // Must be docked to deliver.
    if (ship.nav.status !== 'DOCKED') {
      const { nav } = await api.dockShip(ship.symbol);
      ship.nav = nav;
    }
    const res = await api.deliverContract(contract.id, ship.symbol, term.tradeSymbol, units);
    ship.cargo = res.cargo;
    contract = res.contract;
    upsertContract(contract);
    recordTransaction({
      ship: ship.symbol,
      kind: 'CONTRACT_DELIVER',
      waypoint: term.destinationSymbol,
      tradeSymbol: term.tradeSymbol,
      units,
    });
    log.info(`${ship.symbol} delivered ${units} ${term.tradeSymbol} to ${term.destinationSymbol}`);
  }

  const allDone = (contract.terms.deliver ?? []).every(
    (d) => d.unitsFulfilled >= d.unitsRequired,
  );
  let fulfilled = false;
  if (allDone && !contract.fulfilled) {
    const res = await api.fulfillContract(contract.id);
    contract = res.contract;
    upsertContract(contract);
    fulfilled = true;
    recordTransaction({
      kind: 'CONTRACT_FULFILL',
      total: contract.terms.payment.onFulfilled,
      creditsAfter: res.agent.credits,
    });
    log.info(
      `fulfilled contract ${contract.id} (+${contract.terms.payment.onFulfilled}, credits=${res.agent.credits})`,
    );
  }
  return { ship, contract, fulfilled };
}

/** Total still-needed units for a given trade symbol across delivery terms. */
export function remainingNeed(contract: Contract, tradeSymbol: string): number {
  return (contract.terms.deliver ?? [])
    .filter((d) => d.tradeSymbol === tradeSymbol)
    .reduce((sum, d) => sum + Math.max(0, d.unitsRequired - d.unitsFulfilled), 0);
}

/** The single procurement good a contract wants (first deliver term), if any. */
export function procurementGood(contract: Contract): string | undefined {
  return contract.terms.deliver?.[0]?.tradeSymbol;
}

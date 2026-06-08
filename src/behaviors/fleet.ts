import type { SpaceTradersApi } from '../client/api.js';
import { travelTo } from '../util/nav.js';
import { recordTransaction, upsertShip } from '../state/repos.js';
import type { Ship, ShipType } from '../types/index.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('fleet');

export interface PurchaseResult {
  ship?: Ship;
  credits: number;
  spent: number;
}

/**
 * Purchase a ship of `shipType` at the given shipyard waypoint. A ship of ours
 * must be present at the shipyard for the purchase to succeed, so callers
 * should route a ship there first (or pass `scout` to move one). Returns the
 * newly purchased ship persisted to the DB.
 */
export async function purchaseShipAt(
  api: SpaceTradersApi,
  shipType: ShipType,
  shipyard: string,
  opts: { scout?: Ship; maxPrice?: number } = {},
): Promise<PurchaseResult> {
  // Ensure a ship is present at the shipyard to unlock the purchase.
  if (opts.scout && opts.scout.nav.waypointSymbol !== shipyard) {
    await travelTo(api, opts.scout, shipyard);
  }

  const agent = await api.getMyAgent();
  if (opts.maxPrice && agent.credits < opts.maxPrice) {
    log.warn(`insufficient credits ${agent.credits} < ${opts.maxPrice} for ${shipType}`);
    return { credits: agent.credits, spent: 0 };
  }

  try {
    const res = await api.purchaseShip(shipType, shipyard);
    upsertShip(res.ship);
    const txn = res.transaction as { price?: number } | undefined;
    const spent = txn?.price ?? 0;
    recordTransaction({
      ship: res.ship.symbol,
      kind: 'BUY_SHIP',
      waypoint: shipyard,
      total: spent ? -spent : undefined,
      creditsAfter: res.agent.credits,
    });
    log.info(
      `purchased ${shipType} -> ${res.ship.symbol} for ${spent} (credits=${res.agent.credits})`,
    );
    return { ship: res.ship, credits: res.agent.credits, spent };
  } catch (err) {
    log.error(`purchase ${shipType} at ${shipyard} failed: ${(err as Error).message}`);
    return { credits: agent.credits, spent: 0 };
  }
}

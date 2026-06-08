import type { SpaceTradersApi } from '../client/api.js';
import { ensureDocked } from '../util/nav.js';
import { recordTransaction, upsertMarket } from '../state/repos.js';
import type { Market, Ship } from '../types/index.js';
import { createLogger } from '../util/logger.js';
import { keepBuying, planChunks } from '../util/depth.js';

const log = createLogger('buyer');

export interface BuyResult {
  ship: Ship;
  unitsBought: number;
  spent: number;
  credits?: number;
}

/**
 * Buy up to `maxUnits` of a good at the ship's current waypoint market.
 * Respects per-good trade volume (chunking) and an optional max unit price.
 * The price cap is re-checked against the *realized* per-unit price after every
 * chunk, so buying stops automatically once the market is pushed past the cap
 * (depth-aware): buying drives the purchase price up. The ship must already be
 * at the market waypoint.
 */
export async function buyGoodHere(
  api: SpaceTradersApi,
  ship: Ship,
  good: string,
  maxUnits: number,
  opts: { maxPricePerUnit?: number } = {},
): Promise<BuyResult> {
  const system = ship.nav.systemSymbol;
  const waypoint = ship.nav.waypointSymbol;

  let market: Market;
  try {
    market = await api.getMarket(system, waypoint);
  } catch (err) {
    log.warn(`${ship.symbol} no market at ${waypoint}: ${(err as Error).message}`);
    return { ship, unitsBought: 0, spent: 0 };
  }
  upsertMarket(system, market);

  const tg = market.tradeGoods?.find((g) => g.symbol === good);
  if (!tg) {
    log.warn(`${ship.symbol}: ${good} not sold at ${waypoint}`);
    return { ship, unitsBought: 0, spent: 0 };
  }
  if (opts.maxPricePerUnit && tg.purchasePrice > opts.maxPricePerUnit) {
    log.warn(
      `${ship.symbol}: ${good} price ${tg.purchasePrice} exceeds cap ${opts.maxPricePerUnit}; skipping`,
    );
    return { ship, unitsBought: 0, spent: 0 };
  }

  ship = await ensureDocked(api, ship);

  const freeSpace = ship.cargo.capacity - ship.cargo.units;
  const target = Math.min(maxUnits, freeSpace);
  const chunks = planChunks(target, tg.tradeVolume);
  const ceiling = opts.maxPricePerUnit;

  let unitsBought = 0;
  let spent = 0;
  let credits: number | undefined;
  for (const units of chunks) {
    try {
      const res = await api.purchaseCargo(ship.symbol, good, units);
      ship.cargo = res.cargo;
      unitsBought += units;
      spent += res.transaction.totalPrice;
      credits = res.agent.credits;
      recordTransaction({
        ship: ship.symbol,
        kind: 'BUY_CARGO',
        waypoint,
        tradeSymbol: good,
        units,
        pricePer: res.transaction.pricePerUnit,
        total: -res.transaction.totalPrice,
        creditsAfter: res.agent.credits,
      });
      // Depth-aware: each purchase pushes the price up. Stop before the next
      // chunk once the realized price has climbed past the cap.
      if (ceiling !== undefined && !keepBuying(res.transaction.pricePerUnit, ceiling)) {
        log.info(
          `${ship.symbol} stop buying ${good}: price ${res.transaction.pricePerUnit} exceeded cap ${ceiling} after ${unitsBought}u`,
        );
        break;
      }
    } catch (err) {
      log.warn(`${ship.symbol} buy ${good} failed: ${(err as Error).message}`);
      break;
    }
  }
  if (unitsBought > 0) {
    log.info(
      `${ship.symbol} bought ${unitsBought} ${good} at ${waypoint} for ${spent} (credits=${credits})`,
    );
  }
  return { ship, unitsBought, spent, credits };
}

/**
 * Free up cargo space by getting rid of every good except `keep`. Sells goods
 * the current market will buy (recording revenue) and jettisons the rest.
 * The ship is docked as a side effect when anything is sold.
 */
export async function clearCargoExcept(
  api: SpaceTradersApi,
  ship: Ship,
  keep: string,
): Promise<Ship> {
  const junk = ship.cargo.inventory.filter((i) => i.symbol !== keep && i.units > 0);
  if (junk.length === 0) return ship;

  const system = ship.nav.systemSymbol;
  const waypoint = ship.nav.waypointSymbol;
  let sellable = new Set<string>();
  try {
    const market = await api.getMarket(system, waypoint);
    upsertMarket(system, market);
    sellable = new Set((market.tradeGoods ?? []).map((g) => g.symbol));
  } catch {
    // no market here; everything gets jettisoned
  }

  for (const item of junk) {
    if (sellable.has(item.symbol)) {
      try {
        ship = await ensureDocked(api, ship);
        const res = await api.sellCargo(ship.symbol, item.symbol, item.units);
        ship.cargo = res.cargo;
        recordTransaction({
          ship: ship.symbol,
          kind: 'SELL_CARGO',
          waypoint,
          tradeSymbol: item.symbol,
          units: item.units,
          pricePer: res.transaction.pricePerUnit,
          total: res.transaction.totalPrice,
          creditsAfter: res.agent.credits,
        });
        log.info(`${ship.symbol} sold junk ${item.units} ${item.symbol} for ${res.transaction.totalPrice}`);
        continue;
      } catch (err) {
        log.warn(`${ship.symbol} sell ${item.symbol} failed: ${(err as Error).message}`);
      }
    }
    try {
      const res = await api.jettison(ship.symbol, item.symbol, item.units);
      ship.cargo = res.cargo;
      log.info(`${ship.symbol} jettisoned ${item.units} ${item.symbol}`);
    } catch (err) {
      log.warn(`${ship.symbol} jettison ${item.symbol} failed: ${(err as Error).message}`);
    }
  }
  return ship;
}

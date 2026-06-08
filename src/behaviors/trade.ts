import type { SpaceTradersApi } from '../client/api.js';
import { ensureDocked } from '../util/nav.js';
import { recordTransaction, upsertMarket } from '../state/repos.js';
import type { Market, Ship } from '../types/index.js';
import { createLogger } from '../util/logger.js';
import { keepSelling, planChunks } from '../util/depth.js';

const log = createLogger('trade');

/** Goods the local market will buy (imports + exchange). */
export function sellableHere(market: Market): Set<string> {
  const set = new Set<string>();
  for (const i of market.imports) set.add(i.symbol);
  for (const e of market.exchange) set.add(e.symbol);
  // tradeGoods is authoritative when present.
  if (market.tradeGoods) {
    for (const g of market.tradeGoods) {
      if (g.type === 'IMPORT' || g.type === 'EXCHANGE') set.add(g.symbol);
    }
  }
  return set;
}

export interface SellOptions {
  /** Symbols to never sell (e.g. contract deliverables held back). */
  reserve?: Set<string>;
  /**
   * Minimum acceptable realized sell price per good. Selling a good stops once a
   * chunk's realized price drops below its floor, leaving the rest in the hold
   * (depth-aware): dumping a full hold into one market craters the price.
   */
  floor?: (symbol: string) => number | undefined;
}

export interface SellResult {
  ship: Ship;
  earned: number;
  credits?: number;
  /** Units left unsold per good because the price fell below the floor. */
  unsold: Map<string, number>;
}

/**
 * Sell everything in the ship's cargo that the local market buys, except any
 * symbols in `reserve`. Sells in per-good `tradeVolume` chunks and, when a
 * `floor` is supplied, stops selling a good as soon as a chunk's realized price
 * falls below that good's floor. Requires the ship to be docked at a market
 * waypoint. Returns credits earned, latest agent credits, and any unsold units.
 */
export async function sellCargoHere(
  api: SpaceTradersApi,
  ship: Ship,
  opts: SellOptions = {},
): Promise<SellResult> {
  const reserve = opts.reserve ?? new Set<string>();
  const system = ship.nav.systemSymbol;
  const waypoint = ship.nav.waypointSymbol;
  const unsold = new Map<string, number>();

  let market: Market;
  try {
    market = await api.getMarket(system, waypoint);
  } catch (err) {
    log.debug(`${ship.symbol} no market at ${waypoint}: ${(err as Error).message}`);
    return { ship, earned: 0, unsold };
  }
  upsertMarket(system, market);

  const buyable = sellableHere(market);
  const toSell = ship.cargo.inventory.filter(
    (it) => it.units > 0 && buyable.has(it.symbol) && !reserve.has(it.symbol),
  );
  if (toSell.length === 0) return { ship, earned: 0, unsold };

  ship = await ensureDocked(api, ship);

  let earned = 0;
  let credits: number | undefined;
  for (const item of toSell) {
    const tg = market.tradeGoods?.find((g) => g.symbol === item.symbol);
    const floor = opts.floor?.(item.symbol);
    const chunks = planChunks(item.units, tg?.tradeVolume);
    let sold = 0;
    let stopped = false;
    for (const units of chunks) {
      try {
        const res = await api.sellCargo(ship.symbol, item.symbol, units);
        ship.cargo = res.cargo;
        earned += res.transaction.totalPrice;
        credits = res.agent.credits;
        sold += units;
        recordTransaction({
          ship: ship.symbol,
          kind: 'SELL_CARGO',
          waypoint,
          tradeSymbol: item.symbol,
          units,
          pricePer: res.transaction.pricePerUnit,
          total: res.transaction.totalPrice,
          creditsAfter: res.agent.credits,
        });
        // Depth-aware: each sale pushes the price down. Stop before the next
        // chunk once the realized price drops below this good's floor.
        if (floor !== undefined && !keepSelling(res.transaction.pricePerUnit, floor)) {
          stopped = true;
          break;
        }
      } catch (err) {
        log.warn(`${ship.symbol} sell ${item.symbol} failed: ${(err as Error).message}`);
        stopped = true;
        break;
      }
    }
    const remaining = item.units - sold;
    if (remaining > 0) {
      unsold.set(item.symbol, remaining);
      if (stopped) {
        log.info(
          `${ship.symbol} held ${remaining} ${item.symbol} at ${waypoint}: price below floor ${floor}`,
        );
      }
    }
  }
  if (earned > 0) {
    log.info(`${ship.symbol} sold cargo at ${waypoint} for ${earned} (credits=${credits})`);
  }
  return { ship, earned, credits, unsold };
}

export function cargoUnitsOf(ship: Ship, symbol: string): number {
  return ship.cargo.inventory.find((i) => i.symbol === symbol)?.units ?? 0;
}

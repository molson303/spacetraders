import type { SpaceTradersApi } from '../client/api.js';
import {
  findBestArbitrage,
  findUnpricedMarkets,
  getLatestPricesForGood,
  getWaypointRow,
  type ArbitrageRoute,
} from '../state/repos.js';
import { scanMarket } from '../state/world.js';
import { distance, travelTo } from '../util/nav.js';
import { bestSellMarket, buyCeiling, sellFloor } from '../util/depth.js';
import { createLogger } from '../util/logger.js';
import { buyGoodHere } from './buyer.js';
import { cargoUnitsOf, sellCargoHere } from './trade.js';
import type { Ship } from '../types/index.js';

const log = createLogger('trader');

export interface TraderOptions {
  /** Max buy->sell cycles to run before stopping. */
  cycles?: number;
  /** Minimum per-unit spread to bother trading. Covers fuel + slippage. */
  minProfit?: number;
}

/** Scan the market at the ship's current waypoint, capturing live prices. */
async function scanHere(api: SpaceTradersApi, ship: Ship): Promise<void> {
  try {
    await scanMarket(api, ship.nav.systemSymbol, ship.nav.waypointSymbol);
  } catch (err) {
    log.debug(`${ship.symbol} scan ${ship.nav.waypointSymbol} failed: ${(err as Error).message}`);
  }
}

/** Move to the nearest marketplace we have no prices for, and scan it. */
async function explore(api: SpaceTradersApi, ship: Ship, system: string): Promise<Ship | undefined> {
  const targets = findUnpricedMarkets(system);
  if (targets.length === 0) return undefined;
  const here = getWaypointRow(ship.nav.waypointSymbol);
  const next = here
    ? targets.sort((a, b) => distance(here, a) - distance(here, b))[0]!
    : targets[0]!;
  log.info(`${ship.symbol} exploring -> ${next.symbol} (gathering prices)`);
  ship = await travelTo(api, ship, next.symbol);
  await scanHere(api, ship);
  return ship;
}

/**
 * Run a single arbitrage cycle for `route`: travel to the buy market, fill the
 * hold (depth-aware — stop buying once the purchase price climbs past what the
 * target sell market can clear at a profit), haul to the sell market, and sell
 * in chunks down to a profit floor. Any cargo left when the primary market is
 * tapped out is offloaded at the next-best known market. Returns the ship and
 * realized profit (revenue - spend) for the cycle.
 */
async function runRoute(
  api: SpaceTradersApi,
  ship: Ship,
  route: ArbitrageRoute,
  minProfit: number,
): Promise<{ ship: Ship; profit: number }> {
  log.info(
    `${ship.symbol} arb ${route.good}: buy@${route.buyAt}(${route.buyPrice}) -> sell@${route.sellAt}(${route.sellPrice}) ~${route.profitPerUnit}/u`,
  );
  ship = await travelTo(api, ship, route.buyAt);
  const freeCargo = ship.cargo.capacity - ship.cargo.units;
  const buy = await buyGoodHere(api, ship, route.good, freeCargo, {
    // Depth-aware cap: never pay so much that the spread to the sell price
    // drops below our required margin (also bails if the price spiked).
    maxPricePerUnit: Math.min(
      Math.ceil(route.buyPrice * 1.15),
      buyCeiling(route.sellPrice, minProfit),
    ),
  });
  ship = buy.ship;
  if (buy.unitsBought === 0) {
    log.warn(`${ship.symbol} bought nothing for ${route.good}; skipping route`);
    return { ship, profit: 0 };
  }

  const avgCost = buy.spent / buy.unitsBought;
  const floor = sellFloor(avgCost, minProfit);

  ship = await travelTo(api, ship, route.sellAt);
  const sell = await sellCargoHere(api, ship, {
    floor: (sym) => (sym === route.good ? floor : undefined),
  });
  ship = sell.ship;
  let earned = sell.earned;

  // Depth-aware offload: if the primary market craters below the floor before
  // the hold is empty, haul the remainder to the next-best known market(s).
  const visited = new Set<string>([route.buyAt, route.sellAt]);
  let leftover = cargoUnitsOf(ship, route.good);
  while (leftover > 0) {
    const alt = bestSellMarket(
      getLatestPricesForGood(ship.nav.systemSymbol, route.good),
      visited,
      floor,
    );
    if (!alt) break;
    log.info(
      `${ship.symbol} offloading ${leftover} ${route.good} -> ${alt.waypoint} (sell~${alt.sellPrice})`,
    );
    ship = await travelTo(api, ship, alt.waypoint);
    visited.add(alt.waypoint);
    const more = await sellCargoHere(api, ship, {
      floor: (sym) => (sym === route.good ? floor : undefined),
    });
    ship = more.ship;
    earned += more.earned;
    const after = cargoUnitsOf(ship, route.good);
    if (after >= leftover) break; // sold nothing here; avoid looping
    leftover = after;
  }

  const profit = earned - buy.spent;
  if (leftover > 0) {
    log.warn(`${ship.symbol} carrying ${leftover} unsold ${route.good} (no market above floor ${floor})`);
  }
  log.info(
    `${ship.symbol} arb done ${route.good}: spent=${buy.spent} earned=${earned} profit=${profit}`,
  );
  return { ship, profit };
}

/**
 * Continuously run profitable buy-low/sell-high arbitrage for one hauler using
 * cached market prices. When no profitable route is known, the ship explores
 * unpriced markets to grow the price map, then retries. Returns total realized
 * profit across all cycles.
 */
export async function runTrader(
  api: SpaceTradersApi,
  ship: Ship,
  system: string,
  opts: TraderOptions = {},
): Promise<{ cycles: number; profit: number }> {
  const maxCycles = opts.cycles ?? 5;
  const minProfit = opts.minProfit ?? 20;
  let cycles = 0;
  let totalProfit = 0;

  await scanHere(api, ship);

  while (cycles < maxCycles) {
    const route = findBestArbitrage(system, minProfit);
    if (!route) {
      const explored = await explore(api, ship, system);
      if (!explored) {
        log.warn(`${ship.symbol} no arbitrage route and nothing left to explore; stopping`);
        break;
      }
      ship = explored;
      continue;
    }

    const res = await runRoute(api, ship, route, minProfit);
    ship = res.ship;
    totalProfit += res.profit;
    cycles++;
    if (res.profit <= 0) {
      // Price moved against us; re-evaluate after a fresh scan next loop.
      await scanHere(api, ship);
    }
  }

  log.info(`${ship.symbol} trader done: ${cycles} cycle(s), profit=${totalProfit}`);
  return { cycles, profit: totalProfit };
}

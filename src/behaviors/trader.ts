import type { SpaceTradersApi } from '../client/api.js';
import {
  findArbitrageRoutes,
  findUnpricedMarkets,
  getLatestPricesForGood,
  getWaypointRow,
  type ArbitrageRoute,
} from '../state/repos.js';
import { scanMarket } from '../state/world.js';
import { distance, travelTo } from '../util/nav.js';
import { bestSellMarket, buyCeiling, depthCappedBuyUnits, sellFloor, DEFAULT_SELL_DEPTH_MULTIPLE } from '../util/depth.js';
import { createLogger } from '../util/logger.js';
import { buyGoodHere } from './buyer.js';
import { cargoUnitsOf, sellCargoHere } from './trade.js';
import type { Ship } from '../types/index.js';

const log = createLogger('trader');

/**
 * How many sell-market depth "steps" we're willing to buy in one cycle. Buying
 * more than this strands cargo when the sell price degrades below the floor.
 */
const SELL_DEPTH_MULTIPLE = DEFAULT_SELL_DEPTH_MULTIPLE;

export interface TraderOptions {
  /** Max buy->sell cycles to run before stopping. */
  cycles?: number;
  /** Minimum per-unit spread to bother trading. Covers fuel + slippage. */
  minProfit?: number;
  /**
   * Good this trader was assigned by the orchestrator. The trader sticks to it
   * while it stays profitable so concurrent traders don't drain the same market.
   */
  assignedGood?: string;
  /** Goods claimed by sibling traders, avoided when falling back off-assignment. */
  avoidGoods?: string[];
}

/**
 * Choose this cycle's route from fresh prices. Prefers the trader's assigned
 * good while it still clears `minProfit`; otherwise falls back to the best route
 * whose good isn't claimed by a sibling trader (and only collides as a last
 * resort when every remaining route is already spoken for).
 */
function selectRoute(
  system: string,
  minProfit: number,
  assignedGood: string | undefined,
  avoidGoods: Set<string>,
): ArbitrageRoute | undefined {
  const routes = findArbitrageRoutes(system, minProfit, 30);
  if (routes.length === 0) return undefined;
  if (assignedGood) {
    const mine = routes.find((r) => r.good === assignedGood);
    if (mine) return mine;
  }
  return routes.find((r) => !avoidGoods.has(r.good)) ?? routes[0];
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
  // Don't buy more than the destination sell market can absorb near full price.
  // A full hold of a high-per-unit / thin-depth good strands cargo below the
  // floor (the -9 SHIP_PARTS trap); cap the buy to a few sell-market steps.
  const buyUnits = depthCappedBuyUnits(freeCargo, route.sellVolume, SELL_DEPTH_MULTIPLE);
  if (buyUnits < freeCargo) {
    log.info(
      `${ship.symbol} sell-depth cap ${route.good}: ${buyUnits}/${freeCargo} (sellVol=${route.sellVolume})`,
    );
  }
  const buy = await buyGoodHere(api, ship, route.good, buyUnits, {
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
  const assignedGood = opts.assignedGood;
  const avoidGoods = new Set(opts.avoidGoods ?? []);
  let cycles = 0;
  let totalProfit = 0;

  if (assignedGood) {
    log.info(`${ship.symbol} assigned good ${assignedGood}`);
  }
  await scanHere(api, ship);

  while (cycles < maxCycles) {
    const route = selectRoute(system, minProfit, assignedGood, avoidGoods);
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

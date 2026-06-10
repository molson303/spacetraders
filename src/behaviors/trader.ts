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
import { bestRouteFor, routeCreditsPerSecond } from '../util/routes.js';
import {
  bestSellMarket,
  buyCeiling,
  budgetCappedBuyUnits,
  depthCappedBuyUnits,
  sellFloor,
  strandedGoods,
  DEFAULT_SELL_DEPTH_MULTIPLE,
} from '../util/depth.js';
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
  /**
   * Max credits a single buy->sell cycle may spend on cargo. Bounds per-trade
   * capital at risk so one trader (with REINVEST off) can't sink the whole
   * wallet into a thin-sink position — a big fill craters the sink and strands
   * cargo below the profit floor. Undefined = no cap.
   *
   * May be a resolver `() => number | undefined` evaluated fresh each cycle so
   * the cap tracks the LIVE wallet rather than a stale round-start snapshot (a
   * frozen low cap otherwise locks traders out of high-value routes for the
   * whole round after a dip).
   */
  maxTradeSpend?: number | (() => number | undefined);
  /**
   * Cooperative stop signal checked before each cycle. Lets the orchestrator
   * time-box a round so one ship on long-leg routes can't keep the whole fleet
   * waiting; the in-flight cycle finishes but no new one starts.
   */
  shouldStop?: () => boolean;
}

/**
 * Choose this cycle's route from fresh prices. Prefers the trader's assigned
 * good while it still clears `minProfit`; otherwise falls back to the best route
 * whose good isn't claimed by a sibling trader. Candidates are ranked by
 * credits-per-second (profit-per-trip / round-trip travel time) — the same
 * throughput scorer the orchestrator uses for initial assignments — so far,
 * thin sinks that crater cr/s aren't re-picked each cycle (the J59 trap).
 */
function selectRoute(
  system: string,
  minProfit: number,
  assignedGood: string | undefined,
  avoidGoods: Set<string>,
  holdSize: number,
): ArbitrageRoute | undefined {
  const routes = findArbitrageRoutes(system, minProfit, 30);
  if (routes.length === 0) return undefined;
  const distanceOf = (from: string, to: string): number => {
    const a = getWaypointRow(from);
    const b = getWaypointRow(to);
    return a && b ? distance(a, b) : 0;
  };
  return bestRouteFor(routes, {
    holdSize,
    score: (r) => routeCreditsPerSecond(r, distanceOf, { holdSize }),
    assignedGood,
    avoid: avoidGoods,
  });
}


/** Scan the market at the ship's current waypoint, capturing live prices. */
export async function scanHere(api: SpaceTradersApi, ship: Ship): Promise<void> {
  try {
    await scanMarket(api, ship.nav.systemSymbol, ship.nav.waypointSymbol);
  } catch (err) {
    log.debug(`${ship.symbol} scan ${ship.nav.waypointSymbol} failed: ${(err as Error).message}`);
  }
}

/**
 * Liquidate any cargo the ship is already carrying before it starts a fresh
 * arbitrage run. Ships keep their hold across process restarts, so a hauler can
 * begin a round full of stale goods that don't match its assigned route — every
 * buy then silently no-ops (no free space) and the ship churns forever with its
 * capital frozen in cargo. We first try selling at the current market (free, no
 * travel), then route any remainder to the best known market for each good.
 * Goods with no known market are left in place. A ship that starts with an empty
 * hold (the healthy case) is a no-op.
 */
export async function drainStrandedCargo(
  api: SpaceTradersApi,
  ship: Ship,
  system: string,
): Promise<Ship> {
  if (strandedGoods(ship.cargo.inventory).length === 0) return ship;

  // Sell whatever the current market will buy first — no travel cost.
  const here = await sellCargoHere(api, ship);
  ship = here.ship;

  for (const item of strandedGoods(ship.cargo.inventory)) {
    const alt = bestSellMarket(getLatestPricesForGood(system, item.symbol), new Set(), 1);
    if (!alt) {
      log.warn(
        `${ship.symbol} stranded ${item.units} ${item.symbol}: no known market; holding`,
      );
      continue;
    }
    log.info(
      `${ship.symbol} liquidating stranded ${item.units} ${item.symbol} -> ${alt.waypoint} (sell~${alt.sellPrice})`,
    );
    ship = await travelTo(api, ship, alt.waypoint);
    const sold = await sellCargoHere(api, ship);
    ship = sold.ship;
  }
  return ship;
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
export async function runRoute(
  api: SpaceTradersApi,
  ship: Ship,
  route: ArbitrageRoute,
  minProfit: number,
  maxTradeSpend?: number | (() => number | undefined),
): Promise<{ ship: Ship; profit: number }> {
  log.info(
    `${ship.symbol} arb ${route.good}: buy@${route.buyAt}(${route.buyPrice}) -> sell@${route.sellAt}(${route.sellPrice}) ~${route.profitPerUnit}/u`,
  );
  ship = await travelTo(api, ship, route.buyAt);
  const freeCargo = ship.cargo.capacity - ship.cargo.units;
  // Don't buy more than the destination sell market can absorb near full price.
  // A full hold of a high-per-unit / thin-depth good strands cargo below the
  // floor (the -9 SHIP_PARTS trap); cap the buy to a few sell-market steps.
  const depthUnits = depthCappedBuyUnits(freeCargo, route.sellVolume, SELL_DEPTH_MULTIPLE);
  // Then bound the spend so one trade can't commit the whole wallet to a single
  // thin-sink position (the JEWELRY -75.8k / FOOD -46k saturation losses).
  // Resolve the cap fresh each cycle so it tracks the live wallet.
  const maxSpend = typeof maxTradeSpend === 'function' ? maxTradeSpend() : maxTradeSpend;
  const buyUnits = budgetCappedBuyUnits(depthUnits, route.buyPrice, maxSpend);
  if (buyUnits <= 0) {
    log.info(
      `${ship.symbol} budget cap ${route.good}: ~${route.buyPrice}/u exceeds per-trade budget ${maxSpend}; skipping route`,
    );
    return { ship, profit: 0 };
  }
  if (buyUnits < freeCargo) {
    log.info(
      `${ship.symbol} buy cap ${route.good}: ${buyUnits}/${freeCargo} (sellVol=${route.sellVolume}, maxSpend=${maxSpend ?? '∞'})`,
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
  const holdSize = ship.cargo.capacity;
  let cycles = 0;
  let totalProfit = 0;

  if (assignedGood) {
    log.info(`${ship.symbol} assigned good ${assignedGood}`);
  }
  await scanHere(api, ship);
  ship = await drainStrandedCargo(api, ship, system);

  while (cycles < maxCycles) {
    if (opts.shouldStop?.()) {
      log.info(`${ship.symbol} round time-box reached after ${cycles} cycle(s); stopping`);
      break;
    }
    const route = selectRoute(system, minProfit, assignedGood, avoidGoods, holdSize);
    if (!route) {
      const explored = await explore(api, ship, system);
      if (!explored) {
        log.warn(`${ship.symbol} no arbitrage route and nothing left to explore; stopping`);
        break;
      }
      ship = explored;
      continue;
    }

    const res = await runRoute(api, ship, route, minProfit, opts.maxTradeSpend);
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

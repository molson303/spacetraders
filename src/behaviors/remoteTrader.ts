/*
 * Cross-system arbitrage hauler. Identical economics to the local `trader` but
 * the legs are inter-system: buy in one system, jump gate-by-gate to another,
 * and sell. Reuses the depth-aware buy/sell primitives; only the travel calls
 * differ (`crossSystemTravelTo` handles the jump hops + intra-system nav).
 *
 * Defensive: if either endpoint can't be reached (gate topology not hydrated,
 * unreachable, or out of antimatter) the ship is left where it is and the cycle
 * returns zero profit rather than stranding on a half-finished trade.
 */

import type { SpaceTradersApi } from '../client/api.js';
import { getLatestPricesForGood } from '../state/repos.js';
import { buyCeiling, sellFloor, bestSellMarket } from '../util/depth.js';
import { createLogger } from '../util/logger.js';
import { crossSystemTravelTo } from '../util/crossNav.js';
import { buyGoodHere } from './buyer.js';
import { cargoUnitsOf, sellCargoHere } from './trade.js';
import type { CrossSystemRoute } from '../util/crossRoutes.js';
import type { Ship } from '../types/index.js';

const log = createLogger('remoteTrader');

/**
 * Run one cross-system arbitrage cycle for `route`: travel to the buy market
 * (possibly in another system), fill the hold depth-aware, haul across the gate
 * network to the sell market, and sell down to a profit floor, offloading any
 * remainder at the next-best market in the destination system. Returns the ship
 * and realized profit (revenue - spend).
 */
export async function runRemoteTrade(
  api: SpaceTradersApi,
  ship: Ship,
  route: CrossSystemRoute,
  minProfit: number,
): Promise<{ ship: Ship; profit: number }> {
  log.info(
    `${ship.symbol} xarb ${route.good}: buy@${route.buyAt}[${route.buySystem}](${route.buyPrice}) ` +
      `-> sell@${route.sellAt}[${route.sellSystem}](${route.sellPrice}) ~${route.profitPerUnit}/u`,
  );

  ship = await crossSystemTravelTo(api, ship, route.buyAt);
  if (ship.nav.waypointSymbol !== route.buyAt) {
    log.warn(`${ship.symbol} could not reach buy market ${route.buyAt}; skipping route`);
    return { ship, profit: 0 };
  }

  const freeCargo = ship.cargo.capacity - ship.cargo.units;
  const buy = await buyGoodHere(api, ship, route.good, freeCargo, {
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

  ship = await crossSystemTravelTo(api, ship, route.sellAt);
  if (ship.nav.waypointSymbol !== route.sellAt) {
    log.warn(
      `${ship.symbol} could not reach sell market ${route.sellAt} holding ${buy.unitsBought} ${route.good}`,
    );
    // Salvage: sell whatever we can wherever we ended up.
    const here = await sellCargoHere(api, ship, {
      floor: (sym) => (sym === route.good ? floor : undefined),
    });
    return { ship: here.ship, profit: here.earned - buy.spent };
  }

  const sell = await sellCargoHere(api, ship, {
    floor: (sym) => (sym === route.good ? floor : undefined),
  });
  ship = sell.ship;
  let earned = sell.earned;

  // Offload any remainder at the next-best market in the destination system.
  const visited = new Set<string>([route.sellAt]);
  let leftover = cargoUnitsOf(ship, route.good);
  while (leftover > 0) {
    const alt = bestSellMarket(
      getLatestPricesForGood(ship.nav.systemSymbol, route.good),
      visited,
      floor,
    );
    if (!alt) break;
    ship = await crossSystemTravelTo(api, ship, alt.waypoint);
    visited.add(alt.waypoint);
    const more = await sellCargoHere(api, ship, {
      floor: (sym) => (sym === route.good ? floor : undefined),
    });
    ship = more.ship;
    earned += more.earned;
    const after = cargoUnitsOf(ship, route.good);
    if (after >= leftover) break;
    leftover = after;
  }

  const profit = earned - buy.spent;
  if (leftover > 0) {
    log.warn(`${ship.symbol} carrying ${leftover} unsold ${route.good} (no market above floor ${floor})`);
  }
  log.info(`${ship.symbol} xarb done ${route.good}: spent=${buy.spent} earned=${earned} profit=${profit}`);
  return { ship, profit };
}

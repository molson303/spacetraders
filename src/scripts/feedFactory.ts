import 'dotenv/config';
import { SpaceTradersApi } from '../client/api.js';
import { closeDb } from '../state/db.js';
import { log } from '../util/logger.js';
import { navigateTo, ensureDocked } from '../util/nav.js';
import { systemOf } from '../state/world.js';
import { getLatestPrice, getLatestPricesForGood, recordPrices } from '../state/repos.js';
import { purchaseChunks } from '../fleet/gateSupply.js';
import { pickFeedInput, planFeedBatch, type FeedInputState } from '../fleet/factoryFeed.js';
import type { Market, Ship } from '../types/index.js';

/*
 * Factory-input feeder. Dedicates a single hauler (HAULER) to buy a factory's
 * starved inputs at their cheapest in-system source and sell them into the
 * factory, raising input supply so the factory produces more of its export and
 * the export's price collapses. Run alongside the continuous fleet with the
 * hauler listed in that process's EXCLUDE_SHIPS so they never fight over it.
 *
 * Each trip feeds the most-starved input (balancing both so a two-input recipe
 * like FAB_MATS <- IRON + QUARTZ_SAND keeps rising together) and logs the
 * factory's input + export supply/price so we can measure elasticity.
 *
 * Capital safety: never spends below FLOOR credits. Stops when the surplus above
 * the floor can't buy a single unit, or after MAX_TRIPS (validation cap).
 *
 * Env:
 *   HAULER          ship symbol to dedicate (required)
 *   FACTORY         factory waypoint (default X1-A20-F48)
 *   INPUTS          comma list of input goods (default IRON,QUARTZ_SAND)
 *   EXPORT_GOOD     export good to track for elasticity (default FAB_MATS)
 *   FLOOR           protected credit floor (default 450000)
 *   MAX_TRIPS       safety cap on feed trips (default 0 = unlimited)
 *   MIN_MARGIN      min per-unit feed margin to keep feeding an input (default 0);
 *                   feeding stops once factory-pay minus source-cost drops to this
 *   <GOOD>_SOURCE   optional source-waypoint override per input (e.g. IRON_SOURCE)
 */

const HAULER = process.env.HAULER?.trim();
const FACTORY = process.env.FACTORY?.trim() || 'X1-A20-F48';
const EXPORT_GOOD = process.env.EXPORT_GOOD?.trim() || 'FAB_MATS';
const FLOOR = Number(process.env.FLOOR ?? 450_000);
const MAX_TRIPS = Number(process.env.MAX_TRIPS ?? 0);
const MIN_MARGIN = Number(process.env.MIN_MARGIN ?? 0);
const INPUTS = (process.env.INPUTS ?? 'IRON,QUARTZ_SAND')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let stopping = false;
process.on('SIGINT', () => {
  log.warn('SIGINT — finishing current step then exiting');
  stopping = true;
});
process.on('SIGTERM', () => {
  log.warn('SIGTERM — finishing current step then exiting');
  stopping = true;
});

/** Units of a specific good currently held by the ship. */
function heldUnits(ship: Ship, good: string): number {
  return ship.cargo.inventory.find((i) => i.symbol === good)?.units ?? 0;
}

/**
 * Cheapest in-system waypoint (not the factory itself) to BUY `good`, from the
 * last-known DB prices. Honors a per-good env override (e.g. IRON_SOURCE).
 */
function discoverSource(system: string, good: string): string | undefined {
  const override = process.env[`${good}_SOURCE`]?.trim();
  if (override) return override;
  const rows = getLatestPricesForGood(system, good)
    .filter((r) => r.waypoint !== FACTORY && (r.purchase_price ?? 0) > 0)
    .sort((a, b) => (a.purchase_price ?? 0) - (b.purchase_price ?? 0) || a.waypoint.localeCompare(b.waypoint));
  return rows[0]?.waypoint;
}

/** Sell every held unit of `good` into the factory. */
async function deliverHeld(api: SpaceTradersApi, ship: Ship, good: string): Promise<Ship> {
  const units = heldUnits(ship, good);
  if (units <= 0) return ship;
  ship = await navigateTo(api, ship, FACTORY);
  ship = await ensureDocked(api, ship);
  // The factory caps units per transaction at its trade volume; chunk the sell
  // to respect that limit (a full cargo hold can exceed it).
  const market = await api.getMarket(systemOf(FACTORY), FACTORY);
  const tradeVolume = market.tradeGoods?.find((t) => t.symbol === good)?.tradeVolume ?? units;
  let total = 0;
  for (const chunk of purchaseChunks(units, tradeVolume)) {
    const r = await api.sellCargo(ship.symbol, good, chunk);
    ship.cargo = r.cargo;
    total += r.transaction.totalPrice;
  }
  log.info(`feed: delivered ${units} ${good} -> ${FACTORY} (+${total}cr)`);
  return ship;
}

/** Sell or jettison any cargo that isn't one of our feed inputs. */
async function clearForeignCargo(api: SpaceTradersApi, ship: Ship): Promise<Ship> {
  const keep = new Set(INPUTS);
  for (const item of [...ship.cargo.inventory]) {
    if (keep.has(item.symbol)) continue;
    try {
      ship = await ensureDocked(api, ship);
      const r = await api.sellCargo(ship.symbol, item.symbol, item.units);
      ship.cargo = r.cargo;
      log.info(`feed: sold foreign ${item.units} ${item.symbol} (+${r.transaction.totalPrice}cr)`);
    } catch {
      try {
        const r = await api.jettison(ship.symbol, item.symbol, item.units);
        ship.cargo = r.cargo;
        log.warn(`feed: jettisoned ${item.units} ${item.symbol} (unsellable here)`);
      } catch (e) {
        log.warn(`feed: could not clear ${item.symbol}: ${(e as Error).message}`);
      }
    }
  }
  return ship;
}

/**
 * Read the factory market live, persist it to the DB (so `getLatestPrice` and
 * diagnostics stay fresh — plain getMarket does not write back), and log the
 * input + export supply/price for elasticity tracking. Returns the live market.
 */
async function readFactory(api: SpaceTradersApi, system: string): Promise<Market> {
  const market = await api.getMarket(system, FACTORY);
  if (market.tradeGoods?.length) recordPrices(system, FACTORY, market.tradeGoods);
  const parts: string[] = [];
  for (const good of [...INPUTS, EXPORT_GOOD]) {
    const g = market.tradeGoods?.find((t) => t.symbol === good);
    if (g) parts.push(`${good}{${g.supply} vol${g.tradeVolume} buy${g.purchasePrice}}`);
  }
  log.info(`feed: factory ${FACTORY} | ${parts.join(' ')}`);
  return market;
}

async function main(): Promise<void> {
  if (!HAULER) {
    log.error('HAULER env (ship symbol) is required');
    process.exit(1);
  }
  const api = new SpaceTradersApi();
  const system = systemOf(FACTORY);

  // Resolve a source for each input up front (cheapest known market).
  const sources = new Map<string, string | undefined>();
  for (const good of INPUTS) sources.set(good, discoverSource(system, good));
  log.info(
    `feed start: hauler=${HAULER} factory=${FACTORY} floor=${FLOOR} inputs=[` +
      INPUTS.map((g) => `${g}<-${sources.get(g) ?? 'NONE'}`).join(', ') +
      `]`,
  );

  let ship = await api.getShip(HAULER);

  // Resume / handoff cleanup: deliver any inputs we already hold, then clear
  // any leftover trade cargo from the ship's previous role.
  for (const good of INPUTS) ship = await deliverHeld(api, ship, good);
  ship = await clearForeignCargo(api, ship);

  let trips = 0;
  while (!stopping) {
    const agent = await api.getMyAgent();
    const cargoSpace = ship.cargo.capacity - ship.cargo.units;

    // Read the factory live: its current supply drives which input is most
    // starved, and its IMPORT sell prices drive the per-unit margin guard.
    const factory = await readFactory(api, system);
    const factoryGood = (g: string) => factory.tradeGoods?.find((t) => t.symbol === g);

    // Build live input states. Margin = what the factory pays us to deliver the
    // input (its IMPORT sellPrice) minus the source's last-known purchase price.
    // Both inputs rise together as we feed, so the guard skips whichever has
    // gone unprofitable (e.g. IRON once its source price climbs past F48's pay).
    const states: FeedInputState[] = INPUTS.map((good) => {
      const source = sources.get(good);
      const factorySell = factoryGood(good)?.sellPrice ?? 0;
      const srcBuy = source ? getLatestPrice(source, good)?.purchase_price ?? 0 : 0;
      return {
        good,
        factorySupply: factoryGood(good)?.supply ?? 'SCARCE',
        source,
        margin: source && factorySell > 0 && srcBuy > 0 ? factorySell - srcBuy : undefined,
      };
    });
    const choice = pickFeedInput(states, MIN_MARGIN);
    if (!choice || !choice.source) {
      log.info('feed: no feedable input remains (inputs satisfied or unprofitable); stopping');
      break;
    }
    const good = choice.good;
    const source = choice.source;
    const factorySell = factoryGood(good)?.sellPrice ?? 0;

    const estPrice = getLatestPrice(source, good)?.purchase_price ?? 0;
    if (planFeedBatch({ cargoSpace, credits: agent.credits, floor: FLOOR, pricePerUnit: estPrice || 1 }) <= 0) {
      log.warn(
        `feed: floor reached — can't buy ${good} above ${FLOOR}cr (credits ${agent.credits}). Pausing.`,
      );
      break;
    }

    // Travel to the source, read the live market, buy a floor-protected batch.
    ship = await navigateTo(api, ship, source);
    ship = await ensureDocked(api, ship);
    const market = await api.getMarket(system, source);
    if (market.tradeGoods?.length) recordPrices(system, source, market.tradeGoods);
    const g = market.tradeGoods?.find((t) => t.symbol === good);
    if (!g) {
      log.warn(`feed: ${source} does not sell ${good} (docked); skipping this input`);
      sources.set(good, undefined); // don't retry a bad source
      continue;
    }

    // Live margin re-check at the source: its price climbs as we drain it, so a
    // batch that looked profitable from the DB estimate may not be once we dock.
    const liveMargin = factorySell - g.purchasePrice;
    if (factorySell > 0 && liveMargin <= MIN_MARGIN) {
      log.warn(
        `feed: ${good} margin ${liveMargin}/u (factory pays ${factorySell}, source ${g.purchasePrice}) ` +
          `at/below guard ${MIN_MARGIN}; stopping`,
      );
      break;
    }

    const units = planFeedBatch({
      cargoSpace,
      credits: agent.credits,
      floor: FLOOR,
      pricePerUnit: g.purchasePrice,
    });
    if (units <= 0) {
      log.warn(`feed: ${good} price ${g.purchasePrice} spiked above floor budget; pausing`);
      break;
    }

    log.info(
      `feed: buying ${units} ${good} @~${g.purchasePrice} -> deliver ${factorySell} ` +
        `(margin ${liveMargin}/u, factory ${choice.factorySupply}, credits ${agent.credits})`,
    );
    for (const chunk of purchaseChunks(units, g.tradeVolume)) {
      if (stopping) break;
      const r = await api.purchaseCargo(ship.symbol, good, chunk);
      ship.cargo = r.cargo;
    }

    ship = await deliverHeld(api, ship, good);
    await readFactory(api, system);
    trips++;

    if (MAX_TRIPS > 0 && trips >= MAX_TRIPS) {
      log.info(`feed: hit MAX_TRIPS=${MAX_TRIPS}; stopping`);
      break;
    }
  }

  await readFactory(api, system);
  const agent = await api.getMyAgent();
  log.info(`feed done: ${trips} trip(s), credits=${agent.credits}`);
  closeDb();
}

main().catch((e) => {
  log.error(`feed crashed: ${(e as Error).message}`);
  closeDb();
  process.exit(1);
});

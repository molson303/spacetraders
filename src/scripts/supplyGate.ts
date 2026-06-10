import 'dotenv/config';
import { SpaceTradersApi } from '../client/api.js';
import { closeDb } from '../state/db.js';
import { log } from '../util/logger.js';
import { navigateTo, ensureDocked } from '../util/nav.js';
import { systemOf } from '../state/world.js';
import { getLatestPrice } from '../state/repos.js';
import { remainingMaterials, planSupplyBatch, purchaseChunks } from '../fleet/gateSupply.js';
import type { Ship } from '../types/index.js';

/*
 * One-shot (resumable) jump-gate construction supplier.
 *
 * Dedicates a single hauler (HAULER) to ferry construction materials from their
 * in-system export markets to the gate construction site, completing it so
 * cross-system travel opens. Runs alongside the round supervisor as long as the
 * hauler is listed in that process's EXCLUDE_SHIPS so they never fight over it.
 *
 * Capital safety: never spends below FLOOR credits. When the surplus above the
 * floor can't buy a single unit of any remaining material, it stops and reports
 * progress so a later pass (after more earnings) can resume.
 *
 * Env:
 *   HAULER              ship symbol to dedicate (required)
 *   GATE                construction site waypoint (default X1-A20-I56)
 *   FLOOR               protected credit floor (default 2_000_000)
 *   MATERIALS           comma list restricting which materials this hauler
 *                       handles (default all); use to run one ship per material
 *   FAB_MATS_MARKET     source for FAB_MATS (default X1-A20-F48)
 *   ADV_CIRCUITRY_MARKET source for ADVANCED_CIRCUITRY (default X1-A20-D41)
 *   MAX_TRIPS           safety cap on buy->supply trips (default 0 = unlimited)
 */

const HAULER = process.env.HAULER?.trim();
const GATE = process.env.GATE?.trim() || 'X1-A20-I56';
const FLOOR = Number(process.env.FLOOR ?? 2_000_000);
const MAX_TRIPS = Number(process.env.MAX_TRIPS ?? 0);

const ALL_SOURCES: Record<string, string> = {
  FAB_MATS: process.env.FAB_MATS_MARKET?.trim() || 'X1-A20-F48',
  ADVANCED_CIRCUITRY: process.env.ADV_CIRCUITRY_MARKET?.trim() || 'X1-A20-D41',
};

// Optional MATERIALS env restricts this hauler to a subset of materials so
// multiple haulers can run in parallel without racing (one ship per material).
const MATERIALS = (process.env.MATERIALS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SOURCES: Record<string, string> = MATERIALS.length
  ? Object.fromEntries(
      Object.entries(ALL_SOURCES).filter(([good]) => MATERIALS.includes(good)),
    )
  : ALL_SOURCES;

let stopping = false;
process.on('SIGINT', () => {
  log.warn('SIGINT — finishing current step then exiting');
  stopping = true;
});

/** Units of a specific good currently held by the ship. */
function heldUnits(ship: Ship, good: string): number {
  return ship.cargo.inventory.find((i) => i.symbol === good)?.units ?? 0;
}

/** Sell or jettison any cargo that isn't a needed construction material. */
async function clearForeignCargo(
  api: SpaceTradersApi,
  ship: Ship,
  needed: Set<string>,
): Promise<Ship> {
  for (const item of [...ship.cargo.inventory]) {
    if (needed.has(item.symbol)) continue;
    try {
      ship = await ensureDocked(api, ship);
      const r = await api.sellCargo(ship.symbol, item.symbol, item.units);
      ship.cargo = r.cargo;
      log.info(`hauler: sold ${item.units} ${item.symbol} (${r.transaction.totalPrice}cr)`);
    } catch {
      try {
        const r = await api.jettison(ship.symbol, item.symbol, item.units);
        ship.cargo = r.cargo;
        log.warn(`hauler: jettisoned ${item.units} ${item.symbol} (unsellable here)`);
      } catch (e) {
        log.warn(`hauler: could not clear ${item.symbol}: ${(e as Error).message}`);
      }
    }
  }
  return ship;
}

/** Deliver all held units of `good` to the construction site. */
async function deliverHeld(
  api: SpaceTradersApi,
  ship: Ship,
  system: string,
  good: string,
): Promise<Ship> {
  const units = heldUnits(ship, good);
  if (units <= 0) return ship;
  ship = await navigateTo(api, ship, GATE);
  ship = await ensureDocked(api, ship);
  const res = await api.supplyConstruction(system, GATE, ship.symbol, good, units);
  ship.cargo = res.cargo;
  const m = res.construction.materials.find((x) => x.tradeSymbol === good);
  log.info(
    `hauler: supplied ${units} ${good} -> gate ${m ? `${m.fulfilled}/${m.required}` : ''}`,
  );
  return ship;
}

async function main(): Promise<void> {
  if (!HAULER) {
    log.error('HAULER env (ship symbol) is required');
    process.exit(1);
  }
  const api = new SpaceTradersApi();
  const system = systemOf(GATE);
  const needed = new Set(Object.keys(SOURCES));

  let ship = await api.getShip(HAULER);
  log.info(
    `gate-supply start: hauler=${ship.symbol} cap=${ship.cargo.capacity} floor=${FLOOR} gate=${GATE}`,
  );

  // Resume: deliver anything we already hold, then clear non-material cargo.
  for (const good of needed) ship = await deliverHeld(api, ship, system, good);
  ship = await clearForeignCargo(api, ship, needed);

  let trips = 0;
  while (!stopping) {
    const construction = await api.getConstruction(system, GATE);
    if (construction.isComplete) {
      log.info('gate-supply: construction COMPLETE 🎉');
      break;
    }
    const remaining = remainingMaterials(construction).filter((m) => SOURCES[m.tradeSymbol]);
    if (remaining.length === 0) {
      log.warn('gate-supply: no remaining material has a known source; stopping');
      break;
    }

    const agent = await api.getMyAgent();
    const cargoSpace = ship.cargo.capacity - ship.cargo.units;

    // Pick the first material we can afford and fit. A market's live price and
    // trade volume are only readable once one of our ships is present there, so
    // we estimate affordability from the last-known DB price, travel to the
    // source, then confirm against the live market after docking.
    let acted = false;
    for (const mat of remaining) {
      const source = SOURCES[mat.tradeSymbol];
      if (!source) continue;
      const estPrice = getLatestPrice(source, mat.tradeSymbol)?.purchase_price ?? 0;
      const estUnits = planSupplyBatch({
        remaining: mat.remaining,
        cargoSpace,
        credits: agent.credits,
        floor: FLOOR,
        pricePerUnit: estPrice || 1,
      });
      if (estUnits <= 0) continue; // can't afford this one (estimate) — try next

      // Travel to the source and read the live market now that we're present.
      ship = await navigateTo(api, ship, source);
      ship = await ensureDocked(api, ship);
      const market = await api.getMarket(system, source);
      const good = market.tradeGoods?.find((g) => g.symbol === mat.tradeSymbol);
      if (!good) {
        log.warn(`gate-supply: ${source} does not sell ${mat.tradeSymbol} (docked); skipping`);
        continue;
      }
      const units = planSupplyBatch({
        remaining: mat.remaining,
        cargoSpace,
        credits: agent.credits,
        floor: FLOOR,
        pricePerUnit: good.purchasePrice,
      });
      if (units <= 0) continue; // price spiked above floor — try next

      log.info(
        `gate-supply: buying ${units} ${mat.tradeSymbol} @~${good.purchasePrice} from ${source} ` +
          `(need ${mat.remaining}, credits ${agent.credits})`,
      );
      for (const chunk of purchaseChunks(units, good.tradeVolume)) {
        if (stopping) break;
        const r = await api.purchaseCargo(ship.symbol, mat.tradeSymbol, chunk);
        ship.cargo = r.cargo;
      }
      ship = await deliverHeld(api, ship, system, mat.tradeSymbol);
      acted = true;
      trips++;
      break;
    }

    if (!acted) {
      log.warn(
        `gate-supply: floor reached — cannot afford any remaining material above ${FLOOR}cr. ` +
          `Pausing; rerun after more earnings.`,
      );
      break;
    }
    if (MAX_TRIPS > 0 && trips >= MAX_TRIPS) {
      log.info(`gate-supply: hit MAX_TRIPS=${MAX_TRIPS}; stopping`);
      break;
    }
  }

  // Final progress report.
  const final = await api.getConstruction(system, GATE);
  for (const m of final.materials) {
    log.info(`  ${m.tradeSymbol}: ${m.fulfilled}/${m.required}`);
  }
  const agent = await api.getMyAgent();
  log.info(`gate-supply done: ${trips} trip(s), credits=${agent.credits}`);
  closeDb();
}

main().catch((e) => {
  log.error(`gate-supply crashed: ${(e as Error).message}`);
  closeDb();
  process.exit(1);
});

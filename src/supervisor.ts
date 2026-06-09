/*
 * Persistent fleet supervisor: runs orchestration rounds forever, re-hydrating
 * the fleet and re-assigning roles each round so newly purchased ships are
 * picked up automatically. Resilient to per-round errors (logs + backs off),
 * tracks cumulative profit, optionally reinvests surplus credits into new
 * ships, and shuts down gracefully on SIGINT/SIGTERM (finishes the current
 * round, then closes the DB).
 *
 * Env:
 *   MAX_CONTRACTS    contracts the contractor completes per round (default 1)
 *   TRADE_CYCLES     arbitrage cycles each trader runs per round (default 3)
 *   MIN_PROFIT       minimum per-unit spread a trader will act on (default 20)
 *   SCAN_LIMIT       markets each scanner visits per round (default 20)
 *   SCAN_BUDGET_MS   max ms a scanner runs per round so it never gates the
 *                    round; earners (contractor/traders) define round end
 *                    and reinvest fires right after (default 180000 = 3 min)
 *   REST_MS          pause between rounds (default 5000)
 *   MAX_ROUNDS       stop after N rounds (default 0 = unlimited)
 *   MINERS           run this many mining-capable ships as dedicated miners
 *                    each round (default 0 = no mining, unchanged behavior)
 *   REINVEST         "1" to auto-buy ships from surplus (default 1)
 *   RESERVE          credits to keep on hand, never spent on ships (default 75000)
 *   MAX_SHIPS        fleet size cap for reinvestment (default 8); counts cargo
 *                    earners only — probes live on their own MAX_PROBES budget
 *   MAX_PROBES       max market-data probes to own, stationed one per home-system
 *                    marketplace to keep prices live (default 0 = off)
 *   PROBE_COST_EST   est. probe price used to size probe buys (default 15000)
 *   REINVEST_YARD    optional override of the shipyard to buy at; when unset the
 *                    home system is auto-scanned for SHIPYARD waypoints and the
 *                    nearest one is used
 *   SHIP_COST_EST    min surplus (credits-reserve) before bothering to scan the
 *                    yard for a buy (default 90000)
 *   MIN_ROI          skip buys whose ROI (earn weight / price) is below this
 *                    (default 0 = buy any affordable cargo ship)
 *   REPAIR           "1" to auto-repair worn ships between rounds (default 1)
 *   REPAIR_THRESHOLD condition at/below which a ship is repaired (default 0.4)
 *   REPAIR_YARD      optional override of the shipyard to repair at; defaults to
 *                    REINVEST_YARD, else auto-discovered like REINVEST_YARD
 */
import { SpaceTradersApi } from './client/api.js';
import { closeDb } from './state/db.js';
import { runFleetRound } from './orchestrator.js';
import { purchaseShipAt } from './behaviors/fleet.js';
import { maybeRepair } from './behaviors/maintenance.js';
import { scanShipyard, systemOf } from './state/world.js';
import {
  findJumpGatesBySystem,
  findWaypointsByTrait,
  getJumpGateRow,
  getWaypointRow,
  isWaypointUnderConstruction,
} from './state/repos.js';
import { kvGet, kvSet } from './state/kv.js';
import { travelTo } from './util/nav.js';
import { bestReinvestShip, earnWeight } from './util/reinvest.js';
import {
  planProbeStations,
  probesToProvision,
  type StationAssignment,
  type StationMarket,
} from './util/stations.js';
import { selectShipyard, type ShipyardCandidate } from './util/shipyard.js';
import { sleep } from './client/rateLimiter.js';
import { log } from './util/logger.js';
import type { ShipType } from './types/index.js';

const CFG = {
  maxContracts: Number(process.env.MAX_CONTRACTS ?? 1),
  tradeCycles: Number(process.env.TRADE_CYCLES ?? 3),
  minProfit: Number(process.env.MIN_PROFIT ?? 20),
  scanLimit: Number(process.env.SCAN_LIMIT ?? 20),
  scanBudgetMs: Number(process.env.SCAN_BUDGET_MS ?? 180000),
  restMs: Number(process.env.REST_MS ?? 5000),
  maxRounds: Number(process.env.MAX_ROUNDS ?? 0),
  miners: Number(process.env.MINERS ?? 0),
  crossAntimatterCost: Number(process.env.CROSS_ANTIMATTER_COST ?? 0),
  reinvest: (process.env.REINVEST ?? '1') === '1',
  reserve: Number(process.env.RESERVE ?? 75000),
  maxShips: Number(process.env.MAX_SHIPS ?? 8),
  maxProbes: Number(process.env.MAX_PROBES ?? 0),
  probeCostEst: Number(process.env.PROBE_COST_EST ?? 15000),
  reinvestYard: process.env.REINVEST_YARD?.trim() || undefined,
  shipCostEst: Number(process.env.SHIP_COST_EST ?? 90000),
  minRoi: Number(process.env.MIN_ROI ?? 0),
  repair: (process.env.REPAIR ?? '1') === '1',
  repairThreshold: Number(process.env.REPAIR_THRESHOLD ?? 0.4),
  repairYard: process.env.REPAIR_YARD?.trim() || process.env.REINVEST_YARD?.trim() || undefined,
};

/**
 * Discover the shipyard to use for a given purpose. Honors an explicit operator
 * override (REINVEST_YARD / REPAIR_YARD); otherwise auto-discovers SHIPYARD
 * waypoints in the agent's home system and picks the one nearest to `from`
 * (falling back to the first). Returns undefined when nothing is available.
 */
function discoverShipyard(
  system: string,
  override: string | undefined,
  from: { x: number; y: number } | undefined,
): string | undefined {
  const candidates: ShipyardCandidate[] = findWaypointsByTrait(system, 'SHIPYARD').map((w) => ({
    symbol: w.symbol,
    x: w.x,
    y: w.y,
  }));
  return selectShipyard(candidates, { override, from });
}

/** Coordinates of a waypoint, if known in the local world cache. */
function coordsOf(symbol: string): { x: number; y: number } | undefined {
  const wp = getWaypointRow(symbol);
  return wp ? { x: wp.x, y: wp.y } : undefined;
}

/**
 * Marketplaces eligible for a stationed probe. Home-system markets always
 * qualify (priority 1, covered first). When the home jump gate is operational,
 * already-hydrated markets in directly-connected neighbor systems are also
 * included (priority 0) so cross-system price coverage fills in once MAX_PROBES
 * allows. While the gate is under construction only home markets are returned,
 * keeping cross-system stationing inert until jumps are possible.
 */
function gatherStationMarkets(system: string): StationMarket[] {
  const home: StationMarket[] = findWaypointsByTrait(system, 'MARKETPLACE').map((w) => ({
    symbol: w.symbol,
    system: w.system,
    priority: 1,
  }));

  const homeGate = findJumpGatesBySystem(system)[0];
  const gateBlocked = homeGate ? isWaypointUnderConstruction(homeGate.symbol) : true;
  if (!homeGate || gateBlocked) return home;

  const neighborSystems = new Set(
    (getJumpGateRow(homeGate.symbol)?.connections ?? [])
      .map((c) => systemOf(c))
      .filter((s) => s !== system),
  );
  const neighbors: StationMarket[] = [];
  for (const sys of neighborSystems) {
    for (const w of findWaypointsByTrait(sys, 'MARKETPLACE')) {
      neighbors.push({ symbol: w.symbol, system: w.system, priority: 0 });
    }
  }
  return [...home, ...neighbors];
}

let stopping = false;
function requestStop(signal: string): void {
  if (stopping) {
    log.warn(`${signal} again — exiting now`);
    process.exit(1);
  }
  log.warn(`${signal} received — will stop after the current round finishes`);
  stopping = true;
}
process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));

/**
 * If reinvestment is enabled and we have surplus credits and fleet headroom,
 * route a free-moving scout to the shipyard, read live prices, and buy as many
 * ships as the surplus allows — each time picking the best ROI (earning weight
 * per credit) ship that's affordable. Runs between rounds. Returns the number
 * of ships purchased.
 */
async function maybeReinvest(api: SpaceTradersApi): Promise<number> {
  if (!CFG.reinvest) return 0;
  let agent = await api.getMyAgent();
  let fleet = (await api.listShips()).data;
  // Only cargo earners count against MAX_SHIPS; stationed/scout probes live on
  // their own MAX_PROBES budget and must never crowd out income ships here.
  const earnerCount = fleet.filter((s) => s.cargo.capacity > 0 && s.fuel.capacity > 0).length;
  if (earnerCount >= CFG.maxShips) return 0;
  // Cheap pre-check: don't route a scout if we can't plausibly afford a ship.
  if (agent.credits - CFG.reserve < CFG.shipCostEst) return 0;

  // Route a flex probe (fuel-free, not holding a station) to the yard so live
  // prices populate, falling back to any fuel-free ship, then any ship.
  const stationedShips = new Set(
    (kvGet<StationAssignment[]>('probe_stations') ?? []).map((a) => a.ship),
  );
  const scout =
    fleet.find((s) => s.fuel.capacity === 0 && !stationedShips.has(s.symbol)) ??
    fleet.find((s) => s.fuel.capacity === 0) ??
    fleet[0]!;
  const system = systemOf(agent.headquarters);
  const yardSymbol = discoverShipyard(
    system,
    CFG.reinvestYard,
    coordsOf(scout.nav.waypointSymbol) ?? coordsOf(agent.headquarters),
  );
  if (!yardSymbol) {
    log.info(`reinvest: no shipyard found in ${system}; skipping`);
    return 0;
  }
  if (scout.nav.waypointSymbol !== yardSymbol) {
    await travelTo(api, scout, yardSymbol);
  }

  let bought = 0;
  while (earnerCount + bought < CFG.maxShips) {
    const budget = agent.credits - CFG.reserve;
    if (budget <= 0) break;

    const yard = await scanShipyard(api, system, yardSymbol);
    const candidates = (yard.ships ?? []).map((s) => ({ type: s.type, price: s.purchasePrice }));
    const pick = bestReinvestShip(candidates, {
      budget,
      earnRate: earnWeight,
      minRoi: CFG.minRoi,
    });
    if (!pick) {
      log.info(`reinvest: nothing affordable/worthwhile (budget=${budget}); stopping`);
      break;
    }

    log.info(
      `reinvest: credits=${agent.credits} buying ${pick.type} @ ${pick.price} at ${yardSymbol} ` +
        `(earners ${earnerCount + bought}/${CFG.maxShips}, roi=${(earnWeight(pick.type) / pick.price).toFixed(5)})`,
    );
    const res = await purchaseShipAt(api, pick.type as ShipType, yardSymbol, {
      maxPrice: pick.price + CFG.reserve,
    });
    if (!res.ship) break;
    bought++;
    agent = { ...agent, credits: res.credits };
  }

  if (bought > 0) log.info(`reinvest: bought ${bought} ship(s) this cycle`);
  return bought;
}

/**
 * Provision and station market-data probes. When MAX_PROBES > 0, buys fuel-free
 * probes — on their own budget, separate from the MAX_SHIPS earner cap — up to
 * one per home-system marketplace, then assigns every probe to a market and
 * persists the plan so the next round's station keeper refreshes prices in
 * place. Re-plans each cycle even when buying nothing, so existing probes pick
 * up stations and vacancies (sold/lost probes, new markets) get backfilled.
 * Returns the number of probes bought.
 */
async function maybeProvisionProbes(api: SpaceTradersApi): Promise<number> {
  if (CFG.maxProbes <= 0) return 0;
  let agent = await api.getMyAgent();
  let fleet = (await api.listShips()).data;
  const system = systemOf(agent.headquarters);

  const isProbe = (s: { fuel: { capacity: number } }): boolean => s.fuel.capacity === 0;
  const markets: StationMarket[] = gatherStationMarkets(system);
  if (markets.length === 0) return 0;

  const existing = kvGet<StationAssignment[]>('probe_stations') ?? [];
  const probes = fleet.filter(isProbe);
  const stationedNow = planProbeStations(
    markets,
    probes.map((p) => ({ symbol: p.symbol })),
    existing,
  ).length;
  const buyCount = probesToProvision({
    marketCount: markets.length,
    stationed: stationedNow,
    currentProbes: probes.length,
    maxProbes: CFG.maxProbes,
    budget: agent.credits - CFG.reserve,
    probePrice: CFG.probeCostEst,
  });

  let bought = 0;
  if (buyCount > 0) {
    const ferry = probes[0] ?? fleet[0]!;
    const yardSymbol = discoverShipyard(
      system,
      CFG.reinvestYard,
      coordsOf(ferry.nav.waypointSymbol) ?? coordsOf(agent.headquarters),
    );
    if (!yardSymbol) {
      log.info(`provision: no shipyard found in ${system}; skipping buy`);
    } else {
      if (ferry.nav.waypointSymbol !== yardSymbol) await travelTo(api, ferry, yardSymbol);
      for (let i = 0; i < buyCount; i++) {
        const yard = await scanShipyard(api, system, yardSymbol);
        const offer = (yard.ships ?? []).find((s) => s.type === 'SHIP_PROBE');
        if (!offer) {
          log.info('provision: no SHIP_PROBE sold at yard; skipping');
          break;
        }
        if (agent.credits - CFG.reserve < offer.purchasePrice) break;
        const res = await purchaseShipAt(api, 'SHIP_PROBE' as ShipType, yardSymbol, {
          maxPrice: offer.purchasePrice + CFG.reserve,
        });
        if (!res.ship) break;
        bought++;
        agent = { ...agent, credits: res.credits };
      }
      if (bought > 0) log.info(`provision: bought ${bought} probe(s) this cycle`);
    }
  }

  // Re-plan over ALL current probes (including any just bought) and persist so
  // the orchestrator's station keeper can service them next round.
  if (bought > 0) fleet = (await api.listShips()).data;
  const allProbes = fleet.filter(isProbe).map((p) => ({ symbol: p.symbol }));
  const plan = planProbeStations(markets, allProbes, existing);
  kvSet('probe_stations', plan);
  log.info(
    `provision: ${plan.length}/${markets.length} market(s) stationed (${allProbes.length} probe(s))`,
  );
  return bought;
}

/**
 * Repair any worn ships between rounds. Each repair is capped at the spendable
 * surplus (credits - reserve) so maintenance never eats into the reserve, and
 * healthy ships are skipped cheaply by the condition check before any travel.
 * Returns the number of ships repaired.
 */
async function maybeRepairFleet(api: SpaceTradersApi): Promise<number> {
  if (!CFG.repair) return 0;
  let repaired = 0;
  const fleet = (await api.listShips()).data;
  for (const ship of fleet) {
    if (stopping) break;
    const agent = await api.getMyAgent();
    const yardSymbol = discoverShipyard(
      systemOf(agent.headquarters),
      CFG.repairYard,
      coordsOf(ship.nav.waypointSymbol) ?? coordsOf(agent.headquarters),
    );
    if (!yardSymbol) {
      log.info(`maintenance: no shipyard found for ${ship.symbol}; skipping`);
      continue;
    }
    const before = ship.frame.condition;
    const result = await maybeRepair(api, ship, {
      shipyard: yardSymbol,
      threshold: CFG.repairThreshold,
      maxSpend: Math.max(0, agent.credits - CFG.reserve),
    });
    // Count it as repaired only when condition actually improved.
    if (before !== undefined && (result.frame.condition ?? 0) > before) repaired++;
  }
  if (repaired > 0) log.info(`maintenance: repaired ${repaired} ship(s) this cycle`);
  return repaired;
}

async function main(): Promise<void> {
  const api = new SpaceTradersApi();
  const startAgent = await api.getMyAgent();
  log.info(
    `supervisor start | credits=${startAgent.credits} reinvest=${CFG.reinvest} ` +
      `reserve=${CFG.reserve} maxShips=${CFG.maxShips} maxRounds=${CFG.maxRounds || '∞'}`,
  );

  let round = 0;
  const baseline = startAgent.credits;

  while (!stopping) {
    round++;
    const t0 = Date.now();
    log.info(`===== round ${round} start =====`);
    try {
      const r = await runFleetRound(api, {
        maxContracts: CFG.maxContracts,
        tradeCycles: CFG.tradeCycles,
        minProfit: CFG.minProfit,
        scanLimit: CFG.scanLimit,
        scanBudgetMs: CFG.scanBudgetMs,
        miners: CFG.miners,
        crossAntimatterCost: CFG.crossAntimatterCost,
      });
      const dt = Math.round((Date.now() - t0) / 1000);
      log.info(
        `===== round ${round} done in ${dt}s | credits=${r.endCredits} ` +
          `(round Δ${r.endCredits - r.startCredits}, total Δ${r.endCredits - baseline}) ` +
          `contracts=${r.contractsCompleted} traderProfit=${r.traderProfit} ` +
          `remoteProfit=${r.remoteProfit} scouted=${r.scoutedSystems} ` +
          `minerEarnings=${r.minerEarnings} scanned=${r.scannedMarkets} ` +
          `stationsRefreshed=${r.stationsRefreshed} =====`,
      );
    } catch (err) {
      log.error(`round ${round} failed: ${(err as Error).message}`);
      await sleep(15000); // back off before retrying
    }

    if (stopping) break;
    if (CFG.maxRounds > 0 && round >= CFG.maxRounds) {
      log.info(`reached MAX_ROUNDS=${CFG.maxRounds}; stopping`);
      break;
    }

    try {
      await maybeReinvest(api);
    } catch (err) {
      log.warn(`reinvest skipped: ${(err as Error).message}`);
    }

    if (stopping) break;
    try {
      await maybeProvisionProbes(api);
    } catch (err) {
      log.warn(`probe provisioning skipped: ${(err as Error).message}`);
    }

    if (stopping) break;
    try {
      await maybeRepairFleet(api);
    } catch (err) {
      log.warn(`repair skipped: ${(err as Error).message}`);
    }

    if (stopping) break;
    await sleep(CFG.restMs);
  }

  const finalAgent = await api.getMyAgent();
  log.info(
    `supervisor stopped after ${round} round(s) | credits=${finalAgent.credits} ` +
      `(total Δ${finalAgent.credits - baseline})`,
  );
  closeDb();
  process.exit(0);
}

main().catch((err) => {
  log.error('supervisor crashed', err);
  closeDb();
  process.exit(1);
});

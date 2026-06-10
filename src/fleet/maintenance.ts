/*
 * Shared fleet-maintenance routines: reinvestment, probe provisioning, and
 * repair. Extracted from the round supervisor so both the legacy round loop
 * (supervisor.ts) and the continuous fleet (fleet.ts) drive identical
 * behavior — the round loop calls these between rounds, the continuous fleet
 * calls them from background timers.
 *
 * Every routine takes an explicit {@link MaintenanceConfig} instead of reading
 * process.env directly, so callers own configuration and these stay injectable.
 */

import type { SpaceTradersApi } from '../client/api.js';
import { purchaseShipAt } from '../behaviors/fleet.js';
import { maybeRepair, needsRepair } from '../behaviors/maintenance.js';
import { scanShipyard, systemOf } from '../state/world.js';
import {
  findArbitrageRoutes,
  findJumpGatesBySystem,
  findShipyardsSellingShipType,
  findWaypointsByTrait,
  getJumpGateRow,
  getWaypointRow,
  isWaypointUnderConstruction,
} from '../state/repos.js';
import { kvGet, kvSet } from '../state/kv.js';
import { travelTo } from '../util/nav.js';
import { bestReinvestShip, earnWeight, reinvestEarnerHeadroom } from '../util/reinvest.js';
import { countDistinctRoutes } from '../util/routes.js';
import {
  planProbeStations,
  probesToProvision,
  type StationAssignment,
  type StationMarket,
} from '../util/stations.js';
import { orderShipyardsForPurchase, selectShipyard, type ShipyardCandidate } from '../util/shipyard.js';
import { log } from '../util/logger.js';
import type { Ship, ShipType } from '../types/index.js';

export interface MaintenanceConfig {
  reinvest: boolean;
  reserve: number;
  maxShips: number;
  maxProbes: number;
  probeCostEst: number;
  minProfit: number;
  reinvestYard: string | undefined;
  shipCostEst: number;
  minRoi: number;
  repair: boolean;
  repairThreshold: number;
  repairYard: string | undefined;
  /** Cooperative stop signal — the repair loop bails between ships when true. */
  stopping: () => boolean;
}

/**
 * Discover the shipyard to use for a given purpose. Honors an explicit operator
 * override; otherwise auto-discovers SHIPYARD waypoints in the agent's home
 * system and picks the one nearest to `from` (falling back to the first).
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
 * qualify (priority 1). When the home jump gate is operational, hydrated markets
 * in directly-connected neighbor systems are included (priority 0); while the
 * gate is under construction only home markets are returned.
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

/**
 * If reinvestment is enabled and we have surplus credits and fleet headroom,
 * route a free-moving scout to the shipyard, read live prices, and buy as many
 * ships as the surplus allows — each picking the best ROI ship that's
 * affordable. Returns the number of ships purchased.
 */
export async function maybeReinvest(api: SpaceTradersApi, cfg: MaintenanceConfig): Promise<number> {
  if (!cfg.reinvest) return 0;
  let agent = await api.getMyAgent();
  const fleet = (await api.listShips()).data;
  // Only cargo earners count against MAX_SHIPS; stationed/scout probes live on
  // their own MAX_PROBES budget and must never crowd out income ships here.
  const earnerCount = fleet.filter((s) => s.cargo.capacity > 0 && s.fuel.capacity > 0).length;
  if (earnerCount >= cfg.maxShips) return 0;
  // Cheap pre-check: don't route a scout if we can't plausibly afford a ship.
  if (agent.credits - cfg.reserve < cfg.shipCostEst) return 0;

  // Route-diversity cap: never grow earners past the number of distinct
  // profitable routes in-system. Beyond that, a new hauler can only double up on
  // a good already being traded and collapse its spread.
  const system = systemOf(agent.headquarters);
  const distinctRoutes = countDistinctRoutes(findArbitrageRoutes(system, cfg.minProfit, 30));
  const headroom = reinvestEarnerHeadroom(distinctRoutes, earnerCount);
  const shipTarget = Math.min(cfg.maxShips, earnerCount + headroom);
  if (shipTarget <= earnerCount) {
    log.info(
      `reinvest: ${earnerCount} earners already cover ${distinctRoutes} distinct route(s); ` +
        `holding (maxShips=${cfg.maxShips})`,
    );
    return 0;
  }

  // Route a flex probe (fuel-free, not holding a station) to the yard so live
  // prices populate, falling back to any fuel-free ship, then any ship.
  const stationedShips = new Set(
    (kvGet<StationAssignment[]>('probe_stations') ?? []).map((a) => a.ship),
  );
  const scout =
    fleet.find((s) => s.fuel.capacity === 0 && !stationedShips.has(s.symbol)) ??
    fleet.find((s) => s.fuel.capacity === 0) ??
    fleet[0]!;
  const yardSymbol = discoverShipyard(
    system,
    cfg.reinvestYard,
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
  while (earnerCount + bought < shipTarget) {
    const budget = agent.credits - cfg.reserve;
    if (budget <= 0) break;

    const yard = await scanShipyard(api, system, yardSymbol);
    const candidates = (yard.ships ?? []).map((s) => ({ type: s.type, price: s.purchasePrice }));
    const pick = bestReinvestShip(candidates, {
      budget,
      earnRate: earnWeight,
      minRoi: cfg.minRoi,
    });
    if (!pick) {
      log.info(`reinvest: nothing affordable/worthwhile (budget=${budget}); stopping`);
      break;
    }

    log.info(
      `reinvest: credits=${agent.credits} buying ${pick.type} @ ${pick.price} at ${yardSymbol} ` +
        `(earners ${earnerCount + bought}/${shipTarget}, routes=${distinctRoutes}, roi=${(earnWeight(pick.type) / pick.price).toFixed(5)})`,
    );
    const res = await purchaseShipAt(api, pick.type as ShipType, yardSymbol, {
      maxPrice: pick.price + cfg.reserve,
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
 * probes up to one per eligible marketplace, then assigns every probe to a market
 * and persists the plan so the station keeper refreshes prices in place. Returns
 * the number of probes bought.
 */
export async function maybeProvisionProbes(
  api: SpaceTradersApi,
  cfg: MaintenanceConfig,
): Promise<number> {
  if (cfg.maxProbes <= 0) return 0;
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
    maxProbes: cfg.maxProbes,
    budget: agent.credits - cfg.reserve,
    probePrice: cfg.probeCostEst,
  });

  let bought = 0;
  if (buyCount > 0) {
    let ferry = probes[0] ?? fleet[0]!;
    const candidates: ShipyardCandidate[] = findWaypointsByTrait(system, 'SHIPYARD').map((w) => ({
      symbol: w.symbol,
      x: w.x,
      y: w.y,
    }));
    const sellers = new Set(
      findShipyardsSellingShipType(system, 'SHIP_PROBE').map((s) => s.symbol),
    );
    const ordered = orderShipyardsForPurchase(candidates, sellers, {
      override: cfg.reinvestYard,
      from: coordsOf(ferry.nav.waypointSymbol) ?? coordsOf(agent.headquarters),
    });
    if (ordered.length === 0) {
      log.info(`provision: no shipyard found in ${system}; skipping buy`);
    } else {
      for (const yardSymbol of ordered) {
        if (bought >= buyCount) break;
        if (ferry.nav.waypointSymbol !== yardSymbol) ferry = await travelTo(api, ferry, yardSymbol);
        let soldHere = false;
        while (bought < buyCount) {
          const yard = await scanShipyard(api, system, yardSymbol);
          const offer = (yard.ships ?? []).find((s) => s.type === 'SHIP_PROBE');
          if (!offer) break;
          soldHere = true; // this yard stocks probes; don't wander to others
          if (agent.credits - cfg.reserve < offer.purchasePrice) break;
          const res = await purchaseShipAt(api, 'SHIP_PROBE' as ShipType, yardSymbol, {
            maxPrice: offer.purchasePrice + cfg.reserve,
          });
          if (!res.ship) break;
          bought++;
          agent = { ...agent, credits: res.credits };
        }
        if (soldHere) break;
        log.info(`provision: ${yardSymbol} does not sell SHIP_PROBE; trying next yard`);
      }
      if (bought > 0) log.info(`provision: bought ${bought} probe(s) this cycle`);
    }
  }

  // Re-plan over ALL current probes (including any just bought) and persist.
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
 * Repair any worn ships. Each repair is capped at the spendable surplus
 * (credits - reserve) so maintenance never eats the reserve, and healthy ships
 * are skipped cheaply by the condition check before any travel. Returns the
 * number of ships repaired.
 */
export async function maybeRepairFleet(
  api: SpaceTradersApi,
  cfg: MaintenanceConfig,
): Promise<number> {
  if (!cfg.repair) return 0;
  let repaired = 0;
  const fleet = (await api.listShips()).data;
  for (const ship of fleet) {
    if (cfg.stopping()) break;
    const agent = await api.getMyAgent();
    const yardSymbol = discoverShipyard(
      systemOf(agent.headquarters),
      cfg.repairYard,
      coordsOf(ship.nav.waypointSymbol) ?? coordsOf(agent.headquarters),
    );
    if (!yardSymbol) {
      log.info(`maintenance: no shipyard found for ${ship.symbol}; skipping`);
      continue;
    }
    const before = ship.frame.condition;
    const result = await maybeRepair(api, ship, {
      shipyard: yardSymbol,
      threshold: cfg.repairThreshold,
      maxSpend: Math.max(0, agent.credits - cfg.reserve),
    });
    if (before !== undefined && (result.frame.condition ?? 0) > before) repaired++;
  }
  if (repaired > 0) log.info(`maintenance: repaired ${repaired} ship(s) this cycle`);
  return repaired;
}

export interface RepairDivertConfig {
  reserve: number;
  repairThreshold: number;
  repairYard: string | undefined;
}

/**
 * Mid-loop self-repair for the continuous fleet: a ship checks its own wear
 * between trips and diverts to a shipyard only when a component has fallen to/
 * below the threshold. Self-gating — when the ship is healthy this is a pure,
 * cheap in-memory check with no API calls, so a trade agent can call it every
 * trip. When worn, it discovers the nearest shipyard, caps the spend at the
 * spendable surplus, and repairs to full. Returns the (possibly repaired) ship.
 */
export async function repairWornShip(
  api: SpaceTradersApi,
  ship: Ship,
  cfg: RepairDivertConfig,
): Promise<Ship> {
  if (!needsRepair(ship, cfg.repairThreshold)) return ship;
  const agent = await api.getMyAgent();
  const system = systemOf(agent.headquarters);
  const yardSymbol = discoverShipyard(
    system,
    cfg.repairYard,
    coordsOf(ship.nav.waypointSymbol) ?? coordsOf(agent.headquarters),
  );
  if (!yardSymbol) {
    log.info(`repair: no shipyard found for ${ship.symbol}; deferring`);
    return ship;
  }
  return maybeRepair(api, ship, {
    shipyard: yardSymbol,
    threshold: cfg.repairThreshold,
    maxSpend: Math.max(0, agent.credits - cfg.reserve),
  });
}

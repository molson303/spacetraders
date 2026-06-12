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
  countTransactionsByWaypoint,
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
  marketPriority,
  neighborMarketPriority,
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
  /**
   * Waypoints pinned to always get a stationed probe regardless of trade volume
   * (e.g. the factory we feed for the endgame). The home jump gate, while under
   * construction, is auto-pinned on top of these. Defaults to none.
   */
  strategicMarkets?: string[];
  /** Days of transaction history used to rank market importance. Default 7. */
  stationTxWindowDays?: number;
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
 * Marketplaces eligible for a stationed probe, each tagged with a stationing
 * priority. Home-system markets are ranked by recent trade volume (busier
 * markets get a probe first) with strategic markets — operator-pinned waypoints
 * plus the home jump gate while it is under construction — floated to the top so
 * they are always covered. When the home gate is operational, hydrated markets
 * in directly-connected neighbor systems are appended at priority 0; while the
 * gate is under construction only home markets are returned. Neighbor markets
 * are ranked among themselves by their own recent trade volume (via
 * `inputs.neighborTxCounts`) while staying strictly below every home market;
 * without a resolver they fall back to a flat priority 0.
 */
export function gatherStationMarkets(
  system: string,
  inputs: {
    txCounts?: Map<string, number>;
    strategic?: Set<string>;
    /**
     * Resolver for a neighbor system's per-waypoint recent tx counts, used to
     * rank cross-system neighbor markets among themselves (busier first). When
     * omitted, neighbor markets fall back to priority 0.
     */
    neighborTxCounts?: (system: string) => Map<string, number>;
  } = {},
): StationMarket[] {
  const strategic = new Set(inputs.strategic ?? []);
  const homeGate = findJumpGatesBySystem(system)[0];
  const gateBlocked = homeGate ? isWaypointUnderConstruction(homeGate.symbol) : true;
  // We actively supply the home gate while it is under construction, so pin it
  // as strategic; once built it falls back to ordinary trade-volume ranking.
  if (homeGate && gateBlocked) strategic.add(homeGate.symbol);

  const home: StationMarket[] = findWaypointsByTrait(system, 'MARKETPLACE').map((w) => ({
    symbol: w.symbol,
    system: w.system,
    priority: marketPriority(w.symbol, { txCounts: inputs.txCounts, strategic }),
  }));

  if (!homeGate || gateBlocked) return home;

  const neighborSystems = new Set(
    (getJumpGateRow(homeGate.symbol)?.connections ?? [])
      .map((c) => systemOf(c))
      .filter((s) => s !== system),
  );
  const neighbors: StationMarket[] = [];
  for (const sys of neighborSystems) {
    const counts = inputs.neighborTxCounts?.(sys);
    for (const w of findWaypointsByTrait(sys, 'MARKETPLACE')) {
      neighbors.push({
        symbol: w.symbol,
        system: w.system,
        priority: neighborMarketPriority(counts?.get(w.symbol) ?? 0),
      });
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
 * Provision and station market-data probes. Always re-plans station assignments
 * over the current probes (so a priority change or a newly-charted market
 * re-homes probes even when not buying), and additionally — when MAX_PROBES > 0
 * and budget allows — buys fuel-free probes toward one per eligible marketplace.
 * Returns the number of probes bought.
 */
export async function maybeProvisionProbes(
  api: SpaceTradersApi,
  cfg: MaintenanceConfig,
): Promise<number> {
  let agent = await api.getMyAgent();
  let fleet = (await api.listShips()).data;
  const system = systemOf(agent.headquarters);

  const isProbe = (s: { fuel: { capacity: number } }): boolean => s.fuel.capacity === 0;
  // Rank markets by recent trade volume, pinning operator-chosen strategic
  // waypoints (and the under-construction home gate) to the top.
  const txCounts = countTransactionsByWaypoint(system, cfg.stationTxWindowDays ?? 7);
  const strategic = new Set(cfg.strategicMarkets ?? []);
  const markets: StationMarket[] = gatherStationMarkets(system, {
    txCounts,
    strategic,
    neighborTxCounts: (sys) => countTransactionsByWaypoint(sys, cfg.stationTxWindowDays ?? 7),
  });
  if (markets.length === 0) return 0;

  const existing = kvGet<StationAssignment[]>('probe_stations') ?? [];
  const probes = fleet.filter(isProbe);

  // Buy more probes only when provisioning is enabled and budget/cap allow.
  let bought = 0;
  if (cfg.maxProbes > 0) {
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
  }

  // Re-plan over ALL current probes (including any just bought) and persist, so
  // station-keeping relocates probes to the highest-priority markets even when
  // we're not buying.
  if (bought > 0) fleet = (await api.listShips()).data;
  const allProbes = fleet.filter(isProbe).map((p) => ({ symbol: p.symbol }));
  if (allProbes.length === 0) return bought;
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

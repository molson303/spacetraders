/*
 * Continuous (round-free) fleet supervisor. Where supervisor.ts runs discrete
 * orchestration rounds — every ship waits at a barrier for the slowest sibling
 * before the next round and maintenance blocks the whole fleet between rounds —
 * this launches one perpetual {@link runShipAgent} per ship and lets each loop
 * independently. A ship that finishes a trip claims its next route immediately;
 * a ship on a long leg never stalls the others. Maintenance (reinvest, probe
 * provisioning) runs on background timers instead of a fleet-wide pause.
 *
 * Coordination is a single shared {@link ClaimRegistry}: two ships never work
 * the same good or sell into the same waypoint at once. The fleet splits into a
 * local arbitrage fleet (cr/s-ranked) and a cross-gate fleet (net-profit ranked,
 * falling back to local while the home jump gate is under construction), plus a
 * single contractor.
 *
 * This is built and validated alongside the round supervisor; sup7 stays the
 * live earner until this is proven to beat the round baseline (Phase 6).
 *
 * Env (in addition to the shared maintenance vars from maintenance.ts):
 *   CROSS_SHIPS        earners dedicated to cross-gate hauling (default 2)
 *   MIN_PROFIT         minimum per-unit spread to act on (default 20)
 *   MAX_CONTRACTS      contracts the contractor completes per pipeline run (1)
 *   CONTRACTOR         "1" to reserve the largest earner as contractor (default 1)
 *   REINVEST_INTERVAL_MS   reinvest timer period (default 600000 = 10 min)
 *   PROVISION_INTERVAL_MS  probe provisioning timer period (default 600000)
 *   STATS_INTERVAL_MS      per-fleet stats snapshot period (default 60000 = 1 min)
 *   IDLE_MS            pause for a ship that found no work this trip (default 15000)
 */
import 'dotenv/config';
import { SpaceTradersApi } from './client/api.js';
import { closeDb } from './state/db.js';
import {
  hydrateShips,
  hydrateSystemWaypoints,
  hydrateMarketStructures,
  hydrateJumpGates,
  hydrateContracts,
  systemOf,
} from './state/world.js';
import {
  findArbitrageRoutes,
  findCrossSystemArbitrageRoutes,
  findJumpGatesBySystem,
  getJumpGateRow,
  getWaypointRow,
  isWaypointUnderConstruction,
} from './state/repos.js';
import { kvGet } from './state/kv.js';
import { distance } from './util/nav.js';
import { findJumpPath } from './util/jumpPath.js';
import { ClaimRegistry } from './coordinator/claimRegistry.js';
import { partitionFleet } from './coordinator/fleetPlan.js';
import { runShipAgent, type ShipAgentDeps, type ShipRole, type TripKind } from './agents/shipAgent.js';
import { runProbeAgent, type ProbeCycleDeps } from './agents/probeAgent.js';
import { runRoute, scanHere, drainStrandedCargo } from './behaviors/trader.js';
import { runRemoteTrade } from './behaviors/remoteTrader.js';
import { runContractPipeline } from './behaviors/contractPipeline.js';
import { runStationKeeping } from './behaviors/stationKeeper.js';
import { runRemoteScout } from './behaviors/remoteScout.js';
import { runScanner } from './behaviors/scanner.js';
import { maybeReinvest, maybeProvisionProbes, type MaintenanceConfig } from './fleet/maintenance.js';
import { sleep } from './client/rateLimiter.js';
import { log } from './util/logger.js';
import type { CrossSystemRoute } from './util/crossRoutes.js';
import type { StationAssignment } from './util/stations.js';
import type { Ship } from './types/index.js';

const CFG = {
  crossShips: Number(process.env.CROSS_SHIPS ?? 2),
  minProfit: Number(process.env.MIN_PROFIT ?? 20),
  maxContracts: Number(process.env.MAX_CONTRACTS ?? 1),
  contractor: (process.env.CONTRACTOR ?? '1') === '1',
  crossAntimatterCost: Number(process.env.CROSS_ANTIMATTER_COST ?? 0),
  reinvestIntervalMs: Number(process.env.REINVEST_INTERVAL_MS ?? 600_000),
  provisionIntervalMs: Number(process.env.PROVISION_INTERVAL_MS ?? 600_000),
  probeIntervalMs: Number(process.env.PROBE_INTERVAL_MS ?? 120_000),
  scanLimit: Number(process.env.SCAN_LIMIT ?? 20),
  scanBudgetMs: Number(process.env.SCAN_BUDGET_MS ?? 120_000),
  statsIntervalMs: Number(process.env.STATS_INTERVAL_MS ?? 60_000),
  idleMs: Number(process.env.IDLE_MS ?? 15_000),
  // Shared maintenance config (mirrors supervisor.ts env names).
  reinvest: (process.env.REINVEST ?? '1') === '1',
  reserve: Number(process.env.RESERVE ?? 75000),
  maxShips: Number(process.env.MAX_SHIPS ?? 8),
  maxProbes: Number(process.env.MAX_PROBES ?? 0),
  probeCostEst: Number(process.env.PROBE_COST_EST ?? 15000),
  reinvestYard: process.env.REINVEST_YARD?.trim() || undefined,
  shipCostEst: Number(process.env.SHIP_COST_EST ?? 90000),
  minRoi: Number(process.env.MIN_ROI ?? 0),
};

let stopping = false;
function requestStop(signal: string): void {
  if (stopping) {
    log.warn(`${signal} again — exiting now`);
    process.exit(1);
  }
  log.warn(`${signal} received — draining agents, will exit when trips finish`);
  stopping = true;
}
process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));

interface RoleStats {
  trips: number;
  profit: number;
  contracts: number;
}
const stats: Record<ShipRole, RoleStats> = {
  local: { trips: 0, profit: 0, contracts: 0 },
  cross: { trips: 0, profit: 0, contracts: 0 },
  contractor: { trips: 0, profit: 0, contracts: 0 },
};

async function main(): Promise<void> {
  const api = new SpaceTradersApi();
  const agent = await api.getMyAgent();
  const system = systemOf(agent.headquarters);
  const baseline = agent.credits;
  log.info(
    `fleet start | credits=${baseline} system=${system} crossShips=${CFG.crossShips} ` +
      `contractor=${CFG.contractor} maxShips=${CFG.maxShips}`,
  );

  // Hydrate the world once up front; probes + the provisioning timer keep prices
  // fresh after that, and route candidates are read live from the DB each trip.
  await hydrateShips(api);
  await hydrateSystemWaypoints(api, system);
  await hydrateMarketStructures(api, system);
  await hydrateJumpGates(api, system);
  await hydrateContracts(api);

  const registry = new ClaimRegistry();

  // ---- Shared route providers (read live each trip) ----------------------
  const distanceOf = (from: string, to: string): number => {
    const a = getWaypointRow(from);
    const b = getWaypointRow(to);
    return a && b ? distance(a, b) : 0;
  };
  const gateNeighbors = (g: string): string[] => getJumpGateRow(g)?.connections ?? [];
  const hopsBetween = (from: string, to: string): number | undefined => {
    const gate = findJumpGatesBySystem(from)[0]?.symbol;
    if (!gate) return undefined;
    const path = findJumpPath(gate, to, gateNeighbors, systemOf);
    return path === undefined ? undefined : path.length;
  };
  const gateOpen = (): boolean => {
    const homeGate = findJumpGatesBySystem(system)[0];
    return homeGate ? !isWaypointUnderConstruction(homeGate.symbol) : false;
  };
  const localCandidates = (): ReturnType<typeof findArbitrageRoutes> =>
    findArbitrageRoutes(system, CFG.minProfit, 30);
  const crossCandidates = (): CrossSystemRoute[] =>
    gateOpen() ? (findCrossSystemArbitrageRoutes(CFG.minProfit) as CrossSystemRoute[]) : [];

  const onTrip = (e: { ship: string; role: ShipRole; kind: TripKind; profit: number }): void => {
    const b = stats[e.role];
    b.trips++;
    b.profit += e.profit;
    if (e.kind === 'contract') b.contracts++;
  };

  // ---- Agent launch ------------------------------------------------------
  const running = new Set<string>();
  const agentJobs: Promise<unknown>[] = [];

  const depsFor = (): ShipAgentDeps => ({
    localCandidates,
    crossCandidates,
    execLocal: (ship, route) => runRoute(api, ship, route, CFG.minProfit),
    execCross: (ship, route) => runRemoteTrade(api, ship, route, CFG.minProfit),
    execContract: (ship) =>
      runContractPipeline(api, ship, system, {
        maxContracts: CFG.maxContracts,
        hq: agent.headquarters,
      }),
    refetchShip: (sym) => api.getShip(sym),
    distanceOf,
    hopsBetween,
    gateOpen,
    stopping: () => stopping,
    idleDelay: () => sleep(CFG.idleMs),
    onTrip,
  });

  const launch = (ship: Ship, role: ShipRole): void => {
    if (running.has(ship.symbol)) return;
    running.add(ship.symbol);
    const job = (async () => {
      try {
        // Clear any stale cargo the ship is holding before its first trip so a
        // hauler that started full of mismatched goods doesn't churn forever.
        await scanHere(api, ship);
        const drained = await drainStrandedCargo(api, ship, system);
        await runShipAgent(drained, registry, depsFor(), {
          role,
          system,
          minProfit: CFG.minProfit,
          antimatterCost: CFG.crossAntimatterCost,
          holdSize: drained.cargo.capacity,
        });
      } catch (err) {
        log.error(`${ship.symbol} agent crashed: ${(err as Error).message}`);
      } finally {
        running.delete(ship.symbol);
      }
    })();
    agentJobs.push(job);
  };

  // Partition the current fleet and launch an agent for every earner that isn't
  // already running. Called at startup and after reinvest buys new earners, so
  // newly purchased ships join the continuous fleet without a restart.
  const syncAgents = async (): Promise<void> => {
    const ships = (await api.listShips()).data;
    const part = partitionFleet(ships, {
      crossShips: CFG.crossShips,
      enableContractor: CFG.contractor,
    });
    if (part.contractor) launch(part.contractor, 'contractor');
    for (const s of part.cross) launch(s, 'cross');
    for (const s of part.local) launch(s, 'local');
    log.info(
      `agents: contractor=${part.contractor?.symbol ?? 'none'} ` +
        `cross=[${part.cross.map((s) => s.symbol).join(', ')}] ` +
        `local=[${part.local.map((s) => s.symbol).join(', ')}] (running=${running.size})`,
    );
  };

  await syncAgents();

  // ---- Probe fleet -------------------------------------------------------
  // Stationed probes keep the market price map fresh; flex probes scout neighbor
  // systems to seed the cross-gate source. Runs as one perpetual agent on its
  // own interval, parallel to the trade agents.
  const probeDeps: ProbeCycleDeps = {
    listScouts: async () => (await api.listShips()).data.filter((s) => s.fuel.capacity === 0),
    getStations: () => kvGet<StationAssignment[]>('probe_stations') ?? [],
    stationKeep: (probes, stationed, allowCross) =>
      runStationKeeping(api, probes, stationed, { allowCrossSystem: allowCross }),
    remoteScout: (ship) => runRemoteScout(api, ship, system, { budgetMs: CFG.scanBudgetMs }),
    scan: (ship) => runScanner(api, ship, system, { limit: CFG.scanLimit, budgetMs: CFG.scanBudgetMs }),
    refetchShip: (sym) => api.getShip(sym),
    gateOpen,
  };
  const probeJob = runProbeAgent(probeDeps, {
    intervalMs: CFG.probeIntervalMs,
    stopping: () => stopping,
    delay: (ms) => sleep(ms),
  });

  const cfg: MaintenanceConfig = {
    reinvest: CFG.reinvest,
    reserve: CFG.reserve,
    maxShips: CFG.maxShips,
    maxProbes: CFG.maxProbes,
    probeCostEst: CFG.probeCostEst,
    minProfit: CFG.minProfit,
    reinvestYard: CFG.reinvestYard,
    shipCostEst: CFG.shipCostEst,
    minRoi: CFG.minRoi,
    repair: false, // continuous repair is a mid-loop self-divert (Phase 5), not a timer
    repairThreshold: 0,
    repairYard: undefined,
    stopping: () => stopping,
  };

  // ---- Background maintenance + stats timers -----------------------------
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => Promise<void> | void): void => {
    timers.push(setInterval(() => void Promise.resolve(fn()).catch((e) => log.warn(`timer: ${e}`)), ms));
  };

  every(CFG.reinvestIntervalMs, async () => {
    if (stopping) return;
    const bought = await maybeReinvest(api, cfg);
    if (bought > 0) await syncAgents(); // give the new earners agents
  });
  every(CFG.provisionIntervalMs, async () => {
    if (stopping) return;
    await maybeProvisionProbes(api, cfg);
  });
  every(CFG.statsIntervalMs, async () => {
    const cur = (await api.getMyAgent()).credits;
    log.info(
      `stats | credits=${cur} (Δ${cur - baseline}) running=${running.size} claims=${registry.size()} ` +
        `local{trips=${stats.local.trips} profit=${stats.local.profit}} ` +
        `cross{trips=${stats.cross.trips} profit=${stats.cross.profit}} ` +
        `contractor{trips=${stats.contractor.trips} contracts=${stats.contractor.contracts} profit=${stats.contractor.profit}}`,
    );
  });

  // ---- Wait for stop, then drain -----------------------------------------
  while (!stopping) await sleep(1000);

  log.info('draining: waiting for in-flight trips to finish...');
  for (const t of timers) clearInterval(t);
  await Promise.allSettled([...agentJobs, probeJob]);

  const finalCredits = (await api.getMyAgent()).credits;
  log.info(
    `fleet stopped | credits=${finalCredits} (total Δ${finalCredits - baseline}) ` +
      `trips: local=${stats.local.trips} cross=${stats.cross.trips} contractor=${stats.contractor.trips}`,
  );
  closeDb();
  process.exit(0);
}

main().catch((err) => {
  log.error('fleet crashed', err);
  closeDb();
  process.exit(1);
});

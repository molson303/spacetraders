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
 *   REMOTE_TRADE_SYSTEMS  comma list of remote system symbols to station in-system
 *                      traders in (e.g. "X1-FU76,X1-CN42"); off when empty
 *   REMOTE_TRADE_SHIPS    earners stationed in EACH listed remote system (default 1)
 *   MIN_PROFIT         minimum per-unit spread to act on (default 20)
 *   MAX_CONTRACTS      contracts the contractor completes per pipeline run (1)
 *   CONTRACTOR         "1" to reserve the largest earner as contractor (default 1)
 *   REINVEST_INTERVAL_MS   reinvest timer period (default 600000 = 10 min)
 *   PROVISION_INTERVAL_MS  probe provisioning timer period (default 600000)
 *   MAX_PROBES_PER_CYCLE   probes bought per provisioning cycle (default 3) — caps
 *                      same-type price escalation by re-scanning each cycle
 *   STATS_INTERVAL_MS      per-fleet stats snapshot period (default 60000 = 1 min)
 *   IDLE_MS            pause for a ship that found no work this trip (default 15000)
 *   EXCLUDE_SHIPS      comma list of ship symbols to drop from the trade fleet,
 *                      dedicated to an out-of-band job (e.g. scripts/feedFactory.ts)
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
import { getWallet, setWallet } from './state/wallet.js';
import { distance } from './util/nav.js';
import { findJumpPath } from './util/jumpPath.js';
import { ClaimRegistry } from './coordinator/claimRegistry.js';
import { partitionFleet } from './coordinator/fleetPlan.js';
import { runShipAgent, type ShipAgentDeps, type ShipRole, type TripKind } from './agents/shipAgent.js';
import { runProbeAgent, type ProbeCycleDeps } from './agents/probeAgent.js';
import { runScoutAgent, type ScoutCycleDeps } from './agents/scoutAgent.js';
import { runRoute, scanHere, drainStrandedCargo } from './behaviors/trader.js';
import { runRemoteTrade } from './behaviors/remoteTrader.js';
import { crossSystemTravelTo } from './util/crossNav.js';
import { runContractPipeline } from './behaviors/contractPipeline.js';
import { runStationKeeping } from './behaviors/stationKeeper.js';
import { runRemoteScout } from './behaviors/remoteScout.js';
import { runScanner } from './behaviors/scanner.js';
import { maybeReinvest, maybeProvisionProbes, repairWornShip, type MaintenanceConfig } from './fleet/maintenance.js';
import { sleep } from './client/rateLimiter.js';
import { log } from './util/logger.js';
import { nonReentrant } from './util/concurrency.js';
import type { CrossSystemRoute } from './util/crossRoutes.js';
import type { StationAssignment } from './util/stations.js';
import type { Ship } from './types/index.js';

const CFG = {
  crossShips: Number(process.env.CROSS_SHIPS ?? 2),
  // Remote in-system traders: earners relocated to live in a remote system and
  // run in-system arbitrage there (no jump back home per trade). REMOTE_TRADE_SYSTEMS
  // is a comma list of system symbols; REMOTE_TRADE_SHIPS is how many earners to
  // station in EACH listed system. Off by default (no systems listed).
  remoteTradeSystems: (process.env.REMOTE_TRADE_SYSTEMS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  remoteTradeShips: Number(process.env.REMOTE_TRADE_SHIPS ?? 1),
  minProfit: Number(process.env.MIN_PROFIT ?? 20),
  maxContracts: Number(process.env.MAX_CONTRACTS ?? 1),
  contractor: (process.env.CONTRACTOR ?? '1') === '1',
  // Per-trade spend cap as a fraction of the LIVE wallet (0 disables). Mirrors
  // supervisor.ts: bounds capital any single trip can sink into one position so
  // a big fill can't crater a thin sink. The depth cap is the primary thin-sink
  // guard; this is the secondary whole-wallet-dump guard.
  maxTradeFraction: Number(process.env.MAX_TRADE_FRACTION ?? 0.25),
  crossAntimatterCost: Number(process.env.CROSS_ANTIMATTER_COST ?? 0),
  reinvestIntervalMs: Number(process.env.REINVEST_INTERVAL_MS ?? 600_000),
  provisionIntervalMs: Number(process.env.PROVISION_INTERVAL_MS ?? 600_000),
  probeIntervalMs: Number(process.env.PROBE_INTERVAL_MS ?? 120_000),
  // Remote scouting runs on its own slow loop, fully decoupled from the probe
  // cycle so a ~50-min fuel-free round-trip never freezes station-keeping.
  scoutIntervalMs: Number(process.env.SCOUT_INTERVAL_MS ?? 600_000),
  scanLimit: Number(process.env.SCAN_LIMIT ?? 20),
  scanBudgetMs: Number(process.env.SCAN_BUDGET_MS ?? 120_000),
  // Bounds in-system scanning per neighbor (from arrival), not the slow probe
  // travel out to the gate — kept separate from the local scanner's budget.
  scoutBudgetMs: Number(process.env.SCOUT_BUDGET_MS ?? 600_000),
  statsIntervalMs: Number(process.env.STATS_INTERVAL_MS ?? 60_000),
  idleMs: Number(process.env.IDLE_MS ?? 15_000),
  // Shared maintenance config (mirrors supervisor.ts env names).
  reinvest: (process.env.REINVEST ?? '1') === '1',
  reserve: Number(process.env.RESERVE ?? 75000),
  maxShips: Number(process.env.MAX_SHIPS ?? 8),
  maxProbes: Number(process.env.MAX_PROBES ?? 0),
  maxProbesPerCycle: Number(process.env.MAX_PROBES_PER_CYCLE ?? 3),
  scoutProbes: Number(process.env.SCOUT_PROBES ?? 0),
  probeCostEst: Number(process.env.PROBE_COST_EST ?? 15000),
  reinvestYard: process.env.REINVEST_YARD?.trim() || undefined,
  shipCostEst: Number(process.env.SHIP_COST_EST ?? 90000),
  minRoi: Number(process.env.MIN_ROI ?? 0),
  repairThreshold: Number(process.env.REPAIR_THRESHOLD ?? 0.4),
  repairYard: process.env.REPAIR_YARD?.trim() || process.env.REINVEST_YARD?.trim() || undefined,
  repairEnabled: (process.env.REPAIR ?? '1') === '1',
  // Ship symbols dropped from the trade fleet — dedicated to an out-of-band job
  // (e.g. feeding F48's inputs via scripts/feedFactory.ts) so the continuous
  // fleet never claims them. Mirrors the orchestrator's EXCLUDE_SHIPS.
  excludeShips: (process.env.EXCLUDE_SHIPS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Waypoints always given a stationed probe regardless of trade volume (e.g.
  // the factory we feed). The under-construction home gate is auto-pinned too.
  strategicMarkets: (process.env.STRATEGIC_MARKETS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  stationTxWindowDays: Number(process.env.STATION_TX_WINDOW_DAYS ?? 7),
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
  remote: { trips: 0, profit: 0, contracts: 0 },
  contractor: { trips: 0, profit: 0, contracts: 0 },
};

async function main(): Promise<void> {
  const api = new SpaceTradersApi();
  const agent = await api.getMyAgent();
  const system = systemOf(agent.headquarters);
  const baseline = agent.credits;
  log.info(
    `fleet start | credits=${baseline} system=${system} crossShips=${CFG.crossShips} ` +
      `contractor=${CFG.contractor} maxShips=${CFG.maxShips} maxTradeFraction=${CFG.maxTradeFraction}` +
      (CFG.excludeShips.length ? ` excludeShips=[${CFG.excludeShips.join(', ')}]` : ''),
  );

  // Hydrate the world once up front; probes + the provisioning timer keep prices
  // fresh after that, and route candidates are read live from the DB each trip.
  await hydrateShips(api);
  await hydrateSystemWaypoints(api, system);
  await hydrateMarketStructures(api, system);
  await hydrateJumpGates(api, system);
  await hydrateContracts(api);

  // Hydrate each remote trade system so in-system traders have waypoints (for
  // nav/distance), market structures (for arbitrage candidates), and the gate
  // (for the one-time relocation jump). Probes keep these prices fresh after.
  for (const sys of CFG.remoteTradeSystems) {
    try {
      await hydrateSystemWaypoints(api, sys);
      await hydrateMarketStructures(api, sys);
      await hydrateJumpGates(api, sys);
      log.info(`hydrated remote trade system ${sys}`);
    } catch (err) {
      log.warn(`could not hydrate remote trade system ${sys}: ${(err as Error).message}`);
    }
  }

  const registry = new ClaimRegistry();

  // Live per-trade spend cap, resolved fresh each trip as a fraction of the
  // current wallet (the wallet mirror is updated by every buy/sell). Keeps the
  // cap proportional to the real balance instead of a stale snapshot.
  setWallet(agent.credits);
  const maxTradeSpend: (() => number | undefined) | undefined =
    CFG.maxTradeFraction > 0
      ? () => {
          const c = getWallet();
          return c === undefined ? undefined : Math.max(0, Math.floor(c * CFG.maxTradeFraction));
        }
      : undefined;

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
  // Local candidates for an arbitrary system — remote in-system traders read
  // their own system's routes instead of home's.
  const localCandidatesFor = (sys: string): (() => ReturnType<typeof findArbitrageRoutes>) =>
    sys === system ? localCandidates : () => findArbitrageRoutes(sys, CFG.minProfit, 30);
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

  const depsFor = (tradeSystem: string = system): ShipAgentDeps => ({
    localCandidates: localCandidatesFor(tradeSystem),
    crossCandidates,
    execLocal: (ship, route) => runRoute(api, ship, route, CFG.minProfit, maxTradeSpend),
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
    repairIfWorn: CFG.repairEnabled
      ? (ship) =>
          repairWornShip(api, ship, {
            reserve: CFG.reserve,
            repairThreshold: CFG.repairThreshold,
            repairYard: CFG.repairYard,
          })
      : undefined,
  });

  const launch = (ship: Ship, role: ShipRole, tradeSystem: string = system): void => {
    if (running.has(ship.symbol)) return;
    running.add(ship.symbol);
    const job = (async () => {
      try {
        let s = ship;
        // Remote in-system trader: relocate once to its trade system (one jump
        // out), then trade in-system there forever — no jump back home per trip.
        if (tradeSystem !== system && systemOf(s.nav.waypointSymbol) !== tradeSystem) {
          const gate = findJumpGatesBySystem(tradeSystem)[0];
          if (gate) {
            log.info(`${s.symbol} relocating to ${tradeSystem} for in-system trading`);
            s = await crossSystemTravelTo(api, s, gate.symbol);
            if (systemOf(s.nav.waypointSymbol) !== tradeSystem) {
              log.warn(`${s.symbol} could not relocate to ${tradeSystem}; trading where it landed`);
            }
          } else {
            log.warn(`${s.symbol} no known gate for ${tradeSystem}; cannot relocate`);
          }
        }
        // The system the ship actually ended up in drives its candidates/drain,
        // so a failed relocation degrades to trading wherever it is rather than
        // claiming routes it can't reach.
        const homeOf = systemOf(s.nav.waypointSymbol);
        // Clear any stale cargo the ship is holding before its first trip so a
        // hauler that started full of mismatched goods doesn't churn forever.
        await scanHere(api, s);
        const drained = await drainStrandedCargo(api, s, homeOf);
        await runShipAgent(drained, registry, depsFor(homeOf), {
          role,
          system: homeOf,
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
    const ships = await api.listAllShips();
    const part = partitionFleet(ships, {
      crossShips: CFG.crossShips,
      enableContractor: CFG.contractor,
      excludeShips: CFG.excludeShips,
      remoteSystems: CFG.remoteTradeSystems.map((sys) => ({
        system: sys,
        ships: CFG.remoteTradeShips,
      })),
    });
    if (part.contractor) launch(part.contractor, 'contractor');
    for (const s of part.cross) launch(s, 'cross');
    for (const r of part.remote) launch(r.ship, 'remote', r.system);
    for (const s of part.local) launch(s, 'local');
    log.info(
      `agents: contractor=${part.contractor?.symbol ?? 'none'} ` +
        `cross=[${part.cross.map((s) => s.symbol).join(', ')}] ` +
        `remote=[${part.remote.map((r) => `${r.ship.symbol}@${r.system}`).join(', ')}] ` +
        `local=[${part.local.map((s) => s.symbol).join(', ')}] (running=${running.size})`,
    );
  };

  await syncAgents();

  // ---- Probe fleet -------------------------------------------------------
  // Stationed probes keep the market price map fresh; flex probes scan the home
  // system. Runs as one perpetual agent on its own interval, parallel to the
  // trade agents. Remote scouting is a separate loop (below) so a slow scout
  // trip never blocks station-keeping or the cross-system ferries it drives.
  const probeDeps: ProbeCycleDeps = {
    listScouts: async () => (await api.listAllShips()).filter((s) => s.fuel.capacity === 0),
    getStations: () => kvGet<StationAssignment[]>('probe_stations') ?? [],
    stationKeep: (probes, stationed, allowCross) =>
      runStationKeeping(api, probes, stationed, { allowCrossSystem: allowCross }),
    scan: (ship) => runScanner(api, ship, system, { limit: CFG.scanLimit, budgetMs: CFG.scanBudgetMs }),
    gateOpen,
  };
  const probeJob = runProbeAgent(probeDeps, {
    intervalMs: CFG.probeIntervalMs,
    stopping: () => stopping,
    delay: (ms) => sleep(ms),
  });

  // ---- Remote scout ------------------------------------------------------
  // Decoupled from the probe cycle: rides the gates into unscanned neighbor
  // systems to seed cross-system arbitrage. Sends the index-0 flex probe (the
  // slot the probe cycle reserves) on one ~50-min round-trip per slow tick;
  // a no-op while every probe is stationed.
  const scoutDeps: ScoutCycleDeps = {
    listScouts: async () => (await api.listAllShips()).filter((s) => s.fuel.capacity === 0),
    getStations: () => kvGet<StationAssignment[]>('probe_stations') ?? [],
    remoteScout: (ship) => runRemoteScout(api, ship, system, { budgetMs: CFG.scoutBudgetMs }),
    gateOpen,
  };
  const scoutJob = runScoutAgent(scoutDeps, {
    intervalMs: CFG.scoutIntervalMs,
    stopping: () => stopping,
    delay: (ms) => sleep(ms),
  });

  const cfg: MaintenanceConfig = {
    reinvest: CFG.reinvest,
    reserve: CFG.reserve,
    maxShips: CFG.maxShips,
    maxProbes: CFG.maxProbes,
    maxProbesPerCycle: CFG.maxProbesPerCycle,
    scoutProbes: CFG.scoutProbes,
    probeCostEst: CFG.probeCostEst,
    minProfit: CFG.minProfit,
    reinvestYard: CFG.reinvestYard,
    shipCostEst: CFG.shipCostEst,
    minRoi: CFG.minRoi,
    repair: false, // continuous repair is a mid-loop self-divert (Phase 5), not a timer
    repairThreshold: 0,
    repairYard: undefined,
    strategicMarkets: CFG.strategicMarkets,
    stationTxWindowDays: CFG.stationTxWindowDays,
    stopping: () => stopping,
  };

  // ---- Background maintenance + stats timers -----------------------------
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => Promise<void> | void): void => {
    timers.push(setInterval(() => void Promise.resolve(fn()).catch((e) => log.warn(`timer: ${e}`)), ms));
  };

  // Maintenance tasks can outlast their interval (provisioning travels, scans,
  // and buys). Wrap each in nonReentrant so a slow cycle skips the overlapping
  // tick instead of running concurrently on stale fleet state and overshooting
  // the probe/ship caps.
  every(
    CFG.reinvestIntervalMs,
    nonReentrant(async () => {
      if (stopping) return;
      const bought = await maybeReinvest(api, cfg);
      if (bought > 0) await syncAgents(); // give the new earners agents
    }),
  );
  every(
    CFG.provisionIntervalMs,
    nonReentrant(async () => {
      if (stopping) return;
      await maybeProvisionProbes(api, cfg);
    }),
  );
  every(CFG.statsIntervalMs, async () => {
    const cur = (await api.getMyAgent()).credits;
    log.info(
      `stats | credits=${cur} (Δ${cur - baseline}) running=${running.size} claims=${registry.size()} ` +
        `local{trips=${stats.local.trips} profit=${stats.local.profit}} ` +
        `remote{trips=${stats.remote.trips} profit=${stats.remote.profit}} ` +
        `cross{trips=${stats.cross.trips} profit=${stats.cross.profit}} ` +
        `contractor{trips=${stats.contractor.trips} contracts=${stats.contractor.contracts} profit=${stats.contractor.profit}}`,
    );
  });

  // ---- Wait for stop, then drain -----------------------------------------
  while (!stopping) await sleep(1000);

  log.info('draining: waiting for in-flight trips to finish...');
  for (const t of timers) clearInterval(t);
  await Promise.allSettled([...agentJobs, probeJob, scoutJob]);

  const finalCredits = (await api.getMyAgent()).credits;
  log.info(
    `fleet stopped | credits=${finalCredits} (total Δ${finalCredits - baseline}) ` +
      `trips: local=${stats.local.trips} remote=${stats.remote.trips} cross=${stats.cross.trips} contractor=${stats.contractor.trips}`,
  );
  closeDb();
  process.exit(0);
}

main().catch((err) => {
  log.error('fleet crashed', err);
  closeDb();
  process.exit(1);
});

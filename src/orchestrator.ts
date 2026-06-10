/*
 * Fleet orchestrator: hydrate world + fleet, then run an income behavior for
 * every capable hauler concurrently. Because an agent may hold only ONE active
 * contract at a time, exactly one hauler is the "contractor" (claim/negotiate ->
 * buy -> haul -> fulfill) while every other hauler runs arbitrage trade loops.
 * Free-moving scouts (probes) scan markets to feed the price map.
 *
 * `runFleetRound` performs ONE round (every behavior runs to its finite limit).
 * The persistent supervisor (supervisor.ts) calls it repeatedly. Running this
 * file directly executes a single round.
 *
 * Env (single-round defaults):
 *   MAX_CONTRACTS  contracts the contractor completes (default 1)
 *   TRADE_CYCLES   arbitrage cycles each trader runs (default 5)
 *   MIN_PROFIT     minimum per-unit spread a trader will act on (default 20)
 *   SCAN_LIMIT     markets each scanner visits (default 30)
 *   CROSS_ANTIMATTER_COST  est. credits/jump used to net cross-system routes (default 0)
 */
import { SpaceTradersApi } from './client/api.js';
import { closeDb } from './state/db.js';
import {
  hydrateContracts,
  hydrateJumpGates,
  hydrateMarketStructures,
  hydrateShips,
  hydrateSystemWaypoints,
  systemOf,
} from './state/world.js';
import { runContractPipeline } from './behaviors/contractPipeline.js';
import { runTrader } from './behaviors/trader.js';
import { runScanner } from './behaviors/scanner.js';
import { runRemoteScout } from './behaviors/remoteScout.js';
import { runRemoteTrade } from './behaviors/remoteTrader.js';
import { runStationKeeping } from './behaviors/stationKeeper.js';
import { canMine, runMiner } from './behaviors/miningTrader.js';
import {
  findArbitrageRoutes,
  findCrossSystemArbitrageRoutes,
  findJumpGatesBySystem,
  findWaypointsByTrait,
  getJumpGateRow,
  getWaypointRow,
  isWaypointUnderConstruction,
} from './state/repos.js';
import { kvGet } from './state/kv.js';
import { getWallet, setWallet } from './state/wallet.js';
import { assignRoutes, routeCreditsPerSecond, routeScore } from './util/routes.js';
import { findJumpPath } from './util/jumpPath.js';
import { rankCrossRoutes, assignCrossRoutes, type CrossSystemRoute } from './util/crossRoutes.js';
import { partitionProbes, type StationAssignment } from './util/stations.js';
import { distance } from './util/nav.js';
import { log } from './util/logger.js';
import type { Ship } from './types/index.js';

export interface FleetRoundOptions {
  maxContracts?: number;
  tradeCycles?: number;
  minProfit?: number;
  scanLimit?: number;
  /** Time budget for scanners so they never become the round's long pole. */
  scanBudgetMs?: number;
  /** How many mining-capable ships to run as dedicated miners (default 0). */
  miners?: number;
  /** Estimated antimatter credits spent per jump, used to net cross-system routes (default 0). */
  crossAntimatterCost?: number;
  /**
   * Wall-clock budget for the earners. Traders finish their in-flight cycle but
   * start no new one past the deadline, so one ship on long-leg routes can't keep
   * the whole fleet waiting. 0 = unbounded (default).
   */
  roundBudgetMs?: number;
  /**
   * Fraction of the wallet a single trader may spend on one buy->sell cycle.
   * Bounds per-trade capital at risk so one ship can't dump the whole wallet
   * into a thin-sink position (the JEWELRY/FOOD saturation losses) and starve
   * sibling traders of capital. 0 = unbounded (default).
   */
  maxTradeFraction?: number;
}

export interface FleetRoundResult {
  startCredits: number;
  endCredits: number;
  haulers: number;
  scouts: number;
  contractsCompleted: number;
  traderProfit: number;
  scannedMarkets: number;
  minerEarnings: number;
  remoteProfit: number;
  scoutedSystems: number;
  stationsRefreshed: number;
}

/** A ship that can haul cargo and move under its own fuel. */
function isHauler(s: Ship): boolean {
  return s.cargo.capacity > 0 && s.fuel.capacity > 0;
}

/**
 * Execute one full orchestration round: re-hydrate the world & fleet, assign
 * roles (1 contractor + N traders + scouts as scanners), and run them all
 * concurrently until each hits its finite limit. Does NOT close the DB so it
 * can be called repeatedly by the supervisor.
 */
export async function runFleetRound(
  api: SpaceTradersApi,
  opts: FleetRoundOptions = {},
): Promise<FleetRoundResult> {
  const maxContracts = opts.maxContracts ?? 1;
  const tradeCycles = opts.tradeCycles ?? 5;
  const minProfit = opts.minProfit ?? 20;
  const scanLimit = opts.scanLimit ?? 30;
  const scanBudgetMs = opts.scanBudgetMs ?? 180000;
  const minerCount = Math.max(0, opts.miners ?? 0);
  const crossAntimatterCost = Math.max(0, opts.crossAntimatterCost ?? 0);
  const roundBudgetMs = Math.max(0, opts.roundBudgetMs ?? 0);
  // Earners finish their in-flight cycle but start no new one past this point.
  const deadline = roundBudgetMs > 0 ? Date.now() + roundBudgetMs : Infinity;
  const roundExpired = (): boolean => Date.now() >= deadline;

  const agent = await api.getMyAgent();
  const system = systemOf(agent.headquarters);

  // Per-trade spend cap, sized as a fraction of the LIVE wallet. Bounds how much
  // capital any single trader can sink into one position (thin-sink saturation
  // protection); 0 fraction disables the cap. Resolved fresh on each trade via
  // the wallet mirror (updated by every buy/sell) so the cap grows with the
  // wallet during a long round instead of freezing at the round-start balance —
  // a stale low cap otherwise locks traders out of high-value routes all round.
  const maxTradeFraction = Math.max(0, opts.maxTradeFraction ?? 0);
  setWallet(agent.credits);
  const maxTradeSpend: (() => number | undefined) | undefined =
    maxTradeFraction > 0
      ? () => {
          const c = getWallet();
          return c === undefined ? undefined : Math.max(0, Math.floor(c * maxTradeFraction));
        }
      : undefined;

  const ships = await hydrateShips(api);
  await hydrateSystemWaypoints(api, system);
  await hydrateMarketStructures(api, system);
  await hydrateJumpGates(api, system);
  await hydrateContracts(api);

  // Ships listed in EXCLUDE_SHIPS are dropped from this round entirely (haulers
  // and scouts). Used to dedicate a ship to an out-of-band job (e.g. supplying
  // the jump-gate construction site) without the round fighting over it.
  const excluded = new Set(
    (process.env.EXCLUDE_SHIPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const usableShips = excluded.size ? ships.filter((s) => !excluded.has(s.symbol)) : ships;
  if (excluded.size) {
    log.info(`excluding ${excluded.size} ship(s) from round: ${[...excluded].join(', ')}`);
  }

  const haulers = usableShips.filter(isHauler);
  const scouts = usableShips.filter((s) => !isHauler(s));
  log.info(
    `fleet: ${haulers.length} hauler(s) [${haulers.map((s) => s.symbol).join(', ')}], ` +
      `${scouts.length} scout(s) [${scouts.map((s) => s.symbol).join(', ')}]`,
  );

  const result: FleetRoundResult = {
    startCredits: agent.credits,
    endCredits: agent.credits,
    haulers: haulers.length,
    scouts: scouts.length,
    contractsCompleted: 0,
    traderProfit: 0,
    scannedMarkets: 0,
    minerEarnings: 0,
    remoteProfit: 0,
    scoutedSystems: 0,
    stationsRefreshed: 0,
  };

  if (haulers.length === 0) {
    log.warn('no haulers available this round');
    return result;
  }

  // Opt-in mining: reserve the N largest mining-capable ships as dedicated
  // miners (default 0 => unchanged behavior). They're pulled out of the earner
  // pool so the contractor/trader split below only considers the rest.
  const mineCapable = [...haulers].filter(canMine).sort((a, b) => b.cargo.capacity - a.cargo.capacity);
  const miners = mineCapable.slice(0, minerCount);
  const minerSet = new Set(miners.map((s) => s.symbol));
  const earners = haulers.filter((s) => !minerSet.has(s.symbol));
  if (miners.length > 0) {
    log.info(`miners: [${miners.map((s) => s.symbol).join(', ')}]`);
  }

  // One contractor (largest cargo wins), the rest trade arbitrage. Drawn from
  // the non-miner earner pool; may be empty if every hauler is mining.
  const sorted = [...earners].sort((a, b) => b.cargo.capacity - a.cargo.capacity);
  const contractor = sorted[0];
  const traders = sorted.slice(1);
  log.info(
    `roles: contractor=${contractor?.symbol ?? 'none'} traders=[${traders.map((s) => s.symbol).join(', ')}] ` +
      `scanners=[${scouts.map((s) => s.symbol).join(', ')}]`,
  );

  // Cross-system travel requires the home jump gate to be operational. While the
  // gate is under construction every jump out of the system fails, so disable
  // remote arbitrage/scouting and cross-system station-keeping this round.
  const homeGate = findJumpGatesBySystem(system)[0];
  const gateBlocked = homeGate ? isWaypointUnderConstruction(homeGate.symbol) : true;
  if (gateBlocked) {
    log.info(
      `jump gate ${homeGate?.symbol ?? system} unavailable (under construction); cross-system disabled this round`,
    );
  }

  // Stationed probes sit at markets and refresh live prices in place. Run this
  // BEFORE route-finding so traders compute against fresh data instead of stale
  // spreads (the cause of wasted "bought nothing" trips). Probes left over after
  // stationing form the flex pool used for roving/remote scouting below.
  const stations = kvGet<StationAssignment[]>('probe_stations') ?? [];
  const { stationed, flex } = partitionProbes(scouts, stations);
  const flexProbes = scouts.filter((s) => flex.includes(s.symbol));
  if (stationed.length > 0) {
    log.info(`station keepers: ${stationed.length}, flex probes: ${flexProbes.length}`);
    const sk = await runStationKeeping(api, scouts, stationed, {
      allowCrossSystem: !gateBlocked,
    });
    result.stationsRefreshed += sk.refreshed;
  }

  // Assign each trader a distinct, non-overlapping route up front so concurrent
  // traders don't pile onto the same good and collapse its spread. Traders stick
  // to their assigned good while it stays profitable, then fall back to any
  // unclaimed route. Ranking is by credits-per-second (profit-per-trip divided
  // by round-trip travel time) so short, fat-volume hops that turn the hold over
  // quickly are preferred over long, thin high-margin hauls.
  const candidates = findArbitrageRoutes(system, minProfit, 30);
  const holdSize = Math.max(...haulers.map((s) => s.cargo.capacity), 40);
  const distanceOf = (from: string, to: string): number => {
    const a = getWaypointRow(from);
    const b = getWaypointRow(to);
    return a && b ? distance(a, b) : 0;
  };

  // Cross-system arbitrage takes priority for any freighter when a remote route
  // out-earns the best local hop (net of round-trip jump/antimatter cost). Hops
  // are counted over the hydrated gate graph; only systems whose gate topology
  // is known are reachable. Remote routes are only known once the scout has
  // captured prices in a neighbor system, so early rounds naturally fall back to
  // local trading until the price map fills in.
  const gateNeighbors = (g: string): string[] => getJumpGateRow(g)?.connections ?? [];
  const hopsBetween = (from: string, to: string): number | undefined => {
    const gate = findJumpGatesBySystem(from)[0]?.symbol;
    if (!gate) return undefined;
    const path = findJumpPath(gate, to, gateNeighbors, systemOf);
    return path === undefined ? undefined : path.length;
  };
  const bestLocalScore = candidates.length
    ? Math.max(...candidates.map((r) => routeScore(r, holdSize)))
    : 0;

  const rankedCross = gateBlocked
    ? []
    : rankCrossRoutes(
        findCrossSystemArbitrageRoutes(minProfit) as CrossSystemRoute[],
        hopsBetween,
        { holdSize, antimatterCost: crossAntimatterCost },
      ).filter((r) => r.netProfit > bestLocalScore);
  const crossAssigned = assignCrossRoutes(rankedCross, traders.length);

  // Freighters that drew a remote route haul cross-system; the rest trade local.
  const remoteTraders = traders.slice(0, crossAssigned.length);
  const localTraders = traders.slice(crossAssigned.length);
  const crossGoods = crossAssigned.map((r) => r.route.good);
  if (crossAssigned.length > 0) {
    log.info(
      `cross-system assignments: ${crossAssigned
        .map((r, i) => `${remoteTraders[i]!.symbol}->${r.route.good}([${r.route.buySystem}]${r.route.buyAt}->[${r.route.sellSystem}]${r.route.sellAt} net~${r.netProfit}/${r.hops}h)`)
        .join(', ')}`,
    );
  }

  // Assign each LOCAL trader a distinct, non-overlapping route up front so
  // concurrent traders don't pile onto the same good and collapse its spread.
  // Ranking is by credits-per-second (profit-per-trip / round-trip travel time)
  // so short, fat-volume hops that turn the hold over quickly are preferred.
  const assignments = assignRoutes(candidates, localTraders.length, {
    holdSize,
    score: (r) => routeCreditsPerSecond(r, distanceOf, { holdSize }),
  });
  const assignedGoods = assignments.map((r) => r.good);
  // Goods the idle-contractor fallback should also steer clear of.
  const claimedGoods = [...assignedGoods, ...crossGoods];
  if (assignedGoods.length > 0) {
    log.info(
      `route assignments: ${assignments
        .map((r, i) => `${localTraders[i]!.symbol}->${r.good}(${r.buyAt}->${r.sellAt} ~${r.profitPerUnit}/u)`)
        .join(', ')}`,
    );
  }

  // Earner jobs (contractor + traders) define when the round is "done": the
  // moment they finish we settle credits and reinvest. Scanners run alongside
  // but must never gate the round, so they get a time budget and a stop signal
  // that fires as soon as the earners complete.
  let earnersDone = false;

  // The contractor only exists when at least one non-miner hauler remains.
  const contractorJob = contractor
    ? (async () => {
        try {
          const n = await runContractPipeline(api, contractor, system, {
            maxContracts,
            hq: agent.headquarters,
          });
          result.contractsCompleted += n;
          log.info(`${contractor.symbol} contractor done: ${n} contract(s)`);
          // No feasible contract this round -> don't let the largest hauler idle.
          // Re-fetch its live nav/cargo (the pipeline may have moved it) and run
          // it as a trader, avoiding goods the dedicated traders already claimed.
          if (n === 0) {
            const fresh = await api.getShip(contractor.symbol);
            const r = await runTrader(api, fresh, system, {
              cycles: tradeCycles,
              minProfit,
              avoidGoods: claimedGoods,
              maxTradeSpend,
              shouldStop: roundExpired,
            });
            result.traderProfit += r.profit;
            log.info(
              `${contractor.symbol} idle-contractor traded: ${r.cycles} cycle(s) profit=${r.profit}`,
            );
          }
        } catch (e) {
          log.error(`${contractor.symbol} contractor errored: ${e}`);
        }
      })()
    : undefined;

  const minerJobs: Promise<unknown>[] = miners.map((ship) =>
    runMiner(api, ship, system).then(
      (r) => {
        result.minerEarnings += r.earned;
        log.info(`${ship.symbol} miner done: sold ${r.sold} unit(s) earned=${r.earned}`);
      },
      (e) => log.error(`${ship.symbol} miner errored: ${e}`),
    ),
  );

  const earnerJobs: Promise<unknown>[] = [
    ...(contractorJob ? [contractorJob] : []),
    ...minerJobs,
    ...remoteTraders.map((ship, i) =>
      runRemoteTrade(api, ship, crossAssigned[i]!.route, minProfit).then(
        (r) => {
          result.remoteProfit += r.profit;
          log.info(`${ship.symbol} remote-trader done: profit=${r.profit}`);
        },
        (e) => log.error(`${ship.symbol} remote-trader errored: ${e}`),
      ),
    ),
    ...localTraders.map((ship, i) =>
      runTrader(api, ship, system, {
        cycles: tradeCycles,
        minProfit,
        assignedGood: assignedGoods[i],
        avoidGoods: [...assignedGoods.filter((_, j) => j !== i), ...crossGoods],
        maxTradeSpend,
        shouldStop: roundExpired,
      }).then(
        (r) => {
          result.traderProfit += r.profit;
          log.info(`${ship.symbol} trader done: ${r.cycles} cycle(s) profit=${r.profit}`);
        },
        (e) => log.error(`${ship.symbol} trader errored: ${e}`),
      ),
    ),
  ];

  // Flex probes (those not holding a station) ride the gates into unscanned
  // neighbor systems to capture remote prices (the prerequisite for cross-system
  // arbitrage). The first flex probe does the remote run; when there are no
  // unscanned neighbors it returns quickly and falls back to refreshing the
  // local price map. Extra flex probes stay local. Stationed probes are already
  // busy refreshing their markets above and are excluded here.
  const scannerJobs: Promise<unknown>[] = flexProbes.map((ship, idx) =>
    (async () => {
      try {
        if (idx === 0 && !gateBlocked) {
          const scouted = await runRemoteScout(api, ship, system, {
            budgetMs: scanBudgetMs,
            shouldStop: () => earnersDone,
          });
          result.scoutedSystems += scouted.scannedSystems;
          if (scouted.scannedSystems > 0) return;
          // Nothing new remote -> keep local prices fresh with the time left.
          const fresh = await api.getShip(ship.symbol);
          const n = await runScanner(api, fresh, system, {
            limit: scanLimit,
            budgetMs: scanBudgetMs,
            shouldStop: () => earnersDone,
          });
          result.scannedMarkets += n;
          return;
        }
        const n = await runScanner(api, ship, system, {
          limit: scanLimit,
          budgetMs: scanBudgetMs,
          shouldStop: () => earnersDone,
        });
        result.scannedMarkets += n;
        log.info(`${ship.symbol} scanner done: ${n} market(s)`);
      } catch (e) {
        log.error(`${ship.symbol} scout errored: ${e}`);
      }
    })(),
  );

  // Wait for the earners; that defines the round's outcome and credit delta.
  await Promise.allSettled(earnerJobs);
  earnersDone = true; // signal scanners to wind down at their next checkpoint
  result.endCredits = (await api.getMyAgent()).credits;

  // Let any scanner stop cleanly before returning so the next round doesn't
  // spawn a second scanner on the same probe. Bounded by the current hop.
  await Promise.allSettled(scannerJobs);
  return result;
}

async function main(): Promise<void> {
  const api = new SpaceTradersApi();
  const agent = await api.getMyAgent();
  log.info(`orchestrator (single round) start | credits=${agent.credits}`);
  const r = await runFleetRound(api, {
    maxContracts: Number(process.env.MAX_CONTRACTS ?? 1),
    tradeCycles: Number(process.env.TRADE_CYCLES ?? 5),
    minProfit: Number(process.env.MIN_PROFIT ?? 20),
    scanLimit: Number(process.env.SCAN_LIMIT ?? 30),
    miners: Number(process.env.MINERS ?? 0),
    crossAntimatterCost: Number(process.env.CROSS_ANTIMATTER_COST ?? 0),
  });
  log.info(
    `orchestrator done | credits=${r.endCredits} (Δ${r.endCredits - r.startCredits}) ` +
      `contracts=${r.contractsCompleted} traderProfit=${r.traderProfit} ` +
      `remoteProfit=${r.remoteProfit} scouted=${r.scoutedSystems} minerEarnings=${r.minerEarnings}`,
  );
  closeDb();
}

// Only auto-run when invoked directly, not when imported by the supervisor.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.error('orchestrator failed', err);
    process.exitCode = 1;
  });
}

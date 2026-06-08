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
 */
import { SpaceTradersApi } from './client/api.js';
import { closeDb } from './state/db.js';
import {
  hydrateContracts,
  hydrateMarketStructures,
  hydrateShips,
  hydrateSystemWaypoints,
  systemOf,
} from './state/world.js';
import { runContractPipeline } from './behaviors/contractPipeline.js';
import { runTrader } from './behaviors/trader.js';
import { runScanner } from './behaviors/scanner.js';
import { log } from './util/logger.js';
import type { Ship } from './types/index.js';

export interface FleetRoundOptions {
  maxContracts?: number;
  tradeCycles?: number;
  minProfit?: number;
  scanLimit?: number;
}

export interface FleetRoundResult {
  startCredits: number;
  endCredits: number;
  haulers: number;
  scouts: number;
  contractsCompleted: number;
  traderProfit: number;
  scannedMarkets: number;
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

  const agent = await api.getMyAgent();
  const system = systemOf(agent.headquarters);

  const ships = await hydrateShips(api);
  await hydrateSystemWaypoints(api, system);
  await hydrateMarketStructures(api, system);
  await hydrateContracts(api);

  const haulers = ships.filter(isHauler);
  const scouts = ships.filter((s) => !isHauler(s));
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
  };

  if (haulers.length === 0) {
    log.warn('no haulers available this round');
    return result;
  }

  // One contractor (largest cargo wins), the rest trade arbitrage.
  const sorted = [...haulers].sort((a, b) => b.cargo.capacity - a.cargo.capacity);
  const contractor = sorted[0]!;
  const traders = sorted.slice(1);
  log.info(
    `roles: contractor=${contractor.symbol} traders=[${traders.map((s) => s.symbol).join(', ')}] ` +
      `scanners=[${scouts.map((s) => s.symbol).join(', ')}]`,
  );

  const jobs: Promise<unknown>[] = [
    runContractPipeline(api, contractor, system, {
      maxContracts,
      hq: agent.headquarters,
    }).then(
      (n) => {
        result.contractsCompleted += n;
        log.info(`${contractor.symbol} contractor done: ${n} contract(s)`);
      },
      (e) => log.error(`${contractor.symbol} contractor errored: ${e}`),
    ),
    ...traders.map((ship) =>
      runTrader(api, ship, system, { cycles: tradeCycles, minProfit }).then(
        (r) => {
          result.traderProfit += r.profit;
          log.info(`${ship.symbol} trader done: ${r.cycles} cycle(s) profit=${r.profit}`);
        },
        (e) => log.error(`${ship.symbol} trader errored: ${e}`),
      ),
    ),
    ...scouts.map((ship) =>
      runScanner(api, ship, system, { limit: scanLimit }).then(
        (n) => {
          result.scannedMarkets += n;
          log.info(`${ship.symbol} scanner done: ${n} market(s)`);
        },
        (e) => log.error(`${ship.symbol} scanner errored: ${e}`),
      ),
    ),
  ];

  await Promise.allSettled(jobs);

  result.endCredits = (await api.getMyAgent()).credits;
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
  });
  log.info(
    `orchestrator done | credits=${r.endCredits} (Δ${r.endCredits - r.startCredits}) ` +
      `contracts=${r.contractsCompleted} traderProfit=${r.traderProfit}`,
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

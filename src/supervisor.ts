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
 *   ROUND_BUDGET_MS  wall-clock cap for a round's earners; traders finish their
 *                    in-flight cycle but start no new one past it, so one slow
 *                    ship can't stall the fleet (default 1500000 = 25 min)
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
import {
  maybeReinvest,
  maybeProvisionProbes,
  maybeRepairFleet,
  type MaintenanceConfig,
} from './fleet/maintenance.js';
import { sleep } from './client/rateLimiter.js';
import { log } from './util/logger.js';

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
  roundBudgetMs: Number(process.env.ROUND_BUDGET_MS ?? 1_500_000),
  maxTradeFraction: Number(process.env.MAX_TRADE_FRACTION ?? 0.25),
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

/** Map the supervisor's env config onto the shared maintenance config. */
const maintenanceCfg: MaintenanceConfig = {
  reinvest: CFG.reinvest,
  reserve: CFG.reserve,
  maxShips: CFG.maxShips,
  maxProbes: CFG.maxProbes,
  probeCostEst: CFG.probeCostEst,
  minProfit: CFG.minProfit,
  reinvestYard: CFG.reinvestYard,
  shipCostEst: CFG.shipCostEst,
  minRoi: CFG.minRoi,
  repair: CFG.repair,
  repairThreshold: CFG.repairThreshold,
  repairYard: CFG.repairYard,
  stopping: () => stopping,
};

async function main(): Promise<void> {
  const api = new SpaceTradersApi();
  const startAgent = await api.getMyAgent();
  log.info(
    `supervisor start | credits=${startAgent.credits} reinvest=${CFG.reinvest} ` +
      `reserve=${CFG.reserve} maxShips=${CFG.maxShips} maxRounds=${CFG.maxRounds || '∞'} ` +
      `roundBudget=${CFG.roundBudgetMs ? Math.round(CFG.roundBudgetMs / 1000) + 's' : '∞'} ` +
      `maxTradeFraction=${CFG.maxTradeFraction || '∞'}`,
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
        roundBudgetMs: CFG.roundBudgetMs,
        maxTradeFraction: CFG.maxTradeFraction,
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
      await maybeReinvest(api, maintenanceCfg);
    } catch (err) {
      log.warn(`reinvest skipped: ${(err as Error).message}`);
    }

    if (stopping) break;
    try {
      await maybeProvisionProbes(api, maintenanceCfg);
    } catch (err) {
      log.warn(`probe provisioning skipped: ${(err as Error).message}`);
    }

    if (stopping) break;
    try {
      await maybeRepairFleet(api, maintenanceCfg);
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

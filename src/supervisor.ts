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
 *   REINVEST         "1" to auto-buy ships from surplus (default 1)
 *   RESERVE          credits to keep on hand, never spent on ships (default 75000)
 *   MAX_SHIPS        fleet size cap for reinvestment (default 8)
 *   REINVEST_SHIP    ship type to buy (default SHIP_LIGHT_SHUTTLE)
 *   REINVEST_YARD    shipyard waypoint to buy at (default X1-A20-A2)
 *   SHIP_COST_EST    price estimate gating a purchase attempt (default 90000)
 */
import { SpaceTradersApi } from './client/api.js';
import { closeDb } from './state/db.js';
import { runFleetRound } from './orchestrator.js';
import { purchaseShipAt } from './behaviors/fleet.js';
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
  reinvest: (process.env.REINVEST ?? '1') === '1',
  reserve: Number(process.env.RESERVE ?? 75000),
  maxShips: Number(process.env.MAX_SHIPS ?? 8),
  reinvestShip: (process.env.REINVEST_SHIP ?? 'SHIP_LIGHT_SHUTTLE') as ShipType,
  reinvestYard: process.env.REINVEST_YARD ?? 'X1-A20-A2',
  shipCostEst: Number(process.env.SHIP_COST_EST ?? 90000),
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

/**
 * If reinvestment is enabled and we have surplus credits and fleet headroom,
 * route a free-moving scout to the shipyard and buy one ship. Runs between
 * rounds when ships are idle. Returns true if a ship was purchased.
 */
async function maybeReinvest(api: SpaceTradersApi): Promise<boolean> {
  if (!CFG.reinvest) return false;
  const agent = await api.getMyAgent();
  const ships = (await api.listShips()).data;
  if (ships.length >= CFG.maxShips) return false;
  if (agent.credits - CFG.reserve < CFG.shipCostEst) return false;

  // Prefer a fuel-free scout as the buying courier; fall back to any ship.
  const scout = ships.find((s) => s.fuel.capacity === 0) ?? ships[0];
  log.info(
    `reinvest: credits=${agent.credits} buying ${CFG.reinvestShip} at ${CFG.reinvestYard} ` +
      `(fleet ${ships.length}/${CFG.maxShips})`,
  );
  const res = await purchaseShipAt(api, CFG.reinvestShip, CFG.reinvestYard, {
    scout,
    maxPrice: CFG.reserve + CFG.shipCostEst,
  });
  return Boolean(res.ship);
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
      });
      const dt = Math.round((Date.now() - t0) / 1000);
      log.info(
        `===== round ${round} done in ${dt}s | credits=${r.endCredits} ` +
          `(round Δ${r.endCredits - r.startCredits}, total Δ${r.endCredits - baseline}) ` +
          `contracts=${r.contractsCompleted} traderProfit=${r.traderProfit} scanned=${r.scannedMarkets} =====`,
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

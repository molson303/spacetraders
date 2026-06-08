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
 *   REINVEST_YARD    shipyard waypoint to buy at (default X1-A20-A2)
 *   SHIP_COST_EST    min surplus (credits-reserve) before bothering to scan the
 *                    yard for a buy (default 90000)
 *   MIN_ROI          skip buys whose ROI (earn weight / price) is below this
 *                    (default 0 = buy any affordable cargo ship)
 */
import { SpaceTradersApi } from './client/api.js';
import { closeDb } from './state/db.js';
import { runFleetRound } from './orchestrator.js';
import { purchaseShipAt } from './behaviors/fleet.js';
import { scanShipyard, systemOf } from './state/world.js';
import { travelTo } from './util/nav.js';
import { bestReinvestShip, earnWeight } from './util/reinvest.js';
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
  reinvestYard: process.env.REINVEST_YARD ?? 'X1-A20-A2',
  shipCostEst: Number(process.env.SHIP_COST_EST ?? 90000),
  minRoi: Number(process.env.MIN_ROI ?? 0),
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
 * route a free-moving scout to the shipyard, read live prices, and buy as many
 * ships as the surplus allows — each time picking the best ROI (earning weight
 * per credit) ship that's affordable. Runs between rounds. Returns the number
 * of ships purchased.
 */
async function maybeReinvest(api: SpaceTradersApi): Promise<number> {
  if (!CFG.reinvest) return 0;
  let agent = await api.getMyAgent();
  let fleet = (await api.listShips()).data;
  if (fleet.length >= CFG.maxShips) return 0;
  // Cheap pre-check: don't route a scout if we can't plausibly afford a ship.
  if (agent.credits - CFG.reserve < CFG.shipCostEst) return 0;

  // Route a fuel-free scout (or any ship) to the yard so live prices populate.
  const scout = fleet.find((s) => s.fuel.capacity === 0) ?? fleet[0]!;
  const system = systemOf(CFG.reinvestYard);
  if (scout.nav.waypointSymbol !== CFG.reinvestYard) {
    await travelTo(api, scout, CFG.reinvestYard);
  }

  let bought = 0;
  while (fleet.length + bought < CFG.maxShips) {
    const budget = agent.credits - CFG.reserve;
    if (budget <= 0) break;

    const yard = await scanShipyard(api, system, CFG.reinvestYard);
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
      `reinvest: credits=${agent.credits} buying ${pick.type} @ ${pick.price} at ${CFG.reinvestYard} ` +
        `(fleet ${fleet.length + bought}/${CFG.maxShips}, roi=${(earnWeight(pick.type) / pick.price).toFixed(5)})`,
    );
    const res = await purchaseShipAt(api, pick.type as ShipType, CFG.reinvestYard, {
      maxPrice: pick.price + CFG.reserve,
    });
    if (!res.ship) break;
    bought++;
    agent = { ...agent, credits: res.credits };
  }

  if (bought > 0) log.info(`reinvest: bought ${bought} ship(s) this cycle`);
  return bought;
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

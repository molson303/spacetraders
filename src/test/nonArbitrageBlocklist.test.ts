// In-memory DB must be opened before config/db singletons load.
import './_setupMemoryDb.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../state/db.js';
import {
  findArbitrageRoutes,
  findBestArbitrage,
  findCrossSystemArbitrageRoutes,
  NON_ARBITRAGE_GOODS,
} from '../state/repos.js';

getDb();

function seedPrice(opts: {
  waypoint: string;
  system: string;
  good: string;
  purchase?: number | null;
  sell?: number | null;
  volume?: number | null;
}): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO market_latest
         (waypoint, system, trade_symbol, type, trade_volume, supply, activity,
          purchase_price, sell_price, observed_at)
       VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?, datetime('now'))`,
    )
    .run(
      opts.waypoint,
      opts.system,
      opts.good,
      opts.volume ?? 40,
      opts.purchase ?? null,
      opts.sell ?? null,
    );
}

// Phantom ADVANCED_CIRCUITRY route: an IMPORT market shows a low purchase price
// and a drained EXPORT market shows a wildly inflated sell price. The spread is
// huge but illusory — the EXPORT market refuses to buy the good back, so this
// route burns the whole purchase. The blocklist must keep it out of every finder.
seedPrice({ waypoint: 'X1-S1-A4', system: 'X1-S1', good: 'ADVANCED_CIRCUITRY', purchase: 11610, sell: 9000 });
seedPrice({ waypoint: 'X1-S1-D41', system: 'X1-S1', good: 'ADVANCED_CIRCUITRY', purchase: 64000, sell: 25832 });
// Same illusion across systems for the cross-system finder.
seedPrice({ waypoint: 'X1-S2-D99', system: 'X1-S2', good: 'ADVANCED_CIRCUITRY', purchase: 64000, sell: 25832 });

// A FAB_MATS phantom in the same system, for good measure.
seedPrice({ waypoint: 'X1-S1-F1', system: 'X1-S1', good: 'FAB_MATS', purchase: 100, sell: 90 });
seedPrice({ waypoint: 'X1-S1-F2', system: 'X1-S1', good: 'FAB_MATS', purchase: 5000, sell: 4000 });

// A legitimate, tradable good that MUST still surface as a route.
seedPrice({ waypoint: 'X1-S1-G1', system: 'X1-S1', good: 'CLOTHING', purchase: 100, sell: 90 });
seedPrice({ waypoint: 'X1-S1-G2', system: 'X1-S1', good: 'CLOTHING', purchase: 120, sell: 600 });
seedPrice({ waypoint: 'X1-S3-G3', system: 'X1-S3', good: 'CLOTHING', purchase: 120, sell: 600 });

test('NON_ARBITRAGE_GOODS includes the gate construction inputs', () => {
  assert.ok(NON_ARBITRAGE_GOODS.includes('ADVANCED_CIRCUITRY'));
  assert.ok(NON_ARBITRAGE_GOODS.includes('FAB_MATS'));
  assert.ok(NON_ARBITRAGE_GOODS.includes('QUANTUM_STABILIZERS'));
});

test('findBestArbitrage never returns a blocklisted good', () => {
  const best = findBestArbitrage('X1-S1', 1);
  assert.ok(best, 'a route is found');
  assert.ok(!NON_ARBITRAGE_GOODS.includes(best!.good), `got ${best!.good}`);
  // The only legit route in X1-S1 is CLOTHING.
  assert.equal(best!.good, 'CLOTHING');
});

test('findArbitrageRoutes excludes all blocklisted goods', () => {
  const routes = findArbitrageRoutes('X1-S1', 1, 50);
  assert.ok(routes.length > 0, 'at least one route returned');
  for (const r of routes) {
    assert.ok(!NON_ARBITRAGE_GOODS.includes(r.good), `blocklisted good leaked: ${r.good}`);
  }
  assert.ok(routes.some((r) => r.good === 'CLOTHING'), 'legit CLOTHING route still present');
});

test('findCrossSystemArbitrageRoutes excludes all blocklisted goods', () => {
  const routes = findCrossSystemArbitrageRoutes(1, 50);
  for (const r of routes) {
    assert.ok(!NON_ARBITRAGE_GOODS.includes(r.good), `blocklisted good leaked: ${r.good}`);
  }
  assert.ok(routes.some((r) => r.good === 'CLOTHING'), 'legit CLOTHING cross-system route present');
});

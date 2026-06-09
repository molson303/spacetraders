// In-memory DB must be opened before config/db singletons load.
import './_setupMemoryDb.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../state/db.js';
import { findCrossSystemArbitrageRoutes } from '../state/repos.js';

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

// Buy IRON_ORE cheap in A20, sell dear in CN42 (cross-system spread of 20).
seedPrice({ waypoint: 'X1-A20-A1', system: 'X1-A20', good: 'IRON_ORE', purchase: 10, sell: 8 });
seedPrice({ waypoint: 'X1-CN42-B1', system: 'X1-CN42', good: 'IRON_ORE', purchase: 35, sell: 30 });
// A same-system pair that must NOT appear in cross-system results.
seedPrice({ waypoint: 'X1-A20-A2', system: 'X1-A20', good: 'COPPER', purchase: 5, sell: 50 });
// A thin cross-system spread filtered out by minProfit.
seedPrice({ waypoint: 'X1-A20-A1', system: 'X1-A20', good: 'GOLD', purchase: 100, sell: 90 });
seedPrice({ waypoint: 'X1-CN42-B1', system: 'X1-CN42', good: 'GOLD', purchase: 105, sell: 101 });

test('finds cross-system buy-low/sell-high candidates', () => {
  const routes = findCrossSystemArbitrageRoutes(5);
  const iron = routes.find((r) => r.good === 'IRON_ORE');
  assert.ok(iron, 'IRON_ORE cross-system route present');
  assert.equal(iron!.buySystem, 'X1-A20');
  assert.equal(iron!.sellSystem, 'X1-CN42');
  assert.equal(iron!.buyAt, 'X1-A20-A1');
  assert.equal(iron!.sellAt, 'X1-CN42-B1');
  assert.equal(iron!.profitPerUnit, 20);
});

test('excludes same-system pairs', () => {
  const routes = findCrossSystemArbitrageRoutes(1);
  assert.ok(!routes.some((r) => r.good === 'COPPER'), 'COPPER (same-system) excluded');
  for (const r of routes) assert.notEqual(r.buySystem, r.sellSystem);
});

test('respects the minProfit threshold', () => {
  const routes = findCrossSystemArbitrageRoutes(5);
  // GOLD spread is only 1 (90 -> 101 sell vs 100 -> 105 purchase => 101-100=1).
  assert.ok(!routes.some((r) => r.good === 'GOLD'), 'thin GOLD spread excluded');
});

test('orders results by per-unit spread descending', () => {
  const routes = findCrossSystemArbitrageRoutes(1);
  for (let i = 1; i < routes.length; i++) {
    assert.ok(routes[i - 1]!.profitPerUnit >= routes[i]!.profitPerUnit);
  }
});

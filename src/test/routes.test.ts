import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeScore, assignRoutes } from '../util/routes.js';
import type { ArbitrageRoute } from '../state/repos.js';

function route(p: Partial<ArbitrageRoute>): ArbitrageRoute {
  return {
    good: 'GOOD',
    buyAt: 'BUY',
    buyPrice: 100,
    sellAt: 'SELL',
    sellPrice: 200,
    profitPerUnit: 100,
    tradeVolume: 10,
    ...p,
  };
}

test('routeScore = profitPerUnit x movable units (capped by hold and volume)', () => {
  // volume 10 < hold 40 -> 50 * 10
  assert.equal(routeScore(route({ profitPerUnit: 50, tradeVolume: 10 }), 40), 500);
  // volume 60 > hold 40 -> 50 * 40
  assert.equal(routeScore(route({ profitPerUnit: 50, tradeVolume: 60 }), 40), 2000);
});

test('routeScore treats missing/zero volume as a full hold', () => {
  assert.equal(routeScore(route({ profitPerUnit: 10, tradeVolume: null }), 40), 400);
  assert.equal(routeScore(route({ profitPerUnit: 10, tradeVolume: 0 }), 40), 400);
});

test('routeScore can rank a fat-volume route above a thin high-margin one', () => {
  const thin = route({ good: 'A', profitPerUnit: 300, tradeVolume: 2 }); // 300*2 = 600
  const fat = route({ good: 'B', profitPerUnit: 80, tradeVolume: 40 }); // 80*40 = 3200
  assert.ok(routeScore(fat, 40) > routeScore(thin, 40));
});

test('assignRoutes picks distinct goods and sell waypoints, best score first', () => {
  const routes = [
    route({ good: 'A', sellAt: 'S1', profitPerUnit: 80, tradeVolume: 40 }), // 3200
    route({ good: 'B', sellAt: 'S2', profitPerUnit: 300, tradeVolume: 2 }), // 600
    route({ good: 'C', sellAt: 'S3', profitPerUnit: 100, tradeVolume: 40 }), // 4000
  ];
  const picked = assignRoutes(routes, 2);
  assert.deepEqual(
    picked.map((r) => r.good),
    ['C', 'A'],
  );
});

test('assignRoutes skips duplicate good even if a different waypoint pair', () => {
  const routes = [
    route({ good: 'A', sellAt: 'S1', profitPerUnit: 100, tradeVolume: 40 }),
    route({ good: 'A', sellAt: 'S2', profitPerUnit: 90, tradeVolume: 40 }),
    route({ good: 'B', sellAt: 'S3', profitPerUnit: 50, tradeVolume: 40 }),
  ];
  const picked = assignRoutes(routes, 3);
  assert.deepEqual(
    picked.map((r) => r.good),
    ['A', 'B'],
  );
});

test('assignRoutes skips a route that reuses an already-claimed sell waypoint', () => {
  const routes = [
    route({ good: 'A', sellAt: 'SINK', profitPerUnit: 100, tradeVolume: 40 }),
    route({ good: 'B', sellAt: 'SINK', profitPerUnit: 90, tradeVolume: 40 }),
    route({ good: 'C', sellAt: 'OTHER', profitPerUnit: 50, tradeVolume: 40 }),
  ];
  const picked = assignRoutes(routes, 3);
  assert.deepEqual(
    picked.map((r) => r.good),
    ['A', 'C'],
  );
});

test('assignRoutes returns at most count, and empty for non-positive count', () => {
  const routes = [
    route({ good: 'A', sellAt: 'S1' }),
    route({ good: 'B', sellAt: 'S2' }),
  ];
  assert.equal(assignRoutes(routes, 1).length, 1);
  assert.equal(assignRoutes(routes, 0).length, 0);
  assert.equal(assignRoutes(routes, -3).length, 0);
});

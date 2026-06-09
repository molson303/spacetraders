import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossRouteNetProfit, rankCrossRoutes, assignCrossRoutes, type CrossSystemRoute } from '../util/crossRoutes.js';

function route(partial: Partial<CrossSystemRoute>): CrossSystemRoute {
  return {
    good: 'IRON_ORE',
    buyAt: 'X1-A20-A1',
    buyPrice: 10,
    sellAt: 'X1-CN42-B1',
    sellPrice: 30,
    profitPerUnit: 20,
    tradeVolume: 40,
    buySystem: 'X1-A20',
    sellSystem: 'X1-CN42',
    ...partial,
  };
}

// Hop table: A20 -> CN42 is 1 jump, A20 -> ZZ99 is 2, others unreachable.
const hopsBetween = (from: string, to: string): number | undefined => {
  const table: Record<string, Record<string, number>> = {
    'X1-A20': { 'X1-CN42': 1, 'X1-ZZ99': 2 },
  };
  return table[from]?.[to];
};

test('netProfit subtracts round-trip jump cost from full-hold gross', () => {
  // gross = 20 profit/unit * 40 units = 800; 1 hop * 2 * 100 antimatter = 200.
  const net = crossRouteNetProfit(route({}), hopsBetween, { antimatterCost: 100 });
  assert.equal(net, 800 - 200);
});

test('netProfit with zero antimatter cost equals gross full-hold profit', () => {
  assert.equal(crossRouteNetProfit(route({}), hopsBetween), 800);
});

test('netProfit is bounded by trade volume below hold size', () => {
  // tradeVolume 10 caps a 40-hold to 10 units: 20 * 10 = 200.
  const net = crossRouteNetProfit(route({ tradeVolume: 10 }), hopsBetween);
  assert.equal(net, 200);
});

test('netProfit undefined when buy and sell systems are identical', () => {
  assert.equal(
    crossRouteNetProfit(route({ sellSystem: 'X1-A20' }), hopsBetween),
    undefined,
  );
});

test('netProfit undefined when the sell system is unreachable', () => {
  assert.equal(
    crossRouteNetProfit(route({ sellSystem: 'X1-NOPE' }), hopsBetween),
    undefined,
  );
});

test('rankCrossRoutes keeps only reachable, net-positive routes', () => {
  const routes = [
    route({ good: 'IRON_ORE', sellSystem: 'X1-CN42' }), // net 800
    route({ good: 'COPPER_ORE', sellSystem: 'X1-NOPE' }), // unreachable
    route({ good: 'GOLD', sellSystem: 'X1-A20' }), // same system
  ];
  const ranked = rankCrossRoutes(routes, hopsBetween);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]!.route.good, 'IRON_ORE');
  assert.equal(ranked[0]!.hops, 1);
});

test('rankCrossRoutes drops routes whose profit cannot clear jump cost', () => {
  // gross = 1 * 40 = 40; cost = 2 * 2 hops * 100 = 400 -> net negative.
  const thin = route({ profitPerUnit: 1, sellSystem: 'X1-ZZ99' });
  const ranked = rankCrossRoutes([thin], hopsBetween, { antimatterCost: 100 });
  assert.equal(ranked.length, 0);
});

test('rankCrossRoutes orders by net profit then fewer hops', () => {
  const big = route({ good: 'GOLD', profitPerUnit: 30, sellSystem: 'X1-CN42' }); // 1200
  const small = route({ good: 'IRON_ORE', profitPerUnit: 20, sellSystem: 'X1-CN42' }); // 800
  const far = route({ good: 'COPPER', profitPerUnit: 20, sellSystem: 'X1-ZZ99' }); // 800, 2 hops
  const ranked = rankCrossRoutes([small, far, big], hopsBetween);
  assert.deepEqual(ranked.map((r) => r.route.good), ['GOLD', 'IRON_ORE', 'COPPER']);
  // small (1 hop) outranks far (2 hops) on the tie at 800.
  assert.equal(ranked[1]!.hops, 1);
  assert.equal(ranked[2]!.hops, 2);
});

test('assignCrossRoutes picks distinct non-overlapping routes up to count', () => {
  const ranked = rankCrossRoutes(
    [
      route({ good: 'GOLD', profitPerUnit: 30, sellAt: 'X1-CN42-B1', sellSystem: 'X1-CN42' }),
      route({ good: 'IRON_ORE', profitPerUnit: 20, sellAt: 'X1-CN42-B2', sellSystem: 'X1-CN42' }),
      route({ good: 'COPPER', profitPerUnit: 10, sellAt: 'X1-ZZ99-C1', sellSystem: 'X1-ZZ99' }),
    ],
    hopsBetween,
  );
  const picked = assignCrossRoutes(ranked, 2);
  assert.deepEqual(picked.map((r) => r.route.good), ['GOLD', 'IRON_ORE']);
});

test('assignCrossRoutes skips routes sharing a good or sell waypoint', () => {
  const ranked = rankCrossRoutes(
    [
      route({ good: 'GOLD', profitPerUnit: 30, sellAt: 'X1-CN42-B1', sellSystem: 'X1-CN42' }),
      // same sell waypoint as GOLD -> must be skipped
      route({ good: 'IRON_ORE', profitPerUnit: 25, sellAt: 'X1-CN42-B1', sellSystem: 'X1-CN42' }),
      route({ good: 'COPPER', profitPerUnit: 20, sellAt: 'X1-CN42-B2', sellSystem: 'X1-CN42' }),
    ],
    hopsBetween,
  );
  const picked = assignCrossRoutes(ranked, 3);
  assert.deepEqual(picked.map((r) => r.route.good), ['GOLD', 'COPPER']);
});

test('assignCrossRoutes returns empty for non-positive count', () => {
  const ranked = rankCrossRoutes([route({})], hopsBetween);
  assert.deepEqual(assignCrossRoutes(ranked, 0), []);
});

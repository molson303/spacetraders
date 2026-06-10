import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  routeScore,
  assignRoutes,
  bestRouteFor,
  countDistinctRoutes,
  tripSeconds,
  routeCreditsPerSecond,
  selectFlightMode,
} from '../util/routes.js';
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
    sellVolume: null,
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

test('routeScore caps movable units by sell-market depth', () => {
  // Buy side could fill the hold (40), but the sell market only absorbs 5/step.
  // With the default x3 depth multiple that is 15 units: 100 * 15 = 1500.
  assert.equal(routeScore(route({ profitPerUnit: 100, tradeVolume: 40, sellVolume: 5 }), 40), 1500);
  // Deep sell market (>= hold after the multiple) -> full hold: 100 * 40 = 4000.
  assert.equal(routeScore(route({ profitPerUnit: 100, tradeVolume: 40, sellVolume: 40 }), 40), 4000);
});

test('routeScore: thin sell depth sinks a high-margin route below a deep one', () => {
  // Thin: huge per-unit spread but the sink only clears ~6 units (2 * 3).
  const thinSink = route({ good: 'A', profitPerUnit: 300, tradeVolume: 40, sellVolume: 2 });
  // Deep: modest spread but absorbs a full hold.
  const deepSink = route({ good: 'B', profitPerUnit: 80, tradeVolume: 40, sellVolume: 40 });
  assert.ok(routeScore(deepSink, 40) > routeScore(thinSink, 40));
});

test('routeScore treats unknown sell depth as no extra cap', () => {
  // sellVolume null -> only hold/buy bound it: 100 * 40 = 4000.
  assert.equal(routeScore(route({ profitPerUnit: 100, tradeVolume: 40, sellVolume: null }), 40), 4000);
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

test('tripSeconds: BURN is fastest, DRIFT slowest, plus fixed overhead', () => {
  // d=30, speed=30: factor*1 + 15. CRUISE=25+15=40, BURN=12.5->13+15=28, DRIFT=250+15=265
  assert.equal(tripSeconds(30, 'CRUISE', 30), 40);
  assert.equal(tripSeconds(30, 'BURN', 30), 28);
  assert.equal(tripSeconds(30, 'DRIFT', 30), 265);
  assert.ok(tripSeconds(30, 'BURN') < tripSeconds(30, 'CRUISE'));
  assert.ok(tripSeconds(30, 'CRUISE') < tripSeconds(30, 'DRIFT'));
});

test('tripSeconds: distance floored at 1 so a zero-distance hop still has overhead', () => {
  assert.equal(tripSeconds(0, 'CRUISE', 30), tripSeconds(1, 'CRUISE', 30));
});

test('routeCreditsPerSecond divides profit-per-trip by round-trip time', () => {
  const r = route({ profitPerUnit: 50, tradeVolume: 40 }); // profit 2000 over hold 40
  const distanceOf = () => 30; // CRUISE trip = 40s, round trip = 80s
  const cps = routeCreditsPerSecond(r, distanceOf, { holdSize: 40, engineSpeed: 30 });
  assert.equal(cps, 2000 / 80);
});

test('routeCreditsPerSecond can rank a short hop above a long higher-profit haul', () => {
  const near = route({ good: 'A', buyAt: 'B1', sellAt: 'S1', profitPerUnit: 60, tradeVolume: 40 });
  const far = route({ good: 'B', buyAt: 'B2', sellAt: 'S2', profitPerUnit: 80, tradeVolume: 40 });
  // far has higher raw profit-per-trip but is much farther away.
  assert.ok(routeScore(far) > routeScore(near));
  const distanceOf = (_from: string, to: string) => (to === 'S1' ? 5 : 200);
  assert.ok(
    routeCreditsPerSecond(near, distanceOf) > routeCreditsPerSecond(far, distanceOf),
  );
});

test('assignRoutes honours an injected credits-per-second scorer', () => {
  const near = route({ good: 'A', buyAt: 'B1', sellAt: 'S1', profitPerUnit: 60, tradeVolume: 40 });
  const far = route({ good: 'B', buyAt: 'B2', sellAt: 'S2', profitPerUnit: 80, tradeVolume: 40 });
  const distanceOf = (_from: string, to: string) => (to === 'S1' ? 5 : 200);
  const picked = assignRoutes([far, near], 2, {
    score: (r) => routeCreditsPerSecond(r, distanceOf),
  });
  assert.deepEqual(
    picked.map((r) => r.good),
    ['A', 'B'],
  );
});

test('selectFlightMode: BURN when 2x fuel fits, CRUISE when only 1x, DRIFT otherwise', () => {
  assert.equal(selectFlightMode(10, 100), 'BURN'); // 20 <= 100
  assert.equal(selectFlightMode(60, 100), 'CRUISE'); // 120 > 100 but 60 <= 100
  assert.equal(selectFlightMode(150, 100), 'DRIFT'); // 150 > 100
});

test('selectFlightMode: boundary where 2x fuel exactly fits picks BURN', () => {
  assert.equal(selectFlightMode(50, 100), 'BURN'); // 100 <= 100
  assert.equal(selectFlightMode(100, 100), 'CRUISE'); // 200 > 100, 100 <= 100
});

test('bestRouteFor returns undefined for an empty candidate list', () => {
  assert.equal(bestRouteFor([]), undefined);
});

test('bestRouteFor picks the highest-scored route by default (routeScore)', () => {
  const thin = route({ good: 'A', sellAt: 'S1', profitPerUnit: 300, tradeVolume: 2 }); // 600
  const fat = route({ good: 'B', sellAt: 'S2', profitPerUnit: 80, tradeVolume: 40 }); // 3200
  assert.equal(bestRouteFor([thin, fat], { holdSize: 40 })?.good, 'B');
});

test('bestRouteFor ranks by a custom throughput score (near beats far)', () => {
  // Far high-margin route vs near medium route; cr/s scorer should prefer near.
  const far = route({ good: 'FAR', buyAt: 'B1', sellAt: 'FARSINK', profitPerUnit: 1000, tradeVolume: 40 });
  const near = route({ good: 'NEAR', buyAt: 'B2', sellAt: 'NEARSINK', profitPerUnit: 300, tradeVolume: 40 });
  const distanceOf = (_from: string, to: string): number => (to === 'FARSINK' ? 500 : 5);
  const chosen = bestRouteFor([far, near], {
    holdSize: 40,
    score: (r) => routeCreditsPerSecond(r, distanceOf, { holdSize: 40 }),
  });
  assert.equal(chosen?.good, 'NEAR');
});

test('bestRouteFor prefers the assigned good even when not top-scored', () => {
  const top = route({ good: 'TOP', sellAt: 'S1', profitPerUnit: 300, tradeVolume: 40 });
  const mine = route({ good: 'MINE', sellAt: 'S2', profitPerUnit: 50, tradeVolume: 40 });
  assert.equal(bestRouteFor([top, mine], { holdSize: 40, assignedGood: 'MINE' })?.good, 'MINE');
});

test('bestRouteFor skips avoided goods, falling back only when all are avoided', () => {
  const a = route({ good: 'A', sellAt: 'S1', profitPerUnit: 300, tradeVolume: 40 });
  const b = route({ good: 'B', sellAt: 'S2', profitPerUnit: 80, tradeVolume: 40 });
  assert.equal(bestRouteFor([a, b], { holdSize: 40, avoid: ['A'] })?.good, 'B');
  // Every good avoided -> last resort returns the top-scored route.
  assert.equal(bestRouteFor([a, b], { holdSize: 40, avoid: ['A', 'B'] })?.good, 'A');
});

test('countDistinctRoutes counts non-overlapping good+sell routes', () => {
  const routes = [
    route({ good: 'A', sellAt: 'S1' }),
    route({ good: 'B', sellAt: 'S2' }),
    route({ good: 'C', sellAt: 'S3' }),
  ];
  assert.equal(countDistinctRoutes(routes), 3);
});

test('countDistinctRoutes dedupes repeated goods and shared sell waypoints', () => {
  const routes = [
    route({ good: 'A', sellAt: 'S1' }),
    route({ good: 'A', sellAt: 'S2' }), // same good as first -> skipped
    route({ good: 'B', sellAt: 'S1' }), // shares sell waypoint with first -> skipped
    route({ good: 'C', sellAt: 'S3' }), // distinct -> counted
  ];
  assert.equal(countDistinctRoutes(routes), 2);
});

test('countDistinctRoutes is zero for no routes', () => {
  assert.equal(countDistinctRoutes([]), 0);
});

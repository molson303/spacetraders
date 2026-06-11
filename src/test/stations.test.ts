import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  marketPriority,
  partitionProbes,
  planProbeStations,
  probesToProvision,
  STRATEGIC_PRIORITY,
  type StationAssignment,
  type StationMarket,
} from '../util/stations.js';

function market(symbol: string, priority = 0, system = 'X1-A20'): StationMarket {
  return { symbol, system, priority };
}

test('planProbeStations: assigns free probes to uncovered markets, priority first', () => {
  const markets = [market('X1-A20-M1', 1), market('X1-A20-M2', 5), market('X1-A20-M3', 3)];
  const probes = [{ symbol: 'P-2' }, { symbol: 'P-1' }];
  const out = planProbeStations(markets, probes);
  // Two highest-priority markets covered (M2=5, M3=3); probes in symbol order.
  assert.deepEqual(out, [
    { ship: 'P-1', waypoint: 'X1-A20-M2' },
    { ship: 'P-2', waypoint: 'X1-A20-M3' },
  ]);
});

test('planProbeStations: preserves valid existing assignments', () => {
  const markets = [market('X1-A20-M1'), market('X1-A20-M2'), market('X1-A20-M3')];
  const probes = [{ symbol: 'P-1' }, { symbol: 'P-2' }];
  const existing: StationAssignment[] = [{ ship: 'P-2', waypoint: 'X1-A20-M3' }];
  const out = planProbeStations(markets, probes, existing);
  assert.ok(out.some((a) => a.ship === 'P-2' && a.waypoint === 'X1-A20-M3'), 'kept existing');
  // P-1 fills an uncovered market (M1 or M2), not the already-covered M3.
  const p1 = out.find((a) => a.ship === 'P-1')!;
  assert.notEqual(p1.waypoint, 'X1-A20-M3');
});

test('planProbeStations: drops assignments for gone probes or markets', () => {
  const markets = [market('X1-A20-M1')];
  const probes = [{ symbol: 'P-1' }];
  const existing: StationAssignment[] = [
    { ship: 'P-GONE', waypoint: 'X1-A20-M1' }, // probe no longer exists
    { ship: 'P-1', waypoint: 'X1-A20-GONE' }, // market no longer exists
  ];
  const out = planProbeStations(markets, probes, existing);
  // P-1 freed and reassigned to the only real market; P-GONE dropped.
  assert.deepEqual(out, [{ ship: 'P-1', waypoint: 'X1-A20-M1' }]);
});

test('planProbeStations: fewer probes than markets covers only the top ones', () => {
  const markets = [market('X1-A20-M1', 1), market('X1-A20-M2', 9)];
  const out = planProbeStations(markets, [{ symbol: 'P-1' }]);
  assert.deepEqual(out, [{ ship: 'P-1', waypoint: 'X1-A20-M2' }]);
});

test('planProbeStations: no probes yields no assignments', () => {
  assert.deepEqual(planProbeStations([market('X1-A20-M1')], []), []);
});

test('probesToProvision: bounded by uncovered markets', () => {
  assert.equal(
    probesToProvision({ marketCount: 8, stationed: 5, currentProbes: 5, maxProbes: 20, budget: 1e9, probePrice: 1000 }),
    3,
  );
});

test('probesToProvision: bounded by probe cap headroom', () => {
  assert.equal(
    probesToProvision({ marketCount: 8, stationed: 0, currentProbes: 6, maxProbes: 8, budget: 1e9, probePrice: 1000 }),
    2,
  );
});

test('probesToProvision: bounded by budget', () => {
  assert.equal(
    probesToProvision({ marketCount: 8, stationed: 0, currentProbes: 0, maxProbes: 8, budget: 2500, probePrice: 1000 }),
    2,
  );
});

test('probesToProvision: zero when fully covered or unaffordable', () => {
  assert.equal(
    probesToProvision({ marketCount: 5, stationed: 5, currentProbes: 5, maxProbes: 8, budget: 1e9, probePrice: 1000 }),
    0,
  );
  assert.equal(
    probesToProvision({ marketCount: 5, stationed: 0, currentProbes: 0, maxProbes: 8, budget: 1e9, probePrice: 0 }),
    0,
  );
});

test('partitionProbes: splits stationed vs flex', () => {
  const probes = [{ symbol: 'P-1' }, { symbol: 'P-2' }, { symbol: 'P-3' }];
  const stations: StationAssignment[] = [
    { ship: 'P-1', waypoint: 'X1-A20-M1' },
    { ship: 'P-GONE', waypoint: 'X1-A20-M2' }, // ignored: not a current probe
  ];
  const out = partitionProbes(probes, stations);
  assert.deepEqual(out.stationed, [{ ship: 'P-1', waypoint: 'X1-A20-M1' }]);
  assert.deepEqual(out.flex.sort(), ['P-2', 'P-3']);
});

test('marketPriority: strategic markets are pinned above traffic-ranked ones', () => {
  const txCounts = new Map([['X1-A20-BUSY', 9999]]);
  const strategic = new Set(['X1-A20-F48']);
  assert.equal(marketPriority('X1-A20-F48', { txCounts, strategic }), STRATEGIC_PRIORITY);
  assert.ok(marketPriority('X1-A20-F48', { txCounts, strategic }) > marketPriority('X1-A20-BUSY', { txCounts, strategic }));
});

test('marketPriority: busier markets outrank quieter ones; untraded outranks neighbor', () => {
  const txCounts = new Map([['X1-A20-BUSY', 400], ['X1-A20-QUIET', 5]]);
  assert.ok(marketPriority('X1-A20-BUSY', { txCounts }) > marketPriority('X1-A20-QUIET', { txCounts }));
  // An untraded home market (tx 0 -> priority 1) still beats a neighbor (0).
  assert.ok(marketPriority('X1-A20-NONE', { txCounts }) > 0);
});

test('planProbeStations: rebalances a probe off a low-priority market onto a higher one', () => {
  // One probe currently sits on a low-priority market; a much higher-priority
  // market is uncovered. With no free probes, the probe must be re-homed.
  const markets = [market('X1-A20-LOW', 1), market('X1-A20-HIGH', 500)];
  const existing: StationAssignment[] = [{ ship: 'P-1', waypoint: 'X1-A20-LOW' }];
  const out = planProbeStations(markets, [{ symbol: 'P-1' }], existing);
  assert.deepEqual(out, [{ ship: 'P-1', waypoint: 'X1-A20-HIGH' }]);
});

test('planProbeStations: covers the top-N markets when probes are scarce', () => {
  const markets = [
    market('X1-A20-A', 10),
    market('X1-A20-B', 30),
    market('X1-A20-C', 20),
    market('X1-A20-D', 40),
  ];
  // Two probes both stuck on the two lowest-priority markets.
  const existing: StationAssignment[] = [
    { ship: 'P-1', waypoint: 'X1-A20-A' },
    { ship: 'P-2', waypoint: 'X1-A20-C' },
  ];
  const out = planProbeStations(markets, [{ symbol: 'P-1' }, { symbol: 'P-2' }], existing);
  const covered = out.map((a) => a.waypoint).sort();
  assert.deepEqual(covered, ['X1-A20-B', 'X1-A20-D']); // the two highest priorities
});

test('planProbeStations: no rebalance churn among equal-priority covered markets', () => {
  // All equal priority, fewer probes than markets: a covered probe must NOT be
  // evicted just because another equal market is uncovered.
  const markets = [market('X1-A20-M1'), market('X1-A20-M2'), market('X1-A20-M3')];
  const existing: StationAssignment[] = [{ ship: 'P-2', waypoint: 'X1-A20-M3' }];
  const out = planProbeStations(markets, [{ symbol: 'P-1' }, { symbol: 'P-2' }], existing);
  assert.ok(out.some((a) => a.ship === 'P-2' && a.waypoint === 'X1-A20-M3'), 'retained, no churn');
});

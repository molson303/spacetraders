import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partitionProbes,
  planProbeStations,
  probesToProvision,
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

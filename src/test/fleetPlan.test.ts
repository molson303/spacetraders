import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionFleet, isEarner } from '../coordinator/fleetPlan.js';
import type { Ship } from '../types/index.js';

function ship(symbol: string, cargo: number, fuel: number): Ship {
  return {
    symbol,
    cargo: { capacity: cargo, units: 0, inventory: [] },
    fuel: { capacity: fuel, current: fuel },
  } as unknown as Ship;
}

test('isEarner requires both cargo and fuel capacity', () => {
  assert.equal(isEarner(ship('A', 40, 400)), true);
  assert.equal(isEarner(ship('P', 0, 0)), false); // probe
  assert.equal(isEarner(ship('X', 40, 0)), false); // no fuel
  assert.equal(isEarner(ship('Y', 0, 400)), false); // no hold
});

test('drops probes and keeps only earners', () => {
  const part = partitionFleet([ship('HAUL', 40, 400), ship('PROBE', 0, 0)], {});
  assert.equal(part.contractor?.symbol, 'HAUL');
  assert.deepEqual(part.cross, []);
  assert.deepEqual(part.local, []);
});

test('contractor is the largest-hold earner', () => {
  const part = partitionFleet(
    [ship('SMALL', 40, 400), ship('BIG', 80, 300), ship('MID', 60, 600)],
    { enableContractor: true },
  );
  assert.equal(part.contractor?.symbol, 'BIG');
});

test('cross fleet is the N highest-fuel non-contractor earners', () => {
  const ships = [
    ship('BIG', 80, 300), // contractor (largest hold)
    ship('FUELY', 40, 600),
    ship('FUELY2', 40, 590),
    ship('LOCAL', 40, 300),
  ];
  const part = partitionFleet(ships, { crossShips: 2, enableContractor: true });
  assert.equal(part.contractor?.symbol, 'BIG');
  assert.deepEqual(
    part.cross.map((s) => s.symbol),
    ['FUELY', 'FUELY2'],
  );
  assert.deepEqual(
    part.local.map((s) => s.symbol),
    ['LOCAL'],
  );
});

test('crossShips beyond the pool puts every remaining earner in cross', () => {
  const part = partitionFleet([ship('BIG', 80, 300), ship('A', 40, 500)], {
    crossShips: 5,
    enableContractor: true,
  });
  assert.equal(part.contractor?.symbol, 'BIG');
  assert.deepEqual(
    part.cross.map((s) => s.symbol),
    ['A'],
  );
  assert.deepEqual(part.local, []);
});

test('no contractor when disabled — all earners trade as local/cross', () => {
  const part = partitionFleet([ship('BIG', 80, 300), ship('A', 40, 500)], {
    crossShips: 1,
    enableContractor: false,
  });
  assert.equal(part.contractor, undefined);
  assert.deepEqual(
    part.cross.map((s) => s.symbol),
    ['A'], // highest fuel
  );
  assert.deepEqual(
    part.local.map((s) => s.symbol),
    ['BIG'],
  );
});

test('zero cross ships makes everyone local (minus contractor)', () => {
  const part = partitionFleet([ship('BIG', 80, 300), ship('A', 40, 500), ship('B', 40, 400)], {
    crossShips: 0,
  });
  assert.equal(part.contractor?.symbol, 'BIG');
  assert.deepEqual(part.cross, []);
  assert.deepEqual(
    part.local.map((s) => s.symbol),
    ['A', 'B'], // ranked by fuel desc
  );
});

test('deterministic tiebreak by symbol when fuel and cargo are equal', () => {
  const part = partitionFleet(
    [ship('ZED', 40, 400), ship('ABLE', 40, 400), ship('MID', 40, 400)],
    { crossShips: 1, enableContractor: false },
  );
  // All equal -> sorted by symbol; ABLE first into cross.
  assert.deepEqual(
    part.cross.map((s) => s.symbol),
    ['ABLE'],
  );
});

test('empty fleet yields empty buckets', () => {
  const part = partitionFleet([], { crossShips: 2 });
  assert.equal(part.contractor, undefined);
  assert.deepEqual(part.cross, []);
  assert.deepEqual(part.local, []);
});

test('a fleet of only probes yields empty buckets', () => {
  const part = partitionFleet([ship('P1', 0, 0), ship('P2', 0, 0)], { crossShips: 1 });
  assert.equal(part.contractor, undefined);
  assert.deepEqual(part.cross, []);
  assert.deepEqual(part.local, []);
});

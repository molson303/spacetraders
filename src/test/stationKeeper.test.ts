import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runStationKeeping,
  type StationKeeperDeps,
} from '../behaviors/stationKeeper.js';
import type { StationAssignment } from '../util/stations.js';
import type { Ship } from '../types/index.js';

const api = {} as never;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal Ship shaped just enough for the station keeper's reads. */
function ship(
  symbol: string,
  waypoint: string,
  status: 'IN_ORBIT' | 'DOCKED' | 'IN_TRANSIT' = 'IN_ORBIT',
  system = 'X1-A20',
): Ship {
  return {
    symbol,
    nav: { systemSymbol: system, waypointSymbol: waypoint, status },
  } as unknown as Ship;
}

/** Move a ship's nav onto the given waypoint, as the real travel helpers do. */
function arrive(s: Ship, waypoint: string): Ship {
  return { ...s, nav: { ...s.nav, waypointSymbol: waypoint, status: 'IN_ORBIT' } } as Ship;
}

/** Deps that count travel concurrency and record which markets were scanned. */
function makeDeps(overrides: Partial<StationKeeperDeps> = {}) {
  const scanned: string[] = [];
  const traveled: string[] = [];
  let active = 0;
  let maxActive = 0;
  const deps: StationKeeperDeps = {
    travel: async (_api, s, dest) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(15);
      active--;
      traveled.push(`${s.symbol}->${dest}`);
      return arrive(s, dest);
    },
    crossTravel: async (_api, s, dest) => {
      traveled.push(`x:${s.symbol}->${dest}`);
      return arrive(s, dest);
    },
    scan: async (_api, _system, waypoint) => {
      scanned.push(waypoint);
    },
    ...overrides,
  };
  return { deps, scanned, traveled, stats: () => maxActive };
}

test('runStationKeeping: relocates drifted probes concurrently, not serially', async () => {
  const probes = [
    ship('P-1', 'X1-A20-YARD'),
    ship('P-2', 'X1-A20-YARD'),
    ship('P-3', 'X1-A20-YARD'),
  ];
  const stations: StationAssignment[] = [
    { ship: 'P-1', waypoint: 'X1-A20-M1' },
    { ship: 'P-2', waypoint: 'X1-A20-M2' },
    { ship: 'P-3', waypoint: 'X1-A20-M3' },
  ];
  const { deps, scanned, stats } = makeDeps();

  const res = await runStationKeeping(api, probes, stations, {}, deps);

  assert.equal(res.refreshed, 3);
  assert.equal(res.relocated, 3);
  // All three legs overlapped — serial execution would peak at 1.
  assert.equal(stats(), 3);
  assert.deepEqual(scanned.sort(), ['X1-A20-M1', 'X1-A20-M2', 'X1-A20-M3']);
});

test('runStationKeeping: probe already on station scans in place (no travel)', async () => {
  const probes = [ship('P-1', 'X1-A20-M1')];
  const stations: StationAssignment[] = [{ ship: 'P-1', waypoint: 'X1-A20-M1' }];
  const { deps, scanned, traveled } = makeDeps();

  const res = await runStationKeeping(api, probes, stations, {}, deps);

  assert.equal(res.refreshed, 1);
  assert.equal(res.relocated, 0);
  assert.deepEqual(traveled, []);
  assert.deepEqual(scanned, ['X1-A20-M1']);
});

test('runStationKeeping: in-transit probe is treated as off-station', async () => {
  const probes = [ship('P-1', 'X1-A20-M1', 'IN_TRANSIT')];
  const stations: StationAssignment[] = [{ ship: 'P-1', waypoint: 'X1-A20-M1' }];
  const { deps } = makeDeps();

  const res = await runStationKeeping(api, probes, stations, {}, deps);

  assert.equal(res.relocated, 1);
  assert.equal(res.refreshed, 1);
});

test('runStationKeeping: skips cross-system stations when jumps unavailable', async () => {
  const probes = [ship('P-1', 'X1-A20-YARD'), ship('P-2', 'X1-A20-YARD')];
  const stations: StationAssignment[] = [
    { ship: 'P-1', waypoint: 'X1-A20-M1' },
    { ship: 'P-2', waypoint: 'X1-B99-M1' }, // neighbor system
  ];
  const { deps, scanned } = makeDeps();

  const res = await runStationKeeping(api, probes, stations, { allowCrossSystem: false }, deps);

  assert.equal(res.refreshed, 1);
  assert.deepEqual(scanned, ['X1-A20-M1']);
});

test('runStationKeeping: services cross-system stations when jumps allowed', async () => {
  const probes = [ship('P-2', 'X1-A20-YARD')];
  const stations: StationAssignment[] = [{ ship: 'P-2', waypoint: 'X1-B99-M1' }];
  const { deps, scanned, traveled } = makeDeps();

  const res = await runStationKeeping(api, probes, stations, { allowCrossSystem: true }, deps);

  assert.equal(res.refreshed, 1);
  assert.equal(res.relocated, 1);
  assert.deepEqual(traveled, ['x:P-2->X1-B99-M1']);
  assert.deepEqual(scanned, ['X1-B99-M1']);
});

test('runStationKeeping: one probe failure does not sink the rest', async () => {
  const probes = [ship('P-1', 'X1-A20-YARD'), ship('P-2', 'X1-A20-YARD')];
  const stations: StationAssignment[] = [
    { ship: 'P-1', waypoint: 'X1-A20-M1' },
    { ship: 'P-2', waypoint: 'X1-A20-M2' },
  ];
  const { deps, scanned } = makeDeps({
    travel: async (_api, s, dest) => {
      if (s.symbol === 'P-1') throw new Error('boom');
      return arrive(s, dest);
    },
  });

  const res = await runStationKeeping(api, probes, stations, {}, deps);

  assert.equal(res.refreshed, 1);
  assert.equal(res.relocated, 1);
  assert.deepEqual(scanned, ['X1-A20-M2']);
});

test('runStationKeeping: probe that fails to reach station is not counted', async () => {
  const probes = [ship('P-1', 'X1-A20-YARD')];
  const stations: StationAssignment[] = [{ ship: 'P-1', waypoint: 'X1-A20-M1' }];
  const { deps, scanned } = makeDeps({
    // Travel "succeeds" but lands the ship somewhere other than the station.
    travel: async (_api, s) => arrive(s, 'X1-A20-WRONG'),
  });

  const res = await runStationKeeping(api, probes, stations, {}, deps);

  assert.equal(res.refreshed, 0);
  assert.equal(res.relocated, 0);
  assert.deepEqual(scanned, []);
});

test('runStationKeeping: shouldStop short-circuits the whole pass', async () => {
  const probes = [ship('P-1', 'X1-A20-YARD')];
  const stations: StationAssignment[] = [{ ship: 'P-1', waypoint: 'X1-A20-M1' }];
  const { deps, scanned, traveled } = makeDeps();

  const res = await runStationKeeping(api, probes, stations, { shouldStop: () => true }, deps);

  assert.equal(res.refreshed, 0);
  assert.equal(res.relocated, 0);
  assert.deepEqual(traveled, []);
  assert.deepEqual(scanned, []);
});

test('runStationKeeping: unknown ship symbols are skipped', async () => {
  const probes = [ship('P-1', 'X1-A20-M1')];
  const stations: StationAssignment[] = [
    { ship: 'P-1', waypoint: 'X1-A20-M1' },
    { ship: 'P-GONE', waypoint: 'X1-A20-M2' },
  ];
  const { deps, scanned } = makeDeps();

  const res = await runStationKeeping(api, probes, stations, {}, deps);

  assert.equal(res.refreshed, 1);
  assert.deepEqual(scanned, ['X1-A20-M1']);
});

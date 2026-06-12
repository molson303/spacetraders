import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRemoteScout, type RemoteScoutDeps } from '../behaviors/remoteScout.js';
import type { Ship } from '../types/index.js';

const api = {} as never;
const HOME = 'X1-A20';
const HOME_GATE = 'X1-A20-I56';

function ship(system = HOME, waypoint = 'X1-A20-A1'): Ship {
  return {
    symbol: 'PROBE-1',
    nav: { systemSymbol: system, waypointSymbol: waypoint, status: 'IN_ORBIT' },
  } as unknown as Ship;
}

/**
 * Deps backed by a fake wall clock. `crossTravelMs` and `travelMs` advance the
 * clock so a test can prove the cross-gate travel never eats the scan budget.
 */
function makeDeps(opts: {
  connections?: string[];
  marketsBySystem?: Record<string, string[]>;
  scanned?: Set<string>;
  crossTravelMs?: number;
  travelMs?: number;
  overrides?: Partial<RemoteScoutDeps>;
} = {}) {
  const connections = opts.connections ?? ['X1-FU76-I80', 'X1-CN42-I81'];
  const marketsBySystem = opts.marketsBySystem ?? {
    'X1-FU76': ['X1-FU76-A', 'X1-FU76-B', 'X1-FU76-C'],
    'X1-CN42': ['X1-CN42-A', 'X1-CN42-B'],
  };
  const scannedSystems = opts.scanned ?? new Set<string>();
  const crossTravelMs = opts.crossTravelMs ?? 0;
  const travelMs = opts.travelMs ?? 0;

  let clock = 0;
  const scanCalls: string[] = [];
  const crossLegs: string[] = [];

  const deps: RemoteScoutDeps = {
    hydrateGates: async () => {},
    hydrateWaypoints: async () => {},
    homeGate: () => HOME_GATE,
    gateConnections: () => connections,
    underConstruction: () => false,
    isScanned: (sys) => scannedSystems.has(sys),
    marketsIn: (sys) => marketsBySystem[sys] ?? [],
    crossTravel: async (_api, s, dest) => {
      clock += crossTravelMs;
      crossLegs.push(dest);
      const sys = dest.split('-').slice(0, 2).join('-');
      return { ...s, nav: { ...s.nav, systemSymbol: sys, waypointSymbol: dest, status: 'IN_ORBIT' } } as Ship;
    },
    travel: async (_api, s, dest) => {
      clock += travelMs;
      return { ...s, nav: { ...s.nav, waypointSymbol: dest, status: 'IN_ORBIT' } } as Ship;
    },
    scan: async (_api, _sys, waypoint) => {
      scanCalls.push(waypoint);
    },
    now: () => clock,
    ...opts.overrides,
  };
  return { deps, scanCalls, crossLegs, clock: () => clock };
}

test('runRemoteScout: long travel to the gate does NOT consume the scan budget', async () => {
  // Cross-gate leg burns 100x the budget; markets must still get scanned because
  // the budget is measured from arrival in the neighbor, not function entry.
  const { deps, scanCalls } = makeDeps({ crossTravelMs: 100_000, travelMs: 10 });

  const res = await runRemoteScout(api, ship(), HOME, { budgetMs: 1_000 }, deps);

  assert.equal(res.scannedSystems, 2);
  // Every market in both neighbors scanned despite the huge travel time.
  assert.deepEqual(scanCalls, [
    'X1-FU76-A', 'X1-FU76-B', 'X1-FU76-C',
    'X1-CN42-A', 'X1-CN42-B',
  ]);
});

test('runRemoteScout: budget bounds in-system scanning (from arrival)', async () => {
  // Each in-system hop costs 600ms against a 1000ms per-system budget: hop1 ->
  // scan (clock 600), hop2 -> scan (clock 1200), then 1200 >= 1000 stops it.
  const { deps, scanCalls } = makeDeps({
    crossTravelMs: 0,
    travelMs: 600,
    marketsBySystem: { 'X1-FU76': ['X1-FU76-A', 'X1-FU76-B', 'X1-FU76-C', 'X1-FU76-D'] },
    connections: ['X1-FU76-I80'],
  });

  const res = await runRemoteScout(api, ship(), HOME, { budgetMs: 1_000, maxSystems: 1 }, deps);

  assert.equal(res.scannedSystems, 1);
  assert.deepEqual(scanCalls, ['X1-FU76-A', 'X1-FU76-B']);
});

test('runRemoteScout: budget resets per system (second neighbor fully scanned)', async () => {
  // budgetMs only limits within a system; the second neighbor gets its own fresh
  // window even though wall-clock has advanced far past one budget total.
  const { deps, scanCalls } = makeDeps({ crossTravelMs: 5_000, travelMs: 1 });

  const res = await runRemoteScout(api, ship(), HOME, { budgetMs: 1_000 }, deps);

  assert.equal(res.scannedSystems, 2);
  assert.equal(scanCalls.length, 5);
});

test('runRemoteScout: respects maxSystems and marketsPerSystem caps', async () => {
  const { deps, scanCalls } = makeDeps({ crossTravelMs: 1, travelMs: 1 });

  const res = await runRemoteScout(
    api,
    ship(),
    HOME,
    { maxSystems: 1, marketsPerSystem: 2, budgetMs: 1_000_000 },
    deps,
  );

  assert.equal(res.scannedSystems, 1);
  assert.deepEqual(scanCalls, ['X1-FU76-A', 'X1-FU76-B']);
});

test('runRemoteScout: gate under construction disables scouting', async () => {
  const { deps, scanCalls, crossLegs } = makeDeps({
    overrides: { underConstruction: () => true },
  });

  const res = await runRemoteScout(api, ship(), HOME, { budgetMs: 1_000 }, deps);

  assert.equal(res.scannedSystems, 0);
  assert.deepEqual(scanCalls, []);
  assert.deepEqual(crossLegs, []);
});

test('runRemoteScout: all neighbors already scanned is a no-op', async () => {
  const { deps, scanCalls } = makeDeps({ scanned: new Set(['X1-FU76', 'X1-CN42']) });

  const res = await runRemoteScout(api, ship(), HOME, { budgetMs: 1_000 }, deps);

  assert.equal(res.scannedSystems, 0);
  assert.deepEqual(scanCalls, []);
});

test('runRemoteScout: shouldStop short-circuits before any travel', async () => {
  const { deps, scanCalls, crossLegs } = makeDeps();

  const res = await runRemoteScout(
    api,
    ship(),
    HOME,
    { budgetMs: 1_000, shouldStop: () => true },
    deps,
  );

  assert.equal(res.scannedSystems, 0);
  assert.deepEqual(scanCalls, []);
  // Only the final "head home" leg may run; no scouting legs.
  assert.ok(!crossLegs.includes('X1-FU76-I80'));
});

test('runRemoteScout: no known home gate bails safely', async () => {
  const { deps, scanCalls } = makeDeps({ overrides: { homeGate: () => undefined } });

  const res = await runRemoteScout(api, ship(), HOME, { budgetMs: 1_000 }, deps);

  assert.equal(res.scannedSystems, 0);
  assert.deepEqual(scanCalls, []);
});

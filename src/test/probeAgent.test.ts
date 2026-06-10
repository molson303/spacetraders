import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProbeCycle, runProbeAgent, type ProbeCycleDeps } from '../agents/probeAgent.js';
import type { StationAssignment } from '../util/stations.js';
import type { Ship } from '../types/index.js';

function probe(symbol: string): Ship {
  return { symbol, fuel: { capacity: 0, current: 0 } } as unknown as Ship;
}

function deps(over: Partial<ProbeCycleDeps> = {}): ProbeCycleDeps {
  return {
    listScouts: async () => [probe('P1'), probe('P2')],
    getStations: () => [],
    stationKeep: async () => ({ refreshed: 0, relocated: 0 }),
    remoteScout: async () => ({ scannedSystems: 0 }),
    scan: async () => 0,
    refetchShip: async (sym) => probe(sym),
    gateOpen: () => true,
    ...over,
  };
}

test('returns zeros when there are no probes', async () => {
  const r = await runProbeCycle(deps({ listScouts: async () => [] }));
  assert.deepEqual(r, { refreshed: 0, relocated: 0, scoutedSystems: 0, scannedMarkets: 0 });
});

test('station-keeps stationed probes with cross allowed when the gate is open', async () => {
  const stations: StationAssignment[] = [{ ship: 'P1', waypoint: 'X1-A20-M1' }];
  let allowCrossSeen: boolean | undefined;
  const r = await runProbeCycle(
    deps({
      getStations: () => stations,
      stationKeep: async (_p, _s, allowCross) => {
        allowCrossSeen = allowCross;
        return { refreshed: 3, relocated: 1 };
      },
      // P2 is flex; keep it cheap
      scan: async () => 2,
    }),
  );
  assert.equal(allowCrossSeen, true);
  assert.equal(r.refreshed, 3);
  assert.equal(r.relocated, 1);
});

test('station-keeping disallows cross-system when the gate is shut', async () => {
  let allowCrossSeen: boolean | undefined;
  await runProbeCycle(
    deps({
      gateOpen: () => false,
      getStations: () => [{ ship: 'P1', waypoint: 'X1-A20-M1' }],
      stationKeep: async (_p, _s, allowCross) => {
        allowCrossSeen = allowCross;
        return { refreshed: 1, relocated: 0 };
      },
    }),
  );
  assert.equal(allowCrossSeen, false);
});

test('first flex probe scouts remotely when the gate is open', async () => {
  let scoutedShip: string | undefined;
  let scanned = false;
  const r = await runProbeCycle(
    deps({
      listScouts: async () => [probe('FLEX1')],
      remoteScout: async (s) => ((scoutedShip = s.symbol), { scannedSystems: 2 }),
      scan: async () => ((scanned = true), 0),
    }),
  );
  assert.equal(scoutedShip, 'FLEX1');
  assert.equal(r.scoutedSystems, 2);
  assert.equal(scanned, false); // found remote work -> no local fallback
});

test('first flex probe falls back to local scan when nothing remote is new', async () => {
  let refetched = false;
  const r = await runProbeCycle(
    deps({
      listScouts: async () => [probe('FLEX1')],
      remoteScout: async () => ({ scannedSystems: 0 }),
      refetchShip: async (sym) => ((refetched = true), probe(sym)),
      scan: async () => 4,
    }),
  );
  assert.ok(refetched);
  assert.equal(r.scoutedSystems, 0);
  assert.equal(r.scannedMarkets, 4);
});

test('flex probes only scan locally when the gate is shut (no remote scout)', async () => {
  let scoutCalled = false;
  const r = await runProbeCycle(
    deps({
      gateOpen: () => false,
      listScouts: async () => [probe('FLEX1'), probe('FLEX2')],
      remoteScout: async () => ((scoutCalled = true), { scannedSystems: 9 }),
      scan: async () => 5,
    }),
  );
  assert.equal(scoutCalled, false);
  assert.equal(r.scoutedSystems, 0);
  assert.equal(r.scannedMarkets, 10); // both flex probes scanned locally
});

test('extra flex probes scan locally and counts sum across probes', async () => {
  const r = await runProbeCycle(
    deps({
      listScouts: async () => [probe('FLEX1'), probe('FLEX2'), probe('FLEX3')],
      remoteScout: async () => ({ scannedSystems: 0 }),
      scan: async () => 3, // FLEX1 fallback + FLEX2 + FLEX3 = 9
    }),
  );
  assert.equal(r.scannedMarkets, 9);
});

test('a failing flex probe does not sink the pass', async () => {
  const r = await runProbeCycle(
    deps({
      listScouts: async () => [probe('FLEX1'), probe('FLEX2')],
      remoteScout: async () => ({ scannedSystems: 0 }),
      scan: async (s) => {
        if (s.symbol === 'FLEX1') throw new Error('boom');
        return 7;
      },
    }),
  );
  assert.equal(r.scannedMarkets, 7); // FLEX2 still counted
});

test('runProbeAgent runs maxPasses then stops, sleeping between', async () => {
  let cycles = 0;
  let delays = 0;
  const passes = await runProbeAgent(
    deps({ scan: async () => (cycles++, 1) }),
    {
      stopping: () => false,
      maxPasses: 3,
      delay: async () => void delays++,
    },
  );
  assert.equal(passes, 3);
  assert.equal(delays, 2); // no delay after the final pass
});

test('runProbeAgent exits immediately when already stopping', async () => {
  const passes = await runProbeAgent(deps(), { stopping: () => true, maxPasses: 10 });
  assert.equal(passes, 0);
});

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
    scan: async () => 0,
    gateOpen: () => true,
    ...over,
  };
}

test('returns zeros when there are no probes', async () => {
  const r = await runProbeCycle(deps({ listScouts: async () => [] }));
  assert.deepEqual(r, { refreshed: 0, relocated: 0, scannedMarkets: 0 });
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

test('reserves the first flex probe for the scout agent; scans the rest locally', async () => {
  const scanned: string[] = [];
  const r = await runProbeCycle(
    deps({
      listScouts: async () => [probe('FLEX1'), probe('FLEX2'), probe('FLEX3')],
      scan: async (s) => (scanned.push(s.symbol), 3),
    }),
  );
  // FLEX1 (flex index 0) is reserved for the decoupled scout agent.
  assert.deepEqual(scanned, ['FLEX2', 'FLEX3']);
  assert.equal(r.scannedMarkets, 6);
});

test('a single flex probe is reserved (no local scan) for the scout agent', async () => {
  let scanned = false;
  const r = await runProbeCycle(
    deps({
      listScouts: async () => [probe('FLEX1')],
      scan: async () => ((scanned = true), 9),
    }),
  );
  assert.equal(scanned, false);
  assert.equal(r.scannedMarkets, 0);
});

test('a failing flex probe does not sink the pass', async () => {
  const r = await runProbeCycle(
    deps({
      listScouts: async () => [probe('FLEX1'), probe('FLEX2'), probe('FLEX3')],
      scan: async (s) => {
        if (s.symbol === 'FLEX2') throw new Error('boom');
        return 7;
      },
    }),
  );
  // FLEX1 reserved; FLEX2 throws but FLEX3 still counted.
  assert.equal(r.scannedMarkets, 7);
});

test('runProbeAgent runs maxPasses then stops, sleeping between', async () => {
  let delays = 0;
  const passes = await runProbeAgent(deps(), {
    stopping: () => false,
    maxPasses: 3,
    delay: async () => void delays++,
  });
  assert.equal(passes, 3);
  assert.equal(delays, 2); // no delay after the final pass
});

test('runProbeAgent exits immediately when already stopping', async () => {
  const passes = await runProbeAgent(deps(), { stopping: () => true, maxPasses: 10 });
  assert.equal(passes, 0);
});

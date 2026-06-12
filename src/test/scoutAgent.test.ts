import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScoutCycle, runScoutAgent, type ScoutCycleDeps } from '../agents/scoutAgent.js';
import type { StationAssignment } from '../util/stations.js';
import type { Ship } from '../types/index.js';

function probe(symbol: string): Ship {
  return { symbol, fuel: { capacity: 0, current: 0 } } as unknown as Ship;
}

function deps(over: Partial<ScoutCycleDeps> = {}): ScoutCycleDeps {
  return {
    listScouts: async () => [probe('FLEX1'), probe('FLEX2')],
    getStations: () => [],
    remoteScout: async () => ({ scannedSystems: 0 }),
    gateOpen: () => true,
    ...over,
  };
}

test('scouts the first flex probe when the gate is open', async () => {
  let scoutedShip: string | undefined;
  const r = await runScoutCycle(
    deps({
      listScouts: async () => [probe('FLEX1'), probe('FLEX2')],
      remoteScout: async (s) => ((scoutedShip = s.symbol), { scannedSystems: 2 }),
    }),
  );
  assert.equal(scoutedShip, 'FLEX1');
  assert.equal(r.scoutedSystems, 2);
});

test('no scout when the gate is shut', async () => {
  let scoutCalled = false;
  const r = await runScoutCycle(
    deps({
      gateOpen: () => false,
      remoteScout: async () => ((scoutCalled = true), { scannedSystems: 9 }),
    }),
  );
  assert.equal(scoutCalled, false);
  assert.equal(r.scoutedSystems, 0);
});

test('no scout when there are no probes', async () => {
  let scoutCalled = false;
  const r = await runScoutCycle(
    deps({
      listScouts: async () => [],
      remoteScout: async () => ((scoutCalled = true), { scannedSystems: 1 }),
    }),
  );
  assert.equal(scoutCalled, false);
  assert.equal(r.scoutedSystems, 0);
});

test('no scout when every probe is stationed (flex pool empty)', async () => {
  let scoutCalled = false;
  const stations: StationAssignment[] = [
    { ship: 'FLEX1', waypoint: 'X1-A20-M1' },
    { ship: 'FLEX2', waypoint: 'X1-A20-M2' },
  ];
  const r = await runScoutCycle(
    deps({
      getStations: () => stations,
      remoteScout: async () => ((scoutCalled = true), { scannedSystems: 1 }),
    }),
  );
  assert.equal(scoutCalled, false);
  assert.equal(r.scoutedSystems, 0);
});

test('reports zero when there is nothing new to scout', async () => {
  const r = await runScoutCycle(deps({ remoteScout: async () => ({ scannedSystems: 0 }) }));
  assert.equal(r.scoutedSystems, 0);
});

test('runScoutAgent runs maxPasses then stops, sleeping between', async () => {
  let delays = 0;
  const passes = await runScoutAgent(deps(), {
    stopping: () => false,
    maxPasses: 3,
    delay: async () => void delays++,
  });
  assert.equal(passes, 3);
  assert.equal(delays, 2); // no delay after the final pass
});

test('runScoutAgent exits immediately when already stopping', async () => {
  const passes = await runScoutAgent(deps(), { stopping: () => true, maxPasses: 10 });
  assert.equal(passes, 0);
});

test('a scout error does not stop the loop', async () => {
  let passes = 0;
  const total = await runScoutAgent(
    deps({
      remoteScout: async () => {
        passes++;
        throw new Error('boom');
      },
    }),
    { stopping: () => false, maxPasses: 2, delay: async () => {} },
  );
  assert.equal(total, 2);
  assert.equal(passes, 2);
});

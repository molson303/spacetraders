import './_setupMemoryDb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTrader } from '../behaviors/trader.js';
import type { SpaceTradersApi } from '../client/api.js';
import type { Ship } from '../types/index.js';

/** Minimal ship with an empty hold parked at a waypoint. */
function ship(): Ship {
  return {
    symbol: 'TEST-1',
    nav: { systemSymbol: 'X1-A20', waypointSymbol: 'X1-A20-A1', status: 'DOCKED' },
    cargo: { capacity: 40, units: 0, inventory: [] },
  } as unknown as Ship;
}

/** Stub API whose market lookups fail so scan/drain are inert no-ops. */
function stubApi(): SpaceTradersApi {
  return {
    getMarket: async () => {
      throw new Error('no market (stub)');
    },
  } as unknown as SpaceTradersApi;
}

test('runTrader honors shouldStop before starting any cycle (round time-box)', async () => {
  const res = await runTrader(stubApi(), ship(), 'X1-A20', {
    cycles: 3,
    shouldStop: () => true,
  });
  assert.equal(res.cycles, 0);
  assert.equal(res.profit, 0);
});

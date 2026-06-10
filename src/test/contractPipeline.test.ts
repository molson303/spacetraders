import './_setupMemoryDb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runContractPipeline } from '../behaviors/contractPipeline.js';
import type { SpaceTradersApi } from '../client/api.js';
import type { Contract, Ship } from '../types/index.js';

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

/** An accepted-but-unfulfilled procurement contract for a good with no exporter. */
function activeContract(): Contract {
  return {
    id: 'stuck-1',
    factionSymbol: 'COSMIC',
    type: 'PROCUREMENT',
    accepted: true,
    fulfilled: false,
    terms: {
      deadline: FUTURE,
      payment: { onAccepted: 1000, onFulfilled: 9000 },
      deliver: [
        {
          tradeSymbol: 'LIQUID_HYDROGEN',
          destinationSymbol: 'X1-A20-A1',
          unitsRequired: 100,
          unitsFulfilled: 0,
        },
      ],
    },
  } as unknown as Contract;
}

function ship(): Ship {
  return {
    symbol: 'TEST-1',
    nav: { systemSymbol: 'X1-A20', waypointSymbol: 'X1-A20-A1', status: 'DOCKED' },
    cargo: { capacity: 40, units: 0, inventory: [] },
  } as unknown as Ship;
}

test('runContractPipeline skips negotiation when an active contract blocks the slot', async () => {
  let negotiated = 0;
  const api = {
    listContracts: async () => ({ data: [activeContract()] }),
    negotiateContract: async () => {
      negotiated++;
      throw new Error('Agent already has an active contract.');
    },
    dockShip: async () => undefined,
  } as unknown as SpaceTradersApi;

  const completed = await runContractPipeline(api, ship(), 'X1-A20', { maxContracts: 1 });
  assert.equal(completed, 0);
  assert.equal(negotiated, 0); // never wasted a (doomed) negotiate / HQ round trip
});

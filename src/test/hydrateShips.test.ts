// In-memory DB must be opened before config/db singletons load.
import './_setupMemoryDb.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../state/db.js';
import { hydrateShips } from '../state/world.js';
import { SpaceTradersApi } from '../client/api.js';
import { ApiError } from '../client/http.js';
import type { Ship } from '../types/index.js';
import type { SpaceTradersApi as Api } from '../client/api.js';

getDb();

function ship(symbol: string): Ship {
  return {
    symbol,
    registration: { name: symbol, factionSymbol: 'X', role: 'EXCAVATOR' },
    frame: { symbol: 'FRAME_DRONE' },
    nav: {
      systemSymbol: 'X1-A20',
      waypointSymbol: 'X1-A20-I56',
      status: 'DOCKED',
      flightMode: 'CRUISE',
    },
    fuel: { current: 100, capacity: 100 },
    cargo: { units: 0, capacity: 40, inventory: [] },
    cooldown: { expiration: undefined },
  } as unknown as Ship;
}

/** A real SpaceTradersApi with listShips stubbed to page over a fixed roster,
 *  optionally 500ing on any page that would include a "corrupt" ship. This
 *  exercises the real listAllShips() bulk + per-ship fallback orchestration. */
function apiWithRoster(roster: string[], corrupt: Set<string>): SpaceTradersApi {
  const api = new SpaceTradersApi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (api as any).listShips = async ({ page = 1, limit = 20 } = {}) => {
    const start = (page - 1) * limit;
    const slice = roster.slice(start, start + limit);
    if (slice.some((s) => corrupt.has(s))) {
      throw new ApiError(500, 3000, 'The server did not return a valid response.');
    }
    return { data: slice.map(ship), meta: { total: roster.length, page, limit } };
  };
  return api;
}

test('listAllShips uses the fast bulk path when the server is healthy', async () => {
  const roster = ['A-1', 'A-2', 'A-3'];
  const ships = await apiWithRoster(roster, new Set()).listAllShips();
  assert.deepEqual(
    ships.map((s) => s.symbol),
    roster,
  );
});

test('listAllShips falls back to a per-ship scan and skips an unserializable ship', async () => {
  const roster = ['B-1', 'B-2', 'B-3', 'B-4', 'B-5'];
  // B-3 is corrupt: the bulk limit=20 page fails, and the limit=1 page for B-3 fails.
  const ships = await apiWithRoster(roster, new Set(['B-3'])).listAllShips();
  assert.deepEqual(
    ships.map((s) => s.symbol),
    ['B-1', 'B-2', 'B-4', 'B-5'],
    'should keep the four healthy ships and skip the corrupt one',
  );
});

test('listAllShips rethrows non-5xx errors instead of degrading', async () => {
  const api = new SpaceTradersApi();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (api as any).listShips = async () => {
    throw new ApiError(401, 4100, 'Token is invalid.');
  };
  await assert.rejects(
    () => api.listAllShips(),
    (err: unknown) => err instanceof ApiError && err.httpStatus === 401,
  );
});

test('hydrateShips persists the roster returned by listAllShips', async () => {
  const fake = {
    async listAllShips() {
      return [ship('H-1'), ship('H-2')];
    },
  } as unknown as Api;
  const ships = await hydrateShips(fake);
  assert.equal(ships.length, 2);
  const row = getDb().prepare('SELECT symbol FROM ships WHERE symbol = ?').get('H-1') as
    | { symbol: string }
    | undefined;
  assert.equal(row?.symbol, 'H-1');
});

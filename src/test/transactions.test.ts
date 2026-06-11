// In-memory DB must be opened before config/db singletons load.
import './_setupMemoryDb.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../state/db.js';
import {
  countTransactionsByWaypoint,
  recordTransaction,
  upsertWaypoint,
} from '../state/repos.js';
import type { Waypoint } from '../types/index.js';

getDb();

function market(symbol: string, system = 'X1-TX'): Waypoint {
  return {
    symbol,
    systemSymbol: system,
    type: 'PLANET',
    x: 0,
    y: 0,
    orbitals: [],
    traits: [],
    isUnderConstruction: false,
  };
}

// Two markets in the target system, one in a different system.
upsertWaypoint(market('X1-TX-A1'));
upsertWaypoint(market('X1-TX-A2'));
upsertWaypoint(market('X1-OTHER-Z9', 'X1-OTHER'));

// Recent activity: A1 busier than A2; one transaction in another system.
for (let i = 0; i < 5; i++) recordTransaction({ kind: 'SELL_CARGO', waypoint: 'X1-TX-A1' });
for (let i = 0; i < 2; i++) recordTransaction({ kind: 'BUY_CARGO', waypoint: 'X1-TX-A2' });
recordTransaction({ kind: 'SELL_CARGO', waypoint: 'X1-OTHER-Z9' });
// A transaction with no waypoint must be ignored.
recordTransaction({ kind: 'REFUEL' });
// An old transaction (30 days ago) at A2 must fall outside the default window.
getDb()
  .prepare(
    `INSERT INTO transactions (observed_at, kind, waypoint) VALUES (datetime('now','-30 days'), ?, ?)`,
  )
  .run('SELL_CARGO', 'X1-TX-A2');

test('counts recent transactions per waypoint, scoped to the system', () => {
  const counts = countTransactionsByWaypoint('X1-TX');
  assert.equal(counts.get('X1-TX-A1'), 5);
  assert.equal(counts.get('X1-TX-A2'), 2); // old row excluded by 7-day window
  assert.equal(counts.has('X1-OTHER-Z9'), false); // other system excluded
});

test('busier markets outrank quieter ones', () => {
  const counts = countTransactionsByWaypoint('X1-TX');
  assert.ok((counts.get('X1-TX-A1') ?? 0) > (counts.get('X1-TX-A2') ?? 0));
});

test('widening the window includes older activity', () => {
  const counts = countTransactionsByWaypoint('X1-TX', 60);
  assert.equal(counts.get('X1-TX-A2'), 3); // now includes the 30-day-old row
});

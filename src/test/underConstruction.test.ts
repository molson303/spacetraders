// In-memory DB must be opened before config/db singletons load.
import './_setupMemoryDb.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../state/db.js';
import { isWaypointUnderConstruction, upsertWaypoint } from '../state/repos.js';
import type { Waypoint } from '../types/index.js';

getDb();

function waypoint(symbol: string, underConstruction: boolean): Waypoint {
  return {
    symbol,
    systemSymbol: symbol.split('-').slice(0, 2).join('-'),
    type: 'JUMP_GATE',
    x: 0,
    y: 0,
    orbitals: [],
    traits: [],
    isUnderConstruction: underConstruction,
  };
}

upsertWaypoint(waypoint('X1-A20-I56', true));
upsertWaypoint(waypoint('X1-A20-I57', false));

test('returns true for a waypoint flagged under construction', () => {
  assert.equal(isWaypointUnderConstruction('X1-A20-I56'), true);
});

test('returns false for a waypoint that is operational', () => {
  assert.equal(isWaypointUnderConstruction('X1-A20-I57'), false);
});

test('returns false for an unknown waypoint', () => {
  assert.equal(isWaypointUnderConstruction('X1-ZZ99-NOPE'), false);
});

test('reflects an updated construction flag after re-upsert', () => {
  upsertWaypoint(waypoint('X1-A20-I56', false));
  assert.equal(isWaypointUnderConstruction('X1-A20-I56'), false);
});

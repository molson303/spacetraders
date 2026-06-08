import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  componentConditions,
  lowestCondition,
  needsRepair,
  DEFAULT_REPAIR_THRESHOLD,
} from '../behaviors/maintenance.js';
import type { Ship } from '../types/index.js';

function ship(c: { frame?: number; reactor?: number; engine?: number }): Ship {
  return {
    symbol: 'S-1',
    registration: { name: 'S-1', factionSymbol: 'COSMIC', role: 'HAULER' },
    nav: {
      systemSymbol: 'X1-A20',
      waypointSymbol: 'X1-A20-A1',
      route: {
        origin: { symbol: 'X1-A20-A1', type: 'PLANET', x: 0, y: 0 },
        destination: { symbol: 'X1-A20-A1', type: 'PLANET', x: 0, y: 0 },
        arrival: new Date().toISOString(),
        departureTime: new Date().toISOString(),
      },
      status: 'DOCKED',
      flightMode: 'CRUISE',
    },
    crew: { current: 0, capacity: 0, required: 0, morale: 100 },
    frame: { symbol: 'FRAME', name: 'Frame', condition: c.frame },
    reactor: { symbol: 'REACTOR', condition: c.reactor },
    engine: { symbol: 'ENGINE', speed: 30, condition: c.engine },
    cooldown: { shipSymbol: 'S-1', totalSeconds: 0, remainingSeconds: 0 },
    modules: [],
    mounts: [],
    cargo: { capacity: 40, units: 0, inventory: [] },
    fuel: { current: 400, capacity: 400 },
  };
}

test('componentConditions collects only defined conditions', () => {
  assert.deepEqual(componentConditions(ship({ frame: 0.9, reactor: 0.5, engine: 0.7 })), [
    0.9, 0.5, 0.7,
  ]);
  assert.deepEqual(componentConditions(ship({ frame: 0.9 })), [0.9]);
  assert.deepEqual(componentConditions(ship({})), []);
});

test('lowestCondition returns the worst component, or undefined when none reported', () => {
  assert.equal(lowestCondition(ship({ frame: 0.9, reactor: 0.3, engine: 0.7 })), 0.3);
  assert.equal(lowestCondition(ship({})), undefined);
});

test('needsRepair triggers when any component is at/below threshold', () => {
  assert.equal(needsRepair(ship({ frame: 0.9, reactor: 0.35, engine: 0.8 })), true); // 0.35 <= 0.4
  assert.equal(needsRepair(ship({ frame: 0.9, reactor: 0.5, engine: 0.8 })), false);
});

test('needsRepair treats the threshold as inclusive', () => {
  assert.equal(needsRepair(ship({ frame: DEFAULT_REPAIR_THRESHOLD })), true);
});

test('needsRepair honours a custom threshold', () => {
  assert.equal(needsRepair(ship({ frame: 0.6 }), 0.7), true);
  assert.equal(needsRepair(ship({ frame: 0.6 }), 0.5), false);
});

test('needsRepair is false when the ship reports no condition data', () => {
  assert.equal(needsRepair(ship({})), false);
});

// Open an in-memory DB before any module pulls in config/db (singleton).
// This MUST be the first import so it runs before db.ts is evaluated.
import './_setupMemoryDb.js';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../state/db.js';
import {
  upsertSystem,
  getSystemRow,
  upsertJumpGate,
  getJumpGateRow,
  findJumpGatesBySystem,
} from '../state/repos.js';
import type { JumpGate, System } from '../types/index.js';

// Force migrations to run against the in-memory DB up front.
getDb();

const SYS: System = {
  symbol: 'X1-A20',
  sectorSymbol: 'X1',
  type: 'RED_STAR',
  x: 19437,
  y: 10462,
  waypoints: [{ symbol: 'X1-A20-A1', type: 'PLANET', x: 0, y: 0 }],
};

const GATE: JumpGate = {
  symbol: 'X1-A20-I56',
  connections: ['X1-FU76-FD6F', 'X1-CN42-I67', 'X1-CY96-I50'],
};

test('v2 migration creates systems and jump_gates tables', () => {
  const tables = getDb()
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('systems','jump_gates')")
    .all() as { name: string }[];
  const names = tables.map((t) => t.name).sort();
  assert.deepEqual(names, ['jump_gates', 'systems']);
});

test('upsertSystem round-trips a system row', () => {
  upsertSystem(SYS);
  const row = getSystemRow('X1-A20');
  assert.ok(row);
  assert.equal(row!.symbol, 'X1-A20');
  assert.equal(row!.sector, 'X1');
  assert.equal(row!.type, 'RED_STAR');
  assert.equal(row!.x, 19437);
  assert.equal(row!.y, 10462);
});

test('upsertSystem is idempotent on the primary key', () => {
  upsertSystem(SYS);
  upsertSystem({ ...SYS, type: 'ORANGE_STAR' });
  const row = getSystemRow('X1-A20');
  assert.equal(row!.type, 'ORANGE_STAR');
  const count = getDb()
    .prepare("SELECT COUNT(*) AS c FROM systems WHERE symbol = 'X1-A20'")
    .get() as { c: number };
  assert.equal(count.c, 1);
});

test('getSystemRow returns undefined for an unknown system', () => {
  assert.equal(getSystemRow('X1-ZZZZ'), undefined);
});

test('upsertJumpGate persists and parses connections', () => {
  upsertJumpGate('X1-A20', GATE);
  const row = getJumpGateRow('X1-A20-I56');
  assert.ok(row);
  assert.equal(row!.system, 'X1-A20');
  assert.deepEqual(row!.connections, ['X1-FU76-FD6F', 'X1-CN42-I67', 'X1-CY96-I50']);
});

test('upsertJumpGate updates connections on conflict', () => {
  upsertJumpGate('X1-A20', GATE);
  upsertJumpGate('X1-A20', { symbol: 'X1-A20-I56', connections: ['X1-GK27-I51'] });
  const row = getJumpGateRow('X1-A20-I56');
  assert.deepEqual(row!.connections, ['X1-GK27-I51']);
});

test('findJumpGatesBySystem returns all gates for a system', () => {
  upsertJumpGate('X1-A20', GATE);
  const gates = findJumpGatesBySystem('X1-A20');
  assert.equal(gates.length, 1);
  assert.equal(gates[0]!.symbol, 'X1-A20-I56');
});

test('getJumpGateRow returns undefined for an unknown gate', () => {
  assert.equal(getJumpGateRow('X1-NONE-X9'), undefined);
});

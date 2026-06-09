import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findJumpPath, directNeighborSystems, pickScoutTargets } from '../util/jumpPath.js';

// A small gate graph. Gate waypoints follow X1-<SYSTEM>-<id>; systemOf strips
// to the first two segments.
const GRAPH: Record<string, string[]> = {
  'X1-A20-I56': ['X1-CN42-I67', 'X1-CY96-I50', 'X1-GK27-I51'],
  'X1-CN42-I67': ['X1-A20-I56', 'X1-ZZ99-I10'],
  'X1-CY96-I50': ['X1-A20-I56'],
  'X1-GK27-I51': ['X1-A20-I56'],
  'X1-ZZ99-I10': ['X1-CN42-I67'],
};
const neighbors = (g: string): string[] => GRAPH[g] ?? [];
const systemOf = (wp: string): string => wp.split('-').slice(0, 2).join('-');

test('empty path when the start gate is already in the target system', () => {
  assert.deepEqual(findJumpPath('X1-A20-I56', 'X1-A20', neighbors, systemOf), []);
});

test('single hop to a directly connected system', () => {
  assert.deepEqual(findJumpPath('X1-A20-I56', 'X1-CN42', neighbors, systemOf), ['X1-CN42-I67']);
  assert.deepEqual(findJumpPath('X1-A20-I56', 'X1-GK27', neighbors, systemOf), ['X1-GK27-I51']);
});

test('multi-hop path through an intermediate system', () => {
  // A20 -> CN42 -> ZZ99
  assert.deepEqual(findJumpPath('X1-A20-I56', 'X1-ZZ99', neighbors, systemOf), [
    'X1-CN42-I67',
    'X1-ZZ99-I10',
  ]);
});

test('returns undefined for an unreachable system', () => {
  assert.equal(findJumpPath('X1-A20-I56', 'X1-NOPE', neighbors, systemOf), undefined);
});

test('returns undefined when the start gate has no known connections', () => {
  assert.equal(findJumpPath('X1-UNKNOWN-G1', 'X1-CN42', neighbors, systemOf), undefined);
});

test('respects maxHops bound', () => {
  // ZZ99 needs 2 hops; cap at 1 -> not found.
  assert.equal(
    findJumpPath('X1-A20-I56', 'X1-ZZ99', neighbors, systemOf, { maxHops: 1 }),
    undefined,
  );
});

test('does not revisit gates (no infinite loop on cycles)', () => {
  // CN42 <-> A20 form a cycle; searching an unreachable system must still
  // terminate and return undefined rather than loop forever.
  assert.equal(findJumpPath('X1-CN42-I67', 'X1-MISSING', neighbors, systemOf), undefined);
});

test('directNeighborSystems lists the distinct systems one jump away', () => {
  assert.deepEqual(directNeighborSystems('X1-A20-I56', neighbors, systemOf).sort(), [
    'X1-CN42',
    'X1-CY96',
    'X1-GK27',
  ]);
});

test('pickScoutTargets returns unscanned neighbor systems only', () => {
  const scanned = new Set(['X1-CY96']);
  const targets = pickScoutTargets(
    'X1-A20-I56',
    neighbors,
    systemOf,
    (s) => scanned.has(s),
  ).sort();
  assert.deepEqual(targets, ['X1-CN42', 'X1-GK27']);
});

test('pickScoutTargets returns empty when all neighbors are scanned', () => {
  const targets = pickScoutTargets('X1-A20-I56', neighbors, systemOf, () => true);
  assert.deepEqual(targets, []);
});

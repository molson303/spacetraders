import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectShipyard,
  orderShipyardsForPurchase,
  type ShipyardCandidate,
} from '../util/shipyard.js';

const YARDS: ShipyardCandidate[] = [
  { symbol: 'X1-A20-A2', x: 10, y: 10 },
  { symbol: 'X1-A20-B7', x: 0, y: 0 },
  { symbol: 'X1-A20-C9', x: 30, y: 40 },
];

test('returns undefined when there are no yards and no override', () => {
  assert.equal(selectShipyard([]), undefined);
  assert.equal(selectShipyard([], { from: { x: 0, y: 0 } }), undefined);
});

test('override always wins, even when not in the discovered list', () => {
  assert.equal(selectShipyard(YARDS, { override: 'X1-ZZ-Q1' }), 'X1-ZZ-Q1');
  // override beats nearest selection too
  assert.equal(
    selectShipyard(YARDS, { override: 'X1-ZZ-Q1', from: { x: 0, y: 0 } }),
    'X1-ZZ-Q1',
  );
});

test('override beats an empty list', () => {
  assert.equal(selectShipyard([], { override: 'X1-ZZ-Q1' }), 'X1-ZZ-Q1');
});

test('blank/whitespace override is ignored', () => {
  assert.equal(selectShipyard(YARDS, { override: '   ' }), 'X1-A20-A2');
  assert.equal(selectShipyard(YARDS, { override: '' }), 'X1-A20-A2');
});

test('without an origin, falls back to the first discovered yard', () => {
  assert.equal(selectShipyard(YARDS), 'X1-A20-A2');
});

test('with an origin, picks the nearest yard', () => {
  // origin (1,1): nearest is B7 at (0,0)
  assert.equal(selectShipyard(YARDS, { from: { x: 1, y: 1 } }), 'X1-A20-B7');
  // origin (12,11): nearest is A2 at (10,10)
  assert.equal(selectShipyard(YARDS, { from: { x: 12, y: 11 } }), 'X1-A20-A2');
  // origin (29,39): nearest is C9 at (30,40)
  assert.equal(selectShipyard(YARDS, { from: { x: 29, y: 39 } }), 'X1-A20-C9');
});

test('nearest selection is stable on ties (keeps the earlier candidate)', () => {
  const tied: ShipyardCandidate[] = [
    { symbol: 'FIRST', x: 5, y: 0 },
    { symbol: 'SECOND', x: -5, y: 0 },
  ];
  // origin at (0,0) is equidistant; first candidate wins
  assert.equal(selectShipyard(tied, { from: { x: 0, y: 0 } }), 'FIRST');
});

test('single-yard list returns that yard regardless of origin', () => {
  const one: ShipyardCandidate[] = [{ symbol: 'ONLY', x: 99, y: 99 }];
  assert.equal(selectShipyard(one), 'ONLY');
  assert.equal(selectShipyard(one, { from: { x: 0, y: 0 } }), 'ONLY');
});

test('orderShipyardsForPurchase puts known sellers first', () => {
  // B7 is nearest overall, but only A2 and C9 are known to sell the type.
  const order = orderShipyardsForPurchase(YARDS, new Set(['X1-A20-A2', 'X1-A20-C9']), {
    from: { x: 0, y: 0 },
  });
  // Known sellers first (nearest among them: A2 at (10,10) before C9 at (30,40)),
  // then the unknown B7 last despite being closest.
  assert.deepEqual(order, ['X1-A20-A2', 'X1-A20-C9', 'X1-A20-B7']);
});

test('orderShipyardsForPurchase: no known sellers -> nearest-first discovery order', () => {
  const order = orderShipyardsForPurchase(YARDS, new Set(), { from: { x: 1, y: 1 } });
  assert.deepEqual(order, ['X1-A20-B7', 'X1-A20-A2', 'X1-A20-C9']);
});

test('orderShipyardsForPurchase: override leads and is not duplicated', () => {
  const order = orderShipyardsForPurchase(YARDS, new Set(['X1-A20-C9']), {
    override: 'X1-A20-A2',
    from: { x: 0, y: 0 },
  });
  // Override first; remaining known seller C9 next; then unknown B7.
  assert.deepEqual(order, ['X1-A20-A2', 'X1-A20-C9', 'X1-A20-B7']);
});

test('orderShipyardsForPurchase: override outside the list is still prepended', () => {
  const order = orderShipyardsForPurchase(YARDS, new Set(), { override: 'X1-ZZ-Q1' });
  assert.equal(order[0], 'X1-ZZ-Q1');
  assert.equal(order.length, YARDS.length + 1);
});

test('orderShipyardsForPurchase: without origin, keeps discovery order within groups', () => {
  const order = orderShipyardsForPurchase(YARDS, new Set(['X1-A20-C9']));
  // Known seller C9 first, then the rest in their original discovery order.
  assert.deepEqual(order, ['X1-A20-C9', 'X1-A20-A2', 'X1-A20-B7']);
});

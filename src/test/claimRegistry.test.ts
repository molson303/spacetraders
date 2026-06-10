import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaimRegistry } from '../coordinator/claimRegistry.js';
import type { ArbitrageRoute } from '../state/repos.js';

function route(p: Partial<ArbitrageRoute>): ArbitrageRoute {
  return {
    good: 'GOOD',
    buyAt: 'BUY',
    buyPrice: 100,
    sellAt: 'SELL',
    sellPrice: 200,
    profitPerUnit: 100,
    tradeVolume: 40,
    sellVolume: 40,
    ...p,
  };
}

test('set records a claim and size reflects it', () => {
  const reg = new ClaimRegistry();
  reg.set('S1', 'IRON', 'WP-A');
  assert.equal(reg.size(), 1);
  assert.equal(reg.goodOf('S1'), 'IRON');
});

test('release frees a ship claim', () => {
  const reg = new ClaimRegistry();
  reg.set('S1', 'IRON', 'WP-A');
  reg.release('S1');
  assert.equal(reg.size(), 0);
  assert.equal(reg.goodOf('S1'), undefined);
});

test('set replaces a ship prior claim rather than stacking', () => {
  const reg = new ClaimRegistry();
  reg.set('S1', 'IRON', 'WP-A');
  reg.set('S1', 'GOLD', 'WP-B');
  assert.equal(reg.size(), 1);
  assert.equal(reg.goodOf('S1'), 'GOLD');
});

test('claimedGoods / claimedSells exclude the asking ship own claim', () => {
  const reg = new ClaimRegistry();
  reg.set('S1', 'IRON', 'WP-A');
  reg.set('S2', 'GOLD', 'WP-B');
  // From S1 perspective, only S2 claims count.
  assert.deepEqual([...reg.claimedGoods('S1')], ['GOLD']);
  assert.deepEqual([...reg.claimedSells('S1')], ['WP-B']);
  // With no exception, both show.
  assert.equal(reg.claimedGoods().size, 2);
  assert.equal(reg.claimedSells().size, 2);
});

test('isTaken flags a good or sell held by another ship but not self', () => {
  const reg = new ClaimRegistry();
  reg.set('S1', 'IRON', 'WP-A');
  assert.equal(reg.isTaken('IRON', 'WP-Z'), true); // good collision
  assert.equal(reg.isTaken('GOLD', 'WP-A'), true); // sell collision
  assert.equal(reg.isTaken('GOLD', 'WP-Z'), false); // neither
  assert.equal(reg.isTaken('IRON', 'WP-A', 'S1'), false); // self is ignored
});

test('unclaimedHeadroom counts distinct free routes after removing claims', () => {
  const reg = new ClaimRegistry();
  const candidates = [
    route({ good: 'IRON', sellAt: 'WP-A' }),
    route({ good: 'GOLD', sellAt: 'WP-B' }),
    route({ good: 'COPPER', sellAt: 'WP-C' }),
  ];
  // No claims -> all three distinct routes are free.
  assert.equal(reg.unclaimedHeadroom(candidates), 3);
  // Claiming IRON removes that good; GOLD's sell WP-B claimed removes it too.
  reg.set('S1', 'IRON', 'WP-X');
  reg.set('S2', 'NICKEL', 'WP-B');
  assert.equal(reg.unclaimedHeadroom(candidates), 1); // only COPPER/WP-C left
});

test('activeClaims snapshots every current claim', () => {
  const reg = new ClaimRegistry();
  reg.set('S1', 'IRON', 'WP-A');
  reg.set('S2', 'GOLD', 'WP-B');
  const claims = reg.activeClaims().sort((a, b) => a.ship.localeCompare(b.ship));
  assert.deepEqual(claims, [
    { ship: 'S1', good: 'IRON', sellAt: 'WP-A' },
    { ship: 'S2', good: 'GOLD', sellAt: 'WP-B' },
  ]);
});

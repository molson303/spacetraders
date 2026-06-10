import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickLocalRoute } from '../coordinator/localSource.js';
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

// All hops the same distance so cr/s ranking reduces to profit-per-trip here.
const distanceOf = (): number => 10;

test('picks the highest cr/s route when nothing is claimed', () => {
  const reg = new ClaimRegistry();
  const thin = route({ good: 'THIN', sellAt: 'S1', profitPerUnit: 300, tradeVolume: 2 }); // 300*2=600
  const fat = route({ good: 'FAT', sellAt: 'S2', profitPerUnit: 80, tradeVolume: 40 }); // 80*40=3200
  const pick = pickLocalRoute([thin, fat], reg, { ship: 'S1', holdSize: 40, distanceOf });
  assert.equal(pick?.good, 'FAT');
});

test('skips routes whose good is claimed by another ship', () => {
  const reg = new ClaimRegistry();
  reg.set('OTHER', 'FAT', 'SX');
  const thin = route({ good: 'THIN', sellAt: 'S1', profitPerUnit: 300, tradeVolume: 2 });
  const fat = route({ good: 'FAT', sellAt: 'S2', profitPerUnit: 80, tradeVolume: 40 });
  const pick = pickLocalRoute([thin, fat], reg, { ship: 'S1', holdSize: 40, distanceOf });
  assert.equal(pick?.good, 'THIN'); // FAT good taken -> THIN
});

test('skips routes whose sell waypoint is claimed by another ship', () => {
  const reg = new ClaimRegistry();
  reg.set('OTHER', 'SOMETHING', 'S2');
  const thin = route({ good: 'THIN', sellAt: 'S1', profitPerUnit: 300, tradeVolume: 2 });
  const fat = route({ good: 'FAT', sellAt: 'S2', profitPerUnit: 80, tradeVolume: 40 });
  const pick = pickLocalRoute([thin, fat], reg, { ship: 'S1', holdSize: 40, distanceOf });
  assert.equal(pick?.good, 'THIN'); // FAT's sell S2 taken -> THIN
});

test('ignores the asking ship own claim when filtering', () => {
  const reg = new ClaimRegistry();
  reg.set('S1', 'FAT', 'S2'); // S1's own prior claim must not exclude FAT for S1
  const fat = route({ good: 'FAT', sellAt: 'S2', profitPerUnit: 80, tradeVolume: 40 });
  const pick = pickLocalRoute([fat], reg, { ship: 'S1', holdSize: 40, distanceOf });
  assert.equal(pick?.good, 'FAT');
});

test('prefers the sticky assigned good while it stays free', () => {
  const reg = new ClaimRegistry();
  const top = route({ good: 'TOP', sellAt: 'S1', profitPerUnit: 300, tradeVolume: 40 });
  const mine = route({ good: 'MINE', sellAt: 'S2', profitPerUnit: 50, tradeVolume: 40 });
  const pick = pickLocalRoute([top, mine], reg, {
    ship: 'S1',
    holdSize: 40,
    assignedGood: 'MINE',
    distanceOf,
  });
  assert.equal(pick?.good, 'MINE');
});

test('returns undefined when every route is claimed away', () => {
  const reg = new ClaimRegistry();
  reg.set('A', 'FAT', 'WPX');
  reg.set('B', 'OTHER', 'S2'); // sell of THIN... ensure both blocked
  const thin = route({ good: 'THIN', sellAt: 'S2', profitPerUnit: 300, tradeVolume: 2 });
  const fat = route({ good: 'FAT', sellAt: 'S1', profitPerUnit: 80, tradeVolume: 40 });
  const pick = pickLocalRoute([thin, fat], reg, { ship: 'S1', holdSize: 40, distanceOf });
  assert.equal(pick, undefined);
});

test('returns undefined for an empty candidate pool', () => {
  const reg = new ClaimRegistry();
  assert.equal(pickLocalRoute([], reg, { ship: 'S1', distanceOf }), undefined);
});

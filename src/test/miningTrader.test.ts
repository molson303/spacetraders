import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canMine,
  pickMiningSite,
  bestBuyer,
  type MiningSite,
  type SellQuote,
} from '../behaviors/miningTrader.js';
import type { Ship } from '../types/index.js';

function shipWithMounts(symbols: string[]): Ship {
  return { mounts: symbols.map((symbol) => ({ symbol, name: symbol })) } as unknown as Ship;
}

test('canMine detects mining laser and extractor mounts', () => {
  assert.equal(canMine(shipWithMounts(['MOUNT_MINING_LASER_I'])), true);
  assert.equal(canMine(shipWithMounts(['MOUNT_MINING_LASER_II'])), true);
  assert.equal(canMine(shipWithMounts(['MOUNT_SURVEYOR_I', 'MOUNT_MINING_LASER_I'])), true);
  // hypothetical extractor naming
  assert.equal(canMine(shipWithMounts(['MOUNT_EXTRACTOR_I'])), true);
});

test('canMine is false for non-mining loadouts', () => {
  assert.equal(canMine(shipWithMounts([])), false);
  assert.equal(canMine(shipWithMounts(['MOUNT_SURVEYOR_I', 'MOUNT_SENSOR_ARRAY_I'])), false);
  assert.equal(canMine(shipWithMounts(['MOUNT_GAS_SIPHON_I'])), false);
});

test('pickMiningSite prefers engineered asteroid over plain asteroid', () => {
  const sites: MiningSite[] = [
    { symbol: 'PLAIN', type: 'ASTEROID' },
    { symbol: 'ENG', type: 'ENGINEERED_ASTEROID' },
  ];
  assert.equal(pickMiningSite(sites), 'ENG');
});

test('pickMiningSite falls back to a plain asteroid, then anything', () => {
  assert.equal(
    pickMiningSite([
      { symbol: 'FIELD', type: 'ASTEROID_FIELD' },
      { symbol: 'PLAIN', type: 'ASTEROID' },
    ]),
    'PLAIN',
  );
  assert.equal(pickMiningSite([{ symbol: 'FIELD', type: 'ASTEROID_FIELD' }]), 'FIELD');
});

test('pickMiningSite returns undefined for an empty list', () => {
  assert.equal(pickMiningSite([]), undefined);
});

test('bestBuyer picks the highest positive sell price', () => {
  const quotes: SellQuote[] = [
    { waypoint: 'A', sellPrice: 100 },
    { waypoint: 'B', sellPrice: 250 },
    { waypoint: 'C', sellPrice: 175 },
  ];
  assert.equal(bestBuyer(quotes), 'B');
});

test('bestBuyer ignores null and non-positive prices', () => {
  const quotes: SellQuote[] = [
    { waypoint: 'A', sellPrice: null },
    { waypoint: 'B', sellPrice: 0 },
    { waypoint: 'C', sellPrice: -5 },
    { waypoint: 'D', sellPrice: 42 },
  ];
  assert.equal(bestBuyer(quotes), 'D');
});

test('bestBuyer returns undefined when no quote is sellable', () => {
  assert.equal(bestBuyer([]), undefined);
  assert.equal(
    bestBuyer([
      { waypoint: 'A', sellPrice: null },
      { waypoint: 'B', sellPrice: 0 },
    ]),
    undefined,
  );
});

test('bestBuyer keeps the earlier waypoint on a tie', () => {
  assert.equal(
    bestBuyer([
      { waypoint: 'FIRST', sellPrice: 100 },
      { waypoint: 'SECOND', sellPrice: 100 },
    ]),
    'FIRST',
  );
});

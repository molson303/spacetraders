import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  supplyRank,
  pickFeedInput,
  planFeedBatch,
  isReadyToDraw,
  type FeedInputState,
} from '../fleet/factoryFeed.js';

test('supplyRank orders levels SCARCE..ABUNDANT', () => {
  assert.equal(supplyRank('SCARCE'), 0);
  assert.equal(supplyRank('LIMITED'), 1);
  assert.equal(supplyRank('MODERATE'), 2);
  assert.equal(supplyRank('HIGH'), 3);
  assert.equal(supplyRank('ABUNDANT'), 4);
});

test('supplyRank is case-insensitive and defaults unknown to MODERATE', () => {
  assert.equal(supplyRank('high'), 3);
  assert.equal(supplyRank(undefined), 2);
  assert.equal(supplyRank('NONSENSE'), 2);
});

test('pickFeedInput chooses the most-starved input with a source', () => {
  const inputs: FeedInputState[] = [
    { good: 'IRON', factorySupply: 'LIMITED', source: 'X1-A20-E44' },
    { good: 'QUARTZ_SAND', factorySupply: 'SCARCE', source: 'X1-A20-H54' },
  ];
  assert.equal(pickFeedInput(inputs)?.good, 'QUARTZ_SAND');
});

test('pickFeedInput skips inputs without a source', () => {
  const inputs: FeedInputState[] = [
    { good: 'IRON', factorySupply: 'SCARCE', source: undefined },
    { good: 'QUARTZ_SAND', factorySupply: 'LIMITED', source: 'X1-A20-H54' },
  ];
  assert.equal(pickFeedInput(inputs)?.good, 'QUARTZ_SAND');
});

test('pickFeedInput skips inputs already ABUNDANT', () => {
  const inputs: FeedInputState[] = [
    { good: 'IRON', factorySupply: 'ABUNDANT', source: 'X1-A20-E44' },
    { good: 'QUARTZ_SAND', factorySupply: 'HIGH', source: 'X1-A20-H54' },
  ];
  assert.equal(pickFeedInput(inputs)?.good, 'QUARTZ_SAND');
});

test('pickFeedInput returns undefined when none are feedable', () => {
  assert.equal(pickFeedInput([]), undefined);
  assert.equal(
    pickFeedInput([{ good: 'IRON', factorySupply: 'ABUNDANT', source: 'X1-A20-E44' }]),
    undefined,
  );
  assert.equal(
    pickFeedInput([{ good: 'IRON', factorySupply: 'SCARCE', source: undefined }]),
    undefined,
  );
});

test('pickFeedInput tie-breaks by list order on equal supply', () => {
  const inputs: FeedInputState[] = [
    { good: 'IRON', factorySupply: 'SCARCE', source: 'X1-A20-E44' },
    { good: 'QUARTZ_SAND', factorySupply: 'SCARCE', source: 'X1-A20-H54' },
  ];
  assert.equal(pickFeedInput(inputs)?.good, 'IRON');
});

test('pickFeedInput skips inputs whose margin is at/below the guard', () => {
  // IRON is more starved but unprofitable to feed (margin <= 0); QUARTZ wins.
  const inputs: FeedInputState[] = [
    { good: 'IRON', factorySupply: 'SCARCE', source: 'X1-A20-H52', margin: -46 },
    { good: 'QUARTZ_SAND', factorySupply: 'LIMITED', source: 'X1-A20-B7', margin: 4 },
  ];
  assert.equal(pickFeedInput(inputs)?.good, 'QUARTZ_SAND');
});

test('pickFeedInput returns undefined when every input is unprofitable', () => {
  const inputs: FeedInputState[] = [
    { good: 'IRON', factorySupply: 'SCARCE', source: 'X1-A20-H52', margin: -46 },
    { good: 'QUARTZ_SAND', factorySupply: 'SCARCE', source: 'X1-A20-B7', margin: 0 },
  ];
  assert.equal(pickFeedInput(inputs), undefined);
});

test('pickFeedInput honors a custom minMargin threshold', () => {
  const inputs: FeedInputState[] = [
    { good: 'QUARTZ_SAND', factorySupply: 'SCARCE', source: 'X1-A20-B7', margin: 4 },
  ];
  // Require at least +5/u: the +4 margin is rejected.
  assert.equal(pickFeedInput(inputs, 5), undefined);
  // Default guard (0) accepts it.
  assert.equal(pickFeedInput(inputs)?.good, 'QUARTZ_SAND');
});

test('pickFeedInput treats undefined margin as feedable (guard off)', () => {
  const inputs: FeedInputState[] = [
    { good: 'IRON', factorySupply: 'SCARCE', source: 'X1-A20-H52' },
  ];
  assert.equal(pickFeedInput(inputs)?.good, 'IRON');
});

test('planFeedBatch is bounded by free cargo and the floor', () => {
  // Plenty of credits: bounded by cargo space.
  assert.equal(
    planFeedBatch({ cargoSpace: 40, credits: 1_000_000, floor: 450_000, pricePerUnit: 100 }),
    40,
  );
  // Floor-bound: only 500 spendable above floor at 100/u -> 5 units.
  assert.equal(
    planFeedBatch({ cargoSpace: 40, credits: 450_500, floor: 450_000, pricePerUnit: 100 }),
    5,
  );
});

test('planFeedBatch returns 0 when at/below floor or price non-positive', () => {
  assert.equal(planFeedBatch({ cargoSpace: 40, credits: 450_000, floor: 450_000, pricePerUnit: 100 }), 0);
  assert.equal(planFeedBatch({ cargoSpace: 40, credits: 400_000, floor: 450_000, pricePerUnit: 100 }), 0);
  assert.equal(planFeedBatch({ cargoSpace: 0, credits: 1_000_000, floor: 0, pricePerUnit: 100 }), 0);
  assert.equal(planFeedBatch({ cargoSpace: 40, credits: 1_000_000, floor: 0, pricePerUnit: 0 }), 0);
});

test('isReadyToDraw is true only at HIGH or ABUNDANT', () => {
  assert.equal(isReadyToDraw('SCARCE'), false);
  assert.equal(isReadyToDraw('LIMITED'), false);
  assert.equal(isReadyToDraw('MODERATE'), false);
  assert.equal(isReadyToDraw('HIGH'), true);
  assert.equal(isReadyToDraw('ABUNDANT'), true);
});

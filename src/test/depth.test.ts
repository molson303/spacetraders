import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planChunks,
  sellFloor,
  buyCeiling,
  keepSelling,
  keepBuying,
  bestSellMarket,
} from '../util/depth.js';
import type { PriceRow } from '../state/repos.js';

test('planChunks splits by tradeVolume', () => {
  assert.deepEqual(planChunks(40, 10), [10, 10, 10, 10]);
  assert.deepEqual(planChunks(25, 10), [10, 10, 5]);
  assert.deepEqual(planChunks(7, 10), [7]);
});

test('planChunks treats missing/zero volume as a single chunk', () => {
  assert.deepEqual(planChunks(40, 0), [40]);
  assert.deepEqual(planChunks(40, null), [40]);
  assert.deepEqual(planChunks(40, undefined), [40]);
});

test('planChunks handles non-positive totals', () => {
  assert.deepEqual(planChunks(0, 10), []);
  assert.deepEqual(planChunks(-5, 10), []);
});

test('sellFloor = cost + margin, buyCeiling = sell - margin', () => {
  assert.equal(sellFloor(100, 20), 120);
  assert.equal(buyCeiling(500, 20), 480);
});

test('keepSelling stops at/below floor, keepBuying stops at/above ceiling', () => {
  assert.equal(keepSelling(130, 120), true); // above floor -> continue
  assert.equal(keepSelling(120, 120), true); // exactly floor still ok
  assert.equal(keepSelling(119, 120), false); // below floor -> stop

  assert.equal(keepBuying(470, 480), true); // below ceiling -> continue
  assert.equal(keepBuying(480, 480), true); // exactly ceiling still ok
  assert.equal(keepBuying(481, 480), false); // above ceiling -> stop
});

function priceRow(waypoint: string, sell: number, vol: number | null = 10): PriceRow {
  return {
    waypoint,
    system: 'X1-A20',
    trade_symbol: 'DRUGS',
    type: 'IMPORT',
    trade_volume: vol,
    supply: 'MODERATE',
    activity: null,
    purchase_price: null,
    sell_price: sell,
    observed_at: '2026-06-08T00:00:00Z',
  };
}

test('bestSellMarket picks highest qualifying price', () => {
  const rows = [priceRow('A', 100), priceRow('B', 300), priceRow('C', 200)];
  const best = bestSellMarket(rows, [], 120);
  assert.equal(best?.waypoint, 'B');
  assert.equal(best?.sellPrice, 300);
});

test('bestSellMarket excludes visited and below-floor markets', () => {
  const rows = [priceRow('A', 100), priceRow('B', 300), priceRow('C', 250)];
  // Exclude B (already visited) -> next best above floor 120 is C.
  assert.equal(bestSellMarket(rows, ['B'], 120)?.waypoint, 'C');
  // Floor above everything -> none.
  assert.equal(bestSellMarket(rows, [], 1000), undefined);
  // All excluded -> none.
  assert.equal(bestSellMarket(rows, ['A', 'B', 'C'], 0), undefined);
});

test('bestSellMarket treats null sell price as zero', () => {
  const rows = [priceRow('A', 0, 10), { ...priceRow('B', 0), sell_price: null }];
  assert.equal(bestSellMarket(rows, [], 1), undefined);
});

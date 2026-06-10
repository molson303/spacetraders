import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planChunks,
  sellFloor,
  buyCeiling,
  keepSelling,
  keepBuying,
  bestSellMarket,
  depthCappedBuyUnits,
  budgetCappedBuyUnits,
  DEFAULT_SELL_DEPTH_MULTIPLE,
  strandedGoods,
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

test('depthCappedBuyUnits caps buy to depthMultiple sell-steps', () => {
  // hold 40, sellVolume 5, multiple 3 -> cap at 15.
  assert.equal(depthCappedBuyUnits(40, 5, 3), 15);
  // cap exceeds hold -> bounded by hold.
  assert.equal(depthCappedBuyUnits(40, 20, 3), 40);
  // exact fit.
  assert.equal(depthCappedBuyUnits(15, 5, 3), 15);
});

test('depthCappedBuyUnits treats unknown sell depth as no extra cap', () => {
  assert.equal(depthCappedBuyUnits(40, null, 3), 40);
  assert.equal(depthCappedBuyUnits(40, 0, 3), 40);
  assert.equal(depthCappedBuyUnits(40, undefined, 3), 40);
});

test('depthCappedBuyUnits clamps multiple to at least one step', () => {
  // multiple 0 -> still allow one full step (5), bounded by hold.
  assert.equal(depthCappedBuyUnits(40, 5, 0), 5);
  assert.equal(depthCappedBuyUnits(3, 5, 0), 3);
});

test('depthCappedBuyUnits returns 0 for a full hold', () => {
  assert.equal(depthCappedBuyUnits(0, 5, 3), 0);
  assert.equal(depthCappedBuyUnits(-2, 5, 3), 0);
});

test('DEFAULT_SELL_DEPTH_MULTIPLE is 1 (buy at most one sink step)', () => {
  // The default must keep buys inside a single sell-step. A thin sink (20/step)
  // and a full 40 hold should cap the buy at 20, not 40+, so a fill never floods
  // the sink below the profit floor (the JEWELRY/FOOD saturation losses).
  assert.equal(DEFAULT_SELL_DEPTH_MULTIPLE, 1);
  assert.equal(depthCappedBuyUnits(40, 20, DEFAULT_SELL_DEPTH_MULTIPLE), 20);
  // A sink at least as deep as the hold still fills the whole bay.
  assert.equal(depthCappedBuyUnits(40, 40, DEFAULT_SELL_DEPTH_MULTIPLE), 40);
});

test('budgetCappedBuyUnits limits units to what the spend budget affords', () => {
  // 60 units wanted at ~4000/u, but only 100k budget -> 25 units.
  assert.equal(budgetCappedBuyUnits(60, 4000, 100000), 25);
  // Budget comfortably covers the requested units -> unchanged.
  assert.equal(budgetCappedBuyUnits(20, 100, 100000), 20);
  // Budget can't afford even one unit -> 0 (caller skips the route).
  assert.equal(budgetCappedBuyUnits(40, 5000, 1000), 0);
});

test('budgetCappedBuyUnits treats a non-positive budget as no cap', () => {
  assert.equal(budgetCappedBuyUnits(40, 4000, 0), 40);
  assert.equal(budgetCappedBuyUnits(40, 4000, null), 40);
  assert.equal(budgetCappedBuyUnits(40, 4000, undefined), 40);
});

test('budgetCappedBuyUnits treats unknown unit price as no cap', () => {
  assert.equal(budgetCappedBuyUnits(40, 0, 1000), 40);
  assert.equal(budgetCappedBuyUnits(40, null, 1000), 40);
  assert.equal(budgetCappedBuyUnits(40, undefined, 1000), 40);
});

test('budgetCappedBuyUnits returns 0 for a non-positive unit count', () => {
  assert.equal(budgetCappedBuyUnits(0, 100, 1000), 0);
  assert.equal(budgetCappedBuyUnits(-5, 100, 1000), 0);
});

test('strandedGoods returns held goods ordered by units descending', () => {
  const inv = [
    { symbol: 'IRON', units: 10 },
    { symbol: 'GOLD', units: 0 },
    { symbol: 'SILVER', units: 80 },
    { symbol: 'COPPER', units: 25 },
  ];
  assert.deepEqual(strandedGoods(inv), [
    { symbol: 'SILVER', units: 80 },
    { symbol: 'COPPER', units: 25 },
    { symbol: 'IRON', units: 10 },
  ]);
});

test('strandedGoods excludes the kept good and zero-unit entries', () => {
  const inv = [
    { symbol: 'FABRICS', units: 40 },
    { symbol: 'SILVER', units: 80 },
    { symbol: 'GOLD', units: 0 },
  ];
  assert.deepEqual(strandedGoods(inv, 'FABRICS'), [{ symbol: 'SILVER', units: 80 }]);
});

test('strandedGoods is empty for an empty hold', () => {
  assert.deepEqual(strandedGoods([]), []);
  assert.deepEqual(strandedGoods([{ symbol: 'GOLD', units: 0 }]), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  remainingMaterials,
  affordableUnits,
  planSupplyBatch,
  purchaseChunks,
} from '../fleet/gateSupply.js';
import type { Construction } from '../types/index.js';

function construction(
  materials: { tradeSymbol: string; required: number; fulfilled: number }[],
  isComplete = false,
): Construction {
  return { symbol: 'X1-A20-I56', materials, isComplete };
}

test('remainingMaterials returns required-minus-fulfilled, dropping completed', () => {
  const c = construction([
    { tradeSymbol: 'FAB_MATS', required: 1600, fulfilled: 100 },
    { tradeSymbol: 'ADVANCED_CIRCUITRY', required: 400, fulfilled: 0 },
    { tradeSymbol: 'QUANTUM_STABILIZERS', required: 1, fulfilled: 1 },
  ]);
  assert.deepEqual(remainingMaterials(c), [
    { tradeSymbol: 'FAB_MATS', remaining: 1500 },
    { tradeSymbol: 'ADVANCED_CIRCUITRY', remaining: 400 },
  ]);
});

test('remainingMaterials never goes negative when over-fulfilled', () => {
  const c = construction([{ tradeSymbol: 'FAB_MATS', required: 10, fulfilled: 15 }]);
  assert.deepEqual(remainingMaterials(c), []);
});

test('affordableUnits keeps the floor intact', () => {
  // 1,000,000 credits, floor 2,000,000 -> cannot afford anything
  assert.equal(affordableUnits(1_000_000, 2_000_000, 993), 0);
  // 3,000,000 credits, floor 2,000,000 -> 1,000,000 spendable / 1000 = 1000 units
  assert.equal(affordableUnits(3_000_000, 2_000_000, 1000), 1000);
});

test('affordableUnits returns 0 for non-positive price', () => {
  assert.equal(affordableUnits(5_000_000, 0, 0), 0);
  assert.equal(affordableUnits(5_000_000, 0, -10), 0);
});

test('planSupplyBatch is bounded by remaining need', () => {
  const units = planSupplyBatch({
    remaining: 30,
    cargoSpace: 80,
    credits: 10_000_000,
    floor: 2_000_000,
    pricePerUnit: 1000,
  });
  assert.equal(units, 30);
});

test('planSupplyBatch is bounded by cargo space', () => {
  const units = planSupplyBatch({
    remaining: 1000,
    cargoSpace: 80,
    credits: 10_000_000,
    floor: 2_000_000,
    pricePerUnit: 1000,
  });
  assert.equal(units, 80);
});

test('planSupplyBatch is bounded by affordability above the floor', () => {
  // 2,050,000 credits, floor 2,000,000 -> 50,000 / 1000 = 50 units affordable
  const units = planSupplyBatch({
    remaining: 1000,
    cargoSpace: 80,
    credits: 2_050_000,
    floor: 2_000_000,
    pricePerUnit: 1000,
  });
  assert.equal(units, 50);
});

test('planSupplyBatch returns 0 when nothing needed or no space', () => {
  const base = { credits: 10_000_000, floor: 0, pricePerUnit: 100 };
  assert.equal(planSupplyBatch({ ...base, remaining: 0, cargoSpace: 80 }), 0);
  assert.equal(planSupplyBatch({ ...base, remaining: 80, cargoSpace: 0 }), 0);
});

test('purchaseChunks splits by trade volume', () => {
  assert.deepEqual(purchaseChunks(80, 20), [20, 20, 20, 20]);
  assert.deepEqual(purchaseChunks(50, 20), [20, 20, 10]);
  assert.deepEqual(purchaseChunks(15, 20), [15]);
});

test('purchaseChunks handles edge cases', () => {
  assert.deepEqual(purchaseChunks(0, 20), []);
  assert.deepEqual(purchaseChunks(40, 0), [40]); // non-positive volume -> single chunk
});

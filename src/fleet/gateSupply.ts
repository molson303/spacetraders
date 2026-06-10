import type { Construction } from '../types/index.js';

/**
 * Pure planning helpers for supplying a construction site (e.g. the home jump
 * gate). The runtime script in scripts/supplyGate.ts wires these to the live
 * API; everything here is side-effect free and unit tested.
 */

export interface RemainingMaterial {
  tradeSymbol: string;
  remaining: number;
}

/** Materials still needed (required - fulfilled), omitting completed ones. */
export function remainingMaterials(construction: Construction): RemainingMaterial[] {
  return construction.materials
    .map((m) => ({
      tradeSymbol: m.tradeSymbol,
      remaining: Math.max(0, m.required - m.fulfilled),
    }))
    .filter((m) => m.remaining > 0);
}

/**
 * How many units we can buy at `pricePerUnit` while keeping at least `floor`
 * credits in the bank. Never negative; 0 when the price is non-positive.
 */
export function affordableUnits(credits: number, floor: number, pricePerUnit: number): number {
  if (pricePerUnit <= 0) return 0;
  const spendable = credits - floor;
  if (spendable <= 0) return 0;
  return Math.floor(spendable / pricePerUnit);
}

export interface SupplyBatchInput {
  /** Units still required by the construction site. */
  remaining: number;
  /** Free cargo capacity on the hauler. */
  cargoSpace: number;
  credits: number;
  floor: number;
  pricePerUnit: number;
}

/**
 * Decide how many units to acquire for one trip: bounded by the gate's
 * remaining need, the hauler's free space, and what we can afford above the
 * floor. Returns 0 when nothing is needed or we can't afford a single unit.
 */
export function planSupplyBatch(input: SupplyBatchInput): number {
  const { remaining, cargoSpace, credits, floor, pricePerUnit } = input;
  if (remaining <= 0 || cargoSpace <= 0) return 0;
  const affordable = affordableUnits(credits, floor, pricePerUnit);
  return Math.max(0, Math.min(remaining, cargoSpace, affordable));
}

/**
 * Split a desired unit count into market-trade-volume-sized purchase chunks
 * (e.g. 80 units with volume 20 -> [20, 20, 20, 20]). Each chunk is one
 * purchaseCargo call. A non-positive volume falls back to a single chunk.
 */
export function purchaseChunks(units: number, tradeVolume: number): number[] {
  if (units <= 0) return [];
  const size = tradeVolume > 0 ? tradeVolume : units;
  const chunks: number[] = [];
  let left = units;
  while (left > 0) {
    const n = Math.min(size, left);
    chunks.push(n);
    left -= n;
  }
  return chunks;
}

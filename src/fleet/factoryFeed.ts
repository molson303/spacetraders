/*
 * Pure planning helpers for the factory-feed loop (scripts/feedFactory.ts).
 *
 * A factory waypoint (e.g. X1-A20-F48) produces an export good (FAB_MATS) by
 * consuming imported inputs (IRON + QUARTZ_SAND). While those inputs sit SCARCE
 * the factory is starved, so the export stays SCARCE and its price is sky-high.
 * Selling the factory its inputs raises their supply, which lifts export
 * production -> the export's supply climbs and its purchase price collapses.
 *
 * Everything here is side-effect free and unit tested; the runtime script wires
 * these to the live API.
 */

/**
 * SpaceTraders supply levels, low (starved/expensive) to high (glutted/cheap).
 * Ranked so we can compare "how starved" two markets are and decide when an
 * export is abundant enough to start drawing down.
 */
export const SUPPLY_LEVELS = ['SCARCE', 'LIMITED', 'MODERATE', 'HIGH', 'ABUNDANT'] as const;
export type SupplyLevel = (typeof SUPPLY_LEVELS)[number];

/**
 * Numeric rank for a supply string (0 = SCARCE … 4 = ABUNDANT). Unknown values
 * rank as MODERATE (2) so a missing reading never looks artificially starved or
 * glutted and skew the feed.
 */
export function supplyRank(supply: string | undefined): number {
  const i = SUPPLY_LEVELS.indexOf((supply ?? '').toUpperCase() as SupplyLevel);
  return i >= 0 ? i : 2;
}

export interface FeedInputState {
  /** Input good symbol the factory imports (e.g. IRON). */
  good: string;
  /** The factory's current supply level for this input. */
  factorySupply: string;
  /** Cheapest waypoint to buy this input; undefined = no known source, skip. */
  source?: string;
  /**
   * Per-unit feed margin = what the factory pays us to deliver this input
   * (its IMPORT sell price) minus what the source charges us to buy it. When
   * defined and at/below `minMargin`, the input is skipped: feeding it would
   * burn capital. Leave undefined to skip the guard (always considered feedable).
   */
  margin?: number;
}

/**
 * Choose which input to feed this trip: the most-starved input (lowest factory
 * supply) that has a known source and is still capital-neutral to feed. Feeding
 * the most-starved each trip keeps both inputs rising together, which the export
 * recipe needs. Ties break by the input's order in the list for determinism.
 *
 * Returns undefined when no input qualifies — no source, already ABUNDANT, or
 * its margin has dropped to/through `minMargin` (default 0, i.e. losing money).
 * As we feed an input its supply rises and its source price climbs, so margins
 * decay toward zero; the guard stops us before each input turns unprofitable.
 */
export function pickFeedInput(
  inputs: FeedInputState[],
  minMargin = 0,
): FeedInputState | undefined {
  let best: FeedInputState | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const inp of inputs) {
    if (!inp.source) continue;
    if (inp.margin !== undefined && inp.margin <= minMargin) continue; // unprofitable to feed
    const rank = supplyRank(inp.factorySupply);
    if (rank >= SUPPLY_LEVELS.length - 1) continue; // already ABUNDANT
    if (rank < bestRank) {
      bestRank = rank;
      best = inp;
    }
  }
  return best;
}

export interface FeedBatchInput {
  /** Free cargo capacity on the hauler. */
  cargoSpace: number;
  /** Current credits. */
  credits: number;
  /** Protected credit floor — never spend below this. */
  floor: number;
  /** Expected per-unit purchase price of the input. */
  pricePerUnit: number;
}

/**
 * How many input units to buy for one feed trip: bounded by the hauler's free
 * space and what we can afford above the floor. Returns 0 when we can't afford a
 * single unit above the floor or the price is non-positive.
 */
export function planFeedBatch(input: FeedBatchInput): number {
  const { cargoSpace, credits, floor, pricePerUnit } = input;
  if (cargoSpace <= 0 || pricePerUnit <= 0) return 0;
  const spendable = credits - floor;
  if (spendable <= 0) return 0;
  const affordable = Math.floor(spendable / pricePerUnit);
  return Math.max(0, Math.min(cargoSpace, affordable));
}

/**
 * Whether the factory's export is abundant enough to start buying it down for
 * the gate: true once its supply reaches HIGH or ABUNDANT. Below that, keep
 * feeding inputs rather than buying the still-expensive export.
 */
export function isReadyToDraw(exportSupply: string | undefined): boolean {
  return supplyRank(exportSupply) >= supplyRank('HIGH');
}

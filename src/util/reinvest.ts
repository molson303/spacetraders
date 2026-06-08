/*
 * Reinvestment helpers: choose which ship to buy from live shipyard prices to
 * maximize earning power per credit spent. Kept pure and injectable so the
 * supervisor's reinvest loop stays a thin shell over unit-tested logic.
 */

/** A buyable ship offering with its live shipyard price. */
export interface ReinvestCandidate {
  type: string;
  price: number;
}

/**
 * Relative earning weight per ship type, used as the ROI numerator (≈ the
 * cargo capacity that drives arbitrage/contract income). Non-cargo scouts are
 * zero so they're never bought as income earners; unknown cargo ships fall back
 * to a standard hold so a new ship type is still considered.
 */
const EARN_WEIGHT: Record<string, number> = {
  SHIP_PROBE: 0,
  SHIP_SATELLITE: 0,
  SHIP_LIGHT_SHUTTLE: 40,
  SHIP_LIGHT_HAULER: 40,
  SHIP_COMMAND_FRIGATE: 40,
  SHIP_HEAVY_FREIGHTER: 120,
  SHIP_REFINING_FREIGHTER: 40,
};

export function earnWeight(type: string): number {
  return EARN_WEIGHT[type] ?? 40;
}

export interface BestReinvestOptions {
  /** Credits available to spend right now (already net of any reserve). */
  budget: number;
  /** Expected earning weight per ship type. Defaults to {@link earnWeight}. */
  earnRate?: (type: string) => number;
  /** Skip any candidate whose ROI (earnRate / price) is below this. */
  minRoi?: number;
}

/**
 * Pick the affordable candidate with the best ROI — earning weight per credit
 * of purchase price. This favours the ship that adds the most income capacity
 * per credit, so cheap haulers win early (maximizing fleet headcount) while a
 * larger freighter wins once its capacity-per-credit overtakes them. Returns
 * undefined when nothing is affordable or worth buying.
 */
export function bestReinvestShip(
  candidates: ReinvestCandidate[],
  opts: BestReinvestOptions,
): ReinvestCandidate | undefined {
  const rateOf = opts.earnRate ?? earnWeight;
  const minRoi = opts.minRoi ?? 0;
  let best: ReinvestCandidate | undefined;
  let bestRoi = -Infinity;
  for (const c of candidates) {
    if (c.price <= 0 || c.price > opts.budget) continue;
    const rate = rateOf(c.type);
    if (rate <= 0) continue;
    const roi = rate / c.price;
    if (roi < minRoi) continue;
    if (roi > bestRoi) {
      bestRoi = roi;
      best = c;
    }
  }
  return best;
}

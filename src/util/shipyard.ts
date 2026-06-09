/*
 * Pure shipyard selection helper.
 *
 * Given the shipyards discovered in a system (waypoints carrying the SHIPYARD
 * trait), pick which one to use for buying/repairing. Selection order:
 *   1. override  — an explicit operator-supplied waypoint symbol always wins,
 *                  even if it isn't in the discovered list (operator knows best,
 *                  or the yard simply hasn't been scanned into the DB yet).
 *   2. nearest   — when an origin point is supplied, the closest yard by
 *                  Euclidean distance (fewest fuel/time to reach).
 *   3. first     — otherwise the first discovered yard.
 *   4. undefined — no yards and no override => caller should log + skip.
 *
 * Kept dependency-free so it is trivially unit-testable.
 */

export interface ShipyardCandidate {
  symbol: string;
  x: number;
  y: number;
}

export interface SelectShipyardOptions {
  /** Forced waypoint symbol; when set it is always chosen (highest priority). */
  override?: string;
  /** Origin coordinates to measure distance from, enabling nearest selection. */
  from?: { x: number; y: number };
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/**
 * Choose a shipyard waypoint symbol from the discovered candidates.
 * Returns `undefined` when there is nothing to choose and no override.
 */
export function selectShipyard(
  shipyards: ShipyardCandidate[],
  opts: SelectShipyardOptions = {},
): string | undefined {
  const override = opts.override?.trim();
  if (override) return override;
  if (shipyards.length === 0) return undefined;

  if (opts.from) {
    const origin = opts.from;
    let best = shipyards[0]!;
    let bestD = dist(best, origin);
    for (const yard of shipyards.slice(1)) {
      const d = dist(yard, origin);
      if (d < bestD) {
        best = yard;
        bestD = d;
      }
    }
    return best.symbol;
  }

  return shipyards[0]!.symbol;
}

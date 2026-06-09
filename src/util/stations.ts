/*
 * Pure helpers for stationed market-data probes.
 *
 * A fuel-free probe parked permanently at a marketplace lets us read that
 * market's live prices each round with a single in-place API call (no travel).
 * Covering every market keeps `market_latest` fresh so traders never act on a
 * stale spread (the cause of "bought nothing" wasted trips). These helpers
 * decide which probe sits at which market and how many probes to buy, kept pure
 * and system-agnostic (a station is any waypoint, home or neighbor) so the same
 * logic drives cross-system coverage once jump gates are available.
 */

/** A marketplace a probe can be stationed at. */
export interface StationMarket {
  /** Waypoint symbol of the marketplace. */
  symbol: string;
  system: string;
  /** Higher is more important (e.g. feeds known arbitrage). Default 0. */
  priority?: number;
}

/** A probe ship available for stationing. */
export interface ProbeRef {
  symbol: string;
}

/** A probe assigned to sit at a market waypoint. */
export interface StationAssignment {
  /** Probe ship symbol. */
  ship: string;
  /** Market waypoint symbol the probe is stationed at. */
  waypoint: string;
}

/** Markets ordered most-important-first, deterministic on ties. */
function orderMarkets(markets: StationMarket[]): StationMarket[] {
  return [...markets].sort(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.symbol.localeCompare(b.symbol),
  );
}

/**
 * Assign probes to markets, preserving any still-valid existing assignments and
 * filling uncovered markets (priority-first) with free probes. An existing
 * assignment is retained only when its probe still exists and its market is
 * still in the candidate set; otherwise the probe is freed for reassignment.
 * Deterministic: free probes are consumed in symbol order against markets in
 * priority order. Returns the full assignment list.
 */
export function planProbeStations(
  markets: StationMarket[],
  probes: ProbeRef[],
  existing: StationAssignment[] = [],
): StationAssignment[] {
  const probeSet = new Set(probes.map((p) => p.symbol));
  const marketSet = new Set(markets.map((m) => m.symbol));

  // Retain existing assignments whose probe and market both still exist.
  const retained = existing.filter(
    (a) => probeSet.has(a.ship) && marketSet.has(a.waypoint),
  );
  const usedProbes = new Set(retained.map((a) => a.ship));
  const coveredMarkets = new Set(retained.map((a) => a.waypoint));

  const freeProbes = probes
    .filter((p) => !usedProbes.has(p.symbol))
    .map((p) => p.symbol)
    .sort((a, b) => a.localeCompare(b));
  const uncovered = orderMarkets(markets).filter((m) => !coveredMarkets.has(m.symbol));

  const assignments = [...retained];
  for (let i = 0; i < uncovered.length && i < freeProbes.length; i++) {
    assignments.push({ ship: freeProbes[i]!, waypoint: uncovered[i]!.symbol });
  }
  return assignments;
}

/** Inputs for sizing a probe purchase. */
export interface ProvisionInput {
  /** Total markets we want covered. */
  marketCount: number;
  /** Markets already covered by a stationed probe. */
  stationed: number;
  /** Probes currently owned. */
  currentProbes: number;
  /** Hard cap on probes the fleet may own. */
  maxProbes: number;
  /** Spendable credits (already net of any reserve). */
  budget: number;
  /** Live probe price; <= 0 disables buying. */
  probePrice: number;
}

/**
 * How many probes to buy this cycle: bounded by uncovered markets, the probe
 * cap headroom, and how many fit the budget. Never negative.
 */
export function probesToProvision(input: ProvisionInput): number {
  const uncovered = Math.max(0, input.marketCount - input.stationed);
  const capRoom = Math.max(0, input.maxProbes - input.currentProbes);
  const budgetRoom =
    input.probePrice > 0 ? Math.floor(input.budget / input.probePrice) : 0;
  return Math.max(0, Math.min(uncovered, capRoom, budgetRoom));
}

/** Probes split into those holding a station and the rest (flex pool). */
export interface ProbePartition {
  stationed: StationAssignment[];
  flex: string[];
}

/**
 * Split probes by whether they currently hold a station. Stationed assignments
 * are filtered to probes that still exist; every other probe is flex (available
 * for remote scouting, ferrying, or filling a new station).
 */
export function partitionProbes(
  probes: ProbeRef[],
  stations: StationAssignment[],
): ProbePartition {
  const probeSet = new Set(probes.map((p) => p.symbol));
  const stationed = stations.filter((a) => probeSet.has(a.ship));
  const stationedShips = new Set(stationed.map((a) => a.ship));
  const flex = probes.map((p) => p.symbol).filter((s) => !stationedShips.has(s));
  return { stationed, flex };
}

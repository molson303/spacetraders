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

/** Priority pinned onto strategic markets — far above any plausible tx count. */
export const STRATEGIC_PRIORITY = 1_000_000;

/** Inputs for {@link marketPriority}: trade-volume signal and strategic pins. */
export interface MarketPriorityInputs {
  /** Recent transaction count per waypoint; busier markets rank higher. */
  txCounts?: Map<string, number>;
  /** Waypoints pinned above all traffic-ranked markets (factory, active gate). */
  strategic?: Set<string>;
}

/**
 * Stationing priority for a home-system market. Strategic markets (e.g. the
 * factory we feed, the jump gate under construction) are pinned at
 * {@link STRATEGIC_PRIORITY} so they are always covered. Every other market
 * ranks by recent transaction count — busier markets earn a probe first — offset
 * by 1 so even an untraded home market still outranks a cross-system neighbor
 * (priority 0). Higher = more important.
 */
export function marketPriority(symbol: string, inputs: MarketPriorityInputs = {}): number {
  if (inputs.strategic?.has(symbol)) return STRATEGIC_PRIORITY;
  return 1 + (inputs.txCounts?.get(symbol) ?? 0);
}

/**
 * Stationing priority for a cross-system neighbor market, ranked by the
 * neighbor's own recent transaction count so busier neighbor markets earn a
 * probe first. The count is mapped through `n / (n + 1)` into the half-open
 * range [0, 1): monotonic in volume but always strictly below 1, so every
 * neighbor stays under even an untraded home market (priority >= 1). An
 * untraded neighbor maps to 0, matching the legacy flat-priority behavior.
 * Negative counts are clamped to 0. Higher = more important.
 */
export function neighborMarketPriority(txCount: number): number {
  const n = Math.max(0, txCount);
  return n / (n + 1);
}

/**
 * Assign probes to markets, preserving any still-valid existing assignments and
 * filling uncovered markets (priority-first) with free probes. An existing
 * assignment is retained only when its probe still exists and its market is
 * still in the candidate set; otherwise the probe is freed for reassignment.
 * Deterministic: free probes are consumed in symbol order against markets in
 * priority order.
 *
 * When probes are scarcer than markets, a final rebalance pass re-homes probes
 * sitting on low-priority markets onto any higher-priority market still
 * uncovered — so a priority change (a market's trade volume rising, or a new
 * strategic pin) actually moves a stationed probe instead of being ignored by
 * retention. After it runs, no uncovered market outranks any covered one (i.e.
 * the highest-priority markets the probe count can cover are covered). Returns
 * the full assignment list.
 */
export function planProbeStations(
  markets: StationMarket[],
  probes: ProbeRef[],
  existing: StationAssignment[] = [],
): StationAssignment[] {
  const probeSet = new Set(probes.map((p) => p.symbol));
  const marketSet = new Set(markets.map((m) => m.symbol));
  const priorityOf = new Map(markets.map((m) => [m.symbol, m.priority ?? 0]));

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
  let fi = 0;
  for (let i = 0; i < uncovered.length && fi < freeProbes.length; i++) {
    assignments.push({ ship: freeProbes[fi++]!, waypoint: uncovered[i]!.symbol });
    coveredMarkets.add(uncovered[i]!.symbol);
  }

  // Rebalance: while a higher-priority market sits uncovered, evict the probe on
  // the lowest-priority covered market and move it there. Each swap strictly
  // raises covered priority so the loop terminates; ties break by symbol for
  // determinism. No swap happens when every uncovered market is <= every covered
  // one, which preserves churn-free retention among equal-priority markets.
  for (;;) {
    let target: StationMarket | undefined;
    for (const m of markets) {
      if (coveredMarkets.has(m.symbol)) continue;
      if (
        !target ||
        (m.priority ?? 0) > (target.priority ?? 0) ||
        ((m.priority ?? 0) === (target.priority ?? 0) && m.symbol.localeCompare(target.symbol) < 0)
      ) {
        target = m;
      }
    }
    if (!target) break;

    let victimIdx = -1;
    let victimPriority = Infinity;
    let victimWaypoint = '';
    assignments.forEach((a, i) => {
      const p = priorityOf.get(a.waypoint) ?? 0;
      if (p < victimPriority || (p === victimPriority && a.waypoint.localeCompare(victimWaypoint) < 0)) {
        victimIdx = i;
        victimPriority = p;
        victimWaypoint = a.waypoint;
      }
    });
    if (victimIdx < 0 || (target.priority ?? 0) <= victimPriority) break;

    coveredMarkets.delete(assignments[victimIdx]!.waypoint);
    assignments[victimIdx] = { ship: assignments[victimIdx]!.ship, waypoint: target.symbol };
    coveredMarkets.add(target.symbol);
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

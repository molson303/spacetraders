/*
 * Probe fleet agent for the continuous supervisor. Probes (fuel-free ships) are
 * the fleet's eyes: they keep the market price map fresh so the trade agents
 * compute against live spreads instead of stale ones, and they scout neighbor
 * systems to seed the cross-gate route source.
 *
 * One pass ({@link runProbeCycle}):
 *   - stationed probes refresh the market they sit on, in place
 *     (cross-system stations only when the home gate is open);
 *   - the first flex probe rides the gates into an unscanned neighbor system
 *     ({@link runRemoteScout}) — the prerequisite for cross-system arbitrage —
 *     and falls back to refreshing local prices when there's nothing new out
 *     there; every other flex probe roams the home system scanning markets.
 *
 * {@link runProbeAgent} repeats that pass forever on an interval. The cycle is
 * pure of I/O — every capability is injected — so the routing logic (who scouts
 * vs. scans, gate-gating, flex/stationed split) is unit-testable with no API.
 */

import { partitionProbes, type StationAssignment } from '../util/stations.js';
import { createLogger } from '../util/logger.js';
import type { Ship } from '../types/index.js';

const log = createLogger('probeAgent');

export interface ProbeCycleDeps {
  /** Current probe ships (fuel-free scouts). */
  listScouts: () => Promise<Ship[]>;
  /** Persisted station assignments (probe -> market waypoint). */
  getStations: () => StationAssignment[];
  /** Refresh every stationed probe's market; returns refreshed/relocated counts. */
  stationKeep: (
    probes: Ship[],
    stationed: StationAssignment[],
    allowCross: boolean,
  ) => Promise<{ refreshed: number; relocated: number }>;
  /** Ride the gates scouting unscanned neighbor systems. */
  remoteScout: (ship: Ship) => Promise<{ scannedSystems: number }>;
  /** Roam the home system refreshing market prices; returns markets scanned. */
  scan: (ship: Ship) => Promise<number>;
  /** Re-fetch live ship state (remoteScout moves the probe). */
  refetchShip: (symbol: string) => Promise<Ship>;
  /** False while the home jump gate is under construction. */
  gateOpen: () => boolean;
}

export interface ProbeCycleResult {
  refreshed: number;
  relocated: number;
  scoutedSystems: number;
  scannedMarkets: number;
}

const ZERO: ProbeCycleResult = { refreshed: 0, relocated: 0, scoutedSystems: 0, scannedMarkets: 0 };

/**
 * Run one full probe pass: station-keep the stationed probes, then scout/scan
 * with the flex pool. Returns aggregate coverage counts. Each flex probe's work
 * is isolated (one failing probe never sinks the pass) and its result summed
 * after settling so concurrent increments can't clobber each other.
 */
export async function runProbeCycle(deps: ProbeCycleDeps): Promise<ProbeCycleResult> {
  const scouts = await deps.listScouts();
  if (scouts.length === 0) return { ...ZERO };

  const stations = deps.getStations();
  const { stationed, flex } = partitionProbes(
    scouts.map((s) => ({ symbol: s.symbol })),
    stations,
  );

  const result: ProbeCycleResult = { ...ZERO };

  if (stationed.length > 0) {
    const sk = await deps.stationKeep(scouts, stationed, deps.gateOpen());
    result.refreshed += sk.refreshed;
    result.relocated += sk.relocated;
  }

  const flexProbes = scouts.filter((s) => flex.includes(s.symbol));
  const partials = await Promise.allSettled(
    flexProbes.map((ship, idx) =>
      (async (): Promise<{ scoutedSystems: number; scannedMarkets: number }> => {
        // The first flex probe scouts remote systems (when the gate is open);
        // if there's nothing new out there it refreshes local prices with the
        // probe wherever it ended up. Every other flex probe stays local.
        if (idx === 0 && deps.gateOpen()) {
          const scouted = await deps.remoteScout(ship);
          if (scouted.scannedSystems > 0) {
            return { scoutedSystems: scouted.scannedSystems, scannedMarkets: 0 };
          }
          const fresh = await deps.refetchShip(ship.symbol);
          return { scoutedSystems: 0, scannedMarkets: await deps.scan(fresh) };
        }
        return { scoutedSystems: 0, scannedMarkets: await deps.scan(ship) };
      })(),
    ),
  );

  for (const p of partials) {
    if (p.status === 'fulfilled') {
      result.scoutedSystems += p.value.scoutedSystems;
      result.scannedMarkets += p.value.scannedMarkets;
    } else {
      log.warn(`flex probe failed: ${(p.reason as Error)?.message ?? p.reason}`);
    }
  }

  return result;
}

export interface ProbeAgentOptions {
  /** Pause between probe passes. */
  intervalMs?: number;
  /** Cooperative stop signal — the loop exits before starting a new pass. */
  stopping: () => boolean;
  /** Awaited between passes (injectable for tests, no real delay). */
  delay?: (ms: number) => Promise<void>;
  /** Bound on passes — defaults to Infinity (perpetual). Tests pass a small N. */
  maxPasses?: number;
}

/**
 * Drive the probe fleet forever (or for `maxPasses`), running one
 * {@link runProbeCycle} per interval. Returns the number of passes completed.
 */
export async function runProbeAgent(deps: ProbeCycleDeps, opts: ProbeAgentOptions): Promise<number> {
  const intervalMs = opts.intervalMs ?? 60_000;
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxPasses = opts.maxPasses ?? Number.POSITIVE_INFINITY;
  let passes = 0;

  while (!opts.stopping() && passes < maxPasses) {
    try {
      const r = await runProbeCycle(deps);
      log.info(
        `probe pass: refreshed=${r.refreshed} relocated=${r.relocated} ` +
          `scouted=${r.scoutedSystems} scanned=${r.scannedMarkets}`,
      );
    } catch (err) {
      log.error(`probe pass errored: ${(err as Error).message}`);
    }
    passes++;
    if (opts.stopping() || passes >= maxPasses) break;
    await delay(intervalMs);
  }
  return passes;
}

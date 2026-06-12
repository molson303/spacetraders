/*
 * Probe fleet agent for the continuous supervisor. Probes (fuel-free ships) are
 * the fleet's eyes: they keep the market price map fresh so the trade agents
 * compute against live spreads instead of stale ones.
 *
 * One pass ({@link runProbeCycle}):
 *   - stationed probes refresh the market they sit on, in place
 *     (cross-system stations are ferried/serviced only when the home gate is
 *     open);
 *   - flex probes roam the home system scanning markets.
 *
 * Remote scouting (riding the gates into unscanned neighbor systems) is NOT done
 * here — a single scout trip is fuel-free and can take ~50 minutes, which would
 * freeze station-keeping (and the cross-system ferries it drives) for the whole
 * round-trip. That work lives in its own decoupled loop ({@link runScoutAgent}
 * in scoutAgent.ts) so it can never block this cycle. By convention the first
 * flex probe (index 0) is reserved for the scout agent; this cycle only scans
 * with the remaining flex probes.
 *
 * {@link runProbeAgent} repeats that pass forever on an interval. The cycle is
 * pure of I/O — every capability is injected — so the routing logic (gate-gating,
 * flex/stationed split, scout reservation) is unit-testable with no API.
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
  /** Roam the home system refreshing market prices; returns markets scanned. */
  scan: (ship: Ship) => Promise<number>;
  /** False while the home jump gate is under construction. */
  gateOpen: () => boolean;
}

export interface ProbeCycleResult {
  refreshed: number;
  relocated: number;
  scannedMarkets: number;
}

const ZERO: ProbeCycleResult = { refreshed: 0, relocated: 0, scannedMarkets: 0 };

/**
 * Run one full probe pass: station-keep the stationed probes, then local-scan
 * with the flex pool (excluding the index-0 flex probe reserved for the
 * decoupled scout agent). Returns aggregate coverage counts. Each flex probe's
 * work is isolated (one failing probe never sinks the pass) and its result
 * summed after settling so concurrent increments can't clobber each other.
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

  // Flex probe index 0 is reserved for the decoupled scout agent; every other
  // flex probe roams the home system scanning markets.
  const localFlex = scouts.filter((s) => flex.indexOf(s.symbol) > 0);
  const partials = await Promise.allSettled(localFlex.map((ship) => deps.scan(ship)));

  for (const p of partials) {
    if (p.status === 'fulfilled') {
      result.scannedMarkets += p.value;
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
        `probe pass: refreshed=${r.refreshed} relocated=${r.relocated} scanned=${r.scannedMarkets}`,
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

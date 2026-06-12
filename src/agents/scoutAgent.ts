/*
 * Remote-scout agent for the continuous supervisor — decoupled from the probe
 * cycle on purpose.
 *
 * A scout rides the home jump gate into an unscanned neighbor system, maps its
 * markets ({@link runRemoteScout}), and comes home. Because probes are fuel-free
 * they crawl, so a single round-trip can take ~50 minutes. If this ran inside
 * {@link runProbeCycle} it would hold that cycle open for the whole trip
 * (nonReentrant), freezing station-keeping — and with it the cross-system
 * ferries that hydrate neighbor prices. So scouting lives here, on its own slow
 * cadence ({@link runScoutAgent}), and station-keeping keeps ticking every probe
 * interval regardless of how long a scout is away.
 *
 * One pass ({@link runScoutCycle}) sends the index-0 flex probe (the slot the
 * probe cycle reserves for us) on one scout trip. When there is no flex probe
 * (every probe is stationed) it is a no-op — discovery resumes once a flex/
 * reserve scout exists. Pure of I/O via injected deps, so the routing is
 * unit-testable with no API.
 */

import { partitionProbes, type StationAssignment } from '../util/stations.js';
import { createLogger } from '../util/logger.js';
import type { Ship } from '../types/index.js';

const log = createLogger('scoutAgent');

export interface ScoutCycleDeps {
  /** Current probe ships (fuel-free scouts). */
  listScouts: () => Promise<Ship[]>;
  /** Persisted station assignments (probe -> market waypoint). */
  getStations: () => StationAssignment[];
  /** Ride the gates scouting unscanned neighbor systems. */
  remoteScout: (ship: Ship) => Promise<{ scannedSystems: number }>;
  /** False while the home jump gate is under construction. */
  gateOpen: () => boolean;
}

export interface ScoutCycleResult {
  scoutedSystems: number;
}

const ZERO: ScoutCycleResult = { scoutedSystems: 0 };

/**
 * Run one scout pass: if the gate is open and a flex probe is free (index 0 of
 * the flex pool, reserved by the probe cycle), send it on one remote scout trip.
 * No-op when the gate is shut or every probe is stationed.
 */
export async function runScoutCycle(deps: ScoutCycleDeps): Promise<ScoutCycleResult> {
  if (!deps.gateOpen()) return { ...ZERO };

  const scouts = await deps.listScouts();
  if (scouts.length === 0) return { ...ZERO };

  const { flex } = partitionProbes(
    scouts.map((s) => ({ symbol: s.symbol })),
    deps.getStations(),
  );
  if (flex.length === 0) return { ...ZERO };

  const ship = scouts.find((s) => s.symbol === flex[0]);
  if (!ship) return { ...ZERO };

  const { scannedSystems } = await deps.remoteScout(ship);
  return { scoutedSystems: scannedSystems };
}

export interface ScoutAgentOptions {
  /** Pause between scout passes. */
  intervalMs?: number;
  /** Cooperative stop signal — the loop exits before starting a new pass. */
  stopping: () => boolean;
  /** Awaited between passes (injectable for tests, no real delay). */
  delay?: (ms: number) => Promise<void>;
  /** Bound on passes — defaults to Infinity (perpetual). Tests pass a small N. */
  maxPasses?: number;
}

/**
 * Drive the scout forever (or for `maxPasses`), running one
 * {@link runScoutCycle} per interval. Returns the number of passes completed.
 */
export async function runScoutAgent(deps: ScoutCycleDeps, opts: ScoutAgentOptions): Promise<number> {
  const intervalMs = opts.intervalMs ?? 600_000;
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxPasses = opts.maxPasses ?? Number.POSITIVE_INFINITY;
  let passes = 0;

  while (!opts.stopping() && passes < maxPasses) {
    try {
      const r = await runScoutCycle(deps);
      if (r.scoutedSystems > 0) log.info(`scout pass: scouted=${r.scoutedSystems} system(s)`);
    } catch (err) {
      log.error(`scout pass errored: ${(err as Error).message}`);
    }
    passes++;
    if (opts.stopping() || passes >= maxPasses) break;
    await delay(intervalMs);
  }
  return passes;
}

import type { SpaceTradersApi } from '../client/api.js';
import { sleep } from '../client/rateLimiter.js';
import {
  upsertShip,
  recordTransaction,
  findFuelWaypoints,
  getWaypointRow,
  type WaypointRow,
} from '../state/repos.js';
import type { Ship } from '../types/index.js';
import { createLogger } from './logger.js';
import { selectFlightMode } from './routes.js';

const log = createLogger('nav');

export function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.round(Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2));
}

/** Wait until a ship finishes transit (based on its nav route arrival time). */
export async function waitForArrival(api: SpaceTradersApi, ship: Ship): Promise<Ship> {
  if (ship.nav.status !== 'IN_TRANSIT') return ship;
  const arrival = new Date(ship.nav.route.arrival).getTime();
  const ms = arrival - Date.now();
  if (ms > 0) {
    log.debug(`${ship.symbol} in transit to ${ship.nav.waypointSymbol}, ${Math.ceil(ms / 1000)}s`);
    await sleep(ms + 250);
  }
  const fresh = await api.getShip(ship.symbol);
  upsertShip(fresh);
  return fresh;
}

/** Wait out an active cooldown on a ship. */
export async function waitForCooldown(api: SpaceTradersApi, symbol: string): Promise<void> {
  const cd = await api.getShipCooldown(symbol);
  if (cd && cd.remainingSeconds > 0) {
    log.debug(`${symbol} cooldown ${cd.remainingSeconds}s`);
    await sleep(cd.remainingSeconds * 1000 + 250);
  }
}

export async function ensureOrbit(api: SpaceTradersApi, ship: Ship): Promise<Ship> {
  if (ship.nav.status === 'IN_ORBIT') return ship;
  if (ship.nav.status === 'IN_TRANSIT') ship = await waitForArrival(api, ship);
  if (ship.nav.status === 'DOCKED') {
    const { nav } = await api.orbitShip(ship.symbol);
    ship.nav = nav;
    upsertShip(ship);
  }
  return ship;
}

export async function ensureDocked(api: SpaceTradersApi, ship: Ship): Promise<Ship> {
  if (ship.nav.status === 'DOCKED') return ship;
  if (ship.nav.status === 'IN_TRANSIT') ship = await waitForArrival(api, ship);
  const { nav } = await api.dockShip(ship.symbol);
  ship.nav = nav;
  upsertShip(ship);
  return ship;
}

/**
 * Refuel to full when docked at a waypoint with a fuel market.
 * Silently ignores failures (e.g. no fuel sold here, or ship has no fuel tank).
 */
export async function tryRefuel(api: SpaceTradersApi, ship: Ship): Promise<Ship> {
  if (ship.fuel.capacity === 0) return ship; // probes etc.
  if (ship.fuel.current >= ship.fuel.capacity) return ship;
  try {
    ship = await ensureDocked(api, ship);
    const res = await api.refuelShip(ship.symbol);
    ship.fuel = res.fuel;
    upsertShip(ship);
    const txn = res.transaction as { totalPrice?: number } | undefined;
    recordTransaction({
      ship: ship.symbol,
      kind: 'REFUEL',
      waypoint: ship.nav.waypointSymbol,
      total: txn?.totalPrice != null ? -txn.totalPrice : undefined,
      creditsAfter: res.agent.credits,
    });
    log.debug(`${ship.symbol} refueled to ${ship.fuel.current}/${ship.fuel.capacity}`);
  } catch (err) {
    log.debug(`${ship.symbol} refuel skipped: ${(err as Error).message}`);
  }
  return ship;
}

export interface NavigateOptions {
  /** Refuel to full before departing if possible. */
  refuelBefore?: boolean;
  /** Flight mode to use (defaults to CRUISE). */
  flightMode?: Ship['nav']['flightMode'];
}

/**
 * Navigate a ship to a destination waypoint, handling docking state, optional
 * refuel, flight-mode, and waiting for arrival. Returns the ship parked
 * IN_ORBIT at the destination.
 */
export async function navigateTo(
  api: SpaceTradersApi,
  ship: Ship,
  destination: string,
  opts: NavigateOptions = {},
): Promise<Ship> {
  if (ship.nav.status === 'IN_TRANSIT') ship = await waitForArrival(api, ship);
  if (ship.nav.waypointSymbol === destination) {
    return ensureOrbit(api, ship);
  }

  if (opts.refuelBefore !== false) {
    ship = await tryRefuel(api, ship);
  }

  // Pick the fastest flight mode the available fuel can sustain for this leg.
  // For fuel-burning ships an explicit mode (e.g. forced DRIFT) always wins;
  // otherwise auto-select BURN/CRUISE/DRIFT from the post-refuel fuel level.
  // No-fuel ships (probes) are left on their default mode.
  let mode = opts.flightMode;
  if (!mode && ship.fuel.capacity > 0) {
    const here = getWaypointRow(ship.nav.waypointSymbol);
    const there = getWaypointRow(destination);
    const legDistance = here && there ? distance(here, there) : 0;
    mode = selectFlightMode(legDistance, ship.fuel.current);
  }
  if (mode && ship.nav.flightMode !== mode) {
    const { nav } = await api.patchNav(ship.symbol, mode);
    ship.nav = nav;
  }

  ship = await ensureOrbit(api, ship);

  const res = await api.navigateShip(ship.symbol, destination);
  ship.nav = res.nav;
  ship.fuel = res.fuel;
  upsertShip(ship);
  log.info(
    `${ship.symbol} -> ${destination} (arr ${new Date(res.nav.route.arrival).toLocaleTimeString()}, fuel ${res.fuel.current}/${res.fuel.capacity})`,
  );

  ship = await waitForArrival(api, ship);
  return ship;
}

/**
 * Plan a fuel-aware multi-hop path from `from` to `to`, where every leg is
 * within `range` fuel (CRUISE cost ≈ distance). Returns the ordered list of
 * waypoint symbols to visit (excluding the origin, including the destination),
 * or undefined if no path exists. Uses Dijkstra over fuel-selling waypoints
 * plus the origin and destination.
 */
export function planFuelRoute(
  system: string,
  from: string,
  to: string,
  range: number,
): string[] | undefined {
  const origin = getWaypointRow(from);
  const dest = getWaypointRow(to);
  if (!origin || !dest) return undefined;

  // Node set: fuel waypoints ∪ {origin, dest}, de-duplicated by symbol.
  const nodes = new Map<string, WaypointRow>();
  for (const w of findFuelWaypoints(system)) nodes.set(w.symbol, w);
  nodes.set(origin.symbol, origin);
  nodes.set(dest.symbol, dest);

  const syms = [...nodes.keys()];
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  for (const s of syms) dist.set(s, Infinity);
  dist.set(from, 0);

  while (visited.size < syms.length) {
    let u: string | undefined;
    let best = Infinity;
    for (const s of syms) {
      if (visited.has(s)) continue;
      const d = dist.get(s)!;
      if (d < best) {
        best = d;
        u = s;
      }
    }
    if (u === undefined || best === Infinity) break;
    if (u === to) break;
    visited.add(u);

    const uw = nodes.get(u)!;
    for (const v of syms) {
      if (visited.has(v)) continue;
      const vw = nodes.get(v)!;
      const leg = distance(uw, vw);
      // Destination need not sell fuel; all other hops must be reachable on a
      // full tank, so each individual leg must be within range.
      if (leg > range) continue;
      const alt = best + leg;
      if (alt < dist.get(v)!) {
        dist.set(v, alt);
        prev.set(v, u);
      }
    }
  }

  if (!prev.has(to) && from !== to) return undefined;
  const path: string[] = [];
  let cur: string | undefined = to;
  while (cur !== undefined && cur !== from) {
    path.unshift(cur);
    cur = prev.get(cur);
  }
  return path;
}

/**
 * Travel to a destination that may be beyond a single tank's range, hopping
 * through fuel-selling waypoints and refueling at each stop. Falls back to a
 * direct DRIFT hop if no fuel route can be found. Returns the ship IN_ORBIT at
 * the destination.
 */
export async function travelTo(
  api: SpaceTradersApi,
  ship: Ship,
  destination: string,
): Promise<Ship> {
  if (ship.nav.status === 'IN_TRANSIT') ship = await waitForArrival(api, ship);
  if (ship.nav.waypointSymbol === destination) return ensureOrbit(api, ship);

  const system = ship.nav.systemSymbol;
  const range = ship.fuel.capacity || Infinity;
  const direct = distance(
    getWaypointRow(ship.nav.waypointSymbol) ?? { x: 0, y: 0 },
    getWaypointRow(destination) ?? { x: 0, y: 0 },
  );

  // Single hop is enough.
  if (direct <= range) return navigateTo(api, ship, destination);

  const route = planFuelRoute(system, ship.nav.waypointSymbol, destination, range);
  if (!route || route.length === 0) {
    log.warn(
      `${ship.symbol} no fuel route to ${destination} (${direct} > ${range}); drifting direct`,
    );
    return navigateTo(api, ship, destination, { flightMode: 'DRIFT' });
  }

  log.info(`${ship.symbol} routing to ${destination} via ${route.length} hops: ${route.join(' -> ')}`);
  for (const hop of route) {
    ship = await navigateTo(api, ship, hop);
  }
  return ship;
}

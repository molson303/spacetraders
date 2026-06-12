import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runShipAgent, type ShipAgentDeps, type ShipAgentOptions } from '../agents/shipAgent.js';
import { ClaimRegistry } from '../coordinator/claimRegistry.js';
import type { ArbitrageRoute } from '../state/repos.js';
import type { CrossSystemRoute } from '../util/crossRoutes.js';
import type { Ship } from '../types/index.js';

function ship(symbol = 'S1', capacity = 40): Ship {
  return {
    symbol,
    cargo: { capacity, units: 0, inventory: [] },
    nav: { systemSymbol: 'X1-A20', waypointSymbol: 'X1-A20-A1' },
  } as unknown as Ship;
}

function localRoute(p: Partial<ArbitrageRoute> = {}): ArbitrageRoute {
  return {
    good: 'GOOD',
    buyAt: 'BUY',
    buyPrice: 100,
    sellAt: 'SELL',
    sellPrice: 200,
    profitPerUnit: 100,
    tradeVolume: 40,
    sellVolume: 40,
    ...p,
  };
}

function crossRoute(p: Partial<CrossSystemRoute> = {}): CrossSystemRoute {
  return {
    good: 'XGOOD',
    buyAt: 'X1-A20-A1',
    buyPrice: 10,
    sellAt: 'X1-CN42-B1',
    sellPrice: 50,
    profitPerUnit: 40,
    tradeVolume: 40,
    sellVolume: 40,
    buySystem: 'X1-A20',
    sellSystem: 'X1-CN42',
    ...p,
  };
}

// A sane default dep bundle; each test overrides the bits it cares about.
function deps(over: Partial<ShipAgentDeps> = {}): ShipAgentDeps {
  return {
    localCandidates: () => [localRoute()],
    crossCandidates: () => [crossRoute()],
    execLocal: async (s) => ({ ship: s, profit: 100, traded: true }),
    execCross: async (s) => ({ ship: s, profit: 500, traded: true }),
    execContract: async () => 0,
    refetchShip: async (sym) => ship(sym),
    distanceOf: () => 10,
    hopsBetween: () => 1,
    gateOpen: () => true,
    stopping: () => false,
    ...over,
  };
}

const opts = (over: Partial<ShipAgentOptions> = {}): ShipAgentOptions => ({
  role: 'local',
  system: 'X1-A20',
  maxTrips: 1,
  ...over,
});

test('local role runs a route and accumulates profit', async () => {
  const reg = new ClaimRegistry();
  const res = await runShipAgent(ship(), reg, deps(), opts({ role: 'local', maxTrips: 3 }));
  assert.equal(res.trips, 3);
  assert.equal(res.profit, 300);
});

test('claim is held during execution and released after the trip', async () => {
  const reg = new ClaimRegistry();
  let claimedGoodDuringExec: string | undefined;
  await runShipAgent(
    ship('HAULER'),
    reg,
    deps({
      execLocal: async (s) => {
        claimedGoodDuringExec = reg.goodOf('HAULER');
        return { ship: s, profit: 10, traded: true };
      },
    }),
    opts({ role: 'local' }),
  );
  assert.equal(claimedGoodDuringExec, 'GOOD'); // claimed mid-trip
  assert.equal(reg.size(), 0); // released after
});

test('local role idles (no profit) and waits when no route is free', async () => {
  const reg = new ClaimRegistry();
  let idled = 0;
  const res = await runShipAgent(
    ship(),
    reg,
    deps({ localCandidates: () => [], idleDelay: async () => void idled++ }),
    opts({ role: 'local', maxTrips: 2 }),
  );
  assert.equal(res.profit, 0);
  assert.equal(res.trips, 2);
  assert.equal(idled, 2);
});

test('a claimed route that does not trade (budget cap) idles with backoff', async () => {
  // Regression: runRoute can no-op (budget cap / bought nothing) and return
  // traded=false. The agent must treat that as idle so it backs off instead of
  // busy-spinning on the same dead route (the credit-drain log-spam incident).
  const reg = new ClaimRegistry();
  let idled = 0;
  const events: { kind: string; profit: number }[] = [];
  const res = await runShipAgent(
    ship(),
    reg,
    deps({
      execLocal: async (s) => ({ ship: s, profit: 0, traded: false }),
      idleDelay: async () => void idled++,
      onTrip: (e) => events.push({ kind: e.kind, profit: e.profit }),
    }),
    opts({ role: 'local', maxTrips: 3 }),
  );
  assert.equal(res.profit, 0);
  assert.equal(idled, 3); // backed off every trip instead of spinning
  assert.deepEqual(
    events.map((e) => e.kind),
    ['idle', 'idle', 'idle'],
  );
  assert.equal(reg.size(), 0); // claim released each time
});

test('a cross route that does not trade idles with backoff', async () => {
  const reg = new ClaimRegistry();
  let idled = 0;
  const res = await runShipAgent(
    ship(),
    reg,
    deps({
      execCross: async (s) => ({ ship: s, profit: 0, traded: false }),
      idleDelay: async () => void idled++,
    }),
    opts({ role: 'cross', maxTrips: 2 }),
  );
  assert.equal(res.profit, 0);
  assert.equal(idled, 2);
  assert.equal(reg.size(), 0);
});

test('claim is released even when execution throws', async () => {
  const reg = new ClaimRegistry();
  const res = await runShipAgent(
    ship(),
    reg,
    deps({
      execLocal: async () => {
        throw new Error('boom');
      },
    }),
    opts({ role: 'local' }),
  );
  assert.equal(reg.size(), 0); // finally released despite throw
  assert.equal(res.profit, 0);
  assert.equal(res.trips, 1); // trip still counted, loop survives
});

test('cross role runs a cross route when the gate is open', async () => {
  const reg = new ClaimRegistry();
  let crossRan = false;
  const res = await runShipAgent(
    ship(),
    reg,
    deps({ execCross: async (s) => ((crossRan = true), { ship: s, profit: 700, traded: true }) }),
    opts({ role: 'cross' }),
  );
  assert.ok(crossRan);
  assert.equal(res.profit, 700);
  assert.equal(reg.size(), 0);
});

test('cross role falls back to local trade when the gate is shut', async () => {
  const reg = new ClaimRegistry();
  let crossRan = false;
  let localRan = false;
  const res = await runShipAgent(
    ship(),
    reg,
    deps({
      gateOpen: () => false,
      execCross: async (s) => ((crossRan = true), { ship: s, profit: 700, traded: true }),
      execLocal: async (s) => ((localRan = true), { ship: s, profit: 120, traded: true }),
    }),
    opts({ role: 'cross' }),
  );
  assert.equal(crossRan, false);
  assert.ok(localRan);
  assert.equal(res.profit, 120);
});

test('cross role falls back to local when every cross lane is claimed', async () => {
  const reg = new ClaimRegistry();
  reg.set('OTHER', 'XGOOD', 'X1-CN42-B1'); // the only cross route is taken
  let localRan = false;
  const res = await runShipAgent(
    ship(),
    reg,
    deps({ execLocal: async (s) => ((localRan = true), { ship: s, profit: 90, traded: true }) }),
    opts({ role: 'cross' }),
  );
  assert.ok(localRan);
  assert.equal(res.profit, 90);
});

test('contractor role counts completed contracts and refetches the ship', async () => {
  const reg = new ClaimRegistry();
  let refetched = false;
  let localRan = false;
  const res = await runShipAgent(
    ship('BIG'),
    reg,
    deps({
      execContract: async () => 2,
      refetchShip: async (sym) => ((refetched = true), ship(sym)),
      execLocal: async (s) => ((localRan = true), { ship: s, profit: 5, traded: true }),
    }),
    opts({ role: 'contractor' }),
  );
  assert.equal(res.contracts, 2);
  assert.ok(refetched);
  assert.equal(localRan, false); // contract worked -> no local fallback
});

test('contractor role falls back to local trade when no contract is workable', async () => {
  const reg = new ClaimRegistry();
  let localRan = false;
  const res = await runShipAgent(
    ship('BIG'),
    reg,
    deps({
      execContract: async () => 0,
      execLocal: async (s) => ((localRan = true), { ship: s, profit: 60, traded: true }),
    }),
    opts({ role: 'contractor' }),
  );
  assert.equal(res.contracts, 0);
  assert.ok(localRan);
  assert.equal(res.profit, 60);
});

test('stopping() before the first trip yields zero trips', async () => {
  const reg = new ClaimRegistry();
  const res = await runShipAgent(
    ship(),
    reg,
    deps({ stopping: () => true }),
    opts({ role: 'local', maxTrips: 10 }),
  );
  assert.equal(res.trips, 0);
  assert.equal(res.profit, 0);
});

test('onTrip reports kind and profit for each trip', async () => {
  const reg = new ClaimRegistry();
  const events: { kind: string; profit: number }[] = [];
  await runShipAgent(
    ship(),
    reg,
    deps({ onTrip: (e) => events.push({ kind: e.kind, profit: e.profit }) }),
    opts({ role: 'local', maxTrips: 2 }),
  );
  assert.deepEqual(events, [
    { kind: 'local', profit: 100 },
    { kind: 'local', profit: 100 },
  ]);
});

test('repair check runs before every trip and updates the ship', async () => {
  const reg = new ClaimRegistry();
  const seen: string[] = [];
  await runShipAgent(
    ship('WORN'),
    reg,
    deps({
      repairIfWorn: async (s) => {
        seen.push(s.symbol);
        return s; // pretend healthy / repaired, same ship
      },
    }),
    opts({ role: 'local', maxTrips: 2 }),
  );
  assert.deepEqual(seen, ['WORN', 'WORN']); // once per trip
});

test('a repair diversion swaps in the repaired ship for the trip', async () => {
  const reg = new ClaimRegistry();
  let tradedShip: string | undefined;
  await runShipAgent(
    ship('S1'),
    reg,
    deps({
      repairIfWorn: async () => ship('S1-REPAIRED'),
      execLocal: async (s) => ((tradedShip = s.symbol), { ship: s, profit: 1, traded: true }),
    }),
    opts({ role: 'local', maxTrips: 1 }),
  );
  assert.equal(tradedShip, 'S1-REPAIRED');
});

test('a failing repair check does not abort the trip', async () => {
  const reg = new ClaimRegistry();
  const res = await runShipAgent(
    ship(),
    reg,
    deps({
      repairIfWorn: async () => {
        throw new Error('yard unreachable');
      },
    }),
    opts({ role: 'local', maxTrips: 1 }),
  );
  assert.equal(res.trips, 1);
  assert.equal(res.profit, 100); // trade still ran
});

test('a stop signal mid-run halts further trips', async () => {
  const reg = new ClaimRegistry();
  let n = 0;
  const res = await runShipAgent(
    ship(),
    reg,
    deps({ stopping: () => n >= 2, execLocal: async (s) => (n++, { ship: s, profit: 100, traded: true }) }),
    opts({ role: 'local', maxTrips: 10 }),
  );
  assert.equal(res.trips, 2);
  assert.equal(res.profit, 200);
});

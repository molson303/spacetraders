import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCrossRoute } from '../coordinator/crossSource.js';
import { ClaimRegistry } from '../coordinator/claimRegistry.js';
import type { CrossSystemRoute } from '../util/crossRoutes.js';

function route(p: Partial<CrossSystemRoute>): CrossSystemRoute {
  return {
    good: 'IRON_ORE',
    buyAt: 'X1-A20-A1',
    buyPrice: 10,
    sellAt: 'X1-CN42-B1',
    sellPrice: 30,
    profitPerUnit: 20,
    tradeVolume: 40,
    sellVolume: 40,
    buySystem: 'X1-A20',
    sellSystem: 'X1-CN42',
    ...p,
  };
}

// A20 -> CN42 is 1 jump, A20 -> ZZ99 is 2; others unreachable.
const hopsBetween = (from: string, to: string): number | undefined =>
  ({ 'X1-A20': { 'X1-CN42': 1, 'X1-ZZ99': 2 } } as Record<string, Record<string, number>>)[from]?.[to];

test('returns undefined when the gate is blocked, regardless of routes', () => {
  const reg = new ClaimRegistry();
  const pick = pickCrossRoute([route({})], reg, {
    ship: 'S1',
    gateOpen: false,
    hopsBetween,
  });
  assert.equal(pick, undefined);
});

test('picks the highest net-profit reachable route when gate is open', () => {
  const reg = new ClaimRegistry();
  const near = route({ good: 'NEAR', sellAt: 'X1-CN42-B1', sellSystem: 'X1-CN42', profitPerUnit: 20 }); // gross 800
  const far = route({ good: 'FAR', sellAt: 'X1-ZZ99-B1', sellSystem: 'X1-ZZ99', profitPerUnit: 30 }); // gross 1200
  const pick = pickCrossRoute([near, far], reg, { ship: 'S1', gateOpen: true, hopsBetween });
  assert.equal(pick?.route.good, 'FAR'); // higher net with zero antimatter cost
});

test('drops unreachable routes (hopsBetween undefined)', () => {
  const reg = new ClaimRegistry();
  const reachable = route({ good: 'OK', sellSystem: 'X1-CN42', sellAt: 'X1-CN42-B1' });
  const unreachable = route({ good: 'NOPE', sellSystem: 'X1-QQ00', sellAt: 'X1-QQ00-B1' });
  const pick = pickCrossRoute([unreachable, reachable], reg, {
    ship: 'S1',
    gateOpen: true,
    hopsBetween,
  });
  assert.equal(pick?.route.good, 'OK');
});

test('skips a cross route whose good is already claimed by another ship', () => {
  const reg = new ClaimRegistry();
  reg.set('OTHER', 'FAR', 'somewhere');
  const near = route({ good: 'NEAR', sellAt: 'X1-CN42-B1', sellSystem: 'X1-CN42', profitPerUnit: 20 });
  const far = route({ good: 'FAR', sellAt: 'X1-ZZ99-B1', sellSystem: 'X1-ZZ99', profitPerUnit: 30 });
  const pick = pickCrossRoute([near, far], reg, { ship: 'S1', gateOpen: true, hopsBetween });
  assert.equal(pick?.route.good, 'NEAR'); // FAR good taken -> NEAR
});

test('skips a cross route whose sell waypoint is claimed by another ship', () => {
  const reg = new ClaimRegistry();
  reg.set('OTHER', 'UNRELATED', 'X1-ZZ99-B1');
  const near = route({ good: 'NEAR', sellAt: 'X1-CN42-B1', sellSystem: 'X1-CN42', profitPerUnit: 20 });
  const far = route({ good: 'FAR', sellAt: 'X1-ZZ99-B1', sellSystem: 'X1-ZZ99', profitPerUnit: 30 });
  const pick = pickCrossRoute([near, far], reg, { ship: 'S1', gateOpen: true, hopsBetween });
  assert.equal(pick?.route.good, 'NEAR'); // FAR's sell taken -> NEAR
});

test('antimatter cost can flip the ranking toward the closer route', () => {
  const reg = new ClaimRegistry();
  const near = route({ good: 'NEAR', sellAt: 'X1-CN42-B1', sellSystem: 'X1-CN42', profitPerUnit: 20 }); // gross 800, 1 hop
  const far = route({ good: 'FAR', sellAt: 'X1-ZZ99-B1', sellSystem: 'X1-ZZ99', profitPerUnit: 22 }); // gross 880, 2 hops
  // antimatter 200/jump: near net = 800 - 2*1*200 = 400; far net = 880 - 2*2*200 = 80.
  const pick = pickCrossRoute([near, far], reg, {
    ship: 'S1',
    gateOpen: true,
    antimatterCost: 200,
    hopsBetween,
  });
  assert.equal(pick?.route.good, 'NEAR');
});

test('returns undefined when no net-positive route exists', () => {
  const reg = new ClaimRegistry();
  // gross 800 but antimatter 500/jump -> net 800 - 2*1*500 = -200 -> dropped.
  const pick = pickCrossRoute([route({})], reg, {
    ship: 'S1',
    gateOpen: true,
    antimatterCost: 500,
    hopsBetween,
  });
  assert.equal(pick, undefined);
});

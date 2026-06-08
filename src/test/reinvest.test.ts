import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestReinvestShip, earnWeight, type ReinvestCandidate } from '../util/reinvest.js';

const YARD: ReinvestCandidate[] = [
  { type: 'SHIP_PROBE', price: 28_000 },
  { type: 'SHIP_LIGHT_SHUTTLE', price: 80_000 },
  { type: 'SHIP_LIGHT_HAULER', price: 288_000 },
  { type: 'SHIP_HEAVY_FREIGHTER', price: 600_000 },
];

test('earnWeight zeroes scouts and defaults unknown cargo ships', () => {
  assert.equal(earnWeight('SHIP_PROBE'), 0);
  assert.equal(earnWeight('SHIP_SATELLITE'), 0);
  assert.equal(earnWeight('SHIP_LIGHT_SHUTTLE'), 40);
  assert.equal(earnWeight('SHIP_HEAVY_FREIGHTER'), 120);
  assert.equal(earnWeight('SHIP_MYSTERY_HAULER'), 40);
});

test('bestReinvestShip never picks a zero-earn scout even when cheapest', () => {
  const pick = bestReinvestShip(YARD, { budget: 1_000_000 });
  assert.ok(pick);
  assert.notEqual(pick!.type, 'SHIP_PROBE');
});

test('bestReinvestShip picks best ROI: cheap shuttle beats pricier same-cargo hauler', () => {
  // shuttle 40/80k = 0.0005; light hauler 40/288k ≈ 0.000139 -> shuttle wins.
  const pick = bestReinvestShip(YARD, { budget: 1_000_000 });
  assert.equal(pick!.type, 'SHIP_LIGHT_SHUTTLE');
});

test('bestReinvestShip respects budget: skips anything unaffordable', () => {
  const pick = bestReinvestShip(YARD, { budget: 79_000 });
  // Only the probe is affordable, but it has zero earn weight -> nothing.
  assert.equal(pick, undefined);
});

test('bestReinvestShip can prefer a freighter when its ROI overtakes', () => {
  // Give the heavy freighter a bargain price so its ROI beats the shuttle.
  const yard: ReinvestCandidate[] = [
    { type: 'SHIP_LIGHT_SHUTTLE', price: 80_000 }, // 40/80k = 0.0005
    { type: 'SHIP_HEAVY_FREIGHTER', price: 200_000 }, // 120/200k = 0.0006
  ];
  const pick = bestReinvestShip(yard, { budget: 1_000_000 });
  assert.equal(pick!.type, 'SHIP_HEAVY_FREIGHTER');
});

test('bestReinvestShip applies minRoi floor', () => {
  // shuttle ROI 0.0005; floor above it -> nothing qualifies.
  const pick = bestReinvestShip(YARD, { budget: 1_000_000, minRoi: 0.001 });
  assert.equal(pick, undefined);
});

test('bestReinvestShip honours an injected earnRate', () => {
  // Make the light hauler the most valuable per credit via custom weights.
  const earnRate = (t: string): number => (t === 'SHIP_LIGHT_HAULER' ? 1000 : 1);
  const pick = bestReinvestShip(YARD, { budget: 1_000_000, earnRate });
  assert.equal(pick!.type, 'SHIP_LIGHT_HAULER');
});

test('bestReinvestShip returns undefined for an empty yard', () => {
  assert.equal(bestReinvestShip([], { budget: 1_000_000 }), undefined);
});

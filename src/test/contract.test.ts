import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateContract, procurementGood, remainingNeed } from '../behaviors/contract.js';
import type { Contract } from '../types/index.js';

const NOW = Date.UTC(2026, 0, 1);
const FUTURE = new Date(NOW + 86_400_000).toISOString(); // +1 day
const PAST = new Date(NOW - 86_400_000).toISOString(); // -1 day

function contract(p: {
  good?: string;
  units?: number;
  onAccepted?: number;
  onFulfilled?: number;
  deadline?: string;
  deliver?: Contract['terms']['deliver'];
}): Contract {
  const deliver =
    p.deliver ??
    (p.good
      ? [
          {
            tradeSymbol: p.good,
            destinationSymbol: 'X1-A20-A1',
            unitsRequired: p.units ?? 100,
            unitsFulfilled: 0,
          },
        ]
      : []);
  return {
    id: 'c1',
    factionSymbol: 'COSMIC',
    type: 'PROCUREMENT',
    accepted: false,
    fulfilled: false,
    terms: {
      deadline: p.deadline ?? FUTURE,
      payment: { onAccepted: p.onAccepted ?? 1000, onFulfilled: p.onFulfilled ?? 9000 },
      deliver,
    },
  };
}

const yesExporter = () => true;
const noExporter = () => false;
const priceNone = () => undefined;

test('evaluateContract: not-procurement when no deliver terms', () => {
  const e = evaluateContract(contract({ deliver: [] }), yesExporter, priceNone, NOW);
  assert.equal(e.feasible, false);
  assert.equal(e.reason, 'not-procurement');
  assert.equal(e.good, undefined);
});

test('evaluateContract: expired when deadline has passed', () => {
  const e = evaluateContract(
    contract({ good: 'IRON', deadline: PAST }),
    yesExporter,
    priceNone,
    NOW,
  );
  assert.equal(e.feasible, false);
  assert.equal(e.reason, 'expired');
});

test('evaluateContract: no-exporter when good is not exported in-system', () => {
  const e = evaluateContract(contract({ good: 'IRON' }), noExporter, priceNone, NOW);
  assert.equal(e.feasible, false);
  assert.equal(e.reason, 'no-exporter');
});

test('evaluateContract: feasible when no known price (price unknown)', () => {
  const e = evaluateContract(contract({ good: 'IRON' }), yesExporter, priceNone, NOW);
  assert.equal(e.feasible, true);
  assert.equal(e.reason, undefined);
  assert.equal(e.estCostPerUnit, undefined);
});

test('evaluateContract: feasible when buy price clears the 90% payout cap', () => {
  // payout 10000 / 100 units = 100/unit; cap = 90; price 80 < 90 -> feasible
  const e = evaluateContract(
    contract({ good: 'IRON', units: 100, onAccepted: 1000, onFulfilled: 9000 }),
    yesExporter,
    () => 80,
    NOW,
  );
  assert.equal(e.payoutPerUnit, 100);
  assert.equal(e.estCostPerUnit, 80);
  assert.equal(e.feasible, true);
});

test('evaluateContract: negative-roi when buy price exceeds the 90% payout cap', () => {
  // payout 100/unit; cap = 90; price 95 >= 90 -> infeasible
  const e = evaluateContract(
    contract({ good: 'IRON', units: 100, onAccepted: 1000, onFulfilled: 9000 }),
    yesExporter,
    () => 95,
    NOW,
  );
  assert.equal(e.feasible, false);
  assert.equal(e.reason, 'negative-roi');
  assert.equal(e.estCostPerUnit, 95);
});

test('evaluateContract: payoutPerUnit sums multi-term unit requirements', () => {
  const e = evaluateContract(
    contract({
      onAccepted: 0,
      onFulfilled: 20_000,
      deliver: [
        { tradeSymbol: 'IRON', destinationSymbol: 'X1-A20-A1', unitsRequired: 100, unitsFulfilled: 0 },
        { tradeSymbol: 'IRON', destinationSymbol: 'X1-A20-A1', unitsRequired: 100, unitsFulfilled: 0 },
      ],
    }),
    yesExporter,
    priceNone,
    NOW,
  );
  assert.equal(e.totalUnits, 200);
  assert.equal(e.payoutPerUnit, 100);
});

test('procurementGood returns first deliver trade symbol or undefined', () => {
  assert.equal(procurementGood(contract({ good: 'IRON' })), 'IRON');
  assert.equal(procurementGood(contract({ deliver: [] })), undefined);
});

test('remainingNeed sums unfulfilled units for a trade symbol', () => {
  const c = contract({
    deliver: [
      { tradeSymbol: 'IRON', destinationSymbol: 'X1-A20-A1', unitsRequired: 100, unitsFulfilled: 30 },
      { tradeSymbol: 'IRON', destinationSymbol: 'X1-A20-A1', unitsRequired: 50, unitsFulfilled: 50 },
      { tradeSymbol: 'COPPER', destinationSymbol: 'X1-A20-A1', unitsRequired: 40, unitsFulfilled: 0 },
    ],
  });
  assert.equal(remainingNeed(c, 'IRON'), 70);
  assert.equal(remainingNeed(c, 'COPPER'), 40);
  assert.equal(remainingNeed(c, 'GOLD'), 0);
});

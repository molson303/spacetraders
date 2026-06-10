import './_setupMemoryDb.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getWallet, setWallet, resetWallet } from '../state/wallet.js';
import { recordTransaction } from '../state/repos.js';

test('wallet mirror starts empty and records the latest balance', () => {
  resetWallet();
  assert.equal(getWallet(), undefined);
  setWallet(5000);
  assert.equal(getWallet(), 5000);
  setWallet(12345);
  assert.equal(getWallet(), 12345);
});

test('wallet ignores invalid values (undefined/null/negative/NaN)', () => {
  resetWallet();
  setWallet(8000);
  setWallet(undefined);
  setWallet(null);
  setWallet(-100);
  setWallet(Number.NaN);
  // None of the invalid writes should overwrite the last good value.
  assert.equal(getWallet(), 8000);
});

test('recordTransaction updates the live wallet mirror from creditsAfter', () => {
  resetWallet();
  recordTransaction({ kind: 'BUY_CARGO', creditsAfter: 250000 });
  assert.equal(getWallet(), 250000);
  recordTransaction({ kind: 'SELL_CARGO', creditsAfter: 431760 });
  assert.equal(getWallet(), 431760);
});

test('recordTransaction without creditsAfter leaves the wallet unchanged', () => {
  resetWallet();
  setWallet(99000);
  recordTransaction({ kind: 'BUY_CARGO' });
  assert.equal(getWallet(), 99000);
});

test('live per-trade budget resolver tracks the growing wallet', () => {
  // Mirrors the orchestrator resolver: floor(liveWallet * fraction). The bug it
  // fixes: a static snapshot froze this at the round-start (collapse-low) value,
  // locking traders out of high-value routes for the whole round.
  resetWallet();
  const fraction = 0.25;
  const resolve = (): number | undefined => {
    const c = getWallet();
    return c === undefined ? undefined : Math.max(0, Math.floor(c * fraction));
  };

  assert.equal(resolve(), undefined); // nothing recorded yet -> no cap

  setWallet(6006); // collapse low: budget too small for a 4094/u route
  assert.equal(resolve(), 1501);

  setWallet(474661); // recovered: budget now clears high-value routes
  assert.equal(resolve(), 118665);
});

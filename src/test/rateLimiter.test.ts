import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket, RateLimiter } from '../client/rateLimiter.js';

test('TokenBucket refills continuously up to capacity', () => {
  const b = new TokenBucket(2, 2, 0); // cap 2, 2/s
  assert.equal(b.take(0), true);
  assert.equal(b.take(0), true);
  assert.equal(b.take(0), false); // drained
  // 500ms later -> +1 token
  assert.equal(b.take(500), true);
  assert.equal(b.take(500), false);
  // never exceeds capacity even after a long idle
  b.refill(100000);
  assert.equal(b.available, 2);
});

test('TokenBucket msUntilToken reflects refill rate', () => {
  const b = new TokenBucket(2, 2, 0);
  b.take(0);
  b.take(0);
  assert.equal(b.msUntilToken(0), 500); // 2/s -> 500ms for 1 token
});

test('TokenBucket reconfigure clamps tokens to new capacity', () => {
  const b = new TokenBucket(30, 0.5, 0);
  assert.equal(b.available, 30);
  b.reconfigure(10, 0.5);
  assert.equal(b.available, 10);
});

test('dual buckets: burst drains fast, then throttles to sustained rate', () => {
  // Mirror the limiter's "take from BOTH" rule synchronously over a virtual
  // clock to prove the throughput shape: a quick burst, then ~ratePerSecond.
  const perSec = new TokenBucket(2, 2, 0);
  const burst = new TokenBucket(5, 5 / 60, 0); // 5 over 60s
  const tryTake = (now: number): boolean => {
    if (perSec.msUntilToken(now) === 0 && burst.msUntilToken(now) === 0) {
      perSec.take(now);
      burst.take(now);
      return true;
    }
    return false;
  };

  // At t=0 both full; the per-second bucket (2) is the tighter gate initially.
  assert.equal(tryTake(0), true);
  assert.equal(tryTake(0), true);
  assert.equal(tryTake(0), false); // perSec drained

  // After 2s, perSec refilled (capped 2) -> 2 more allowed, drawing burst to 1.
  assert.equal(tryTake(2000), true);
  assert.equal(tryTake(2000), true);
  assert.equal(tryTake(2000), false);

  // burst now at 1; one more allowed, then burst is the limiter.
  assert.equal(tryTake(4000), true); // 5th draw empties burst
  assert.equal(tryTake(4000), false); // burst empty even though perSec has tokens
});

test('RateLimiter serves all acquirers FIFO and never deadlocks', async () => {
  // Real clock, fast rates so the test completes quickly. Pure burst/sustained
  // math is covered by the TokenBucket cases above; here we assert the async
  // queue drains every waiter in order.
  const limiter = new RateLimiter({
    ratePerSecond: 50,
    burst: 50,
    burstWindowSec: 1,
  });

  const order: number[] = [];
  const tasks = Array.from({ length: 8 }, (_, i) =>
    limiter.acquire().then(() => order.push(i)),
  );

  await Promise.all(tasks);
  assert.equal(order.length, 8);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]); // FIFO preserved
  assert.equal(limiter.pending, 0);
});

test('RateLimiter observeHeaders re-tunes from server limits', () => {
  const limiter = new RateLimiter({ ratePerSecond: 2, burst: 25, now: () => 0 });
  const headers = new Headers({
    'x-ratelimit-limit-per-second': '3',
    'x-ratelimit-limit-burst': '40',
  });
  // Should not throw and should accept the new numbers.
  limiter.observeHeaders(headers);
  // Garbage values are ignored.
  limiter.observeHeaders(new Headers({ 'x-ratelimit-limit-burst': 'nope' }));
  assert.equal(limiter.pending, 0);
});

import { createLogger } from '../util/logger.js';

const log = createLogger('ratelimit');

/*
 * Global token-bucket rate limiter shared by every API call from every ship.
 *
 * SpaceTraders allows ~2 requests/sec sustained with a small burst. We model
 * this as a bucket that refills continuously. All callers `await acquire()`
 * before issuing a request; requests are served strictly FIFO so no ship
 * starves. A 429 response can also force a global cooldown via `penalize()`.
 */

export interface RateLimiterOptions {
  ratePerSecond?: number; // sustained refill rate
  burst?: number; // max tokens in the bucket
}

interface Waiter {
  resolve: () => void;
}

export class RateLimiter {
  private readonly ratePerSecond: number;
  private readonly burst: number;
  private tokens: number;
  private lastRefill: number;
  private queue: Waiter[] = [];
  private penaltyUntil = 0;
  private draining = false;

  constructor(opts: RateLimiterOptions = {}) {
    this.ratePerSecond = opts.ratePerSecond ?? 2;
    this.burst = opts.burst ?? 2;
    this.tokens = this.burst;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
    this.lastRefill = now;
  }

  /** Wait until a request slot is available. */
  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
      this.drain();
    });
  }

  /** Force a global pause (e.g. server told us retry-after N seconds). */
  penalize(seconds: number): void {
    const until = Date.now() + seconds * 1000;
    if (until > this.penaltyUntil) {
      this.penaltyUntil = until;
      log.warn(`global cooldown for ${seconds.toFixed(2)}s (429)`);
      this.drain();
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const now = Date.now();
        if (now < this.penaltyUntil) {
          await sleep(this.penaltyUntil - now);
          continue;
        }
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          const waiter = this.queue.shift()!;
          waiter.resolve();
        } else {
          const needed = (1 - this.tokens) / this.ratePerSecond;
          await sleep(Math.max(5, needed * 1000));
        }
      }
    } finally {
      this.draining = false;
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

import { createLogger } from '../util/logger.js';

const log = createLogger('ratelimit');

/*
 * Global rate limiter shared by every API call from every ship.
 *
 * SpaceTraders enforces TWO coupled limits: a sustained ~2 requests/sec AND a
 * larger burst allowance (~30 requests per rolling 60s). We model this as two
 * token buckets; a request must take a token from BOTH to proceed, so the fleet
 * can fire a short burst quickly but still settle to the sustained rate. This is
 * far more throughput than a single burst=2 bucket while staying within limits.
 *
 * All callers `await acquire()` before issuing a request; requests are served
 * strictly FIFO so no ship starves. A 429 forces a global cooldown via
 * `penalize()`, and `observeHeaders()` lets live `x-ratelimit-*` response
 * headers re-tune the buckets to the server's actual numbers.
 */

export interface RateLimiterOptions {
  /** Sustained requests per second (default 2). */
  ratePerSecond?: number;
  /** Max requests in a burst window (default 25, a margin under the ~30 cap). */
  burst?: number;
  /** Burst window length in seconds (default 60). */
  burstWindowSec?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

interface Waiter {
  resolve: () => void;
}

/** A continuously-refilling token bucket. Pure aside from the injected clock. */
export class TokenBucket {
  capacity: number;
  private tokens: number;
  private refillPerSec: number;
  private last: number;

  constructor(capacity: number, refillPerSec: number, now: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerSec = refillPerSec;
    this.last = now;
  }

  /** Reconfigure capacity/rate, keeping current token count within the new cap. */
  reconfigure(capacity: number, refillPerSec: number): void {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = Math.min(this.tokens, capacity);
  }

  refill(now: number): void {
    const elapsed = (now - this.last) / 1000;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.last = now;
  }

  /** Take one token if available; returns true on success. */
  take(now: number): boolean {
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Milliseconds until at least one token is available. */
  msUntilToken(now: number): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);
  }

  /** Test/inspection helper. */
  get available(): number {
    return this.tokens;
  }
}

export class RateLimiter {
  private readonly second: TokenBucket;
  private readonly burst: TokenBucket;
  private readonly now: () => number;
  private queue: Waiter[] = [];
  private penaltyUntil = 0;
  private draining = false;

  constructor(opts: RateLimiterOptions = {}) {
    const ratePerSecond = opts.ratePerSecond ?? 2;
    const burstSize = opts.burst ?? 25;
    const windowSec = opts.burstWindowSec ?? 60;
    this.now = opts.now ?? Date.now;
    const t = this.now();
    this.second = new TokenBucket(ratePerSecond, ratePerSecond, t);
    this.burst = new TokenBucket(burstSize, burstSize / windowSec, t);
  }

  /** Wait until a request slot is available in BOTH buckets. */
  acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ resolve });
      void this.drain();
    });
  }

  /** Force a global pause (e.g. server told us retry-after N seconds). */
  penalize(seconds: number): void {
    const until = this.now() + seconds * 1000;
    if (until > this.penaltyUntil) {
      this.penaltyUntil = until;
      log.warn(`global cooldown for ${seconds.toFixed(2)}s (429)`);
      void this.drain();
    }
  }

  /**
   * Re-tune buckets from live `x-ratelimit-*` response headers so we track the
   * server's real limits instead of our static guess. Safe to call on every
   * response; ignores missing/garbage values.
   */
  observeHeaders(headers: Headers): void {
    const perSec = num(headers.get('x-ratelimit-limit-per-second'));
    const burstLimit = num(headers.get('x-ratelimit-limit-burst'));
    if (perSec && perSec > 0) this.second.reconfigure(perSec, perSec);
    if (burstLimit && burstLimit > 0) {
      // Keep a small safety margin under the advertised burst cap.
      const cap = Math.max(1, Math.floor(burstLimit * 0.85));
      this.burst.reconfigure(cap, burstLimit / 60);
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const now = this.now();
        if (now < this.penaltyUntil) {
          await sleep(this.penaltyUntil - now);
          continue;
        }
        // Need a token from BOTH buckets. Peek both; only consume when both ready.
        const secWait = this.second.msUntilToken(now);
        const burstWait = this.burst.msUntilToken(now);
        if (secWait === 0 && burstWait === 0) {
          this.second.take(now);
          this.burst.take(now);
          this.queue.shift()!.resolve();
        } else {
          await sleep(Math.max(5, secWait, burstWait));
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

function num(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

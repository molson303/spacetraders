/*
 * Small concurrency helpers for the background-timer maintenance model.
 */

/**
 * Wrap an async task so overlapping invocations are skipped while one is still
 * in flight. Background timers (setInterval) fire on a fixed period regardless
 * of whether the previous run finished; a slow maintenance cycle (probe
 * provisioning travels + scans + purchases) can outlast its interval, so two
 * cycles would otherwise run concurrently, both read the same stale fleet
 * state, and both buy toward the same cap — overshooting it (the probe-buy
 * overshoot: 22 bought against 18 headroom). This guard makes a tardy task
 * simply skip the overlapping tick and run again on the next clear one.
 *
 * Returns a wrapper that resolves to the task's result, or `undefined` when the
 * call was skipped because a prior run was still active. The active flag is
 * always cleared, even if the task throws.
 */
export function nonReentrant<T>(fn: () => Promise<T>): () => Promise<T | undefined> {
  let active = false;
  return async (): Promise<T | undefined> => {
    if (active) return undefined;
    active = true;
    try {
      return await fn();
    } finally {
      active = false;
    }
  };
}

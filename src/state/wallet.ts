/*
 * In-memory mirror of the agent's live credit balance.
 *
 * Every buy/sell funnels its post-transaction `agent.credits` through
 * recordTransaction, which updates this value. Consumers can therefore read the
 * CURRENT wallet without spending an API request on getMyAgent.
 *
 * Why this exists: the per-trade spend cap was sized once from the wallet at
 * round start. With long rounds (ROUND_BUDGET_MS) that snapshot froze the cap at
 * whatever the wallet was when the round began — after a collapse that was the
 * low-water mark, so the cap stayed tiny for the entire round and locked traders
 * out of every high-value route (DRUGS/EQUIPMENT/MICROPROCESSORS) even as the
 * wallet recovered. Sizing the cap off this live value keeps it proportional to
 * the real wallet instead of a stale floor.
 */

let current: number | undefined;

/** Record the latest known agent credit balance. Ignores invalid values. */
export function setWallet(credits: number | undefined | null): void {
  if (typeof credits === 'number' && Number.isFinite(credits) && credits >= 0) {
    current = credits;
  }
}

/** Latest known agent credits, or undefined if nothing has been recorded yet. */
export function getWallet(): number | undefined {
  return current;
}

/** Reset the mirror (tests). */
export function resetWallet(): void {
  current = undefined;
}

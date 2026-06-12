import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nonReentrant } from '../util/concurrency.js';

/** A promise plus its resolver, so a test can hold a task "in flight". */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test('nonReentrant skips overlapping calls while one is in flight', async () => {
  const gate = deferred<void>();
  let runs = 0;
  const guarded = nonReentrant(async () => {
    runs++;
    await gate.promise;
    return runs;
  });

  const first = guarded(); // starts, blocks on gate
  const second = await guarded(); // overlapping -> skipped immediately
  assert.equal(second, undefined);
  assert.equal(runs, 1); // the task body ran only once

  gate.resolve();
  assert.equal(await first, 1);
});

test('nonReentrant runs again on the next clear tick', async () => {
  let runs = 0;
  const guarded = nonReentrant(async () => ++runs);

  assert.equal(await guarded(), 1);
  assert.equal(await guarded(), 2); // prior run finished -> not skipped
});

test('nonReentrant clears the active flag even when the task throws', async () => {
  let runs = 0;
  const guarded = nonReentrant(async () => {
    runs++;
    throw new Error('boom');
  });

  await assert.rejects(guarded(), /boom/);
  // Flag was released despite the throw, so the next call runs.
  await assert.rejects(guarded(), /boom/);
  assert.equal(runs, 2);
});

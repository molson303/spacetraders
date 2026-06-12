import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAllPages } from '../util/paginate.js';
import type { ApiList } from '../types/index.js';

/** A paged source of `total` numbered items, served `pageSize` at a time. */
function pagedSource(total: number, pageSize: number) {
  let calls = 0;
  const fetchPage = async (page: number): Promise<ApiList<number>> => {
    calls++;
    const start = (page - 1) * pageSize;
    const data = Array.from(
      { length: Math.max(0, Math.min(pageSize, total - start)) },
      (_, i) => start + i,
    );
    return { data, meta: { total, page, limit: pageSize } };
  };
  return { fetchPage, calls: () => calls };
}

test('collectAllPages walks every page until meta.total is reached', async () => {
  // 42 ships at 20/page -> 3 pages (20 + 20 + 2). The bug this guards against:
  // the fleet only ever saw page 1 (20 ships), hiding 22 probes.
  const src = pagedSource(42, 20);
  const all = await collectAllPages(src.fetchPage);
  assert.equal(all.length, 42);
  assert.deepEqual(all[0], 0);
  assert.deepEqual(all[41], 41);
  assert.equal(src.calls(), 3);
});

test('collectAllPages handles a single full page (no extra fetch)', async () => {
  const src = pagedSource(20, 20);
  const all = await collectAllPages(src.fetchPage);
  assert.equal(all.length, 20);
  assert.equal(src.calls(), 1); // exactly total -> stop without a probe page
});

test('collectAllPages handles an empty fleet', async () => {
  const src = pagedSource(0, 20);
  const all = await collectAllPages(src.fetchPage);
  assert.deepEqual(all, []);
  assert.equal(src.calls(), 1);
});

test('collectAllPages stops on an empty page even if total is inconsistent', async () => {
  // Defensive: a wrong/high total must not loop forever; an empty page ends it.
  let calls = 0;
  const fetchPage = async (page: number): Promise<ApiList<number>> => {
    calls++;
    const data = page <= 2 ? [page] : [];
    return { data, meta: { total: 9999, page, limit: 1 } };
  };
  const all = await collectAllPages(fetchPage);
  assert.deepEqual(all, [1, 2]);
  assert.equal(calls, 3); // page 3 is empty -> break
});

/*
 * Pagination helper for the SpaceTraders list endpoints. Pages are capped
 * server-side (ships at 20/page), so any caller that needs the full collection
 * — the whole fleet roster, every contract — must walk the pages. Pure: the
 * page fetch is injected, so the walk logic is unit-testable with no HTTP.
 */

import type { ApiList } from '../types/index.js';

/**
 * Exhaustively page through a list endpoint, accumulating every item. Pages are
 * 1-based to match the API. Stops once the accumulated count reaches
 * `meta.total`, or defensively when a page returns no rows (guards against an
 * inconsistent/missing total so a bad response can't loop forever).
 */
export async function collectAllPages<T>(
  fetchPage: (page: number) => Promise<ApiList<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  for (;;) {
    const res = await fetchPage(page);
    all.push(...res.data);
    const total = res.meta?.total ?? all.length;
    if (res.data.length === 0 || all.length >= total) break;
    page++;
  }
  return all;
}

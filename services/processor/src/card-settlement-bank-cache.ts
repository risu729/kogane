// Tick-local sharing of the unchanged bank query. Entries belong to one CORE
// input revision, never merely a date. No result crosses a sweep invocation.
import type { CoreRevisionRow } from "../../../packages/read-model/src/source-revision.ts";

const MAX_DATES = 32;
const MAX_ROWS = 2000;

function revisionKey(row: CoreRevisionRow | null): string | null {
  if (
    !row ||
    !Number.isSafeInteger(row.source_revision) ||
    row.source_revision < 0 ||
    !Number.isSafeInteger(row.visibility_revision) ||
    row.visibility_revision < 0 ||
    typeof row.core_epoch !== "string" ||
    row.core_epoch.length === 0
  )
    return null;
  return JSON.stringify([row.source_revision, row.visibility_revision, row.core_epoch]);
}

/** The caller fixes query text, adapter semantics and row limit for this reader.
 * A mutation during a miss leaves that query's normal result usable but never
 * tags it as belonging to either revision. Empty results are cacheable too. */
export function createSettlementBankReader<T>(
  readRevision: () => Promise<CoreRevisionRow | null>,
  readRows: (date: string) => Promise<readonly T[]>,
): (date: string) => Promise<readonly T[]> {
  const cache = new Map<string, readonly T[]>();
  let revision: string | null = null;
  let retainedRows = 0;
  return async (date) => {
    const before = revisionKey(await readRevision());
    if (before === null || before !== revision) {
      cache.clear();
      retainedRows = 0;
      revision = before;
    }
    const cached = cache.get(date);
    if (before !== null && cached !== undefined) {
      cache.delete(date);
      cache.set(date, cached);
      return cached;
    }
    const rows = await readRows(date);
    if (before === null) return rows;
    const after = revisionKey(await readRevision());
    if (after !== before) {
      cache.clear();
      retainedRows = 0;
      revision = after;
      return rows;
    }
    // Never truncate a query result to make it fit; an oversized result simply
    // bypasses sharing. LRU eviction bounds both empty-date and row retention.
    if (rows.length > MAX_ROWS) return rows;
    while (cache.size >= MAX_DATES || retainedRows + rows.length > MAX_ROWS) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      retainedRows -= cache.get(oldest)!.length;
      cache.delete(oldest);
    }
    cache.set(date, rows);
    retainedRows += rows.length;
    return rows;
  };
}

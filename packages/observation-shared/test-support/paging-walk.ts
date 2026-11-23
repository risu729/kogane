// The paging conformance walk (ADR 0128): a client that knows nothing of a
// read's cursor kind continues by merging `next.arguments` into its last call
// until `next` is null. This walk does exactly that, checks `next` and
// `paging` on every page, and returns every item it saw, so a test can check
// the walk reached the end with no duplicate and no gap. Framework-free: it
// throws on the first broken rule, so Bun and Vitest tests share it.
import { continueCall, validPagedFields, type PagedFields } from "../src/paging-contract";

export interface PagingWalk<Item> {
  /** Every item seen, in walk order. */
  items: Item[];
  /** Every call's arguments, in order: the first, then each continuation. */
  calls: Record<string, unknown>[];
  /** Whether the walk ended on a page whose rows follow but are withheld (`stoppedBy: "budget"`). */
  withheld: boolean;
}

export async function walkPages<Item>(input: {
  /** The first call's arguments. */
  first: Record<string, unknown>;
  /** One call; returns the object that carries `next` and `paging`. */
  call: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** The items of one answer. */
  items: (answer: Record<string, unknown>) => readonly Item[];
  /** An item's identity, unique across the whole list. */
  id: (item: Item) => string;
  /** A bound on the walk, so a continuation that never ends fails. */
  maxPages?: number;
}): Promise<PagingWalk<Item>> {
  const seen = new Set<string>();
  const items: Item[] = [];
  const calls: Record<string, unknown>[] = [];
  let args: Record<string, unknown> = input.first;
  const maxPages = input.maxPages ?? 100;
  for (let page = 1; page <= maxPages; page += 1) {
    calls.push(args);
    const answer = await input.call(args);
    if (!validPagedFields(answer))
      throw new Error(`page ${page}: next and paging break the contract`);
    const { next, paging } = answer as unknown as PagedFields;
    const listed = input.items(answer);
    if (paging.returned !== listed.length)
      throw new Error(`page ${page}: paging.returned ${paging.returned} != ${listed.length} items`);
    for (const item of listed) {
      const key = input.id(item);
      if (seen.has(key)) throw new Error(`page ${page}: ${key} was already listed`);
      seen.add(key);
      items.push(item);
    }
    if (next === null) return { items, calls, withheld: paging.stoppedBy === "budget" };
    // Only the continuation changes; every other argument repeats as it was.
    args = continueCall(args, next);
  }
  throw new Error(`no last page within ${maxPages} pages`);
}

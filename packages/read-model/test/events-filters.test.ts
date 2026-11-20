// The activity list's filters (ADR 0081, amendment of 2026-11-20) are a
// rewrite of a shipped query, so they are proven equal to it: the unfiltered
// text is the frozen legacy text byte for byte, and every filtered read,
// paged to its end, returns exactly the shipped list narrowed in memory by an
// independent restatement of each filter. The comparison runs on random
// stores that draw every shape the filters decide (both account forms, live
// and superseded revisions, revisions of one event left live together, a
// merge across event ids, evidence that names no parse run, a parse run that
// does not exist, a malformed reference, recording times in every stored
// form) and on a scaled store past the walk bound, at several page sizes and
// walk bounds. The plans are checked without table statistics in
// `statement-plans.test.ts` and on workerd's D1 in
// services/processor/test/events-filters-cost.test.ts. Every value is
// synthetic.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  ACTIVITY_FILTER_WALK,
  activityEventsSql,
  type ActivityBasis,
  type ActivityFilters,
  type ActivityKey,
  createEventsReader,
  type EventView,
  type FilteredActivityPage,
} from "../src/index";
import type { SqlExecutor } from "../src/reader";
import { fullCoreDatabase } from "../../storage-d1/test/sqlite.ts";
import { LEGACY_ACTIVITY_EVENTS_SQL } from "./events-activity-legacy-sql";
import { EventsWorld, random, transactionRef, WORLD_SOURCES } from "./events-filter-world";

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const BASES: readonly ActivityBasis[] = ["cash-movement", "purchase-recognition"];
const NONE: ActivityFilters = { since: null, before: null, account: null, source: null };

function executor(db: Database): SqlExecutor {
  return {
    all: async <T>(statement: string, args: readonly unknown[]) =>
      db.query(statement).all(...(args as never[])) as T[],
    first: async <T>(statement: string, args: readonly unknown[]) =>
      (db.query(statement).get(...(args as never[])) ?? null) as T | null,
  };
}

/** The shipped list: every row of the frozen text, as the reader answers them. */
async function shipped(db: Database, basis: ActivityBasis): Promise<EventView[]> {
  const items = (
    await createEventsReader(executor(db), { pageSize: 1_000_000 }).activity({ basis, offset: 0 })
  ).items;
  // The reader's text is the frozen one, and so are its rows and their order.
  const legacy = db.query(LEGACY_ACTIVITY_EVENTS_SQL).all(basis, 1_000_001, 0) as {
    event_id: string;
    revision: number;
  }[];
  expect(items.map((item) => [item.eventId, item.revision])).toEqual(
    legacy.map((row) => [row.event_id, row.revision]),
  );
  return items;
}

/**
 * What each filter means, restated without the filtered text: each
 * revision's recording time, its own legs and its own evidence, and the
 * source of each parse run, read whole from the base tables.
 */
function narrowed(db: Database, items: readonly EventView[], filters: ActivityFilters) {
  const rows = <T>(text: string) => db.query(text).all() as T[];
  const key = (eventId: string, revision: number) => `${eventId}@${revision}`;
  const revisions = new Map(
    rows<{ event_id: string; revision: number; created_at: string; evidence_support_json: string }>(
      "SELECT event_id,revision,created_at,evidence_support_json FROM economic_event_revisions",
    ).map((row) => {
      const at = Date.parse(row.created_at);
      return [
        key(row.event_id, row.revision),
        {
          at: Number.isFinite(at) ? new Date(at).toISOString() : null,
          evidence: JSON.parse(row.evidence_support_json) as unknown[],
        },
      ];
    }),
  );
  const subjects = new Map<string, string[]>();
  for (const leg of rows<{ event_id: string; revision: number; subject_ref: string }>(
    "SELECT event_id,revision,subject_ref FROM economic_legs",
  )) {
    const revision = key(leg.event_id, leg.revision);
    subjects.set(revision, [...(subjects.get(revision) ?? []), leg.subject_ref]);
  }
  const captured = new Map(
    rows<{ id: number; source_id: string }>(
      "SELECT p.id,a.source_id FROM parse_runs p JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id",
    ).map((row) => [String(row.id), row.source_id]),
  );
  return items.filter((item) => {
    const revision = revisions.get(key(item.eventId, item.revision))!;
    const at = revision.at;
    if (filters.since !== null && (at === null || at < filters.since)) return false;
    if (filters.before !== null && (at === null || at >= filters.before)) return false;
    if (
      filters.account !== null &&
      !(subjects.get(key(item.eventId, item.revision)) ?? []).some(
        (subject) => subject === filters.account || subject === `account:${filters.account}`,
      )
    )
      return false;
    if (
      filters.source !== null &&
      !revision.evidence.some((ref) => {
        if (ref === null || typeof ref !== "object" || Array.isArray(ref)) return false;
        const parse = (ref as { revision?: unknown }).revision;
        const id = typeof parse === "string" ? /^parse_run:([1-9]\d*)$/u.exec(parse) : null;
        return id !== null && captured.get(id[1]!) === filters.source;
      })
    )
      return false;
    return true;
  });
}

/** Each listed revision's place in the order, as `event@revision`. */
const keys = (items: readonly EventView[]) =>
  items.map((item) => `${item.eventId}@${item.revision}`);

/** Every page of a filtered read, from the first to the last, with each page's own bounds checked. */
async function paged(
  db: Database,
  basis: ActivityBasis,
  filters: ActivityFilters,
  pageSize: number,
  walk: number,
): Promise<{ items: EventView[]; pages: FilteredActivityPage[] }> {
  const reader = createEventsReader(executor(db), { pageSize, filterWalk: walk });
  const items: EventView[] = [];
  const pages: FilteredActivityPage[] = [];
  let after: ActivityKey | null = null;
  for (;;) {
    const page = await reader.filteredActivity({ basis, filters, after });
    expect(page.items.length).toBeLessThanOrEqual(pageSize);
    expect(page.walked).toBeLessThanOrEqual(walk);
    expect(page.walk).toBe(walk);
    expect(page.dataCoverage.truncated).toBe(page.next !== null);
    // A page that continues either filled up or walked as far as it may.
    if (page.next !== null)
      expect(page.items.length === pageSize || page.walked === walk).toBe(true);
    items.push(...page.items);
    pages.push(page);
    if (page.next === null) return { items, pages };
    after = page.next;
    if (pages.length > 100_000) throw new Error("the filtered walk does not end");
  }
}

const day = (n: number) => Date.UTC(2099, 0, 1) + n * 86_400_000;

/** A recording time in one of the forms `created_at` holds, or a value that is no time at all. */
function stamp(draw: () => number, ms: number): string {
  const form = draw();
  const iso = new Date(ms).toISOString();
  if (form < 0.45) return iso;
  if (form < 0.65) return iso.replace(/\.\d{3}Z$/u, "Z");
  if (form < 0.85) {
    // The same instant written at +09:00.
    const local = new Date(ms + 9 * 3_600_000).toISOString().replace(/Z$/u, "");
    return `${local}+09:00`;
  }
  if (form < 0.95) return iso.slice(0, 10);
  return "unrecorded";
}

/**
 * A random store; `size` event ids, each with one to three revisions. With
 * `conflicts`, some later revisions stay live beside the earlier one, the
 * inconsistency `economic_event_live_conflicts` lists; without, every later
 * revision replaces the live one, as the writers write them.
 */
function randomWorld(seed: number, size: number, conflicts: boolean) {
  const draw = random(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(draw() * values.length)]!;
  const world = new EventsWorld();
  const parses = WORLD_SOURCES.flatMap((source) =>
    Array.from({ length: 1 + Math.floor(draw() * 3) }, () => world.capture(source)),
  );
  const accounts = ["account_a1", "account_b2", "account_c3", "acct.D4", "account_e5"];
  const subjects = [
    ...accounts.map((account) => `account:${account}`),
    ...accounts.map((account) => account),
    "claim:cost",
    "account:account_unknown",
  ];
  const bases = ["cash-movement", "purchase-recognition", "obligation-change"];
  const prefixes = ["card-purchase:", "ev-", "E", "z", "é-", "card-purchase:0"];
  const evidence = (): unknown[] => {
    const refs: unknown[] = [];
    for (let n = 1 + Math.floor(draw() * 3); n > 0; n -= 1) {
      const shape = draw();
      const parse = pick(parses);
      if (shape < 0.6) refs.push(transactionRef(Math.floor(draw() * 50) + 1, parse));
      else if (shape < 0.7) refs.push(transactionRef(1, 999_999)); // no such parse run
      else if (shape < 0.78) refs.push(transactionRef(1, `parse_run:0${parse}`)); // malformed
      else if (shape < 0.86)
        refs.push({
          kind: "typed-claim",
          id: "card_debit_account_statement:1",
          revision: "reader:1",
        });
      else if (shape < 0.92) refs.push({ kind: "balance", id: "balance:1", revision: parse });
      else if (shape < 0.96) refs.push({ kind: "transaction", id: "transaction:1" });
      else refs.push("synthetic-text");
    }
    return refs;
  };
  const ids = [
    ...new Set(
      Array.from({ length: size }, () => `${pick(prefixes)}${Math.floor(draw() * 10_000)}`),
    ),
  ];
  const live = new Map<string, number>();
  for (const eventId of ids)
    for (let revision = 1, last = 1 + Math.floor(draw() * 3); revision <= last; revision += 1) {
      const legs = Array.from({ length: Math.floor(draw() * 4) }, () => ({
        subjectRef: pick(subjects),
        basis: pick(bases),
      }));
      // A later revision replaces the live one; with conflicts, some stay live beside it.
      const replaces = revision > 1 && (!conflicts || draw() < 0.8);
      world.event({
        eventId,
        revision,
        kind: draw() < 0.5 ? "purchase" : "card_settlement",
        createdAt: stamp(draw, day(Math.floor(draw() * 30)) + Math.floor(draw() * 86_400_000)),
        evidence: evidence(),
        legs,
        ...(replaces ? { supersedes: [{ eventId, revision: revision - 1 }] } : {}),
      });
      live.set(eventId, revision);
    }
  // A merge: a revision of one event replaces another event's live revision
  // (and its own, unless the store keeps conflicts).
  for (let n = 0; n < Math.min(3, ids.length - 1); n += 1) {
    const [from, into] = [ids[n]!, ids[ids.length - 1 - n]!];
    if (from === into || !live.has(from)) continue;
    const revision = live.get(into)! + 1;
    world.event({
      eventId: into,
      revision,
      createdAt: stamp(draw, day(20)),
      evidence: [transactionRef(1, pick(parses))],
      legs: [{ subjectRef: `account:${accounts[n]}`, basis: "cash-movement" }],
      supersedes: [
        { eventId: from, revision: live.get(from)! },
        ...(conflicts ? [] : [{ eventId: into, revision: live.get(into)! }]),
      ],
    });
    live.delete(from);
    live.set(into, revision);
  }
  const instant = () =>
    draw() < 0.4
      ? null
      : new Date(day(Math.floor(draw() * 32)) + Math.floor(draw() * 86_400_000)).toISOString();
  const filters = (): ActivityFilters => {
    let since = instant();
    let before = instant();
    if (since !== null && before !== null && since >= before) [since, before] = [before, since];
    if (since !== null && since === before) before = null;
    return {
      since,
      before,
      account: draw() < 0.5 ? null : pick([...accounts, "account_unknown"]),
      source: draw() < 0.6 ? null : pick([...WORLD_SOURCES, "wise"]),
    };
  };
  return { world, filters };
}

describe("the unfiltered list is the shipped one", () => {
  test("its text is the frozen legacy text, byte for byte", () => {
    expect(activityEventsSql).toBe(LEGACY_ACTIVITY_EVENTS_SQL);
  });

  test("with no filter, the filtered walk returns the shipped list on random stores", async () => {
    for (const seed of [1, 2, 3])
      for (const conflicts of [false, true]) {
        const { world } = randomWorld(seed, 60, conflicts);
        for (const basis of BASES)
          for (const [pageSize, walk] of [
            [4, 9],
            [200, ACTIVITY_FILTER_WALK],
          ] as const) {
            const { items } = await paged(world.db, basis, NONE, pageSize, walk);
            const all = await shipped(world.db, basis);
            // With two live revisions of one event, an item's view depends on
            // which other rows share its page (see the comparisons below).
            if (conflicts) expect(keys(items)).toEqual(keys(all));
            else expect(items).toEqual(all);
          }
        world.db.close();
      }
  });
});

describe("a filtered read is the shipped list narrowed in memory", () => {
  /**
   * Each store is compared twice over: the revisions listed, in order, on
   * every store; and every listed item whole on stores the writers could
   * have written. The item view (`views` in src/events.ts) gathers legs and
   * evidence by event id, so where two revisions of one event are live (an
   * inconsistency `economic_event_live_conflicts` lists, which no writer
   * leaves) an item shows what its page holds of both: the shipped list
   * does so too, page by page, so the view of such an item is not a
   * property of the list. The filters decide on each revision's own legs
   * and evidence, which the revision comparison checks.
   */
  test("on random stores, at every page size and walk bound, paged to its end", async () => {
    let compared = 0;
    let nonEmpty = 0;
    for (let seed = 10; seed < 30; seed += 1)
      for (const conflicts of [false, true]) {
        const { world, filters } = randomWorld(seed, 30 + (seed % 5) * 20, conflicts);
        for (const basis of BASES) {
          const all = await shipped(world.db, basis);
          for (let n = 0; n < 6; n += 1) {
            const chosen = filters();
            const expected = narrowed(world.db, all, chosen);
            for (const [pageSize, walk] of [
              [1, 3],
              [3, 7],
              [5, 2],
              [200, ACTIVITY_FILTER_WALK],
            ] as const) {
              const { items } = await paged(world.db, basis, chosen, pageSize, walk);
              const context = { seed, conflicts, basis, chosen, pageSize, walk };
              expect({ ...context, listed: keys(items) }).toEqual({
                ...context,
                listed: keys(expected),
              });
              if (!conflicts)
                expect({ ...context, items }).toEqual({ ...context, items: expected });
            }
            compared += 1;
            if (expected.length > 0) nonEmpty += 1;
          }
        }
        world.db.close();
      }
    // The draws decide something: many comparisons list revisions, some do not.
    expect(compared).toBe(480);
    expect(nonEmpty).toBeGreaterThan(130);
    expect(nonEmpty).toBeLessThan(compared);
  }, 120_000);

  test("on a scaled store past the walk bound, each page reads at most the bound", async () => {
    const world = new EventsWorld();
    const parses = WORLD_SOURCES.map((source) => world.capture(source));
    const size = ACTIVITY_FILTER_WALK * 2 + 1_234;
    const start = day(0);
    world.db.exec("BEGIN");
    for (let n = 0; n < size; n += 1) {
      const eventId = `card-purchase:${(n * 7919) % size}`;
      const account = `account_${n % 40}`;
      const event = {
        eventId,
        createdAt: new Date(start + n * 60_000).toISOString(),
        evidence: [transactionRef(n + 1, parses[n % parses.length]!)],
        legs: [
          { subjectRef: n % 3 === 0 ? account : `account:${account}`, basis: "cash-movement" },
          { subjectRef: "claim:cost", basis: "purchase-recognition", role: "increase" as const },
        ],
      };
      world.event({ ...event, revision: 1 });
      // One in five is revised later; the first revision stays only as history.
      if (n % 5 === 0)
        world.event({
          ...event,
          revision: 2,
          createdAt: new Date(start + (size + n) * 60_000).toISOString(),
          supersedes: [{ eventId, revision: 1 }],
        });
    }
    world.db.exec("COMMIT");
    const all = await shipped(world.db, "cash-movement");
    expect(all).toHaveLength(size);
    const late = new Date(start + (size - 300) * 60_000).toISOString();
    for (const chosen of [
      { ...NONE, since: late },
      { ...NONE, account: "account_7" },
      { ...NONE, source: "myjcb" },
      {
        ...NONE,
        since: late,
        before: new Date(start + size * 60_000).toISOString(),
        source: "vpass",
      },
      {
        since: new Date(start).toISOString(),
        before: late,
        account: "account_3",
        source: "smbc-bank",
      },
    ]) {
      const expected = narrowed(world.db, all, chosen);
      expect(expected.length).toBeGreaterThan(0);
      const begun = performance.now();
      const { items, pages } = await paged(
        world.db,
        "cash-movement",
        chosen,
        200,
        ACTIVITY_FILTER_WALK,
      );
      console.info("events filters: scaled store", {
        chosen,
        listed: items.length,
        pages: pages.length,
        ms: Math.round(performance.now() - begun),
      });
      expect(items).toEqual(expected);
      // The walk crosses the live revisions in bounded steps: never more
      // than the bound a page, and every page but the last walks it whole
      // unless the page filled first.
      expect(pages.reduce((total, page) => total + page.walked, 0)).toBeGreaterThanOrEqual(size);
      for (const page of pages.slice(0, -1))
        expect(page.walked === ACTIVITY_FILTER_WALK || page.items.length === 200).toBe(true);
    }
    world.db.close();
  }, 120_000);
});

describe("what each filter keeps", () => {
  /** A small store whose every revision is named for what it should match. */
  function store() {
    const world = new EventsWorld();
    const vpass = world.capture("vpass");
    const bank = world.capture("smbc-bank");
    const cash = (subjectRef: string) => [{ subjectRef, basis: "cash-movement" }];
    world.event({
      eventId: "ev-a",
      revision: 1,
      createdAt: "2099-01-10T00:00:00.000Z",
      evidence: [transactionRef(1, vpass)],
      legs: cash("account:account_1"),
    });
    // Recorded at the same instant as `since` below, written at +09:00.
    world.event({
      eventId: "ev-b",
      revision: 1,
      createdAt: "2099-01-11T09:00:00+09:00",
      evidence: [
        transactionRef(2, bank),
        { kind: "typed-claim", id: "card_debit_account_statement:1", revision: "reader:1" },
      ],
      legs: cash("account_1"),
    });
    // Revised since: only the live revision is listed, whenever the first was recorded.
    world.event({
      eventId: "ev-c",
      revision: 1,
      createdAt: "2099-01-12T00:00:00.000Z",
      evidence: [transactionRef(3, vpass)],
      legs: cash("account:account_2"),
    });
    world.event({
      eventId: "ev-c",
      revision: 2,
      createdAt: "2099-01-13T00:00:00.000Z",
      evidence: [transactionRef(3, bank)],
      legs: cash("account:account_2"),
      supersedes: [{ eventId: "ev-c", revision: 1 }],
    });
    // Recorded exactly at `before`: outside the window.
    world.event({
      eventId: "ev-d",
      revision: 1,
      createdAt: "2099-01-14T00:00:00Z",
      evidence: [transactionRef(4, 999_999)],
      legs: cash("account:account_1"),
    });
    return world;
  }
  const ids = async (world: EventsWorld, filters: Partial<ActivityFilters>) =>
    (
      await paged(world.db, "cash-movement", { ...NONE, ...filters }, 200, ACTIVITY_FILTER_WALK)
    ).items.map((item) => `${item.eventId}@${item.revision}`);

  test("the recording window is inclusive at since and exclusive at before, in any offset", async () => {
    const world = store();
    expect(await ids(world, { since: "2099-01-11T00:00:00.000Z" })).toEqual([
      "ev-b@1",
      "ev-c@2",
      "ev-d@1",
    ]);
    expect(await ids(world, { before: "2099-01-14T00:00:00.000Z" })).toEqual([
      "ev-a@1",
      "ev-b@1",
      "ev-c@2",
    ]);
    expect(
      await ids(world, { since: "2099-01-11T00:00:00.000Z", before: "2099-01-13T00:00:00.000Z" }),
    ).toEqual(["ev-b@1"]);
    world.db.close();
  });

  test("an account matches a leg in either stored form", async () => {
    const world = store();
    expect(await ids(world, { account: "account_1" })).toEqual(["ev-a@1", "ev-b@1", "ev-d@1"]);
    expect(await ids(world, { account: "account_2" })).toEqual(["ev-c@2"]);
    expect(await ids(world, { account: "account_9" })).toEqual([]);
    world.db.close();
  });

  test("a source matches a reference read in a parse run of its capture, never a claim or a missing run", async () => {
    const world = store();
    expect(await ids(world, { source: "vpass" })).toEqual(["ev-a@1"]);
    expect(await ids(world, { source: "smbc-bank" })).toEqual(["ev-b@1", "ev-c@2"]);
    expect(await ids(world, { source: "myjcb" })).toEqual([]);
    world.db.close();
  });

  test("a page walks no further than its bound, and its cursor continues where the walk stopped", async () => {
    const world = store();
    const reader = createEventsReader(executor(world.db), { pageSize: 200, filterWalk: 2 });
    const filters = { ...NONE, account: "account_2" };
    const first = await reader.filteredActivity({ basis: "cash-movement", filters, after: null });
    // ev-a and ev-b walked, neither matches: an empty page that continues.
    expect(first.items).toEqual([]);
    expect(first.walked).toBe(2);
    expect(first.next).toEqual({ eventId: "ev-b", revision: 1 });
    const second = await reader.filteredActivity({
      basis: "cash-movement",
      filters,
      after: first.next,
    });
    expect(second.items.map((item) => item.eventId)).toEqual(["ev-c"]);
    expect(second.next).toEqual({ eventId: "ev-d", revision: 1 });
    const third = await reader.filteredActivity({
      basis: "cash-movement",
      filters,
      after: second.next,
    });
    expect(third).toMatchObject({ items: [], walked: 0, next: null });
    world.db.close();
  });
});

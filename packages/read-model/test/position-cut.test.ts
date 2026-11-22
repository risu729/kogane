// POSITION_CUT_SQL: whether positions read page by page from `positionsSql`
// are one cut of the current positions (INV06). The check is compared with an
// independent oracle on seeded random stores, where a republish, a newer
// capture or a new parse lands between two page reads, and its plan is checked
// on the migrated schema without table statistics. Every source, account,
// code and quantity is synthetic.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createObservationReader, type SqlExecutor } from "../src/index";
import { POSITION_CUT_SQL, positionsSql } from "../src/sql";
import { PAGE_LIMIT } from "../src/scope";
import { migrated } from "./card-usage-fixture";
import { DatedStore } from "./dated-state-fixture";
import { migratedDatabase } from "./price-candidates-fixture";

/** Positions one page answers; the extra row only says another page exists. */
const PAGE = PAGE_LIMIT - 1;
const SNAPSHOT = {
  source: "sbi-securities",
  dataset: "domestic-cash-positions",
  parser: "sbi-domestic-cash-positions",
} as const;
const GENERIC = { dataset: "positions", parser: "synthetic-positions" } as const;

beforeAll(() => {
  migrated().close();
  migratedDatabase().close();
}, 60_000);

function executor(db: Database): SqlExecutor {
  return {
    all: async <T>(text: string, args: readonly unknown[]) =>
      db.query(text).all(...(args as never[])) as T[],
    first: async <T>(text: string, args: readonly unknown[]) =>
      (db.query(text).get(...(args as never[])) as T | null) ?? null,
  };
}

/** mulberry32: a small seeded generator, so a failing seed replays. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Row {
  id: number;
  holding: string;
}
interface Cut {
  current_rows: number;
  read_current: number;
  prefix_rows: number;
}

/** Ids handed out by hand, far above the fixture's own sequence. */
let manual = 1_000_000;

/**
 * Re-parse `artifact` under a new parser version and publish it in place of
 * the artifact's current run, as a release re-parse does: the codes come back
 * under new observation ids.
 */
function reparse(db: Database, artifact: number, account: string, codes: readonly string[]): void {
  manual += 1;
  const parse = manual;
  const version = `9.0.${parse}`;
  db.run(
    "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,?,'2026-09-02','ok','[]')",
    [parse, artifact, GENERIC.parser, version],
  );
  db.run(
    `INSERT INTO published_parse_runs(fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind)
     VALUES(?,?,?,?,'2026-09-02','normal')
     ON CONFLICT(fetch_artifact_id,parser_name) DO UPDATE SET parse_run_id=excluded.parse_run_id,
       parser_version=excluded.parser_version,published_at=excluded.published_at`,
    [artifact, GENERIC.parser, parse, version],
  );
  fill(db, parse, account, codes);
}

/** Positions of `codes` under `account` in parse run `parse`, in one statement. */
function fill(db: Database, parse: number, account: string, codes: readonly string[]): void {
  db.run(
    `INSERT INTO position_observations(parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
     SELECT ?, ?, value, '1', 0, '$.positions[' || key || ']', '{}' FROM json_each(?)`,
    [parse, account, JSON.stringify(codes)],
  );
}

/** A published capture of a dataset without a snapshot policy, holding `codes`. */
function generic(
  store: DatedStore,
  source: string,
  account: string,
  codes: readonly string[],
): number {
  const capture = store.capture({ source, ...GENERIC, fetchedAt: "2026-09-01T00:00:00.000Z" });
  fill(store.db, capture.parse, account, codes);
  return capture.artifact;
}

function codes(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);
}

async function page(db: Database, offset: number): Promise<Row[]> {
  const reader = createObservationReader(executor(db));
  return (await reader.listPositions({ offset })).map((entry) => ({
    id: entry.position.id,
    holding: `${entry.position.source_id}|${entry.position.source_account}|${entry.position.security_code}`,
  }));
}

/**
 * Pages read the way the report job reads them, with `between(n)` run after
 * page `n`; stops after `pages` pages when given, else at the store's end.
 */
async function readPages(
  db: Database,
  between: (index: number) => void,
  pages = Number.POSITIVE_INFINITY,
): Promise<{ rows: Row[]; ended: boolean }> {
  const rows: Row[] = [];
  for (let index = 0; ; index += 1) {
    const answer = await page(db, index * PAGE);
    rows.push(...answer.slice(0, PAGE));
    const ended = answer.length <= PAGE;
    if (ended || index + 1 >= pages) return { rows, ended };
    between(index);
  }
}

function check(db: Database, ids: readonly number[]): Cut {
  return db.query(POSITION_CUT_SQL).get(JSON.stringify(ids)) as Cut;
}

function passes(cut: Cut, read: number, ended: boolean): boolean {
  return (
    cut.read_current === read && cut.prefix_rows === read && (!ended || cut.current_rows === read)
  );
}

/** One seeded store: a snapshot dataset and several re-parseable artifacts. */
function randomStore(random: () => number): {
  db: Database;
  mutations: (() => void)[];
} {
  const store = new DatedStore();
  const pick = (n: number) => Math.floor(random() * n);
  const snapshotAccounts = ["acct-m", "acct-q"].slice(0, 1 + pick(2));
  const snapshotPositions = (fresh: number) =>
    snapshotAccounts.flatMap((account) =>
      codes(`S${fresh}`, 20 + pick(100)).map((code) => ({ account, code, quantity: "1" })),
    );
  store.capture({
    ...SNAPSHOT,
    fetchedAt: "2026-09-01T00:00:00.000Z",
    claim: "complete",
    positions: snapshotPositions(0),
  });
  const artifacts: { artifact: number; account: string; codes: string[] }[] = [];
  for (const [index, source] of ["synthetic-a", "synthetic-c", "synthetic-z"].entries()) {
    const account = `acct-${index}`;
    const held = codes(`G${index}`, 60 + pick(400));
    artifacts.push({ artifact: generic(store, source, account, held), account, codes: held });
  }
  let fresh = 0;
  const mutations = [
    // A re-parse of one artifact with the same holdings, one more or one fewer.
    () => {
      const target = artifacts[pick(artifacts.length)]!;
      const change = pick(3);
      const next =
        change === 0
          ? target.codes
          : change === 1
            ? [`A-${pick(1000)}`, ...target.codes]
            : target.codes.slice(1);
      reparse(store.db, target.artifact, target.account, next);
      target.codes = next;
    },
    // A newer complete capture of the snapshot dataset replaces the older one.
    () => {
      fresh += 1;
      store.capture({
        ...SNAPSHOT,
        fetchedAt: `2026-09-${String(1 + fresh).padStart(2, "0")}T00:00:00.000Z`,
        claim: "complete",
        positions: snapshotPositions(pick(2) === 0 ? 0 : fresh),
      });
    },
    // A new artifact's parse is published: rows are only added.
    () => {
      fresh += 1;
      generic(
        store,
        pick(2) === 0 ? "synthetic-b" : "synthetic-y",
        `acct-new-${fresh}`,
        codes(`N${fresh}`, 1 + pick(30)),
      );
    },
    // Nothing moves.
    () => {},
  ];
  return { db: store.db, mutations };
}

describe("POSITION_CUT_SQL", () => {
  test("a snapshot republished between two page reads fails the check", async () => {
    const store = new DatedStore();
    const artifact = generic(store, "synthetic-a", "acct-a", codes("SYN", 600));
    const { rows, ended } = await readPages(store.db, () =>
      reparse(store.db, artifact, "acct-a", ["AAA-0000", ...codes("SYN", 600)]),
    );
    expect(ended).toBe(true);
    // The second page starts one row earlier, on the new run's copy of the
    // first page's last holding: 601 ids, 600 holdings.
    expect(rows.length).toBe(601);
    expect(new Set(rows.map((row) => row.holding)).size).toBe(600);
    const cut = check(
      store.db,
      rows.map((row) => row.id),
    );
    expect(passes(cut, rows.length, ended)).toBe(false);
    // Read again with nothing moving, the same store is one cut.
    const again = await readPages(store.db, () => {});
    expect(
      passes(
        check(
          store.db,
          again.rows.map((row) => row.id),
        ),
        again.rows.length,
        again.ended,
      ),
    ).toBe(true);
    expect(again.rows.length).toBe(601);
  }, 60_000);

  test("an empty store is one cut", () => {
    const store = new DatedStore();
    expect(check(store.db, [])).toEqual({ current_rows: 0, read_current: 0, prefix_rows: 0 });
  });

  test("on random stores the check passes exactly when the ids read are a prefix of the final cut", async () => {
    // Outcomes per mutation kind: [passed, failed].
    const outcomes: [number, number][] = [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = generator(seed);
      const { db, mutations } = randomStore(random);
      const kind = Math.floor(random() * mutations.length);
      const mutation = mutations[kind]!;
      const at = Math.floor(random() * 2);
      const pages = random() < 0.3 ? 1 + Math.floor(random() * 2) : Number.POSITIVE_INFINITY;
      const { rows, ended } = await readPages(
        db,
        (index) => {
          if (index === at) mutation();
        },
        pages,
      );
      const seen = [...new Set(rows.map((row) => row.id))];
      const cut = check(db, seen);
      // The oracle: the final cut read with nothing moving, in page order.
      const final = (await readPages(db, () => {})).rows;
      const prefix = new Set(final.slice(0, seen.length).map((row) => row.id));
      const oracle = seen.every((id) => prefix.has(id)) && (!ended || final.length === seen.length);
      expect(passes(cut, seen.length, ended), `seed ${seed}`).toBe(oracle);
      expect(cut.current_rows, `seed ${seed}`).toBe(final.length);
      if (oracle) {
        const holdings = [...new Map(rows.map((row) => [row.id, row.holding])).values()];
        expect(new Set(holdings).size, `seed ${seed}`).toBe(holdings.length);
        outcomes[kind]![0] += 1;
      } else outcomes[kind]![1] += 1;
    }
    // A re-parse and a newer capture each moved a cut under some seed; a
    // read with nothing moving is always one cut.
    expect(outcomes[0]![1]).toBeGreaterThan(0);
    expect(outcomes[1]![1]).toBeGreaterThan(0);
    expect(outcomes[3]![1]).toBe(0);
    expect(outcomes.reduce((sum, [ok]) => sum + ok, 0)).toBeGreaterThan(0);
  }, 120_000);

  test("the plan adds no whole-store pass to the positions read without statistics", () => {
    // The complete CORE schema, never analyzed.
    const db = migratedDatabase();
    const plan = (text: string, args: unknown[]): string[] =>
      (db.query(`EXPLAIN QUERY PLAN ${text}`).all(...(args as never[])) as { detail: string }[])
        // Subquery numbers differ between two texts; the plan shape does not.
        .map((row) => row.detail.replace(/subquery-\d+/gu, "subquery"));
    const scans = (lines: string[]) => lines.filter((line) => line.startsWith("SCAN"));
    const paged = positionsSql({}, 0);
    const read = plan(paged.sql, [...paged.args]);
    const cut = plan(POSITION_CUT_SQL, ["[1,2]"]);
    // Every scan of the check is one the page read already makes, or the JSON
    // argument; the bound row is reached by key, through its visible artifact.
    const extra = scans(cut).filter((line) => !scans(read).includes(line));
    expect(extra.length).toBeGreaterThan(0);
    expect(
      extra.every((line) => line.startsWith("SCAN json_each")),
      extra.join("\n"),
    ).toBe(true);
    for (const alias of ["bound", "bound_p"])
      expect(cut).toContain(`SEARCH ${alias} USING INTEGER PRIMARY KEY (rowid=?)`);
    // The two id lists and the bound are each evaluated once, never per row.
    expect(cut.filter((line) => /^(LIST|SCALAR) SUBQUERY/u.test(line))).toEqual([
      "LIST SUBQUERY 1",
      "SCALAR SUBQUERY 3",
      "LIST SUBQUERY 2",
    ]);
  });
});

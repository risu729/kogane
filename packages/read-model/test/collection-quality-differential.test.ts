// The collection quality cell page and the account coverage read (ADR 0088)
// against the cell page as it shipped before ADR 0088 split its CTEs out
// (collection-quality-cells-legacy-sql.ts), row for row, on small random
// stores. Each seed draws its states at random: tied and ordered capture
// times, failed and partial runs, failed and human-required units, units and
// months with no file, parses published, pending, failed, superseded or never
// queued, complete and partial coverage claims, and identity runs that are
// sealed or not, under one or two policies, over mappings that a later
// revision corrects. `drawn` records the states the seeds drew; the last test
// checks that the seeds together drew each of them. The scaled store's
// differential is in collection-quality.test.ts. Every value is synthetic.
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import {
  ACCOUNT_COVERAGE_CELL_BOUND,
  ACCOUNT_COVERAGE_SQL,
  type AccountCoverageRow,
  CELL_QUALITY_SQL,
  type CellQualityRow,
} from "../src/collection-quality";
import { fullCoreSchema } from "./card-usage-scale-fixture";
import {
  LEGACY_CELL_QUALITY_SQL,
  LEGACY_CELL_QUALITY_SQL_SHA256,
} from "./collection-quality-cells-legacy-sql";
import { type ArtifactSpec, type ParseSpec, QualityStore } from "./collection-quality-fixture";

beforeAll(() => {
  fullCoreSchema().close();
}, 60_000);

const SEED_COUNT = Number(process.env["KOGANE_RANDOM_SEEDS"] ?? 24);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => 7_001 + index * 7_919);
const PRODUCER = "collector-r2-importer";

/** Mulberry32: a small deterministic generator, so a failing seed replays. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Every state a seed may draw; the last test checks that the seeds drew each. */
const drawn = new Set<string>();

type Kind = "transaction" | "balance";
interface Shape {
  source: string;
  parser: string;
  kind: Kind;
  units?: readonly string[];
  /** The artifacts of one capture, for the units it includes. */
  artifacts(units: readonly string[]): ArtifactSpec[];
  claim?: true;
  /** Vpass seals a policy from 2 on only with card bindings (CORE 0020), so its runs stay at 1. */
  onePolicy?: true;
}

const SHAPES: readonly Shape[] = [
  {
    source: "global-pass",
    parser: "global-pass-activity",
    kind: "transaction",
    artifacts: () =>
      ["2099-03", "2099-02", "2099-01"].map((month) => ({
        key: `activity-${month}.html`,
        dataset: "globalpass-activity",
      })),
  },
  {
    source: "vpass",
    parser: "vpass-statement-page",
    kind: "transaction",
    units: ["card-a", "card-b"],
    onePolicy: true,
    artifacts: (units) =>
      units.flatMap((unit) =>
        ["209901", "209902"].map((month) => ({
          key: `months/${month}/top-00${unit === "card-a" ? 1 : 2}.json`,
          dataset: "statement-page",
          unit,
        })),
      ),
  },
  {
    source: "st-george",
    parser: "st-george-balances",
    kind: "balance",
    claim: true,
    artifacts: () => [{ key: "account-snapshot.json", dataset: "account-snapshot" }],
  },
  {
    source: "sony-bank",
    parser: "sony-bank-history-json",
    kind: "transaction",
    artifacts: () => [
      { key: "yen-history-page-0001.json", dataset: "yen-history-page-0001" },
      { key: "yen-history-page-0002.json", dataset: "yen-history-page-0002" },
    ],
  },
];

/** A random store over every shape, with the identity layer written as the sweep writes it. */
class RandomQualityStore {
  readonly store = new QualityStore();
  private readonly random: () => number;
  private observation = 900_000;
  private identityRun = 0;
  private readonly refs = new Map<string, number>();
  private readonly accounts = new Set<string>();

  constructor(seed: number) {
    this.random = generator(seed);
    for (const shape of SHAPES) this.fill(shape);
  }

  private pick<T>(values: readonly T[]): T {
    return values[Math.floor(this.random() * values.length)]!;
  }

  private chance(probability: number): boolean {
    return this.random() < probability;
  }

  /** A new mapping revision of `ref` (the first creates the source account); returns its id. */
  private map(source: string, ref: string): string {
    const db = this.store.db;
    const revision = (this.refs.get(ref) ?? 0) + 1;
    if (revision === 1)
      db.run("INSERT INTO source_accounts VALUES(?,?,?,?)", [
        ref,
        source,
        PRODUCER,
        JSON.stringify([ref]),
      ]);
    else drawn.add("mapping-corrected");
    const account = this.pick([
      "synthetic-account-a",
      "synthetic-account-b",
      "synthetic-account-c",
    ]);
    const status = this.pick(["identified", "provider-local", "aggregate", "unresolved"] as const);
    if (!this.accounts.has(account)) {
      this.accounts.add(account);
      db.run("INSERT INTO accounts VALUES(?,?,'synthetic-role',?)", [
        account,
        `Synthetic ${account}`,
        status,
      ]);
    }
    db.run("INSERT INTO account_mappings VALUES(?,?,?,?,?,'synthetic_reason',1,'2099-01-01',?,?)", [
      `${ref}-r${revision}`,
      ref,
      revision,
      account,
      revision === 1 ? "rule" : "manual",
      `Synthetic ${account}`,
      status,
    ]);
    this.refs.set(ref, revision);
    return `${ref}-r${revision}`;
  }

  /** Observations of a published parse, and zero to two identity runs naming them. */
  private identify({ source, kind, onePolicy }: Shape, parse: number): void {
    const db = this.store.db;
    const count = Math.floor(this.random() * 3);
    if (count === 0) drawn.add("published-without-observations");
    const rows: { id: number; ref: string }[] = [];
    for (let index = 0; index < count; index += 1) {
      this.observation += 1;
      const ref = `synthetic-${source}-ref-${String(Math.floor(this.random() * 3))}`;
      if (kind === "transaction")
        db.run(
          "INSERT INTO transaction_observations(id,parse_run_id,source_account,raw_locator,extra_json) VALUES(?,?,?,'$[0]','{}')",
          [this.observation, parse, ref],
        );
      else
        db.run(
          "INSERT INTO balance_observations(id,parse_run_id,source_account,metric,instrument,raw_locator,extra_json) VALUES(?,?,?,'synthetic-metric','JPY','$[0]','{}')",
          [this.observation, parse, ref],
        );
      rows.push({ id: this.observation, ref });
    }
    const policies = this.pick(onePolicy ? [0, 1, 1] : [0, 1, 1, 2]);
    if (policies === 0) drawn.add("identity-not-recorded");
    for (let policy = 1; policy <= policies; policy += 1) {
      this.identityRun += 1;
      const run = `synthetic-identity-${String(this.identityRun)}`;
      db.run("INSERT INTO identity_runs VALUES(?,?,?,'2099-01-01')", [run, parse, policy]);
      for (const { id, ref } of rows) {
        const mapping =
          this.refs.has(ref) && !this.chance(0.2)
            ? `${ref}-r${String(this.refs.get(ref))}`
            : this.map(source, ref);
        db.run("INSERT INTO identity_observations VALUES(?,?,?,?,?,?,'[]')", [
          `${run}-${String(id)}`,
          run,
          kind,
          id,
          ref,
          mapping,
        ]);
      }
      if (this.chance(0.8)) {
        db.run("INSERT INTO identity_run_seals VALUES(?,?,'2099-01-01')", [run, rows.length]);
        drawn.add(policy === 2 ? "newer-policy-sealed" : "identity-sealed");
      } else drawn.add("identity-unsealed");
    }
  }

  private fill(shape: Shape): void {
    const captures = 1 + Math.floor(this.random() * 4);
    let day = 0;
    for (let capture = 0; capture < captures; capture += 1) {
      // A tied capture time now and then: the cell read breaks ties by run id.
      if (capture === 0 || !this.chance(0.2)) day += 1;
      else drawn.add("tied-capture");
      const units = (shape.units ?? []).filter(() => this.chance(0.8));
      const unitOutcomes = Object.fromEntries(
        units.map((unit) => {
          const outcome = this.pick(["success", "success", "failed", "human_required"] as const);
          if (outcome !== "success") drawn.add(`unit-${outcome}`);
          return [
            unit,
            outcome === "success"
              ? { outcome }
              : { outcome, code: outcome === "failed" ? "provider_error" : "human_required" },
          ];
        }),
      );
      const all = shape.artifacts(units);
      const artifacts = all.filter(() => this.chance(0.85));
      if (artifacts.length < all.length) drawn.add("capture-without-some-file");
      const outcome = this.pick(["success", "success", "partial", "failed"] as const);
      const run = this.store.run({
        source: shape.source,
        at: new Date(Date.UTC(2099, 0, day)).toISOString(),
        outcome,
        ...(shape.units === undefined ? {} : { units: unitOutcomes }),
        artifacts,
      });
      for (const artifact of run.artifacts) {
        const state = this.pick([
          "published",
          "published",
          "published",
          "pending",
          "failed",
          "superseded",
          "none",
        ] as const);
        drawn.add(`parse-${state}`);
        if (state === "none") continue;
        const spec: ParseSpec =
          state === "published"
            ? shape.claim === undefined
              ? { kind: "published" }
              : {
                  kind: "published",
                  claim: this.chance(0.7)
                    ? { completeness: "complete" }
                    : { completeness: "partial", cause: "page_missing" },
                }
            : state === "failed"
              ? { kind: "failed", code: "parser_rejected" }
              : { kind: state };
        const parse = this.store.parse(artifact, shape.parser, spec);
        if (state === "published" && parse !== null) this.identify(shape, parse);
      }
    }
  }
}

/** Every page of the frozen cell read, concatenated. */
function legacyCells(store: QualityStore, source: string): CellQualityRow[] {
  const rows: CellQualityRow[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = store.all<CellQualityRow>(LEGACY_CELL_QUALITY_SQL, [source, offset]);
    rows.push(...page.slice(0, 500));
    if (page.length <= 500) return rows;
  }
}

/** The account read's rows without the column it adds. */
function cellsOf(rows: readonly AccountCoverageRow[]): CellQualityRow[] {
  return rows.map(({ accounts_json: _accounts, ...cell }) => cell);
}

test("the frozen text is the shipped cell page, byte for byte", () => {
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  expect(hash(LEGACY_CELL_QUALITY_SQL)).toBe(LEGACY_CELL_QUALITY_SQL_SHA256);
  expect(hash(CELL_QUALITY_SQL)).toBe(LEGACY_CELL_QUALITY_SQL_SHA256);
});

describe("the cell page and the account read equal the shipped cell page on random stores", () => {
  for (const seed of SEEDS)
    test(`seed ${String(seed)}`, () => {
      const world = new RandomQualityStore(seed);
      try {
        for (const { source } of SHAPES) {
          const legacy = legacyCells(world.store, source);
          expect(legacy.length).toBeLessThan(ACCOUNT_COVERAGE_CELL_BOUND);
          for (let offset = 0; offset <= legacy.length; offset += 500)
            expect(world.store.all<CellQualityRow>(CELL_QUALITY_SQL, [source, offset])).toEqual(
              world.store.all<CellQualityRow>(LEGACY_CELL_QUALITY_SQL, [source, offset]),
            );
          const accounts = world.store.all<AccountCoverageRow>(ACCOUNT_COVERAGE_SQL, [source]);
          expect(cellsOf(accounts)).toEqual(legacy);
          for (const row of accounts) {
            const named = JSON.parse(row.accounts_json) as [
              string,
              string,
              string,
              string,
              string,
              number,
            ][];
            for (const [capture, , , , kind, observations] of named) {
              expect(["newest", "current"]).toContain(capture);
              expect(["transaction", "balance"]).toContain(kind);
              expect(observations).toBeGreaterThan(0);
            }
            if (named.length > 0) drawn.add("cell-names-account");
            else drawn.add("cell-names-no-account");
            if (row.current_run_id !== null && row.current_run_id !== row.newest_run_id)
              drawn.add("older-current");
            if (row.current_run_id === null) drawn.add("no-current");
          }
        }
      } finally {
        world.store.db.close();
      }
    }, 60_000);

  test.if(SEED_COUNT >= 8)("the seeds drew every state the reads handle", () => {
    expect([...drawn].sort()).toEqual(
      [
        "capture-without-some-file",
        "cell-names-account",
        "cell-names-no-account",
        "identity-not-recorded",
        "identity-sealed",
        "identity-unsealed",
        "mapping-corrected",
        "newer-policy-sealed",
        "no-current",
        "older-current",
        "parse-failed",
        "parse-none",
        "parse-pending",
        "parse-published",
        "parse-superseded",
        "published-without-observations",
        "tied-capture",
        "unit-failed",
        "unit-human_required",
      ].sort(),
    );
  });
});

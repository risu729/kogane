// The account coverage read (ADR 0088): one source's collection quality
// cells regrouped by the accounts their captures' observations name, on
// synthetic complete-CORE stores. Every unit key, account id, label, time and
// period is invented; no amount, merchant or provider text is written.
import { beforeAll, describe, expect, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { QualityStore } from "../../read-model/test/collection-quality-fixture.ts";
import { fullCoreSchema } from "../../read-model/test/card-usage-scale-fixture.ts";
import {
  ACCOUNT_COVERAGE_CELL_BOUND as SQL_CELL_BOUND,
  SOURCE_JOBS_SQL,
} from "../../read-model/src/collection-quality.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { PROVIDER_DATA_TYPE_CATALOGUE } from "../src/collection/provider-data-types.ts";
import {
  CollectionQualityLimitError,
  queryAccountCoverage,
  queryCollectionQualityCells,
  queryCollectionQualitySummary,
} from "../src/query/collection-quality.ts";
import {
  ACCOUNT_COVERAGE_CELL_BOUND,
  ACCOUNT_COVERAGE_ENTRY_BOUND,
  validAccountCoverage,
  validCollectionQualityResponse,
  type AccountCoverage,
  type MappingStatus,
} from "../../observation-shared/src/collection-quality-contract.ts";

beforeAll(() => fullCoreSchema().close(), 60_000);

const PRODUCER = "collector-r2-importer";

function executor(store: QualityStore): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(sql: string, args: readonly unknown[]) =>
      (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}

/** Writes the identity layer the way the identity sweep does: append-only, sealed per parse. */
class Identities {
  private observation = 900_000;
  private run = 0;
  private readonly revisions = new Map<string, number>();
  private readonly accounts = new Set<string>();
  private readonly observed = new Map<number, { id: number; kind: "transaction" | "balance" }[]>();

  constructor(
    private readonly store: QualityStore,
    private readonly source: string,
  ) {}

  /** A new mapping revision of source reference `ref` to `account` (corrections are new rows). */
  map(ref: string, account: string, status: MappingStatus): void {
    const db = this.store.db;
    const revision = (this.revisions.get(ref) ?? 0) + 1;
    if (revision === 1)
      db.run("INSERT INTO source_accounts VALUES(?,?,?,?)", [
        ref,
        this.source,
        PRODUCER,
        JSON.stringify([ref]),
      ]);
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
    this.revisions.set(ref, revision);
  }

  /**
   * Observations of `parse` for each reference, then one identity run naming
   * them under policy `policy` (default 1), sealed unless `sealed` is false.
   * A later call for the same parse re-identifies the observations written
   * first, in order, as a newer policy's sweep does.
   */
  identify(
    parse: number,
    rows: { ref: string; kind: "transaction" | "balance" }[],
    { policy = 1, sealed = true }: { policy?: number; sealed?: boolean } = {},
  ): void {
    const db = this.store.db;
    const written = this.observed.get(parse);
    const ids =
      written?.map((observation, index) => ({ ...observation, ref: rows[index]!.ref })) ??
      rows.map(({ ref, kind }) => {
        this.observation += 1;
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
        return { id: this.observation, ref, kind };
      });
    if (written === undefined) this.observed.set(parse, ids);
    else expect(rows.length).toBe(written.length);
    this.run += 1;
    const run = `synthetic-identity-${this.source}-${this.run}`;
    db.run("INSERT INTO identity_runs VALUES(?,?,?,'2099-01-01')", [run, parse, policy]);
    for (const { id, ref, kind } of ids)
      db.run("INSERT INTO identity_observations VALUES(?,?,?,?,?,?,'[]')", [
        `${run}-${id}`,
        run,
        kind,
        id,
        ref,
        `${ref}-r1`,
      ]);
    if (sealed)
      db.run("INSERT INTO identity_run_seals VALUES(?,?,'2099-01-01')", [run, ids.length]);
  }
}

/** The instant ages are counted to (collection-freshness-v1); 2099-02-05 in Asia/Tokyo. */
const AS_OF = "2099-02-05T03:00:00.000Z";

/** The answer, checked against the wire contract and the route's path check. */
async function read(
  store: QualityStore,
  sourceId: string,
  asOf: string = AS_OF,
): Promise<AccountCoverage> {
  const answer = await queryAccountCoverage(executor(store), { sourceId, asOf });
  expect(answer).not.toBeNull();
  expect(validAccountCoverage(answer)).toBe(true);
  expect(
    validCollectionQualityResponse(`/api/collection-quality/${sourceId}/accounts`, answer),
  ).toBe(true);
  expect(validCollectionQualityResponse(`/api/collection-quality/other/accounts`, answer)).toBe(
    false,
  );
  return answer!;
}

/** Every cell of the paged cell read, as the account read must cover it. */
async function pagedCells(store: QualityStore, sourceId: string) {
  // The account read's own instant, so the two views' ages can be compared.
  const page = await queryCollectionQualityCells(executor(store), {
    sourceId,
    offset: 0,
    asOf: AS_OF,
  });
  expect(page!.coverage.truncated).toBe(false);
  return page!.cells;
}

/** Each cell of the cell page appears in the account read, with the same state and reasons. */
async function expectSameCells(store: QualityStore, sourceId: string, answer: AccountCoverage) {
  const cells = await pagedCells(store, sourceId);
  expect(answer.cells).toBe(cells.length);
  const key = (value: {
    dataset: string | null;
    parser: string | null;
    unitKey: string | null;
    period: unknown;
    currentRule: string;
  }) =>
    JSON.stringify([value.dataset, value.parser, value.unitKey, value.period, value.currentRule]);
  const seen = new Map<string, { state: string; reasons: readonly string[] }>();
  for (const account of answer.accounts)
    for (const type of account.dataTypes)
      for (const period of type.periods) {
        seen.set(key({ ...type, ...period }), {
          state: period.cellState,
          reasons: period.reasons,
        });
        // Parity applies wherever both views name the same capture.
        const cell = cells.find((value) => key(value) === key({ ...type, ...period }))!;
        if (
          cell.current?.fetchRunId === period.capture.fetchRunId &&
          cell.current.capturedAt === period.capture.capturedAt
        )
          expect(period.freshness).toEqual(cell.freshness);
      }
  for (const value of answer.unattributed) {
    expect(seen.has(key(value))).toBe(false);
    seen.set(key(value), { state: value.state, reasons: value.reasons });
  }
  expect(seen.size).toBe(cells.length);
  for (const value of cells)
    expect(seen.get(key(value))).toEqual({ state: value.state, reasons: value.reasons });
}

const named = (accounts: number) =>
  JSON.stringify(
    Array.from({ length: accounts }, (_, index) => [
      "current",
      `synthetic-account-${String(index)}`,
      `Synthetic ${String(index)}`,
      "identified",
      "transaction",
      1,
    ]),
  );
const syntheticAccountRows = (accounts: number) =>
  Array.from({ length: ACCOUNT_COVERAGE_CELL_BOUND }, (_, index) => ({
    dataset: "synthetic-dataset",
    parser_name: "synthetic-parser",
    fetch_unit_key: `synthetic-unit-${String(index)}`,
    period_kind: "latest",
    period: null,
    period_state: null,
    current_rule: "published-eligible",
    newest_run_id: 1,
    newest_captured_at: "2099-01-01T00:00:00.000Z",
    newest_run_succeeded: 1,
    latest_producer_run_id: 1,
    artifacts: 1,
    observations: accounts,
    unresolved_identities: 0,
    identity_missing: 0,
    unit_outcome_unknown: 0,
    raw_stored: 1,
    not_queued: 0,
    not_eligible: 0,
    published: 1,
    pending: 0,
    failed: 0,
    unpublished: 0,
    failure_codes_json: "[]",
    unit_failed: 0,
    unit_failure_code: null,
    incomplete_coverage: 0,
    coverage_causes_json: "[]",
    unreported_coverage: 0,
    current_run_id: 1,
    current_captured_at: "2099-01-01T00:00:00.000Z",
    accounts_json: named(accounts),
  }));

describe("account coverage", () => {
  test("a group's newest capture keeps its own wait, across types and within one Tokyo date", async () => {
    const older = {
      ...syntheticAccountRows(1)[0]!,
      unit_failed: 1,
      unit_failure_code: "human_required_reauth",
    };
    const newer = {
      ...syntheticAccountRows(1)[0]!,
      newest_run_id: 2,
      current_run_id: 2,
      newest_captured_at: "2099-01-01T01:00:00.000Z",
      current_captured_at: "2099-01-01T01:00:00.000Z",
    };
    for (const otherType of [false, true]) {
      const rows = [older, { ...newer, dataset: otherType ? "another-dataset" : newer.dataset }];
      const answer = await queryAccountCoverage(
        {
          all: async <T>(sql: string) => (sql === SOURCE_JOBS_SQL ? [] : rows) as T[],
          first: async <T>() =>
            ({ source_id: "paypay", fetch_run_id: 2, succeeded: 1, completed_at: null }) as T,
        },
        { sourceId: "paypay", asOf: "2099-01-07T00:00:00.000Z" },
      );
      expect(validAccountCoverage(answer)).toBe(true);
      expect(answer!.dataTypes).toBeNull();
      expect(answer!.accounts[0]!.dataTypes.every((type) => type.providerTypes.length === 0)).toBe(
        true,
      );
      expect(answer!.accounts[0]!.freshness).toEqual({ state: "stale", ageDays: 6 });
      expect(
        answer!.accounts[0]!.dataTypes.find((type) => type.dataset === newer.dataset)!.freshness,
      ).toEqual(
        otherType ? { state: "human-required", ageDays: 6 } : { state: "stale", ageDays: 6 },
      );
    }
  });
  test("provider types reverse every source catalogue and leave unknown parsers unclassified", async () => {
    // Exercise the actual reader's reverse lookup for every catalogue source
    // and parser, including parsers shared by multiple provider data types.
    for (const [sourceId, catalogue] of Object.entries(PROVIDER_DATA_TYPE_CATALOGUE)) {
      for (const parser of new Set([
        ...catalogue.flatMap((entry) => entry.parsers),
        "synthetic-unknown-parser",
      ])) {
        const one = { ...syntheticAccountRows(1)[0]!, parser_name: parser };
        const answer = await queryAccountCoverage(
          {
            all: async <T>(sql: string) => (sql === SOURCE_JOBS_SQL ? [] : [one]) as T[],
            first: async <T>() =>
              ({ source_id: sourceId, fetch_run_id: 1, succeeded: 1, completed_at: null }) as T,
          },
          { sourceId, asOf: AS_OF },
        );
        expect(validAccountCoverage(answer)).toBe(true);
        expect(answer!.dataTypesVersion).toBe("provider-data-types-v1");
        expect(answer!.dataTypes).toEqual([...catalogue]);
        expect(answer!.accounts[0]!.dataTypes[0]!.providerTypes).toEqual(
          catalogue.filter((entry) => entry.parsers.includes(parser)).map((entry) => entry.type),
        );
      }
    }
  });

  test("an unknown source is null; an empty source has no account and no cell", async () => {
    const store = new QualityStore();
    try {
      expect(
        await queryAccountCoverage(executor(store), { sourceId: "no-such-source", asOf: AS_OF }),
      ).toBe(null);
      const empty = await read(store, "vpass");
      expect(empty).toMatchObject({ cells: 0, accounts: [], unattributed: [] });
    } finally {
      store.db.close();
    }
  });

  test("card statement months per account: current, older-current behind a refused page, and a unit with no file", async () => {
    const store = new QualityStore();
    const ids = new Identities(store, "vpass");
    try {
      ids.map("synthetic-card-ref-a", "synthetic-account-a", "identified");
      ids.map("synthetic-card-ref-b", "synthetic-account-b", "unresolved");
      const cards = {
        "card-a": { outcome: "success" as const },
        "card-b": { outcome: "success" as const },
      };
      const page = (unit: string, month: string) => ({
        key: `months/${month}/top-00${unit === "card-a" ? 1 : 2}.json`,
        dataset: "statement-page",
        unit,
      });
      const first = store.run({
        source: "vpass",
        at: "2099-02-01T00:00:00Z",
        units: cards,
        artifacts: [page("card-a", "209901"), page("card-a", "209902"), page("card-b", "209901")],
      });
      const [a1, a2, b1] = first.artifacts.map((artifact) =>
        store.parse(artifact, "vpass-statement-page", { kind: "published" })!,
      );
      ids.identify(a1!, [
        { ref: "synthetic-card-ref-a", kind: "transaction" },
        { ref: "synthetic-card-ref-a", kind: "transaction" },
      ]);
      ids.identify(a2!, [{ ref: "synthetic-card-ref-a", kind: "transaction" }]);
      ids.identify(b1!, [{ ref: "synthetic-card-ref-b", kind: "transaction" }]);
      // A newer capture of card A's first month is refused: the older stays current.
      const second = store.run({
        source: "vpass",
        at: "2099-02-02T00:00:00Z",
        units: { "card-a": { outcome: "success" } },
        artifacts: [page("card-a", "209901")],
      });
      store.parse(second.artifacts[0]!, "vpass-statement-page", {
        kind: "failed",
        code: "parser_rejected",
      });
      // Card B's next attempt stored no file at all.
      store.run({
        source: "vpass",
        at: "2099-02-03T00:00:00Z",
        outcome: "partial",
        units: { "card-b": { outcome: "failed", code: "human_required" } },
        artifacts: [],
      });

      const answer = await read(store, "vpass");
      expect(answer.accounts.map((account) => [account.accountId, account.statuses])).toEqual([
        ["synthetic-account-a", ["identified"]],
        ["synthetic-account-b", ["unresolved"]],
      ]);
      const [a, b] = answer.accounts;
      expect(a!.label).toBe("Synthetic synthetic-account-a");
      expect(a!.dataTypes).toHaveLength(1);
      expect(a!.dataTypes[0]).toMatchObject({
        dataset: "statement-page",
        parser: "vpass-statement-page",
        kind: "transaction",
      });
      expect(
        a!.dataTypes[0]!.periods.map((entry) => [
          entry.period.value,
          entry.unitKey,
          entry.standing,
          entry.capture.fetchRunId,
          entry.observations,
        ]),
      ).toEqual([
        ["209902", "card-a", "current", first.run, 1],
        ["209901", "card-a", "older-current", first.run, 2],
      ]);
      const behind = a!.dataTypes[0]!.periods[1]!;
      expect(behind.reasons).toContain("newer_capture_not_current");
      expect(behind.reasons).toContain("parser_rejected");
      // The unresolved mapping is the account's status and the cell's reason, never hidden.
      expect(b!.dataTypes[0]!.periods).toHaveLength(1);
      expect(b!.dataTypes[0]!.periods[0]!.reasons).toContain("identity_unresolved");
      // The empty attempt names no account: it is listed apart, with its reasons,
      // and never attributed to card B's account through its unit key.
      expect(answer.unattributed).toHaveLength(1);
      expect(answer.unattributed[0]).toMatchObject({
        dataset: null,
        parser: null,
        unitKey: "card-b",
        state: "no-current",
      });
      expect(answer.unattributed[0]!.reasons).toEqual(
        expect.arrayContaining(["unit_without_artifacts", "user_action_required"]),
      );
      await expectSameCells(store, "vpass", answer);
    } finally {
      store.db.close();
    }
  });

  test("an account only the newest, not-current capture names is newest-not-current", async () => {
    const store = new QualityStore();
    const ids = new Identities(store, "st-george");
    try {
      ids.map("synthetic-ref-old", "synthetic-account-old", "provider-local");
      ids.map("synthetic-ref-new", "synthetic-account-new", "provider-local");
      const snapshot = [{ key: "account-snapshot.json", dataset: "account-snapshot" }];
      const first = store.run({
        source: "st-george",
        at: "2099-01-01T00:00:00Z",
        artifacts: snapshot,
      });
      const old = store.parse(first.artifacts[0]!, "st-george-balances", {
        kind: "published",
        version: "1.0.1",
        claim: { completeness: "complete" },
      })!;
      ids.identify(old, [{ ref: "synthetic-ref-old", kind: "balance" }]);
      const second = store.run({
        source: "st-george",
        at: "2099-01-02T00:00:00Z",
        artifacts: snapshot,
      });
      const partial = store.parse(second.artifacts[0]!, "st-george-balances", {
        kind: "published",
        version: "1.0.1",
        claim: { completeness: "partial", cause: "page_missing" },
      })!;
      ids.identify(partial, [
        { ref: "synthetic-ref-old", kind: "balance" },
        { ref: "synthetic-ref-new", kind: "balance" },
      ]);
      const answer = await read(store, "st-george");
      const standing = Object.fromEntries(
        answer.accounts.map((account) => [
          account.accountId,
          account.dataTypes.map((type) =>
            type.periods.map((entry) => [type.kind, entry.standing, entry.capture.fetchRunId]),
          ),
        ]),
      );
      expect(standing).toEqual({
        "synthetic-account-new": [[["balance", "newest-not-current", second.run]]],
        "synthetic-account-old": [[["balance", "older-current", first.run]]],
      });
      for (const account of answer.accounts)
        expect(account.dataTypes[0]!.periods[0]!.reasons).toContain("coverage_incomplete");
      expect(answer.unattributed).toEqual([]);
      await expectSameCells(store, "st-george", answer);
    } finally {
      store.db.close();
    }
  });

  test("a published capture with no observation, or none the identity layer recorded, names no account", async () => {
    const store = new QualityStore();
    try {
      const run = store.run({
        source: "sony-bank",
        at: "2099-01-01T00:00:00Z",
        artifacts: [
          { key: "yen-history-page-0001.json", dataset: "yen-history-page-0001" },
          { key: "yen-history-page-0002.json", dataset: "yen-history-page-0002" },
        ],
      });
      store.parse(run.artifacts[0]!, "sony-bank-history-json", { kind: "published" });
      const parse = store.parse(run.artifacts[1]!, "sony-bank-history-json", {
        kind: "published",
      })!;
      store.db.run(
        "INSERT INTO transaction_observations(id,parse_run_id,source_account,raw_locator,extra_json) VALUES(910001,?,'synthetic-unrecorded','$[0]','{}')",
        [parse],
      );
      const answer = await read(store, "sony-bank");
      expect(answer.accounts).toEqual([]);
      expect(
        answer.unattributed.map((value) => [
          value.dataset,
          value.reasons.filter((reason) =>
            ["published_without_observations", "identity_not_recorded"].includes(reason),
          ),
        ]),
      ).toEqual([
        // No identity run was written for the empty parse either; the cell says both.
        ["yen-history-page-0001", ["identity_not_recorded", "published_without_observations"]],
        ["yen-history-page-0002", ["identity_not_recorded"]],
      ]);
      await expectSameCells(store, "sony-bank", answer);
    } finally {
      store.db.close();
    }
  });

  test("a corrected mapping moves the periods to the new account; the earlier decision stays stored", async () => {
    const store = new QualityStore();
    const ids = new Identities(store, "global-pass");
    try {
      ids.map("synthetic-ref", "synthetic-account-first", "unresolved");
      const run = store.run({
        source: "global-pass",
        at: "2099-02-01T00:00:00Z",
        artifacts: [
          { key: "activity-2099-01.html", dataset: "globalpass-activity" },
          { key: "activity-2098-12.html", dataset: "globalpass-activity" },
        ],
      });
      for (const artifact of run.artifacts)
        ids.identify(store.parse(artifact, "global-pass-activity", { kind: "published" })!, [
          { ref: "synthetic-ref", kind: "transaction" },
        ]);
      const before = await read(store, "global-pass");
      expect(before.accounts.map((account) => account.accountId)).toEqual([
        "synthetic-account-first",
      ]);
      ids.map("synthetic-ref", "synthetic-account-reviewed", "identified");
      const after = await read(store, "global-pass");
      expect(after.accounts.map((account) => [account.accountId, account.statuses])).toEqual([
        ["synthetic-account-reviewed", ["identified"]],
      ]);
      expect(
        after.accounts[0]!.dataTypes[0]!.periods.map((entry) => [
          entry.period.kind,
          entry.period.value,
          entry.standing,
        ]),
      ).toEqual([
        ["activity-month", "2099-01", "current"],
        ["activity-month", "2098-12", "current"],
      ]);
      expect(store.all<{ n: number }>("SELECT count(*) AS n FROM account_mappings")[0]!.n).toBe(2);
      await expectSameCells(store, "global-pass", after);
    } finally {
      store.db.close();
    }
  });

  test("an account is one period per cell and kind: two source accounts, both captures and only the newest sealed policy count (INV06)", async () => {
    const store = new QualityStore();
    const ids = new Identities(store, "global-pass");
    try {
      // Two source references reviewed onto one account, with different statuses.
      ids.map("synthetic-ref-x", "synthetic-account-shared", "identified");
      ids.map("synthetic-ref-y", "synthetic-account-shared", "provider-local");
      ids.map("synthetic-ref-z", "synthetic-account-stale", "identified");
      const run = store.run({
        source: "global-pass",
        at: "2099-02-01T00:00:00Z",
        artifacts: [{ key: "activity-2099-01.html", dataset: "globalpass-activity" }],
      });
      const parse = store.parse(run.artifacts[0]!, "global-pass-activity", {
        kind: "published",
      })!;
      const as = (ref: string) => ({ ref, kind: "transaction" as const });
      // An older sealed policy named another account; a newer policy is not sealed yet.
      ids.identify(parse, [as("synthetic-ref-z"), as("synthetic-ref-z"), as("synthetic-ref-z")]);
      ids.identify(parse, [as("synthetic-ref-x"), as("synthetic-ref-x"), as("synthetic-ref-y")], {
        policy: 2,
      });
      ids.identify(parse, [as("synthetic-ref-z"), as("synthetic-ref-z"), as("synthetic-ref-z")], {
        policy: 3,
        sealed: false,
      });
      const answer = await read(store, "global-pass");
      // The capture is both the cell's newest and its current one: listed once.
      expect(answer.accounts.map((account) => [account.accountId, account.statuses])).toEqual([
        ["synthetic-account-shared", ["identified", "provider-local"]],
      ]);
      expect(answer.accounts[0]!.dataTypes).toHaveLength(1);
      expect(
        answer.accounts[0]!.dataTypes[0]!.periods.map((entry) => [
          entry.period.value,
          entry.standing,
          entry.capture.fetchRunId,
          entry.observations,
        ]),
      ).toEqual([["2099-01", "current", run.run, 3]]);
      expect(answer.unattributed).toEqual([]);
      await expectSameCells(store, "global-pass", answer);
    } finally {
      store.db.close();
    }
  });

  test("freshness per period, data type and account: the freshest period's age, explained by what the source waits on (collection-freshness-v1)", async () => {
    const store = new QualityStore();
    const ids = new Identities(store, "global-pass");
    try {
      ids.map("synthetic-ref-a", "synthetic-account-a", "identified");
      ids.map("synthetic-ref-b", "synthetic-account-b", "provider-local");
      const month = (value: string) => ({
        key: `activity-${value}.html`,
        dataset: "globalpass-activity",
      });
      const first = store.run({
        source: "global-pass",
        at: "2099-02-01T00:00:00Z",
        artifacts: [month("2099-01"), month("2098-12")],
      });
      for (const artifact of first.artifacts)
        ids.identify(store.parse(artifact, "global-pass-activity", { kind: "published" })!, [
          { ref: "synthetic-ref-a", kind: "transaction" },
        ]);
      const second = store.run({
        source: "global-pass",
        at: "2099-02-02T00:00:00Z",
        artifacts: [month("2099-01")],
      });
      ids.identify(
        store.parse(second.artifacts[0]!, "global-pass-activity", { kind: "published" })!,
        [
          { ref: "synthetic-ref-a", kind: "transaction" },
          { ref: "synthetic-ref-b", kind: "transaction" },
        ],
      );
      const view = (answer: AccountCoverage) =>
        answer.accounts.map((account) => ({
          account: [account.accountId, account.freshness],
          types: account.dataTypes.map((type) => ({
            type: type.freshness,
            periods: type.periods.map((entry) => [entry.period.value, entry.freshness]),
          })),
        }));
      // 2099-02-05T03:00Z is 12:00 on 2099-02-05 in Tokyo: the newer month is 3
      // days old, the older 4 (stale); a data type and an account read their
      // freshest period.
      const answer = await read(store, "global-pass");
      expect(answer.freshnessAsOf).toEqual({
        policy: "collection-freshness-v1",
        at: AS_OF,
        date: "2099-02-05",
      });
      expect(view(answer)).toEqual([
        {
          account: ["synthetic-account-a", { state: "recent", ageDays: 3 }],
          types: [
            {
              type: { state: "recent", ageDays: 3 },
              periods: [
                ["2099-01", { state: "recent", ageDays: 3 }],
                ["2098-12", { state: "stale", ageDays: 4 }],
              ],
            },
          ],
        },
        {
          account: ["synthetic-account-b", { state: "recent", ageDays: 3 }],
          types: [
            {
              type: { state: "recent", ageDays: 3 },
              periods: [["2099-01", { state: "recent", ageDays: 3 }]],
            },
          ],
        },
      ]);
      await expectSameCells(store, "global-pass", answer);
      // The Tokyo midnight, not the UTC one, starts a day.
      const sameDay = await read(store, "global-pass", "2099-02-02T14:59:59.999Z");
      expect(sameDay.accounts[1]!.freshness).toEqual({ state: "same-day", ageDays: 0 });
      expect(
        (await read(store, "global-pass", "2099-02-02T15:00:00.000Z")).accounts[1]!.freshness,
      ).toEqual({
        state: "recent",
        ageDays: 1,
      });
      // A person must act on the source's job: what is stale says so; what is fresh stays fresh.
      store.occurrence("prestia-globalpass", {
        nominalAt: "2099-02-03T18:17:00.000Z",
        status: "failed",
        failureCode: "human_required_reauth",
      });
      const waiting = await read(store, "global-pass");
      expect(view(waiting)[0]).toEqual({
        account: ["synthetic-account-a", { state: "recent", ageDays: 3 }],
        types: [
          {
            type: { state: "recent", ageDays: 3 },
            periods: [
              ["2099-01", { state: "recent", ageDays: 3 }],
              ["2098-12", { state: "human-required", ageDays: 4 }],
            ],
          },
        ],
      });
      const later = await read(store, "global-pass", "2099-02-10T03:00:00.000Z");
      expect(later.accounts.map((account) => account.freshness)).toEqual([
        { state: "human-required", ageDays: 8 },
        { state: "human-required", ageDays: 8 },
      ]);
      await expectSameCells(store, "global-pass", waiting);
      // Summary, cells and accounts apply the same wait to matching captures.
      const asOf = "2099-02-10T03:00:00.000Z";
      const parity = async (state: "human-required" | "disabled") => {
        const account = await read(store, "global-pass", asOf);
        const summary = await queryCollectionQualitySummary(executor(store), { asOf });
        const source = summary.sources.find((entry) => entry.sourceId === "global-pass")!;
        expect(account.accounts[0]!.freshness).toEqual(source.freshness);
        expect(source.freshness.state).toBe(state);
        const cells = await queryCollectionQualityCells(executor(store), {
          sourceId: "global-pass",
          offset: 0,
          asOf,
        });
        for (const group of account.accounts[0]!.dataTypes)
          for (const period of group.periods)
            expect(period.freshness).toEqual(
              cells!.cells.find((cell) => cell.period.value === period.period.value)!.freshness,
            );
      };
      await parity("human-required");
      store.db.run("UPDATE collection_schedules SET enabled = 0 WHERE id = 'prestia-globalpass'");
      await parity("human-required");
      store.occurrence("prestia-globalpass", {
        nominalAt: "2099-02-04T18:17:00.000Z",
        status: "completed",
      });
      await parity("disabled");
    } finally {
      store.db.close();
    }
  });

  test("an account only a newest, not-current capture names has its capture's age: nothing current names it", async () => {
    const store = new QualityStore();
    const ids = new Identities(store, "st-george");
    try {
      ids.map("synthetic-ref-old", "synthetic-account-old", "provider-local");
      ids.map("synthetic-ref-new", "synthetic-account-new", "provider-local");
      const snapshot = [{ key: "account-snapshot.json", dataset: "account-snapshot" }];
      const first = store.run({
        source: "st-george",
        at: "2099-02-03T00:00:00Z",
        artifacts: snapshot,
      });
      ids.identify(
        store.parse(first.artifacts[0]!, "st-george-balances", {
          kind: "published",
          claim: { completeness: "complete" },
        })!,
        [{ ref: "synthetic-ref-old", kind: "balance" }],
      );
      const second = store.run({
        source: "st-george",
        at: "2099-02-04T00:00:00Z",
        artifacts: snapshot,
      });
      ids.identify(
        store.parse(second.artifacts[0]!, "st-george-balances", {
          kind: "published",
          claim: { completeness: "partial", cause: "page_missing" },
        })!,
        [
          { ref: "synthetic-ref-old", kind: "balance" },
          { ref: "synthetic-ref-new", kind: "balance" },
        ],
      );
      const answer = await read(store, "st-george");
      const of = Object.fromEntries(
        answer.accounts.map((account) => [
          account.accountId,
          [
            account.freshness,
            account.dataTypes[0]!.freshness,
            account.dataTypes[0]!.periods[0]!.standing,
            account.dataTypes[0]!.periods[0]!.freshness,
          ],
        ]),
      );
      // The cell's current capture (two days old) names only the old account.
      expect(of).toEqual({
        "synthetic-account-new": [
          { state: "recent", ageDays: 1 },
          { state: "recent", ageDays: 1 },
          "newest-not-current",
          { state: "recent", ageDays: 1 },
        ],
        "synthetic-account-old": [
          { state: "recent", ageDays: 2 },
          { state: "recent", ageDays: 2 },
          "older-current",
          { state: "recent", ageDays: 2 },
        ],
      });
      await expectSameCells(store, "st-george", answer);
    } finally {
      store.db.close();
    }
  });

  test("the contract checks each age against its capture and its freshest period", async () => {
    const store = new QualityStore();
    const ids = new Identities(store, "global-pass");
    try {
      ids.map("synthetic-ref-a", "synthetic-account-a", "identified");
      const run = store.run({
        source: "global-pass",
        at: "2099-02-01T00:00:00Z",
        artifacts: [{ key: "activity-2099-01.html", dataset: "globalpass-activity" }],
      });
      ids.identify(store.parse(run.artifacts[0]!, "global-pass-activity", { kind: "published" })!, [
        { ref: "synthetic-ref-a", kind: "transaction" },
      ]);
      const answer = await read(store, "global-pass");
      const edit = (change: (copy: AccountCoverage) => void): AccountCoverage => {
        const copy = structuredClone(answer);
        change(copy);
        return copy;
      };
      const period = (copy: AccountCoverage) => copy.accounts[0]!.dataTypes[0]!.periods[0]!;
      for (const bad of [
        // Another date than the instant's, or no as-of at all.
        edit((copy) => (copy.freshnessAsOf.date = "2099-02-04")),
        edit((copy) => delete (copy as Partial<AccountCoverage>).freshnessAsOf),
        // An age the capture does not give, or one the policy does not allow.
        edit((copy) => (period(copy).freshness = { state: "stale", ageDays: 5 })),
        edit((copy) => (period(copy).freshness = { state: "recent", ageDays: 4 })),
        // Every named capture must have its age, regardless of standing.
        edit((copy) => (period(copy).freshness = { state: "no-capture", ageDays: null })),
        // A data type or an account whose age is not its freshest period's.
        edit(
          (copy) => (copy.accounts[0]!.dataTypes[0]!.freshness = { state: "stale", ageDays: 9 }),
        ),
        edit((copy) => (copy.accounts[0]!.freshness = { state: "no-capture", ageDays: null })),
      ])
        expect(validAccountCoverage(bad)).toBe(false);
      expect(validAccountCoverage(answer)).toBe(true);
    } finally {
      store.db.close();
    }
  });

  test("the read writes nothing", async () => {
    const store = new QualityStore();
    try {
      const changes = () => store.all<{ n: number }>("SELECT total_changes() AS n")[0]!.n;
      const before = changes();
      await read(store, "vpass");
      expect(changes()).toBe(before);
    } finally {
      store.db.close();
    }
  });

  test("more cells than the bound is refused whole, never cut", async () => {
    expect(SQL_CELL_BOUND).toBe(ACCOUNT_COVERAGE_CELL_BOUND);
    const row = {
      dataset: null,
      parser_name: null,
      fetch_unit_key: "synthetic-unit",
      period_kind: "latest",
      period: null,
      period_state: null,
      current_rule: "published-eligible",
      newest_run_id: 1,
      newest_captured_at: "2099-01-01T00:00:00.000Z",
      newest_run_succeeded: 1,
      latest_producer_run_id: 1,
      artifacts: 0,
      observations: 0,
      unresolved_identities: 0,
      identity_missing: 0,
      unit_outcome_unknown: 0,
      raw_stored: 0,
      not_queued: 0,
      not_eligible: 0,
      published: 0,
      pending: 0,
      failed: 0,
      unpublished: 0,
      failure_codes_json: "[]",
      unit_failed: 0,
      unit_failure_code: null,
      incomplete_coverage: 0,
      coverage_causes_json: "[]",
      unreported_coverage: 0,
      current_run_id: null,
      current_captured_at: null,
      accounts_json: "[]",
    };
    // The source's jobs (SOURCE_JOBS_SQL) are none; every other read is the cells.
    const bounded = (rows: number): SqlExecutor => ({
      all: async <T>(sql: string) =>
        (sql === SOURCE_JOBS_SQL ? [] : Array.from({ length: rows }, () => row)) as T[],
      first: async <T>() =>
        ({ source_id: "vpass", fetch_run_id: 1, succeeded: 1, completed_at: null }) as T,
    });
    const full = await queryAccountCoverage(bounded(ACCOUNT_COVERAGE_CELL_BOUND), {
      sourceId: "vpass",
      asOf: AS_OF,
    });
    expect(full!.unattributed).toHaveLength(ACCOUNT_COVERAGE_CELL_BOUND);
    expect(validAccountCoverage(full)).toBe(true);
    await expect(
      queryAccountCoverage(bounded(ACCOUNT_COVERAGE_CELL_BOUND + 1), {
        sourceId: "vpass",
        asOf: AS_OF,
      }),
    ).rejects.toBeInstanceOf(CollectionQualityLimitError);
  });

  test("more account periods than the bound is refused whole, never cut", async () => {
    const executorOf = (accounts: number): SqlExecutor => ({
      all: async <T>(sql: string) =>
        (sql === SOURCE_JOBS_SQL ? [] : syntheticAccountRows(accounts)) as T[],
      first: async <T>() =>
        ({ source_id: "vpass", fetch_run_id: 1, succeeded: 1, completed_at: null }) as T,
    });
    // 2,000 cells × 5 accounts is exactly the bound of 10,000 entries.
    const full = await queryAccountCoverage(executorOf(5), { sourceId: "vpass", asOf: AS_OF });
    expect(
      full!.accounts.reduce((sum, account) => sum + account.dataTypes[0]!.periods.length, 0),
    ).toBe(ACCOUNT_COVERAGE_ENTRY_BOUND);
    expect(validAccountCoverage(full)).toBe(true);
    await expect(
      queryAccountCoverage(executorOf(6), { sourceId: "vpass", asOf: AS_OF }),
    ).rejects.toBeInstanceOf(CollectionQualityLimitError);
  });
});

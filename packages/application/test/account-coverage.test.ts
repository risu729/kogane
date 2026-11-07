// The account coverage read (ADR 0082): one source's collection quality
// cells regrouped by the accounts their captures' observations name, on
// synthetic complete-CORE stores. Every unit key, account id, label, time and
// period is invented; no amount, merchant or provider text is written.
import { beforeAll, describe, expect, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { QualityStore } from "../../read-model/test/collection-quality-fixture.ts";
import { fullCoreSchema } from "../../read-model/test/card-usage-scale-fixture.ts";
import { ACCOUNT_COVERAGE_CELL_BOUND as SQL_CELL_BOUND } from "../../read-model/src/collection-quality.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import type { Grant } from "../src/grants.ts";
import {
  CollectionQualityLimitError,
  queryAccountCoverage,
  readAccountCoverageForGrant,
  queryCollectionQualityCells,
} from "../src/query/collection-quality.ts";
import {
  ACCOUNT_COVERAGE_CELL_BOUND,
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

  /** Observations of `parse` for each reference, then one sealed identity run naming them. */
  identify(parse: number, rows: { ref: string; kind: "transaction" | "balance" }[]): void {
    const db = this.store.db;
    const ids = rows.map(({ ref, kind }) => {
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
    this.run += 1;
    const run = `synthetic-identity-${this.source}-${this.run}`;
    db.run("INSERT INTO identity_runs VALUES(?,?,1,'2099-01-01')", [run, parse]);
    for (const { id, ref, kind } of ids)
      db.run("INSERT INTO identity_observations VALUES(?,?,?,?,?,?,'[]')", [
        `${run}-${id}`,
        run,
        kind,
        id,
        ref,
        `${ref}-r1`,
      ]);
    db.run("INSERT INTO identity_run_seals VALUES(?,?,'2099-01-01')", [run, ids.length]);
  }
}

/** The answer, checked against the wire contract and the route's path check. */
async function read(store: QualityStore, sourceId: string): Promise<AccountCoverage> {
  const answer = await queryAccountCoverage(executor(store), { sourceId });
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
  const page = await queryCollectionQualityCells(executor(store), { sourceId, offset: 0 });
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
      for (const period of type.periods)
        seen.set(key({ ...type, ...period }), {
          state: period.cellState,
          reasons: period.reasons,
        });
  for (const value of answer.unattributed) {
    expect(seen.has(key(value))).toBe(false);
    seen.set(key(value), { state: value.state, reasons: value.reasons });
  }
  expect(seen.size).toBe(cells.length);
  for (const value of cells)
    expect(seen.get(key(value))).toEqual({ state: value.state, reasons: value.reasons });
}

describe("account coverage", () => {
  test("an unknown source is null; an empty source has no account and no cell", async () => {
    const store = new QualityStore();
    try {
      expect(await queryAccountCoverage(executor(store), { sourceId: "no-such-source" })).toBe(
        null,
      );
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
    const bounded = (rows: number): SqlExecutor => ({
      all: async <T>() => Array.from({ length: rows }, () => row) as T[],
      first: async <T>() =>
        ({ source_id: "vpass", fetch_run_id: 1, succeeded: 1, completed_at: null }) as T,
    });
    const full = await queryAccountCoverage(bounded(ACCOUNT_COVERAGE_CELL_BOUND), {
      sourceId: "vpass",
    });
    expect(full!.unattributed).toHaveLength(ACCOUNT_COVERAGE_CELL_BOUND);
    expect(validAccountCoverage(full)).toBe(true);
    await expect(
      queryAccountCoverage(bounded(ACCOUNT_COVERAGE_CELL_BOUND + 1), { sourceId: "vpass" }),
    ).rejects.toBeInstanceOf(CollectionQualityLimitError);
    // Under a grant, the same bound is a typed refusal the route and the agent read share.
    const grant: Grant = {
      principal: "synthetic-agent",
      scopes: { sources: "*", accounts: "*" },
      capabilities: ["evidence.read"],
      budget: { maxRows: 100, maxProposalTargets: 3, maxExplainDepth: 3 },
    };
    const refused = await readAccountCoverageForGrant({
      grant,
      sql: bounded(ACCOUNT_COVERAGE_CELL_BOUND + 1),
      sourceId: "vpass",
    });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.code).toBe("budget_exceeded");
  });

  test("under a grant: capability, perimeter and source are refused before anything is read", async () => {
    let reads = 0;
    const counting: SqlExecutor = {
      all: async <T>() => {
        reads += 1;
        return [] as T[];
      },
      first: async <T>() => {
        reads += 1;
        return null as T | null;
      },
    };
    const whole: Grant = {
      principal: "synthetic-agent",
      scopes: { sources: "*", accounts: "*" },
      capabilities: ["evidence.read"],
      budget: { maxRows: 100, maxProposalTargets: 3, maxExplainDepth: 3 },
    };
    for (const [grant, sourceId, code, refs] of [
      [
        { ...whole, capabilities: ["summary.read", "records.read"] },
        "vpass",
        "unauthorized",
        ["capability:evidence.read"],
      ],
      [
        { ...whole, scopes: { sources: ["vpass"], accounts: "*" } },
        "vpass",
        "evidence_restricted",
        ["scope:source"],
      ],
      [
        { ...whole, scopes: { sources: "*", accounts: ["synthetic"] } },
        "vpass",
        "evidence_restricted",
        ["scope:account"],
      ],
      [whole, "Not_A_Source", "invalid_query", ["source"]],
      [whole, 7, "invalid_query", ["source"]],
    ] as const) {
      const outcome = await readAccountCoverageForGrant({
        grant: grant as Grant,
        sql: counting,
        sourceId,
      });
      expect(outcome).toMatchObject({ ok: false, error: { code, refs } });
    }
    expect(reads).toBe(0);
    // A well-formed source the store does not hold is read, then refused the same way.
    const unknown = await readAccountCoverageForGrant({
      grant: whole,
      sql: counting,
      sourceId: "no-such-source",
    });
    expect(unknown).toMatchObject({
      ok: false,
      error: { code: "invalid_query", refs: ["source"] },
    });
    expect(reads).toBe(1);
  });
});

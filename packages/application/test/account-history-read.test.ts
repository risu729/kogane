// One source account's correction history (src/query/account-history-read.ts,
// ADR 0077 amendment 2026-11-08) over the account candidate world: decisions
// go through the real change lifecycle, and the read returns every one of
// them, oldest first, while writing nothing. Every producer, connection key,
// account id and label here is synthetic; no provider value appears.
import { beforeAll, describe, expect, test } from "bun:test";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import {
  ACCOUNT_HISTORY_COUNT_SQL,
  ACCOUNT_HISTORY_SQL,
} from "../../read-model/src/account-history.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { validAccountHistoryRead } from "../../observation-shared/src/account-history-contract.ts";
import { approve } from "../src/command/approve.ts";
import { commit } from "../src/command/commit.ts";
import type { ChangeKind, ChangePayload, Principal } from "../src/command/contract.ts";
import { createPlan } from "../src/command/plan.ts";
import type { Grant } from "../src/grants.ts";
import { reviewAccountCandidates, type AccountCandidate } from "../src/query/account-candidates.ts";
import { readAccountHistoryForGrant } from "../src/query/account-history-read.ts";
import { KEY_A, MF_PRODUCER, type Store, world } from "./account-candidates-world.ts";
import { OPERATOR, planners, stubDatabase } from "./instrument-resolution-world.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

/** The reader authority a signed-in browser has (services/app `readerGrant`). */
const READER: Grant = {
  principal: "reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read", "evidence.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};
const DIRECT = "sa-direct-time";
const BANK_ONLY = "sbi-shinsei-bank";

let clock = 0;
async function decide(s: Store, principal: Principal, kind: ChangeKind, payload: ChangePayload) {
  clock += 1;
  const now = `2099-01-02T00:00:${String(clock).padStart(2, "0")}.000Z`;
  const store = sqliteCommandStore(s.db);
  const plan = await createPlan(
    kind,
    payload,
    { actor: principal, baseContextId: "account-history:test", now, ttlSeconds: 3600 },
    store,
  );
  if (!plan.ok) throw new Error(`plan refused: ${JSON.stringify(plan)}`);
  const approval = await approve(store, {
    planId: plan.plan.planId,
    planDigest: plan.plan.planDigest,
    actor: principal,
    scope: [],
    ttlSeconds: 3600,
    now,
  });
  if (!approval.ok) throw new Error(`approval refused: ${JSON.stringify(approval)}`);
  const committed = await commit(store, {
    operationId: `op-history-${String(clock)}`,
    principal,
    planId: plan.plan.planId,
    approvalId: approval.approval.approvalId,
    planners: planners(s.db),
    now,
  });
  if (!committed.ok) throw new Error(`commit refused: ${JSON.stringify(committed)}`);
}

async function history(s: Store, sourceAccountId: unknown = DIRECT, grant: Grant = READER) {
  return readAccountHistoryForGrant({ grant, sql: s.sql, sourceAccountId });
}

beforeAll(() => {
  stubDatabase().close();
  migratedDatabase().close();
}, 60_000);

describe("the correction history of one source account", () => {
  test("lists the rule mapping, an acceptance, its withdrawal, a kept-apart pair and a manual correction, oldest first, and writes nothing", async () => {
    const s = world();
    // Before any decision: only the rule mapping.
    const initial = await history(s);
    expect(initial).toMatchObject({
      ok: true,
      history: {
        schemaVersion: "kogane-account-history-v1",
        sourceAccountId: DIRECT,
        total: 1,
        entries: [
          {
            entry: "mapping",
            revision: 1,
            method: "rule",
            decisionOrigin: "automatic",
            accountId: `account-${DIRECT}`,
            relationKind: null,
          },
        ],
      },
    });
    const page = await reviewAccountCandidates({
      grant: READER,
      sql: s.sql,
      request: { view: "open", offset: 0, sourceAccountId: null },
    });
    if (!page.ok) throw new Error("candidate read refused");
    const candidate = (page.review.items as AccountCandidate[]).find(
      (item) => item.directSourceAccountId === DIRECT,
    )!;
    await decide(s, OPERATOR, "relation.accept", {
      ...candidate.commands.accept!.payload,
      reason: "synthetic acceptance",
    });
    await decide(s, OPERATOR, "relation.reject", {
      ...candidate.commands.reject!.payload,
      reason: "synthetic withdrawal",
    });
    await decide(s, OPERATOR, "relation.reject", {
      relationKind: "same_account",
      fromRef: "source_account:sa-mf-a",
      toRef: `source_account:${DIRECT}`,
      validFrom: null,
      validTo: null,
      evidenceRefs: [],
      reason: "synthetic keep apart",
    });
    await decide(s, OPERATOR, "identity.assign", {
      subject: "account",
      referenceId: DIRECT,
      targetId: "account-sa-direct-ordinary",
      reason: "synthetic correction",
    });
    // An unrelated account's decision never appears in this one's history.
    await decide(s, OPERATOR, "identity.assign", {
      subject: "account",
      referenceId: "sa-direct-ordinary",
      targetId: `account-${DIRECT}`,
      reason: "synthetic other account",
    });
    const before = s.snapshot();
    const outcome = await history(s);
    expect(s.snapshot()).toBe(before);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { entries } = outcome.history;
    expect(validAccountHistoryRead(outcome.history)).toBe(true);
    expect(outcome.history.total).toBe(entries.length);
    expect(
      entries.map((row) => [row.entry, row.relationKind, row.relationStatus ?? row.decisionKind]),
    ).toEqual([
      ["mapping", null, null],
      ["relation", "connection_contains", "accepted"],
      ["relation", "connection_contains", "rejected"],
      ["relation", "same_account", "rejected"],
      ["decision", null, "assign"],
      ["mapping", null, null],
    ]);
    const relations = entries.filter((row) => row.entry === "relation");
    expect(relations.map((row) => [row.fromRef, row.toRef, row.reason])).toEqual([
      [`connection:${MF_PRODUCER}/${KEY_A}`, `source_account:${DIRECT}`, "synthetic acceptance"],
      [`connection:${MF_PRODUCER}/${KEY_A}`, `source_account:${DIRECT}`, "synthetic withdrawal"],
      ["source_account:sa-mf-a", `source_account:${DIRECT}`, "synthetic keep apart"],
    ]);
    // Who decided is a closed class; the actor id never leaves the read.
    expect(entries.slice(1).every((row) => row.decisionOrigin === "operator")).toBe(true);
    expect(entries.every((row) => !Object.keys(row).some((key) => /actor/iu.test(key)))).toBe(true);
    const mappings = entries.filter((row) => row.entry === "mapping");
    expect(mappings.map((row) => [row.revision, row.method, row.accountId])).toEqual([
      [1, "rule", `account-${DIRECT}`],
      [2, "manual", "account-sa-direct-ordinary"],
    ]);
    // The count is the read's own rows, through the same keys.
    expect((await s.sql.first<{ n: number }>(ACCOUNT_HISTORY_COUNT_SQL, [DIRECT]))!.n).toBe(
      entries.length,
    );
    // The aggregator side of the same_account row sees it too, from the other end.
    const aggregator = await history(s, "sa-mf-a");
    if (!aggregator.ok) throw new Error("aggregator history refused");
    expect(
      aggregator.history.entries
        .filter((row) => row.entry === "relation")
        .map((row) => [row.relationKind, row.fromRef]),
    ).toEqual([["same_account", "source_account:sa-mf-a"]]);
    expect(validAccountHistoryRead(aggregator.history)).toBe(true);
  });

  test("the wire check refuses a relation that does not name the account, an open code and a raw actor", async () => {
    const s = world();
    await decide(s, OPERATOR, "relation.reject", {
      relationKind: "same_account",
      fromRef: "source_account:sa-mf-a",
      toRef: `source_account:${DIRECT}`,
      validFrom: null,
      validTo: null,
      evidenceRefs: [],
      reason: "synthetic keep apart",
    });
    const outcome = await history(s);
    if (!outcome.ok) throw new Error("history refused");
    expect(validAccountHistoryRead(outcome.history)).toBe(true);
    const read = outcome.history;
    const at = read.entries.findIndex((row) => row.entry === "relation");
    const mutate = (change: (value: typeof read) => void) => {
      const copy = structuredClone(read);
      change(copy);
      return validAccountHistoryRead(copy);
    };
    expect(mutate((value) => (value.entries[at]!.toRef = "source_account:elsewhere"))).toBe(false);
    expect(mutate((value) => (value.entries[at]!.relationKind = "invented"))).toBe(false);
    expect(mutate((value) => (value.entries[0]!.decisionOrigin = "raw-actor" as never))).toBe(
      false,
    );
    expect(mutate((value) => (value.total = value.total + 1))).toBe(false);
    expect(mutate((value) => (value.entries[0]!.entry = "edit" as never))).toBe(false);
  });
});

describe("grant, request and budget", () => {
  test("capability, a narrowed scope and a malformed id refuse before any read", async () => {
    const untouched: SqlExecutor = {
      all: async () => {
        throw new Error("read");
      },
      first: async () => {
        throw new Error("read");
      },
    };
    const refusals = [
      [{ ...READER, capabilities: ["summary.read" as const] }, DIRECT, "unauthorized"],
      [
        { ...READER, scopes: { sources: [BANK_ONLY], accounts: "*" as const } },
        DIRECT,
        "evidence_restricted",
      ],
      [
        { ...READER, scopes: { sources: "*" as const, accounts: ["synthetic"] } },
        DIRECT,
        "evidence_restricted",
      ],
      [READER, "bad|account", "invalid_query"],
      [READER, 7, "invalid_query"],
    ] as const;
    for (const [grant, sourceAccountId, code] of refusals)
      expect(
        await readAccountHistoryForGrant({
          grant: grant as Grant,
          sql: untouched,
          sourceAccountId,
        }),
      ).toMatchObject({ ok: false, error: { code, requestId: "accounts.history" } });
  });

  test("an unknown account is restricted, and a history over budget is refused before its rows are read", async () => {
    const s = world();
    expect(await history(s, "sa-unknown")).toMatchObject({
      ok: false,
      error: { code: "evidence_restricted", refs: ["sourceAccountId"] },
    });
    const counted: SqlExecutor = {
      first: s.sql.first,
      all: async () => {
        throw new Error("history read over budget");
      },
    };
    expect(
      await readAccountHistoryForGrant({
        grant: { ...READER, budget: { ...READER.budget, maxRows: 0 } },
        sql: counted,
        sourceAccountId: DIRECT,
      }),
    ).toMatchObject({ ok: false, error: { code: "budget_exceeded" } });
    expect(
      (await history(s, DIRECT, { ...READER, budget: { ...READER.budget, maxRows: 1 } })).ok,
    ).toBe(true);
  });
});

describe("query plans without table statistics", () => {
  // The whole CORE schema with the real indexes, never analyzed.
  test("every branch reaches its rows by key, never by a scan", () => {
    const db = migratedDatabase();
    for (const text of [ACCOUNT_HISTORY_SQL, ACCOUNT_HISTORY_COUNT_SQL]) {
      const plan = explain(db, text, [DIRECT])
        .map((step) => step.detail)
        .join("\n");
      expect(plan).not.toMatch(
        /^SCAN (m|d|r|account_mappings|decision_revisions|entity_relations)\b/mu,
      );
      expect(plan).toContain("sqlite_autoindex_account_mappings_2 (source_account_id=?)");
      expect(plan).toContain("decision_revisions_subject (subject_kind=? AND subject_ref=?)");
      expect(plan).toMatch(/entity_relations_from \(kind=\? AND from_ref=\?\)/u);
      expect(plan).toMatch(/entity_relations_to \(kind=\? AND to_ref=\?\)/u);
      // Each relation's decision is joined by its primary key.
      expect(plan).toContain("sqlite_autoindex_decision_revisions_1 (id=?)");
    }
    db.close();
  });
});

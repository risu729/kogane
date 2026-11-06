// The account correspondence candidate review (src/query/account-candidates.ts,
// ADR 0077) over CORE 0017+ on the Layer A stub: connection reviews inserted
// through the review table's own evidence triggers, source accounts with rule
// mappings, and decisions through the change lifecycle. Every producer,
// connection key, account id and label here is synthetic; no provider value
// appears.
import { beforeAll, describe, expect, test } from "bun:test";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import {
  ACCOUNT_CONNECTION_REVIEWS_SQL,
  ACCOUNT_RELATIONS_SQL,
  ACCOUNT_SOURCE_FACTS_SQL,
  AGGREGATOR_SOURCE_ACCOUNTS_SQL,
} from "../../read-model/src/account-candidates.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { approve } from "../src/command/approve.ts";
import { commit } from "../src/command/commit.ts";
import { validPayload, type ChangePayload, type Principal } from "../src/command/contract.ts";
import { createPlan } from "../src/command/plan.ts";
import type { Grant } from "../src/grants.ts";
import {
  ACCOUNT_CANDIDATES_PAGE_SIZE,
  parseAccountCandidatesRequest,
  queryAccountCandidates,
  reviewAccountCandidates,
  type AccountCandidate,
  type AccountCandidateReview,
  type AccountCandidatesRequest,
} from "../src/query/account-candidates.ts";
import {
  BANK,
  DIRECT_PRODUCER,
  KEY_A,
  KEY_B,
  KEY_C,
  MF,
  MF_PRODUCER,
  Store,
  world,
} from "./account-candidates-world.ts";
import { AGENT, OPERATOR, planners, stubDatabase } from "./instrument-resolution-world.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

/** The reader authority a signed-in browser has (services/app `readerGrant`). */
const READER: Grant = {
  principal: "reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read", "evidence.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};

function request(input: Partial<AccountCandidatesRequest> = {}): AccountCandidatesRequest {
  return { view: "open", offset: 0, sourceAccountId: null, ...input };
}

async function review(
  s: Store,
  input: Partial<AccountCandidatesRequest> = {},
  grant: Grant = READER,
): Promise<AccountCandidateReview> {
  const outcome = await reviewAccountCandidates({ grant, sql: s.sql, request: request(input) });
  if (!outcome.ok) throw new Error(`refused: ${outcome.error.code}`);
  return outcome.review;
}

const candidates = (page: AccountCandidateReview) => page.items as AccountCandidate[];

let clock = 0;
async function decide(
  s: Store,
  principal: Principal,
  kind: "relation.accept" | "relation.reject",
  payload: ChangePayload,
) {
  clock += 1;
  const now = `2099-01-02T00:00:${String(clock).padStart(2, "0")}.000Z`;
  const store = sqliteCommandStore(s.db);
  const plan = await createPlan(
    kind,
    payload,
    { actor: principal, baseContextId: "account-candidates:test", now, ttlSeconds: 3600 },
    store,
  );
  if (!plan.ok) return { stage: "plan", result: plan } as const;
  const approval = await approve(store, {
    planId: plan.plan.planId,
    planDigest: plan.plan.planDigest,
    actor: principal,
    scope: [],
    ttlSeconds: 3600,
    now,
  });
  if (!approval.ok) return { stage: "approve", result: approval } as const;
  const committed = await commit(store, {
    operationId: `op-${String(clock)}`,
    principal,
    planId: plan.plan.planId,
    approvalId: approval.approval.approvalId,
    planners: planners(s.db),
    now,
  });
  return { stage: "commit", result: committed } as const;
}

beforeAll(() => {
  stubDatabase().close();
  migratedDatabase().close();
}, 60_000);

describe("the candidate read over the CORE schema", () => {
  test("proposes containment per pinned direct account, holds the doubly claimed one and never same_account", async () => {
    const s = world();
    const before = s.snapshot();
    const open = await review(s);
    expect(
      candidates(open).map((item) => [item.connectionKey, item.directSourceAccountId]),
    ).toEqual([[KEY_A, "sa-direct-time"]]);
    const held = await review(s, { view: "held" });
    expect(candidates(held).map((item) => [item.connectionKey, item.hold])).toEqual([
      [KEY_A, "direct-account-in-several-connections"],
      [KEY_B, "direct-account-in-several-connections"],
    ]);
    expect(candidates(held).every((item) => item.commands.accept === null)).toBe(true);
    expect(open.summary).toEqual({
      connections: { confirmed: 2, unresolved: 1, "evidence-ineligible": 0 },
      candidates: { proposed: 3, accepted: 0, rejected: 0 },
      held: 2,
      unreviewedAggregatorAccounts: 1,
      sameAccountProposed: 0,
      sameAccountRecorded: 0,
    });
    // One aggregator account matching two direct accounts: neither is chosen.
    expect(candidates(open)[0]!.sameAccount.reasons).toEqual([
      "aggregator-account-connection-scoped",
      "several-direct-accounts",
    ]);
    // The unresolved connection labelled like a direct account pairs with nothing.
    const connections = await review(s, { view: "connections" });
    expect(connections.items).toMatchObject([
      { connectionKey: KEY_A, state: "confirmed" },
      { connectionKey: KEY_B, state: "confirmed" },
      { connectionKey: KEY_C, state: "unresolved", directSourceAccountIds: [] },
    ]);
    const unreviewed = await review(s, { view: "unreviewed" });
    expect(unreviewed.items).toEqual([
      {
        sourceAccountId: "sa-mf-unreviewed",
        producerId: MF_PRODUCER,
        connectionKey: `moneyforward-account-v2-${"d".repeat(64)}`,
        reason: "no-connection-review",
      },
    ]);
    // The page names each source account with its current mapping.
    expect(
      open.sourceAccounts.map((row) => [row.sourceAccountId, row.label, row.mappingRevision]),
    ).toEqual([
      ["sa-direct-time", "Synthetic time deposit", 1],
      ["sa-mf-a", "Synthetic aggregator connection", 1],
    ]);
    // Every named command is a valid change payload once a reason is added.
    for (const item of [...candidates(open), ...candidates(held)])
      for (const command of [item.commands.accept, item.commands.reject])
        if (command)
          expect(validPayload(command.kind, { ...command.payload, reason: "synthetic" })).toBe(
            true,
          );
    expect(s.snapshot()).toBe(before);
  });

  test("an excluded direct run makes its review ineligible and releases the other connection's claim", async () => {
    const s = new Store();
    s.sourceAccount(
      "sa-direct-ordinary",
      BANK,
      DIRECT_PRODUCER,
      [`${BANK}:ordinary`],
      "Synthetic ordinary",
    );
    s.aggregator("sa-mf-a", KEY_A);
    s.aggregator("sa-mf-b", KEY_B);
    const runA = s.review(KEY_A, ["sa-direct-ordinary"]);
    s.review(KEY_B, ["sa-direct-ordinary"]);
    expect((await review(s, { view: "held" })).total).toBe(2);
    s.exclude(runA!);
    const held = await review(s, { view: "held" });
    expect(candidates(held).map((item) => [item.connectionKey, item.hold])).toEqual([
      [KEY_A, "evidence-ineligible"],
    ]);
    expect(candidates(await review(s)).map((item) => item.connectionKey)).toEqual([KEY_B]);
  });

  test("decisions go through the change lifecycle: an agent plans, a person accepts and withdraws", async () => {
    const s = world();
    const [candidate] = candidates(await review(s));
    const accept = { ...candidate!.commands.accept!.payload, reason: "synthetic acceptance" };
    const byAgent = await decide(s, AGENT, "relation.accept", accept);
    expect(byAgent.stage).toBe("approve");
    expect(byAgent.result.ok).toBe(false);
    const accepted = await decide(s, OPERATOR, "relation.accept", accept);
    expect(accepted.stage).toBe("commit");
    expect(accepted.result.ok).toBe(true);
    const decided = candidates(await review(s, { view: "decided" }));
    expect(decided.map((item) => [item.directSourceAccountId, item.status])).toEqual([
      ["sa-direct-time", "accepted"],
    ]);
    expect(decided[0]!.commands.accept).toBeNull();
    // Accepting containment never derives same_account (SC06).
    expect(
      s.db.query("SELECT count(*) AS n FROM entity_relations WHERE kind='same_account'").get(),
    ).toEqual({ n: 0 });
    const withdraw = { ...decided[0]!.commands.reject!.payload, reason: "synthetic withdrawal" };
    const withdrawn = await decide(s, OPERATOR, "relation.reject", withdraw);
    expect(withdrawn.result.ok).toBe(true);
    const after = candidates(await review(s, { view: "decided" }));
    expect(after.map((item) => item.status)).toEqual(["rejected"]);
    expect(after[0]!.commands.reject).toBeNull();
    expect(after[0]!.commands.accept?.kind).toBe("relation.accept");
    // Both decisions stay: the withdrawal is a later row, not an edit.
    expect(
      s.db
        .query(
          "SELECT status FROM entity_relations WHERE kind='connection_contains' ORDER BY created_at",
        )
        .all(),
    ).toEqual([{ status: "accepted" }, { status: "rejected" }]);
    expect((await review(s)).total).toBe(0);
  });

  test("a stored same_account decision is reported on the pair, and the policy still proposes none", async () => {
    const s = world();
    const result = await decide(s, OPERATOR, "relation.reject", {
      relationKind: "same_account",
      fromRef: "source_account:sa-mf-a",
      toRef: "source_account:sa-direct-time",
      validFrom: null,
      validTo: null,
      evidenceRefs: [],
      reason: "synthetic keep apart",
    });
    expect(result.result.ok).toBe(true);
    const [candidate] = candidates(await review(s));
    expect(candidate!.sameAccount).toEqual({
      proposed: false,
      reasons: ["aggregator-account-connection-scoped", "several-direct-accounts"],
      recorded: [
        {
          fromRef: "source_account:sa-mf-a",
          toRef: "source_account:sa-direct-time",
          status: "rejected",
        },
      ],
    });
  });
});

describe("grant, request and bounds", () => {
  test("records.read over the whole store, before anything is read", async () => {
    const untouched: SqlExecutor = {
      all: async () => {
        throw new Error("read");
      },
      first: async () => {
        throw new Error("read");
      },
    };
    const refused = async (grant: Grant) => {
      const outcome = await reviewAccountCandidates({ grant, sql: untouched, request: request() });
      return outcome.ok ? null : [outcome.error.code, outcome.error.refs];
    };
    expect(await refused({ ...READER, capabilities: ["summary.read"] })).toEqual([
      "unauthorized",
      ["capability:records.read"],
    ]);
    expect(await refused({ ...READER, scopes: { sources: [BANK], accounts: "*" } })).toEqual([
      "evidence_restricted",
      ["scope:source"],
    ]);
    expect(await refused({ ...READER, budget: { ...READER.budget, maxRows: 10 } })).toEqual([
      "budget_exceeded",
      ["budget:maxRows=10"],
    ]);
  });

  test("the request is closed; a source account filter narrows and an unknown one is refused", async () => {
    expect(parseAccountCandidatesRequest(undefined)).toEqual({ ok: true, value: request() });
    expect(parseAccountCandidatesRequest({ other: 1 })).toMatchObject({
      ok: false,
      code: "unsupported_semantics",
    });
    expect(parseAccountCandidatesRequest({ view: "hints" })).toMatchObject({
      ok: false,
      refs: ["view"],
    });
    expect(parseAccountCandidatesRequest({ offset: -1 })).toMatchObject({
      ok: false,
      refs: ["offset"],
    });
    expect(parseAccountCandidatesRequest({ sourceAccountId: "bad id" })).toMatchObject({
      ok: false,
      refs: ["sourceAccountId"],
    });
    const s = world();
    const narrowed = await review(s, { view: "held", sourceAccountId: "sa-mf-b" });
    expect(candidates(narrowed).map((item) => item.connectionKey)).toEqual([KEY_B]);
    const outcome = await reviewAccountCandidates({
      grant: READER,
      sql: s.sql,
      request: request({ sourceAccountId: "sa-nothing" }),
    });
    expect(outcome.ok ? null : outcome.error.code).toBe("evidence_restricted");
  });

  test("pages hold 50 items and a store past a bound is refused whole", async () => {
    const s = new Store();
    s.aggregator("sa-mf-a", KEY_A);
    const directs = Array.from({ length: 60 }, (_, i) => `sa-direct-${String(i).padStart(2, "0")}`);
    for (const id of directs)
      s.sourceAccount(id, BANK, DIRECT_PRODUCER, [`${BANK}:${id}`], "Synthetic");
    s.review(KEY_A, directs);
    const first = await review(s);
    expect(first.items).toHaveLength(ACCOUNT_CANDIDATES_PAGE_SIZE);
    expect(first.total).toBe(60);
    expect(first.nextOffset).toBe(ACCOUNT_CANDIDATES_PAGE_SIZE);
    const second = await review(s, { offset: ACCOUNT_CANDIDATES_PAGE_SIZE });
    expect(second.items).toHaveLength(10);
    expect(second.nextOffset).toBeNull();

    const overfull = (text: string): SqlExecutor => ({
      all: async <T>(sql: string, args: readonly unknown[]) => {
        if (sql === text)
          return Array.from(
            {
              length:
                text === ACCOUNT_RELATIONS_SQL
                  ? 10_001
                  : text === ACCOUNT_CONNECTION_REVIEWS_SQL
                    ? 65
                    : 1_001,
            },
            (_, i) =>
              text === ACCOUNT_RELATIONS_SQL
                ? {
                    kind: "same_account",
                    fromRef: `source_account:a${String(i)}`,
                    toRef: "source_account:b",
                    status: "accepted",
                  }
                : text === ACCOUNT_CONNECTION_REVIEWS_SQL
                  ? {
                      producerId: MF_PRODUCER,
                      connectionKey: `k${String(i)}`,
                      revision: 1,
                      label: "x",
                      status: "unresolved",
                      relatedSourceId: null,
                      directProducerId: null,
                      detailArtifactId: 1,
                      directArtifactId: null,
                      branchArtifactId: null,
                      directReferenceIdsJson: "[]",
                      evidenceEligible: 1,
                    }
                  : {
                      sourceAccountId: `sa-${String(i)}`,
                      producerId: MF_PRODUCER,
                      referenceJson: `["${MF}:k"]`,
                    },
          ) as T[];
        return s.sql.all<T>(sql, args);
      },
      first: s.sql.first,
    });
    for (const [text, bound] of [
      [ACCOUNT_CONNECTION_REVIEWS_SQL, "reviews"],
      [AGGREGATOR_SOURCE_ACCOUNTS_SQL, "aggregatorAccounts"],
      [ACCOUNT_RELATIONS_SQL, "relations"],
    ] as const) {
      const outcome = await reviewAccountCandidates({
        grant: READER,
        sql: overfull(text),
        request: request(),
      });
      expect(outcome.ok ? null : [outcome.error.code, outcome.error.refs]).toEqual([
        "budget_exceeded",
        [`budget:accountCandidates.${bound}`],
      ]);
    }
    await expect(queryAccountCandidates(overfull(ACCOUNT_RELATIONS_SQL))).rejects.toThrow(
      "relations",
    );
  });
});

describe("query plans without table statistics", () => {
  // The whole CORE schema with the real Layer A indexes (the stub above has
  // none), never analyzed.
  test("every read reaches its rows by key, never an observation table", () => {
    const db = migratedDatabase();
    const plan = (text: string, args: readonly unknown[] = []) =>
      explain(db, text, args)
        .map((step) => step.detail)
        .join("\n");
    const reviews = plan(ACCOUNT_CONNECTION_REVIEWS_SQL);
    const aggregators = plan(AGGREGATOR_SOURCE_ACCOUNTS_SQL);
    const relations = plan(ACCOUNT_RELATIONS_SQL);
    const facts = plan(ACCOUNT_SOURCE_FACTS_SQL, ['["sa-mf-a"]']);
    for (const table of [
      "transaction_observations",
      "balance_observations",
      "identity_observations",
    ])
      expect([reviews, aggregators, relations, facts].join("\n")).not.toContain(table);
    // The review view is the browser connection reader's own: one pass over
    // the small append-only review table, every newer-revision and evidence
    // check keyed.
    expect(reviews.match(/^SCAN .*/gmu)).toEqual([
      "SCAN c USING INDEX sqlite_autoindex_account_connection_reviews_1",
    ]);
    expect(aggregators).toContain(
      "SEARCH source_accounts USING INDEX sqlite_autoindex_source_accounts_2 (source_id=?)",
    );
    // One keyed range per kind (SQLite may use either kind index), never a scan.
    expect(relations).not.toMatch(/SCAN r\b/u);
    expect(relations).toContain("MULTI-INDEX OR");
    expect(
      relations.match(/SEARCH r USING INDEX entity_relations_(from|to) \(kind=\? AND /gu),
    ).toHaveLength(2);
    expect(facts).not.toMatch(/SCAN (s|m|n)\b/u);
    expect(facts).toContain("SEARCH s USING INDEX sqlite_autoindex_source_accounts_1 (id=?)");
    expect(facts).toContain(
      "SEARCH m USING INDEX sqlite_autoindex_account_mappings_2 (source_account_id=? AND revision=?)",
    );
  });
});

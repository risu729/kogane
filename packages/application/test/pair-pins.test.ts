// A plan for one identity pair pins every reference the pair's decisions may
// be recorded under, so a decision recorded under any of them between plan
// and commit makes the plan stale (ADR 0077's amendment of 2026-11-08,
// docs/change-lifecycle.md "Pair pins"). Over CORE 0017+ on the Layer A stub,
// with connection reviews inserted through the review table's own evidence
// triggers and every decision through the change lifecycle. Every producer,
// connection key, account, identifier and instrument here is synthetic.
import { beforeAll, describe, expect, test } from "bun:test";
import { approve } from "../src/command/approve.ts";
import { commit } from "../src/command/commit.ts";
import type {
  ChangeKind,
  ChangePayload,
  CommandStore,
  IdentityAssignPayload,
  RelationPayload,
} from "../src/command/contract.ts";
import { createPlan } from "../src/command/plan.ts";
import { simulate } from "../src/command/simulate.ts";
import { queryAccountCandidates } from "../src/query/account-candidates.ts";
import { queryInstrumentResolution } from "../src/query/instrument-resolution.ts";
import {
  CONNECTION_PAIR_REFS_SQL,
  connectionPairGuard,
  pairReferences,
} from "../src/operations/pair-references.ts";
import { explain } from "../../read-model/test/card-usage-plan.ts";
import {
  KEY_A,
  MF_PRODUCER,
  MF_PRODUCER_2,
  type Store,
  world as accountWorld,
} from "./account-candidates-world.ts";
import {
  OPERATOR,
  candidateOf,
  ids,
  planners,
  stubDatabase,
  world as instrumentWorld,
} from "./instrument-resolution-world.ts";
import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";

beforeAll(() => {
  stubDatabase().close();
  migratedDatabase().close();
}, 60_000);

const NOW = "2099-01-02T00:00:00.000Z";
const OWN = `connection:${MF_PRODUCER}/${KEY_A}`;
const OTHER_PRODUCER = `connection:${MF_PRODUCER_2}/${KEY_A}`;
const LEGACY = `connection:${MF_PRODUCER}/synthetic-importer-era-key`;
const DIRECT = "source_account:sa-direct-time";
const triple = (fromRef: string, toRef = DIRECT) =>
  `relation:connection_contains|${fromRef}|${toRef}`;

let operations = 0;

/** Plans and approves `payload` as the operator; the commit is the caller's. */
async function planned(
  store: CommandStore,
  kind: ChangeKind,
  payload: ChangePayload,
  baseContextId = "pair-pins:test",
) {
  const plan = await createPlan(
    kind,
    payload,
    { actor: OPERATOR, baseContextId, now: NOW, ttlSeconds: 3600 },
    store,
  );
  if (!plan.ok) throw new Error(`plan refused: ${plan.error}`);
  return plan.plan;
}

async function approved(store: CommandStore, plan: { planId: string; planDigest: string }) {
  return approve(store, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    actor: OPERATOR,
    scope: [],
    ttlSeconds: 3600,
    now: NOW,
  });
}

async function committed(
  store: CommandStore,
  db: Parameters<typeof planners>[0],
  planId: string,
  approvalId: string,
) {
  operations += 1;
  return commit(store, {
    operationId: `op-pair-${String(operations)}`,
    principal: OPERATOR,
    planId,
    approvalId,
    planners: planners(db),
    now: NOW,
  });
}

/** One whole decision: plan, approve and commit. */
async function decide(
  store: CommandStore,
  db: Parameters<typeof planners>[0],
  kind: ChangeKind,
  payload: ChangePayload,
  baseContextId?: string,
) {
  const plan = await planned(store, kind, payload, baseContextId);
  const approval = await approved(store, plan);
  if (!approval.ok) throw new Error(`approval refused: ${approval.error}`);
  const result = await committed(store, db, plan.planId, approval.approval.approvalId);
  if (!result.ok) throw new Error(`commit refused: ${result.error}`);
}

const containment = (fromRef: string, reason: string): RelationPayload => ({
  relationKind: "connection_contains",
  fromRef,
  toRef: DIRECT,
  validFrom: null,
  validTo: null,
  evidenceRefs: [],
  reason,
});

/** The candidate's own accept payload for the pair (KEY_A, sa-direct-time). */
async function ownAccept(s: Store): Promise<RelationPayload> {
  const set = await queryAccountCandidates(s.sql);
  const candidate = set.candidates.find(
    (item) => item.connectionRef === OWN && item.directSourceAccountId === "sa-direct-time",
  );
  return { ...candidate!.commands.accept!.payload, reason: "synthetic acceptance" };
}

/** What 0029 backfilled under the importer-era key 0063 later replaced on review A's row. */
function legacyBackfill(s: Store): void {
  const reviewId = (
    s.db
      .query("SELECT id FROM account_connection_reviews WHERE connection_key=? AND producer_id=?")
      .get(KEY_A, MF_PRODUCER) as { id: number }
  ).id;
  const id = `rel_legacy_connection_${String(reviewId)}_1`;
  const decision = `dr_legacy_connection_${String(reviewId)}_1`;
  s.db.run(
    `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
     VALUES(?,'relation',?,1,'accept','legacy-migration','legacy-unknown',NULL,'synthetic','[]',NULL,NULL,'2026-01-01T00:00:00.000Z')`,
    [decision, id],
  );
  s.db.run(
    `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
     VALUES(?,'connection_contains',?,?,NULL,NULL,'rejected',?,'[]','2026-01-01T00:00:00.000Z')`,
    [id, LEGACY, DIRECT, decision],
  );
}

const relationRows = (s: Store) =>
  s.db.query("SELECT count(*) AS n FROM entity_relations WHERE to_ref=?").get(DIRECT);

describe("an account pair (ADR 0077) is pinned under every reference", () => {
  test("the plan pins the candidate's own, another producer's and the 0029 reference", async () => {
    const s = accountWorld();
    s.review(KEY_A, ["sa-direct-ordinary", "sa-direct-time"], undefined, MF_PRODUCER_2);
    legacyBackfill(s);
    const store = sqliteCommandStore(s.db);
    const plan = await planned(store, "relation.accept", await ownAccept(s));
    expect(plan.expectedRevisions).toEqual({
      [triple(OWN)]: 0,
      [triple(OTHER_PRODUCER)]: 0,
      [triple(LEGACY)]: 1,
    });
    // The same set from either of the pair's references, and none for a
    // triple no connection review names.
    expect(
      (await pairReferences(store, "relation.reject", containment(LEGACY, "x"))).sort(),
    ).toEqual([triple(LEGACY), triple(OTHER_PRODUCER), triple(OWN)].sort());
    expect(
      await pairReferences(store, "relation.accept", containment("connection:nobody/none", "x")),
    ).toEqual([]);
    s.db.close();
  });

  for (const [name, reference, prepare] of [
    ["another producer's reference of the same identity value", OTHER_PRODUCER, "review"],
    ["the reference 0029 backfilled under a rewritten key", LEGACY, "legacy"],
  ] as const)
    test(`a decision under ${name} between plan and commit makes the plan stale`, async () => {
      const s = accountWorld();
      if (prepare === "review")
        s.review(KEY_A, ["sa-direct-ordinary", "sa-direct-time"], undefined, MF_PRODUCER_2);
      else legacyBackfill(s);
      const store = sqliteCommandStore(s.db);
      const plan = await planned(store, "relation.accept", await ownAccept(s));
      const approval = await approved(store, plan);
      if (!approval.ok) throw new Error("approval refused");
      // Someone keeps the pair apart under the pair's other reference.
      await decide(store, s.db, "relation.reject", containment(reference, "synthetic keep apart"));
      const rows = relationRows(s);
      expect(await simulate(plan, store)).toMatchObject({ ok: true, report: { stale: true } });
      const result = await committed(store, s.db, plan.planId, approval.approval.approvalId);
      expect(result).toMatchObject({ ok: false, error: "stale_context" });
      expect(result.ok ? [] : result.refs).toContain(triple(reference));
      expect(relationRows(s)).toEqual(rows);
      expect(
        s.db.query("SELECT status FROM change_plans WHERE plan_id=?").get(plan.planId),
      ).toEqual({ status: "stale" });
      s.db.close();
    });

  test("approval is refused the same way", async () => {
    const s = accountWorld();
    s.review(KEY_A, ["sa-direct-ordinary", "sa-direct-time"], undefined, MF_PRODUCER_2);
    const store = sqliteCommandStore(s.db);
    const plan = await planned(store, "relation.accept", await ownAccept(s));
    await decide(store, s.db, "relation.reject", containment(OTHER_PRODUCER, "synthetic"));
    const result = await approved(store, plan);
    expect(result).toMatchObject({ ok: false, error: "stale_context" });
    expect(result.ok ? [] : result.refs).toContain(triple(OTHER_PRODUCER));
    s.db.close();
  });

  test("a reference that appears after planning refuses approval and marks the plan stale", async () => {
    const s = accountWorld();
    const store = sqliteCommandStore(s.db);
    const plan = await planned(store, "relation.accept", await ownAccept(s));
    expect(Object.keys(plan.expectedRevisions)).toEqual([triple(OWN)]);
    // No pinned revision moves: the pair only gains a reference.
    s.review(KEY_A, ["sa-direct-ordinary", "sa-direct-time"], undefined, MF_PRODUCER_2);
    expect(await simulate(plan, store)).toMatchObject({ ok: true, report: { stale: true } });
    const result = await approved(store, plan);
    expect(result).toMatchObject({ ok: false, error: "stale_context" });
    expect(result.ok ? [] : result.refs).toEqual([plan.planId, triple(OTHER_PRODUCER)]);
    expect(s.db.query("SELECT count(*) AS n FROM approvals").get()).toEqual({ n: 0 });
    expect(s.db.query("SELECT status FROM change_plans WHERE plan_id=?").get(plan.planId)).toEqual({
      status: "stale",
    });
    s.db.close();
  });

  test("a reference that appears after planning makes the plan stale, also inside the commit batch", async () => {
    for (const phase of ["before-commit", "before-batch"] as const) {
      const s = accountWorld();
      const base = sqliteCommandStore(s.db);
      const plan = await planned(base, "relation.accept", await ownAccept(s));
      expect(Object.keys(plan.expectedRevisions)).toEqual([triple(OWN)]);
      const approval = await approved(base, plan);
      if (!approval.ok) throw new Error("approval refused");
      // A second producer's first review of the same identity value: the
      // pair now has a reference the plan did not pin.
      const appear = () =>
        s.review(KEY_A, ["sa-direct-ordinary", "sa-direct-time"], undefined, MF_PRODUCER_2);
      if (phase === "before-commit") appear();
      let injected = false;
      const store: CommandStore = {
        ...base,
        batch: async (writes) => {
          if (
            phase === "before-batch" &&
            !injected &&
            writes.some((write) => write.sql.includes("INSERT INTO operation_receipts"))
          ) {
            injected = true;
            appear();
          }
          return base.batch(writes);
        },
      };
      const rows = relationRows(s);
      const result = await committed(store, s.db, plan.planId, approval.approval.approvalId);
      expect(result).toMatchObject({ ok: false, error: "stale_context" });
      expect(result.ok ? [] : result.refs).toContain(triple(OTHER_PRODUCER));
      if (phase === "before-batch") expect(injected).toBe(true);
      expect(relationRows(s)).toEqual(rows);
      expect(
        s.db
          .query("SELECT uses_remaining FROM approvals WHERE approval_id=?")
          .get(approval.approval.approvalId),
      ).toEqual({ uses_remaining: 1 });
      s.db.close();
    }
  });

  test("with nothing recorded in between the pinned plan commits", async () => {
    const s = accountWorld();
    s.review(KEY_A, ["sa-direct-ordinary", "sa-direct-time"], undefined, MF_PRODUCER_2);
    legacyBackfill(s);
    const store = sqliteCommandStore(s.db);
    const plan = await planned(store, "relation.accept", await ownAccept(s));
    const approval = await approved(store, plan);
    if (!approval.ok) throw new Error("approval refused");
    expect(await committed(store, s.db, plan.planId, approval.approval.approvalId)).toMatchObject({
      ok: true,
    });
    s.db.close();
  });
});

describe("an instrument pair (ADR 0055) is pinned under both orientations and both mappings", () => {
  async function fixture() {
    const w = await instrumentWorld();
    const id = ids(w);
    const resolution = await queryInstrumentResolution(w.sql);
    const candidate = candidateOf(resolution, id.listing9001, id.broker9001);
    const instrumentOf = (identifier: string) =>
      resolution.identifiers.find((row) => row.identifierId === identifier)!.instrumentId;
    const anchor = candidate.anchorIdentifierId;
    const subject = candidate.subjectIdentifierId;
    return {
      w,
      store: sqliteCommandStore(w.db),
      candidate,
      anchor,
      subject,
      adopt: {
        ...candidate.commands!.adopt!.payload,
        reason: "synthetic adoption",
      } as IdentityAssignPayload,
      keepApart: {
        ...candidate.commands!.keepApart.payload,
        reason: "synthetic keep apart",
      } as RelationPayload,
      forward: `relation:listed_as|instrument:${instrumentOf(anchor)}|identifier:${subject}`,
      reverse: `relation:listed_as|instrument:${instrumentOf(subject)}|identifier:${anchor}`,
    };
  }

  test("adoption and keeping apart pin the same four references", async () => {
    const f = await fixture();
    const adoption = await planned(f.store, "identity.assign", f.adopt, f.candidate.candidateId);
    const keepApart = await planned(f.store, "relation.reject", f.keepApart);
    const expected = {
      [`instrument_mapping:${f.anchor}`]: 1,
      [`instrument_mapping:${f.subject}`]: 1,
      [f.forward]: 0,
      [f.reverse]: 0,
    };
    expect(adoption.expectedRevisions).toEqual(expected);
    expect(keepApart.expectedRevisions).toEqual(expected);
    f.w.db.close();
  });

  test("a rejection in the other orientation between plan and commit makes the adoption stale", async () => {
    const f = await fixture();
    const plan = await planned(f.store, "identity.assign", f.adopt, f.candidate.candidateId);
    const approval = await approved(f.store, plan);
    if (!approval.ok) throw new Error("approval refused");
    const [, from, to] = f.reverse.split("|");
    await decide(f.store, f.w.db, "relation.reject", {
      relationKind: "listed_as",
      fromRef: from!,
      toRef: to!,
      validFrom: null,
      validTo: null,
      evidenceRefs: [],
      reason: "synthetic reverse keep apart",
    });
    const mappings = () =>
      f.w.db
        .query("SELECT * FROM instrument_mappings WHERE identifier_id=? ORDER BY revision")
        .all(f.subject);
    const before = mappings();
    const result = await committed(f.store, f.w.db, plan.planId, approval.approval.approvalId);
    expect(result).toMatchObject({ ok: false, error: "stale_context" });
    expect(result.ok ? [] : result.refs).toContain(f.reverse);
    expect(mappings()).toEqual(before);
    f.w.db.close();
  });

  test("an adoption between plan and commit makes keeping apart stale", async () => {
    const f = await fixture();
    const plan = await planned(f.store, "relation.reject", f.keepApart);
    const approval = await approved(f.store, plan);
    if (!approval.ok) throw new Error("approval refused");
    await decide(f.store, f.w.db, "identity.assign", f.adopt, f.candidate.candidateId);
    const result = await committed(f.store, f.w.db, plan.planId, approval.approval.approvalId);
    expect(result).toMatchObject({ ok: false, error: "stale_context" });
    expect(result.ok ? [] : result.refs).toContain(`instrument_mapping:${f.subject}`);
    expect(
      f.w.db.query("SELECT count(*) AS n FROM entity_relations WHERE kind='listed_as'").get(),
    ).toEqual({ n: 0 });
    f.w.db.close();
  });
});

// A `same_account` decision, and a `listed_as` decision whose evidence does
// not name exactly two identifiers, decide no pair: every reader takes such a
// triple's status from its own rows only, and the plan shows that triple
// only. Their plans pin the triple alone, and a decision under any other
// triple (the reverse orientation included) leaves what the plan showed, and
// what its commit writes, unchanged.
describe("a decision that names no pair pins its own triple only", () => {
  const sameAccount = (fromRef: string, toRef: string, reason: string): RelationPayload => ({
    relationKind: "same_account",
    fromRef,
    toRef,
    validFrom: null,
    validTo: null,
    evidenceRefs: [],
    reason,
  });

  test("same_account: a decision in the reverse orientation leaves the plan fresh, and both are read apart", async () => {
    const s = accountWorld();
    const store = sqliteCommandStore(s.db);
    const aggregator = "source_account:sa-mf-a";
    const own = `relation:same_account|${aggregator}|${DIRECT}`;
    const payload = sameAccount(aggregator, DIRECT, "synthetic keep apart");
    expect(await pairReferences(store, "relation.reject", payload)).toEqual([]);
    const plan = await planned(store, "relation.reject", payload);
    expect(plan.expectedRevisions).toEqual({ [own]: 0 });
    const approval = await approved(store, plan);
    if (!approval.ok) throw new Error("approval refused");
    // The reverse orientation is accepted in between: another triple.
    await decide(store, s.db, "relation.accept", sameAccount(DIRECT, aggregator, "synthetic"));
    expect(await simulate(plan, store)).toMatchObject({ ok: true, report: { stale: false } });
    expect(await committed(store, s.db, plan.planId, approval.approval.approvalId)).toMatchObject({
      ok: true,
    });
    expect(
      s.db
        .query(
          "SELECT from_ref AS fromRef,status FROM entity_relations WHERE kind='same_account' ORDER BY from_ref",
        )
        .all(),
    ).toEqual([
      { fromRef: DIRECT, status: "accepted" },
      { fromRef: aggregator, status: "rejected" },
    ]);
    // The candidate read reports each orientation with its own status and
    // derives no status of the pair from them.
    const candidate = (await queryAccountCandidates(s.sql)).candidates.find(
      (item) => item.connectionRef === OWN && item.directSourceAccountId === "sa-direct-time",
    )!;
    expect(candidate.sameAccount.recorded).toEqual([
      { fromRef: aggregator, toRef: DIRECT, status: "rejected" },
      { fromRef: DIRECT, toRef: aggregator, status: "accepted" },
    ]);
    s.db.close();
  });

  test("listed_as without two named identifiers names no pair and pins its own triple", async () => {
    const w = await instrumentWorld();
    const id = ids(w);
    const store = sqliteCommandStore(w.db);
    const resolution = await queryInstrumentResolution(w.sql);
    const candidate = candidateOf(resolution, id.listing9001, id.broker9001);
    const instrumentOf = (identifier: string) =>
      resolution.identifiers.find((row) => row.identifierId === identifier)!.instrumentId;
    const anchor = candidate.anchorIdentifierId;
    const subject = candidate.subjectIdentifierId;
    const forward = `relation:listed_as|instrument:${instrumentOf(anchor)}|identifier:${subject}`;
    const keepApart = (evidenceRefs: string[]): RelationPayload => ({
      relationKind: "listed_as",
      fromRef: `instrument:${instrumentOf(anchor)}`,
      toRef: `identifier:${subject}`,
      validFrom: null,
      validTo: null,
      evidenceRefs,
      reason: "synthetic keep apart",
    });
    // None, only the subject, or three identifiers: no pair is named.
    for (const evidence of [
      [],
      [`identifier:${subject}`],
      [`identifier:${anchor}`, `identifier:${subject}`, `identifier:${id.venue9001}`],
    ])
      expect(await pairReferences(store, "relation.reject", keepApart(evidence))).toEqual([]);
    const plan = await planned(store, "relation.reject", keepApart([]));
    expect(plan.expectedRevisions).toEqual({ [forward]: 0 });
    const approval = await approved(store, plan);
    if (!approval.ok) throw new Error("approval refused");
    // The reverse orientation is rejected in between: another triple.
    await decide(store, w.db, "relation.reject", {
      ...keepApart([]),
      fromRef: `instrument:${instrumentOf(subject)}`,
      toRef: `identifier:${anchor}`,
    });
    expect(await simulate(plan, store)).toMatchObject({ ok: true, report: { stale: false } });
    expect(await committed(store, w.db, plan.planId, approval.approval.approvalId)).toMatchObject({
      ok: true,
    });
    expect(
      w.db
        .query("SELECT count(*) AS n FROM entity_relations WHERE kind='listed_as' AND to_ref=?")
        .get(`identifier:${subject}`),
    ).toEqual({ n: 1 });
    w.db.close();
  });
});

test("the account pair's references are read by key on the whole CORE schema without statistics", () => {
  const db = migratedDatabase();
  const plan = (text: string, args: readonly unknown[]) =>
    explain(db, text, args)
      .map((step) => step.detail)
      .join("\n");
  const read = plan(CONNECTION_PAIR_REFS_SQL, [OWN, DIRECT]);
  const guard = connectionPairGuard("relation.accept", containment(OWN, "x"), {})!;
  const batch = plan(`SELECT 1 WHERE ${guard.sql}`, guard.binds);
  for (const text of [read, batch]) {
    // One pass over the small review table per use; each backfilled relation
    // by its primary key, never a scan of the relations or an observation.
    expect(text).not.toMatch(/SCAN r\b/u);
    expect(text).not.toMatch(/observations/u);
    expect(text).toContain("SEARCH r USING INDEX sqlite_autoindex_entity_relations_1 (id=?)");
    const reached = new Set(
      (text.match(/^(?:SCAN|SEARCH) \w+/gmu) ?? []).map((step) => step.split(" ")[1] ?? step),
    );
    // Only the bound row, the review table, its pinned references, the
    // relations by key and the statement's own derived sets (and, in the
    // batch, the pinned JSON).
    for (const table of reached)
      expect(["CONSTANT", "c", "j", "p", "pair", "pair_keys", "pinned", "q", "r"]).toContain(table);
  }
  db.close();
});

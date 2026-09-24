// Pending-to-posted links in the purchase recognition lane (src/card-purchase-job.ts)
// and through the change lifecycle on D1: the candidate pass writes stage-B
// proposals over recognised events, a pair the provider itself linked is
// merged as a rule decision, a merged event is revised and retired like any
// other, and a reviewed accept or withdrawal merges or splits it. Vpass rows
// produced by the deployed parser on the real CORE schema in Miniflare; every
// card, amount, merchant, token and link id is synthetic.
import { afterEach, expect, test } from "bun:test";
import { CARD_PURCHASE_ACTOR } from "../../../packages/domain/src/card-purchase.ts";
import type { CardPurchaseCandidate } from "../../../packages/domain/src/card-purchase-view.ts";
import type { Observation } from "../../../packages/parsers/src/types.ts";
import {
  approve,
  commit,
  createPlan,
  d1CommandStore,
  type ChangeKind,
  type Principal,
} from "../../../packages/application/src/index.ts";
import { queryCardPurchases } from "../../../packages/application/src/query/card-purchases.ts";
import type { SqlExecutor } from "../../../packages/read-model/src/reader.ts";
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import type { SourceFactRef } from "../../../packages/domain/src/events.ts";
import {
  DEFAULT_MATCH_OPTIONS,
  proposalIdentity,
  stageBProposals,
  type MatchFact,
} from "../../../packages/domain/src/reconcile.ts";
import { exactQuantity, integerDecimal } from "../../../packages/domain/src/values.ts";
import {
  CANDIDATE_LOOKUP_CHUNK,
  CANDIDATE_WRITE_LIMIT,
  cardPurchaseSweep,
  type CardPurchaseSweepResult,
} from "../src/card-purchase-job.ts";
import { changeMutationPlanners } from "../src/change-commands.ts";
import { reviseIdentity } from "../src/identity-store.ts";
import { reconciliationSweep } from "../src/reconciliation-job.ts";
import { disposeWorlds, NOW, world, type UsageRow, type World } from "./card-purchase-world.ts";

afterEach(disposeWorlds);

const PENDING: UsageRow = {
  date: "26/05/03",
  merchant: "架空店舗A",
  amount: "1,200",
  paymentType: "1回払い",
};
const POSTED: UsageRow = {
  date: "26/05/03",
  merchant: "架空店舗A",
  amount: "1,234",
  paymentType: "1回払い",
};
const OTHER: UsageRow = {
  date: "26/05/06",
  merchant: "架空店舗C",
  amount: "700",
  paymentType: "1回払い",
};

function counts(result: CardPurchaseSweepResult) {
  return {
    recognized: result.recognized,
    revised: result.revised,
    reanchored: result.reanchored,
    retired: result.retired,
    conflicts: result.conflicts,
    failed: result.failed,
    proposed: result.proposed,
    merged: result.merged,
  };
}
const NOTHING = {
  recognized: 0,
  revised: 0,
  reanchored: 0,
  retired: 0,
  conflicts: 0,
  failed: 0,
  proposed: 0,
  merged: 0,
};

/** A provider link id on every row of a capture: the synthetic slice of reconciliation.test.ts. */
const linked =
  (id: string) =>
  (row: Observation): Observation =>
    row.kind === "transaction"
      ? {
          ...row,
          extra: {
            ...row.extra,
            _kogane: { ...(row.extra["_kogane"] as object), providerLinkId: id },
          },
        }
      : row;

interface ProposalRow {
  id: string;
  status: string;
  target_refs_json: string;
  rationale_codes_json: string;
  evidence_refs_json: string;
}

async function proposals(w: World): Promise<ProposalRow[]> {
  return w.all<ProposalRow>(
    "SELECT id,status,target_refs_json,rationale_codes_json,evidence_refs_json FROM reconciliation_proposals ORDER BY id",
  );
}

/** Per live event: its state and the roles of the keys it holds. */
async function events(w: World) {
  return w.all<{ event_id: string; revision: number; state: string; roles: string }>(
    `SELECT r.event_id,r.revision,r.state,
      (SELECT group_concat(k.role,',') FROM (SELECT role FROM card_purchase_recognition_keys k
        WHERE k.event_id=r.event_id AND k.revision=r.revision ORDER BY role DESC) k) AS roles
     FROM current_economic_events r WHERE r.kind IN ('purchase','refund') ORDER BY r.event_id`,
  );
}

/** A pending Vpass row, then the month's posted capture; the pending event is retired. */
async function pendingThenPosted(
  w: World,
  posted: readonly UsageRow[],
  rewrite?: (row: Observation) => Observation,
) {
  const pending = await w.vpass({
    family: "customized",
    fetchedAt: "2026-05-10T00:00:00.000Z",
    rows: [PENDING],
    ...(rewrite ? { rewrite } : {}),
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 1 });
  const capture = await w.vpass({
    family: "web",
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: posted,
    ...(rewrite ? { rewrite } : {}),
  });
  return { pending, capture };
}

function executor(w: World): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      (
        await w.db
          .prepare(sql)
          .bind(...args)
          .all<T>()
      ).results,
    first: async <T>(sql: string, args: readonly unknown[]) =>
      w.db
        .prepare(sql)
        .bind(...args)
        .first<T>(),
  };
}

const OPERATOR: Principal = {
  id: "synthetic-human",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
const COMMAND_NOW = "2098-01-01T00:00:00.000Z";
let operation = 0;

/** Plan, approve and commit one review through the processor's own planners. */
async function review(w: World, kind: ChangeKind, candidate: CardPurchaseCandidate) {
  const store = d1CommandStore(w.db);
  const planned = await createPlan(
    kind,
    { ...candidate.relation, reason: "reviewed against the statement" },
    {
      actor: OPERATOR,
      baseContextId: `card-purchase-link:${candidate.proposalId}`,
      now: COMMAND_NOW,
      ttlSeconds: 600,
    },
    store,
  );
  if (!planned.ok) throw new Error("plan " + JSON.stringify(planned));
  const approval = await approve(store, {
    planId: planned.plan.planId,
    planDigest: planned.plan.planDigest,
    actor: OPERATOR,
    scope: [],
    ttlSeconds: 600,
    now: COMMAND_NOW,
  });
  if (!approval.ok) throw new Error("approval " + JSON.stringify(approval));
  const result = await commit(store, {
    operationId: `link-review-${(operation += 1)}`,
    principal: OPERATOR,
    planId: planned.plan.planId,
    approvalId: approval.approval.approvalId,
    planners: changeMutationPlanners(w.db),
    now: COMMAND_NOW,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.receipt;
}

async function candidateOf(w: World, eventId: string): Promise<CardPurchaseCandidate> {
  const page = await queryCardPurchases(executor(w), { eventId });
  const [candidate] = page.items[0]?.candidates ?? [];
  if (!candidate) throw new Error("no candidate");
  return candidate;
}

test("the candidate pass writes stage-B proposals over recognised events, once, within its budget", async () => {
  const w = await world();
  const { pending, capture } = await pendingThenPosted(w, [POSTED, OTHER]);
  const flipped = await w.sweep();
  // The pending event is retired first, the posted rows recognised, and the
  // retired pending event paired with each posted event of its month.
  expect(counts(flipped)).toEqual({ ...NOTHING, retired: 1, recognized: 2, proposed: 2 });
  const stored = await proposals(w);
  expect(stored).toHaveLength(2);
  const [pendingObservation] = pending.observations;
  for (const row of stored) {
    expect(row.status).toBe("proposed");
    const [left, right] = JSON.parse(row.target_refs_json) as {
      kind: string;
      id: string;
      revision: string;
    }[];
    expect(left).toEqual({
      kind: "transaction",
      id: `transaction:${pendingObservation}`,
      revision: `parse_run:${pending.parse}`,
    });
    expect(capture.observations.map((id) => `transaction:${id}`)).toContain(right!.id);
    // Evidence is cited canonically: the ref id already carries its kind.
    expect(JSON.parse(row.evidence_refs_json)).toEqual([left!.id, right!.id]);
    // Amount and date closeness only: two candidates for one pending row.
    const rationale = JSON.parse(row.rationale_codes_json) as string[];
    expect(rationale).toContain("no_provider_link_id");
    expect(rationale).toContain("multiple_candidates");
  }
  // Nothing is merged or accepted by the rule without a provider link.
  expect(await w.count("SELECT count(*) AS n FROM entity_relations")).toBe(0);
  expect((await events(w)).map((event) => event.roles).sort()).toEqual([
    "pending",
    "posted",
    "posted",
  ]);
  // A second pass over the same events writes nothing.
  expect(counts(await w.sweep())).toEqual(NOTHING);
  expect(await proposals(w)).toEqual(stored);
  expect(CANDIDATE_WRITE_LIMIT).toBe(100);
}, 90_000);

test("the candidate budget bounds each tick, and already stored pairs never take it", async () => {
  const w = await world();
  await pendingThenPosted(w, [POSTED, OTHER, { ...OTHER, date: "26/05/07", amount: "800" }]);
  expect(await w.sweep({ candidateWriteLimit: 1 })).toMatchObject({ retired: 1, proposed: 1 });
  expect(await w.sweep({ candidateWriteLimit: 1 })).toMatchObject({ proposed: 1 });
  expect(await w.sweep({ candidateWriteLimit: 1 })).toMatchObject({ proposed: 1 });
  expect(await w.sweep({ candidateWriteLimit: 1 })).toMatchObject({ proposed: 0 });
  expect(await proposals(w)).toHaveLength(3);
}, 90_000);

test("two posted rows of the same amount are two candidates and never merge by themselves (SC03)", async () => {
  const w = await world();
  const same: UsageRow = { ...PENDING, amount: "900" };
  await w.vpass({ family: "customized", fetchedAt: "2026-05-10T00:00:00.000Z", rows: [same] });
  await w.sweep();
  await w.vpass({ family: "web", fetchedAt: "2026-06-10T00:00:00.000Z", rows: [same, same] });
  expect(counts(await w.sweep())).toEqual({
    ...NOTHING,
    retired: 1,
    recognized: 2,
    proposed: 2,
  });
  const stored = await proposals(w);
  expect(stored.map((row) => row.status)).toEqual(["proposed", "proposed"]);
  for (const row of stored) {
    const rationale = JSON.parse(row.rationale_codes_json) as string[];
    expect(rationale).toContain("amount_equal");
    expect(rationale).toContain("multiple_candidates");
  }
  expect(await w.count("SELECT count(*) AS n FROM entity_relations")).toBe(0);
  expect(await events(w)).toHaveLength(3);
  expect(await w.totals()).toMatchObject({ captured: "1800", authorized: "0", unresolved: 1 });
}, 90_000);

test("MyJCB rows with only relative period labels (detailMonth-N) meet by usage month", async () => {
  const w = await world();
  const matching: UsageRow = {
    date: "2026/05/10",
    merchant: "架空店舗J",
    amount: "800",
    paymentType: "1回払い",
  };
  // Pending and confirmed captures the collector could only label relatively.
  await w.myjcb({
    state: "unconfirmed",
    period: "detailMonth-0",
    fetchedAt: "2026-06-12T00:00:00.000Z",
    rows: [matching, { ...matching, date: "2026/05/28", amount: "2,500" }],
  });
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-2",
    fetchedAt: "2026-06-12T00:00:00.000Z",
    rows: [matching, { ...matching, date: "2026/05/01", amount: "300" }],
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 4, proposed: 1 });
  // No statement period is recognised on either side.
  expect(
    await w.all("SELECT DISTINCT source_id,statement_period FROM card_purchase_recognitions"),
  ).toEqual([{ source_id: "myjcb", statement_period: null }]);
  // Exactly the matching pair is proposed: same usage day, same amount.
  const [only, ...rest] = await proposals(w);
  expect(rest).toEqual([]);
  expect(only).toMatchObject({ status: "proposed" });
  const rationale = JSON.parse(only!.rationale_codes_json) as string[];
  expect(rationale).toEqual(
    expect.arrayContaining(["status_pending_to_posted", "date_within_window", "amount_equal"]),
  );
  expect(rationale).not.toContain("multiple_candidates");
  const [pending, posted] = JSON.parse(only!.target_refs_json) as { id: string }[];
  const byId = new Map(
    (
      await w.all<{ id: number; status: string; as_of: string }>(
        "SELECT id,status,as_of FROM transaction_observations",
      )
    ).map((row) => [`transaction:${row.id}`, row]),
  );
  expect(byId.get(pending!.id)).toMatchObject({ status: "unconfirmed", as_of: "2026-05-10" });
  expect(byId.get(posted!.id)).toMatchObject({ status: "confirmed", as_of: "2026-05-10" });
  expect(counts(await w.sweep())).toEqual(NOTHING);

  expect(await w.count("SELECT count(*) AS n FROM entity_relations")).toBe(0);
}, 120_000);

test("MyJCB twins of one amount and day under relative labels are both candidates, ambiguous, never merged", async () => {
  const w = await world();
  const matching: UsageRow = {
    date: "2026/05/10",
    merchant: "架空店舗J",
    amount: "800",
    paymentType: "1回払い",
  };
  await w.myjcb({
    state: "unconfirmed",
    period: "detailMonth-1",
    fetchedAt: "2026-06-12T00:00:00.000Z",
    rows: [matching],
  });
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-2",
    fetchedAt: "2026-06-12T00:00:00.000Z",
    rows: [matching, matching],
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 3, proposed: 2 });
  const stored = await proposals(w);
  expect(stored).toHaveLength(2);
  for (const row of stored) {
    expect(row.status).toBe("proposed");
    const rationale = JSON.parse(row.rationale_codes_json) as string[];
    expect(rationale).toEqual(expect.arrayContaining(["amount_equal", "multiple_candidates"]));
  }
  expect(await w.count("SELECT count(*) AS n FROM entity_relations")).toBe(0);
  expect(await events(w)).toHaveLength(3);
  expect(counts(await w.sweep())).toEqual(NOTHING);
}, 120_000);

test("a pair the provider itself linked is accepted and merged as a rule decision", async () => {
  const w = await world();
  const { pending, capture } = await pendingThenPosted(w, [POSTED], linked("provider-auth-1"));
  const result = await w.sweep();
  expect(counts(result)).toEqual({
    ...NOTHING,
    retired: 1,
    recognized: 1,
    proposed: 1,
    merged: 1,
  });
  // One live purchase: the pending-origin event, captured, holding both keys.
  const [event, ...others] = await events(w);
  expect(others).toEqual([]);
  expect(event).toMatchObject({ revision: 3, state: "captured", roles: "posted,pending" });
  expect(
    await w.all(
      "SELECT r.revision,r.state,c.action FROM economic_event_revisions r JOIN card_purchase_recognitions c USING(event_id,revision) WHERE r.event_id=? ORDER BY r.revision",
      event!.event_id,
    ),
  ).toEqual([
    { revision: 1, state: "authorized", action: "recognize" },
    { revision: 2, state: "unknown", action: "retire" },
    { revision: 3, state: "captured", action: "merge" },
  ]);
  // The posted event's live revision is superseded across ids.
  expect(
    await w.all(
      "SELECT revision,superseded_by FROM economic_event_revisions WHERE event_id<>? ORDER BY revision",
      event!.event_id,
    ),
  ).toEqual([{ revision: 1, superseded_by: `${event!.event_id}@3` }]);
  expect(await w.totals()).toMatchObject({ captured: "1234", authorized: "0", unresolved: 0 });
  // Every judgement is a recorded rule decision: the merge, the proposal and
  // the relation, which joins the two rows by their canonical refs.
  const [proposal] = await proposals(w);
  expect(proposal).toMatchObject({ status: "accepted" });
  expect(
    await w.all(
      `SELECT d.subject_ref,d.decision_kind,d.method,d.actor_id,d.operation_id FROM decision_revisions d
       WHERE d.subject_ref IN (?,?) OR d.id=(SELECT decision_revision_id FROM entity_relations)
       ORDER BY d.subject_ref`,
      `proposal:${proposal!.id}`,
      `event:${event!.event_id}`,
    ),
  ).toEqual(
    expect.arrayContaining([
      {
        subject_ref: `proposal:${proposal!.id}`,
        decision_kind: "accept",
        method: "rule",
        actor_id: CARD_PURCHASE_ACTOR,
        operation_id: null,
      },
      expect.objectContaining({ subject_ref: `event:${event!.event_id}`, method: "rule" }),
    ]),
  );
  expect(await w.all("SELECT kind,from_ref,to_ref,status FROM entity_relations")).toEqual([
    {
      kind: "pending_to_posted",
      from_ref: `transaction:${pending.observations[0]}`,
      to_ref: `transaction:${capture.observations[0]}`,
      status: "accepted",
    },
  ]);
  // The merged event follows its posted row; nothing is left to do.
  expect(counts(await w.sweep())).toEqual(NOTHING);
}, 90_000);

test("a merged event is revised when its content changes and retired when none of its keys is current", async () => {
  const w = await world();
  await pendingThenPosted(w, [POSTED], linked("provider-auth-2"));
  expect(await w.sweep()).toMatchObject({ merged: 1 });
  const [merged] = await events(w);

  // An account mapping correction: the merged event is revised, still one
  // event holding both keys.
  const [row] = await w.usage();
  const mapping = (
    await w.all<{ source_account_id: string; revision: number }>(
      "SELECT source_account_id,revision FROM current_account_mappings WHERE account_id=?",
      row!.account_id,
    )
  )[0]!;
  await w.db
    .prepare(
      "INSERT INTO accounts(id,label,role,status) VALUES('acct-card-corrected','synthetic','card-statement','identified')",
    )
    .run();
  await reviseIdentity(w.db, {
    kind: "account",
    referenceId: mapping.source_account_id,
    targetId: "acct-card-corrected",
    expectedRevision: mapping.revision,
    reason: "synthetic correction",
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, revised: 1 });
  expect(await events(w)).toEqual([
    { event_id: merged!.event_id, revision: 4, state: "captured", roles: "posted,pending" },
  ]);
  expect(
    await w.all(
      `SELECT l.subject_ref FROM economic_legs l JOIN current_economic_events e USING(event_id,revision)`,
    ),
  ).toEqual([{ subject_ref: "account:acct-card-corrected" }]);
  expect(counts(await w.sweep())).toEqual(NOTHING);

  // A newer capture of the month no longer shows the posted row: the merged
  // event is retired holding both keys, with no leg.
  await w.vpass({ family: "web", fetchedAt: "2026-06-20T00:00:00.000Z", rows: [OTHER] });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, retired: 1, recognized: 1 });
  const retired = (await events(w)).find((event) => event.event_id === merged!.event_id);
  expect(retired).toEqual({
    event_id: merged!.event_id,
    revision: 5,
    state: "unknown",
    roles: "posted,pending",
  });
  expect(
    await w.count(
      "SELECT count(*) AS n FROM economic_legs WHERE event_id=? AND revision=5",
      merged!.event_id,
    ),
  ).toBe(0);
  expect(await w.totals()).toMatchObject({ captured: "700", unresolved: 1 });

  // The row reappears: the same event is captured again, still merged.
  await w.vpass({
    family: "web",
    fetchedAt: "2026-06-30T00:00:00.000Z",
    rows: [POSTED, OTHER],
    rewrite: linked("provider-auth-2"),
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, revised: 1 });
  expect((await events(w)).find((event) => event.event_id === merged!.event_id)).toEqual({
    event_id: merged!.event_id,
    revision: 6,
    state: "captured",
    roles: "posted,pending",
  });
  expect(await w.totals()).toMatchObject({ captured: "1934", unresolved: 0 });
}, 120_000);

test("a reviewed accept on D1 merges, the lane leaves the merged event alone, and a withdrawal splits it", async () => {
  const w = await world();
  await pendingThenPosted(w, [POSTED]);
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, retired: 1, recognized: 1, proposed: 1 });
  const before = await events(w);
  const postedEvent = before.find((event) => event.roles === "posted")!.event_id;
  const pendingEvent = before.find((event) => event.roles === "pending")!.event_id;
  const candidate = await candidateOf(w, postedEvent);
  expect(candidate.actions).toEqual(["accept", "reject"]);

  const accepted = await review(w, "relation.accept", candidate);
  expect(accepted.result).toMatchObject({ review: "accept" });
  expect(await events(w)).toEqual([
    { event_id: pendingEvent, revision: 3, state: "captured", roles: "posted,pending" },
  ]);
  expect(await w.totals()).toMatchObject({ captured: "1234", unresolved: 0 });
  // The lane neither revises nor conflicts on the merged event.
  expect(counts(await w.sweep())).toEqual(NOTHING);

  const withdrawal = await candidateOf(w, pendingEvent);
  expect(withdrawal.actions).toEqual(["withdraw"]);
  const withdrawn = await review(w, "relation.reject", withdrawal);
  expect(withdrawn.result).toMatchObject({ review: "withdraw" });
  expect(await events(w)).toEqual(
    [
      { event_id: pendingEvent, revision: 4, state: "unknown", roles: "pending" },
      { event_id: postedEvent, revision: 2, state: "captured", roles: "posted" },
    ].sort((a, b) => (a.event_id < b.event_id ? -1 : 1)),
  );
  expect(await w.totals()).toMatchObject({ captured: "1234", unresolved: 1 });
  // The split pair is not proposed again, and nothing else is left to do.
  expect(counts(await w.sweep())).toEqual(NOTHING);
  expect(await proposals(w)).toHaveLength(1);
}, 120_000);

/** The digest `proposalIdentity` gives the stage-B pair of two stored target refs, as either writer computes it. */
async function pairDigest(targets: readonly SourceFactRef[]): Promise<string> {
  const [left, right] = targets.map((ref, index): MatchFact => ({
    ref,
    scope: { sourceId: "vpass", credentialEpoch: "x", accountNamespace: "x" },
    sourceAccount: "x",
    externalId: null,
    identifierOrigin: "collector-fingerprint",
    providerLinkId: null,
    settlementState: index === 0 ? "pending" : "posted",
    quantity: exactQuantity("JPY", integerDecimal(-1200), "decimal-v1"),
    occurred: { kind: "local-date", value: "2026-05-03", zone: null, basis: "provider" },
    counterparty: null,
    statementPeriod: null,
    ownerRef: null,
  }));
  const [proposal] = stageBProposals([left!, right!], DEFAULT_MATCH_OPTIONS);
  return canonicalDigest(proposalIdentity(proposal!));
}

test("the reconciliation lane and the purchase lane propose one pair once, under one digest, whichever runs first", async () => {
  for (const order of ["reconciliation first", "purchases first"] as const) {
    const w = await world();
    await pendingThenPosted(w, [POSTED]);
    if (order === "reconciliation first") {
      expect(await reconciliationSweep(w.db, { now: NOW })).toMatchObject({ written: 1 });
      // The purchase lane pairs the same two rows and finds the pair stored.
      expect(counts(await w.sweep())).toEqual({ ...NOTHING, retired: 1, recognized: 1 });
    } else {
      expect(counts(await w.sweep())).toEqual({
        ...NOTHING,
        retired: 1,
        recognized: 1,
        proposed: 1,
      });
      expect(await reconciliationSweep(w.db, { now: NOW })).toMatchObject({ written: 0 });
    }
    const stored = await w.all<{ id: string; proposal_digest: string; target_refs_json: string }>(
      "SELECT id,proposal_digest,target_refs_json FROM reconciliation_proposals",
    );
    expect(stored).toHaveLength(1);
    const digest = await pairDigest(JSON.parse(stored[0]!.target_refs_json) as SourceFactRef[]);
    expect(stored[0]).toMatchObject({ id: `rp_${digest}`, proposal_digest: digest });
    // The pair the purchase lane compares is exactly that stored row's targets.
    const [pendingKey, postedKey] = await w.all<{ observation_id: number; parse_run_id: number }>(
      "SELECT observation_id,parse_run_id FROM current_card_purchase_keys ORDER BY role",
    );
    expect(JSON.parse(stored[0]!.target_refs_json)).toEqual(
      [pendingKey!, postedKey!].map((key) => ({
        kind: "transaction",
        id: `transaction:${key.observation_id}`,
        revision: `parse_run:${key.parse_run_id}`,
      })),
    );
    expect(counts(await w.sweep())).toEqual(NOTHING);
    expect(await reconciliationSweep(w.db, { now: NOW })).toMatchObject({ written: 0 });
    await disposeWorlds();
  }
}, 180_000);

test("a provider-linked pair the reconciliation lane accepted is merged once, without a second acceptance", async () => {
  const w = await world();
  await pendingThenPosted(w, [POSTED], linked("provider-auth-4"));
  expect(await reconciliationSweep(w.db, { now: NOW })).toMatchObject({
    written: 1,
    autoAccepted: 1,
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, retired: 1, recognized: 1, merged: 1 });
  const [proposal] = await proposals(w);
  expect(proposal).toMatchObject({ status: "accepted" });
  // One acceptance (the reconciliation rule's), one relation, one merged event.
  expect(
    await w.count(
      "SELECT count(*) AS n FROM decision_revisions WHERE subject_ref=?",
      `proposal:${proposal!.id}`,
    ),
  ).toBe(1);
  expect(await w.count("SELECT count(*) AS n FROM entity_relations")).toBe(1);
  expect((await events(w)).map((event) => [event.state, event.roles])).toEqual([
    ["captured", "posted,pending"],
  ]);
  expect(await w.totals()).toMatchObject({ captured: "1234", authorized: "0", unresolved: 0 });
  expect(counts(await w.sweep())).toEqual(NOTHING);
}, 120_000);

test("the rule never merges again a provider-linked pair a reviewer split, even after a re-anchor", async () => {
  const w = await world();
  const { capture } = await pendingThenPosted(w, [POSTED], linked("provider-auth-5"));
  expect(await w.sweep()).toMatchObject({ merged: 1 });
  const [merged] = await events(w);
  const withdrawal = await candidateOf(w, merged!.event_id);
  expect(withdrawal.actions).toEqual(["withdraw"]);
  expect((await review(w, "relation.reject", withdrawal)).result).toMatchObject({
    review: "withdraw",
  });
  expect(counts(await w.sweep())).toEqual(NOTHING);
  const split = await events(w);
  expect(split.map((event) => [event.state, event.roles]).sort()).toEqual([
    ["captured", "posted"],
    ["unknown", "pending"],
  ]);
  // A published replay re-anchors the posted event on a new row: the pair
  // is a new proposal, still provider-linked, and the rule leaves it to review.
  await w.publish(await capture.replay({ publish: false }));
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, reanchored: 1, proposed: 1 });
  expect((await events(w)).map((event) => [event.state, event.roles]).sort()).toEqual([
    ["captured", "posted"],
    ["unknown", "pending"],
  ]);
  const fresh = (await proposals(w)).filter((row) => row.status === "proposed");
  expect(fresh).toHaveLength(1);
  expect(JSON.parse(fresh[0]!.rationale_codes_json)).toContain("provider_link_id_equal");
  expect(counts(await w.sweep())).toEqual(NOTHING);
  // A reviewer can still accept it.
  const postedEvent = split.find((event) => event.roles === "posted")!.event_id;
  const page = await queryCardPurchases(executor(w), { eventId: postedEvent });
  expect(
    page.items[0]!.candidates.find((entry) => entry.proposalId === fresh[0]!.id),
  ).toMatchObject({ providerLinked: true, actions: ["accept", "reject"] });
}, 120_000);

test("the candidate pass looks up stored pairs a bounded chunk at a time", async () => {
  const w = await world();
  await pendingThenPosted(w, [POSTED, OTHER, { ...OTHER, date: "26/05/07", amount: "800" }]);
  expect(CANDIDATE_LOOKUP_CHUNK).toBe(1_000);
  // Every stored-pair lookup binds its digests as one JSON array; record their sizes.
  let lookups: number[] = [];
  const db = new Proxy(w.db, {
    get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("WHERE proposal_digest IN")) return statement;
        return {
          bind: (...args: unknown[]) => {
            lookups.push((JSON.parse(args[0] as string) as unknown[]).length);
            return statement.bind(...args);
          },
        };
      };
    },
  });
  const tick = async () => {
    lookups = [];
    const result = await cardPurchaseSweep(db, {
      now: NOW,
      candidateLookupChunk: 2,
      candidateWriteLimit: 2,
    });
    return { proposed: result.proposed, lookups };
  };
  // Three pairs: the first chunk fills the budget, so the second is not read.
  expect(await tick()).toEqual({ proposed: 2, lookups: [2] });
  // The stored chunk takes no budget; the next chunk's new pair is written.
  expect(await tick()).toEqual({ proposed: 1, lookups: [2, 1] });
  expect(await tick()).toEqual({ proposed: 0, lookups: [2, 1] });
  expect(await proposals(w)).toHaveLength(3);
}, 120_000);

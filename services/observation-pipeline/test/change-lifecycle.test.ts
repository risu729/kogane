// The change lifecycle (migration 0031, architecture addendum A09): plan →
// simulate → approve → commit, idempotency receipts, expected revisions
// verified inside the write transaction, and the decision outbox that turns an
// accepted judgement into a published one. Synthetic rows only; no amounts.
//
// Acceptance: SC17 (a plan pinned to rev7 cannot be approved or committed once
// a concurrent change made it rev8, and re-simulating yields a new digest),
// AT69 (a changed plan is refused), AT70 (parallel commits, lost responses,
// resends, and an expired approval on an already committed operation).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import type {
  IdentityInput,
  IdentityPlan,
} from "../../../poc/observation-pipeline/src/identity/types.ts";
import {
  approve,
  commit,
  createPlan,
  d1CommandStore,
  getReceipt,
  loadPlan,
  simulate,
  type ChangePlan,
  type CommandStore,
  type Principal,
} from "../../../packages/application/src/index.ts";
import { changeMutationPlanners } from "../src/change-commands.ts";
import { dispatchDecisionOutbox } from "../src/decision-outbox.ts";
import { executeIdentityCommand } from "../src/identity-commands.ts";
import {
  IDENTITY_POLICY_VERSION,
  identifyParse,
  type IdentityResolver,
} from "../src/identity-store.ts";
import {
  LAYER_A_SQL,
  layerBMigrations,
  migrationDir,
  publishParse,
  seedArtifact,
  splitSql,
  startPipeline,
} from "./harness.ts";

let mf: Miniflare;
let env: Env;
let db: D1Database;
let store: CommandStore;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  db = env.DB;
  store = d1CommandStore(db);
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

const PRODUCER = "collector-r2-importer";
const operator: Principal = {
  id: "operator@synthetic.test",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
const agent: Principal = {
  id: "agent-proposer",
  kind: "agent",
  verification: "server",
  capabilities: ["interpretation.propose"],
};
const NOW = "2098-01-01T00:00:00.000Z";
const later = (seconds: number) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

const resolver: IdentityResolver = (input: IdentityInput): IdentityPlan => ({
  account: {
    key: [input.sourceAccount],
    label: "rule label",
    role: "deposit",
    status: "provider-local",
    reason: "synthetic-test-policy",
  },
  instruments: [
    {
      role: "unit",
      kind: "money",
      namespace: "iso4217",
      scope: "global",
      value: "JPY",
      label: "JPY",
      status: "identified",
      reason: "synthetic-test-policy",
      details: {},
    },
  ],
  issues: [],
});

async function seedParse(id: number, sourceAccount: string, observations = 2, publish = true) {
  await seedArtifact(env, id, "smbc-bank", "synthetic", `synthetic-${id}.json`, { id });
  await db.batch([
    db
      .prepare(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'synthetic','1','2098-01-01','pending','[]')",
      )
      .bind(id, id),
    db
      .prepare(
        "INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,raw_locator,extra_json) SELECT ?,?,'synthetic_balance','JPY','synthetic:'||?||':'||value,'{}' FROM json_each(?)",
      )
      .bind(
        id,
        sourceAccount,
        id,
        JSON.stringify(Array.from({ length: observations }, (_, i) => i)),
      ),
    db.prepare("UPDATE parse_runs SET status='ok' WHERE id=?").bind(id),
  ]);
  if (publish) await publishParse(db, id);
  await identifyParse(
    db,
    { id, artifact_id: id, source_id: "smbc-bank", producer_id: PRODUCER, fetch_run_id: id },
    resolver,
  );
  const mapping = (await db
    .prepare(
      "SELECT m.source_account_id AS ref, m.account_id, m.revision FROM current_account_mappings m JOIN current_identity_observations o ON o.source_account_id=m.source_account_id WHERE o.parse_run_id=? LIMIT 1",
    )
    .bind(id)
    .first<{ ref: string; account_id: string; revision: number }>())!;
  return mapping;
}

async function target(id: string, label = "operator target") {
  await db
    .prepare("INSERT OR IGNORE INTO accounts VALUES(?,?,'deposit','identified')")
    .bind(id, label)
    .run();
  return id;
}

interface Counts {
  plans: number;
  approvals: number;
  receipts: number;
  outbox: number;
  decisions: number;
  operations: number;
  mappings: number;
  relations: number;
}

async function counts(): Promise<Counts> {
  const row = await db
    .prepare(`SELECT
      (SELECT count(*) FROM change_plans) AS plans,
      (SELECT count(*) FROM approvals) AS approvals,
      (SELECT count(*) FROM operation_receipts) AS receipts,
      (SELECT count(*) FROM decision_outbox) AS outbox,
      (SELECT count(*) FROM decision_revisions) AS decisions,
      (SELECT count(*) FROM decision_operations) AS operations,
      (SELECT count(*) FROM account_mappings) AS mappings,
      (SELECT count(*) FROM entity_relations) AS relations`)
    .first<Counts>();
  return row!;
}

async function planFor(
  ref: string,
  targetId: string,
  actor: Principal = operator,
  now = NOW,
): Promise<ChangePlan> {
  const result = await createPlan(
    "identity.assign",
    { subject: "account", referenceId: ref, targetId, reason: "operator corrected the mapping" },
    { actor, baseContextId: "identity-current-v1", now, ttlSeconds: 900 },
    store,
  );
  if (!result.ok) throw new Error(`plan failed: ${result.error}`);
  return result.plan;
}

async function approveFor(plan: ChangePlan, now = NOW) {
  const result = await approve(store, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    actor: operator,
    scope: [],
    ttlSeconds: 600,
    now,
  });
  if (!result.ok) throw new Error(`approve failed: ${result.error}`);
  return result.approval;
}

const commitWith = (
  operationId: string,
  plan: ChangePlan,
  approvalId: string,
  now = NOW,
  principal: Principal = operator,
) =>
  commit(store, {
    operationId,
    principal,
    planId: plan.planId,
    approvalId,
    planners: changeMutationPlanners(db),
    now,
  });

test("a plan records the revisions it was read at and a server-computed impact, never the caller's", async () => {
  const mapping = await seedParse(200, "smbc-bank:plan-1", 3);
  const plan = await planFor(mapping.ref, await target("target-plan-1"));
  expect(plan.planId).toMatch(/^[0-9a-f]{64}$/u);
  expect(plan.status).toBe("planned");
  expect(plan.expectedRevisions).toEqual({ [`account_mapping:${mapping.ref}`]: 1 });
  expect(plan.simulation.before.attributedObservations).toBe(3);
  expect(plan.simulation.after.attributedObservations).toBe(3);
  expect(plan.simulation.affectedParseRuns).toBe(1);
  expect(plan.simulation.affectedScopes).toEqual(["smbc-bank"]);
  expect(plan.simulation.targets).toEqual([
    {
      subjectRef: `account_mapping:${mapping.ref}`,
      currentRevision: 1,
      currentTargetRef: mapping.account_id,
      proposedTargetRef: "target-plan-1",
    },
  ]);
  expect(plan.simulation.outboxTargets).toEqual(["identity-projection", "balance-projection"]);
  // Counts and identifiers only: nothing in a simulation carries an amount.
  expect(JSON.stringify(plan.simulation)).not.toMatch(/amount|currency|JPY/iu);
  // Planning the same change twice over unchanged data is the same plan.
  const again = await planFor(mapping.ref, "target-plan-1");
  expect(again.planId).toBe(plan.planId);
  const report = await simulate(plan, store);
  expect(report.ok && report.report.stale).toBe(false);
  expect(report.ok && report.report.resimulatedPlanId).toBe(plan.planId);
});

test("an unadopted successful parse is not part of the difference an operator approves", async () => {
  const mapping = await seedParse(220, "smbc-bank:gate", 2);
  const before = await planFor(mapping.ref, await target("target-gate"));
  expect(before.simulation.before.attributedObservations).toBe(2);
  // A second successful run over the same reference that the publication gate
  // has not adopted. It is a future candidate: no normal reader sees it, so it
  // must not appear in the count a human approves (docs/publication-gate.md).
  await seedParse(221, "smbc-bank:gate", 5, false);
  const unadopted = await simulate(before, store);
  expect(unadopted.ok && unadopted.report.simulation.before.attributedObservations).toBe(2);
  expect(unadopted.ok && unadopted.report.stale).toBe(false);
  // Adopting it is what brings its rows into the difference, and that is a
  // fresh simulation: the stored plan is immutable and keeps its own numbers.
  await publishParse(db, 221);
  const adopted = await simulate(before, store);
  expect(adopted.ok && adopted.report.simulation.before.attributedObservations).toBe(7);
  expect((await loadPlan(store, before.planId))!.simulation.before.attributedObservations).toBe(2);
});

test("SC17/AT69: a plan pinned to rev7 is refused once a concurrent change made it rev8, and re-simulation is a different plan", async () => {
  const mapping = await seedParse(201, "smbc-bank:sc17");
  const first = await target("target-sc17-a");
  const second = await target("target-sc17-b");
  const plan = await planFor(mapping.ref, first);
  expect(plan.expectedRevisions[`account_mapping:${mapping.ref}`]).toBe(1);

  // A concurrent correction from another path moves the subject to revision 2.
  const concurrent = await executeIdentityCommand(
    db,
    {
      operationId: "op-sc17-concurrent",
      actorId: "other-operator",
      actorVerification: "server",
      action: "assign",
      kind: "account",
      referenceId: mapping.ref,
      expectedRevision: 1,
      targetId: second,
      reason: "another operator got there first",
    },
    IDENTITY_POLICY_VERSION,
  );
  expect(concurrent.ok).toBe(true);

  const stale = await approve(store, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    actor: operator,
    scope: [],
    ttlSeconds: 600,
    now: NOW,
  });
  expect(stale).toMatchObject({ ok: false, error: "stale_context" });
  // The plan is marked stale rather than deleted; its record survives.
  expect((await loadPlan(store, plan.planId))!.status).toBe("stale");

  const report = await simulate(plan, store);
  expect(report.ok && report.report.stale).toBe(true);
  expect(report.ok && report.report.currentRevisions).toEqual({
    [`account_mapping:${mapping.ref}`]: 2,
  });
  // Re-simulating the same change produces a different plan id, so no approval
  // of the old digest can ever apply to it.
  const resimulated = await planFor(mapping.ref, first);
  expect(resimulated.planId).not.toBe(plan.planId);
  expect(report.ok && report.report.resimulatedPlanId).toBe(resimulated.planId);
});

test("a stale plan is refused at commit too, and the failed guard writes nothing at all", async () => {
  const mapping = await seedParse(202, "smbc-bank:guard");
  const plan = await planFor(mapping.ref, await target("target-guard"));
  const approval = await approveFor(plan);
  // Move the subject after the approval was issued.
  expect(
    (
      await executeIdentityCommand(
        db,
        {
          operationId: "op-guard-concurrent",
          actorId: "other-operator",
          actorVerification: "server",
          action: "assign",
          kind: "account",
          referenceId: mapping.ref,
          expectedRevision: 1,
          targetId: await target("target-guard-other"),
          reason: "concurrent",
        },
        IDENTITY_POLICY_VERSION,
      )
    ).ok,
  ).toBe(true);
  const before = await counts();
  const result = await commitWith("op-guard", plan, approval.approvalId);
  expect(result).toMatchObject({ ok: false, error: "stale_context" });
  // Nothing of the commit was written: not the receipt, not the decision, not
  // the outbox row, not a mapping revision.
  expect(await counts()).toEqual(before);
  expect(
    await db
      .prepare("SELECT uses_remaining FROM approvals WHERE approval_id=?")
      .bind(approval.approvalId)
      .first<number>("uses_remaining"),
  ).toBe(1);
});

test("commit accepts once, replays the same receipt, and refuses a different payload under the same key", async () => {
  const mapping = await seedParse(203, "smbc-bank:idempotent");
  const targetId = await target("target-idempotent");
  const plan = await planFor(mapping.ref, targetId);
  const approval = await approveFor(plan);
  const first = await commitWith("op-idempotent", plan, approval.approvalId);
  expect(first).toMatchObject({ ok: true, replayed: false });
  if (!first.ok) throw new Error("unreachable");
  expect(first.receipt).toMatchObject({
    operationId: "op-idempotent",
    principal: operator.id,
    operationKind: "identity.assign",
    planId: plan.planId,
    status: "accepted",
    publishedAt: null,
  });
  expect(first.receipt.result).toMatchObject({ action: "assign", revision: 2 });
  const mappingRow = await db
    .prepare(
      "SELECT account_id,revision,method FROM current_account_mappings WHERE source_account_id=?",
    )
    .bind(mapping.ref)
    .first<{ account_id: string; revision: number; method: string }>();
  expect(mappingRow).toEqual({ account_id: targetId, revision: 2, method: "manual" });

  const after = await counts();
  // Same principal, same operation id, same payload: the same receipt and no
  // second mutation (AT70).
  const replay = await commitWith("op-idempotent", plan, approval.approvalId);
  expect(replay).toMatchObject({ ok: true, replayed: true });
  if (!replay.ok) throw new Error("unreachable");
  expect(replay.receipt).toEqual(first.receipt);
  expect(await counts()).toEqual(after);

  // The same key with a different payload is refused, not silently accepted.
  // Planning and approving are their own rows; the refused commit writes none.
  const other = await planFor(mapping.ref, await target("target-idempotent-other"));
  const otherApproval = await approveFor(other);
  const afterOther = await counts();
  expect(await commitWith("op-idempotent", other, otherApproval.approvalId)).toMatchObject({
    ok: false,
    error: "idempotency_conflict",
  });
  expect(await counts()).toEqual(afterOther);
});

test("an expired approval still returns the receipt of an already committed operation", async () => {
  const mapping = await seedParse(204, "smbc-bank:expired");
  const plan = await planFor(mapping.ref, await target("target-expired"));
  const approval = await approveFor(plan);
  expect((await commitWith("op-expired", plan, approval.approvalId)).ok).toBe(true);
  // Long after the approval expired: the completed operation answers with its
  // receipt rather than demanding a new approval for a change already made.
  const replay = await commitWith("op-expired", plan, approval.approvalId, later(86_400));
  expect(replay).toMatchObject({ ok: true, replayed: true });
  const looked = await getReceipt(store, operator.id, "op-expired");
  expect(looked).toMatchObject({ ok: true });
  if (!looked.ok || !replay.ok) throw new Error("unreachable");
  expect(looked.receipt).toEqual(replay.receipt);
  // A receipt is only visible in its own principal's namespace.
  expect(await getReceipt(store, "someone-else", "op-expired")).toMatchObject({
    ok: false,
    error: "receipt_not_found",
  });
});

test("two commits of one approved plan interleave: exactly one succeeds", async () => {
  const mapping = await seedParse(205, "smbc-bank:parallel");
  const plan = await planFor(mapping.ref, await target("target-parallel"));
  const approval = await approveFor(plan);
  const before = await counts();
  const [a, b] = await Promise.all([
    commitWith("op-parallel-a", plan, approval.approvalId),
    commitWith("op-parallel-b", plan, approval.approvalId),
  ]);
  expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  const failed = a.ok ? b : a;
  expect(failed.ok).toBe(false);
  if (failed.ok) throw new Error("unreachable");
  // The loser is told why: the revision moved, or the single-use approval is
  // spent. Never "committed" and never a second mapping revision.
  expect(["stale_context", "approval_exhausted", "plan_not_open"]).toContain(failed.error);
  const after = await counts();
  expect(after.receipts).toBe(before.receipts + 1);
  expect(after.mappings).toBe(before.mappings + 1);
  expect(after.decisions).toBe(before.decisions + 1);
});

test("a resent identical commit races itself and still yields one receipt and one mutation", async () => {
  const mapping = await seedParse(206, "smbc-bank:resend");
  const plan = await planFor(mapping.ref, await target("target-resend"));
  const approval = await approveFor(plan);
  const before = await counts();
  const results = await Promise.all([
    commitWith("op-resend", plan, approval.approvalId),
    commitWith("op-resend", plan, approval.approvalId),
  ]);
  const accepted = results.filter((result) => result.ok);
  expect(accepted).toHaveLength(2);
  const receipts = accepted.map((result) => (result.ok ? result.receipt : null));
  expect(receipts[0]).toEqual(receipts[1]!);
  const after = await counts();
  expect(after.receipts).toBe(before.receipts + 1);
  expect(after.mappings).toBe(before.mappings + 1);
  expect(after.outbox).toBe(before.outbox + 2);
});

test("relations are accepted as typed claims with their own decision; rejecting appends a new revision", async () => {
  const mapping = await seedParse(207, "smbc-bank:relation");
  const payload = {
    relationKind: "connection_contains" as const,
    fromRef: "connection:collector-r2-importer/synthetic",
    toRef: `source_account:${mapping.ref}`,
    validFrom: null,
    validTo: null,
    evidenceRefs: ["fetch_artifact:207"],
    reason: "the connection detail names this leaf",
  };
  const planned = await createPlan(
    "relation.accept",
    payload,
    { actor: operator, baseContextId: "identity-current-v1", now: NOW, ttlSeconds: 900 },
    store,
  );
  expect(planned.ok).toBe(true);
  if (!planned.ok) throw new Error("unreachable");
  expect(planned.plan.simulation.before.relations).toBe(0);
  expect(planned.plan.simulation.after.relations).toBe(1);
  const approval = await approveFor(planned.plan);
  const committed = await commitWith("op-relation-accept", planned.plan, approval.approvalId);
  expect(committed).toMatchObject({ ok: true });
  if (!committed.ok) throw new Error("unreachable");
  const relation = await db
    .prepare("SELECT * FROM entity_relations WHERE id=?")
    .bind(String(committed.receipt.result.relationId))
    .first<Record<string, unknown>>();
  expect(relation).toMatchObject({
    kind: "connection_contains",
    from_ref: payload.fromRef,
    to_ref: payload.toRef,
    status: "accepted",
    decision_revision_id: committed.receipt.decisionRevisionId,
  });
  // No transitive closure: accepting connection_contains creates nothing else
  // and never a same_account claim (SC06).
  expect(
    await db
      .prepare("SELECT count(*) n FROM entity_relations WHERE kind='same_account'")
      .first<number>("n"),
  ).toBe(0);

  // Rejecting the same triple is a second revision, not a delete.
  const rejected = await createPlan(
    "relation.reject",
    { ...payload, reason: "the branch artifact contradicts it" },
    { actor: operator, baseContextId: "identity-current-v1", now: NOW, ttlSeconds: 900 },
    store,
  );
  expect(rejected.ok).toBe(true);
  if (!rejected.ok) throw new Error("unreachable");
  expect(rejected.plan.expectedRevisions).toEqual({
    [`relation:connection_contains|${payload.fromRef}|${payload.toRef}`]: 1,
  });
  const rejectApproval = await approveFor(rejected.plan);
  const rejectResult = await commitWith(
    "op-relation-reject",
    rejected.plan,
    rejectApproval.approvalId,
  );
  expect(rejectResult).toMatchObject({ ok: true });
  expect(
    await db
      .prepare("SELECT count(*) n FROM entity_relations WHERE kind=? AND from_ref=? AND to_ref=?")
      .bind(payload.relationKind, payload.fromRef, payload.toRef)
      .first<number>("n"),
  ).toBe(2);
});

test("an agent may plan and simulate but never approve or commit", async () => {
  const mapping = await seedParse(208, "smbc-bank:agent");
  const plan = await planFor(mapping.ref, await target("target-agent"), agent);
  expect(plan.createdBy).toBe(agent.id);
  const report = await simulate(plan, store);
  expect(report.ok).toBe(true);
  expect(
    await approve(store, {
      planId: plan.planId,
      planDigest: plan.planDigest,
      actor: agent,
      scope: [],
      ttlSeconds: 600,
      now: NOW,
    }),
  ).toMatchObject({ ok: false, error: "approval_required" });
  const approval = await approveFor(plan);
  // Even with a human's approval in hand, an agent cannot commit it.
  expect(await commitWith("op-agent", plan, approval.approvalId, NOW, agent)).toMatchObject({
    ok: false,
    error: "approval_required",
  });
  expect(
    await db
      .prepare("SELECT count(*) n FROM operation_receipts WHERE principal=?")
      .bind(agent.id)
      .first<number>("n"),
  ).toBe(0);
});

test("an approval is bound to its plan digest, its expiry and its uses", async () => {
  const mapping = await seedParse(209, "smbc-bank:approval");
  const plan = await planFor(mapping.ref, await target("target-approval"));
  expect(
    await approve(store, {
      planId: plan.planId,
      planDigest: `${"0".repeat(63)}1`,
      actor: operator,
      scope: [],
      ttlSeconds: 600,
      now: NOW,
    }),
  ).toMatchObject({ ok: false, error: "stale_context" });
  const approval = await approveFor(plan);
  expect(approval.planDigest).toBe(plan.planId);
  expect(await commitWith("op-approval-late", plan, approval.approvalId, later(700))).toMatchObject(
    { ok: false, error: "approval_expired" },
  );
  expect(await commitWith("op-approval-missing", plan, "ap_nothing")).toMatchObject({
    ok: false,
    error: "approval_not_found",
  });
  // A scope that does not cover the plan's subject refuses the commit.
  const scoped = await approve(store, {
    planId: plan.planId,
    planDigest: plan.planDigest,
    actor: operator,
    scope: ["account_mapping:something-else"],
    ttlSeconds: 600,
    now: NOW,
  });
  expect(scoped.ok).toBe(true);
  if (!scoped.ok) throw new Error("unreachable");
  expect(await commitWith("op-approval-scope", plan, scoped.approval.approvalId)).toMatchObject({
    ok: false,
    error: "approval_scope_mismatch",
  });
});

test("the outbox publishes an accepted receipt once, and a duplicate delivery changes nothing", async () => {
  const mapping = await seedParse(210, "smbc-bank:outbox");
  const plan = await planFor(mapping.ref, await target("target-outbox"));
  const approval = await approveFor(plan);
  const committed = await commitWith("op-outbox", plan, approval.approvalId);
  expect(committed).toMatchObject({ ok: true });
  const rows = await db
    .prepare(
      "SELECT target,processed_at,attempts FROM decision_outbox WHERE operation_id='op-outbox' ORDER BY target",
    )
    .all<{ target: string; processed_at: string | null; attempts: number }>();
  expect(rows.results.map((row) => row.target)).toEqual([
    "balance-projection",
    "identity-projection",
  ]);
  expect(rows.results.every((row) => row.processed_at === null)).toBe(true);
  // Accepted is not published (addendum 10 section 5).
  expect(
    (await getReceipt(store, operator.id, "op-outbox")) as { receipt: { status: string } },
  ).toMatchObject({ receipt: { status: "accepted", publishedAt: null } });

  const first = await dispatchDecisionOutbox(db, { limit: 50 });
  expect(first.processed).toBeGreaterThanOrEqual(2);
  expect(first.published).toBeGreaterThanOrEqual(1);
  const published = await getReceipt(store, operator.id, "op-outbox");
  expect(published).toMatchObject({ ok: true });
  if (!published.ok) throw new Error("unreachable");
  expect(published.receipt.status).toBe("published");
  expect(published.receipt.publishedAt).not.toBeNull();
  // The immutable part of the receipt is unchanged by publication.
  expect(published.receipt.decisionRevisionId).toBe(
    committed.ok ? committed.receipt.decisionRevisionId : "",
  );

  // A duplicate or out-of-order delivery is a no-op: processed rows are never
  // reopened and the receipt is not published twice.
  const snapshot = await db
    .prepare(
      "SELECT id,processed_at,outcome,attempts FROM decision_outbox WHERE operation_id='op-outbox' ORDER BY id",
    )
    .all();
  const second = await dispatchDecisionOutbox(db, { limit: 50 });
  expect(second.claimed).toBe(0);
  expect(second.published).toBe(0);
  expect(
    (
      await db
        .prepare(
          "SELECT id,processed_at,outcome,attempts FROM decision_outbox WHERE operation_id='op-outbox' ORDER BY id",
        )
        .all()
    ).results,
  ).toEqual(snapshot.results);
  expect(
    await db
      .prepare(
        "SELECT count(*) n FROM operation_receipts WHERE status='published' AND published_at IS NULL",
      )
      .first<number>("n"),
  ).toBe(0);
});

test("an outbox target that throws is retried with backoff and never marked processed", async () => {
  const mapping = await seedParse(211, "smbc-bank:retry");
  const plan = await planFor(mapping.ref, await target("target-retry"));
  const approval = await approveFor(plan);
  expect((await commitWith("op-retry", plan, approval.approvalId)).ok).toBe(true);
  const failing = await dispatchDecisionOutbox(db, {
    limit: 50,
    processors: {
      "identity-projection": () => Promise.reject(new Error("synthetic outage amount=999999")),
    },
  });
  expect(failing.failed).toBeGreaterThanOrEqual(1);
  const row = await db
    .prepare(
      "SELECT processed_at,attempts,last_error_code,available_at_ms,lease_token FROM decision_outbox WHERE operation_id='op-retry' AND target='identity-projection'",
    )
    .first<{
      processed_at: string | null;
      attempts: number;
      last_error_code: string | null;
      available_at_ms: number;
      lease_token: string | null;
    }>();
  expect(row).toMatchObject({ processed_at: null, attempts: 1, last_error_code: "Error" });
  expect(row!.available_at_ms).toBeGreaterThan(Date.now());
  expect(row!.lease_token).toBeNull();
  // Nothing of the provider or the amount reaches the stored error code.
  expect(row!.last_error_code).not.toContain("999999");
  // The receipt stays accepted while any target is unprocessed.
  const receipt = await getReceipt(store, operator.id, "op-retry");
  expect(receipt).toMatchObject({ ok: true });
  if (!receipt.ok) throw new Error("unreachable");
  expect(receipt.receipt.status).toBe("accepted");
});

test("the internal command routes require a verified actor and refuse an agent's approval", async () => {
  const mapping = await seedParse(212, "smbc-bank:route");
  const targetId = await target("target-route");
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await mf.dispatchFetch(`https://pipeline.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  const human = { "x-kogane-verified-actor": operator.id, "x-kogane-actor-kind": "human" };
  const asAgent = { "x-kogane-verified-actor": agent.id, "x-kogane-actor-kind": "agent" };
  const payload = {
    subject: "account",
    referenceId: mapping.ref,
    targetId,
    reason: "route test",
  };
  expect((await post("/command/v1/plan", { kind: "identity.assign", payload })).status).toBe(400);
  const planned = await post("/command/v1/plan", { kind: "identity.assign", payload }, asAgent);
  expect(planned.status).toBe(200);
  const plan = planned.json.plan as ChangePlan;
  expect(plan.createdBy).toBe(agent.id);
  expect(
    await post("/command/v1/approve", { planId: plan.planId, planDigest: plan.planId }, asAgent),
  ).toMatchObject({ status: 403, json: { error: "approval_required" } });
  const approved = await post(
    "/command/v1/approve",
    { planId: plan.planId, planDigest: plan.planId },
    human,
  );
  expect(approved.status).toBe(200);
  const approvalId = (approved.json.approval as { approvalId: string }).approvalId;
  expect(
    await post(
      "/command/v1/commit",
      { operationId: "op-route", planId: plan.planId, approvalId },
      asAgent,
    ),
  ).toMatchObject({ status: 403, json: { error: "approval_required" } });
  const committed = await post(
    "/command/v1/commit",
    { operationId: "op-route", planId: plan.planId, approvalId },
    human,
  );
  expect(committed.status).toBe(200);
  expect(committed.json.receipt).toMatchObject({ status: "accepted", operationId: "op-route" });
  const looked = await post("/command/v1/operation", { operationId: "op-route" }, human);
  expect(looked.json.receipt).toMatchObject({ operationId: "op-route" });
  // The operation namespace is per principal.
  expect(await post("/command/v1/operation", { operationId: "op-route" }, asAgent)).toMatchObject({
    status: 404,
    json: { error: "receipt_not_found" },
  });
  // Unknown command paths and non-POST methods are not this route's.
  expect(
    (await mf.dispatchFetch("https://pipeline.internal/command/v1/plan", { method: "GET" })).status,
  ).toBe(405);
  expect(
    (await mf.dispatchFetch("https://pipeline.internal/command/v1/delete", { method: "POST" }))
      .status,
  ).toBe(404);
});

test("plans, approvals, receipts and outbox rows are append-only except their own state columns", async () => {
  const receipt = await db
    .prepare("SELECT operation_id,plan_id FROM operation_receipts LIMIT 1")
    .first<{ operation_id: string; plan_id: string }>();
  expect(receipt).not.toBeNull();
  const rejected = async (sql: string, ...binds: unknown[]) => {
    let failed = false;
    try {
      await db
        .prepare(sql)
        .bind(...binds)
        .run();
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  };
  await rejected("DELETE FROM operation_receipts WHERE operation_id=?", receipt!.operation_id);
  await rejected("DELETE FROM decision_outbox WHERE 1=1");
  await rejected("DELETE FROM change_plans WHERE plan_id=?", receipt!.plan_id);
  await rejected("DELETE FROM approvals WHERE 1=1");
  await rejected(
    "UPDATE operation_receipts SET payload_digest=? WHERE operation_id=?",
    "0".repeat(64),
    receipt!.operation_id,
  );
  await rejected("UPDATE change_plans SET payload_json='{}' WHERE plan_id=?", receipt!.plan_id);
  await rejected("UPDATE approvals SET uses_remaining=uses_remaining+1 WHERE 1=1");
  await rejected("UPDATE decision_outbox SET target='agent-notify' WHERE 1=1");
});

test("migration 0031 applies on a seeded 0017-0035 schema and touches no existing row", async () => {
  const local = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response('test'); } };",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
      r2Buckets: ["EVIDENCE"],
    }),
  );
  try {
    const local1 = (await local.getD1Database("DB")) as unknown as D1Database;
    await local1.exec(LAYER_A_SQL);
    const apply = async (names: string[]) => {
      for (const name of names)
        for (const sql of splitSql(readFileSync(new URL(name, migrationDir), "utf8")))
          await local1.prepare(sql).run();
    };
    const migrations = layerBMigrations();
    expect(migrations).toContain("0031_operations.sql");
    expect(migrations).toContain("0029_decision_log.sql");
    await apply(migrations.filter((name) => name !== "0031_operations.sql"));
    await local1.batch([
      local1.prepare("INSERT INTO sources VALUES('smbc-bank','synthetic')"),
      local1.prepare(`INSERT INTO producers VALUES('${PRODUCER}')`),
      local1.prepare(
        `INSERT INTO source_accounts VALUES('ref-x','smbc-bank','${PRODUCER}','["x"]')`,
      ),
      local1.prepare("INSERT INTO accounts VALUES('acct-x','X','deposit','provider-local')"),
      local1.prepare(
        "INSERT INTO account_mappings VALUES('am-x-1','ref-x',1,'acct-x','rule','policy',1,'2098-01-01','X','provider-local')",
      ),
    ]);
    const snapshot = async () => [
      (await local1.prepare("SELECT * FROM account_mappings ORDER BY id").all()).results,
      (await local1.prepare("SELECT * FROM decision_revisions ORDER BY id").all()).results,
      (await local1.prepare("SELECT * FROM entity_relations ORDER BY id").all()).results,
    ];
    const before = await snapshot();
    await apply(["0031_operations.sql"]);
    expect(await snapshot()).toEqual(before);
    for (const table of ["change_plans", "approvals", "operation_receipts", "decision_outbox"])
      expect(await local1.prepare(`SELECT count(*) n FROM ${table}`).first<number>("n")).toBe(0);
  } finally {
    await local.dispose();
  }
}, 120_000);

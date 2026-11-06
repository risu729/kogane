// The bounded, resumable balance projection job (review D10/D11, addendum
// A07) on the production schema, including migration 0030 and every
// append-only trigger. Synthetic evidence only: no real account, balance or
// provider body appears here.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { scopeRelationsFromEntityRelations } from "../../../packages/read-model/src/index";
import {
  balanceProjectionOutboxProcessor,
  captureFixedInput,
  currentCoreRevision,
  runBalanceProjection,
} from "../src/balance-projection-job.ts";
import {
  DEFAULT_PROCESSORS,
  dispatchDecisionOutbox,
  type OutboxRow,
} from "../src/decision-outbox.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;
/** The job reads the flag from the environment; the harness binds none. */
const on = (): Env => ({ ...env, BALANCE_PROJECTION_ENABLED: "1" }) as unknown as Env;
const off = (): Env => ({ ...env, BALANCE_PROJECTION_ENABLED: "0" }) as unknown as Env;

beforeAll(async () => {
  ({ mf, env } = await startPipeline());
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

async function parse(artifactId: number, parser: string, version = "1"): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,?,?,'2026-09-07T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(artifactId, parser, version)
    .first<{ id: number }>();
  await publishParse(env.DB, row!.id);
  return row!.id;
}

async function balance(
  parseRunId: number,
  account: string,
  metric: string,
  amountMinor: number,
  asOf: string,
  locator = account + metric,
): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO balance_observations
       (parse_run_id,source_account,metric,instrument,amount_minor,as_of,observed_at,raw_locator,extra_json)
     VALUES (?,?,?,'JPY',?,?, '2026-09-07T00:00:00Z',?,'{}') RETURNING id`,
  )
    .bind(parseRunId, account, metric, amountMinor, asOf, locator)
    .first<{ id: number }>();
  return row!.id;
}

/** The row the dispatcher hands a processor, with the revision it stamps. */
async function outboxRow(): Promise<OutboxRow> {
  return {
    id: 1,
    decision_revision_id: "dr_probe",
    principal: "operator:1",
    operation_id: "op_probe",
    target: "balance-projection",
    attempts: 1,
    required_source_revision: (await currentCoreRevision(env.DB)).source_revision,
  };
}

const count = async (sql: string, ...args: unknown[]): Promise<number> =>
  (await (
    /\b(balance_read_snapshots|current_balance_projection|scope_relations|balance_snapshot_pointer)\b/u.test(
      sql,
    )
      ? env.READ
      : env.DB
  )
    .prepare(sql)
    .bind(...args)
    .first<{ n: number }>())!.n;

test("the flag is off by default and the job writes nothing", async () => {
  const result = await runBalanceProjection(off());
  expect(result).toMatchObject({ enabled: false, status: "skipped", reasonCode: "flag_off" });
  expect(await count("SELECT count(*) AS n FROM balance_read_snapshots")).toBe(0);
  expect(await count("SELECT count(*) AS n FROM current_balance_projection")).toBe(0);
}, 30000);

test("a build seals one snapshot and records every candidate with its state", async () => {
  await seedArtifact(env, 101, "smbc-bank", "balance-normalized", "balances.json", {
    synthetic: true,
  });
  const run = await parse(101, "smbc-direct-balance");
  await balance(run, "smbc:ordinary", "account_balance", 60000, "2026-09-08");
  await balance(run, "smbc:savings", "account_balance", 100000, "2026-09-07");

  const result = await runBalanceProjection(on());
  expect(result).toMatchObject({ enabled: true, status: "complete", rowCount: 2 });
  expect(result.snapshotId).toMatch(/^[0-9a-f]{64}$/u);
  const rows = await env.READ.prepare(
    `SELECT scope_key,state,reason_code,metric_id,quantity_coefficient,unit_ref,row_seq,
            evidence_count,as_of_kind,freshness,latest_in_group
     FROM current_balance_projection WHERE snapshot_id=?1 ORDER BY row_seq`,
  )
    .bind(result.snapshotId)
    .all<Record<string, unknown>>();
  // Two distinct accounts of one bank: the provider listed them apart, so
  // both are adopted and neither is a possible duplicate of the other.
  expect(rows.results.map((row) => row.state)).toEqual(["adopted", "adopted"]);
  expect(rows.results.map((row) => row.metric_id)).toEqual(["deposit.balance", "deposit.balance"]);
  // Ordered by effective time descending, position dense from zero.
  expect(rows.results.map((row) => row.quantity_coefficient)).toEqual(["60000", "100000"]);
  expect(rows.results.map((row) => row.row_seq)).toEqual([0, 1]);
  expect(rows.results.every((row) => row.evidence_count === 1)).toBe(true);
  expect(rows.results.every((row) => row.as_of_kind === "local-date")).toBe(true);
  expect(rows.results.every((row) => row.freshness === "current")).toBe(true);
  expect(rows.results.every((row) => row.latest_in_group === 1)).toBe(true);
  // Sealed exactly once, and readable only as a complete snapshot.
  expect(
    await count("SELECT count(*) AS n FROM balance_read_snapshots WHERE status='complete'"),
  ).toBe(1);
}, 60000);

test("the same inputs rebuild to the same snapshot id and do no work twice", async () => {
  const first = await runBalanceProjection(on());
  expect(first.status).toBe("unchanged");
  expect(first.written).toBe(0);
  const second = await runBalanceProjection(on());
  expect(second.snapshotId).toBe(first.snapshotId);
  expect(await count("SELECT count(*) AS n FROM balance_read_snapshots")).toBe(1);
}, 30000);

test("a sealed snapshot is immutable and its rows cannot be edited or deleted", async () => {
  const snapshot = await env.READ.prepare(
    "SELECT snapshot_id FROM balance_read_snapshots WHERE status='complete' LIMIT 1",
  ).first<{ snapshot_id: string }>();
  await expect(
    env.READ.prepare("UPDATE current_balance_projection SET state='adopted' WHERE snapshot_id=?1")
      .bind(snapshot!.snapshot_id)
      .run(),
  ).rejects.toThrow(/sealed read snapshot is immutable/u);
  await expect(
    env.READ.prepare("DELETE FROM current_balance_projection WHERE snapshot_id=?1")
      .bind(snapshot!.snapshot_id)
      .run(),
  ).rejects.toThrow(/retire the snapshot/u);
  // A complete snapshot never goes back to building.
  await expect(
    env.READ.prepare("UPDATE balance_read_snapshots SET status='building' WHERE snapshot_id=?1")
      .bind(snapshot!.snapshot_id)
      .run(),
  ).rejects.toThrow(/invalid read snapshot transition/u);
}, 30000);

test("a new publication makes a new snapshot and retires the oldest builds", async () => {
  await seedArtifact(env, 102, "sony-bank", "gross-balance", "balances-2.json", {
    synthetic: true,
  });
  const run = await parse(102, "sony-bank-gross-balance");
  await balance(run, "sony:gross", "gross_asset_balance", 5000, "2026-09-09");
  const second = await runBalanceProjection(on());
  expect(second.status).toBe("complete");
  expect(second.rowCount).toBe(3);

  await seedArtifact(env, 103, "smbc-bank", "balance-normalized", "balances-3.json", {
    synthetic: true,
  });
  const third = await parse(103, "smbc-direct-balance");
  await balance(third, "smbc:third", "account_balance", 1, "2026-09-10");
  const latest = await runBalanceProjection(on());
  expect(latest.status).toBe("complete");
  expect(latest.snapshotId).not.toBe(second.snapshotId);
  // The retained window keeps one previous build so an open cursor survives;
  // anything older is retired first and only then loses its rows.
  expect(
    await count("SELECT count(*) AS n FROM balance_read_snapshots WHERE status='complete'"),
  ).toBeLessThanOrEqual(2);
  const retired = await env.READ.prepare(
    "SELECT snapshot_id FROM balance_read_snapshots WHERE status='retired'",
  ).all<{ snapshot_id: string }>();
  for (const row of retired.results)
    expect(
      await count(
        "SELECT count(*) AS n FROM current_balance_projection WHERE snapshot_id=?1",
        row.snapshot_id,
      ),
    ).toBe(0);
}, 60000);

test("a build is bounded per invocation and resumes from its cursor", async () => {
  await seedArtifact(env, 104, "smbc-bank", "balance-normalized", "balances-4.json", {
    synthetic: true,
  });
  const run = await parse(104, "smbc-direct-balance");
  for (let index = 0; index < 6; index += 1)
    await balance(run, `smbc:bounded-${String(index)}`, "account_balance", index + 1, "2026-09-11");

  const first = await runBalanceProjection(on(), { writeBudget: 2 });
  expect(first.status).toBe("building");
  expect(first.written).toBe(2);
  // A building snapshot is never a read target: it has no completed_at.
  expect(
    await count(
      "SELECT count(*) AS n FROM balance_read_snapshots WHERE snapshot_id=?1 AND status='building' AND completed_at IS NULL",
      first.snapshotId!,
    ),
  ).toBe(1);
  let result = first;
  for (let step = 0; step < 10 && result.status === "building"; step += 1)
    result = await runBalanceProjection(on(), { writeBudget: 2 });
  expect(result.status).toBe("complete");
  expect(result.snapshotId).toBe(first.snapshotId);
  expect(
    await count(
      "SELECT count(*) AS n FROM current_balance_projection WHERE snapshot_id=?1",
      result.snapshotId!,
    ),
  ).toBe(result.rowCount);
}, 60000);

/**
 * An accepted decision changes which scopes overlap, and therefore which
 * candidates are adopted, without publishing a single new parse. The outbox
 * processor A09 hands to A07 is what turns "the decision was published" into
 * "the read model was rebuilt", and it must be safe to deliver twice.
 */
test("a published decision rebuilds the projection through the outbox, once", async () => {
  const before = await runBalanceProjection(on());
  expect(before.status).toBe("unchanged");
  const beforeRevision = (await currentCoreRevision(env.DB)).source_revision;

  // One accepted `same_account` relation, recorded the way a command does.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,
        actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES('dr_outbox_1','relation','rel_outbox_1',1,'accept','manual','operator:1',NULL,
        'Synthetic: the two routes report one account.','[]',NULL,NULL,'2026-09-12T00:00:00Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,
        decision_revision_id,evidence_refs_json,created_at)
       VALUES('rel_outbox_1','same_account','source_account:synthetic:a','source_account:synthetic:b',
        NULL,NULL,'accepted','dr_outbox_1','[]','2026-09-12T00:00:00Z')`,
    ),
  ]);

  // The adopted relations are a declared input, so the context has moved.
  expect((await currentCoreRevision(env.DB)).source_revision).toBeGreaterThan(beforeRevision);

  const processor = balanceProjectionOutboxProcessor(on());
  const row = await outboxRow();
  const first = await processor(env.DB, row);
  const afterId = (await env.READ.prepare(
    "SELECT snapshot_id FROM balance_snapshot_pointer WHERE id=1",
  ).first<{ snapshot_id: string }>())!.snapshot_id;
  // Completed carries the evidence: the snapshot the read model publishes,
  // not "a rebuild was started".
  expect(first).toEqual({
    status: "completed",
    evidence: { code: "balance_projection_active", ref: afterId },
  });
  expect(
    await count(
      "SELECT count(*) AS n FROM balance_read_snapshots WHERE snapshot_id=?1 AND status='complete'",
      afterId,
    ),
  ).toBe(1);

  // Delivered again: idempotent, and it does not rebuild a second time. The
  // active pointer already covers the revision, so the second delivery answers
  // from it without touching the projection (05 section 5).
  const snapshots = await count("SELECT count(*) AS n FROM balance_read_snapshots");
  expect(await processor(env.DB, row)).toEqual({
    status: "completed",
    evidence: { code: "balance_projection_active", ref: afterId },
  });
  expect(await count("SELECT count(*) AS n FROM balance_read_snapshots")).toBe(snapshots);

  // With the flag off nothing is written and nothing is completed: the row
  // stays open, because no read model was updated (05 section 6).
  expect(await balanceProjectionOutboxProcessor(off())(env.DB, row)).toEqual({
    status: "pending",
    progress: "projection_flag_off",
  });
}, 60000);

test("the dispatcher routes the balance-projection target to that processor", async () => {
  // The FK chain a committed operation leaves behind, written directly: the
  // command path itself is covered by change-lifecycle.test.ts, and what is
  // under test here is only which processor the target reaches.
  const planId = "b".repeat(64);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,
        actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES('dr_outbox_2','relation','rel_outbox_2',1,'accept','manual','operator:1',NULL,
        'Synthetic: a second accepted correspondence.','[]',NULL,NULL,'2026-09-12T01:00:00Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,
        decision_revision_id,evidence_refs_json,created_at)
       VALUES('rel_outbox_2','same_account','source_account:synthetic:c','source_account:synthetic:d',
        NULL,NULL,'accepted','dr_outbox_2','[]','2026-09-12T01:00:00Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO change_plans(plan_id,kind,payload_json,base_context_id,expected_revisions_json,
        simulation_json,created_by,created_at,expires_at,status)
       VALUES(?1,'relation.accept','{}','identity-current-v1','{}','{}','operator:1',
        '2026-09-12T01:00:00Z','2026-09-12T02:00:00Z','committed')`,
    ).bind(planId),
    env.DB.prepare(
      `INSERT INTO operation_receipts(operation_id,principal,operation_kind,payload_digest,plan_id,
        status,result_json,created_at,published_at)
       VALUES('op_outbox_2','operator:1','relation.accept',?2,?1,'accepted','{}',
        '2026-09-12T01:00:00Z',NULL)`,
    ).bind(planId, "c".repeat(64)),
    env.DB.prepare(
      `INSERT INTO decision_outbox(decision_revision_id,principal,operation_id,target,
        enqueued_at,available_at_ms)
       VALUES('dr_outbox_2','operator:1','op_outbox_2','balance-projection','2026-09-12T01:00:00Z',0)`,
    ),
  ]);
  const result = await dispatchDecisionOutbox(env.DB, {
    processors: { "balance-projection": balanceProjectionOutboxProcessor(on()) },
  });
  expect(result.claimed).toBe(1);
  expect(result.processed).toBe(1);
  expect(result.failed).toBe(0);
  expect(Object.keys(result.outcomes)).toEqual(["balance_projection_active"]);
  // The operation's only row is processed, so the receipt is published: the
  // judgement was accepted long before every screen was current.
  expect(result.published).toBe(1);
  // A second pass finds nothing to claim: the row is processed, not repeated.
  const again = await dispatchDecisionOutbox(env.DB, {
    processors: { "balance-projection": balanceProjectionOutboxProcessor(on()) },
  });
  expect(again.claimed).toBe(0);

  // Nothing stands in for A07 by default: the target has no entry in
  // `DEFAULT_PROCESSORS`, so a caller that forgets to hand the real processor
  // in leaves the row blocked rather than closing it with a placeholder
  // outcome that never touched the projection (05 section 6).
  expect(DEFAULT_PROCESSORS["balance-projection"]).toBeUndefined();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,
        actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES('dr_outbox_3','relation','rel_outbox_3',1,'accept','manual','operator:1',NULL,
        'Synthetic: a third accepted correspondence.','[]',NULL,NULL,'2026-09-12T01:30:00Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO decision_outbox(decision_revision_id,principal,operation_id,target,
        enqueued_at,available_at_ms)
       VALUES('dr_outbox_3','operator:1','op_outbox_2','balance-projection','2026-09-12T01:30:00Z',0)`,
    ),
  ]);
  const unowned = await dispatchDecisionOutbox(env.DB);
  expect(unowned.claimed).toBe(1);
  expect(unowned.blocked).toBe(1);
  expect(unowned.processed).toBe(0);
  expect(unowned.outcomes).toEqual({ "blocked:no_processor": 1 });
  expect(
    await count(
      "SELECT count(*) AS n FROM decision_outbox WHERE decision_revision_id='dr_outbox_3' AND processed_at IS NULL AND blocked_code='no_processor'",
    ),
  ).toBe(1);
}, 60000);

/**
 * A relation's decisions are append-only: `relation.reject` writes a new
 * `entity_relations` row for the same (kind, from, to) and leaves the earlier
 * acceptance in place. The projection reads the newest decision of each
 * triple, ordered as the change lifecycle orders a relation's history
 * (`created_at`, then `id`, newest first), so a later rejection withdraws the
 * acceptance and a later acceptance overrides an earlier rejection; a later
 * proposal changes nothing (ADR 0001's amendment of 2026-11-06).
 */
test("a later decision on a relation triple supersedes an earlier one in the projection input", async () => {
  const decide = (
    id: string,
    kind: string,
    from: string,
    to: string,
    status: "accepted" | "rejected" | "proposed",
    at: string,
  ) => [
    env.DB.prepare(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,
        actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES(?1,'relation',?2,1,?3,'manual','operator:1',NULL,'Synthetic relation decision.','[]',
        NULL,NULL,?4)`,
    ).bind(
      `dr_${id}`,
      `rel_${id}`,
      status === "accepted" ? "accept" : status === "rejected" ? "reject" : "propose",
      at,
    ),
    env.DB.prepare(
      `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,
        decision_revision_id,evidence_refs_json,created_at)
       VALUES(?1,?2,?3,?4,NULL,NULL,?5,?6,'[]',?7)`,
    ).bind(`rel_${id}`, kind, from, to, status, `dr_${id}`, at),
  ];
  const a = "source_account:sup:a";
  const b = "source_account:sup:b";
  const x = "connection:sup/x";
  const e = "source_account:sup:e";
  const f = "source_account:sup:f";
  await env.DB.batch([
    // Accepted, then rejected: withdrawn. The rejection's id sorts first, so
    // the order is by time, not by id.
    ...decide("sup_9", "same_account", a, b, "accepted", "2026-09-13T00:00:00Z"),
    ...decide("sup_1", "same_account", a, b, "rejected", "2026-09-13T01:00:00Z"),
    // Rejected, then accepted: in force.
    ...decide(
      "sup_2",
      "connection_contains",
      x,
      "source_account:sup:c",
      "rejected",
      "2026-09-13T00:00:00Z",
    ),
    ...decide(
      "sup_3",
      "connection_contains",
      x,
      "source_account:sup:c",
      "accepted",
      "2026-09-13T01:00:00Z",
    ),
    // The same instant: the higher id is the newer decision.
    ...decide(
      "sup_4",
      "connection_contains",
      x,
      "source_account:sup:d",
      "accepted",
      "2026-09-13T02:00:00Z",
    ),
    ...decide(
      "sup_5",
      "connection_contains",
      x,
      "source_account:sup:d",
      "rejected",
      "2026-09-13T02:00:00Z",
    ),
    // Proposed, then accepted; the reverse direction is a triple of its own.
    ...decide("sup_6", "same_account", e, f, "proposed", "2026-09-13T00:00:00Z"),
    ...decide("sup_7", "same_account", e, f, "accepted", "2026-09-13T01:00:00Z"),
    ...decide("sup_8", "same_account", f, e, "rejected", "2026-09-13T02:00:00Z"),
    // Accepted, then proposed again (by an agent, say): a proposal never
    // supersedes a decision, so the acceptance stays in force (INV07).
    ...decide("sup_a", "account_has_pocket", e, "pocket:sup/g", "accepted", "2026-09-13T00:00:00Z"),
    ...decide("sup_b", "account_has_pocket", e, "pocket:sup/g", "proposed", "2026-09-13T01:00:00Z"),
  ]);
  const capture = await captureFixedInput(env.DB);
  if (!capture.ok) throw new Error(`capture failed: ${capture.code}`);
  const relations = scopeRelationsFromEntityRelations(capture.captured.input.content.relations)
    .filter((relation) => /:sup[:/]/u.test(relation.fromScopeKey))
    .map(({ fromScopeKey, toScopeKey, relation, decisionRevisionId }) => ({
      fromScopeKey,
      toScopeKey,
      relation,
      decisionRevisionId,
    }));
  expect(relations).toEqual([
    {
      fromScopeKey: "source_account:sup:c",
      toScopeKey: x,
      relation: "subset",
      decisionRevisionId: "dr_sup_3",
    },
    { fromScopeKey: e, toScopeKey: f, relation: "same", decisionRevisionId: "dr_sup_7" },
    {
      fromScopeKey: "pocket:sup/g",
      toScopeKey: e,
      relation: "subset",
      decisionRevisionId: "dr_sup_a",
    },
  ]);
  // Only the current row of each triple is a declared input.
  expect(
    capture.captured.input.content.relations
      .filter((row) => row.id.startsWith("rel_sup_"))
      .map((row) => row.id),
  ).toEqual(["rel_sup_1", "rel_sup_3", "rel_sup_5", "rel_sup_7", "rel_sup_8", "rel_sup_a"]);
}, 60000);

// The `lane` audit records (ADR 0064, plan slice S7): one record per tick of a
// lane that wrote rule decisions, economic commits or proposals, naming what it
// wrote by range and nothing else; idle ticks, lanes that write none of these
// and flags that are off write nothing.
//
// The stages here write synthetic rows straight into the tables a lane writes
// (every id, digest and code below is invented), together with rows another
// writer could add while the lane runs — an operator's decision, an agent's
// proposal — which the record must not name. The purchase recognition lane's
// own rows are covered end to end in `card-purchase-lane-audit.test.ts`.
import { afterAll, beforeEach, expect } from "bun:test";
import type { Miniflare } from "miniflare";
import {
  LANE_AUDIT,
  markLaneAudit,
  RECONCILIATION_RULE_ACTOR,
  recordLaneAudit,
  resolveLaneRef,
} from "../src/lane-audit.ts";
import { LANE_TICK_COUNTS } from "../src/lane-ticks.ts";
import { runScheduled, type ScheduledStages } from "../src/worker.ts";
import { startPipeline } from "./harness.ts";
import { settledTest } from "./support/settle.ts";

let mf: Miniflare;
let env: Env;
// Started while the module loads, never in a hook (test/support/settle.ts).
({ mf, env } = await startPipeline());
const test = settledTest();
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  await env.DB.prepare("DELETE FROM processor_lane_ticks").run();
});

interface AuditRow {
  audit_id: string;
  path: string;
  subject: string | null;
  principal: string;
  principal_kind: string;
  operation: string;
  risk_class: string;
  step: string;
  scope_namespace: string | null;
  target_ref: string | null;
  result: string;
  result_code: string | null;
  correlation_id: string;
  refs_json: string;
  diff_json: string;
}

async function laneRecords(): Promise<AuditRow[]> {
  return (
    await env.DB.prepare(
      "SELECT * FROM audit_records WHERE path='lane' ORDER BY recorded_at,audit_id",
    ).all<AuditRow>()
  ).results;
}

let sequence = 0;
const hex = (n: number) => n.toString(16).padStart(64, "0");

/** A rule (or other-method) relation decision, as a lane or another writer appends one. */
async function decision(actor: string, method = "rule"): Promise<string> {
  sequence += 1;
  const id = `dr_synthetic_${sequence}`;
  await env.DB.prepare(
    `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
     VALUES(?,'relation',?,1,'accept',?,?,NULL,'synthetic reason','[]',NULL,NULL,'2026-11-06T00:00:00.000Z')`,
  )
    .bind(id, `rel_synthetic_${sequence}`, method, actor)
    .run();
  return id;
}

/** A reconciliation proposal of `kind` under `method`. */
async function proposal(kind: string, method = "rule"): Promise<string> {
  sequence += 1;
  const id = `rp_${hex(sequence)}`;
  await env.DB.prepare(
    `INSERT INTO reconciliation_proposals(id,kind,stage,target_refs_json,method,policy_release,
      rationale_codes_json,rejection_conditions_json,evidence_refs_json,status,decision_revision_id,proposal_digest,created_at)
     VALUES(?,?,'A',?,?,'synthetic-policy','[]','[]','[]','proposed',NULL,?,'2026-11-06T00:00:00.000Z')`,
  )
    .bind(
      id,
      kind,
      JSON.stringify([
        { kind: "transaction", id: `transaction:${sequence}a`, revision: 1 },
        { kind: "transaction", id: `transaction:${sequence}b`, revision: 1 },
      ]),
      method,
      hex(sequence),
    )
    .run();
  return id;
}

const QUIET = { parsed: 0 };
/** Only the reconciliation stage wired beside the three required ones. */
function stages(reconcile: ScheduledStages["reconcile"]): ScheduledStages {
  return {
    parse: () => Promise.resolve(QUIET),
    identity: () => Promise.resolve({ processedRuns: 0 }),
    balanceProjection: () => Promise.resolve({ enabled: false, status: "skipped" }),
    ...(reconcile ? { reconcile } : {}),
  };
}
const ON = () => ({ ...env, RECONCILIATION_ENABLED: "true" }) as unknown as Env;
const RECONCILE_RESULT = {
  slices: 2,
  scanned: 11,
  groups: 3,
  groupsSkipped: 0,
  groupsDeferred: 1,
  proposed: 3,
  known: 1,
  written: 3,
  failed: 0,
  autoAccepted: 1,
};

test("the audited lanes are the ones that write decisions or proposals, and every one keeps tick records", () => {
  expect(Object.keys(LANE_AUDIT).sort()).toEqual([
    "card_settlement_sweep",
    "instrument_auto_adoption",
    "maintenance_survey",
    "purchase_recognition",
    "reconciliation_sweep",
  ]);
  for (const lane of Object.keys(LANE_AUDIT))
    expect(Object.hasOwn(LANE_TICK_COUNTS, lane)).toBe(true);
});

test("a writing tick is one record whose refs name exactly the rows the lane wrote, and none of its tick counts", async () => {
  const written = { decisions: [] as string[], same: [] as string[], supports: [] as string[] };
  // Rows that were there before the tick are not the tick's.
  await decision(RECONCILIATION_RULE_ACTOR);
  await proposal("provider_same");
  const lines: string[] = [];
  await runScheduled(
    ON(),
    stages(async () => {
      written.same.push(await proposal("provider_same"));
      // Another writer between the lane's own rows: an operator's manual
      // decision and an agent's proposal are inside the ranges, not named.
      await decision("operator@example.invalid", "manual");
      await proposal("provider_same", "ai");
      written.supports.push(await proposal("supports"));
      written.same.push(await proposal("provider_same"));
      written.decisions.push(await decision(RECONCILIATION_RULE_ACTOR));
      await decision("rule:some-other-rule");
      written.decisions.push(await decision(RECONCILIATION_RULE_ACTOR));
      return RECONCILE_RESULT;
    }),
    (line) => lines.push(line),
  );
  expect(lines.filter((line) => line.includes("lane_audit_record_failed"))).toEqual([]);
  const records = await laneRecords();
  expect(records).toHaveLength(1);
  const [record] = records;
  expect(record).toMatchObject({
    path: "lane",
    subject: null,
    principal: "lane:reconciliation-sweep",
    principal_kind: "automatic",
    operation: "lane.tick",
    risk_class: "R2",
    step: "call",
    scope_namespace: null,
    target_ref: null,
    result: "applied",
    result_code: null,
  });
  const refs = JSON.parse(record!.refs_json) as string[];
  expect(refs.map((ref) => ref.replace(/:\d+-\d+$/u, ""))).toEqual([
    "decision-revisions",
    "proposals:reconciliation-provider-same",
    "proposals:reconciliation-supports",
  ]);
  const resolved = await Promise.all(
    refs.map((ref) => resolveLaneRef(env.DB, "reconciliation_sweep", ref)),
  );
  expect(resolved).toEqual([written.decisions, written.same, written.supports]);
  expect(JSON.parse(record!.diff_json)).toEqual({
    kind: "lane",
    decisionRevisions: 2,
    commits: 0,
    proposals: [
      { kind: "reconciliation-provider-same", count: 2 },
      { kind: "reconciliation-supports", count: 1 },
    ],
  });
  // None of the tick's own counts: the tick row has them, the record does not.
  const tick = await env.DB.prepare(
    "SELECT counts_json FROM processor_lane_ticks WHERE lane='reconciliation_sweep'",
  ).first<{ counts_json: string }>();
  expect(JSON.parse(tick!.counts_json)).toMatchObject({ scanned: 11, proposed: 3 });
  const diffKeys = JSON.stringify(JSON.parse(record!.diff_json));
  for (const field of Object.keys(RECONCILE_RESULT)) expect(diffKeys).not.toContain(`"${field}"`);
  // The other writers' rows stay unnamed by any ref.
  const named = resolved.flat();
  expect(named).toHaveLength(5);
});

test("idle ticks, a lane that wrote nothing, a flag that is off and an unaudited lane write no record", async () => {
  const before = (await laneRecords()).length;
  // Wired and on, wrote nothing.
  await runScheduled(
    ON(),
    stages(() => Promise.resolve(RECONCILE_RESULT)),
    () => {},
  );
  // Off: the stage is not called at all.
  await runScheduled(
    { ...env, RECONCILIATION_ENABLED: "0" } as unknown as Env,
    stages(async () => {
      await proposal("provider_same");
      return RECONCILE_RESULT;
    }),
    () => {},
  );
  // A lane that writes none of decisions, proposals or settings, even when
  // something else writes a proposal while it runs (an unaudited lane takes
  // no mark, so nothing is attributed to it).
  await runScheduled(
    ON(),
    {
      ...stages(undefined),
      prices: async () => {
        await proposal("supports", "ai");
        return { scanned: 1, promoted: 1, written: 1 };
      },
    },
    () => {},
  );
  expect((await laneRecords()).length).toBe(before);
});

test("a lane named like a built-in property is an unaudited lane: no mark, no record, no log line and no reference", async () => {
  const before = (await laneRecords()).length;
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  // A mark an audited lane took, then a proposal any writer could add.
  const mark = await markLaneAudit(env.DB, "reconciliation_sweep", log);
  expect(mark).not.toBeNull();
  const id = await proposal("provider_same");
  const refs = [
    "decision-revisions:1-2",
    "commit-seq:synthetic-epoch:1-2",
    `proposals:reconciliation-provider-same:1-${Number.MAX_SAFE_INTEGER}`,
    `proposals:card-settlement-candidate:1-${Number.MAX_SAFE_INTEGER}`,
    `proposals:maintenance-survey-new:1-${Number.MAX_SAFE_INTEGER}`,
  ];
  // The audited lane's own reference still resolves: the refusal below is the lane's.
  expect(await resolveLaneRef(env.DB, "reconciliation_sweep", refs[2]!)).toContain(id);
  for (const lane of [
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
    "valueOf",
    "unknown_lane",
  ]) {
    expect(await markLaneAudit(env.DB, lane, log)).toBeNull();
    await recordLaneAudit(
      env.DB,
      lane,
      mark,
      { outcome: "ran", result: {} },
      "corr-synthetic",
      log,
    );
    await recordLaneAudit(
      env.DB,
      lane,
      mark,
      { outcome: "failed", code: "synthetic_code" },
      "corr-synthetic",
      log,
    );
    for (const ref of refs) expect(await resolveLaneRef(env.DB, lane, ref)).toBeNull();
  }
  expect(lines).toEqual([]);
  expect((await laneRecords()).length).toBe(before);
});

test("a tick that threw after writing is one failed record with its code; one that wrote nothing is none", async () => {
  const before = (await laneRecords()).length;
  await runScheduled(
    ON(),
    stages(() => Promise.reject(new TypeError("synthetic provider text 1234"))),
    () => {},
  );
  expect((await laneRecords()).length).toBe(before);
  let id = "";
  await runScheduled(
    ON(),
    stages(async () => {
      id = await proposal("contradicts");
      throw new TypeError("synthetic provider text 1234");
    }),
    () => {},
  );
  const records = await laneRecords();
  expect(records.length).toBe(before + 1);
  const failed = records.at(-1)!;
  // `TypeError` is not a lower-case code: the record carries `lane_failed`.
  expect(failed).toMatchObject({ result: "failed", result_code: "lane_failed", risk_class: "R1" });
  const [ref] = JSON.parse(failed.refs_json) as string[];
  expect(await resolveLaneRef(env.DB, "reconciliation_sweep", ref!)).toEqual([id]);
  expect(JSON.stringify(failed)).not.toContain("synthetic provider text");
});

test("each writing lane of one tick is its own record under the tick's one correlation id", async () => {
  const before = (await laneRecords()).length;
  let reconciled = "";
  let candidate = "";
  await runScheduled(
    { ...ON(), PURCHASE_RECOGNITION_ENABLED: "true" } as unknown as Env,
    {
      ...stages(async () => {
        reconciled = await proposal("funded_by");
        return RECONCILE_RESULT;
      }),
      purchases: async () => {
        candidate = await proposal("pending_to_posted");
        return { scanned: 1, proposed: 1 };
      },
    },
    () => {},
  );
  const records = (await laneRecords()).slice(before);
  expect(records.map((record) => record.principal).sort()).toEqual([
    "lane:purchase-recognition",
    "lane:reconciliation-sweep",
  ]);
  expect(new Set(records.map((record) => record.correlation_id)).size).toBe(1);
  const byLane = Object.fromEntries(
    records.map((record) => [record.principal, JSON.parse(record.refs_json) as string[]]),
  );
  // Lanes run one after the other, each from its own mark: neither names the other's row.
  expect(
    await resolveLaneRef(env.DB, "reconciliation_sweep", byLane["lane:reconciliation-sweep"]![0]!),
  ).toEqual([reconciled]);
  expect(
    await resolveLaneRef(env.DB, "purchase_recognition", byLane["lane:purchase-recognition"]![0]!),
  ).toEqual([candidate]);
  for (const record of records) expect(record.risk_class).toBe("R1");
});

test("a record that cannot be written is logged with a safe code and changes nothing the lane did", async () => {
  const before = (await laneRecords()).length;
  await env.DB.prepare(
    "CREATE TRIGGER refuse_lane_audit BEFORE INSERT ON audit_records WHEN NEW.path='lane' BEGIN SELECT RAISE(ABORT,'synthetic refusal'); END",
  ).run();
  const lines: string[] = [];
  let kept = "";
  try {
    await runScheduled(
      ON(),
      stages(async () => {
        kept = await proposal("statement_covers");
        return RECONCILE_RESULT;
      }),
      (line) => lines.push(line),
    );
  } finally {
    await env.DB.prepare("DROP TRIGGER refuse_lane_audit").run();
  }
  expect((await laneRecords()).length).toBe(before);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM reconciliation_proposals WHERE id=?")
      .bind(kept)
      .first<number>("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT outcome FROM processor_lane_ticks WHERE lane='reconciliation_sweep'",
    ).first<string>("outcome"),
  ).toBe("ran");
  const failures = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === "lane_audit_record_failed");
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ lane: "reconciliation_sweep" });
  expect(JSON.stringify(failures)).not.toContain("synthetic refusal");
});

test("a mark that cannot be read names only a closed audit code or a built-in error class", async () => {
  class Synthetic_private_account_label extends Error {}
  const refuse = () => {
    throw new Error("synthetic private trap");
  };
  const hostile = new Proxy({}, { get: refuse, getPrototypeOf: refuse, has: refuse });
  const coded = (code: unknown, error: Error = new Error("synthetic")) =>
    Object.assign(error, { code });
  for (const [thrown, code] of [
    [new Synthetic_private_account_label("synthetic"), "Error"],
    ["synthetic private text", "unknown"],
    [hostile, "unknown"],
    // A lower-case `code` that no audit builder throws is free text too.
    [coded("synthetic_private_label"), "Error"],
    [coded("synthetic_private_label", new Synthetic_private_account_label()), "Error"],
    [coded("audit_record_invalid", new TypeError("synthetic")), "audit_record_invalid"],
    [coded("audit_diff_invalid"), "audit_diff_invalid"],
  ] as const) {
    const lines: string[] = [];
    const mark = await markLaneAudit(
      {
        prepare: () => {
          throw thrown;
        },
      } as unknown as D1Database,
      "reconciliation_sweep",
      (line) => lines.push(line),
    );
    expect(mark).toBeNull();
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { event: "lane_audit_record_failed", lane: "reconciliation_sweep", code },
    ]);
  }
});

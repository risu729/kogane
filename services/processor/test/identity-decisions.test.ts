// The durable decision log (migration 0029) and the identity command model:
// assign / release-override lifecycle, idempotent resend, conflict detection,
// protection of manual decisions, the migration of legacy manuals, typed
// relations, and the per-run policy record. Synthetic rows only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { otherIdentity as providerIdentity } from "../../../packages/identity/src/other.ts";
import type { IdentityInput, IdentityPlan } from "../../../packages/identity/src/types.ts";
import { executeIdentityCommand, type IdentityCommand } from "../src/identity-commands.ts";
import { dependencyDigest } from "../src/identity-policies/index.ts";
import {
  IDENTITY_POLICY_VERSION,
  identifyParse,
  identitySweep,
  reviseIdentity,
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
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  db = env.DB;
}, 60_000);
afterAll(async () => {
  await mf?.dispose();
});

const PRODUCER = "collector-r2-importer";
const labelled =
  (label: string): IdentityResolver =>
  (input: IdentityInput): IdentityPlan => ({
    account: {
      key: [input.sourceAccount],
      label,
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

async function seedParse(
  id: number,
  source = "smbc-bank",
  sourceAccount = "smbc-bank:ordinary-yen",
  count = 1,
) {
  await seedArtifact(env, id, source, "synthetic", `synthetic-${id}.json`, { id });
  await db.batch([
    db
      .prepare(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'synthetic','1','2026-01-01','pending','[]')",
      )
      .bind(id, id),
    db
      .prepare(
        "INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,raw_locator,extra_json) SELECT ?,?,'synthetic_balance','JPY','synthetic:'||value,'{}' FROM json_each(?)",
      )
      .bind(id, sourceAccount, JSON.stringify(Array.from({ length: count }, (_, i) => i))),
    db.prepare("UPDATE parse_runs SET status='ok' WHERE id=?").bind(id),
  ]);
  // Adoption is what makes a successful run current (docs/publication-gate.md).
  await publishParse(db, id);
  return { id, artifact_id: id, source_id: source, producer_id: PRODUCER, fetch_run_id: id };
}
async function count(table: string, where = "1=1", ...bindings: unknown[]) {
  return (await db
    .prepare(`SELECT count(*) n FROM ${table} WHERE ${where}`)
    .bind(...bindings)
    .first<number>("n"))!;
}
async function currentMapping(parseId: number) {
  return (await db
    .prepare(
      "SELECT m.* FROM current_account_mappings m JOIN current_identity_observations o ON o.source_account_id=m.source_account_id WHERE o.parse_run_id=? LIMIT 1",
    )
    .bind(parseId)
    .first<{
      id: string;
      source_account_id: string;
      account_id: string;
      revision: number;
      method: string;
      label: string;
      policy_version: number;
    }>())!;
}
const command = (patch: Partial<IdentityCommand> & Pick<IdentityCommand, "operationId">) => ({
  actorId: "operator:synthetic",
  actorVerification: "server" as const,
  action: "assign" as const,
  kind: "account" as const,
  referenceId: "",
  expectedRevision: 1,
  targetId: "manual-target",
  reason: "synthetic manual decision",
  ...patch,
});
const run = (c: IdentityCommand) => executeIdentityCommand(db, c, IDENTITY_POLICY_VERSION);

test("assign protects the subject; release-override appends, supersedes, and lets the rule reapply", async () => {
  const parse = await seedParse(100);
  expect(await identifyParse(db, parse, labelled("rule label"))).toBe(1);
  const original = await currentMapping(100);
  const ref = original.source_account_id;
  await db
    .prepare(
      "INSERT INTO accounts VALUES('manual-target','手動確認済み口座','deposit','identified')",
    )
    .run();
  const assign = await run(command({ operationId: "op-assign-100", referenceId: ref }));
  expect(assign).toMatchObject({
    ok: true,
    replayed: false,
    receipt: { action: "assign", revision: 2 },
  });
  if (!assign.ok) throw new Error("unreachable");
  expect(assign.receipt.decisionRevisionId).toMatch(/^dr_[0-9a-f]{64}$/u);
  expect(assign.receipt.mappingId).toMatch(/^am_[0-9a-f]{64}$/u);
  const decision = await db
    .prepare("SELECT * FROM decision_revisions WHERE operation_id='op-assign-100'")
    .first<Record<string, unknown>>();
  expect(decision).toMatchObject({
    id: assign.receipt.decisionRevisionId,
    subject_kind: "account_mapping",
    subject_ref: ref,
    revision: 2,
    decision_kind: "assign",
    method: "manual",
    actor_id: "operator:synthetic",
    previous_revision: 1,
    superseded_by: null,
  });
  expect(JSON.parse(String(decision!.evidence_refs_json))).toEqual([
    `account_mapping:${assign.receipt.mappingId}`,
  ]);
  const ledger = await db
    .prepare("SELECT * FROM decision_operations WHERE operation_id='op-assign-100'")
    .first<Record<string, unknown>>();
  expect(ledger).toMatchObject({ actor_id: "operator:synthetic", actor_verification: "server" });
  expect(JSON.parse(String(ledger!.result_json))).toEqual(assign.receipt);
  expect(await currentMapping(100)).toMatchObject({
    id: assign.receipt.mappingId,
    account_id: "manual-target",
    revision: 2,
    method: "manual",
    label: "手動確認済み口座",
  });
  // A newer automatic policy does not overwrite the active manual decision.
  const later = await seedParse(101);
  await identifyParse(db, later, labelled("newer rule label"), 3);
  expect(await currentMapping(101)).toMatchObject({ account_id: "manual-target", revision: 2 });
  expect(await count("account_mappings", "source_account_id=?", ref)).toBe(2);
  // A release from a stale revision is a conflict and writes nothing.
  const stale = await run(
    command({
      operationId: "op-release-stale",
      action: "release-override",
      referenceId: ref,
      expectedRevision: 1,
      targetId: null,
    }),
  );
  expect(stale).toEqual({ ok: false, error: "revision_conflict" });
  expect(await count("decision_operations", "operation_id='op-release-stale'")).toBe(0);
  const release = await run(
    command({
      operationId: "op-release-100",
      action: "release-override",
      referenceId: ref,
      expectedRevision: 2,
      targetId: null,
      reason: "evidence reviewed; automatic policy may apply again",
    }),
  );
  expect(release).toMatchObject({ ok: true, receipt: { revision: 2, mappingId: null } });
  if (!release.ok) throw new Error("unreachable");
  expect(
    await db
      .prepare("SELECT superseded_by FROM decision_revisions WHERE id=?")
      .bind(assign.receipt.decisionRevisionId)
      .first<string>("superseded_by"),
  ).toBe(release.receipt.decisionRevisionId);
  const released = await db
    .prepare("SELECT * FROM decision_revisions WHERE id=?")
    .bind(release.receipt.decisionRevisionId)
    .first<Record<string, unknown>>();
  expect(released).toMatchObject({
    decision_kind: "release-override",
    revision: 2,
    previous_revision: 2,
    superseded_by: null,
  });
  expect(JSON.parse(String(released!.evidence_refs_json))).toEqual([
    `decision_revision:${assign.receipt.decisionRevisionId}`,
  ]);
  expect(await count("active_manual_overrides", "subject_ref=?", ref)).toBe(0);
  expect(await count("protected_mapping_subjects", "subject_ref=?", ref)).toBe(0);
  // The manual mapping row is still there and still current until a rule appends.
  expect(await count("account_mappings", "source_account_id=? AND method='manual'", ref)).toBe(1);
  expect(await currentMapping(100)).toMatchObject({ revision: 2, method: "manual" });
  const again = await seedParse(102);
  await identifyParse(db, again, labelled("rule applies again"));
  expect(await currentMapping(102)).toMatchObject({
    account_id: original.account_id,
    revision: 3,
    method: "rule",
    label: "rule applies again",
  });
  expect(await count("account_mappings", "source_account_id=?", ref)).toBe(3);
  // Observations pinned earlier keep the mapping they were recorded with.
  expect(await count("identity_observations", "account_mapping_id=?", original.id)).toBe(1);
  expect(
    await count("identity_observations", "account_mapping_id=?", assign.receipt.mappingId),
  ).toBe(1);
  expect(
    await run(
      command({
        operationId: "op-release-none",
        action: "release-override",
        referenceId: ref,
        expectedRevision: 3,
        targetId: null,
      }),
    ),
  ).toEqual({ ok: false, error: "no_active_override" });
}, 30_000);

test("a resend with the same operation id and payload replays the result without a second revision", async () => {
  const parse = await seedParse(110, "sony-bank", "sony-bank:deposit:JPY");
  await identifyParse(db, parse, labelled("sony rule"));
  const ref = (await currentMapping(110)).source_account_id;
  const c = command({ operationId: "op-resend-110", referenceId: ref });
  const first = await run(c);
  const second = await run(c);
  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) throw new Error("unreachable");
  expect(second.replayed).toBe(true);
  expect(second.receipt).toEqual(first.receipt);
  expect(await count("account_mappings", "source_account_id=?", ref)).toBe(2);
  expect(await count("decision_revisions", "operation_id='op-resend-110'")).toBe(1);
  expect(await count("decision_operations", "operation_id='op-resend-110'")).toBe(1);
  // Even after the subject moved on, the stored result is what the resend gets.
  await run(
    command({
      operationId: "op-release-110",
      action: "release-override",
      referenceId: ref,
      expectedRevision: 2,
      targetId: null,
    }),
  );
  expect(await run(c)).toEqual({ ok: true, replayed: true, receipt: first.receipt });
  // Same operation id with a different payload, or a different actor, is a conflict.
  expect(await run({ ...c, reason: "a different reason" })).toEqual({
    ok: false,
    error: "idempotency_conflict",
  });
  expect(await run({ ...c, actorId: "operator:someone-else" })).toEqual({
    ok: false,
    error: "idempotency_conflict",
  });
  expect(await count("decision_revisions", "operation_id='op-resend-110'")).toBe(1);
});

test("a failed guard writes nothing and a trigger failure aborts the whole batch", async () => {
  const parse = await seedParse(120, "v-point", "v-point:member");
  await identifyParse(db, parse, labelled("point rule"));
  const ref = (await currentMapping(120)).source_account_id;
  const before = await Promise.all([
    count("decision_operations"),
    count("decision_revisions"),
    count("account_mappings"),
  ]);
  expect(
    await run(command({ operationId: "op-stale-120", referenceId: ref, expectedRevision: 7 })),
  ).toEqual({ ok: false, error: "revision_conflict" });
  expect(
    await run(command({ operationId: "op-missing-120", referenceId: ref, targetId: "absent" })),
  ).toEqual({ ok: false, error: "target_missing" });
  for (const invalid of [
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
    { reason: " " },
    { reason: "x".repeat(1001) },
    { action: "release-override" as const, targetId: "manual-target" },
    { action: "assign" as const, targetId: null },
    { operationId: "" },
    { operationId: "bad id" },
    { actorId: "" },
  ])
    expect(
      await run(command({ operationId: "op-invalid-120", referenceId: ref, ...invalid })),
    ).toEqual({ ok: false, error: "invalid_command" });
  expect(
    await Promise.all([
      count("decision_operations"),
      count("decision_revisions"),
      count("account_mappings"),
    ]),
  ).toEqual(before);
  // The decision trigger rejects a revision that no mapping row backs, and the
  // batch is one transaction: the ledger row written before it is rolled back.
  await expect(
    db.batch([
      db
        .prepare(
          "INSERT INTO decision_operations VALUES('op-trigger-120','operator:synthetic','server','assign',?,'{}','2099')",
        )
        .bind("0".repeat(64)),
      db
        .prepare(
          "INSERT INTO decision_revisions VALUES('dr-trigger-120','account_mapping',?,99,'assign','manual','operator:synthetic','op-trigger-120','synthetic','[]',1,NULL,'2099')",
        )
        .bind(ref),
    ]),
  ).rejects.toThrow("decision_subject_invalid");
  expect(await count("decision_operations", "operation_id='op-trigger-120'")).toBe(0);
});

test("the legacy adapter records an unverified legacy-cli actor and keeps its error contract", async () => {
  const parse = await seedParse(130, "mobile-suica", "mobile-suica:sf");
  await identifyParse(db, parse, labelled("suica rule"));
  const mapping = await currentMapping(130);
  await db
    .prepare("INSERT INTO instruments VALUES('manual-instrument','money','手動通貨','identified')")
    .run();
  const change = {
    kind: "account" as const,
    referenceId: mapping.source_account_id,
    targetId: "manual-target",
    expectedRevision: mapping.revision,
    reason: "legacy operator correction",
  };
  await reviseIdentity(db, change);
  await expect(reviseIdentity(db, change)).rejects.toThrow("identity_revision_conflict");
  await expect(reviseIdentity(db, { ...change, expectedRevision: 0 })).rejects.toThrow(
    "identity_revision_invalid",
  );
  await expect(
    reviseIdentity(db, { ...change, expectedRevision: 2, targetId: "absent" }),
  ).rejects.toThrow("identity_target_missing");
  const ledger = await db
    .prepare(
      "SELECT o.actor_id,o.actor_verification,d.method FROM decision_operations o JOIN decision_revisions d ON d.operation_id=o.operation_id WHERE d.subject_ref=?",
    )
    .bind(mapping.source_account_id)
    .all<{ actor_id: string; actor_verification: string; method: string }>();
  expect(ledger.results).toEqual([
    { actor_id: "legacy-cli", actor_verification: "legacy-unknown", method: "manual" },
  ]);
  const instrument = await db
    .prepare(
      "SELECT identifier_id,revision FROM current_instrument_mappings WHERE identifier_id LIKE 'ii_%' LIMIT 1",
    )
    .first<{ identifier_id: string; revision: number }>();
  await reviseIdentity(db, {
    kind: "instrument",
    referenceId: instrument!.identifier_id,
    targetId: "manual-instrument",
    expectedRevision: instrument!.revision,
    reason: "legacy instrument correction",
  });
  expect(
    await count(
      "active_manual_overrides",
      "subject_kind='instrument_mapping' AND subject_ref=?",
      instrument!.identifier_id,
    ),
  ).toBe(1);
});

test("protection decisions match the former guard for every non-released history and differ only after a release", async () => {
  const OLD =
    "SELECT EXISTS(SELECT 1 FROM account_mappings WHERE source_account_id=? AND (method='manual' OR policy_version>=?)) blocked";
  const NEW = `SELECT (EXISTS(SELECT 1 FROM protected_mapping_subjects WHERE subject_kind='account_mapping' AND subject_ref=?)
    OR EXISTS(SELECT 1 FROM current_account_mappings WHERE source_account_id=? AND method='rule' AND policy_version>=?)) blocked`;
  const histories = [
    "rule-v1",
    "rule-v1-manual-logged",
    "rule-v1-manual-unlogged",
    "rule-v2",
    "released",
    "unlogged-released",
  ];
  await db.batch([
    db.prepare(
      "INSERT INTO accounts VALUES('history-target','履歴口座','deposit','provider-local')",
    ),
    ...histories.flatMap((h) => [
      db
        .prepare("INSERT INTO source_accounts VALUES(?,'smbc-bank',?,?)")
        .bind(`sa-${h}`, PRODUCER, JSON.stringify([`history:${h}`])),
      db
        .prepare(
          "INSERT INTO account_mappings VALUES(?,?,1,'history-target','rule','synthetic',?,'2099','履歴口座','provider-local')",
        )
        .bind(`am-${h}-1`, `sa-${h}`, h === "rule-v2" ? 2 : 1),
    ]),
    // Manual rows the way an older build wrote them: no decision describes them.
    ...["rule-v1-manual-unlogged", "unlogged-released"].map((h) =>
      db
        .prepare(
          "INSERT INTO account_mappings VALUES(?,?,2,'history-target','manual','by hand',1,'2099','履歴口座','provider-local')",
        )
        .bind(`am-${h}-2`, `sa-${h}`),
    ),
  ]);
  for (const h of ["rule-v1-manual-logged", "released"]) {
    const result = await run(
      command({ operationId: `op-${h}`, referenceId: `sa-${h}`, targetId: "history-target" }),
    );
    expect(result.ok).toBe(true);
  }
  for (const h of ["released", "unlogged-released"]) {
    const release = await run(
      command({
        operationId: `op-${h}-release`,
        action: "release-override",
        referenceId: `sa-${h}`,
        expectedRevision: 2,
        targetId: null,
      }),
    );
    expect(release.ok, h).toBe(true);
  }
  // Releasing an un-logged manual supersedes nothing but is recorded with its revision.
  expect(
    await db
      .prepare(
        "SELECT revision,previous_revision,evidence_refs_json FROM decision_revisions WHERE operation_id='op-unlogged-released-release'",
      )
      .first<Record<string, unknown>>(),
  ).toEqual({ revision: 2, previous_revision: null, evidence_refs_json: "[]" });
  const blocked = async (sql: string, ref: string, version: number) =>
    (await db
      .prepare(sql)
      .bind(...(sql === OLD ? [ref, version] : [ref, ref, version]))
      .first<number>("blocked")) === 1;
  const observed: Record<string, { old: boolean[]; new: boolean[] }> = {};
  for (const h of histories)
    observed[h] = {
      old: [await blocked(OLD, `sa-${h}`, 1), await blocked(OLD, `sa-${h}`, 2)],
      new: [await blocked(NEW, `sa-${h}`, 1), await blocked(NEW, `sa-${h}`, 2)],
    };
  // Independent expected set: [blocked at version 1, blocked at version 2].
  expect(Object.fromEntries(histories.map((h) => [h, observed[h]!.new]))).toEqual({
    "rule-v1": [true, false],
    "rule-v1-manual-logged": [true, true],
    "rule-v1-manual-unlogged": [true, true],
    "rule-v2": [true, true],
    released: [false, false],
    "unlogged-released": [false, false],
  });
  for (const h of histories.filter((h) => !h.endsWith("released")))
    expect(observed[h]!.new, h).toEqual(observed[h]!.old);
  for (const h of ["released", "unlogged-released"])
    expect(observed[h]!.old, h).toEqual([true, true]);
});

test("every run records its policy family, release and evidence digest; legacy runs stay readable", async () => {
  const parse = await seedParse(200);
  await identifyParse(db, parse, labelled("policy rule"));
  const baseline = await db
    .prepare("SELECT * FROM identity_run_contexts WHERE parse_run_id=200")
    .first<Record<string, unknown>>();
  expect(baseline).toMatchObject({
    policy_version: 1,
    policy_family: "identity-default",
    policy_release: "identity-default-v1",
    dependency_digest: await dependencyDigest([]),
    policy_recorded: 1,
  });
  const legacy = await seedParse(201);
  await db.batch([
    db.prepare("INSERT INTO identity_runs VALUES('legacy-run-1',201,1,'2099')"),
    db.prepare("INSERT INTO identity_runs VALUES('legacy-run-2',201,2,'2099')"),
  ]);
  expect(
    (
      await db
        .prepare(
          "SELECT policy_version,policy_family,policy_release,dependency_digest,policy_recorded FROM identity_run_contexts WHERE parse_run_id=? ORDER BY policy_version",
        )
        .bind(legacy.id)
        .all()
    ).results,
  ).toEqual([
    {
      policy_version: 1,
      policy_family: "identity-default",
      policy_release: "identity-default-v1",
      dependency_digest: "legacy",
      policy_recorded: 0,
    },
    {
      policy_version: 2,
      policy_family: "vpass-card-binding",
      policy_release: "vpass-card-binding-v2",
      dependency_digest: "legacy",
      policy_recorded: 0,
    },
  ]);
  for (const sql of [
    "UPDATE identity_run_policies SET policy_release='x'",
    "DELETE FROM identity_run_policies",
    "INSERT OR REPLACE INTO identity_run_policies SELECT * FROM identity_run_policies LIMIT 1",
    `INSERT INTO identity_run_policies VALUES('legacy-run-1',200,'identity-default','identity-default-v1','${"0".repeat(64)}','[]')`,
  ])
    await expect(db.prepare(sql).run()).rejects.toThrow();
});

async function vpassParse(id: number, ordinal = "card-001", withObservation = true) {
  await seedArtifact(env, id, "vpass", "statement", `statement-${id}.json`, { id });
  await db.batch([
    db
      .prepare(
        "UPDATE acquisition_sessions SET producer_id=?,external_id_namespace='vpass-worker-card-v1' WHERE id=?",
      )
      .bind(PRODUCER, id),
    db
      .prepare("INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(?,?,?,'card')")
      .bind(id, id, ordinal),
    db.prepare("UPDATE fetch_artifacts SET fetch_unit_id=? WHERE id=?").bind(id, id),
    db
      .prepare(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'synthetic','1','2026-01-01','pending','[]')",
      )
      .bind(id, id),
    ...(withObservation
      ? [
          db
            .prepare(
              "INSERT INTO transaction_observations(parse_run_id,source_account,currency,raw_locator,extra_json) VALUES(?,?,'JPY','$','{}')",
            )
            .bind(id, `vpass:${ordinal}`),
        ]
      : []),
    db.prepare("UPDATE parse_runs SET status='ok' WHERE id=?").bind(id),
  ]);
  return { id, artifact_id: id, source_id: "vpass", producer_id: PRODUCER, fetch_run_id: id };
}
async function sidecar(id: number, financial: number, token = `vpass-card-v1-${"a".repeat(64)}`) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO fetch_runs(id,source_id,producer_id,acquisition_session_id,source_run_key) VALUES(?,'vpass',?,?,'card-001-vpass-card-binding-v1')",
      )
      .bind(id, PRODUCER, financial),
    db
      .prepare("INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(?,?,?,'card')")
      .bind(id, id, token),
    db.prepare("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',0,0)").bind(id),
    db.prepare("INSERT INTO fetch_unit_reports VALUES(?,'terminal','success',NULL)").bind(id),
    db
      .prepare(
        "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,artifact_role,format_id,format_version) VALUES(?,?,'vpass','card-identity-binding','card-identity-binding.json',?,'collector_derived','vpass-card-identity-binding-json','1')",
      )
      .bind(id, id, id),
    db.prepare("INSERT INTO fetch_run_seals(fetch_run_id) VALUES(?)").bind(id),
  ]);
}

test("arrival of trusted Vpass evidence yields a new run of another family with a different digest", async () => {
  const financial = await vpassParse(300);
  expect(await identifyParse(db, financial, providerIdentity)).toBe(1);
  await sidecar(1300, 300);
  expect((await identitySweep(db, providerIdentity, 8, "vpass")).identifiedRuns).toBe(1);
  const runs = (
    await db
      .prepare(
        "SELECT c.policy_version,c.policy_family,c.policy_release,c.dependency_digest,p.dependency_set_json FROM identity_run_contexts c JOIN identity_run_policies p ON p.identity_run_id=c.identity_run_id WHERE c.parse_run_id=300 ORDER BY c.policy_version",
      )
      .all<Record<string, unknown>>()
  ).results;
  expect(runs).toHaveLength(2);
  expect(runs[0]).toMatchObject({
    policy_version: 1,
    policy_family: "identity-default",
    policy_release: "identity-default-v1",
    dependency_digest: await dependencyDigest([]),
    dependency_set_json: "[]",
  });
  expect(runs[1]).toMatchObject({
    policy_version: 2,
    policy_family: "vpass-card-binding",
    policy_release: "vpass-card-binding-v2",
  });
  expect(JSON.parse(String(runs[1]!.dependency_set_json))).toEqual([
    {
      kind: "trusted-vpass-card-binding",
      financialUnitId: 300,
      bindingArtifactId: 1300,
      cardToken: `vpass-card-v1-${"a".repeat(64)}`,
    },
  ]);
  expect(runs[1]!.dependency_digest).not.toBe(runs[0]!.dependency_digest);
  // Empty trusted parses go through the batched fast path with the same record.
  await vpassParse(301, "card-001", false);
  await sidecar(1301, 301);
  expect(await identitySweep(db, providerIdentity, 8, "vpass")).toEqual({
    processedRuns: 1,
    identifiedRuns: 1,
    identifiedObservations: 0,
  });
  expect(
    await db
      .prepare(
        "SELECT policy_version,policy_family,policy_release,dependency_digest FROM identity_run_contexts WHERE parse_run_id=301",
      )
      .first<Record<string, unknown>>(),
  ).toEqual({
    policy_version: 2,
    policy_family: "vpass-card-binding",
    policy_release: "vpass-card-binding-v2",
    dependency_digest: await dependencyDigest([
      {
        kind: "trusted-vpass-card-binding",
        financialUnitId: 301,
        bindingArtifactId: 1301,
        cardToken: `vpass-card-v1-${"a".repeat(64)}`,
      },
    ]),
  });
}, 30_000);

test("the private route runs the command: legacy-cli by default, a verified actor by header, replay and conflicts", async () => {
  const parse = await seedParse(400, "sbi-vc-trade", "sbi-vc-trade:main");
  await identifyParse(db, parse, labelled("exchange rule"));
  const mapping = await currentMapping(400);
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    mf.dispatchFetch("https://private.test/identity-revise", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const body = {
    kind: "account",
    referenceId: mapping.source_account_id,
    targetId: "manual-target",
    expectedRevision: 1,
    reason: "route correction",
    operationId: "route-op-400",
  };
  const first = await post(body);
  expect(first.status).toBe(200);
  const firstJson = (await first.json()) as {
    revised: boolean;
    replayed: boolean;
    receipt: unknown;
  };
  expect(firstJson).toMatchObject({ revised: true, replayed: false });
  const replay = await post(body);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ ...firstJson, replayed: true });
  expect(
    await db
      .prepare(
        "SELECT actor_id,actor_verification FROM decision_operations WHERE operation_id='route-op-400'",
      )
      .first<Record<string, unknown>>(),
  ).toEqual({ actor_id: "legacy-cli", actor_verification: "legacy-unknown" });
  const conflict = await post({ ...body, reason: "changed" });
  expect(conflict.status).toBe(409);
  expect(conflict.headers.get("x-kogane-error")).toBe("idempotency_conflict");
  expect(await conflict.text()).toBe("Revision conflict or invalid identity");
  const release = await post(
    {
      kind: "account",
      referenceId: mapping.source_account_id,
      targetId: null,
      expectedRevision: 2,
      reason: "release by verified operator",
      action: "release-override",
      operationId: "route-op-401",
    },
    { "x-kogane-verified-actor": "ops:alice" },
  );
  expect(release.status).toBe(200);
  expect(
    await db
      .prepare(
        "SELECT actor_id,actor_verification FROM decision_operations WHERE operation_id='route-op-401'",
      )
      .first<Record<string, unknown>>(),
  ).toEqual({ actor_id: "ops:alice", actor_verification: "server" });
  for (const invalid of [
    [{ ...body, action: "merge" }, {}],
    [{ ...body, operationId: 5 }, {}],
    [{ ...body, action: "release-override" }, {}],
    [{ ...body, targetId: null }, {}],
    [body, { "x-kogane-verified-actor": "Bad Actor" }],
  ] as const) {
    const response = await post(invalid[0], invalid[1]);
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid request");
  }
  const stale = await post({ ...body, operationId: "route-op-402" });
  expect(stale.status).toBe(409);
  expect(stale.headers.get("x-kogane-error")).toBe("revision_conflict");
});

test("decision log rows reject UPDATE, DELETE and REPLACE; superseded_by is set once to a same-subject decision", async () => {
  // One relation row, so the entity_relations triggers have something to fire on.
  await db.batch([
    db.prepare(
      "INSERT INTO decision_revisions VALUES('dr-relation-append','relation','rel-append',1,'propose','rule','synthetic',NULL,'synthetic','[]',NULL,NULL,'2099')",
    ),
    db.prepare(
      "INSERT INTO entity_relations VALUES('rel-append','supports','evidence:a','evidence:b',NULL,NULL,'proposed','dr-relation-append','[]','2099')",
    ),
  ]);
  for (const table of ["decision_operations", "decision_revisions", "entity_relations"]) {
    expect(await count(table)).toBeGreaterThan(0);
    const column = table === "decision_operations" ? "operation_id" : "id";
    await expect(db.prepare(`UPDATE ${table} SET ${column}=${column}`).run()).rejects.toThrow();
    await expect(db.prepare(`DELETE FROM ${table}`).run()).rejects.toThrow();
    await expect(
      db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`).run(),
    ).rejects.toThrow();
  }
  const [a, b] = (
    await db
      .prepare(
        "SELECT id,subject_ref FROM decision_revisions WHERE decision_kind='assign' AND superseded_by IS NULL ORDER BY id LIMIT 2",
      )
      .all<{ id: string; subject_ref: string }>()
  ).results;
  expect(a && b && a.subject_ref !== b.subject_ref).toBe(true);
  await expect(
    db.prepare("UPDATE decision_revisions SET superseded_by=? WHERE id=?").bind(b!.id, a!.id).run(),
  ).rejects.toThrow("append-only");
  await expect(
    db.prepare("UPDATE decision_revisions SET superseded_by=? WHERE id=?").bind(a!.id, a!.id).run(),
  ).rejects.toThrow("append-only");
  await expect(
    db.prepare("UPDATE decision_revisions SET reason='changed' WHERE id=?").bind(a!.id).run(),
  ).rejects.toThrow("append-only");
});

test("migration 0029 on 0017-0035 with seeded rows: every legacy manual once, relations from connection evidence, mappings untouched", async () => {
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
    const store = (await local.getD1Database("DB")) as unknown as D1Database;
    const bucket = await local.getR2Bucket("EVIDENCE");
    const localEnv = { DB: store, EVIDENCE: bucket } as unknown as Env;
    await store.exec(LAYER_A_SQL);
    const apply = async (names: string[]) => {
      for (const name of names)
        for (const sql of splitSql(readFileSync(new URL(name, migrationDir), "utf8")))
          await store.prepare(sql).run();
    };
    const migrations = layerBMigrations();
    expect(migrations).toContain("0029_decision_log.sql");
    await apply(migrations.filter((name) => name < "0029"));
    // Evidence: one MF detail run per connection and one direct SBI Shinsei run
    // holding the overview and branch artifacts; then leaf references and
    // mappings written the way the previous build wrote them.
    await seedArtifact(localEnv, 1, "moneyforward-me", "account-detail", "detail-a.html", {});
    await seedArtifact(
      localEnv,
      2,
      "sbi-shinsei-bank",
      "top-accounts-balance-and-activity",
      "overview.json",
      {},
    );
    await seedArtifact(localEnv, 4, "moneyforward-me", "account-detail", "detail-b.html", {});
    const long = "reason ".repeat(320);
    await store.batch([
      store.prepare(
        "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,artifact_role) VALUES(3,2,'sbi-shinsei-bank','balance-summary-and-stage','branch.json','collector_derived')",
      ),
      store.prepare(
        "INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(1,1,'connection-a','account'),(4,4,'connection-b','account')",
      ),
      store.prepare("UPDATE fetch_artifacts SET fetch_unit_id=1 WHERE id=1"),
      store.prepare("UPDATE fetch_artifacts SET fetch_unit_id=4 WHERE id=4"),
      store.prepare("INSERT INTO sources VALUES('smbc-bank','synthetic')"),
      store.prepare(
        `INSERT INTO source_accounts VALUES('direct-1','sbi-shinsei-bank','${PRODUCER}','["d1"]'),('direct-2','sbi-shinsei-bank','${PRODUCER}','["d2"]'),('ref-a','smbc-bank','${PRODUCER}','["a"]'),('ref-b','smbc-bank','${PRODUCER}','["b"]')`,
      ),
      store.prepare(
        "INSERT INTO accounts VALUES('acct-a','A','deposit','provider-local'),('acct-manual','手動','deposit','identified')",
      ),
      store.prepare(
        "INSERT INTO account_mappings VALUES('am-a-1','ref-a',1,'acct-a','rule','provider-scope',1,'2098-01-01','A','provider-local')",
      ),
      store.prepare(
        "INSERT INTO account_mappings VALUES('am-a-2','ref-a',2,'acct-manual','manual','first manual',2,'2098-02-02','手動','identified')",
      ),
      store
        .prepare(
          "INSERT INTO account_mappings VALUES('am-b-1','ref-b',1,'acct-manual','manual',?,2,'2098-03-03','手動','identified')",
        )
        .bind(long),
      store.prepare(
        "INSERT INTO instruments VALUES('inst-1','money','JPY','identified'),('inst-manual','money','手動通貨','identified')",
      ),
      store.prepare(
        "INSERT INTO instrument_identifiers VALUES('ident-1','iso4217','global','JPY','{}')",
      ),
      store.prepare(
        "INSERT INTO instrument_mappings VALUES('im-1-1','ident-1',1,'inst-1','rule','iso',1,'2098-01-01','JPY','identified'),('im-1-2','ident-1',2,'inst-manual','manual','instrument manual',2,'2098-04-04','手動通貨','identified')",
      ),
      store.prepare(
        `INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,related_source_id,direct_producer_id,reason,verifier_version,detail_artifact_id,direct_artifact_id,branch_artifact_id,direct_reference_ids_json,created_at) VALUES('${PRODUCER}','connection-a',1,'SBI新生銀行（MoneyForward連携）','confirmed','sbi-shinsei-bank','${PRODUCER}','same connection; one leaf','test-v1',1,2,3,'["direct-1"]','2098-05-05')`,
      ),
      store.prepare(
        `INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,related_source_id,direct_producer_id,reason,verifier_version,detail_artifact_id,direct_artifact_id,branch_artifact_id,direct_reference_ids_json,created_at) VALUES('${PRODUCER}','connection-a',2,'SBI新生銀行（MoneyForward連携）','confirmed','sbi-shinsei-bank','${PRODUCER}','same connection; leaf unresolved','test-v1',1,2,3,'["direct-1","direct-2"]','2098-06-06')`,
      ),
      store.prepare(
        `INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,related_source_id,direct_producer_id,reason,verifier_version,detail_artifact_id,direct_artifact_id,branch_artifact_id,direct_reference_ids_json,created_at) VALUES('${PRODUCER}','connection-b',1,'三井住友銀行（MoneyForward連携）','unresolved','smbc-bank',NULL,'no witness','test-v1',4,NULL,NULL,'[]','2098-07-07')`,
      ),
    ]);
    const snapshot = async () => [
      (await store.prepare("SELECT * FROM account_mappings ORDER BY id").all()).results,
      (await store.prepare("SELECT * FROM instrument_mappings ORDER BY id").all()).results,
      (await store.prepare("SELECT * FROM account_connection_reviews ORDER BY id").all()).results,
    ];
    const before = await snapshot();
    await apply(migrations.filter((name) => name >= "0029"));
    expect(await snapshot()).toEqual(before);
    const decisions = (
      await store
        .prepare(
          "SELECT id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at FROM decision_revisions WHERE subject_kind<>'relation' ORDER BY subject_kind,subject_ref,revision",
        )
        .all<Record<string, unknown>>()
    ).results;
    expect(decisions).toEqual([
      {
        id: "dr_legacy_account_am-a-2",
        subject_kind: "account_mapping",
        subject_ref: "ref-a",
        revision: 2,
        decision_kind: "assign",
        method: "legacy-migration",
        actor_id: "legacy-unknown",
        operation_id: null,
        reason: "first manual",
        evidence_refs_json: '["account_mapping:am-a-2"]',
        previous_revision: 1,
        superseded_by: null,
        created_at: "2098-02-02",
      },
      {
        id: "dr_legacy_account_am-b-1",
        subject_kind: "account_mapping",
        subject_ref: "ref-b",
        revision: 1,
        decision_kind: "assign",
        method: "legacy-migration",
        actor_id: "legacy-unknown",
        operation_id: null,
        reason: long.slice(0, 2000),
        evidence_refs_json: '["account_mapping:am-b-1"]',
        previous_revision: null,
        superseded_by: null,
        created_at: "2098-03-03",
      },
      {
        id: "dr_legacy_instrument_im-1-2",
        subject_kind: "instrument_mapping",
        subject_ref: "ident-1",
        revision: 2,
        decision_kind: "assign",
        method: "legacy-migration",
        actor_id: "legacy-unknown",
        operation_id: null,
        reason: "instrument manual",
        evidence_refs_json: '["instrument_mapping:im-1-2"]',
        previous_revision: 1,
        superseded_by: null,
        created_at: "2098-04-04",
      },
    ]);
    // Exactly one decision per manual row; none for rule rows; all protected.
    expect(
      await store
        .prepare(
          `SELECT count(*) n FROM account_mappings m WHERE
          (m.method='manual' AND (SELECT count(*) FROM decision_revisions d WHERE d.subject_kind='account_mapping' AND d.subject_ref=m.source_account_id AND d.revision=m.revision)<>1)
          OR (m.method='rule' AND EXISTS(SELECT 1 FROM decision_revisions d WHERE d.subject_kind='account_mapping' AND d.subject_ref=m.source_account_id AND d.revision=m.revision))`,
        )
        .first<number>("n"),
    ).toBe(0);
    expect(
      (
        await store
          .prepare("SELECT subject_kind,subject_ref FROM protected_mapping_subjects ORDER BY 1,2")
          .all()
      ).results,
    ).toEqual([
      { subject_kind: "account_mapping", subject_ref: "ref-a" },
      { subject_kind: "account_mapping", subject_ref: "ref-b" },
      { subject_kind: "instrument_mapping", subject_ref: "ident-1" },
    ]);
    const relations = (
      await store
        .prepare(
          "SELECT id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at FROM entity_relations ORDER BY id",
        )
        .all<Record<string, unknown>>()
    ).results;
    const review = await store
      .prepare(
        "SELECT id FROM account_connection_reviews WHERE connection_key='connection-a' AND revision=2",
      )
      .first<number>("id");
    expect(relations).toEqual(
      ["direct-1", "direct-2"].map((leaf, index) => ({
        id: `rel_legacy_connection_${review}_${index}`,
        kind: "connection_contains",
        from_ref: `connection:${PRODUCER}/connection-a`,
        to_ref: `source_account:${leaf}`,
        valid_from: null,
        valid_to: null,
        status: "accepted",
        decision_revision_id: `dr_legacy_connection_${review}_${index}`,
        evidence_refs_json: '["fetch_artifact:1","fetch_artifact:2","fetch_artifact:3"]',
        created_at: "2098-06-06",
      })),
    );
    expect(
      await store
        .prepare("SELECT count(*) n FROM decision_revisions WHERE subject_kind='relation'")
        .first<number>("n"),
    ).toBe(2);
    // SC06: connection evidence never implies leaf-account equivalence.
    expect(
      await store
        .prepare("SELECT count(*) n FROM entity_relations WHERE kind='same_account'")
        .first<number>("n"),
    ).toBe(0);
    // The backfill is not repeatable: its deterministic ids are refused a second time.
    const backfill = splitSql(
      readFileSync(new URL("0029_decision_log.sql", migrationDir), "utf8"),
    ).filter((sql) => /^INSERT INTO (decision_revisions|entity_relations)/u.test(sql.trim()));
    expect(backfill).toHaveLength(4);
    for (const sql of backfill) await expect(store.prepare(sql).run()).rejects.toThrow("forbidden");
    expect(
      await store.prepare("SELECT count(*) n FROM decision_revisions").first<number>("n"),
    ).toBe(5);
    // Relation kinds outside the closed union are rejected by CHECK; a
    // same_account claim needs its own explicit decision.
    await store
      .prepare(
        "INSERT INTO decision_revisions VALUES('dr-rel-x','relation','rel-x',1,'propose','rule','test',NULL,'synthetic','[]',NULL,NULL,'2099')",
      )
      .run();
    for (const kind of ["same_as", "connection-contains", "SAME_ACCOUNT", ""])
      await expect(
        store
          .prepare(
            "INSERT INTO entity_relations VALUES('rel-x',?,'source_account:direct-1','source_account:direct-2',NULL,NULL,'proposed','dr-rel-x','[]','2099')",
          )
          .bind(kind)
          .run(),
      ).rejects.toThrow();
    await expect(
      store
        .prepare(
          "INSERT INTO entity_relations VALUES('rel-y','same_account','source_account:direct-1','source_account:direct-2',NULL,NULL,'proposed','dr-rel-x','[]','2099')",
        )
        .run(),
    ).rejects.toThrow("relation_decision_missing");
    await store
      .prepare(
        "INSERT INTO entity_relations VALUES('rel-x','same_account','source_account:direct-1','source_account:direct-2',NULL,NULL,'proposed','dr-rel-x','[]','2099')",
      )
      .run();
    expect(
      await store
        .prepare(
          "SELECT count(*) n FROM entity_relations WHERE kind='same_account' AND status='accepted'",
        )
        .first<number>("n"),
    ).toBe(0);
  } finally {
    await local.dispose();
  }
}, 60_000);

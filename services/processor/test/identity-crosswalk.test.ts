// ADR 0030: the one-time crosswalk between importer-era and collector-era
// account identities. The importer derived its identity values under a key
// that is lost; the collector's values for the same card or account differ,
// so each became a second account entity. The proposal measures which old
// value a new one continues from provider rows both producers captured, the
// operator records it through the change lifecycle, and from then on the new
// value resolves to the importer-era entity.
//
// Everything is synthetic: tokens are repeated hex digits or unkeyed digests
// of the anonymous fixtures' tuple, and the rows, merchants and amounts are
// placeholders in the observed shapes. The importer-era values are
// `v1`-shaped (the importer's HMACs; the key is gone, so they are made up) and
// the collector-era values are the `v2` values the collectors derive since
// ADR 0029: the Vpass collector's token is a `vpass-card-v2-` value bound in
// its own run, and the MoneyForward collector's identity is the one
// `moneyForwardRunPlan` derives from the fixture's detail page.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  approve,
  commit,
  createPlan,
  d1CommandStore,
  type ChangePlan,
  type IdentityCrosswalkPayload,
  type Principal,
} from "../../../packages/application/src/index.ts";
import { persistRun, type PersistRunPlan } from "../../../packages/collection/src/writer.ts";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import {
  CROSSWALK_PROPOSALS_SQL,
  type CrosswalkProposal,
  type CrosswalkProposalRow,
  crosswalkProposals,
  importerEntityId,
} from "../../../packages/storage-d1/src/core/identity-crosswalk.ts";
import {
  CORE_MIGRATIONS_URL,
  applyReadMigrations,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../../../packages/storage-d1/src/migrations.ts";
import { moneyForwardRunPlan } from "../../collector-moneyforward/src/shared-collection.ts";
import type { RawArtifact } from "../../collector-moneyforward/src/types.ts";
import { changeMutationPlanners } from "../src/change-commands.ts";
import { registerCollectionRun } from "../src/collection/index.ts";
import { identifyParse, identitySweep } from "../src/identity-store.ts";
import { sweep } from "../src/worker.ts";
import {
  disposeWorlds,
  PRODUCER as IMPORTER,
  TOKEN_A,
  type UsageRow,
  world,
  type World,
} from "./card-purchase-world.ts";

let mf: Miniflare | undefined;
afterEach(async () => {
  await disposeWorlds();
  await mf?.dispose();
  mf = undefined;
});

const COLLECTOR_VPASS = "collector-vpass";
const NOW = "2026-09-27T00:00:00.000Z";
/** The collector's v2 token (ADR 0029) for the card whose importer token is `TOKEN_A`. */
const NEW_TOKEN = `vpass-card-v2-${"c".repeat(64)}`;
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

const row = (date: string, merchant: string, amount: string): UsageRow => ({
  date,
  merchant,
  amount,
  paymentType: "1",
});
const MAY = [row("26/05/03", "架空店舗A", "1,000"), row("26/05/09", "架空店舗B", "250")];
const APRIL = [row("26/04/11", "架空店舗C", "700")];
const JUNE = [row("26/06/02", "架空店舗D", "300")];

async function proposals(db: D1Database): Promise<CrosswalkProposal[]> {
  const rows = await db.prepare(CROSSWALK_PROPOSALS_SQL).all<CrosswalkProposalRow>();
  return crosswalkProposals(rows.results);
}

/** Each Vpass token source account, its producer and the entity it maps to now. */
async function vpassMappings(db: D1Database) {
  return (
    await db
      .prepare(
        `SELECT s.id,s.producer_id,json_extract(s.reference_json,'$[1]') AS token,
          m.account_id,m.revision,m.method,m.policy_version
         FROM source_accounts s JOIN current_account_mappings m ON m.source_account_id=s.id
         WHERE s.source_id='vpass' AND json_extract(s.reference_json,'$[0]')='vpass:card'
         ORDER BY s.producer_id DESC,token`,
      )
      .all<{
        id: string;
        producer_id: string;
        token: string;
        account_id: string;
        revision: number;
        method: string;
        policy_version: number;
      }>()
  ).results;
}

async function count(db: D1Database, table: string): Promise<number> {
  return (await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

function payload(
  proposal: CrosswalkProposal,
  reason = "The same statement lines were captured under both values",
): IdentityCrosswalkPayload {
  return {
    source: proposal.source as IdentityCrosswalkPayload["source"],
    fromRef: proposal.oldKeyRef!,
    toRef: proposal.newKeyRef,
    sharedRows: proposal.sharedRows,
    newOnlyRows: proposal.newOnlyRows,
    oldOnlyRows: proposal.oldOnlyRows!,
    months: proposal.months,
    reason,
  };
}

async function plan(db: D1Database, actor: Principal, body: unknown) {
  return createPlan(
    "identity.crosswalk.accept",
    body,
    { actor, baseContextId: "identity-current-v1", now: NOW, ttlSeconds: 900 },
    d1CommandStore(db),
  );
}

async function approveAndCommit(db: D1Database, actor: Principal, planned: ChangePlan, op: string) {
  const store = d1CommandStore(db);
  const approval = await approve(store, {
    planId: planned.planId,
    planDigest: planned.planDigest,
    actor,
    scope: [],
    ttlSeconds: 600,
    now: NOW,
  });
  if (!approval.ok) return approval;
  return commit(store, {
    operationId: op,
    principal: actor,
    planId: planned.planId,
    approvalId: approval.approval.approvalId,
    planners: changeMutationPlanners(db),
    now: NOW,
  });
}

/** The importer's card-001 in April and May, and the collector's May under its own token. */
async function vpassSplit(): Promise<World> {
  const w = await world();
  await w.vpass({
    family: "web",
    month: "202604",
    fetchedAt: "2026-05-10T00:00:00.000Z",
    rows: APRIL,
  });
  await w.vpass({
    family: "web",
    month: "202605",
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: MAY,
  });
  await w.vpass({
    family: "web",
    month: "202605",
    fetchedAt: "2026-09-20T00:00:00.000Z",
    rows: MAY,
    token: NEW_TOKEN,
    binding: "collector",
    producer: COLLECTOR_VPASS,
  });
  return w;
}

test("Vpass: rows captured by both producers propose one unique crosswalk, counts only", async () => {
  const w = await vpassSplit();
  const lines = await proposals(w.db);
  expect(lines).toEqual([
    {
      source: "vpass",
      newKeyRef: NEW_TOKEN,
      oldKeyRef: TOKEN_A,
      sharedRows: 2,
      newOnlyRows: 0,
      oldOnlyRows: 1,
      months: 1,
      verdict: "unique",
    },
  ]);
  // Before any decision the two values are two entities.
  const [collector, importer] = await vpassMappings(w.db);
  expect([collector!.producer_id, importer!.producer_id]).toEqual([COLLECTOR_VPASS, IMPORTER]);
  expect(collector!.account_id).not.toBe(importer!.account_id);
  expect(importer!.account_id).toBe(await importerEntityId("vpass", TOKEN_A));
}, 60_000);

test("Vpass: a third value sharing a row makes it ambiguous, and a value sharing nothing is none", async () => {
  const w = await world();
  const OTHER_OLD = `vpass-card-v1-${"d".repeat(64)}`;
  const LONE = `vpass-card-v2-${"e".repeat(64)}`;
  await w.vpass({
    family: "web",
    month: "202605",
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: MAY,
  });
  // A second importer-era value that captured one of the same lines.
  await w.vpass({
    family: "web",
    month: "202605",
    fetchedAt: "2026-06-11T00:00:00.000Z",
    rows: MAY.slice(0, 1),
    token: OTHER_OLD,
  });
  await w.vpass({
    family: "web",
    month: "202605",
    fetchedAt: "2026-09-20T00:00:00.000Z",
    rows: MAY,
    token: NEW_TOKEN,
    binding: "collector",
    producer: COLLECTOR_VPASS,
  });
  // The collector's other card: nothing the importer captured.
  await w.vpass({
    family: "web",
    card: "card-002",
    month: "202606",
    fetchedAt: "2026-09-20T00:00:00.000Z",
    rows: JUNE,
    token: LONE,
    binding: "collector",
    producer: COLLECTOR_VPASS,
  });
  const lines = await proposals(w.db);
  expect(
    lines.map((line) => [line.newKeyRef, line.oldKeyRef, line.sharedRows, line.verdict]),
  ).toEqual(
    [
      [NEW_TOKEN, TOKEN_A, 2, "ambiguous"],
      [NEW_TOKEN, OTHER_OLD, 1, "ambiguous"],
      [LONE, null, 0, "none"],
    ].sort(
      (a, b) =>
        String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1])),
    ),
  );
  // An ambiguous or empty overlap cannot be planned at all.
  const ambiguous = await plan(
    w.db,
    operator,
    payload(lines.find((l) => l.oldKeyRef === TOKEN_A)!),
  );
  expect(ambiguous).toMatchObject({ ok: false, error: "target_ambiguous" });
  expect(await count(w.db, "change_plans")).toBe(0);
}, 60_000);

test("Vpass: the operator records the crosswalk; an agent cannot, and changed evidence or a second crosswalk is refused", async () => {
  const w = await vpassSplit();
  const [proposal] = await proposals(w.db);
  const body = payload(proposal!);

  // Counts the server does not measure are refused before a plan exists.
  expect(await plan(w.db, operator, { ...body, sharedRows: 3 })).toMatchObject({
    ok: false,
    error: "stale_context",
  });
  expect(await count(w.db, "change_plans")).toBe(0);

  // An agent may plan (propose) but never approve or commit.
  const proposed = await plan(w.db, agent, body);
  if (!proposed.ok) throw new Error(proposed.error);
  const [collector, importer] = await vpassMappings(w.db);
  const subject = `proposal:identity-crosswalk|vpass|${TOKEN_A}|${NEW_TOKEN}`;
  expect(proposed.plan.expectedRevisions).toEqual({
    [subject]: 0,
    [`account_mapping:${collector!.id}`]: 1,
  });
  expect(proposed.plan.payload).toEqual(body);
  expect(proposed.plan.simulation.targets.map((target) => target.proposedTargetRef)).toEqual([
    `account:${importer!.account_id}`,
    importer!.account_id,
  ]);
  expect(await approveAndCommit(w.db, agent, proposed.plan, "agent-op")).toMatchObject({
    ok: false,
    error: "approval_required",
  });

  // The operator approves two plans of the same pair (different reasons).
  const first = await plan(w.db, operator, body);
  const second = await plan(w.db, operator, { ...body, reason: "Second look at the same lines" });
  if (!first.ok || !second.ok) throw new Error("plan refused");

  // The collector captures April too before the commit: the overlap the plan
  // pinned has changed, so the commit writes nothing.
  await w.vpass({
    family: "web",
    month: "202604",
    fetchedAt: "2026-09-21T00:00:00.000Z",
    rows: APRIL,
    token: NEW_TOKEN,
    binding: "collector",
    producer: COLLECTOR_VPASS,
  });
  const before = {
    crosswalk: await count(w.db, "account_identity_crosswalk"),
    decisions: await count(w.db, "decision_revisions"),
    mappings: await count(w.db, "account_mappings"),
    receipts: await count(w.db, "operation_receipts"),
  };
  expect(await approveAndCommit(w.db, operator, first.plan, "stale-op")).toMatchObject({
    ok: false,
    error: "stale_context",
  });
  expect({
    crosswalk: await count(w.db, "account_identity_crosswalk"),
    decisions: await count(w.db, "decision_revisions"),
    mappings: await count(w.db, "account_mappings"),
    receipts: await count(w.db, "operation_receipts"),
  }).toEqual(before);

  // Re-measured, the proposal is still unique; the operator records it.
  const [remeasured] = await proposals(w.db);
  expect(remeasured).toMatchObject({ sharedRows: 3, newOnlyRows: 0, oldOnlyRows: 0, months: 2 });
  const accepted = await plan(w.db, operator, payload(remeasured!));
  const racing = await plan(w.db, operator, payload(remeasured!, "A concurrent second plan"));
  if (!accepted.ok || !racing.ok) throw new Error("plan refused");
  const committed = await approveAndCommit(w.db, operator, accepted.plan, "crosswalk-op");
  if (!committed.ok) throw new Error(committed.error);
  expect(committed.receipt.result).toMatchObject({
    source: "vpass",
    fromRef: TOKEN_A,
    toRef: NEW_TOKEN,
    accountId: importer!.account_id,
    pinnedMappings: 1,
  });

  const recorded = await w.db
    .prepare(
      "SELECT source_id,from_account_ref,to_account_ref,evidence_json,actor_id,decision_revision_id FROM account_identity_crosswalk",
    )
    .all<Record<string, string>>();
  expect(recorded.results).toHaveLength(1);
  expect(recorded.results[0]).toMatchObject({
    source_id: "vpass",
    from_account_ref: TOKEN_A,
    to_account_ref: NEW_TOKEN,
    actor_id: operator.id,
    decision_revision_id: committed.receipt.decisionRevisionId,
  });
  const evidence = JSON.parse(recorded.results[0]!.evidence_json!) as Record<string, unknown>;
  expect(Object.keys(evidence).sort()).toEqual(
    ["months", "newOnlyRows", "oldOnlyRows", "proposalDigest", "sharedRows"].sort(),
  );
  expect(evidence).toMatchObject({ sharedRows: 3, newOnlyRows: 0, oldOnlyRows: 0, months: 2 });
  expect(
    await w.db
      .prepare(
        "SELECT subject_kind,subject_ref,revision,decision_kind,method,actor_id FROM decision_revisions WHERE id=?",
      )
      .bind(committed.receipt.decisionRevisionId)
      .first<Record<string, unknown>>(),
  ).toEqual({
    subject_kind: "relation",
    subject_ref: subject,
    revision: 1,
    decision_kind: "accept",
    method: "manual",
    actor_id: operator.id,
  });

  // The collector's automatic mapping is superseded by a new rule revision
  // pointing at the importer-era entity; the importer's is untouched and the
  // old revision is still there.
  const after = await vpassMappings(w.db);
  expect(after).toEqual([
    { ...collector!, account_id: importer!.account_id, revision: 2 },
    importer!,
  ]);
  expect(
    await w.db
      .prepare("SELECT account_id FROM account_mappings WHERE source_account_id=? AND revision=1")
      .bind(collector!.id)
      .first<Record<string, unknown>>(),
  ).toEqual({ account_id: collector!.account_id });

  // The owner's check in docs/identity-operations.md, verbatim.
  expect(
    (
      await w.db
        .prepare(
          `SELECT x.source_id, count(DISTINCT x.id) AS crosswalks,
       count(m.source_account_id) AS collector_source_accounts
FROM account_identity_crosswalk x
LEFT JOIN source_accounts s ON s.source_id=x.source_id
 AND s.producer_id<>'collector-r2-importer'
 AND s.reference_json IN (json_array('vpass:card',x.to_account_ref),
                          json_array('moneyforward-me:'||x.to_account_ref))
LEFT JOIN current_account_mappings m ON m.source_account_id=s.id
GROUP BY x.source_id;`,
        )
        .all()
    ).results,
  ).toEqual([{ source_id: "vpass", crosswalks: 1, collector_source_accounts: 1 }]);

  // The racing plan of the same pair is now stale, and nothing more is written.
  expect(await approveAndCommit(w.db, operator, racing.plan, "racing-op")).toMatchObject({
    ok: false,
    error: "stale_context",
  });
  // A second crosswalk for the same old or the same new value is refused.
  expect(await plan(w.db, operator, payload(remeasured!))).toMatchObject({
    ok: false,
    error: "target_ambiguous",
  });
  expect(await count(w.db, "account_identity_crosswalk")).toBe(1);
}, 90_000);

test("Vpass: after the crosswalk a new collector observation lands on the importer-era entity", async () => {
  const w = await vpassSplit();
  const [proposal] = await proposals(w.db);
  const [collector, importer] = await vpassMappings(w.db);
  const planned = await plan(w.db, operator, payload(proposal!));
  if (!planned.ok) throw new Error(planned.error);
  const committed = await approveAndCommit(w.db, operator, planned.plan, "crosswalk-op");
  if (!committed.ok) throw new Error(committed.error);

  // The collector's June capture: identified by the scheduled rule, its rows
  // are attributed to the importer-era entity, and no further mapping
  // revision is appended.
  const june = await w.vpass({
    family: "web",
    month: "202606",
    fetchedAt: "2026-09-25T00:00:00.000Z",
    rows: JUNE,
    token: NEW_TOKEN,
    binding: "collector",
    producer: COLLECTOR_VPASS,
  });
  const attributed = async (parse: number) =>
    (
      await w.db
        .prepare(
          `SELECT DISTINCT m.account_id FROM current_identity_observations o
            JOIN current_account_mappings m ON m.source_account_id=o.source_account_id
           WHERE o.parse_run_id=?`,
        )
        .bind(parse)
        .all<{ account_id: string }>()
    ).results;
  expect(await attributed(june.parse)).toEqual([{ account_id: importer!.account_id }]);
  expect((await vpassMappings(w.db))[0]).toMatchObject({ revision: 2 });

  // The rule itself now derives the importer-era entity for the new value:
  // a newer policy run appends its revision, and it names that entity.
  await identifyParse(
    w.db,
    {
      id: june.parse,
      artifact_id: june.artifact,
      source_id: "vpass",
      producer_id: COLLECTOR_VPASS,
      fetch_run_id: june.run,
    },
    resolveIdentity,
    3,
  );
  const [rederived] = await vpassMappings(w.db);
  expect(rederived).toMatchObject({
    id: collector!.id,
    account_id: importer!.account_id,
    revision: 3,
    method: "rule",
    policy_version: 3,
  });
}, 90_000);

test("Vpass: without a crosswalk the rule keeps the collector's own entity", async () => {
  const w = await vpassSplit();
  const [collector] = await vpassMappings(w.db);
  const june = await w.vpass({
    family: "web",
    month: "202606",
    fetchedAt: "2026-09-25T00:00:00.000Z",
    rows: JUNE,
    token: NEW_TOKEN,
    binding: "collector",
    producer: COLLECTOR_VPASS,
  });
  await identifyParse(
    w.db,
    {
      id: june.parse,
      artifact_id: june.artifact,
      source_id: "vpass",
      producer_id: COLLECTOR_VPASS,
      fetch_run_id: june.run,
    },
    resolveIdentity,
    3,
  );
  const [rederived] = await vpassMappings(w.db);
  expect(rederived).toMatchObject({
    account_id: collector!.account_id,
    revision: 2,
    policy_version: 3,
  });
}, 90_000);

// ── MoneyForward ME: the external id carries the identity, so rows are
// compared by what its fingerprint covers besides it. ─────────────────────

/** What the collector derives from the fixture's detail page (ADR 0029). */
const MF_V2 = `moneyforward-account-v2-${createHash("sha256")
  .update(JSON.stringify(["moneyforward-account-v2", "anonymous-account", "anonymous-service"]))
  .digest("hex")}`;
/** A made-up importer identity: the key that derived the real ones is gone. */
const MF_V1 = `moneyforward-account-v1-${"5a".repeat(32)}`;

/** The plan with every unit key `from` renamed `to`: how an importer-era run carried its v1 key. */
function relabel(plan: PersistRunPlan, from: string, to: string): PersistRunPlan {
  const swap = (key: string) => (key === from ? to : key);
  return {
    run: {
      ...plan.run,
      requestedScope: {
        ...plan.run.requestedScope,
        unitKeys: plan.run.requestedScope.unitKeys.map(swap),
      },
      units: plan.run.units.map((unit) => ({ ...unit, unitKey: swap(unit.unitKey) })),
      ranges: plan.run.ranges.map((range) => ({
        ...range,
        rangeKey: range.rangeKey.replace(from, to),
        ...(range.unitKey === undefined ? {} : { unitKey: swap(range.unitKey) }),
      })),
    },
    artifacts: plan.artifacts.map((artifact) =>
      artifact.unitKey === undefined ? artifact : { ...artifact, unitKey: swap(artifact.unitKey) },
    ),
  };
}
const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../tests/fixtures/observation-pipeline/moneyforward/${name}`, import.meta.url),
    "utf8",
  );
const FEBRUARY = fixture("account-01-month-2099-02.html");
const JANUARY = FEBRUARY.replace("2099-02-03", "2099-01-03").replace("2099-01-31", "2098-12-31");
const HTML = "text/html; charset=utf-8";

async function mfStore(): Promise<Env> {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {};",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB", "READ"],
      r2Buckets: ["EVIDENCE"],
    }),
  );
  const db = await mf.getD1Database("DB");
  const read = await mf.getD1Database("READ");
  for (const file of migrationFiles(CORE_MIGRATIONS_URL))
    for (const sql of splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file)))
      await db.prepare(sql).run();
  const bootstrap = readFileSync(
    new URL("../../../infra/bootstrap/ingest-clients.sql", import.meta.url),
    "utf8",
  );
  for (const sql of splitSqlStatements(bootstrap)) await db.prepare(sql).run();
  await applyReadMigrations(read);
  const env = {
    DB: db,
    READ: read,
    EVIDENCE: await mf.getR2Bucket("EVIDENCE"),
    SHARED_R2_INGEST_ENABLED: "true",
    COLLECTION_INGEST_CLIENT: "processor-shared-r2",
  } as unknown as Env;
  // The importer's route, for the test only: the importer no longer runs.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO ingest_client_producers (ingest_client_id, producer_id) SELECT 'processor-shared-r2', ?1 WHERE NOT EXISTS (SELECT 1 FROM ingest_client_producers WHERE ingest_client_id='processor-shared-r2' AND producer_id=?1)",
    ).bind(IMPORTER),
    env.DB.prepare(
      "INSERT INTO producer_sources (producer_id, source_id) SELECT ?1, 'moneyforward-me' WHERE NOT EXISTS (SELECT 1 FROM producer_sources WHERE producer_id=?1 AND source_id='moneyforward-me')",
    ).bind(IMPORTER),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id, active) VALUES ('processor-shared-r2', ?1, 'moneyforward-me', 1)",
    ).bind(IMPORTER),
  ]);
  return env;
}

async function mfRun(
  env: Env,
  input: { runId: string; at: string; months: [string, string][]; importer?: boolean },
): Promise<void> {
  const pages: RawArtifact[] = [
    {
      dataset: "accounts-index",
      filename: "accounts.html",
      mediaType: HTML,
      body: fixture("accounts.html"),
    },
    {
      dataset: "account-detail",
      filename: "account-detail-01.html",
      mediaType: HTML,
      body: fixture("account-detail-01.html"),
    },
    ...input.months.map(([month, body]) => ({
      dataset: "monthly-transactions",
      filename: `account-01-month-${month}.html`,
      mediaType: HTML,
      body,
    })),
  ];
  const plan = await moneyForwardRunPlan({
    schemaVersion: "moneyforward-worker-poc-v1",
    runId: input.runId,
    startedAt: input.at,
    completedAt: input.at,
    status: "success",
    accountDetailCount: 1,
    monthlyFragmentCount: input.months.length,
    artifacts: pages,
    failures: [],
  });
  // The importer's run of the same account carried its v1 identity.
  const run = input.importer
    ? relabel({ ...plan, run: { ...plan.run, producer: IMPORTER } }, MF_V2, MF_V1)
    : plan;
  expect((await persistRun(env.EVIDENCE, run)).outcome).toBe("persisted");
  expect(
    await registerCollectionRun(env, { source: "moneyforward-me", runId: input.runId }),
  ).toMatchObject({ outcome: "registered" });
}

test("MoneyForward: the proposal matches rows across identities and the crosswalk joins the entities", async () => {
  const env = await mfStore();
  const oldRef = MF_V1;
  const newRef = MF_V2;
  await mfRun(env, {
    runId: "00000000-0000-4000-8000-00000000d030",
    at: "2026-08-01T00:00:00.000Z",
    months: [
      ["2099-01", JANUARY],
      ["2099-02", FEBRUARY],
    ],
    importer: true,
  });
  expect(await sweep(env)).toMatchObject({ error: 0 });
  await mfRun(env, {
    runId: "00000000-0000-4000-8000-00000000c030",
    at: "2026-09-20T00:00:00.000Z",
    months: [["2099-02", FEBRUARY]],
  });
  expect(await sweep(env)).toMatchObject({ error: 0 });
  await identitySweep(env.DB, resolveIdentity, 40);

  // The external ids differ (each carries its identity); the rows do not.
  const ids = await env.DB.prepare(
    "SELECT count(DISTINCT external_id) AS ids, count(*) AS n FROM transaction_observations WHERE as_of LIKE '2099-02-%'",
  ).first();
  expect(ids).toEqual({ ids: 4, n: 4 });
  const lines = await proposals(env.DB);
  expect(lines).toEqual([
    {
      source: "moneyforward-me",
      newKeyRef: newRef,
      oldKeyRef: oldRef,
      sharedRows: 2,
      newOnlyRows: 0,
      oldOnlyRows: 2,
      months: 1,
      verdict: "unique",
    },
  ]);

  const mappings = async () =>
    (
      await env.DB.prepare(
        `SELECT s.producer_id,m.account_id,m.revision FROM source_accounts s
          JOIN current_account_mappings m ON m.source_account_id=s.id
         WHERE s.source_id='moneyforward-me' ORDER BY s.producer_id`,
      ).all<{ producer_id: string; account_id: string; revision: number }>()
    ).results;
  const [collector, importer] = await mappings();
  expect(collector!.account_id).not.toBe(importer!.account_id);
  expect(importer!.account_id).toBe(await importerEntityId("moneyforward-me", oldRef));
  // Before the crosswalk the v2 value has its own entity, anchored like any
  // identity value (ADR 0029), not the v1 value's.
  expect(collector!.account_id).toBe(await importerEntityId("moneyforward-me", newRef));

  const planned = await plan(env.DB, operator, payload(lines[0]!));
  if (!planned.ok) throw new Error(planned.error);
  const committed = await approveAndCommit(env.DB, operator, planned.plan, "mf-crosswalk-op");
  if (!committed.ok) throw new Error(committed.error);
  expect(await mappings()).toEqual([
    { producer_id: "collector-moneyforward-me", account_id: importer!.account_id, revision: 2 },
    importer!,
  ]);

  // The rule itself now resolves the v2 value to the importer-era entity: a
  // newer policy run over the collector's February parse appends a rule
  // revision that names it.
  const parse = await env.DB.prepare(
    `SELECT p.id,a.id AS artifact_id,a.source_id,r.producer_id,a.fetch_run_id FROM parse_runs p
      JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN fetch_runs r ON r.id=a.fetch_run_id
     WHERE p.status='ok' AND r.producer_id='collector-moneyforward-me' AND a.dataset='monthly-transactions'`,
  ).first<{
    id: number;
    artifact_id: number;
    source_id: string;
    producer_id: string;
    fetch_run_id: number;
  }>();
  await identifyParse(env.DB, parse!, resolveIdentity, 3);
  expect(await mappings()).toEqual([
    { producer_id: "collector-moneyforward-me", account_id: importer!.account_id, revision: 3 },
    importer!,
  ]);
}, 90_000);

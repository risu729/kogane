// The first reconciliation vertical slice (A10): the bounded rule job over
// published Vpass statement rows, the proposal store of migration 0032, and
// the command that turns one candidate into an adopted relation through the
// decision log. Synthetic rows only; no provider data is used anywhere.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { decideProposal, type ProposalCommand } from "../src/reconciliation-commands.ts";
import {
  reconciliationEnabled,
  reconciliationSweep,
  RECONCILIATION_SLICES,
  type ReconciliationSlice,
} from "../src/reconciliation-job.ts";
import { runScheduled } from "../src/worker.ts";
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

let nextArtifact = 900;
let nextParse = 900;

interface SeedRow {
  status: string;
  amount: number;
  asOf: string;
  month: string;
  family: string;
  linkId?: string;
  origin?: string;
}

/** One published parse of one artifact carrying the given synthetic rows. */
async function seedRows(
  source: string,
  card: string,
  rows: readonly SeedRow[],
  publish = true,
): Promise<number> {
  const artifactId = (nextArtifact += 1);
  const parseId = (nextParse += 1);
  await seedArtifact(env, artifactId, source, "statement-page", `${card}-${artifactId}.json`, {});
  await db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'statement-page','1','2026-03-01','ok','[]')",
    )
    .bind(parseId, artifactId)
    .run();
  for (const [index, row] of rows.entries()) {
    const extra = {
      _kogane: {
        statementMonth: row.month,
        statementFamily: row.family,
        identityOrigin: row.origin ?? "sanitized-row+card+month+family+occurrence",
        ...(row.linkId === undefined ? {} : { providerLinkId: row.linkId }),
      },
    };
    await db
      .prepare(
        `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,
         amount_minor,amount_text,amount_scale,currency,counterparty,as_of,observed_at,raw_locator,extra_json)
         VALUES(?,?,?,?,?,?,0,'JPY','synthetic-merchant',?,'2026-03-10T00:00:00Z',?,?)`,
      )
      .bind(
        parseId,
        `${source}:${card}`,
        `${source}:${card}:${row.month}:${row.family}:${index}`,
        row.status,
        row.amount,
        String(row.amount),
        row.asOf,
        `json:$.rows[${index}]`,
        JSON.stringify(extra),
      )
      .run();
  }
  if (publish) await publishParse(db, parseId);
  return parseId;
}

const VPASS: ReconciliationSlice = RECONCILIATION_SLICES[0]!;

async function proposals(): Promise<
  { id: string; kind: string; stage: string; status: string; rationale: string[] }[]
> {
  const rows = await db
    .prepare(
      "SELECT id,kind,stage,status,rationale_codes_json FROM reconciliation_proposals ORDER BY id",
    )
    .all<{
      id: string;
      kind: string;
      stage: string;
      status: string;
      rationale_codes_json: string;
    }>();
  return rows.results.map((row) => ({
    id: row.id,
    kind: row.kind,
    stage: row.stage,
    status: row.status,
    rationale: JSON.parse(row.rationale_codes_json) as string[],
  }));
}

test("the slice is exactly the Vpass pending/posted pair", () => {
  expect(RECONCILIATION_SLICES).toHaveLength(1);
  expect(VPASS).toEqual({
    sourceId: "vpass",
    pendingStatuses: ["unconfirmed"],
    postedStatuses: ["posted"],
  });
  expect(reconciliationEnabled(undefined)).toBe(false);
  expect(reconciliationEnabled("0")).toBe(false);
  expect(reconciliationEnabled("1")).toBe(true);
});

test("a pending and a posted row of one card become one candidate, accepted by nobody", async () => {
  await seedRows("vpass", "card-a", [
    {
      status: "unconfirmed",
      amount: -1200,
      asOf: "2026-03-01",
      month: "2026-03",
      family: "customized",
    },
    { status: "posted", amount: -1234, asOf: "2026-03-02", month: "2026-03", family: "web" },
  ]);
  const first = await reconciliationSweep(db, { now: "2026-03-20T00:00:00Z" });
  expect(first).toMatchObject({ slices: 1, scanned: 2, groups: 1, written: 1, autoAccepted: 0 });
  const stored = await proposals();
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    kind: "pending_to_posted",
    stage: "B",
    status: "proposed",
  });
  // Amount and date closeness only; the rule says so and accepts nothing (UC13).
  expect(stored[0]!.rationale).toContain("no_provider_link_id");
  expect(stored[0]!.rationale).not.toContain("provider_link_id_equal");
  expect(
    await db.prepare("SELECT count(*) AS n FROM entity_relations").first<{ n: number }>(),
  ).toEqual({ n: 0 });
  // Re-running over the same published rows writes nothing new.
  const second = await reconciliationSweep(db, { now: "2026-03-21T00:00:00Z" });
  expect(second).toMatchObject({ scanned: 2, written: 0, autoAccepted: 0 });
  expect(await proposals()).toEqual(stored);
});

test("two posted rows of the same amount are two candidates, never one merge (SC03)", async () => {
  await seedRows("vpass", "card-b", [
    {
      status: "unconfirmed",
      amount: -900,
      asOf: "2026-04-01",
      month: "2026-04",
      family: "customized",
    },
    { status: "posted", amount: -900, asOf: "2026-04-01", month: "2026-04", family: "web" },
    { status: "posted", amount: -900, asOf: "2026-04-01", month: "2026-04", family: "web" },
  ]);
  await reconciliationSweep(db, { now: "2026-04-10T00:00:00Z" });
  const cardB = (await proposals()).filter((row) => row.rationale.includes("multiple_candidates"));
  expect(cardB).toHaveLength(2);
  for (const row of cardB) expect(row.status).toBe("proposed");
});

test("an unpublished parse produces no candidate (docs/publication-gate.md)", async () => {
  const before = (await proposals()).length;
  await seedRows(
    "vpass",
    "card-c",
    [
      {
        status: "unconfirmed",
        amount: -700,
        asOf: "2026-05-01",
        month: "2026-05",
        family: "customized",
      },
      { status: "posted", amount: -700, asOf: "2026-05-01", month: "2026-05", family: "web" },
    ],
    false,
  );
  await reconciliationSweep(db, { now: "2026-05-10T00:00:00Z" });
  expect((await proposals()).length).toBe(before);
});

test("acceptance flows through the decision log and creates exactly one relation", async () => {
  const target = (await proposals()).find((row) => row.status === "proposed")!;
  const command: ProposalCommand = {
    operationId: "op-accept-1",
    actorId: "reviewer",
    actorVerification: "server",
    action: "accept",
    proposalId: target.id,
    expectedStatus: "proposed",
    method: "manual",
    reason: "reviewed against the statement page",
  };
  const accepted = await decideProposal(db, command);
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) throw new Error("unreachable");
  expect(accepted.replayed).toBe(false);
  expect(accepted.receipt.status).toBe("accepted");
  const relation = await db
    .prepare("SELECT id,kind,status,decision_revision_id FROM entity_relations WHERE id=?")
    .bind(accepted.receipt.relationId)
    .first<{ id: string; kind: string; status: string; decision_revision_id: string }>();
  expect(relation).toMatchObject({ kind: "pending_to_posted", status: "accepted" });
  const stored = (await proposals()).find((row) => row.id === target.id)!;
  expect(stored.status).toBe("accepted");
  // A resend of the same command replays the receipt and writes nothing more.
  const replay = await decideProposal(db, command);
  expect(replay).toMatchObject({ ok: true, replayed: true });
  expect(
    await db.prepare("SELECT count(*) AS n FROM entity_relations").first<{ n: number }>(),
  ).toEqual({ n: 1 });
  // A second, different command against the resolved proposal conflicts.
  expect(await decideProposal(db, { ...command, operationId: "op-accept-2" })).toEqual({
    ok: false,
    error: "status_conflict",
  });
  // A different payload under the same operation id is an idempotency conflict.
  expect(await decideProposal(db, { ...command, reason: "different reason" })).toEqual({
    ok: false,
    error: "idempotency_conflict",
  });
});

test("a rejection records the decision and creates no relation", async () => {
  const target = (await proposals()).find((row) => row.status === "proposed")!;
  const rejected = await decideProposal(db, {
    operationId: "op-reject-1",
    actorId: "reviewer",
    actorVerification: "server",
    action: "reject",
    proposalId: target.id,
    expectedStatus: "proposed",
    method: "manual",
    reason: "different merchant on the statement",
  });
  expect(rejected).toMatchObject({ ok: true });
  if (!rejected.ok) throw new Error("unreachable");
  expect(rejected.receipt.relationId).toBeNull();
  const stored = (await proposals()).find((row) => row.id === target.id)!;
  expect(stored.status).toBe("rejected");
  const decision = await db
    .prepare("SELECT decision_kind,method,actor_id FROM decision_revisions WHERE id=?")
    .bind(rejected.receipt.proposalDecisionId)
    .first<{ decision_kind: string; method: string; actor_id: string }>();
  expect(decision).toEqual({ decision_kind: "reject", method: "manual", actor_id: "reviewer" });
});

test("a missing proposal and an unknown command are refused without writing", async () => {
  expect(
    await decideProposal(db, {
      operationId: "op-missing",
      actorId: "reviewer",
      actorVerification: "server",
      action: "accept",
      proposalId: "rp_absent",
      expectedStatus: "proposed",
      method: "manual",
      reason: "x",
    }),
  ).toEqual({ ok: false, error: "proposal_missing" });
  expect(
    await decideProposal(db, {
      operationId: "op bad id",
      actorId: "reviewer",
      actorVerification: "server",
      action: "accept",
      proposalId: "rp_absent",
      expectedStatus: "proposed",
      method: "manual",
      reason: "x",
    } as ProposalCommand),
  ).toEqual({ ok: false, error: "invalid_command" });
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM decision_operations WHERE operation_id='op-missing'")
      .first<{ n: number }>(),
  ).toEqual({ n: 0 });
});

test("an explicit provider link id is the only thing the rule accepts by itself", async () => {
  // A synthetic source that does report a link id for both sides of the pair.
  const slice: ReconciliationSlice = {
    sourceId: "synthetic-linked",
    pendingStatuses: ["unconfirmed"],
    postedStatuses: ["posted"],
  };
  await seedRows("synthetic-linked", "card-l", [
    {
      status: "unconfirmed",
      amount: -500,
      asOf: "2026-06-01",
      month: "2026-06",
      family: "customized",
      linkId: "provider-auth-1",
    },
    {
      status: "posted",
      amount: -500,
      asOf: "2026-06-02",
      month: "2026-06",
      family: "web",
      linkId: "provider-auth-1",
    },
  ]);
  const result = await reconciliationSweep(db, {
    slices: [slice],
    now: "2026-06-10T00:00:00Z",
  });
  expect(result).toMatchObject({ written: 1, autoAccepted: 1 });
  const accepted = (await proposals()).find((row) =>
    row.rationale.includes("provider_link_id_equal"),
  )!;
  expect(accepted.status).toBe("accepted");
  // Even an automatic acceptance is a recorded decision by a named actor.
  const decision = await db
    .prepare(
      "SELECT method,actor_id,decision_kind FROM decision_revisions WHERE subject_ref=? ORDER BY id",
    )
    .bind(`proposal:${accepted.id}`)
    .first<{ method: string; actor_id: string; decision_kind: string }>();
  expect(decision).toEqual({
    method: "rule",
    actor_id: "rule:reconciliation-v1",
    decision_kind: "accept",
  });
  // Re-running is idempotent: the operation ledger replays instead of re-accepting.
  expect(
    await reconciliationSweep(db, { slices: [slice], now: "2026-06-11T00:00:00Z" }),
  ).toMatchObject({
    written: 0,
    autoAccepted: 0,
  });
});

test("the scheduled lane is off unless the flag is on", async () => {
  const lines: Record<string, unknown>[] = [];
  const log = (line: string) => lines.push(JSON.parse(line));
  const stages = {
    parse: () => Promise.resolve({ parsed: 0 }),
    identity: () => Promise.resolve({ processedRuns: 0 }),
    reconcile: (target: Env) => reconciliationSweep(target.DB, { slices: [] }),
    // The balance projection lane always runs and reports itself skipped
    // while its own flag is off (docs/balance-read-model.md); it is here so
    // this test observes the reconciliation lane, not that one.
    balanceProjection: () => Promise.resolve({ enabled: false, status: "skipped" }),
  };
  await runScheduled(env, stages, log);
  expect(lines.map((line) => line.event)).toEqual([
    "observation_sweep",
    "identity_sweep",
    "balance_projection",
  ]);
  lines.length = 0;
  await runScheduled({ ...env, RECONCILIATION_ENABLED: "1" } as unknown as Env, stages, log);
  expect(lines.map((line) => line.event)).toEqual([
    "observation_sweep",
    "identity_sweep",
    "balance_projection",
    "reconciliation_sweep",
  ]);
  // Counts only: no amount, account label or provider text is logged.
  expect(JSON.stringify(lines)).not.toMatch(/1234|card-a|merchant/u);
}, 60_000);

test("migration 0032 applies on 0017 through 0035 with seeded rows and keeps its closed enums", async () => {
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
    expect(migrations).toContain("0032_economic_events.sql");
    await apply(migrations.filter((name) => name < "0032"));
    // Existing rows before the migration: the A10 tables are additive, so a
    // populated database gains them without touching anything it already has.
    await seedArtifact(localEnv, 1, "vpass", "statement-page", "card.json", {});
    await store
      .prepare(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(1,1,'statement-page','1','2026-03-01','ok','[]')",
      )
      .run();
    await store
      .prepare(
        "INSERT INTO transaction_observations(id,parse_run_id,source_account,status,amount_minor,amount_text,amount_scale,currency,as_of,raw_locator,extra_json) VALUES(1,1,'vpass:card','posted',-100,'-100',0,'JPY','2026-03-01','json:$','{}')",
      )
      .run();
    const before = await store
      .prepare("SELECT count(*) AS n FROM transaction_observations")
      .first<{ n: number }>();
    await apply(migrations.filter((name) => name >= "0032"));
    expect(
      await store
        .prepare("SELECT count(*) AS n FROM transaction_observations")
        .first<{ n: number }>(),
    ).toEqual(before!);
    // The new tables exist and are empty; the migration writes no rows.
    for (const table of [
      "reconciliation_proposals",
      "economic_event_revisions",
      "economic_legs",
      "allocations",
      "obligation_revisions",
      "settlement_relations",
    ]) {
      expect(
        await store.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>(),
      ).toEqual({ n: 0 });
    }
    const decision = `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
      VALUES('dr1','relation','event:ev1',1,'accept','rule','rule:test',NULL,'synthetic','[]',NULL,NULL,'2026-03-01T00:00:00Z')`;
    await store.prepare(decision).run();
    const insertEvent = (kind: string, state: string) =>
      store
        .prepare(
          `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
           VALUES('ev1',1,?,?,NULL,'{"kind":"unknown","reasonCode":"x"}','cash-movement','["transaction:1"]','dr1',NULL,'2026-03-01T00:00:00Z')`,
        )
        .bind(kind, state)
        .run();
    // A state outside the kind's own family is refused by the CHECK.
    await expect(insertEvent("purchase", "credited")).rejects.toThrow();
    await expect(insertEvent("nonsense", "captured")).rejects.toThrow();
    await insertEvent("purchase", "captured");
    // An event whose decision does not name it is refused.
    await expect(
      store
        .prepare(
          `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
           VALUES('ev2',1,'purchase','captured',NULL,'{"kind":"unknown","reasonCode":"x"}','cash-movement','["transaction:1"]','dr1',NULL,'2026-03-01T00:00:00Z')`,
        )
        .run(),
    ).rejects.toThrow();
    // Append-only: no delete, and no update of a fact column.
    await expect(store.prepare("DELETE FROM economic_event_revisions").run()).rejects.toThrow();
    await expect(
      store.prepare("UPDATE economic_event_revisions SET kind='refund'").run(),
    ).rejects.toThrow();
    // A proposal is always born `proposed` with no decision.
    await expect(
      store
        .prepare(
          `INSERT INTO reconciliation_proposals(id,kind,stage,target_refs_json,method,policy_release,rationale_codes_json,rejection_conditions_json,evidence_refs_json,status,decision_revision_id,proposal_digest,created_at)
           VALUES('rp1','pending_to_posted','B','[{"kind":"transaction","id":"a","revision":"1"},{"kind":"transaction","id":"b","revision":"1"}]','rule','reconciliation-rules-v1','[]','[]','[]','accepted','dr1',?,'2026-03-01T00:00:00Z')`,
        )
        .bind("a".repeat(64))
        .run(),
    ).rejects.toThrow();
  } finally {
    await local.dispose();
  }
}, 60_000);

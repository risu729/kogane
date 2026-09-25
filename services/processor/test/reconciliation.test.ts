// The first reconciliation vertical slice (A10): the bounded rule job over
// published Vpass statement and MyJCB ledger rows, the proposal store of
// migration 0032, and the command that turns one candidate into an adopted
// relation through the decision log. Synthetic rows only; no provider data is
// used anywhere.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { canonicalDigest } from "../../../packages/domain/src/context.ts";
import {
  proposalIdentity,
  stageAProposals,
  stageBProposals,
  type MatchFact,
} from "../../../packages/domain/src/reconcile.ts";
import { myJcbCreditLedger } from "../../../packages/parsers/src/parsers/myjcb.ts";
import { vpassStatementPage } from "../../../packages/parsers/src/parsers/vpass.ts";
import type { ArtifactMeta, TransactionObservation } from "../../../packages/parsers/src/types.ts";
import { decideProposal, type ProposalCommand } from "../src/reconciliation-commands.ts";
import {
  factOf,
  factPageQuery,
  GROUP_LIMIT,
  GROUP_READ_LIMIT,
  LOOKUP_CHUNK,
  reconciliationEnabled,
  reconciliationSweep,
  RECONCILIATION_SLICES,
  SCAN_LIMIT,
  WRITE_BATCH,
  WRITE_LIMIT,
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
  usageAmountText?: string;
  paymentAmountText?: string;
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
        ...(row.usageAmountText === undefined ? {} : { usageAmountText: row.usageAmountText }),
        ...(row.paymentAmountText === undefined
          ? {}
          : { paymentAmountText: row.paymentAmountText }),
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

test("slices cover Vpass and guarded MyJCB pending/posted pairs", () => {
  expect(RECONCILIATION_SLICES).toHaveLength(2);
  expect(VPASS).toEqual({
    sourceId: "vpass",
    pendingStatuses: ["unconfirmed"],
    postedStatuses: ["posted"],
  });
  expect(reconciliationEnabled(undefined)).toBe(false);
  expect(reconciliationEnabled("0")).toBe(false);
  expect(reconciliationEnabled("1")).toBe(true);
});

test("both Vpass id forms stay collector fingerprints, so stage A pairs neither", () => {
  // vpass-statement-page@1.2.0 names every page after the first in the
  // external id and records `...+page+occurrence` as its identityOrigin. Both
  // origins must still read as collector fingerprints, never provider ids.
  const customized = readFileSync(
    new URL(
      "../../../tests/fixtures/observation-pipeline/vpass-parser-boundaries/customized.json",
      import.meta.url,
    ),
  );
  const parsed = (page: string) =>
    vpassStatementPage
      .parse(customized, {
        id: 1,
        sourceId: "vpass",
        runStatus: "success",
        runFailureCount: 0,
        dataset: "statement-page",
        url: null,
        mime: "application/json",
        artifactKey: `cards/card-001/months/202608/${page}.json`,
        fetchUnitKey: "card-001",
        fetchedAt: "2026-08-30T00:00:00.000Z",
        sha256: "0".repeat(64),
      } satisfies ArtifactMeta)
      .observations.filter((row): row is TransactionObservation => row.kind === "transaction")[0]!;
  const fact = (row: TransactionObservation, id: number) => {
    const kogane = row.extra["_kogane"] as Record<string, string>;
    return factOf(
      {
        id,
        parse_run_id: id,
        source_account: row.sourceAccount,
        external_id: row.externalId ?? null,
        status: row.status ?? null,
        as_of: row.asOf ?? null,
        counterparty: row.counterparty ?? null,
        currency: row.currency ?? null,
        source_id: "vpass",
        producer_id: "synthetic-producer",
        external_id_namespace: null,
        value_status: "exact",
        coefficient: String(row.amountMinor),
        scale: 0,
        value_basis: "minor_units",
        statement_period: kogane["statementMonth"]!,
        provider_link_id: null,
        identity_origin: kogane["identityOrigin"]!,
        usage_amount_text: null,
        payment_amount_text: null,
      },
      VPASS,
    );
  };
  const first = fact(parsed("top-000"), 1);
  const later = fact(parsed("answer-001"), 2);
  expect(first.identifierOrigin).toBe("collector-fingerprint");
  expect(later.identifierOrigin).toBe("collector-fingerprint");
  // The same row on two pages of one capture: two ids, nothing to propose.
  expect(stageAProposals([first, later])).toEqual([]);
  // The same row in two captures shares its fingerprint, and is still not a
  // provider row id: snapshot currentness, not a relation, picks the capture.
  const again = fact(parsed("answer-001"), 3);
  expect(again.externalId).toBe(later.externalId);
  expect(stageAProposals([later, again])).toEqual([]);
  expect(stageAProposals([first, fact(parsed("top-000"), 4)])).toEqual([]);
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
  expect(first).toMatchObject({ slices: 2, scanned: 2, groups: 1, written: 1, autoAccepted: 0 });
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
  // The ends are the targets' own refs, `transaction:<id>`: a SourceFactRef id
  // already carries its kind and is never prefixed a second time.
  const targets = await db
    .prepare("SELECT target_refs_json,evidence_refs_json FROM reconciliation_proposals WHERE id=?")
    .bind(target.id)
    .first<{ target_refs_json: string; evidence_refs_json: string }>();
  const [pending, posted] = JSON.parse(targets!.target_refs_json) as { id: string }[];
  expect(
    await db
      .prepare("SELECT from_ref,to_ref,evidence_refs_json FROM entity_relations WHERE id=?")
      .bind(accepted.receipt.relationId)
      .first<Record<string, unknown>>(),
  ).toEqual({
    from_ref: pending!.id,
    to_ref: posted!.id,
    evidence_refs_json: JSON.stringify([pending!.id, posted!.id]),
  });
  expect(pending!.id).toMatch(/^transaction:[0-9]+$/u);
  expect(posted!.id).toMatch(/^transaction:[0-9]+$/u);
  expect(JSON.parse(targets!.evidence_refs_json)).toEqual([pending!.id, posted!.id]);
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

test("MyJCB full one-payment rows propose, installment slices do not mimic a pending purchase", async () => {
  const myjcb = RECONCILIATION_SLICES.find((slice) => slice.sourceId === "myjcb")!;
  await seedRows("myjcb", "full-payment", [
    { status: "unconfirmed", amount: -1200, asOf: "2026-09-01", month: "202609", family: "ledger" },
    {
      status: "confirmed",
      amount: -1200,
      asOf: "2026-09-01",
      month: "202609",
      family: "ledger",
      usageAmountText: "1,200",
      paymentAmountText: "1,200",
    },
  ]);
  await seedRows("myjcb", "installment-slice", [
    { status: "unconfirmed", amount: -300, asOf: "2026-09-01", month: "202609", family: "ledger" },
    {
      status: "confirmed",
      amount: -300,
      asOf: "2026-09-01",
      month: "202609",
      family: "ledger",
      usageAmountText: "1,200",
      paymentAmountText: "300",
    },
  ]);
  const result = await reconciliationSweep(db, { slices: [myjcb] });
  expect(result.written).toBe(1);
  expect(result.autoAccepted).toBe(0);
});

// ---------------------------------------------------------------------------
// MyJCB rows as the deployed ledger parser emits them
// ---------------------------------------------------------------------------

const MYJCB: ReconciliationSlice = RECONCILIATION_SLICES.find(
  (slice) => slice.sourceId === "myjcb",
)!;
/** One payment month, shown first by the unconfirmed ledger and then by the confirmed one. */
const MYJCB_PERIOD = "2026年10月お支払い分";
/** Every observation `seedLedger` stored, across the tests below. */
const ledgerObservations: number[] = [];

interface LedgerRow {
  /** `YYYY/MM/DD`, as the collector copies the provider's cell. */
  date: string;
  merchant: string;
  paymentType: string;
  /** The summary amount cell: the usage while unconfirmed, this statement's payment once confirmed. */
  amount: string;
  /** The expanded amount (payment while unconfirmed, usage once confirmed); default `amount`. */
  other?: string;
}

/**
 * One published `credit-ledger` capture of a MyJCB connection, in the shape the
 * collector writes (services/collector-myjcb/test/parsers.test.ts: `1,000円`
 * cells, `一回払い`), parsed by the deployed ledger parser and stored exactly
 * as it emits each row. Returns the observation ids in row order.
 */
async function seedLedger(
  connection: string,
  state: "unconfirmed" | "confirmed",
  rows: readonly LedgerRow[],
  period = MYJCB_PERIOD,
): Promise<number[]> {
  const artifactId = (nextArtifact += 1);
  const parseId = (nextParse += 1);
  const detailMonth = state === "unconfirmed" ? 0 : 1;
  const key = `${connection}/credit-ledger-0${detailMonth}.json`;
  const ledger = {
    schemaVersion: 1,
    detailMonth,
    period,
    state,
    headers: [
      "ご利用日",
      "ご利用先など",
      "支払区分",
      state === "confirmed" ? "今回のお支払い金額" : "ご利用金額",
    ],
    rows: rows.map((row) => ({
      summaryCells: [row.date, row.merchant, row.paymentType, row.amount],
      expanded: {
        [state === "confirmed" ? "ご利用金額" : "今回のお支払い金額"]: row.other ?? row.amount,
        摘要: "",
        今回回数: "1",
        備考: "",
        訂正サイン: "",
      },
    })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(ledger));
  await seedArtifact(env, artifactId, "myjcb", "credit-ledger", key, bytes);
  await db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,?,'2026-10-01','pending','[]')",
    )
    .bind(parseId, artifactId, myJcbCreditLedger.name, myJcbCreditLedger.version)
    .run();
  const parsed = myJcbCreditLedger
    .parse(bytes, {
      id: artifactId,
      sourceId: "myjcb",
      runStatus: "success",
      runFailureCount: 0,
      dataset: "credit-ledger",
      url: null,
      mime: "application/json",
      artifactKey: key,
      statementState: state,
      period,
      fetchedAt: "2026-10-01T00:00:00.000Z",
      sha256: "0".repeat(64),
    })
    .observations.filter((row): row is TransactionObservation => row.kind === "transaction");
  const ids: number[] = [];
  for (const row of parsed) {
    const inserted = await db
      .prepare(
        `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .bind(
        parseId,
        row.sourceAccount,
        row.externalId ?? null,
        row.status ?? null,
        row.amountMinor ?? null,
        row.amountText ?? null,
        row.amountScale ?? null,
        row.currency ?? null,
        row.description ?? null,
        row.counterparty ?? null,
        row.asOf ?? null,
        row.observedAt ?? null,
        row.rawLocator,
        JSON.stringify(row.extra),
      )
      .first<{ id: number }>();
    ids.push(inserted!.id);
  }
  await db.prepare("UPDATE parse_runs SET status='ok' WHERE id=?").bind(parseId).run();
  await publishParse(db, parseId);
  ledgerObservations.push(...ids);
  return ids;
}

interface StoredProposal {
  id: string;
  kind: string;
  stage: string;
  status: string;
  rationale: string[];
  /** `transaction:<observation id>` of the pending side, then the posted side. */
  targets: string[];
}

/** Stored proposals that cite any of the given observations. */
async function citing(observations: readonly number[]): Promise<StoredProposal[]> {
  const refs = new Set(observations.map((id) => `transaction:${id}`));
  const rows = await db
    .prepare(
      "SELECT id,kind,stage,status,rationale_codes_json,target_refs_json FROM reconciliation_proposals ORDER BY id",
    )
    .all<{
      id: string;
      kind: string;
      stage: string;
      status: string;
      rationale_codes_json: string;
      target_refs_json: string;
    }>();
  return rows.results
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      stage: row.stage,
      status: row.status,
      rationale: JSON.parse(row.rationale_codes_json) as string[],
      targets: (JSON.parse(row.target_refs_json) as { id: string }[]).map((ref) => ref.id),
    }))
    .filter((row) => row.targets.some((target) => refs.has(target)));
}

/** The facts of one connection exactly as the job reads them, before the installment guard. */
async function unguardedFacts(connection: string): Promise<MatchFact[]> {
  const rows = await db
    .prepare(factPageQuery)
    .bind(
      MYJCB.sourceId,
      JSON.stringify([...MYJCB.pendingStatuses, ...MYJCB.postedStatuses]),
      0,
      1_000,
    )
    .all<Parameters<typeof factOf>[0]>();
  return rows.results
    .filter((row) => row.source_account === `myjcb:${connection}:root`)
    .map((row) => factOf(row, MYJCB));
}

test("a MyJCB pending row and its confirmed row with 1,200円 texts become one reviewed candidate", async () => {
  const purchase = { date: "2026/09/10", merchant: "架空書店", paymentType: "一回払い" };
  const [pending] = await seedLedger("conn-match", "unconfirmed", [
    { ...purchase, amount: "1,200円" },
  ]);
  const [posted] = await seedLedger("conn-match", "confirmed", [
    { ...purchase, amount: "1,200円" },
  ]);
  // What the parser handed over and the job reads: display text, not digits.
  const facts = await unguardedFacts("conn-match");
  expect(facts).toHaveLength(2);
  const texts = await db
    .prepare(
      "SELECT json_extract(extra_json,'$._kogane.usageAmountText') AS usage,json_extract(extra_json,'$._kogane.paymentAmountText') AS payment FROM transaction_observations WHERE id=?",
    )
    .bind(posted!)
    .first<{ usage: string; payment: string }>();
  expect(texts).toEqual({ usage: "1,200円", payment: "1,200円" });

  const result = await reconciliationSweep(db, { slices: [MYJCB], now: "2026-10-02T00:00:00Z" });
  expect(result).toMatchObject({ written: 1, autoAccepted: 0 });
  const stored = await citing([pending!, posted!]);
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({
    kind: "pending_to_posted",
    stage: "B",
    status: "proposed",
    targets: [`transaction:${pending}`, `transaction:${posted}`],
  });
  expect(stored[0]!.rationale).toEqual(
    expect.arrayContaining([
      "no_provider_link_id",
      "same_statement_period",
      "date_within_window",
      "amount_equal",
      "counterparty_equal",
    ]),
  );
  expect(stored[0]!.rationale).not.toContain("multiple_candidates");
  // The stored row is the matcher's candidate, and the matcher never makes a
  // MyJCB pair auto-acceptable: no source supplies a provider link id.
  const [candidate, ...others] = stageBProposals(facts);
  expect(others).toEqual([]);
  expect(candidate).toMatchObject({
    kind: "pending_to_posted",
    stage: "B",
    status: "proposed",
    autoAcceptable: false,
  });
  expect(`rp_${await canonicalDigest(proposalIdentity(candidate!))}`).toBe(stored[0]!.id);
  expect(
    await db
      .prepare("SELECT count(*) AS n FROM decision_revisions WHERE subject_ref=?")
      .bind(`proposal:${stored[0]!.id}`)
      .first<{ n: number }>(),
  ).toEqual({ n: 0 });
});

test("a MyJCB installment slice (usage 12,000 / payment 4,000) is never compared", async () => {
  const purchase = { date: "2026/09/12", merchant: "架空家電" };
  const [pending] = await seedLedger("conn-installment", "unconfirmed", [
    { ...purchase, paymentType: "分割払い", amount: "12,000円", other: "4,000円" },
  ]);
  const slices = await seedLedger("conn-installment", "confirmed", [
    { ...purchase, paymentType: "分割払い", amount: "4,000円", other: "12,000円" },
    // A payment type that drifted to look single does not hide the slice.
    { ...purchase, paymentType: "一回払い", amount: "4,000円", other: "12,000円" },
  ]);
  // Without the guard the matcher would pair the pending purchase with each slice.
  expect(stageBProposals(await unguardedFacts("conn-installment"))).toHaveLength(2);
  const result = await reconciliationSweep(db, { slices: [MYJCB], now: "2026-10-02T00:00:00Z" });
  expect(result).toMatchObject({ written: 0, autoAccepted: 0 });
  expect(await citing([pending!, ...slices])).toEqual([]);
});

test("two MyJCB confirmed rows of the same amount stay two candidates, never one merge (SC03)", async () => {
  const purchase = { date: "2026/09/15", merchant: "架空売店", paymentType: "一回払い" };
  const [pending] = await seedLedger("conn-twins", "unconfirmed", [
    { ...purchase, amount: "900円" },
  ]);
  const twins = await seedLedger("conn-twins", "confirmed", [
    { ...purchase, amount: "900円" },
    { ...purchase, amount: "900円" },
  ]);
  expect(twins).toHaveLength(2);
  const result = await reconciliationSweep(db, { slices: [MYJCB], now: "2026-10-02T00:00:00Z" });
  expect(result).toMatchObject({ written: 2, autoAccepted: 0 });
  const stored = await citing([pending!, ...twins]);
  expect(stored).toHaveLength(2);
  for (const row of stored) {
    expect(row).toMatchObject({ kind: "pending_to_posted", stage: "B", status: "proposed" });
    expect(row.rationale).toEqual(expect.arrayContaining(["amount_equal", "multiple_candidates"]));
    expect(row.targets[0]).toBe(`transaction:${pending}`);
  }
  // Each twin is its own candidate; the two posted rows are not proposed as one row.
  expect(stored.map((row) => row.targets[1]).sort()).toEqual(
    twins.map((id) => `transaction:${id}`).sort(),
  );
});

test("re-running the sweep over the same MyJCB rows writes no duplicate proposal", async () => {
  const before = await proposals();
  // The one matched pair and the two twin candidates above.
  expect(await citing(ledgerObservations)).toHaveLength(3);
  const result = await reconciliationSweep(db, { slices: [MYJCB], now: "2026-10-03T00:00:00Z" });
  expect(result.scanned).toBeGreaterThanOrEqual(ledgerObservations.length);
  expect(result).toMatchObject({ written: 0, autoAccepted: 0 });
  expect(await proposals()).toEqual(before);
  expect(await citing(ledgerObservations)).toHaveLength(3);
});

test("a proposal already decided is never proposed again", async () => {
  const [pair] = await citing(ledgerObservations);
  const rejected = await decideProposal(db, {
    operationId: "op-reject-myjcb",
    actorId: "reviewer",
    actorVerification: "server",
    action: "reject",
    proposalId: pair!.id,
    expectedStatus: "proposed",
    method: "manual",
    reason: "reviewed against the ledger",
  });
  expect(rejected).toMatchObject({ ok: true });
  const before = await proposals();
  const result = await reconciliationSweep(db, { slices: [MYJCB], now: "2026-10-04T00:00:00Z" });
  expect(result).toMatchObject({ written: 0, autoAccepted: 0 });
  expect(await proposals()).toEqual(before);
  expect((await citing(ledgerObservations)).find((row) => row.id === pair!.id)?.status).toBe(
    "rejected",
  );
});

test("a relative MyJCB label (detailMonth-N) names no payment month, so nothing pairs under it", async () => {
  // The collector writes `detailMonth-N` for a month the past-months API does
  // not label; the same label names a different payment month next month.
  const purchase = { date: "2026/09/20", merchant: "架空薬局", paymentType: "一回払い" };
  const [pending] = await seedLedger(
    "conn-relative",
    "unconfirmed",
    [{ ...purchase, amount: "1,200円" }],
    "detailMonth-1",
  );
  const [posted] = await seedLedger(
    "conn-relative",
    "confirmed",
    [{ ...purchase, amount: "1,200円" }],
    "detailMonth-1",
  );
  // Grouped by the label alone the matcher would claim one statement period.
  const [unguarded, ...others] = stageBProposals(await unguardedFacts("conn-relative"));
  expect(others).toEqual([]);
  expect(unguarded!.rationaleCodes).toContain("same_statement_period");
  const before = await proposals();
  const result = await reconciliationSweep(db, { slices: [MYJCB], now: "2026-10-05T00:00:00Z" });
  expect(result).toMatchObject({ written: 0, autoAccepted: 0 });
  expect(await citing([pending!, posted!])).toEqual([]);
  expect(await proposals()).toEqual(before);
});

test("a MyJCB confirmed row re-captured by a later run is not proposed as the same row", async () => {
  // Every daily run re-captures each listed month under the same collector
  // fingerprint, which is not a provider row id: stage A pairs nothing.
  const row = {
    date: "2026/09/22",
    merchant: "架空文具",
    paymentType: "一回払い",
    amount: "700円",
  };
  const first = await seedLedger("conn-recapture", "confirmed", [row]);
  const second = await seedLedger("conn-recapture", "confirmed", [row]);
  const captures = await unguardedFacts("conn-recapture");
  expect(captures).toHaveLength(2);
  expect(captures[0]!.externalId).toBe(captures[1]!.externalId);
  expect(captures.map((fact) => fact.identifierOrigin)).toEqual([
    "collector-fingerprint",
    "collector-fingerprint",
  ]);
  expect(stageAProposals(captures)).toEqual([]);
  const result = await reconciliationSweep(db, { slices: [MYJCB], now: "2026-10-06T00:00:00Z" });
  expect(result).toMatchObject({ written: 0, autoAccepted: 0 });
  expect(await citing([...first, ...second])).toEqual([]);
  // A pending row of the same month still pairs with each capture, as a candidate.
  const [pending] = await seedLedger("conn-recapture", "unconfirmed", [row]);
  const paired = await reconciliationSweep(db, { slices: [MYJCB], now: "2026-10-07T00:00:00Z" });
  expect(paired).toMatchObject({ written: 2, autoAccepted: 0 });
  const stored = await citing([pending!]);
  expect(stored.map((proposal) => [proposal.stage, proposal.targets[0]])).toEqual([
    ["B", `transaction:${pending}`],
    ["B", `transaction:${pending}`],
  ]);
});

// ---------------------------------------------------------------------------
// Stage A over parsed Vpass captures, the scan cursor, and the matching window
// ---------------------------------------------------------------------------

const NOW = "2026-10-10T00:00:00Z";

/** A synthetic slice of its own, so each test below pages only its own rows. */
function syntheticSlice(sourceId: string): ReconciliationSlice {
  return { sourceId, pendingStatuses: ["unconfirmed"], postedStatuses: ["posted"] };
}

/** The observation ids a `seedRows` parse stored, in row order. */
async function observationsOf(parseId: number): Promise<number[]> {
  const rows = await db
    .prepare("SELECT id FROM transaction_observations WHERE parse_run_id=? ORDER BY id")
    .bind(parseId)
    .all<{ id: number }>();
  return rows.results.map((row) => row.id);
}

async function cursorOf(sourceId: string): Promise<number | null> {
  return (
    (
      await db
        .prepare("SELECT last_observation_id FROM reconciliation_scan_cursor WHERE source_id=?")
        .bind(sourceId)
        .first<{ last_observation_id: number }>()
    )?.last_observation_id ?? null
  );
}

/** The D1 binding, counting proposal inserts, digest lookups and batches sent through it. */
function counting(target: D1Database): {
  db: D1Database;
  sent: { inserts: number; lookups: number; batches: number };
} {
  const sent = { inserts: 0, lookups: 0, batches: 0 };
  return {
    sent,
    db: {
      prepare(sql: string) {
        if (sql.startsWith("INSERT INTO reconciliation_proposals")) sent.inserts += 1;
        if (sql.startsWith("SELECT proposal_digest")) sent.lookups += 1;
        return target.prepare(sql);
      },
      batch(statements: D1PreparedStatement[]) {
        sent.batches += 1;
        return target.batch(statements);
      },
    } as unknown as D1Database,
  };
}

/**
 * One published capture of the synthetic Vpass statement page fixture, parsed
 * by the deployed parser (vpass-statement-page@1.2.0) and stored exactly as it
 * emits each row.
 */
async function seedVpassCapture(family: "customized" | "web", page: string): Promise<number[]> {
  const artifactId = (nextArtifact += 1);
  const parseId = (nextParse += 1);
  const key = `cards/card-001/months/202608/${page}.json`;
  const bytes = readFileSync(
    new URL(
      `../../../tests/fixtures/observation-pipeline/vpass-parser-boundaries/${family}.json`,
      import.meta.url,
    ),
  );
  await seedArtifact(env, artifactId, "vpass", "statement-page", key, new Uint8Array(bytes));
  await db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,?,'2026-08-30','pending','[]')",
    )
    .bind(parseId, artifactId, vpassStatementPage.name, vpassStatementPage.version)
    .run();
  const parsed = vpassStatementPage
    .parse(bytes, {
      id: artifactId,
      sourceId: "vpass",
      runStatus: "success",
      runFailureCount: 0,
      dataset: "statement-page",
      url: null,
      mime: "application/json",
      artifactKey: key,
      fetchUnitKey: "card-001",
      fetchedAt: "2026-08-30T00:00:00.000Z",
      sha256: "0".repeat(64),
    } satisfies ArtifactMeta)
    .observations.filter((row): row is TransactionObservation => row.kind === "transaction");
  const ids: number[] = [];
  for (const row of parsed) {
    const inserted = await db
      .prepare(
        `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
      .bind(
        parseId,
        row.sourceAccount,
        row.externalId ?? null,
        row.status ?? null,
        row.amountMinor ?? null,
        row.amountText ?? null,
        row.amountScale ?? null,
        row.currency ?? null,
        row.description ?? null,
        row.counterparty ?? null,
        row.asOf ?? null,
        row.observedAt ?? null,
        row.rawLocator,
        JSON.stringify(row.extra),
      )
      .first<{ id: number }>();
    ids.push(inserted!.id);
  }
  await db.prepare("UPDATE parse_runs SET status='ok' WHERE id=?").bind(parseId).run();
  await publishParse(db, parseId);
  return ids;
}

test("two captures parsed by the deployed Vpass 1.2.0 parser write no stage A proposal", async () => {
  // Every daily capture re-lists the month: the same rows under the same
  // collector fingerprints, on the first page and on a later one.
  const captures = [
    ...(await seedVpassCapture("customized", "top-000")),
    ...(await seedVpassCapture("customized", "top-000")),
    ...(await seedVpassCapture("customized", "answer-001")),
    ...(await seedVpassCapture("customized", "answer-001")),
    ...(await seedVpassCapture("web", "top-000")),
    ...(await seedVpassCapture("web", "top-000")),
  ];
  const ids = await db
    .prepare(
      `SELECT external_id,json_extract(extra_json,'$._kogane.identityOrigin') AS origin,count(*) AS n
       FROM transaction_observations WHERE id IN (SELECT value FROM json_each(?))
       GROUP BY external_id ORDER BY external_id`,
    )
    .bind(JSON.stringify(captures))
    .all<{ external_id: string; origin: string; n: number }>();
  // Each external id is shared by its two captures, and both origins are
  // collector fingerprints the job never reads as provider ids.
  expect(ids.results.map((row) => row.n)).toEqual(ids.results.map(() => 2));
  expect(new Set(ids.results.map((row) => row.origin))).toEqual(
    new Set([
      "sanitized-row+card+month+family+occurrence",
      "sanitized-row+card+month+family+page+occurrence",
    ]),
  );
  await reconciliationSweep(db, { slices: [VPASS], now: NOW });
  expect((await citing(captures)).filter((row) => row.stage === "A")).toEqual([]);
  expect(
    await db
      .prepare(
        "SELECT count(*) AS n FROM reconciliation_proposals WHERE kind='provider_same' AND EXISTS(SELECT 1 FROM json_each(target_refs_json) r WHERE json_extract(r.value,'$.id') IN (SELECT 'transaction:'||value FROM json_each(?)))",
      )
      .bind(JSON.stringify(captures))
      .first<{ n: number }>(),
  ).toEqual({ n: 0 });
});

test("a provider row id seen in two captures is still a stage A pair, accepted as a decision", async () => {
  const slice = syntheticSlice("synthetic-provider-id");
  const row = {
    status: "posted",
    amount: -2500,
    asOf: "2026-07-05",
    month: "2026-07",
    family: "web",
    origin: "provider-row-id",
  };
  const first = await observationsOf(await seedRows("synthetic-provider-id", "acct", [row]));
  const second = await observationsOf(await seedRows("synthetic-provider-id", "acct", [row]));
  const result = await reconciliationSweep(db, { slices: [slice], now: NOW });
  expect(result).toMatchObject({ groups: 1, proposed: 1, written: 1, autoAccepted: 1 });
  const [pair, ...others] = await citing([...first, ...second]);
  expect(others).toEqual([]);
  expect(pair).toMatchObject({
    kind: "provider_same",
    stage: "A",
    status: "accepted",
    targets: [`transaction:${first[0]}`, `transaction:${second[0]}`],
  });
  expect(pair!.rationale).toEqual(
    expect.arrayContaining(["provider_identifier_equal", "same_identifier_namespace"]),
  );
  expect(pair!.rationale).not.toContain("collector_fingerprint_identifier");
  expect(await reconciliationSweep(db, { slices: [slice], now: NOW })).toMatchObject({
    known: 1,
    written: 0,
    autoAccepted: 0,
  });
});

test("a slice larger than one page is visited in full across ticks, then wraps", async () => {
  // The bounds docs/economic-events.md documents for one tick.
  expect({
    SCAN_LIMIT,
    GROUP_LIMIT,
    GROUP_READ_LIMIT,
    WRITE_LIMIT,
    LOOKUP_CHUNK,
    WRITE_BATCH,
  }).toEqual({
    SCAN_LIMIT: 1_000,
    GROUP_LIMIT: 200,
    GROUP_READ_LIMIT: 2_000,
    WRITE_LIMIT: 500,
    LOOKUP_CHUNK: 1_000,
    WRITE_BATCH: 100,
  });
  const slice = syntheticSlice("synthetic-paged");
  // A July purchase whose posted row sits two rows after its pending row, and
  // an August purchase that only later pages reach.
  const july = await observationsOf(
    await seedRows("synthetic-paged", "card-p", [
      { status: "unconfirmed", amount: -100, asOf: "2026-07-01", month: "2026-07", family: "c" },
      { status: "posted", amount: -999, asOf: "2026-07-25", month: "2026-07", family: "web" },
      { status: "posted", amount: -100, asOf: "2026-07-02", month: "2026-07", family: "web" },
    ]),
  );
  const august = await observationsOf(
    await seedRows("synthetic-paged", "card-p", [
      { status: "unconfirmed", amount: -200, asOf: "2026-08-01", month: "2026-08", family: "c" },
      { status: "posted", amount: -200, asOf: "2026-08-03", month: "2026-08", family: "web" },
    ]),
  );
  const tick = { slices: [slice], now: NOW, scanLimit: 2 };
  expect(await cursorOf(slice.sourceId)).toBeNull();
  // Page 1 holds July's pending row; its posted row is read with its group.
  expect(await reconciliationSweep(db, tick)).toMatchObject({
    scanned: 2,
    groups: 1,
    proposed: 1,
    known: 0,
    written: 1,
  });
  expect(await cursorOf(slice.sourceId)).toBe(july[1]!);
  // Page 2 reaches August. July's pair is stored, so only August's is sent.
  expect(await reconciliationSweep(db, tick)).toMatchObject({
    scanned: 2,
    groups: 2,
    proposed: 2,
    known: 1,
    written: 1,
  });
  expect(await cursorOf(slice.sourceId)).toBe(august[0]!);
  // The last, short page wraps the cursor to 0.
  expect(await reconciliationSweep(db, tick)).toMatchObject({ scanned: 1, known: 1, written: 0 });
  expect(await cursorOf(slice.sourceId)).toBe(0);
  // The next cycle starts over and finds everything stored.
  expect(await reconciliationSweep(db, tick)).toMatchObject({ scanned: 2, known: 1, written: 0 });
  expect(await cursorOf(slice.sourceId)).toBe(july[1]!);
  const stored = await citing([...july, ...august]);
  expect(stored.map((row) => row.targets)).toEqual(
    expect.arrayContaining([
      [`transaction:${july[0]}`, `transaction:${july[2]}`],
      [`transaction:${august[0]}`, `transaction:${august[1]}`],
    ]),
  );
  expect(stored).toHaveLength(2);

  // An exactly full last page wraps on the next tick, whose page is empty.
  await db
    .prepare("UPDATE reconciliation_scan_cursor SET last_observation_id=? WHERE source_id=?")
    .bind(august[0]!, slice.sourceId)
    .run();
  expect(await reconciliationSweep(db, { ...tick, scanLimit: 1 })).toMatchObject({ scanned: 1 });
  expect(await cursorOf(slice.sourceId)).toBe(august[1]!);
  expect(await reconciliationSweep(db, { ...tick, scanLimit: 1 })).toMatchObject({ scanned: 0 });
  expect(await cursorOf(slice.sourceId)).toBe(0);

  // An overlapping tick moves the cursor after this tick read it: this
  // tick's update is conditional on the value it read, so it leaves that move.
  const overlapping = {
    prepare(sql: string) {
      if (!sql.startsWith("SELECT last_observation_id FROM reconciliation_scan_cursor"))
        return db.prepare(sql);
      return {
        bind: (...args: unknown[]) => ({
          async first() {
            const read = await db
              .prepare(sql)
              .bind(...args)
              .first();
            await db
              .prepare(
                "UPDATE reconciliation_scan_cursor SET last_observation_id=? WHERE source_id=?",
              )
              .bind(august[0]!, slice.sourceId)
              .run();
            return read;
          },
        }),
      };
    },
    batch: (statements: D1PreparedStatement[]) => db.batch(statements),
  } as unknown as D1Database;
  expect(await reconciliationSweep(overlapping, tick)).toMatchObject({ scanned: 2, written: 0 });
  expect(await cursorOf(slice.sourceId)).toBe(august[0]!);
});

test("groups past the group read wait, and the cursor stops before their first row", async () => {
  const slice = syntheticSlice("synthetic-deferred");
  const rows = (month: string, day: string, amount: number) => [
    { status: "unconfirmed", amount, asOf: `${month}-${day}`, month, family: "c" },
    { status: "posted", amount, asOf: `${month}-${day}`, month, family: "web" },
  ];
  const may = await observationsOf(
    await seedRows("synthetic-deferred", "card-d", rows("2026-05", "03", -300)),
  );
  const june = await observationsOf(
    await seedRows("synthetic-deferred", "card-d", rows("2026-06", "04", -400)),
  );
  // Both groups are on the page, but only May fits a group read of two rows.
  const tick = { slices: [slice], now: NOW, groupReadLimit: 2 };
  expect(await reconciliationSweep(db, tick)).toMatchObject({
    scanned: 4,
    groups: 1,
    groupsDeferred: 1,
    written: 1,
  });
  expect(await cursorOf(slice.sourceId)).toBe(june[0]! - 1);
  expect(await reconciliationSweep(db, tick)).toMatchObject({
    scanned: 2,
    groups: 1,
    groupsDeferred: 0,
    written: 1,
  });
  expect(await cursorOf(slice.sourceId)).toBe(0);
  expect(await citing([...may, ...june])).toHaveLength(2);
});

test("only the posted row inside the window after its pending row is proposed", async () => {
  const slice = syntheticSlice("synthetic-window");
  const [pending, before, late, inside] = await observationsOf(
    await seedRows("synthetic-window", "card-w", [
      { status: "unconfirmed", amount: -500, asOf: "2026-08-10", month: "2026-08", family: "c" },
      // Same card, month and amount, but dated before the authorisation.
      { status: "posted", amount: -500, asOf: "2026-08-09", month: "2026-08", family: "web" },
      // One day past the window.
      { status: "posted", amount: -500, asOf: "2026-08-16", month: "2026-08", family: "web" },
      { status: "posted", amount: -500, asOf: "2026-08-12", month: "2026-08", family: "web" },
    ]),
  );
  expect(await reconciliationSweep(db, { slices: [slice], now: NOW })).toMatchObject({
    groups: 1,
    proposed: 1,
    written: 1,
  });
  const [pair, ...others] = await citing([pending!, before!, late!, inside!]);
  expect(others).toEqual([]);
  expect(pair!.targets).toEqual([`transaction:${pending}`, `transaction:${inside}`]);
  expect(pair!.rationale).toEqual(
    expect.arrayContaining(["date_within_window", "same_statement_period", "amount_equal"]),
  );
  // The pairs outside the window were never candidates, so nothing is ambiguous.
  expect(pair!.rationale).not.toContain("multiple_candidates");
});

test("a stored proposal is never sent again, and a decided one is never proposed again", async () => {
  const slice = syntheticSlice("synthetic-resend");
  const purchase = (day: string, amount: number) => [
    { status: "unconfirmed", amount, asOf: `2026-07-${day}`, month: "2026-07", family: "c" },
    { status: "posted", amount, asOf: `2026-07-${day}`, month: "2026-07", family: "web" },
  ];
  const first = await observationsOf(
    await seedRows("synthetic-resend", "card-r", purchase("01", -300)),
  );
  const fresh = counting(db);
  expect(await reconciliationSweep(fresh.db, { slices: [slice], now: NOW })).toMatchObject({
    proposed: 1,
    known: 0,
    written: 1,
  });
  expect(fresh.sent).toEqual({ inserts: 1, lookups: 1, batches: 1 });
  // The same rows again: one lookup, and not one statement sent to write.
  const again = counting(db);
  expect(await reconciliationSweep(again.db, { slices: [slice], now: NOW })).toMatchObject({
    proposed: 1,
    known: 1,
    written: 0,
  });
  expect(again.sent).toEqual({ inserts: 0, lookups: 1, batches: 0 });
  // A new purchase in the same group: only its pair is sent.
  const second = await observationsOf(
    await seedRows("synthetic-resend", "card-r", purchase("20", -400)),
  );
  const added = counting(db);
  expect(await reconciliationSweep(added.db, { slices: [slice], now: NOW })).toMatchObject({
    proposed: 2,
    known: 1,
    written: 1,
  });
  expect(added.sent).toEqual({ inserts: 1, lookups: 1, batches: 1 });
  // A reviewer rejects the first pair; the rule never proposes it again.
  const [firstPair] = await citing(first);
  expect(firstPair!.targets).toEqual(first.map((id) => `transaction:${id}`));
  expect(
    await decideProposal(db, {
      operationId: "op-reject-resend",
      actorId: "reviewer",
      actorVerification: "server",
      action: "reject",
      proposalId: firstPair!.id,
      expectedStatus: "proposed",
      method: "manual",
      reason: "reviewed against the statement",
    }),
  ).toMatchObject({ ok: true });
  const decided = counting(db);
  expect(await reconciliationSweep(decided.db, { slices: [slice], now: NOW })).toMatchObject({
    proposed: 2,
    known: 2,
    written: 0,
  });
  expect(decided.sent).toEqual({ inserts: 0, lookups: 1, batches: 0 });
  const stored = await citing([...first, ...second]);
  expect(stored.map((row) => row.status).sort()).toEqual(["proposed", "rejected"]);
});

test("the write budget holds the cursor on its page until the page's new pairs are written", async () => {
  const slice = syntheticSlice("synthetic-budget");
  const rows = await observationsOf(
    await seedRows("synthetic-budget", "card-b", [
      { status: "unconfirmed", amount: -100, asOf: "2026-09-01", month: "2026-09", family: "c" },
      { status: "posted", amount: -100, asOf: "2026-09-01", month: "2026-09", family: "web" },
      { status: "unconfirmed", amount: -200, asOf: "2026-09-15", month: "2026-09", family: "c" },
      { status: "posted", amount: -200, asOf: "2026-09-16", month: "2026-09", family: "web" },
    ]),
  );
  const tick = { slices: [slice], now: NOW, writeLimit: 1 };
  expect(await reconciliationSweep(db, tick)).toMatchObject({ proposed: 2, written: 1 });
  // One new pair is left, so the cursor has not moved past the page.
  expect(await cursorOf(slice.sourceId)).toBeNull();
  expect(await reconciliationSweep(db, tick)).toMatchObject({
    proposed: 2,
    known: 1,
    written: 1,
  });
  // Both are written, and the short page leaves the cursor at 0.
  expect(await cursorOf(slice.sourceId)).toBeNull();
  expect(await citing(rows)).toHaveLength(2);
  expect(await reconciliationSweep(db, tick)).toMatchObject({ known: 2, written: 0 });
});

test("a tick whose every write D1 rejects leaves its page instead of holding it for ever", async () => {
  const slice = syntheticSlice("synthetic-rejected");
  const rows = await observationsOf(
    await seedRows("synthetic-rejected", "card-x", [
      { status: "unconfirmed", amount: -100, asOf: "2026-09-01", month: "2026-09", family: "c" },
      { status: "posted", amount: -100, asOf: "2026-09-01", month: "2026-09", family: "web" },
      { status: "unconfirmed", amount: -200, asOf: "2026-09-15", month: "2026-09", family: "c" },
      { status: "posted", amount: -200, asOf: "2026-09-16", month: "2026-09", family: "web" },
    ]),
  );
  const rejecting = {
    prepare: (sql: string) => db.prepare(sql),
    batch: () => Promise.reject(new Error("synthetic rejection")),
  } as unknown as D1Database;
  // Two new pairs and room for one: the page would be held, but nothing
  // was written, so holding it would only send the same batch again.
  const tick = { slices: [slice], now: NOW, scanLimit: 2, writeLimit: 1 };
  expect(await reconciliationSweep(rejecting, tick)).toMatchObject({
    proposed: 2,
    written: 0,
    failed: 1,
  });
  expect(await cursorOf(slice.sourceId)).toBe(rows[1]!);
  expect(await citing(rows)).toEqual([]);
  // A tick that writes something still holds its page for the pair left over.
  expect(await reconciliationSweep(db, tick)).toMatchObject({ proposed: 2, written: 1 });
  expect(await cursorOf(slice.sourceId)).toBe(rows[1]!);
  expect(await reconciliationSweep(db, tick)).toMatchObject({ known: 1, written: 1 });
  expect(await cursorOf(slice.sourceId)).toBe(rows[3]!);
  expect(await citing(rows)).toHaveLength(2);
});

test("the stored digests are looked up a chunk at a time, the last chunk short", async () => {
  const slice = syntheticSlice("synthetic-chunks");
  // One pending row and three posted rows in its window: three candidates.
  const rows = await observationsOf(
    await seedRows("synthetic-chunks", "card-k", [
      { status: "unconfirmed", amount: -300, asOf: "2026-09-10", month: "2026-09", family: "c" },
      { status: "posted", amount: -300, asOf: "2026-09-10", month: "2026-09", family: "web" },
      { status: "posted", amount: -300, asOf: "2026-09-11", month: "2026-09", family: "web" },
      { status: "posted", amount: -300, asOf: "2026-09-12", month: "2026-09", family: "web" },
    ]),
  );
  // One digest past a full chunk (as 1,001 against 1,000): a second lookup.
  const over = counting(db);
  expect(
    await reconciliationSweep(over.db, { slices: [slice], now: NOW, lookupChunk: 2 }),
  ).toMatchObject({ proposed: 3, known: 0, written: 3 });
  expect(over.sent).toEqual({ inserts: 3, lookups: 2, batches: 1 });
  // Exactly one full chunk (as 1,000): one lookup, and every digest found.
  const exact = counting(db);
  expect(
    await reconciliationSweep(exact.db, { slices: [slice], now: NOW, lookupChunk: 3 }),
  ).toMatchObject({ proposed: 3, known: 3, written: 0 });
  expect(exact.sent).toEqual({ inserts: 0, lookups: 1, batches: 0 });
  // The short last chunk finds its stored digest too.
  const again = counting(db);
  expect(
    await reconciliationSweep(again.db, { slices: [slice], now: NOW, lookupChunk: 2 }),
  ).toMatchObject({ proposed: 3, known: 3, written: 0 });
  expect(again.sent).toEqual({ inserts: 0, lookups: 2, batches: 0 });
  expect(await citing(rows)).toHaveLength(3);
});

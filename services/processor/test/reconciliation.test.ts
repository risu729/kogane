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
  factQuery,
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

test("both Vpass id forms stay collector fingerprints, so stage A only proposes them", () => {
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
        period_label: null,
        fetched_at: "2026-08-30T00:00:00.000Z",
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
  // The same later-page row in two captures: proposed for review, never accepted.
  const [proposal, ...others] = stageAProposals([later, fact(parsed("answer-001"), 3)]);
  expect(others).toEqual([]);
  expect(proposal).toMatchObject({ kind: "provider_same", stage: "A", autoAcceptable: false });
  expect(proposal!.rationaleCodes).toContain("collector_fingerprint_identifier");
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
  /** The wording the combined ご利用先など／支払区分 cell shows after the merchant. */
  paymentType: string;
  /** The summary amount cell: the usage while unconfirmed, this statement's payment once confirmed. */
  amount: string;
  /** The expanded amount (payment while unconfirmed, usage once confirmed); default `amount`. */
  other?: string;
}

/**
 * One published `credit-ledger` capture of a MyJCB connection, in the shape
 * production rows have (`1,000円` cells, the payment type such as `1回払` in
 * the combined ご利用先など／支払区分 cell after the merchant), parsed by the
 * deployed ledger parser and stored exactly as it emits each row. Returns the
 * observation ids in row order.
 */
async function seedLedger(
  connection: string,
  state: "unconfirmed" | "confirmed",
  rows: readonly LedgerRow[],
  period = MYJCB_PERIOD,
  /** The capture time (default now) and the menu position (default 0 unconfirmed, 1 confirmed). */
  capture: { fetchedAt?: string; detailMonth?: number } = {},
): Promise<number[]> {
  const artifactId = (nextArtifact += 1);
  const parseId = (nextParse += 1);
  const detailMonth = capture.detailMonth ?? (state === "unconfirmed" ? 0 : 1);
  const key = `${connection}/credit-ledger-${String(detailMonth).padStart(2, "0")}.json`;
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
      // The production row shape: merchant and payment type share the combined
      // ご利用先など／支払区分 cell; the cell the parser takes for the payment
      // type holds a two-character label.
      summaryCells: [row.date, `${row.merchant} ${row.paymentType}`, "架空", row.amount],
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
  await seedArtifact(
    env,
    artifactId,
    "myjcb",
    "credit-ledger",
    key,
    bytes,
    true,
    capture.fetchedAt === undefined ? undefined : Date.parse(capture.fetchedAt),
  );
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
      fetchedAt: capture.fetchedAt ?? "2026-10-01T00:00:00.000Z",
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
    .prepare(factQuery)
    .bind(
      MYJCB.sourceId,
      JSON.stringify([...MYJCB.pendingStatuses, ...MYJCB.postedStatuses]),
      1_000,
    )
    .all<Parameters<typeof factOf>[0]>();
  return rows.results
    .filter((row) => row.source_account === `myjcb:${connection}:root`)
    .map((row) => factOf(row, MYJCB));
}

test("a MyJCB pending row and its confirmed row with 1,200円 texts become one reviewed candidate", async () => {
  const purchase = { date: "2026/09/10", merchant: "架空書店", paymentType: "1回払" };
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
    { ...purchase, paymentType: "1回払", amount: "4,000円", other: "12,000円" },
  ]);
  // Without the guard the matcher would pair the pending purchase with each slice.
  expect(stageBProposals(await unguardedFacts("conn-installment"))).toHaveLength(2);
  const result = await reconciliationSweep(db, { slices: [MYJCB], now: "2026-10-02T00:00:00Z" });
  expect(result).toMatchObject({ written: 0, autoAccepted: 0 });
  expect(await citing([pending!, ...slices])).toEqual([]);
});

test("two MyJCB confirmed rows of the same amount stay two candidates, never one merge (SC03)", async () => {
  const purchase = { date: "2026/09/15", merchant: "架空売店", paymentType: "1回払" };
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

test("a relative MyJCB label is resolved from its capture time: detailMonth-0 pairs with the detailMonth-1 row the next cycle moved it to", async () => {
  // docs/observations.md: the collector keeps `detailMonth-N` verbatim and
  // the job reads it with the capture time of its own artifact. Captured on
  // 2026-09-12 (JST), position 0 is the cycle paid in 2026-10; captured on
  // 2026-09-26, after the 15th closing, position 1 is that same cycle.
  const purchase = { date: "2026/09/10", merchant: "架空花店", paymentType: "1回払" };
  const [pending] = await seedLedger(
    "conn-resolved",
    "unconfirmed",
    [{ ...purchase, amount: "1,200円" }],
    "detailMonth-0",
    { fetchedAt: "2026-09-12T00:00:00.000Z" },
  );
  const [posted] = await seedLedger(
    "conn-resolved",
    "confirmed",
    [{ ...purchase, amount: "1,200円" }],
    "detailMonth-1",
    { fetchedAt: "2026-09-26T00:00:00.000Z" },
  );
  expect(
    (await unguardedFacts("conn-resolved")).map((fact) => [fact.ref.id, fact.statementPeriod]),
  ).toEqual([
    [`transaction:${pending}`, "2026-10"],
    [`transaction:${posted}`, "2026-10"],
  ]);
  const result = await reconciliationSweep(db, { slices: [MYJCB], now: "2026-10-05T00:00:00Z" });
  expect(result).toMatchObject({ written: 1, autoAccepted: 0 });
  const [stored, ...others] = await citing([pending!, posted!]);
  expect(others).toEqual([]);
  expect(stored).toMatchObject({
    kind: "pending_to_posted",
    stage: "B",
    status: "proposed",
    targets: [`transaction:${pending}`, `transaction:${posted}`],
  });
  expect(stored!.rationale).toEqual(
    expect.arrayContaining(["same_statement_period", "date_within_window", "amount_equal"]),
  );
});

test("the same relative label captured in another cycle names another month, so nothing pairs under it", async () => {
  // Two purchases of one amount three days apart, either side of the 15th
  // closing: the first is on the statement paid in 2026-09, the second on the
  // one paid in 2026-10, and each is `detailMonth-1` on its own capture day.
  const [pending] = await seedLedger(
    "conn-relative",
    "unconfirmed",
    [{ date: "2026/08/14", merchant: "架空薬局", paymentType: "1回払", amount: "1,200円" }],
    "detailMonth-1",
    { fetchedAt: "2026-09-05T00:00:00.000Z", detailMonth: 1 },
  );
  const [posted] = await seedLedger(
    "conn-relative",
    "confirmed",
    [{ date: "2026/08/17", merchant: "架空薬局", paymentType: "1回払", amount: "1,200円" }],
    "detailMonth-1",
    { fetchedAt: "2026-10-05T00:00:00.000Z" },
  );
  const facts = await unguardedFacts("conn-relative");
  expect(facts.map((fact) => fact.statementPeriod)).toEqual(["2026-09", "2026-10"]);
  // Grouped by the raw label, the matcher would claim one statement period.
  const [unguarded, ...rest] = stageBProposals(
    facts.map((fact) => ({ ...fact, statementPeriod: "detailMonth-1" })),
  );
  expect(rest).toEqual([]);
  expect(unguarded!.rationaleCodes).toContain("same_statement_period");
  const before = await proposals();
  const result = await reconciliationSweep(db, { slices: [MYJCB], now: "2026-10-06T00:00:00Z" });
  expect(result).toMatchObject({ written: 0, autoAccepted: 0 });
  expect(await citing([pending!, posted!])).toEqual([]);
  expect(await proposals()).toEqual(before);
});

test("a confirmed row at a position the rule does not place (detailMonth-2) pairs with nothing", async () => {
  // relative-statement-period-v1 resolves positions 0 and 1 only: the
  // production captures place nothing beyond, and the months the provider
  // labels absolutely sit two months off `P0 − N`. A uniform offset would put
  // this row in 2026-10 beside the pending row; the rule leaves it unplaced,
  // and an unplaced confirmed row stays out of pending-to-posted matching.
  const purchase = { date: "2026/09/01", merchant: "架空書房", paymentType: "1回払" };
  const [pending] = await seedLedger(
    "conn-unplaced",
    "unconfirmed",
    [{ ...purchase, amount: "1,500円" }],
    "detailMonth-0",
    { fetchedAt: "2026-09-05T00:00:00.000Z" },
  );
  const [posted] = await seedLedger(
    "conn-unplaced",
    "confirmed",
    [{ ...purchase, amount: "1,500円" }],
    "detailMonth-2",
    { fetchedAt: "2026-10-20T00:00:00.000Z", detailMonth: 2 },
  );
  expect((await unguardedFacts("conn-unplaced")).map((fact) => fact.statementPeriod)).toEqual([
    "2026-10",
    null,
  ]);
  const result = await reconciliationSweep(db, { slices: [MYJCB], now: "2026-10-21T00:00:00Z" });
  expect(result).toMatchObject({ written: 0, autoAccepted: 0 });
  expect(await citing([pending!, posted!])).toEqual([]);
});

test("a MyJCB confirmed row re-captured by a later run is not proposed as the same row", async () => {
  // Stage A over MyJCB confirmed rows is left out: every daily run re-captures
  // each listed month, and the lane only needs these rows for stage B.
  const row = {
    date: "2026/09/22",
    merchant: "架空文具",
    paymentType: "1回払",
    amount: "700円",
  };
  const first = await seedLedger("conn-recapture", "confirmed", [row]);
  const second = await seedLedger("conn-recapture", "confirmed", [row]);
  const [unguarded, ...others] = stageAProposals(await unguardedFacts("conn-recapture"));
  expect(others).toEqual([]);
  expect(unguarded).toMatchObject({ kind: "provider_same", stage: "A", autoAcceptable: false });
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

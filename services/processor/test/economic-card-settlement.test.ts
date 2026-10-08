// The card settlement commands as writers of the common consumption guard
// (ADR 0054, G1b; CORE 0070), through the change lifecycle's plan, approve and
// commit on workerd's D1 (Miniflare): what an acceptance and a withdrawal
// write, and the refusals W1–W4 and W6–W9 and T1 of the design review, with a
// synthetic own-transfer-shaped writer where a second writer is needed (no
// own-transfer writer exists yet). Every row is synthetic: invented ids,
// round amounts, invented dates.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";
import { cardSettlementSweep } from "../src/card-settlement-job.ts";
import {
  CARD_SETTLEMENT_WRITER_RELEASE,
  cardSettlementMutation,
} from "../src/card-settlement-commands.ts";
import { identifyParse, type IdentityResolver } from "../src/identity-store.ts";
import { changeMutationPlanners } from "../src/change-commands.ts";
import {
  approve,
  commit,
  createPlan,
  d1CommandStore,
  type ChangeKind,
  type MutationPlanners,
  type Principal,
} from "../../../packages/application/src/index.ts";
import { resolveAndSimulate } from "../../../packages/application/src/operations/targets.ts";
import {
  INITIAL_IDENTITY_EPOCH,
  aliasClassText,
  parseConsumptionKey,
  type AliasClass,
} from "../../../packages/domain/src/economic-contract.ts";
import { validSourceFactRef } from "../../../packages/domain/src/events.ts";
import { declaredAliasClass } from "../../../packages/domain/src/row-identity.ts";
import {
  decisionEntry,
  economicFinalizationWrites,
} from "../../../packages/storage-d1/src/atomic/economic-commit.ts";
import type { SqlWrite } from "../../../packages/storage-d1/src/core/operations.ts";

let mf: Miniflare, env: Env, db: D1Database;
const actor: Principal = {
  id: "synthetic-human",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
const now = "2098-01-01T00:00:00.000Z";
let sequence = 0;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  db = env.DB;
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

const resolver: IdentityResolver = (input) => ({
  account: {
    key: [input.sourceAccount],
    label: "synthetic",
    role: "deposit",
    status: "provider-local",
    reason: "test",
  },
  instruments: [],
  issues: [],
});

async function preparedCommand(kind: ChangeKind, payload: unknown, planners?: MutationPlanners) {
  const store = d1CommandStore(db);
  const planned = await createPlan(
    kind,
    payload,
    { actor, baseContextId: "identity-current-v1", now, ttlSeconds: 600 },
    store,
  );
  if (!planned.ok) throw new Error("plan " + JSON.stringify(planned));
  const approval = await approve(store, {
    planId: planned.plan.planId,
    planDigest: planned.plan.planDigest,
    actor,
    scope: [],
    ttlSeconds: 600,
    now,
  });
  if (!approval.ok) throw new Error("approval " + JSON.stringify(approval));
  const operationId = "g1b-op-" + ++sequence;
  const run = (input: { operationId?: string; idempotencyPayloadDigest?: string } = {}) =>
    commit(store, {
      operationId: input.operationId ?? operationId,
      principal: actor,
      planId: planned.plan.planId,
      approvalId: approval.approval.approvalId,
      planners: planners ?? changeMutationPlanners(db),
      now,
      ...(input.idempotencyPayloadDigest === undefined
        ? {}
        : { idempotencyPayloadDigest: input.idempotencyPayloadDigest }),
    });
  return Object.assign(run, { plan: planned.plan, operationId });
}
async function command(kind: ChangeKind, payload: unknown) {
  return (await preparedCommand(kind, payload))();
}

async function ownership(parse: number, kind: "liable_party" | "beneficial_owner") {
  const mapping = await db
    .prepare(
      "SELECT m.account_id FROM current_account_mappings m JOIN current_identity_observations o ON o.source_account_id=m.source_account_id WHERE o.parse_run_id=? LIMIT 1",
    )
    .bind(parse)
    .first<{ account_id: string }>();
  if (!mapping) throw new Error("no mapping");
  const result = await command("relation.accept", {
    relationKind: kind,
    fromRef: "account:" + mapping.account_id,
    toRef: "party:synthetic-owner",
    validFrom: null,
    validTo: null,
    evidenceRefs: ["synthetic-proof"],
    reason: "Synthetic explicit ownership evidence",
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

/** seedArtifact's capture under another producer and namespace (a second collection path). */
async function seedArtifactAs(id: number, producer: string, namespace: string): Promise<void> {
  const nowMs = Date.parse("2026-09-12T00:00:00Z");
  const sha = id.toString(16).padStart(64, "0");
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO sources VALUES('smbc-bank','smbc-bank')"),
    env.DB.prepare("INSERT OR IGNORE INTO producers VALUES(?)").bind(producer),
    env.DB.prepare(
      "INSERT INTO acquisition_sessions(id,external_session_id,producer_id,external_id_namespace) VALUES(?,?,?,?)",
    ).bind(id, `run-${id}`, producer, namespace),
    env.DB.prepare(
      "INSERT INTO fetch_runs(id,source_id,acquisition_session_id,producer_id,first_recorded_at_ms) VALUES(?,'smbc-bank',?,?,?)",
    ).bind(id, id, producer, nowMs),
    env.DB.prepare("INSERT INTO fetch_run_reports VALUES(?,'terminal','success',?,?)").bind(
      id,
      nowMs,
      nowMs,
    ),
    env.DB.prepare("INSERT OR IGNORE INTO raw_objects VALUES(?,3,?)").bind(sha, sha),
    env.DB.prepare(
      "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,declared_media_type,fetched_at_ms,recorded_at_ms,sha256,artifact_role) VALUES(?,?,'smbc-bank','transactions-normalized',?,NULL,'application/json',?,?,?,'collector_derived')",
    ).bind(id, id, `g1b-${id}.json`, nowMs, nowMs, sha),
    env.DB.prepare("INSERT INTO fetch_run_seals(fetch_run_id,sealed_at_ms) VALUES(?,?)").bind(
      id,
      nowMs,
    ),
  ]);
}

async function parseRun(id: number, parser: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'1','2026-09-12','ok','[]')",
    )
    .bind(id, id, parser)
    .run();
}

/** A statement total of 3000 due on the 10th of `period`, under `sourceAccount`. */
async function statement(
  id: number,
  source: "myjcb" | "vpass",
  sourceAccount: string,
  period: string,
) {
  await seedArtifact(env, id, source, "synthetic", `g1b-statement-${id}`, {});
  await parseRun(id, source === "myjcb" ? "myjcb-credit-statement-total" : "vpass-statement-page");
  await db
    .prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
 VALUES(?,?,'credit_statement_payment_amount',3000,'3000',0,'JPY',?,'synthetic-total',?)`)
    .bind(
      id,
      sourceAccount,
      `${period}-01`,
      JSON.stringify({
        _kogane: {
          period,
          paymentDate: `${period}-10`,
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        },
      }),
    )
    .run();
  await publishParse(db, id);
  await identifyParse(
    db,
    {
      id,
      artifact_id: id,
      source_id: source,
      producer_id: "collector-r2-importer",
      fetch_run_id: id,
    },
    resolver,
  );
}

/** An SMBC debit of 3000 as the SMBC parser stores it: provider id and recorded origin. */
async function debit(
  id: number,
  sourceAccount: string,
  providerId: string,
  period: string,
  path: { producer: string; namespace: string } | null = null,
) {
  if (path === null)
    await seedArtifact(env, id, "smbc-bank", "transactions-normalized", `g1b-debit-${id}`, {});
  else await seedArtifactAs(id, path.producer, path.namespace);
  await parseRun(id, "smbc-direct-transactions");
  await db
    .prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,as_of,raw_locator,extra_json)
 VALUES(?,?,?,'posted',-3000,'-3000',0,'JPY',?,'json:$.transactions[0]',?)`)
    .bind(
      id,
      sourceAccount,
      providerId,
      `${period}-10T00:00:00+09:00`,
      JSON.stringify({
        id: providerId,
        _kogane: {
          direction: "outflow",
          amountSignSource: "direction",
          identityOrigin: "provider-id",
        },
      }),
    )
    .run();
  await publishParse(db, id);
  await identifyParse(
    db,
    {
      id,
      artifact_id: id,
      source_id: "smbc-bank",
      producer_id: path?.producer ?? "collector-r2-importer",
      fetch_run_id: id,
    },
    resolver,
  );
}

/** One owned statement and one owned SMBC debit of it; returns the ready candidate. */
async function ownedPair(base: number, period: string): Promise<string> {
  await statement(base, "myjcb", `myjcb:g1b-${base}:root`, period);
  await debit(base + 1, `smbc-bank:g1b-${base}`, `g1b-debit-${base}`, period);
  await ownership(base, "liable_party");
  await ownership(base + 1, "beneficial_owner");
  await cardSettlementSweep(db);
  return candidateOf(base, base + 1);
}

async function candidateOf(statementParse: number, debitParse: number): Promise<string> {
  const row = await db
    .prepare(
      `SELECT c.id FROM card_settlement_candidates c WHERE c.statement_parse_run_id=? AND c.bank_parse_run_id=?
       AND json_extract(c.facts_json,'$.ownership')='established-same'`,
    )
    .bind(statementParse, debitParse)
    .first<{ id: string }>();
  if (!row) throw new Error(`no owned candidate for ${statementParse}/${debitParse}`);
  return row.id;
}

/** Every row of every CORE table, so a moved pointer or a spent approval shows too. */
async function snapshot(): Promise<Record<string, string[]>> {
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results.map((row) => row.name);
  const found: Record<string, string[]> = {};
  for (const table of tables)
    found[table] = (await db.prepare(`SELECT * FROM ${table}`).all()).results
      .map((row) => JSON.stringify(row))
      .sort();
  return found;
}

const count = async (sql: string, ...binds: unknown[]): Promise<number> =>
  (await db
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number }>())!.n;

interface BankRow {
  id: number;
  parse_run_id: number;
  key: string;
  source_id: string;
  parser_name: string;
  source_account: string;
  extra_json: string;
  account_id: string;
}
/** A debit row, its 5-tuple and its resolved account, as a writer reads them. */
async function bankRow(parse: number): Promise<BankRow> {
  const row = await db
    .prepare(
      `SELECT t.id,t.parse_run_id,json_array(a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id) AS key,
        a.source_id,p.parser_name,t.source_account,t.extra_json,m.account_id
       FROM transaction_observations t JOIN parse_runs p ON p.id=t.parse_run_id JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
       JOIN fetch_runs fr ON fr.id=a.fetch_run_id JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id
       JOIN current_identity_observations o ON o.parse_run_id=t.parse_run_id
       JOIN current_account_mappings m ON m.source_account_id=o.source_account_id
       WHERE t.parse_run_id=? LIMIT 1`,
    )
    .bind(parse)
    .first<BankRow>();
  if (!row) throw new Error("no bank row");
  return row;
}

function aliasOf(row: BankRow): AliasClass {
  const alias = declaredAliasClass({
    sourceId: row.source_id,
    parserName: row.parser_name,
    sourceAccount: row.source_account,
    extra: JSON.parse(row.extra_json),
    accountId: row.account_id,
  });
  if (alias === null) throw new Error("no alias class");
  return alias;
}

/**
 * A synthetic own-transfer-shaped writer (no own-transfer writer exists yet):
 * revision `revision` of `eventId` claiming the debit row in book
 * cash-movement under its alias class, sealed and logged, superseding
 * `revision - 1` when there is one. Its entry is its own decision. With
 * `alias` false it records no alias class, so a conflict on the key is
 * refused as economic_claim_held alone (a held key and a held alias class
 * raise from two triggers, and which fires first is SQLite's choice).
 */
function ownTransferWrites(
  eventId: string,
  revision: number,
  rows: readonly BankRow[],
  released: readonly BankRow[] = [],
  alias = true,
): SqlWrite[] {
  const decisionId = `dr-synthetic-transfer-${eventId}-${revision}`;
  const entry = decisionEntry(decisionId);
  const claims = rows.map((row) => ({
    eventId,
    revision,
    book: "cash-movement" as const,
    key: parseConsumptionKey(row.key)!,
    aliasClass: alias ? aliasOf(row) : null,
    identityEpoch: INITIAL_IDENTITY_EPOCH,
    observationId: row.id,
    parseRunId: row.parse_run_id,
  }));
  const supersedes = revision > 1 ? [{ eventId, revision: revision - 1 }] : [];
  return [
    {
      sql: `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
 SELECT ?,'relation',?,?,?,'manual','synthetic-transfer-writer',NULL,'synthetic transfer','[]',?,NULL,? WHERE NOT EXISTS(SELECT 1 FROM decision_revisions WHERE id=?)`,
      binds: [
        decisionId,
        `event:${eventId}`,
        revision,
        revision === 1 ? "accept" : "supersede",
        revision === 1 ? null : revision - 1,
        now,
        decisionId,
      ],
    },
    {
      sql: `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
 SELECT ?,?,'transfer','debited',NULL,'{}','cash-movement','["synthetic-evidence"]',?,NULL,? WHERE ${entry.sql}
 AND NOT EXISTS(SELECT 1 FROM economic_event_revisions WHERE event_id=? AND revision=?)`,
      binds: [eventId, revision, decisionId, now, ...entry.binds, eventId, revision],
    },
    ...supersedes.map((prior) => ({
      sql: `UPDATE economic_event_revisions SET superseded_by=? WHERE event_id=? AND revision=? AND superseded_by IS NULL AND ${entry.sql}`,
      binds: [`${eventId}@${revision}`, prior.eventId, prior.revision, ...entry.binds],
    })),
    ...economicFinalizationWrites({
      entry,
      claims,
      times: [],
      effects: [],
      seals: [
        {
          eventId,
          revision,
          writerRelease: "synthetic-transfer-writer-v1",
          legCount: 0,
          claimCount: claims.length,
          timeCount: 0,
          effectCount: 0,
          contentDigest: "c".repeat(64),
          identityPins: {},
          identityEpoch: INITIAL_IDENTITY_EPOCH,
          now,
        },
      ],
      commit: {
        decisionRevisionId: decisionId,
        operationId: null,
        principal: "synthetic-transfer-writer",
        payloadDigest: "d".repeat(64),
        kind: "synthetic.own-transfer",
        members: [{ eventId, revision, supersedes }],
        claims: claims.map(({ book, key }) => ({ book, key })),
        released: released.map((row) => ({
          book: "cash-movement" as const,
          key: parseConsumptionKey(row.key)!,
        })),
        now,
      },
    }),
  ];
}

async function batch(writes: readonly SqlWrite[]): Promise<void> {
  await db.batch(writes.map((write) => db.prepare(write.sql).bind(...write.binds)));
}

/** The planners, with the acceptance's reservation precondition dropped (an older build's guard). */
function withoutPrecondition(): MutationPlanners {
  return {
    ...changeMutationPlanners(db),
    "card-settlement.accept": async (input) => {
      const mutation = await cardSettlementMutation(input);
      if (!mutation) return null;
      const { precondition: _dropped, ...rest } = mutation;
      return rest;
    },
  };
}

describe("an acceptance and a withdrawal join the guard", () => {
  test("an acceptance claims the debit with its alias class, seals and logs it; a withdrawal releases it", async () => {
    const proposalId = await ownedPair(2000, "2026-09");
    const bank = await bankRow(2001);
    const accept = await preparedCommand("card-settlement.accept", {
      proposalId,
      reason: "verified total and bank debit",
    });
    // The plan pins the event's head: no revision yet.
    const eventKey = Object.keys(accept.plan.expectedRevisions).find((ref) =>
      ref.startsWith("economic-event:"),
    )!;
    expect(accept.plan.expectedRevisions[eventKey]).toBe(0);
    const accepted = await accept();
    if (!accepted.ok) throw new Error(JSON.stringify(accepted));
    const eventId = accepted.receipt.result["eventId"] as string;
    expect(eventKey).toBe(`economic-event:${eventId}`);
    expect(
      await db
        .prepare(
          "SELECT revision,book,consumption_key,alias_class,identity_epoch,observation_id,parse_run_id FROM economic_claims WHERE event_id=?",
        )
        .bind(eventId)
        .all(),
    ).toMatchObject({
      results: [
        {
          revision: 1,
          book: "cash-movement",
          consumption_key: bank.key,
          alias_class: aliasClassText({
            sourceId: "smbc-bank",
            components: ["g1b-debit-2000"],
            accountId: bank.account_id,
            ruleVersion: "smbc-meisai-id-v1",
          }),
          identity_epoch: INITIAL_IDENTITY_EPOCH,
          observation_id: bank.id,
          parse_run_id: 2001,
        },
      ],
    });
    expect(
      await db
        .prepare(
          "SELECT writer_release,leg_count,claim_count,time_count,effect_count,identity_epoch FROM economic_revision_seals WHERE event_id=?",
        )
        .bind(eventId)
        .first<Record<string, unknown>>(),
    ).toEqual({
      writer_release: CARD_SETTLEMENT_WRITER_RELEASE,
      leg_count: 2,
      claim_count: 1,
      time_count: 0,
      effect_count: 0,
      identity_epoch: INITIAL_IDENTITY_EPOCH,
    });
    const receipt = await db
      .prepare("SELECT payload_digest FROM operation_receipts WHERE operation_id=?")
      .bind(accept.operationId)
      .first<{ payload_digest: string }>();
    expect(
      await db
        .prepare(
          `SELECT decision_revision_id,operation_id,principal,payload_digest,kind,members_json,claims_json,released_json,known_at
           FROM economic_commit_log l JOIN economic_revision_seals s ON s.core_epoch=l.core_epoch AND s.commit_seq=l.commit_seq
           WHERE s.event_id=?`,
        )
        .bind(eventId)
        .first<Record<string, unknown>>(),
    ).toEqual({
      decision_revision_id: accepted.receipt.decisionRevisionId,
      operation_id: accept.operationId,
      principal: actor.id,
      payload_digest: receipt!.payload_digest,
      kind: "card-settlement.accept",
      members_json: JSON.stringify([{ eventId, revision: 1, supersedes: [] }]),
      claims_json: JSON.stringify([["cash-movement", bank.key]]),
      released_json: "[]",
      known_at: now,
    });
    // The legacy holder and the claim row are one holder.
    expect(
      await count(
        "SELECT count(*) AS n FROM live_consumption_claims WHERE book='cash-movement' AND consumption_key=?",
        bank.key,
      ),
    ).toBe(1);
    // The event revision cites SourceFactRef objects.
    const support = JSON.parse(
      (await db
        .prepare("SELECT evidence_support_json AS e FROM economic_event_revisions WHERE event_id=?")
        .bind(eventId)
        .first<{ e: string }>())!.e,
    ) as unknown[];
    expect(support).toHaveLength(2);
    expect(support.every(validSourceFactRef)).toBe(true);
    expect(
      await count(
        "SELECT count(*) AS n FROM unlogged_economic_revisions WHERE event_id=?",
        eventId,
      ),
    ).toBe(0);

    // W7: a resend after a lost response returns the receipt and writes nothing.
    const before = await snapshot();
    const resent = await accept();
    expect(resent).toMatchObject({ ok: true, replayed: true });
    expect(await snapshot()).toEqual(before);

    const withdraw = await preparedCommand("card-settlement.withdraw", {
      proposalId,
      reason: "correspondence judgement corrected",
    });
    expect(withdraw.plan.expectedRevisions[eventKey]).toBe(1);
    const withdrawn = await withdraw();
    if (!withdrawn.ok) throw new Error(JSON.stringify(withdrawn));
    expect(
      await db
        .prepare(
          `SELECT kind,members_json,claims_json,released_json FROM economic_commit_log l
           JOIN economic_revision_seals s ON s.core_epoch=l.core_epoch AND s.commit_seq=l.commit_seq
           WHERE s.event_id=? AND s.revision=2`,
        )
        .bind(eventId)
        .first<Record<string, unknown>>(),
    ).toEqual({
      kind: "card-settlement.withdraw",
      members_json: JSON.stringify([{ eventId, revision: 2, supersedes: [[eventId, 1]] }]),
      claims_json: "[]",
      released_json: JSON.stringify([["cash-movement", bank.key]]),
    });
    expect(
      await db
        .prepare(
          "SELECT leg_count,claim_count FROM economic_revision_seals WHERE event_id=? AND revision=2",
        )
        .bind(eventId)
        .first<Record<string, unknown>>(),
    ).toEqual({ leg_count: 0, claim_count: 0 });
    // The withdrawal keeps writing its own record; the claim is free.
    expect(
      await count("SELECT count(*) AS n FROM card_settlement_allocation_withdrawals"),
    ).toBeGreaterThan(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM live_consumption_claims WHERE book='cash-movement' AND consumption_key=?",
        bank.key,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM unlogged_economic_revisions WHERE event_id=?",
        eventId,
      ),
    ).toBe(0);
  }, 60000);
});

describe("W1: an own-transfer-shaped claim and a settlement on one bank_key", () => {
  test("settlement first: the second writer's claim raises economic_claim_held and writes nothing", async () => {
    const proposalId = await ownedPair(2100, "2026-10");
    expect((await command("card-settlement.accept", { proposalId, reason: "reviewed" })).ok).toBe(
      true,
    );
    const before = await snapshot();
    await expect(
      batch(ownTransferWrites("transfer-w1a", 1, [await bankRow(2101)], [], false)),
    ).rejects.toThrow("economic_claim_held");
    expect(await snapshot()).toEqual(before);
  }, 60000);

  test("claim first: the settlement is refused with the code, before and after its plan, and nothing is written", async () => {
    const proposalId = await ownedPair(2200, "2026-11");
    // A plan made before the other writer's claim.
    const planned = await preparedCommand("card-settlement.accept", {
      proposalId,
      reason: "reviewed",
    });
    const stale = await preparedCommand(
      "card-settlement.accept",
      { proposalId, reason: "reviewed by an older build" },
      withoutPrecondition(),
    );
    await batch(ownTransferWrites("transfer-w1b", 1, [await bankRow(2201)], [], false));
    const before = await snapshot();
    // A new plan: refused, naming the code.
    expect(
      await resolveAndSimulate(d1CommandStore(db), "card-settlement.accept", {
        proposalId,
        reason: "reviewed",
      }),
    ).toEqual({
      ok: false,
      error: "stale_context",
      refs: [`card-settlement:${proposalId}`, "economic_claim_held"],
    });
    // The earlier plan: the reservation's readiness guard writes nothing, and
    // the failure reason names the code.
    expect(await planned()).toEqual({
      ok: false,
      error: "stale_context",
      refs: [`card-settlement:${proposalId}`, "economic_claim_held"],
    });
    expect(await snapshot()).toEqual(before);
    // Without that guard (an older build's reservation), the claim row's
    // trigger raises inside the batch, D1 rolls it back whole, and the
    // commit answers with the code.
    expect(await stale()).toEqual({
      ok: false,
      error: "stale_context",
      refs: [stale.plan.planId, "economic_claim_held"],
    });
    expect(await snapshot()).toEqual(before);
  }, 60000);
});

describe("T1: one SMBC debit collected under two producers and namespaces", () => {
  test("settled on path A, the same fact on path B is an alias conflict, and nothing is written", async () => {
    // Two statements of one owner due on the same day, and one SMBC debit
    // collected twice: path A (the importer) and path B (a collector with
    // its own namespace). B's source account is resolved to A's account, as
    // an operator assigns a producer switch's accounts.
    await statement(2300, "myjcb", "myjcb:g1b-t1:root", "2026-12");
    await statement(2301, "vpass", "vpass:g1b-t1", "2026-12");
    await debit(2302, "smbc-bank:g1b-t1", "g1b-t1-debit", "2026-12");
    await debit(2303, "smbc-bank:g1b-t1", "g1b-t1-debit", "2026-12", {
      producer: "collector-smbc-g1b",
      namespace: "smbc-g1b-b",
    });
    const a = await bankRow(2302);
    const b0 = await bankRow(2303);
    const reference = (await db
      .prepare(
        "SELECT m.source_account_id AS ref FROM current_account_mappings m JOIN current_identity_observations o ON o.source_account_id=m.source_account_id WHERE o.parse_run_id=2303 LIMIT 1",
      )
      .first<{ ref: string }>())!.ref;
    expect(b0.account_id).not.toBe(a.account_id);
    const assigned = await command("identity.assign", {
      subject: "account",
      referenceId: reference,
      targetId: a.account_id,
      reason: "the collector's account is the importer's",
    });
    if (!assigned.ok) throw new Error(JSON.stringify(assigned));
    const b = await bankRow(2303);
    expect(b.account_id).toBe(a.account_id);
    expect(b.key).not.toBe(a.key);
    expect(aliasClassText(aliasOf(b))).toBe(aliasClassText(aliasOf(a)));
    await ownership(2300, "liable_party");
    await ownership(2301, "liable_party");
    await ownership(2302, "beneficial_owner");
    await cardSettlementSweep(db);
    const onA = await candidateOf(2300, 2302);
    const onB = await candidateOf(2301, 2303);
    // Before G1b's alias class, both were ready: another statement, another bank_key.
    const ready = async (id: string) =>
      db
        .prepare(
          "SELECT statement_current,bank_current,ownership_current,allocation_available FROM card_settlement_readiness WHERE id=?",
        )
        .bind(id)
        .first<Record<string, unknown>>();
    const flags = {
      statement_current: 1,
      bank_current: 1,
      ownership_current: 1,
      allocation_available: 1,
    };
    expect(await ready(onA)).toEqual(flags);
    expect(await ready(onB)).toEqual(flags);
    const planned = await preparedCommand("card-settlement.accept", {
      proposalId: onB,
      reason: "B",
    });
    const stale = await preparedCommand(
      "card-settlement.accept",
      { proposalId: onB, reason: "B by an older guard" },
      withoutPrecondition(),
    );
    expect((await command("card-settlement.accept", { proposalId: onA, reason: "A" })).ok).toBe(
      true,
    );
    // The 0044 readiness still calls B ready: it compares the full 5-tuple.
    expect(await ready(onB)).toEqual(flags);
    const before = await snapshot();
    expect(
      await resolveAndSimulate(d1CommandStore(db), "card-settlement.accept", {
        proposalId: onB,
        reason: "B",
      }),
    ).toEqual({
      ok: false,
      error: "stale_context",
      refs: [`card-settlement:${onB}`, "alias_conflict"],
    });
    expect(await planned()).toEqual({
      ok: false,
      error: "stale_context",
      refs: [`card-settlement:${onB}`, "alias_conflict"],
    });
    expect(await stale()).toEqual({
      ok: false,
      error: "stale_context",
      refs: [stale.plan.planId, "alias_conflict"],
    });
    expect(await snapshot()).toEqual(before);
  }, 90000);
});

describe("refusals keep the store whole", () => {
  test("W2: a withdrawal whose pointer matched no row is refused by the commit row", async () => {
    const proposalId = await ownedPair(2400, "2027-01");
    expect((await command("card-settlement.accept", { proposalId, reason: "reviewed" })).ok).toBe(
      true,
    );
    const planners: MutationPlanners = {
      ...changeMutationPlanners(db),
      "card-settlement.withdraw": async (input) => {
        const mutation = await cardSettlementMutation(input);
        if (!mutation) return null;
        // The pointer statement names a revision that is not there: it
        // matches 0 rows, which is no SQL error.
        return {
          ...mutation,
          writes: mutation.writes.map((write) =>
            write.sql.startsWith("UPDATE economic_event_revisions SET superseded_by")
              ? { sql: write.sql, binds: write.binds.map((bind, at) => (at === 2 ? 7 : bind)) }
              : write,
          ),
        };
      },
    };
    const withdraw = await preparedCommand(
      "card-settlement.withdraw",
      { proposalId, reason: "corrected" },
      planners,
    );
    const before = await snapshot();
    expect(await withdraw()).toEqual({
      ok: false,
      error: "stale_context",
      refs: [withdraw.plan.planId, "economic_commit_prior_not_superseded"],
    });
    expect(await snapshot()).toEqual(before);
  }, 60000);

  test("W3: a sealed settlement revision takes no leg, claim or accepted decision", async () => {
    const proposalId = await ownedPair(2500, "2027-02");
    const accepted = await command("card-settlement.accept", { proposalId, reason: "reviewed" });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted));
    const eventId = accepted.receipt.result["eventId"] as string;
    const bank = await bankRow(2501);
    const before = await snapshot();
    for (const [sql, binds] of [
      [
        `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,role,basis)
         VALUES(?,1,2,'acct','JPY','exact','1',0,'fee','cash-movement')`,
        [eventId],
      ],
      [
        `INSERT INTO economic_claims(event_id,revision,book,consumption_key,alias_class,identity_epoch,observation_id,parse_run_id)
         VALUES(?,1,'card-usage',?,NULL,?,?,?)`,
        [eventId, bank.key, INITIAL_IDENTITY_EPOCH, bank.id, bank.parse_run_id],
      ],
      [
        `INSERT INTO economic_event_times(event_id,revision,role,temporal_json)
         VALUES(?,1,'posting','{"kind":"unknown","reasonCode":"synthetic"}')`,
        [eventId],
      ],
    ] as const)
      await expect(
        db
          .prepare(sql)
          .bind(...binds)
          .run(),
      ).rejects.toThrow("economic_revision_sealed");
    expect(await snapshot()).toEqual(before);
  }, 60000);

  test("W4: a failed correction keeps the old revision, its claim and every command table whole", async () => {
    const proposalId = await ownedPair(2600, "2027-03");
    const other = await ownedPair(2610, "2027-04");
    // The synthetic writer adopts the first debit, then corrects its event
    // to the second debit, which a settlement accepted meanwhile.
    await batch(ownTransferWrites("transfer-w4", 1, [await bankRow(2601)], [], false));
    expect(
      (await command("card-settlement.accept", { proposalId: other, reason: "reviewed" })).ok,
    ).toBe(true);
    const before = await snapshot();
    await expect(
      batch(
        ownTransferWrites("transfer-w4", 2, [await bankRow(2611)], [await bankRow(2601)], false),
      ),
    ).rejects.toThrow("economic_claim_held");
    expect(await snapshot()).toEqual(before);
    expect(
      await count(
        "SELECT count(*) AS n FROM live_consumption_claims WHERE event_id='transfer-w4' AND revision=1",
      ),
    ).toBe(1);
    // The first debit's settlement stays refused: its key is still held.
    expect(
      await resolveAndSimulate(d1CommandStore(db), "card-settlement.accept", {
        proposalId,
        reason: "reviewed",
      }),
    ).toMatchObject({ ok: false, error: "stale_context" });
  }, 60000);

  test("W6: a withdrawal planned before another withdrawal committed writes nothing", async () => {
    const proposalId = await ownedPair(2700, "2027-05");
    expect((await command("card-settlement.accept", { proposalId, reason: "reviewed" })).ok).toBe(
      true,
    );
    const first = await preparedCommand("card-settlement.withdraw", { proposalId, reason: "one" });
    const second = await preparedCommand("card-settlement.withdraw", { proposalId, reason: "two" });
    expect((await first()).ok).toBe(true);
    const commits = await count("SELECT count(*) AS n FROM economic_commit_log");
    const result = await second();
    expect(result).toMatchObject({ ok: false, error: "stale_context" });
    if (result.ok) throw new Error("unreachable");
    // The review and the event head both moved.
    expect(result.refs).toContain(`card-settlement:${proposalId}`);
    expect(result.refs!.some((ref) => ref.startsWith("economic-event:"))).toBe(true);
    expect(await count("SELECT count(*) AS n FROM economic_commit_log")).toBe(commits);
  }, 60000);

  test("W7 and W8: concurrent resends add one set of rows; a key reused for another payload is refused", async () => {
    const proposalId = await ownedPair(2800, "2027-06");
    const accept = await preparedCommand("card-settlement.accept", {
      proposalId,
      reason: "reviewed",
    });
    const tables = [
      "decision_revisions",
      "decision_operations",
      "economic_commit_log",
      "economic_claims",
      "economic_revision_seals",
      "decision_outbox",
      "operation_receipts",
    ];
    const counts = async () =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async (table) => [table, await count(`SELECT count(*) AS n FROM ${table}`)]),
        ),
      );
    const before = await counts();
    // Two batches of one operation at once: D1 runs them one after the
    // other; the second is refused by the 0029 operation ledger (a raise, so
    // nothing of it stays) or replays the receipt. Either way one set of rows.
    const results = await Promise.allSettled([accept(), accept()]);
    const fulfilled = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(fulfilled.some((result) => result.ok && !result.replayed)).toBe(true);
    expect(fulfilled.every((result) => result.ok)).toBe(true);
    const after = await counts();
    expect(after["economic_commit_log"]).toBe(before["economic_commit_log"]! + 1);
    expect(after["economic_claims"]).toBe(before["economic_claims"]! + 1);
    expect(after["operation_receipts"]).toBe(before["operation_receipts"]! + 1);
    expect(after["decision_operations"]).toBe(before["decision_operations"]! + 1);
    expect(await accept()).toMatchObject({ ok: true, replayed: true });
    expect(await accept({ idempotencyPayloadDigest: "0".repeat(64) })).toEqual({
      ok: false,
      error: "idempotency_conflict",
      refs: [accept.operationId],
    });
    expect(await counts()).toEqual(after);
  }, 60000);

  test("W9: a failure at any statement of an acceptance writes nothing", async () => {
    const proposalId = await ownedPair(2900, "2027-07");
    // Count the acceptance's own statements once.
    let length = 0;
    const probe: MutationPlanners = {
      ...changeMutationPlanners(db),
      "card-settlement.accept": async (input) => {
        const mutation = await cardSettlementMutation(input);
        length = mutation?.writes.length ?? 0;
        return null;
      },
    };
    await (
      await preparedCommand("card-settlement.accept", { proposalId, reason: "probe" }, probe)
    )();
    expect(length).toBeGreaterThan(8);
    const failing: SqlWrite = {
      sql: "INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at) VALUES(0,'x','x','x')",
      binds: [],
    };
    for (let index = 0; index < length; index += 1) {
      const injected: MutationPlanners = {
        ...changeMutationPlanners(db),
        "card-settlement.accept": async (input) => {
          const mutation = await cardSettlementMutation(input);
          if (!mutation) return null;
          return {
            ...mutation,
            writes: mutation.writes.map((write, at) => (at === index ? failing : write)),
          };
        },
      };
      const run = await preparedCommand(
        "card-settlement.accept",
        { proposalId, reason: `failure at ${index}` },
        injected,
      );
      const before = await snapshot();
      await expect(run()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    }
    // The batch itself is whole.
    expect((await command("card-settlement.accept", { proposalId, reason: "reviewed" })).ok).toBe(
      true,
    );
  }, 180000);
});

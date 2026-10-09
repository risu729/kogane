// SBI Shinsei activity parser 0.1.3 records `_kogane.identityOrigin:
// "provider-id"` (ADR 0018, 2026-10-09 note). This file walks what deploying it
// would do to a store that already holds a 0.1.2 parse of a capture: the
// repair lane re-parses the stored capture under 0.1.3 beside the 0.1.2 run,
// the settlement sweep proposes the 0.1.3 row under the same bank key, a
// settlement accepted before G1b keeps reserving it, nothing is adopted by
// itself, and only a human's acceptance consumes the debit, under the declared
// alias class. A reference the provider reused later collides with that
// holder instead of counting twice.
//
// The 0.1.2 run is seeded as the deployed parser's output without the origin
// key: packages/parsers/test/coverage-contract.test.ts and
// sbi-shinsei-parsers.test.ts prove that is exactly 0.1.2's output. Every
// value is synthetic (the parser-boundary fixture and variants of it).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Miniflare } from "miniflare";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";
import { sweep } from "../src/worker.ts";
import { cardSettlementSweep } from "../src/card-settlement-job.ts";
import { cardSettlementReadinessCtes } from "../../../packages/read-model/src/card-settlement-readiness.ts";
import { identifyParse, type IdentityResolver } from "../src/identity-store.ts";
import {
  approve,
  commit,
  createPlan,
  d1CommandStore,
  type ChangeKind,
  type Principal,
} from "../../../packages/application/src/index.ts";
import { cardSettlementDebitIdentity } from "../../../packages/application/src/operations/card-settlement-target.ts";
import { aliasClassText } from "../../../packages/domain/src/economic-contract.ts";
import type { CardSettlementFacts } from "../../../packages/domain/src/card-settlement.ts";
import { sbiShinseiTopBalancesAndActivity } from "../../../packages/parsers/src/parsers/sbi-shinsei-top-balances-and-activity.ts";
import type { ArtifactMeta } from "../../../packages/parsers/src/types.ts";
import { changeMutationPlanners } from "../src/change-commands.ts";

const FIXTURE = new URL(
  "../../../tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/top-accounts-balance-and-activity.json",
  import.meta.url,
);
const SOURCE = "sbi-shinsei-bank";
const DATASET = "top-accounts-balance-and-activity";
const PARSER = sbiShinseiTopBalancesAndActivity.name;

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

/** Identify one parse run of an artifact (seeded with its fetch run's id). */
const identify = (id: number, source: string, artifact = id) =>
  identifyParse(
    db,
    {
      id,
      artifact_id: artifact,
      source_id: source,
      producer_id: "collector-r2-importer",
      fetch_run_id: artifact,
    },
    resolver,
  );

/** The parse run the lane published for an artifact, with its version. */
const published = (artifactId: number) =>
  db
    .prepare(
      `SELECT p.id,p.parser_version FROM published_parse_runs pub JOIN parse_runs p ON p.id=pub.parse_run_id
       WHERE pub.fetch_artifact_id=? AND pub.parser_name=?`,
    )
    .bind(artifactId, PARSER)
    .first<{ id: number; parser_version: string }>();

/**
 * Store a capture and the run a 0.1.2 deployment wrote for it: the transaction
 * rows of the deployed parser's output with the origin key taken out (the
 * only difference between the two releases), as an `ok` run of version
 * 0.1.2, published and identified. Balances are not needed by the adapter.
 */
async function storedBy012(id: number, payload: unknown, fetchedAtMs: number): Promise<void> {
  await seedArtifact(env, id, SOURCE, DATASET, `${DATASET}.json`, payload, true, fetchedAtMs);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const meta: ArtifactMeta = {
    id,
    sourceId: SOURCE,
    runStatus: "success",
    runFailureCount: 0,
    dataset: DATASET,
    url: null,
    mime: "application/json",
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    sha256: "0".repeat(64),
  };
  await db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'0.1.2',?,'ok','[]')",
    )
    .bind(id, id, PARSER, new Date(fetchedAtMs).toISOString())
    .run();
  for (const row of sbiShinseiTopBalancesAndActivity.parse(bytes, meta).observations) {
    if (row.kind !== "transaction") continue;
    const kogane = { ...(row.extra["_kogane"] as Record<string, unknown>) };
    expect(kogane["identityOrigin"]).toBe("provider-id");
    delete kogane["identityOrigin"];
    await db
      .prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,as_of,observed_at,raw_locator,extra_json)
       VALUES(?,?,?,NULL,?,?,?,?,?,?,?,?,?)`)
      .bind(
        id,
        row.sourceAccount,
        row.externalId ?? null,
        row.amountMinor ?? null,
        row.amountText ?? null,
        row.amountScale ?? null,
        row.currency ?? null,
        row.description ?? null,
        row.asOf,
        row.observedAt ?? null,
        row.rawLocator,
        JSON.stringify({ ...row.extra, _kogane: kogane }),
      )
      .run();
  }
  await publishParse(db, id);
  await identify(id, SOURCE);
}

/** A synthetic MyJCB statement total, published and identified. */
async function statement(id: number, amount: number, paymentDate: string): Promise<void> {
  await seedArtifact(env, id, "myjcb", "synthetic", `synthetic-${id}`, {});
  await db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,'myjcb-credit-statement-total','1','2026-09-08','ok','[]')",
    )
    .bind(id, id)
    .run();
  await db
    .prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
     VALUES(?,'myjcb:synthetic-origin:root','credit_statement_payment_amount',?,?,0,'JPY','2026-09-01','synthetic-total',?)`)
    .bind(
      id,
      amount,
      String(amount),
      JSON.stringify({
        _kogane: {
          period: paymentDate.slice(0, 7),
          paymentDate,
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        },
      }),
    )
    .run();
  await publishParse(db, id);
  await identify(id, "myjcb");
}

async function preparedCommand(kind: ChangeKind, payload: unknown) {
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
  return () =>
    commit(store, {
      operationId: "sbi-origin-op-" + ++sequence,
      principal: actor,
      planId: planned.plan.planId,
      approvalId: approval.approval.approvalId,
      planners: changeMutationPlanners(db),
      now,
    });
}
const command = async (kind: ChangeKind, payload: unknown) =>
  (await preparedCommand(kind, payload))();

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

const count = async (sql: string, ...binds: (string | number)[]): Promise<number> =>
  (await db
    .prepare(sql)
    .bind(...binds)
    .first<{ n: number }>())!.n;

interface Candidate {
  id: string;
  bank_key: string;
  bank_parse_run_id: number;
  facts_json: string;
}
/** The owned SBI Shinsei candidates, oldest first. */
const candidates = async (): Promise<Candidate[]> =>
  (
    await db
      .prepare(
        `SELECT id,bank_key,bank_parse_run_id,facts_json FROM card_settlement_candidates
         WHERE json_extract(facts_json,'$.bankDebit.sourceId')='sbi-shinsei-bank'
          AND json_extract(facts_json,'$.ownership')='established-same' ORDER BY created_at,id`,
      )
      .all<Candidate>()
  ).results;
const facts = (candidate: Candidate) => JSON.parse(candidate.facts_json) as CardSettlementFacts;
/** The resolved bank account the candidate's facts name (an owned candidate has one). */
const bankAccount = (candidate: Candidate): string => {
  const account = facts(candidate).bankDebit.accountId;
  if (account === null) throw new Error("no resolved bank account");
  return account;
};

const readiness = async (id: string) =>
  db
    .prepare(
      `WITH chosen AS (SELECT ?1 AS id), ${cardSettlementReadinessCtes()}
       SELECT statement_current,bank_current,ownership_current,allocation_available,claim_available FROM readiness`,
    )
    .bind(id)
    .first<Record<string, number>>();

/** What any adoption writes; the release and the sweep must not change them. */
const adopted = async () => ({
  decisions: await count("SELECT count(*) AS n FROM decision_revisions"),
  settlements: await count("SELECT count(*) AS n FROM card_settlement_decisions"),
  claims: await count("SELECT count(*) AS n FROM economic_claims"),
  allocations: await count("SELECT count(*) AS n FROM allocations"),
});

const BANK = 2101;
const STATEMENT = 2103;
let reparsed = 0;

test("a debit a 0.1.2 run stored is a candidate whose acceptance is refused: identity_origin_unrecorded", async () => {
  await storedBy012(
    BANK,
    JSON.parse(readFileSync(FIXTURE, "utf8")),
    Date.parse("2026-09-07T00:10:00Z"),
  );
  await statement(STATEMENT, 1200, "2026-09-07");
  await ownership(STATEMENT, "liable_party");
  await ownership(BANK, "beneficial_owner");
  expect(await cardSettlementSweep(db)).toMatchObject({ proposed: 1, written: 1 });
  const [candidate] = await candidates();
  expect(candidate!.bank_parse_run_id).toBe(BANK);
  expect(await readiness(candidate!.id)).toEqual({
    statement_current: 1,
    bank_current: 1,
    ownership_current: 1,
    allocation_available: 1,
    claim_available: 1,
  });
  expect(
    await cardSettlementDebitIdentity(d1CommandStore(db), candidate!.id, facts(candidate!)),
  ).toEqual({ admitted: false, refusal: "identity_origin_unrecorded" });
  const before = await adopted();
  await expect(
    command("card-settlement.accept", { proposalId: candidate!.id, reason: "synthetic" }),
  ).rejects.toThrow(
    '"unsupported_semantics","refs":["card-settlement:' +
      candidate!.id +
      '","identity_origin_unrecorded"]',
  );
  expect(await adopted()).toEqual(before);
}, 60000);

test("an acceptance made before G1b holds the 0.1.2-cited candidate (no claim row, as that build wrote it)", async () => {
  const [candidate] = await candidates();
  const decision = (id: string, subject: string) =>
    db
      .prepare(
        `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,created_at)
 VALUES(?,'relation',?,1,'accept','manual','synthetic-human',NULL,'synthetic pre-guard acceptance','[]',NULL,?)`,
      )
      .bind(id, subject, now);
  await db.batch([
    decision("dr-legacy-origin", `card-settlement:${candidate!.id}`),
    decision("dr-legacy-origin-event", "event:legacy-origin-event"),
    decision("dr-legacy-origin-allocation", "allocation:legacy-origin-allocation"),
    db
      .prepare(
        `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,created_at)
 VALUES('legacy-origin-event',1,'card_settlement','debited',NULL,'{}','cash-movement','["synthetic-evidence"]','dr-legacy-origin-event',?)`,
      )
      .bind(now),
    db
      .prepare(
        `INSERT INTO allocations(id,source_component_ref,target_effect_ref,role,unit_ref,coefficient,scale,decision_revision_id,created_at)
 SELECT 'legacy-origin-allocation','transaction:'||bank_observation_id,'event:legacy-origin-event','settlement','JPY','1200',0,'dr-legacy-origin-allocation',?
 FROM card_settlement_candidates WHERE id=?`,
      )
      .bind(now, candidate!.id),
    db
      .prepare(
        `INSERT INTO card_settlement_decisions(proposal_id,revision,status,decision_revision_id,event_id,obligation_id,settlement_id,created_at)
 VALUES(?,1,'accepted','dr-legacy-origin','legacy-origin-event',NULL,'legacy-origin-allocation',?)`,
      )
      .bind(candidate!.id, now),
  ]);
  expect(await count("SELECT count(*) AS n FROM economic_claims")).toBe(0);
}, 60000);

test("the repair lane re-parses the stored capture under 0.1.3 beside the 0.1.2 run; nothing is rewritten or adopted", async () => {
  const before = await adopted();
  const old = await db
    .prepare("SELECT * FROM transaction_observations WHERE parse_run_id=? ORDER BY id")
    .bind(BANK)
    .all<Record<string, unknown>>();
  expect(old.results).toHaveLength(2);
  for (
    let attempt = 0;
    attempt < 5 && (await published(BANK))?.parser_version !== "0.1.3";
    attempt++
  )
    expect((await sweep(env, { lane: "repair" })).lanes.repair?.error).toBe(0);
  const current = await published(BANK);
  expect(current?.parser_version).toBe("0.1.3");
  reparsed = current!.id;
  await identify(reparsed, SOURCE, BANK);
  // Both runs are kept: the 0.1.2 run is marked superseded, its rows unchanged.
  expect(
    (
      await db
        .prepare(
          "SELECT parser_version,status,superseded_by_parse_run_id AS superseded FROM parse_runs WHERE fetch_artifact_id=? ORDER BY id",
        )
        .bind(BANK)
        .all()
    ).results,
  ).toEqual([
    { parser_version: "0.1.2", status: "ok", superseded: reparsed },
    { parser_version: "0.1.3", status: "ok", superseded: null },
  ]);
  expect(
    (
      await db
        .prepare("SELECT * FROM transaction_observations WHERE parse_run_id=? ORDER BY id")
        .bind(BANK)
        .all<Record<string, unknown>>()
    ).results,
  ).toEqual(old.results);
  const rows = (
    await db
      .prepare(
        "SELECT external_id,source_account,amount_text,as_of,extra_json FROM transaction_observations WHERE parse_run_id IN (?,?) ORDER BY parse_run_id,id",
      )
      .bind(BANK, reparsed)
      .all<{
        external_id: string;
        source_account: string;
        amount_text: string;
        as_of: string;
        extra_json: string;
      }>()
  ).results;
  // Same references, accounts, amounts and dates; the origin only on the new rows.
  const shape = rows.map(({ extra_json: _, ...row }) => row);
  expect(shape.slice(2)).toEqual(shape.slice(0, 2));
  expect(
    rows.map(
      (row) =>
        (JSON.parse(row.extra_json) as { _kogane: Record<string, unknown> })._kogane[
          "identityOrigin"
        ] ?? null,
    ),
  ).toEqual([null, null, "provider-id", "provider-id"]);
  // The pointer moved by an appended publication event.
  expect(
    await db
      .prepare(
        "SELECT previous_parse_run_id AS previous,new_parse_run_id AS next,kind FROM publication_events WHERE fetch_artifact_id=? ORDER BY id DESC LIMIT 1",
      )
      .bind(BANK)
      .first<Record<string, unknown>>(),
  ).toEqual({ previous: BANK, next: reparsed, kind: "normal" });
  // The adapter now names the 0.1.3 row; the 0.1.2-cited candidate is no longer current.
  expect(
    (
      await db
        .prepare(
          "SELECT parse_run_id FROM card_bank_debit_facts WHERE external_id='SYNTHETIC-TXN-001'",
        )
        .all<{ parse_run_id: number }>()
    ).results,
  ).toEqual([{ parse_run_id: reparsed }]);
  const [old012] = await candidates();
  expect(await readiness(old012!.id)).toMatchObject({ bank_current: 0 });
  expect(await adopted()).toEqual(before);
}, 60000);

test("the sweep proposes the 0.1.3 row under the same bank key; the pre-G1b acceptance still reserves it", async () => {
  const before = await adopted();
  await cardSettlementSweep(db);
  const [old012, new013, ...rest] = await candidates();
  expect(rest).toEqual([]);
  expect(new013!.bank_parse_run_id).toBe(reparsed);
  expect(new013!.bank_key).toBe(old012!.bank_key);
  // Rule 2 no longer refuses the 0.1.3 row; the 0.1.2 one still is.
  expect(await cardSettlementDebitIdentity(d1CommandStore(db), new013!.id, facts(new013!))).toEqual(
    {
      admitted: true,
      aliasClass: {
        sourceId: "sbi-shinsei-bank",
        components: ["SYNTHETIC-TXN-001"],
        accountId: bankAccount(new013!),
        ruleVersion: "sbi-shinsei-txn-reference-no-v1",
      },
    },
  );
  expect(await cardSettlementDebitIdentity(d1CommandStore(db), old012!.id, facts(old012!))).toEqual(
    { admitted: false, refusal: "identity_origin_unrecorded" },
  );
  expect(await readiness(new013!.id)).toEqual({
    statement_current: 1,
    bank_current: 1,
    ownership_current: 1,
    allocation_available: 0,
    claim_available: 0,
  });
  await expect(
    command("card-settlement.accept", { proposalId: new013!.id, reason: "synthetic" }),
  ).rejects.toThrow('"stale_context"');
  // Proposing is not adopting.
  expect(await adopted()).toEqual(before);
}, 60000);

test("once the pre-G1b acceptance is withdrawn, a human accepts the 0.1.3 debit under its alias class", async () => {
  const [old012, new013] = await candidates();
  const withdrawn = await command("card-settlement.withdraw", {
    proposalId: old012!.id,
    reason: "correspondence judgement corrected",
  });
  if (!withdrawn.ok) throw new Error(JSON.stringify(withdrawn));
  expect(await readiness(new013!.id)).toMatchObject({
    allocation_available: 1,
    claim_available: 1,
  });
  const accepted = await command("card-settlement.accept", {
    proposalId: new013!.id,
    reason: "verified total and SBI Shinsei debit",
  });
  if (!accepted.ok) throw new Error(JSON.stringify(accepted));
  const eventId = accepted.receipt.result["eventId"] as string;
  const observation = (await db
    .prepare(
      "SELECT id FROM transaction_observations WHERE parse_run_id=? AND external_id='SYNTHETIC-TXN-001'",
    )
    .bind(reparsed)
    .first<{ id: number }>())!.id;
  expect(
    await db
      .prepare(
        "SELECT book,consumption_key,alias_class,observation_id,parse_run_id FROM economic_claims WHERE event_id=?",
      )
      .bind(eventId)
      .all(),
  ).toMatchObject({
    results: [
      {
        book: "cash-movement",
        consumption_key: new013!.bank_key,
        alias_class: aliasClassText({
          sourceId: "sbi-shinsei-bank",
          components: ["SYNTHETIC-TXN-001"],
          accountId: bankAccount(new013!),
          ruleVersion: "sbi-shinsei-txn-reference-no-v1",
        }),
        observation_id: observation,
        parse_run_id: reparsed,
      },
    ],
  });
}, 60000);

test("a reference the provider reused later is refused against the holder, never a second payment", async () => {
  // Not observed: a later capture whose different debit carries an earlier
  // reference. The adapter keeps the newest capture per reference, and the
  // live claim on that reference reserves it.
  const reused = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    responseParam: { activity: { responseParam: Record<string, unknown> } };
  };
  Object.assign(reused.responseParam.activity.responseParam, {
    fromDate: "20261001",
    toDate: "20261007",
    activityDetails: [
      {
        txnReferenceNo: "SYNTHETIC-TXN-001",
        description: "Synthetic later debit",
        debit: "1300",
        postingDate: "20261006",
        balance: "121956",
        tradeTypeCode: "SYNTHETIC",
      },
    ],
  });
  await seedArtifact(
    env,
    2105,
    SOURCE,
    DATASET,
    `${DATASET}.json`,
    reused,
    true,
    Date.parse("2026-10-07T00:10:00Z"),
  );
  expect((await sweep(env, { lane: "incremental" })).lanes.incremental?.error).toBe(0);
  const later = await published(2105);
  expect(later?.parser_version).toBe("0.1.3");
  await identify(later!.id, SOURCE, 2105);
  // The same card and bank accounts: their ownership is already recorded.
  await statement(2106, 1300, "2026-10-07");
  const before = await adopted();
  await cardSettlementSweep(db);
  const all = await candidates();
  const third = all.find((candidate) => candidate.bank_parse_run_id === later!.id)!;
  expect(third.bank_key).toBe(all[0]!.bank_key);
  // The accepted candidate's debit is no longer the newest capture of the key.
  expect(await readiness(all[1]!.id)).toMatchObject({ bank_current: 0 });
  expect(await readiness(third.id)).toMatchObject({
    bank_current: 1,
    allocation_available: 0,
    claim_available: 0,
  });
  await expect(
    command("card-settlement.accept", { proposalId: third.id, reason: "synthetic" }),
  ).rejects.toThrow('"stale_context"');
  expect(await adopted()).toEqual(before);
  // The plan answers on the 0044 reservation first; behind it the key is held
  // by the accepted event's live claim (claim_available 0 above).
  expect(
    await db
      .prepare(
        "SELECT count(*) AS n FROM economic_claims c JOIN card_settlement_candidates k ON k.bank_key=c.consumption_key WHERE k.id=?",
      )
      .bind(third.id)
      .first<{ n: number }>(),
  ).toEqual({ n: 1 });
}, 60000);

// SBI Shinsei as the second bank adapter of card settlement review (migration
// 0052, ADR 0018). Every bank capture is the synthetic parser-boundary fixture
// (tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries), or a
// variant of it, stored and parsed by the processor's incremental lane through
// the deployed `sbi-shinsei-top-balances-and-activity` parser. The statement is
// a synthetic MyJCB total, as in card-settlement.test.ts. Every value is
// synthetic.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Miniflare } from "miniflare";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";
import { sweep } from "../src/worker.ts";
import { cardSettlementSweep } from "../src/card-settlement-job.ts";
import { identifyParse, type IdentityResolver } from "../src/identity-store.ts";
import {
  approve,
  commit,
  createPlan,
  d1CommandStore,
  type ChangeKind,
  type Principal,
} from "../../../packages/application/src/index.ts";
import { changeMutationPlanners } from "../src/change-commands.ts";

const FIXTURE = new URL(
  "../../../tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/top-accounts-balance-and-activity.json",
  import.meta.url,
);
const DATASET = "top-accounts-balance-and-activity";
const PARSER = "sbi-shinsei-top-balances-and-activity";

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

interface Activity {
  accountNo: string;
  currency: string;
  currentBalance: string;
  activityDetails: Record<string, string>[];
}
interface Fixture {
  responseParam: { activity: { responseParam: Activity } };
}
const fixture = (): Fixture => JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

/**
 * The fixture's JPY activity with the rows the adapter must refuse beside its
 * one debit: a credit of the same amount on the same day, and a zero debit.
 */
function jpyActivity(): Fixture {
  const payload = fixture();
  const rows = payload.responseParam.activity.responseParam.activityDetails;
  expect(rows.map((row) => [row["txnReferenceNo"], "debit" in row ? "debit" : "credit"])).toEqual([
    ["SYNTHETIC-TXN-001", "debit"],
    ["SYNTHETIC-TXN-002", "credit"],
  ]);
  rows.push(
    {
      txnReferenceNo: "SYNTHETIC-TXN-003",
      description: "Synthetic credit of the bill amount",
      credit: "1200",
      postingDate: "20260906",
      balance: "125956",
      tradeTypeCode: "SYNTHETIC",
    },
    {
      txnReferenceNo: "SYNTHETIC-TXN-004",
      description: "Synthetic zero debit",
      debit: "0",
      postingDate: "20260906",
      balance: "125956",
      tradeTypeCode: "SYNTHETIC",
    },
  );
  return payload;
}

/** The fixture's second (USD) account's activity: a debit of the bill's number, in dollars. */
function foreignActivity(): Fixture {
  const payload = fixture();
  const activity = payload.responseParam.activity.responseParam;
  activity.accountNo = "SYNTHETIC-002";
  activity.currency = "USD";
  activity.currentBalance = "12.34";
  activity.activityDetails = [
    {
      txnReferenceNo: "SYNTHETIC-TXN-USD-001",
      description: "Synthetic foreign debit",
      debit: "1200",
      postingDate: "20260906",
      balance: "12.34",
      tradeTypeCode: "SYNTHETIC",
    },
  ];
  return payload;
}

/** Store one capture and parse it through the processor's incremental lane; returns the parse run. */
async function capture(id: number, payload: unknown, fetchedAtMs: number): Promise<number> {
  await seedArtifact(
    env,
    id,
    "sbi-shinsei-bank",
    DATASET,
    `${DATASET}.json`,
    payload,
    true,
    fetchedAtMs,
  );
  const result = await sweep(env, { lane: "incremental" });
  expect(result.lanes.incremental?.error).toBe(0);
  const parse = await db
    .prepare(
      `SELECT p.id,p.parser_name FROM parse_runs p JOIN published_parse_runs pub ON pub.parse_run_id=p.id
       WHERE p.fetch_artifact_id=? AND p.status='ok'`,
    )
    .bind(id)
    .first<{ id: number; parser_name: string }>();
  expect(parse?.parser_name).toBe(PARSER);
  await identifyParse(
    db,
    {
      id: parse!.id,
      artifact_id: id,
      source_id: "sbi-shinsei-bank",
      producer_id: "collector-r2-importer",
      fetch_run_id: id,
    },
    resolver,
  );
  return parse!.id;
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
     VALUES(?,'myjcb:synthetic-sbi:root','credit_statement_payment_amount',?,?,0,'JPY','2026-09-01','synthetic-total',?)`)
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
  await identifyParse(
    db,
    {
      id,
      artifact_id: id,
      source_id: "myjcb",
      producer_id: "collector-r2-importer",
      fetch_run_id: id,
    },
    resolver,
  );
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
      operationId: "sbi-op-" + ++sequence,
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
  facts_json: string;
}
const candidates = async (where = "1=1"): Promise<Candidate[]> =>
  (
    await db
      .prepare(
        `SELECT id,facts_json FROM card_settlement_candidates WHERE ${where} ORDER BY created_at,id`,
      )
      .all<Candidate>()
  ).results;
const bankSource = (candidate: Candidate): string =>
  (JSON.parse(candidate.facts_json) as { bankDebit: { sourceId: string } }).bankDebit.sourceId;

const readiness = async (id: string) =>
  db
    .prepare(
      "SELECT statement_current,bank_current,ownership_current,allocation_available FROM card_settlement_readiness WHERE id=?",
    )
    .bind(id)
    .first<Record<string, number>>();

const STATEMENT_PARSE = 1103;
let jpyParse = 0;

test("only the provider's own JPY debit is an adapter row; credits, zero and foreign-currency rows are not", async () => {
  const at = Date.parse("2026-09-07T00:10:00Z");
  jpyParse = await capture(1101, jpyActivity(), at);
  await capture(1102, foreignActivity(), at + 60_000);
  // Every row the parser read is stored, whatever the adapter admits.
  expect(
    await count(
      "SELECT count(*) AS n FROM transaction_observations WHERE source_account LIKE 'sbi-shinsei:%'",
    ),
  ).toBe(5);
  const rows = (
    await db
      .prepare(
        "SELECT external_id,unit_ref,coefficient,scale,value_status,status,debit_date,adapter FROM card_bank_debit_facts",
      )
      .all()
  ).results;
  expect(rows).toEqual([
    {
      external_id: "SYNTHETIC-TXN-001",
      unit_ref: "JPY",
      coefficient: "-1200",
      scale: 0,
      value_status: "exact",
      status: null,
      debit_date: "2026-09-06",
      adapter: "sbi-shinsei-bank",
    },
  ]);
}, 60000);

test("an equal-amount statement within three days produces a candidate, which unknown ownership cannot accept", async () => {
  await statement(STATEMENT_PARSE, 1200, "2026-09-07");
  expect(await cardSettlementSweep(db)).toMatchObject({ proposed: 1, written: 1 });
  const [candidate] = await candidates();
  const facts = JSON.parse(candidate!.facts_json);
  expect(facts.bankDebit).toMatchObject({
    sourceId: "sbi-shinsei-bank",
    sourceAccount: "sbi-shinsei:SYNTHETIC-001",
    amount: {
      unitRef: "JPY",
      value: { status: "exact", value: { coefficient: "1200", scale: 0 } },
    },
    occurred: { kind: "local-date", value: "2026-09-06", zone: "Asia/Tokyo", basis: "provider" },
  });
  expect(facts.ownership).toBe("unknown");
  expect(await readiness(candidate!.id)).toMatchObject({ bank_current: 1, ownership_current: 0 });
  await expect(
    command("card-settlement.accept", { proposalId: candidate!.id, reason: "test" }),
  ).rejects.toThrow();
  expect(await count("SELECT count(*) AS n FROM current_allocations")).toBe(0);
}, 60000);

test("re-observing the same txnReferenceNo is one payment, not a second one", async () => {
  const before = await candidates();
  const reobserved = await capture(1104, jpyActivity(), Date.parse("2026-09-08T00:10:00Z"));
  expect(
    await count(
      "SELECT count(*) AS n FROM transaction_observations WHERE external_id='SYNTHETIC-TXN-001'",
    ),
  ).toBe(2);
  // The view keeps the newest capture of the provider id only.
  const current = await db
    .prepare("SELECT parse_run_id FROM card_bank_debit_facts WHERE external_id='SYNTHETIC-TXN-001'")
    .all<{ parse_run_id: number }>();
  expect(current.results.map((row) => row.parse_run_id)).toEqual([reobserved]);
  await cardSettlementSweep(db);
  const after = await candidates();
  expect(after).toHaveLength(before.length + 1);
  // The earlier observation's candidate is no longer current; both name one bank key.
  expect(await readiness(before[0]!.id)).toMatchObject({ bank_current: 0 });
  expect(await count("SELECT count(DISTINCT bank_key) AS n FROM card_settlement_candidates")).toBe(
    1,
  );
}, 60000);

test("ownership is still required, and an accepted SBI Shinsei debit reserves the statement against an SMBC one", async () => {
  await ownership(STATEMENT_PARSE, "liable_party");
  await ownership(jpyParse, "beneficial_owner");
  // An SMBC debit of the same bill, in the old adapter's shape (card-settlement.test.ts).
  await seedArtifact(env, 1105, "smbc-bank", "transactions-normalized", "smbc-synthetic", {});
  await db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(1105,1105,'smbc-direct-transactions','1','2026-09-08','ok','[]')",
    )
    .run();
  await db
    .prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,as_of,raw_locator,extra_json)
     VALUES(1105,'smbc-bank:synthetic-sbi-test','synthetic-smbc-debit','posted',-1200,'-1200',0,'JPY','2026-09-07T00:00:00+09:00','synthetic',?)`)
    .bind(JSON.stringify({ _kogane: { direction: "outflow", amountSignSource: "direction" } }))
    .run();
  await publishParse(db, 1105);
  await identifyParse(
    db,
    {
      id: 1105,
      artifact_id: 1105,
      source_id: "smbc-bank",
      producer_id: "collector-r2-importer",
      fetch_run_id: 1105,
    },
    resolver,
  );
  await ownership(1105, "beneficial_owner");
  await cardSettlementSweep(db);
  const owned = await candidates("json_extract(facts_json,'$.ownership')='established-same'");
  const sbi = owned.filter((row) => bankSource(row) === "sbi-shinsei-bank");
  const smbc = owned.filter((row) => bankSource(row) === "smbc-bank");
  expect(sbi).toHaveLength(1);
  expect(smbc).toHaveLength(1);
  // The owned SBI Shinsei candidate cites the newest observation of the provider id.
  expect(await readiness(sbi[0]!.id)).toEqual({
    statement_current: 1,
    bank_current: 1,
    ownership_current: 1,
    allocation_available: 1,
  });
  const accepted = await command("card-settlement.accept", {
    proposalId: sbi[0]!.id,
    reason: "verified total and SBI Shinsei debit",
  });
  if (!accepted.ok) throw new Error(JSON.stringify(accepted));
  expect(await count("SELECT count(*) AS n FROM current_allocations")).toBe(1);
  // Across adapters: the statement is reserved, so the SMBC debit is not available to it.
  expect(await readiness(smbc[0]!.id)).toMatchObject({ allocation_available: 0 });
  await expect(
    command("card-settlement.accept", { proposalId: smbc[0]!.id, reason: "second payment" }),
  ).rejects.toThrow();
  // Every other candidate of the same provider id is reserved too.
  for (const other of await candidates())
    if (other.id !== sbi[0]!.id && bankSource(other) === "sbi-shinsei-bank")
      expect(await readiness(other.id)).toMatchObject({ allocation_available: 0 });
  // Withdrawal frees the statement for the SMBC review; the SBI Shinsei row stays as it was.
  const withdrawn = await command("card-settlement.withdraw", {
    proposalId: sbi[0]!.id,
    reason: "correspondence judgement corrected",
  });
  if (!withdrawn.ok) throw new Error(JSON.stringify(withdrawn));
  expect(await readiness(smbc[0]!.id)).toMatchObject({ allocation_available: 1 });
  expect(
    await count("SELECT count(*) AS n FROM card_bank_debit_facts WHERE adapter='sbi-shinsei-bank'"),
  ).toBe(1);
}, 60000);

test("another allocation of the SBI Shinsei provider id blocks its review", async () => {
  const [sbi] = (
    await candidates("json_extract(facts_json,'$.ownership')='established-same'")
  ).filter((row) => bankSource(row) === "sbi-shinsei-bank");
  expect(await readiness(sbi!.id)).toMatchObject({ allocation_available: 1 });
  await db
    .prepare(`INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,reason,evidence_refs_json,created_at)
     VALUES('sbi-generic-decision','relation','allocation:sbi-generic-allocation',1,'accept','manual','synthetic-human','Existing separate allocation','[]','2098')`)
    .run();
  // Against the older observation of the same provider id: the key, not the row, is reserved.
  await db
    .prepare(`INSERT INTO allocations(id,source_component_ref,target_effect_ref,role,unit_ref,coefficient,scale,decision_revision_id,created_at)
     SELECT 'sbi-generic-allocation','transaction:'||id,'event:other-effect','transfer','JPY','1',0,'sbi-generic-decision','2098'
     FROM transaction_observations WHERE parse_run_id=? AND external_id='SYNTHETIC-TXN-001'`)
    .bind(jpyParse)
    .run();
  expect(await readiness(sbi!.id)).toMatchObject({ allocation_available: 0 });
  await expect(
    command("card-settlement.accept", { proposalId: sbi!.id, reason: "already allocated" }),
  ).rejects.toThrow();
}, 60000);

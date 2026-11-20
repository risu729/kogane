// Which bank account each card is debited from
// (packages/application/src/query/card-debit-accounts.ts, ADR 0114,
// docs/card-settlements.md, Debit account per card) on the complete CORE
// schema: a stated MyJCB account whose newest reading no longer resolves, a
// Vpass card answered by an accepted settlement and unanswered again after
// its withdrawal, a Vpass card with only an undecided candidate, and one with
// nothing, and a Vpass card whose total the decimal-v1 projection could not
// read, which keeps its status and reason, and a Vpass month accepted under
// one card ordinal whose candidate under the next ordinal, which the guard
// refuses, is not listed as open; that the read writes nothing, is graded
// before it reads, and reaches readings, decisions and settled months by key
// without table statistics. Every value is synthetic.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import {
  CARD_DEBIT_ACCOUNT_CANDIDATES_SQL,
  CARD_DEBIT_ACCOUNT_READINGS_SQL,
  reviewCardDebitAccounts,
  type CardDebitAccountCard,
} from "../../../packages/application/src/query/card-debit-accounts.ts";
import {
  approve,
  commit,
  createPlan,
  d1CommandStore,
  type ChangeKind,
  type Grant,
  type Principal,
} from "../../../packages/application/src/index.ts";
import { CARD_DEBIT_ACCOUNT_POLICY } from "../../../packages/domain/src/card-debit-account.ts";
import { CARD_INFORMATION_READER_VERSION } from "../../../packages/domain/src/myjcb-card-information.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { cardSettlementSweep } from "../src/card-settlement-job.ts";
import { changeMutationPlanners } from "../src/change-commands.ts";
import { identifyParse, type IdentityResolver } from "../src/identity-store.ts";
import { publishParse, seedArtifact, startPipeline } from "./harness.ts";

let mf: Miniflare, env: Env, db: D1Database;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  db = env.DB;
  await seed();
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

const WHOLE: Grant = {
  principal: "synthetic-reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["records.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};
const actor: Principal = {
  id: "synthetic-human",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
const now = "2098-03-01T00:00:00.000Z";
let sequence = 0;
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

const MYJCB = "myjcb:synthetic:root";
const BANK = "smbc-bank:synthetic";
const OTHER_BANK = "smbc-bank:synthetic-other";
/** Statement parses: [parse id, source, parser, card, period, total, due date]. */
const STATEMENTS: [number, string, string, string, string, string, string][] = [
  [801, "myjcb", "myjcb-credit-statement-total", MYJCB, "2098-01", "3000", "2098-01-10"],
  // The card's newest statement is a zero total: nothing to match.
  [802, "myjcb", "myjcb-credit-statement-total", MYJCB, "2098-02", "0", "2098-02-10"],
  [811, "vpass", "vpass-statement-page", "vpass:card-001", "2098-01", "5000", "2098-01-27"],
  [812, "vpass", "vpass-statement-page", "vpass:card-002", "2098-01", "4000", "2098-01-26"],
  [813, "vpass", "vpass-statement-page", "vpass:card-003", "2098-01", "7000", "2098-01-25"],
  // A total that is not a number: decimal-v1 records it `unparsed`.
  [814, "vpass", "vpass-statement-page", "vpass:card-004", "2098-01", "unreadable", "2098-01-25"],
];
/** SMBC debits: [provider id, magnitude, debit date]. */
const DEBITS: [string, string, string][] = [
  ["dd-1", "3000", "2098-01-10"],
  ["dd-2", "5000", "2098-01-27"],
  ["dd-3", "4000", "2098-01-26"],
];

/** One statement parse, neither published nor identified. */
async function seedStatement([
  id,
  source,
  parser,
  card,
  period,
  total,
  due,
]: (typeof STATEMENTS)[number]) {
  await seedArtifact(env, id, source, "synthetic", "synthetic-" + id, { id });
  await db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'1','2098-02-12','ok','[]')",
    )
    .bind(id, id, parser)
    .run();
  await db
    .prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
 VALUES(?,?,'credit_statement_payment_amount',?,?,0,'JPY',?,?,?)`)
    .bind(
      id,
      card,
      /^-?\d+$/u.test(total) ? Number(total) : null,
      total,
      period + "-01",
      "synthetic-" + period,
      JSON.stringify({
        _kogane: {
          period,
          paymentDate: due,
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        },
      }),
    )
    .run();
}

async function seed() {
  for (const statement of STATEMENTS) await seedStatement(statement);
  await seedArtifact(env, 820, "smbc-bank", "synthetic", "synthetic-820", { id: 820 });
  await db
    .prepare(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(820,820,'smbc-direct-transactions','1','2098-02-12','ok','[]')",
    )
    .run();
  for (const [providerId, amount, date] of DEBITS)
    await db
      .prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,counterparty,as_of,raw_locator,extra_json)
  VALUES(820,?,?,'posted',?,?,0,'JPY','synthetic',?,?,?)`)
      .bind(
        BANK,
        providerId,
        -Number(amount),
        "-" + amount,
        date + "T00:00:00+09:00",
        "synthetic-" + providerId,
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
  for (const [id, source] of [
    ...STATEMENTS.map(([parse, statementSource]) => [parse, statementSource] as const),
    [820, "smbc-bank"] as const,
  ]) {
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
}

async function command(kind: ChangeKind, payload: unknown) {
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
  const result = await commit(store, {
    operationId: "debit-accounts-op-" + ++sequence,
    principal: actor,
    planId: planned.plan.planId,
    approvalId: approval.approval.approvalId,
    planners: changeMutationPlanners(db),
    now,
  });
  if (!result.ok) throw new Error(kind + " " + JSON.stringify(result));
}

async function ownership(parse: number, kind: "liable_party" | "beneficial_owner") {
  const mapping = await db
    .prepare(
      "SELECT m.account_id FROM current_account_mappings m JOIN current_identity_observations o ON o.source_account_id=m.source_account_id WHERE o.parse_run_id=? LIMIT 1",
    )
    .bind(parse)
    .first<{ account_id: string }>();
  if (!mapping) throw new Error("no mapping");
  await command("relation.accept", {
    relationKind: kind,
    fromRef: "account:" + mapping.account_id,
    toRef: "party:synthetic-owner",
    validFrom: null,
    validTo: null,
    evidenceRefs: ["synthetic-proof"],
    reason: "Synthetic explicit ownership evidence",
  });
}

/** A `read` reading of MyJCB page `artifact` captured at `observedAt`, admitted by parse 801. */
async function reading(artifact: number, observedAt: string): Promise<number> {
  const row = await db
    .prepare(`INSERT INTO card_debit_account_statement(source_id,card_source_account,fetch_artifact_id,statement_parse_run_id,raw_sha256,source_object_key,observed_at,reader_version,outcome,refusal_code,bank_name,branch_name,account_type,leading_digits,masked_digit_count,created_at)
 SELECT 'myjcb',?,a.id,?,a.sha256,a.artifact_key,?,?,'read',NULL,'架空銀行','架空支店','普通','1234',3,'2098-02-12'
 FROM fetch_artifacts a WHERE a.id=? RETURNING id`)
    .bind(MYJCB, 801, observedAt, CARD_INFORMATION_READER_VERSION, artifact)
    .first<{ id: number }>();
  return row!.id;
}

async function evidence(
  candidate: string,
  statement: number,
  outcome: "supports" | "names_other_account" | "not_proposed",
  bankSourceAccount: string | null,
  reason: string | null = null,
) {
  await db
    .prepare(`INSERT INTO card_settlement_debit_account_evidence(candidate_id,statement_id,policy,outcome,reason,proposal_json,evidence_digest,created_at)
 VALUES(?,?,?,?,?,?,?,'2098-02-12')`)
    .bind(
      candidate,
      statement,
      CARD_DEBIT_ACCOUNT_POLICY,
      outcome,
      reason,
      bankSourceAccount === null
        ? null
        : JSON.stringify({
            bankSourceId: "smbc-bank",
            bankSourceAccount,
            visibleDigitCount: 4,
          }),
      String(++sequence).padStart(64, "0"),
    )
    .run();
}

async function candidateOf(card: string): Promise<string> {
  const row = await db
    .prepare(
      "SELECT id FROM card_settlement_candidates WHERE json_extract(facts_json,'$.statement.sourceAccount')=? ORDER BY created_at DESC,id DESC LIMIT 1",
    )
    .bind(card)
    .first<{ id: string }>();
  return row!.id;
}

/** Every candidate of `card`, newest first. */
async function candidatesOf(card: string): Promise<string[]> {
  const rows = await db
    .prepare(
      "SELECT id FROM card_settlement_candidates WHERE json_extract(facts_json,'$.statement.sourceAccount')=? ORDER BY created_at DESC,id DESC",
    )
    .bind(card)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

async function review(grant: Grant = WHOLE) {
  const outcome = await reviewCardDebitAccounts({ grant, sql: d1Executor(db) });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
  return outcome.review;
}
const byCard = (items: readonly CardDebitAccountCard[]) =>
  new Map(items.map((item) => [item.card.sourceAccount, item]));

/** Rows per table of the store, so a read that writes anything is seen. */
async function rowCounts(): Promise<Record<string, number>> {
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
      )
      .all<{ name: string }>()
  ).results;
  const counts: Record<string, number> = {};
  for (const { name } of tables)
    counts[name] = (await db
      .prepare(`SELECT count(*) AS n FROM "${name}"`)
      .first<{ n: number }>())!.n;
  return counts;
}

test("before any evidence, every card is listed with its newest statement and no answer", async () => {
  const page = await review();
  expect(page.cardsTruncated).toBe(false);
  expect(page.items.map((item) => item.card.sourceAccount)).toEqual([
    MYJCB,
    "vpass:card-001",
    "vpass:card-002",
    "vpass:card-003",
    "vpass:card-004",
  ]);
  const cards = byCard(page.items);
  // The newest statement is the zero total, shown as the provider stated it.
  expect(cards.get(MYJCB)?.latestStatement).toMatchObject({
    period: "2098-02",
    paymentDate: { kind: "local-date", value: "2098-02-10" },
    amount: { unitRef: "JPY", value: { status: "exact", value: { coefficient: "0" } } },
  });
  // A total the projection could not read keeps its status and reason (INV05).
  expect(cards.get("vpass:card-004")?.latestStatement).toMatchObject({
    period: "2098-01",
    amount: { unitRef: "JPY", value: { status: "unparsed", reasonCode: "stored:unparsed" } },
  });
  expect(cards.get(MYJCB)?.stated).toEqual({
    status: "absent",
    reason: "evidence_not_recorded",
    latest: null,
    lastNamed: null,
  });
  expect(cards.get("vpass:card-001")?.stated).toMatchObject({
    status: "absent",
    reason: "source_has_no_debit_account_statement",
  });
  for (const item of page.items)
    expect(item.answer).toEqual({ basis: "unknown", reason: "no_debit_account_evidence" });
  expect(page.manifest).toMatchObject({
    rule: "card-debit-account-answer-v1",
    statedPolicy: CARD_DEBIT_ACCOUNT_POLICY,
    readerVersion: CARD_INFORMATION_READER_VERSION,
    bases: ["provider-stated", "accepted-settlement"],
    cardsMax: 100,
  });
});

test("undecided candidates are listed but never answer", async () => {
  expect(await cardSettlementSweep(db)).toMatchObject({ proposed: 3 });
  const cards = byCard((await review()).items);
  for (const card of [MYJCB, "vpass:card-001", "vpass:card-002"]) {
    expect(cards.get(card)?.answer).toEqual({
      basis: "unknown",
      reason: "only_unreviewed_candidates",
    });
    expect(cards.get(card)?.proposed).toEqual([
      {
        bankSourceId: "smbc-bank",
        bankSourceAccount: BANK,
        statements: 1,
        latest: {
          proposalId: await candidateOf(card),
          debitDate: expect.stringMatching(/^2098-01-\d\d$/u),
          period: "2098-01",
        },
      },
    ]);
  }
  expect(cards.get("vpass:card-003")?.answer).toEqual({
    basis: "unknown",
    reason: "no_debit_account_evidence",
  });
});

test("a stated account answers first; a newer reading that names none keeps the last named one", async () => {
  const candidate = await candidateOf(MYJCB);
  const first = await reading(801, "2098-01-12T00:00:00Z");
  await evidence(candidate, first, "supports", BANK);
  let item = byCard((await review()).items).get(MYJCB)!;
  expect(item.stated).toMatchObject({
    status: "named",
    latest: { observedAt: "2098-01-12T00:00:00Z" },
  });
  expect(item.answer).toEqual({
    basis: "provider-stated",
    account: { bankSourceId: "smbc-bank", bankSourceAccount: BANK },
    readingRef: {
      kind: "typed-claim",
      id: `card_debit_account_statement:${first}`,
      revision: `reader:${CARD_INFORMATION_READER_VERSION}`,
    },
    observedAt: "2098-01-12T00:00:00Z",
    codes: [],
  });
  const newer = await reading(802, "2098-02-12T00:00:00Z");
  await evidence(candidate, newer, "not_proposed", null, "ambiguous_accounts");
  item = byCard((await review()).items).get(MYJCB)!;
  expect(item.stated).toMatchObject({
    status: "not_named",
    latest: { accounts: [], reasons: ["ambiguous_accounts"], visibleDigitCount: null },
    lastNamed: { observedAt: "2098-01-12T00:00:00Z" },
  });
  expect(item.answer).toMatchObject({
    basis: "provider-stated",
    account: { bankSourceAccount: BANK },
    codes: ["newer_reading_unresolved"],
  });
});

test("an accepted settlement answers a card without a stated account, until it is withdrawn", async () => {
  await ownership(811, "liable_party");
  await ownership(820, "beneficial_owner");
  await cardSettlementSweep(db);
  const accepted = await candidateOf("vpass:card-001");
  await command("card-settlement.accept", { proposalId: accepted, reason: "synthetic" });
  const before = await rowCounts();
  let item = byCard((await review()).items).get("vpass:card-001")!;
  expect(item.answer).toEqual({
    basis: "accepted-settlement",
    account: { bankSourceId: "smbc-bank", bankSourceAccount: BANK },
    proposalId: accepted,
    debitDate: "2098-01-27",
    codes: [],
  });
  expect(item.settled).toHaveLength(1);
  // The accepted statement's other, undecided candidate is no longer listed.
  expect(item.proposed).toEqual([]);
  expect(await rowCounts()).toEqual(before);
  await command("card-settlement.withdraw", { proposalId: accepted, reason: "synthetic" });
  item = byCard((await review()).items).get("vpass:card-001")!;
  expect(item.settled).toEqual([]);
  expect(item.answer).toEqual({ basis: "unknown", reason: "only_unreviewed_candidates" });
});

test("a reading that names two accounts is conflicting and never chosen; a later single one is", async () => {
  const [candidate, other] = await candidatesOf(MYJCB);
  expect(other).toBeDefined();
  await seedArtifact(env, 830, "myjcb", "synthetic", "synthetic-830", { id: 830 });
  const both = await reading(830, "2098-02-15T00:00:00Z");
  // Two different candidates were given two different accounts by one reading.
  await evidence(candidate!, both, "supports", BANK);
  await evidence(other!, both, "names_other_account", OTHER_BANK);
  let item = byCard((await review()).items).get(MYJCB)!;
  expect(item.stated).toMatchObject({
    status: "conflicting",
    latest: {
      accounts: [
        { bankSourceId: "smbc-bank", bankSourceAccount: BANK },
        { bankSourceId: "smbc-bank", bankSourceAccount: OTHER_BANK },
      ],
      visibleDigitCount: 4,
    },
    lastNamed: { observedAt: "2098-01-12T00:00:00Z" },
  });
  expect(item.answer).toMatchObject({
    basis: "provider-stated",
    account: { bankSourceAccount: BANK },
    observedAt: "2098-01-12T00:00:00Z",
    codes: ["newer_reading_unresolved"],
  });
  await seedArtifact(env, 831, "myjcb", "synthetic", "synthetic-831", { id: 831 });
  const single = await reading(831, "2098-02-16T00:00:00Z");
  await evidence(candidate!, single, "names_other_account", OTHER_BANK);
  item = byCard((await review()).items).get(MYJCB)!;
  expect(item.stated.status).toBe("named");
  expect(item.answer).toMatchObject({
    basis: "provider-stated",
    account: { bankSourceAccount: OTHER_BANK },
    observedAt: "2098-02-16T00:00:00Z",
    codes: [],
  });
});

test("only a candidate's newest row for a reading counts: a changed outcome replaces the old one", async () => {
  const candidate = await candidateOf(MYJCB);
  await seedArtifact(env, 832, "myjcb", "synthetic", "synthetic-832", { id: 832 });
  const page = await reading(832, "2098-02-20T00:00:00Z");
  await evidence(candidate, page, "supports", BANK);
  // The sweep appends a row when the outcome changes; the older row is no
  // longer what the rule says about this candidate and reading.
  await evidence(candidate, page, "not_proposed", null, "ambiguous_accounts");
  let item = byCard((await review()).items).get(MYJCB)!;
  expect(item.stated).toMatchObject({
    status: "not_named",
    latest: { observedAt: "2098-02-20T00:00:00Z", accounts: [], reasons: ["ambiguous_accounts"] },
    lastNamed: { observedAt: "2098-02-16T00:00:00Z" },
  });
  expect(item.answer).toMatchObject({
    basis: "provider-stated",
    account: { bankSourceAccount: OTHER_BANK },
    observedAt: "2098-02-16T00:00:00Z",
    codes: ["newer_reading_unresolved"],
  });
  // One candidate whose outcome moved from one account to another names one
  // account, not two.
  await evidence(candidate, page, "supports", BANK);
  await evidence(candidate, page, "names_other_account", OTHER_BANK);
  item = byCard((await review()).items).get(MYJCB)!;
  expect(item.stated).toMatchObject({
    status: "named",
    latest: {
      observedAt: "2098-02-20T00:00:00Z",
      accounts: [{ bankSourceId: "smbc-bank", bankSourceAccount: OTHER_BANK }],
    },
  });
  expect(item.answer).toMatchObject({
    basis: "provider-stated",
    account: { bankSourceAccount: OTHER_BANK },
    observedAt: "2098-02-20T00:00:00Z",
    codes: [],
  });
});

test("a card month settled under one card ordinal is not proposed again under the next", async () => {
  // The acceptance guard reserves a card month by (source, account, period),
  // whatever the statement key (migration 0044, `allocation_available`). A
  // new ordinal of the same card is a new source account and so a new
  // statement key: its candidate for an accepted month is never acceptable,
  // and is not listed as an open proposal.
  await ownership(812, "liable_party");
  await cardSettlementSweep(db);
  const accepted = await candidateOf("vpass:card-002");
  await command("card-settlement.accept", { proposalId: accepted, reason: "synthetic" });
  // The provider re-reads the same month under a new ordinal, which the
  // identity rule resolves to the same card account.
  await seedStatement([
    815,
    "vpass",
    "vpass-statement-page",
    "vpass:card-005",
    "2098-01",
    "4000",
    "2098-01-26",
  ]);
  await publishParse(db, 815);
  await identifyParse(
    db,
    {
      id: 815,
      artifact_id: 815,
      source_id: "vpass",
      producer_id: "collector-r2-importer",
      fetch_run_id: 815,
    },
    (input) => resolver({ ...input, sourceAccount: "vpass:card-002" }),
  );
  await cardSettlementSweep(db);
  const reproposed = await candidateOf("vpass:card-005");
  const month = (id: string) =>
    db
      .prepare(
        `SELECT statement_key,json_extract(facts_json,'$.statement.sourceId') AS source,
          json_extract(facts_json,'$.statement.accountId') AS account,
          json_extract(facts_json,'$.statement.period') AS period
         FROM card_settlement_candidates WHERE id=?`,
      )
      .bind(id)
      .first<{ statement_key: string; source: string; account: string; period: string }>();
  const settledMonth = (await month(accepted))!;
  const reproposedMonth = (await month(reproposed))!;
  expect(reproposedMonth.statement_key).not.toBe(settledMonth.statement_key);
  expect({ ...reproposedMonth, statement_key: null }).toEqual({
    ...settledMonth,
    statement_key: null,
  });
  // The guard refuses it for the reserved month alone: every other readiness
  // flag holds, and the command layer's own plan refuses the acceptance.
  expect(
    await db
      .prepare(
        "SELECT statement_current,bank_current,ownership_current,allocation_available FROM card_settlement_readiness WHERE id=?",
      )
      .bind(reproposed)
      .first(),
  ).toEqual({
    statement_current: 1,
    bank_current: 1,
    ownership_current: 1,
    allocation_available: 0,
  });
  expect(
    await createPlan(
      "card-settlement.accept",
      { proposalId: reproposed, reason: "synthetic" },
      { actor, baseContextId: "identity-current-v1", now, ttlSeconds: 600 },
      d1CommandStore(db),
    ),
  ).toMatchObject({ ok: false, error: "stale_context" });
  const before = await rowCounts();
  const cards = byCard((await review()).items);
  expect(await rowCounts()).toEqual(before);
  expect(cards.get("vpass:card-002")).toMatchObject({
    settled: [{ statements: 1, latest: { proposalId: accepted } }],
    proposed: [],
    answer: { basis: "accepted-settlement", proposalId: accepted },
  });
  // The new ordinal's entry lists its statement, and no open proposal.
  expect(cards.get("vpass:card-005")).toMatchObject({
    latestStatement: { period: "2098-01" },
    settled: [],
    proposed: [],
    answer: { basis: "unknown", reason: "no_debit_account_evidence" },
  });
});

test("a grant without records.read or the whole store is refused before anything is read", async () => {
  for (const [grant, code, refs] of [
    [{ ...WHOLE, capabilities: ["summary.read"] }, "unauthorized", ["capability:records.read"]],
    [
      { ...WHOLE, scopes: { sources: "*", accounts: ["acct"] } },
      "evidence_restricted",
      ["scope:account"],
    ],
    [
      { ...WHOLE, budget: { ...WHOLE.budget, maxRows: 99 } },
      "budget_exceeded",
      ["budget:maxRows=99"],
    ],
  ] as const) {
    const outcome = await reviewCardDebitAccounts({
      grant: grant as Grant,
      sql: {
        all: () => Promise.reject(new Error("read")),
        first: () => Promise.reject(new Error("read")),
      },
    });
    expect(outcome).toMatchObject({ ok: false, error: { code, refs } });
  }
});

test("more cards than the bound are said, never listed as a complete answer", async () => {
  const statement = (n: number) => ({
    id: n,
    parse_run_id: n,
    source_id: "vpass",
    source_account: `vpass:card-${String(n).padStart(3, "0")}`,
    unit_ref: "JPY",
    value_status: "exact",
    coefficient: "0",
    scale: 0,
    payment_date: "2098-01-10",
    as_of: null,
    period: "2098-01",
    account_id: null,
    owner_ref: null,
    evidence_refs_json: null,
  });
  const candidate = (sourceAccount: string) => ({
    status: "proposed",
    card_source_id: "vpass",
    card_source_account: sourceAccount,
    bank_source_id: "smbc-bank",
    bank_source_account: BANK,
    statements: 1,
    latest_key: "2098-01-10\ncs_synthetic",
    latest_period: "2098-01",
  });
  const run = async (statements: number, candidates: string[]) => {
    const limits: unknown[] = [];
    const outcome = await reviewCardDebitAccounts({
      grant: WHOLE,
      sql: {
        all: async <T>(sql: string, binds: readonly unknown[] = []) => {
          if (sql === CARD_DEBIT_ACCOUNT_READINGS_SQL) return [] as T[];
          if (sql === CARD_DEBIT_ACCOUNT_CANDIDATES_SQL)
            return candidates.map(candidate) as unknown as T[];
          limits.push(binds[0]);
          // The statement read honours its bound, as the SQL's LIMIT does.
          return Array.from({ length: Math.min(statements, Number(binds[0])) }, (_, n) =>
            statement(n + 1),
          ) as unknown as T[];
        },
        first: () => Promise.reject(new Error("read")),
      },
    });
    if (!outcome.ok) throw new Error(outcome.error.code);
    expect(limits).toEqual([101]);
    return outcome.review;
  };
  // Exactly the bound: complete.
  let review = await run(100, []);
  expect([review.items.length, review.cardsTruncated]).toEqual([100, false]);
  // One more statement card: the first 100 are listed and the cut is said.
  review = await run(150, ["vpass:card-120"]);
  expect([review.items.length, review.cardsTruncated]).toEqual([100, true]);
  expect(review.items.at(-1)?.card.sourceAccount).toBe("vpass:card-100");
  // A card known only by a candidate beyond the bound is said too.
  review = await run(100, ["vpass:card-999"]);
  expect([review.items.length, review.cardsTruncated]).toEqual([100, true]);
  expect(review.items.some((item) => item.card.sourceAccount === "vpass:card-999")).toBe(false);
  // A candidate-only card before the cut is listed; the last statement card gives way.
  review = await run(150, ["vpass:card-050a"]);
  expect([review.items.length, review.cardsTruncated]).toEqual([100, true]);
  expect(review.items.some((item) => item.card.sourceAccount === "vpass:card-050a")).toBe(true);
  expect(review.items.at(-1)?.card.sourceAccount).toBe("vpass:card-099");
});

test("readings, decisions and settled months are reached by key, without table statistics", async () => {
  // docs/card-settlements.md, Cost: the evidence and the candidates are each
  // scanned once; a reading and a candidate's latest decision are keyed, and
  // a proposal probes the settled months through an index, never a scan.
  for (const [name, sql, binds] of [
    [
      "readings",
      CARD_DEBIT_ACCOUNT_READINGS_SQL,
      [CARD_DEBIT_ACCOUNT_POLICY, CARD_INFORMATION_READER_VERSION],
    ],
    ["candidates", CARD_DEBIT_ACCOUNT_CANDIDATES_SQL, []],
  ] as const) {
    const plan = (
      await db
        .prepare("EXPLAIN QUERY PLAN " + sql)
        .bind(...binds)
        .all<{ detail: string }>()
    ).results.map((row) => row.detail);
    expect({
      name,
      scans: plan.filter((detail) =>
        /^SCAN (s|card_debit_account_statement|card_settlement_decisions|d|latest|m|settled_month)\b/u.test(
          detail,
        ),
      ),
    }).toEqual({ name, scans: [] });
    if (name === "candidates")
      expect(plan).toContain(
        "SEARCH m USING AUTOMATIC COVERING INDEX (card_source_id=? AND card_account_id=? AND period=?)",
      );
  }
});

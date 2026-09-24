// Card purchase recognition end to end (src/card-purchase-job.ts): Vpass and
// MyJCB usage rows produced by the deployed parsers, published and identified
// the way the pipeline does it, read through the shared current-usage SQL and
// written through the guarded 0047 batch, on the real CORE schema in
// Miniflare (card-purchase-world.ts). Every card, amount, merchant and token
// here is synthetic.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CARD_PURCHASE_ACTOR,
  cardPurchaseEventId,
  cardPurchaseRevision,
  classifyCardUsage,
  recognitionKey,
  validCardPurchaseFacts,
  type CardPurchaseDraft,
} from "../../../packages/domain/src/card-purchase.ts";
import { validSourceFactRef } from "../../../packages/domain/src/events.ts";
import type { Observation } from "../../../packages/parsers/src/types.ts";
import type { CurrentCardUsageRow } from "../../../packages/read-model/src/card-usage.ts";
import { smbcDirectTransactions } from "../../../packages/parsers/src/parsers/smbc-direct.ts";
import {
  approve,
  commit,
  createPlan,
  d1CommandStore,
  type ChangeKind,
  type Principal,
} from "../../../packages/application/src/index.ts";
import { cardPurchaseRecognitionWrites } from "../../../packages/storage-d1/src/atomic/card-purchase-recognition.ts";
import {
  cardPurchaseSweep,
  cardUsageFactOf,
  purchaseRecognitionEnabled,
  type CardPurchaseSweepOptions,
  type CardPurchaseSweepResult,
} from "../src/card-purchase-job.ts";
import { cardSettlementSweep } from "../src/card-settlement-job.ts";
import { changeMutationPlanners } from "../src/change-commands.ts";
import { identifyParse, reviseIdentity } from "../src/identity-store.ts";
import { runScheduled } from "../src/worker.ts";
import { publishParse, seedArtifact } from "./harness.ts";
import {
  disposeWorlds,
  meta,
  NOW,
  PRODUCER,
  providerLocal,
  TOKEN_A,
  TOKEN_B,
  world,
  type UsageRow,
  type World,
} from "./card-purchase-world.ts";

afterEach(disposeWorlds);

function counts(result: CardPurchaseSweepResult) {
  return {
    recognized: result.recognized,
    revised: result.revised,
    reanchored: result.reanchored,
    retired: result.retired,
    conflicts: result.conflicts,
    failed: result.failed,
  };
}
const NOTHING = { recognized: 0, revised: 0, reanchored: 0, retired: 0, conflicts: 0, failed: 0 };

/** A recognition draft of one current row under a chosen event id, as a racing writer would plan it. */
async function draftFor(row: CurrentCardUsageRow, eventId?: string): Promise<CardPurchaseDraft> {
  const fact = cardUsageFactOf(row);
  const classified = classifyCardUsage(fact);
  if (!classified.ok) throw new Error(classified.reasonCode);
  const draft = await cardPurchaseRevision({
    action: "recognize",
    eventId: eventId ?? (await cardPurchaseEventId(classified.kind, recognitionKey(fact)!)),
    revision: 1,
    fact,
  });
  if (!draft) throw new Error("draft rejected");
  return draft;
}

async function run(db: D1Database, draft: CardPurchaseDraft, sql?: (text: string) => string) {
  const writes = cardPurchaseRecognitionWrites({ draft, expectedRevision: null, now: NOW });
  const results = await db.batch(
    writes.map((write, index) =>
      db.prepare(index === 0 && sql ? sql(write.sql) : write.sql).bind(...write.binds),
    ),
  );
  return results.map((result) => result.meta.changes);
}

const POSTED: UsageRow = {
  date: "26/05/03",
  merchant: "架空店舗A",
  amount: "1,234",
  paymentType: "1回払い",
};

const DEFAULT_STAGES = {
  parse: () => Promise.resolve({ parsed: 0 }),
  identity: () => Promise.resolve({ processedRuns: 0 }),
  balanceProjection: () => Promise.resolve({ enabled: false, status: "skipped" }),
  purchases: (target: Env) => cardPurchaseSweep(target.DB, { now: NOW }),
};

// ---------------------------------------------------------------------------

test("flag off: the lane is not run and nothing is written; only 1 or true turns it on", async () => {
  const w = await world();
  await w.vpass({ family: "web", fetchedAt: "2026-06-10T00:00:00.000Z", rows: [POSTED] });
  for (const value of [undefined, "", "0", "false", "TRUE", "yes"])
    expect(purchaseRecognitionEnabled(value)).toBe(false);
  expect(purchaseRecognitionEnabled("1")).toBe(true);
  expect(purchaseRecognitionEnabled("true")).toBe(true);
  const lines: Record<string, unknown>[] = [];
  const log = (line: string) => lines.push(JSON.parse(line));
  const before = await w.snapshot();
  for (const flag of [undefined, "0", "false"]) {
    await runScheduled(
      { ...w.env, PURCHASE_RECOGNITION_ENABLED: flag } as unknown as Env,
      DEFAULT_STAGES,
      log,
    );
    expect(lines.map((line) => line.event)).toEqual([
      "observation_sweep",
      "identity_sweep",
      "balance_projection",
    ]);
    lines.length = 0;
  }
  expect(await w.snapshot()).toEqual(before);
  expect(await w.cursor()).toBe(0);
  // The committed configuration turns the lane on (production since
  // 2026-09-24); the rollback is setting it back to "0".
  expect(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")).toContain(
    '"PURCHASE_RECOGNITION_ENABLED": "true"',
  );
  await runScheduled(
    { ...w.env, PURCHASE_RECOGNITION_ENABLED: "1" } as unknown as Env,
    DEFAULT_STAGES,
    log,
  );
  expect(lines.map((line) => line.event)).toEqual([
    "observation_sweep",
    "identity_sweep",
    "balance_projection",
    "purchase_recognition",
  ]);
  expect(lines[3]).toMatchObject({ event: "purchase_recognition", recognized: 1 });
}, 60_000);

test("a posted single-payment Vpass row is one captured purchase with a rule decision; the second sweep writes nothing", async () => {
  const w = await world();
  const capture = await w.vpass({
    family: "web",
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: [
      POSTED,
      { date: "26/05/05", merchant: "架空店舗B", amount: "5,000", paymentType: "2回払い" },
    ],
  });
  const first = await w.sweep();
  expect(first).toEqual({
    scanned: 2,
    recognized: 1,
    revised: 0,
    reanchored: 0,
    retired: 0,
    skipped: { payment_type_unsupported: 1 },
    conflicts: 0,
    failed: 0,
    deferred: false,
    proposed: 0,
    merged: 0,
    groupsSkipped: 0,
  });
  const [observation] = capture.observations;
  const [event] = await w.all<Record<string, any>>("SELECT * FROM economic_event_revisions");
  const [row] = (await w.usage()).filter((entry) => entry.observation_id === observation);
  expect(event).toMatchObject({
    event_id: await cardPurchaseEventId("purchase", JSON.parse(row!.recognition_key!)),
    revision: 1,
    kind: "purchase",
    state: "captured",
    unknown_reason: null,
    basis: "purchase-recognition",
    superseded_by: null,
  });
  expect(JSON.parse(event!["effective_time_json"])).toEqual({
    kind: "local-date",
    value: "2026-05-03",
    zone: "Asia/Tokyo",
    basis: "provider",
  });
  // Evidence is SourceFactRef objects, pinned to the published parse run.
  const evidence: unknown[] = JSON.parse(event!["evidence_support_json"]);
  expect(evidence).toEqual([
    {
      kind: "transaction",
      id: `transaction:${observation}`,
      revision: `parse_run:${capture.parse}`,
    },
  ]);
  expect(evidence.every(validSourceFactRef)).toBe(true);
  // Exactly one purchase-recognition leg on the resolved card account; no cash leg.
  expect(
    await w.all(
      "SELECT subject_ref,unit_ref,value_status,coefficient,scale,role,basis FROM economic_legs",
    ),
  ).toEqual([
    {
      subject_ref: `account:${row!.account_id}`,
      unit_ref: "JPY",
      value_status: "exact",
      coefficient: "1234",
      scale: 0,
      role: "decrease",
      basis: "purchase-recognition",
    },
  ]);
  // The rule decision: method rule, the policy's actor, no operation, codes only.
  const [decision] = await w.all<Record<string, any>>(
    "SELECT * FROM decision_revisions WHERE id=?",
    event!["decision_revision_id"],
  );
  expect(decision).toMatchObject({
    subject_kind: "relation",
    subject_ref: `event:${event!["event_id"]}`,
    revision: 1,
    decision_kind: "accept",
    method: "rule",
    actor_id: CARD_PURCHASE_ACTOR,
    operation_id: null,
    reason: "card-purchase-recognition-v1:recognize",
    previous_revision: null,
  });
  expect(CARD_PURCHASE_ACTOR).toBe("rule:card-purchase-recognition-v1");
  // No provider text anywhere recognition wrote.
  const [sidecar] = await w.all<Record<string, any>>("SELECT * FROM card_purchase_recognitions");
  expect(sidecar).toMatchObject({
    action: "recognize",
    source_id: "vpass",
    statement_period: "2026-05",
  });
  expect(validCardPurchaseFacts(JSON.parse(sidecar!["facts_json"]))).toBe(true);
  expect(JSON.stringify(await w.snapshot())).not.toMatch(/架空|回払い/u);
  expect(await w.totals()).toEqual({
    captured: "1234",
    authorized: "0",
    capturedRefunds: "0",
    authorizedRefunds: "0",
    unresolved: 0,
  });
  // Replaying the whole sweep over the same rows writes nothing at all.
  const before = await w.snapshot();
  const second = await w.sweep();
  expect(counts(second)).toEqual(NOTHING);
  expect(second.skipped).toEqual({ payment_type_unsupported: 1 });
  expect(await w.snapshot()).toEqual(before);
}, 60_000);

test("a re-fetch of the same month (new artifact, same external ids) creates no revision", async () => {
  const w = await world();
  const first = await w.vpass({
    family: "web",
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: [POSTED],
  });
  expect((await w.sweep()).recognized).toBe(1);
  const before = await w.snapshot();
  const refetch = await w.vpass({
    family: "web",
    fetchedAt: "2026-06-20T00:00:00.000Z",
    rows: [POSTED],
  });
  // The newer capture's row is the current one, under the same key.
  const [row] = await w.usage();
  expect(row!.observation_id).toBe(refetch.observations[0]!);
  expect(counts(await w.sweep())).toEqual(NOTHING);
  expect(await w.snapshot()).toEqual(before);
  // The live key still pins the row it was recognised from; content, not ids, is identity.
  expect(await w.all("SELECT revision,observation_id FROM current_card_purchase_keys")).toEqual([
    { revision: 1, observation_id: first.observations[0]! },
  ]);
}, 60_000);

test("customized → authorized; the web snapshot of the month → captured posted events, pending retired with no legs", async () => {
  const w = await world();
  await w.vpass({
    family: "customized",
    fetchedAt: "2026-05-10T00:00:00.000Z",
    rows: [
      { date: "26/05/03", merchant: "架空店舗A", amount: "1,200", paymentType: "1回払い" },
      { date: "26/05/04", merchant: "架空返金A", amount: "-1,500", paymentType: "1回払い" },
    ],
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 2 });
  expect(await w.totals()).toEqual({
    captured: "0",
    authorized: "1200",
    capturedRefunds: "0",
    authorizedRefunds: "1500",
    unresolved: 0,
  });
  expect(
    await w.all(
      "SELECT kind,state,role FROM current_card_purchase_recognitions JOIN current_card_purchase_keys USING(event_id,revision) ORDER BY kind",
    ),
  ).toEqual([
    { kind: "purchase", state: "authorized", role: "pending" },
    { kind: "refund", state: "authorized", role: "pending" },
  ]);

  await w.vpass({
    family: "web",
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: [
      POSTED,
      { date: "26/05/06", merchant: "架空店舗C", amount: "700", paymentType: "1回払い" },
    ],
  });
  const flipped = await w.sweep();
  expect(counts(flipped)).toEqual({ ...NOTHING, recognized: 2, retired: 2 });
  // Pending events are retired, not cancelled or refunded: unknown, no legs.
  const retired = await w.all<Record<string, any>>(
    "SELECT event_id,revision,state,unknown_reason FROM current_economic_events WHERE state='unknown' ORDER BY event_id",
  );
  expect(retired).toHaveLength(2);
  for (const event of retired) {
    expect(event).toMatchObject({ revision: 2, unknown_reason: "provider_status_absent" });
    expect(
      await w.count(
        "SELECT count(*) AS n FROM economic_legs WHERE event_id=? AND revision=2",
        event["event_id"],
      ),
    ).toBe(0);
  }
  // The live purchase-recognition legs are exactly the posted amounts.
  expect(
    await w.all(
      `SELECT l.coefficient,l.role FROM economic_legs l JOIN current_economic_events e
       ON e.event_id=l.event_id AND e.revision=l.revision WHERE l.basis='purchase-recognition' ORDER BY l.coefficient`,
    ),
  ).toEqual([
    { coefficient: "1234", role: "decrease" },
    { coefficient: "700", role: "decrease" },
  ]);
  expect(await w.totals()).toEqual({
    captured: "1934",
    authorized: "0",
    capturedRefunds: "0",
    authorizedRefunds: "0",
    unresolved: 2,
  });
  expect(counts(await w.sweep())).toEqual(NOTHING);
}, 60_000);

test("MyJCB: usage equal to payment is captured; the installment slice is skipped and writes nothing", async () => {
  const w = await world();
  await w.myjcb({
    state: "confirmed",
    period: "2026年6月お支払い分",
    fetchedAt: "2026-05-12T00:00:00.000Z",
    rows: [
      {
        date: "2026/04/20",
        merchant: "架空店舗G",
        amount: "1,000",
        paymentType: "1回払い",
        other: "1,000",
      },
      // A single payment whose usage total differs from this statement's payment.
      {
        date: "2026/04/21",
        merchant: "架空店舗H",
        amount: "4,000",
        paymentType: "1回払い",
        other: "12,000",
        installment: "1",
      },
      {
        date: "2026/04/22",
        merchant: "架空店舗I",
        amount: "3,000",
        paymentType: "分割",
        other: "9,000",
      },
    ],
  });
  await w.myjcb({
    state: "unconfirmed",
    period: "2026年7月お支払い分",
    fetchedAt: "2026-05-12T00:00:00.000Z",
    rows: [{ date: "2026/05/10", merchant: "架空店舗J", amount: "800", paymentType: "1回払い" }],
  });
  const result = await w.sweep();
  expect(result).toMatchObject({
    scanned: 4,
    recognized: 2,
    skipped: { installment_amount_differs: 1, payment_type_unsupported: 1 },
    conflicts: 0,
    failed: 0,
  });
  expect(await w.totals()).toMatchObject({ captured: "1000", authorized: "800" });
  expect(
    await w.all(
      "SELECT source_id,statement_period,json_extract(facts_json,'$.amountCheck') AS amount_check FROM card_purchase_recognitions ORDER BY statement_period",
    ),
  ).toEqual([
    { source_id: "myjcb", statement_period: "2026-06", amount_check: "usage-equals-payment" },
    { source_id: "myjcb", statement_period: "2026-07", amount_check: "usage-equals-payment" },
  ]);
  expect(await w.count("SELECT count(*) AS n FROM economic_event_revisions")).toBe(2);
}, 60_000);

test("an unpublished parse, an unresolved account or a Vpass identity without the card binding recognises nothing", async () => {
  const w = await world();
  const unpublished = await w.vpass({
    family: "web",
    card: "card-001",
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: [POSTED],
    publish: false,
  });
  // Identity has not run for this parse: no account.
  await w.vpass({
    family: "web",
    card: "card-002",
    token: TOKEN_B,
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: [POSTED],
    identify: null,
  });
  // No trusted binding: the deployed resolver maps the ordinal to an unresolved placeholder.
  await w.vpass({
    family: "web",
    card: "card-003",
    token: null,
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: [POSTED],
  });
  // No trusted binding, yet a provider-local account: the identity family is not the binding one.
  await w.vpass({
    family: "web",
    card: "card-004",
    token: null,
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: [POSTED],
    identify: providerLocal,
  });
  const result = await w.sweep();
  expect(result).toMatchObject({
    scanned: 3,
    ...NOTHING,
    skipped: { account_not_resolved: 2, card_identity_unstable: 1 },
  });
  expect(await w.count("SELECT count(*) AS n FROM economic_event_revisions")).toBe(0);
  expect(
    await w.count(
      "SELECT count(*) AS n FROM decision_revisions WHERE actor_id=?",
      CARD_PURCHASE_ACTOR,
    ),
  ).toBe(0);
  // Recognition follows publication: once the parse is adopted, its row is recognised.
  await w.publish(unpublished);
  expect((await w.sweep()).recognized).toBe(1);
}, 60_000);

test("a refund row is its own refund event with an increase leg and no allocation", async () => {
  const w = await world();
  await w.vpass({
    family: "web",
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: [
      POSTED,
      { date: "26/05/04", merchant: "架空返金A", amount: "-1,500", paymentType: "1回払い" },
    ],
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 2 });
  expect(
    await w.all(
      `SELECT e.kind,e.state,l.role,l.coefficient,l.basis FROM current_economic_events e
       JOIN economic_legs l ON l.event_id=e.event_id AND l.revision=e.revision ORDER BY e.kind`,
    ),
  ).toEqual([
    {
      kind: "purchase",
      state: "captured",
      role: "decrease",
      coefficient: "1234",
      basis: "purchase-recognition",
    },
    {
      kind: "refund",
      state: "captured",
      role: "increase",
      coefficient: "1500",
      basis: "purchase-recognition",
    },
  ]);
  expect(
    (
      await w.all<{ event_id: string }>(
        "SELECT event_id FROM current_economic_events WHERE kind='refund'",
      )
    )[0]!.event_id,
  ).toMatch(/^refund_[0-9a-f]{64}$/u);
  // Nothing is allocated: the refund's purchase is not inferred.
  expect(await w.count("SELECT count(*) AS n FROM allocations")).toBe(0);
  expect(await w.totals()).toMatchObject({ captured: "1234", capturedRefunds: "1500" });
}, 60_000);

test("an account-mapping change is revision 2 superseding 1, and revision 1 stays readable", async () => {
  const w = await world();
  await w.vpass({ family: "web", fetchedAt: "2026-06-10T00:00:00.000Z", rows: [POSTED] });
  await w.sweep();
  const [row] = await w.usage();
  const eventId = (
    await w.all<{ event_id: string }>("SELECT event_id FROM economic_event_revisions")
  )[0]!.event_id;
  const mapping = (
    await w.all<{ source_account_id: string; revision: number; account_id: string }>(
      "SELECT source_account_id,revision,account_id FROM current_account_mappings WHERE account_id=?",
      row!.account_id,
    )
  )[0]!;
  await w.db
    .prepare(
      "INSERT INTO accounts(id,label,role,status) VALUES('acct-card-corrected','synthetic','card-statement','identified')",
    )
    .run();
  await reviseIdentity(w.db, {
    kind: "account",
    referenceId: mapping.source_account_id,
    targetId: "acct-card-corrected",
    expectedRevision: mapping.revision,
    reason: "synthetic correction",
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, revised: 1 });
  expect(
    await w.all(
      `SELECT r.revision,r.state,r.superseded_by,l.subject_ref FROM economic_event_revisions r
       JOIN economic_legs l ON l.event_id=r.event_id AND l.revision=r.revision ORDER BY r.revision`,
    ),
  ).toEqual([
    {
      revision: 1,
      state: "captured",
      superseded_by: `${eventId}@2`,
      subject_ref: `account:${mapping.account_id}`,
    },
    {
      revision: 2,
      state: "captured",
      superseded_by: null,
      subject_ref: "account:acct-card-corrected",
    },
  ]);
  expect(
    await w.all(
      "SELECT d.decision_kind,d.previous_revision,d.reason FROM economic_event_revisions r JOIN decision_revisions d ON d.id=r.decision_revision_id WHERE r.revision=2",
    ),
  ).toEqual([
    {
      decision_kind: "supersede",
      previous_revision: 1,
      reason: "card-purchase-recognition-v1:revise",
    },
  ]);
  expect(
    await w.all(
      "SELECT revision,action,account_id FROM card_purchase_recognitions ORDER BY revision",
    ),
  ).toEqual([
    { revision: 1, action: "recognize", account_id: mapping.account_id },
    { revision: 2, action: "revise", account_id: "acct-card-corrected" },
  ]);
  expect(await w.totals()).toMatchObject({ captured: "1234" });
  expect(counts(await w.sweep())).toEqual(NOTHING);
}, 60_000);

test("a published replay of the same artifact re-anchors the event with the same content", async () => {
  const w = await world();
  const capture = await w.vpass({
    family: "web",
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: [POSTED],
  });
  await w.sweep();
  // An unpublished replay changes nothing: the recognised parse is still the adopted one.
  const candidate = await capture.replay({ publish: false });
  expect(counts(await w.sweep())).toEqual(NOTHING);
  // Publishing the replay unpublishes the parse the live evidence cites.
  await w.publish(candidate);
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, reanchored: 1 });
  const sidecars = await w.all<{ revision: number; action: string; content_digest: string }>(
    "SELECT revision,action,content_digest FROM card_purchase_recognitions ORDER BY revision",
  );
  expect(sidecars.map((row) => [row.revision, row.action])).toEqual([
    [1, "recognize"],
    [2, "reanchor"],
  ]);
  expect(sidecars[1]!.content_digest).toBe(sidecars[0]!.content_digest);
  expect(
    await w.all("SELECT revision,observation_id,parse_run_id FROM current_card_purchase_keys"),
  ).toEqual([
    { revision: 2, observation_id: candidate.observations[0]!, parse_run_id: candidate.parse },
  ]);
  expect(await w.totals()).toMatchObject({ captured: "1234", unresolved: 0 });
  expect(counts(await w.sweep())).toEqual(NOTHING);
}, 60_000);

test("the key trigger refuses a second live holder, and a concurrent duplicate batch writes nothing", async () => {
  const w = await world();
  await w.vpass({ family: "web", fetchedAt: "2026-06-10T00:00:00.000Z", rows: [POSTED] });
  const [row] = await w.usage();
  // Two writers planned the same recognition against the same empty state.
  const planned = await draftFor(row!);
  const duplicate = await draftFor(row!);
  expect((await run(w.db, planned)).every((changes) => changes > 0)).toBe(true);
  const before = await w.snapshot();
  expect((await run(w.db, duplicate)).every((changes) => changes === 0)).toBe(true);
  // Another event id claiming the held key writes nothing either.
  const thief = await draftFor(row!, `purchase_${"0".repeat(64)}`);
  expect((await run(w.db, thief)).every((changes) => changes === 0)).toBe(true);
  expect(await w.snapshot()).toEqual(before);
  // Had that batch slipped past its guard, the 0047 trigger aborts it whole.
  const heldCheck =
    /AND NOT EXISTS\(SELECT 1 FROM current_card_purchase_keys k[\s\S]*?json_each\(\?11\)\)\)/u;
  await expect(
    run(w.db, thief, (sql) => sql.replace(heldCheck, "AND ?10 IS NOT NULL AND ?11 IS NOT NULL")),
  ).rejects.toThrow("card_purchase_key_held");
  expect(await w.snapshot()).toEqual(before);
  // The sweep itself finds the key held and the content unchanged.
  expect(counts(await w.sweep())).toEqual(NOTHING);

  // Two sweeps racing over a new row: one event, one decision, one leg.
  await w.vpass({
    family: "web",
    fetchedAt: "2026-06-20T00:00:00.000Z",
    rows: [
      POSTED,
      { date: "26/05/09", merchant: "架空店舗D", amount: "2,500", paymentType: "1回払い" },
    ],
  });
  const raced = await Promise.all([w.sweep(), w.sweep()]);
  expect(raced[0]!.recognized + raced[1]!.recognized).toBe(1);
  expect(raced.every((result) => result.failed === 0)).toBe(true);
  expect(await w.count("SELECT count(*) AS n FROM economic_event_revisions")).toBe(2);
  expect(
    await w.count(
      "SELECT count(*) AS n FROM decision_revisions WHERE actor_id=?",
      CARD_PURCHASE_ACTOR,
    ),
  ).toBe(2);
  expect(await w.totals()).toMatchObject({ captured: "3734" });
}, 60_000);

test("a card ordinal change under one resolved account retires the old events and captures the new ones; the captured total is unchanged", async () => {
  const w = await world();
  const rows: UsageRow[] = [
    POSTED,
    { date: "26/05/07", merchant: "架空店舗E", amount: "2,000", paymentType: "1回払い" },
  ];
  await w.vpass({ family: "web", card: "card-001", fetchedAt: "2026-06-10T00:00:00.000Z", rows });
  await w.sweep();
  const original = await w.totals();
  expect(original).toMatchObject({ captured: "3234", unresolved: 0 });
  // The provider renumbered the card; the trusted binding keeps the same token,
  // so both captures resolve to one account and only the newer one is current.
  await w.vpass({ family: "web", card: "card-002", fetchedAt: "2026-06-20T00:00:00.000Z", rows });
  const accounts = new Set((await w.usage()).map((row) => row.account_id));
  expect(accounts.size).toBe(1);
  expect((await w.usage()).every((row) => row.source_account === "vpass:card-002")).toBe(true);
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 2, retired: 2 });
  expect(await w.totals()).toEqual({ ...original, unresolved: 2 });
  expect(
    await w.all(
      "SELECT state,count(*) AS n FROM current_economic_events GROUP BY state ORDER BY state",
    ),
  ).toEqual([
    { state: "captured", n: 2 },
    { state: "unknown", n: 2 },
  ]);
  expect(counts(await w.sweep())).toEqual(NOTHING);
}, 60_000);

// The card settlement command helpers of card-settlement.test.ts.
const operator: Principal = {
  id: "synthetic-human",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
const COMMAND_NOW = "2098-01-01T00:00:00.000Z";
let operation = 0;
async function command(db: D1Database, kind: ChangeKind, payload: unknown) {
  const store = d1CommandStore(db);
  const planned = await createPlan(
    kind,
    payload,
    { actor: operator, baseContextId: "identity-current-v1", now: COMMAND_NOW, ttlSeconds: 600 },
    store,
  );
  if (!planned.ok) throw new Error("plan " + JSON.stringify(planned));
  const approval = await approve(store, {
    planId: planned.plan.planId,
    planDigest: planned.plan.planDigest,
    actor: operator,
    scope: [],
    ttlSeconds: 600,
    now: COMMAND_NOW,
  });
  if (!approval.ok) throw new Error("approval " + JSON.stringify(approval));
  const result = await commit(store, {
    operationId: "purchase-test-op-" + (operation += 1),
    principal: operator,
    planId: planned.plan.planId,
    approvalId: approval.approval.approvalId,
    planners: changeMutationPlanners(db),
    now: COMMAND_NOW,
  });
  if (!result.ok) throw new Error(JSON.stringify(result));
}

/** A MyJCB statement total and its SMBC bank debit, published, identified and owned by one party. */
async function seedSettlement(w: World): Promise<void> {
  const { db } = w;
  for (const [id, source] of [
    [701, "myjcb"],
    [702, "smbc-bank"],
  ] as const) {
    await seedArtifact(w.env, id, source, "synthetic", "synthetic-" + id, {});
    await db
      .prepare(
        "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,'1','2026-09-12','ok','[]')",
      )
      .bind(
        id,
        id,
        source === "myjcb" ? "myjcb-credit-statement-total" : "smbc-direct-transactions",
      )
      .run();
  }
  await db
    .prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
 VALUES(701,'myjcb:conn-a:root','credit_statement_payment_amount',1000,'1000',0,'JPY','2026-06-01','synthetic-total',?)`)
    .bind(
      JSON.stringify({
        _kogane: {
          period: "2026-06",
          paymentDate: "2026-06-10",
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        },
      }),
    )
    .run();
  const parsed = await smbcDirectTransactions.parse(
    new TextEncoder().encode(
      JSON.stringify({
        range: { start: "2026-06-01", end: "2026-06-30" },
        depositsTotal: 0,
        withdrawalsTotal: 1000,
        transactions: [
          {
            id: "synthetic-provider-debit",
            date: "2026-06-10T00:00:00+09:00",
            amount: 1000,
            balanceAfter: 9000,
            description: "synthetic",
            direction: "debit",
          },
        ],
      }),
    ),
    meta(
      702,
      "smbc-bank",
      "transactions-normalized",
      "transactions/20260601-20260630.normalized.json",
      "2026-06-12T00:00:00.000Z",
      {},
    ),
  );
  for (const row of parsed.observations) {
    if (row.kind !== "transaction") continue;
    await db
      .prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,counterparty,as_of,raw_locator,extra_json)
  VALUES(702,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(
        row.sourceAccount,
        row.externalId ?? null,
        row.status ?? null,
        row.amountMinor ?? null,
        row.amountText ?? null,
        row.amountScale ?? null,
        row.currency ?? null,
        row.counterparty ?? null,
        row.asOf ?? null,
        row.rawLocator,
        JSON.stringify(row.extra),
      )
      .run();
  }
  for (const [id, source] of [
    [701, "myjcb"],
    [702, "smbc-bank"],
  ] as const) {
    await publishParse(db, id);
    await identifyParse(
      db,
      { id, artifact_id: id, source_id: source, producer_id: PRODUCER, fetch_run_id: id },
      providerLocal,
    );
  }
  for (const [parse, relationKind] of [
    [701, "liable_party"],
    [702, "beneficial_owner"],
  ] as const) {
    const [mapping] = await w.all<{ account_id: string }>(
      "SELECT m.account_id FROM current_account_mappings m JOIN current_identity_observations o ON o.source_account_id=m.source_account_id WHERE o.parse_run_id=? LIMIT 1",
      parse,
    );
    await command(db, "relation.accept", {
      relationKind,
      fromRef: "account:" + mapping!.account_id,
      toRef: "party:synthetic-owner",
      validFrom: null,
      validTo: null,
      evidenceRefs: ["synthetic-proof"],
      reason: "Synthetic explicit ownership evidence",
    });
  }
}

test("accepting a card settlement adds no purchase-recognition leg and leaves the captured total unchanged; purchases have no cash leg", async () => {
  const w = await world();
  await w.myjcb({
    state: "confirmed",
    period: "2026年6月お支払い分",
    fetchedAt: "2026-05-12T00:00:00.000Z",
    rows: [
      {
        date: "2026/04/20",
        merchant: "架空店舗G",
        amount: "1,000",
        paymentType: "1回払い",
        other: "1,000",
      },
    ],
  });
  expect((await w.sweep()).recognized).toBe(1);
  const captured = await w.totals();
  const recognitionLegs = () =>
    w.count("SELECT count(*) AS n FROM economic_legs WHERE basis='purchase-recognition'");
  expect(await recognitionLegs()).toBe(1);

  await seedSettlement(w);
  expect(await cardSettlementSweep(w.db)).toMatchObject({ written: 1 });
  const [candidate] = await w.all<{ id: string }>(
    "SELECT id FROM card_settlement_candidates WHERE json_extract(facts_json,'$.ownership')='established-same'",
  );
  await command(w.db, "card-settlement.accept", {
    proposalId: candidate!.id,
    reason: "verified total and bank debit",
  });
  // The settlement is its own event: a cash movement and an unresolved
  // obligation change, and no purchase expense.
  expect(
    await w.all(
      `SELECT DISTINCT l.basis FROM economic_legs l JOIN economic_event_revisions e
       ON e.event_id=l.event_id AND e.revision=l.revision WHERE e.kind='card_settlement' ORDER BY l.basis`,
    ),
  ).toEqual([{ basis: "cash-movement" }, { basis: "obligation-change" }]);
  expect(await recognitionLegs()).toBe(1);
  expect(await w.totals()).toEqual(captured);
  // A purchase moves no cash: no purchase or refund revision has a cash-movement leg.
  expect(
    await w.count(
      `SELECT count(*) AS n FROM economic_legs l JOIN economic_event_revisions e
       ON e.event_id=l.event_id AND e.revision=l.revision
       WHERE e.kind IN ('purchase','refund') AND l.basis<>'purchase-recognition'`,
    ),
  ).toBe(0);
  // And the next sweep has nothing to add.
  expect(counts(await w.sweep())).toEqual(NOTHING);
  expect(await w.totals()).toEqual(captured);
}, 90_000);

test("bounds: the write budget holds the cursor, the last page wraps to 0, and a fully retired full page defers recognition for at most ceil(K / limit) ticks", async () => {
  const w = await world();
  const rows: UsageRow[] = [
    POSTED,
    { date: "26/05/07", merchant: "架空店舗E", amount: "2,000", paymentType: "1回払い" },
    { date: "26/05/08", merchant: "架空店舗F", amount: "300", paymentType: "1回払い" },
  ];
  const capture = await w.vpass({
    family: "web",
    card: "card-001",
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows,
  });
  const [a, b] = capture.observations;
  const limits = { scanLimit: 2, writeLimit: 1 };
  expect(await w.sweep(limits)).toMatchObject({ scanned: 2, recognized: 1 });
  expect(await w.cursor()).toBe(a!);
  expect(await w.sweep(limits)).toMatchObject({ scanned: 2, recognized: 1 });
  expect(await w.cursor()).toBe(b!);
  // The last, short page: the third row, then back to the start.
  expect(await w.sweep(limits)).toMatchObject({ scanned: 1, recognized: 1 });
  expect(await w.cursor()).toBe(0);
  expect(await w.sweep(limits)).toMatchObject({ scanned: 2, ...NOTHING });
  expect(await w.cursor()).toBe(b!);
  expect(await w.sweep(limits)).toMatchObject({ scanned: 1, ...NOTHING });
  expect(await w.cursor()).toBe(0);
  const original = await w.totals();
  expect(original.captured).toBe("3534");

  // A renumbered card: three stale keys, three new ones. With one retirement
  // per tick, every tick retires its whole (full) page, so recognition waits
  // until nothing stale is left and the captured total never exceeds what the
  // provider shows. The wait is bounded: three live keys, one per tick, so at
  // most ceil(3 / 1) = 3 deferred ticks.
  await w.vpass({ family: "web", card: "card-002", fetchedAt: "2026-06-20T00:00:00.000Z", rows });
  const seen: string[] = [];
  for (let tick = 0; tick < 3; tick += 1) {
    const result = await w.sweep({ retireLimit: 1 });
    expect(result).toMatchObject({ retired: 1, recognized: 0, scanned: 0, deferred: true });
    seen.push((await w.totals()).captured);
  }
  // Each tick only lowers the captured total, down to nothing live before the new rows.
  for (const [index, total] of seen.entries())
    expect(BigInt(total) < BigInt(index === 0 ? original.captured : seen[index - 1]!)).toBe(true);
  expect(seen.at(-1)).toBe("0");
  const last = await w.sweep({ retireLimit: 1 });
  expect(last).toMatchObject({ retired: 0, recognized: 3, deferred: false });
  expect(await w.totals()).toEqual({ ...original, unresolved: 3 });
}, 90_000);

test("log lines carry counts only: no amount, merchant, account or identifier", async () => {
  const w = await world();
  await w.vpass({
    family: "web",
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: [
      { date: "26/05/03", merchant: "架空店舗Z", amount: "98,765", paymentType: "1回払い" },
      { date: "26/05/04", merchant: "架空店舗Y", amount: "43,210", paymentType: "リボ" },
    ],
  });
  const lines: string[] = [];
  await runScheduled(
    { ...w.env, PURCHASE_RECOGNITION_ENABLED: "true" } as unknown as Env,
    DEFAULT_STAGES,
    (line) => lines.push(line),
  );
  const line = lines
    .map((entry) => JSON.parse(entry))
    .find((entry) => entry.event === "purchase_recognition");
  expect(line).toEqual({
    event: "purchase_recognition",
    scanned: 2,
    recognized: 1,
    revised: 0,
    reanchored: 0,
    retired: 0,
    skipped: { payment_type_unsupported: 1 },
    conflicts: 0,
    failed: 0,
    deferred: false,
    proposed: 0,
    merged: 0,
    groupsSkipped: 0,
  });
  // The tick is recorded (migration 0048) with exactly the counts of that
  // line, so "did the lane run, and what did it do?" no longer needs the logs.
  const ticks = await w.env.DB.prepare(
    "SELECT outcome,error_code,counts_json FROM processor_lane_ticks WHERE lane='purchase_recognition'",
  ).all<{ outcome: string; error_code: string | null; counts_json: string }>();
  expect(ticks.results).toHaveLength(1);
  const { event: _event, ...counts } = line;
  expect(ticks.results[0]).toMatchObject({ outcome: "ran", error_code: null });
  expect(JSON.parse(ticks.results[0]!.counts_json)).toEqual(counts);
  const stored = await w.env.DB.prepare(
    "SELECT group_concat(counts_json,char(10)) AS text FROM processor_lane_ticks",
  ).first<string>("text");
  const text = `${lines.join("\n")}\n${stored}`;
  const [row] = await w.usage();
  for (const secret of [
    "98765",
    "98,765",
    "43210",
    "架空",
    "リボ",
    "回払い",
    "card-001",
    TOKEN_A,
    row!.account_id!,
    "vpass:",
  ])
    expect(text).not.toContain(secret);
  // No event id or recognition key either.
  expect(text).not.toMatch(/(?:purchase|refund)_[0-9a-f]{64}/u);
}, 60_000);

test("keys with slashes, plus signs, full-width, escaped and control characters match SQLite's json_array, so every holder is found again", async () => {
  const w = await world();
  // Every character class an external id or a namespace could carry: the
  // 0047 guard and current usage derive the key with SQLite's json_array, the
  // writer with JSON.stringify, and the holder lookup decodes it with json_each.
  const odd = [
    "a/b+c=",
    "全角＋／＃ｶﾅ",
    'q"uote\\back',
    "lit\\u00e9 é😀",
    "ctl\u0001\u001f\u007f",
    "tab\tnl\nlf\r",
    "ls ps ",
  ];
  let next = 0;
  const rewrite = (row: Observation): Observation =>
    row.kind === "transaction" && row.externalId
      ? { ...row, externalId: `${row.externalId}|${odd[next++ % odd.length]}` }
      : row;
  const vpassRows = odd.map((_, index): UsageRow => ({
    date: `26/05/${String(index + 1).padStart(2, "0")}`,
    merchant: `架空店舗${index}`,
    amount: `${index + 1},000`,
    paymentType: "1回払い",
  }));
  await w.vpass({
    family: "web",
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: vpassRows,
    rewrite,
  });
  await w.myjcb({
    state: "confirmed",
    period: "2026年6月お支払い分",
    fetchedAt: "2026-05-12T00:00:00.000Z",
    namespace: 'ns/＋"\\\u0001é',
    rows: [{ date: "2026/04/20", merchant: "架空店舗G", amount: "1,000", paymentType: "1回払い" }],
    rewrite,
  });
  const rows = await w.usage();
  expect(rows).toHaveLength(odd.length + 1);
  for (const row of rows)
    expect(JSON.stringify(recognitionKey(cardUsageFactOf(row)))).toBe(row.recognition_key!);
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: odd.length + 1 });
  expect(
    (
      await w.all<{ recognition_key: string }>(
        "SELECT recognition_key FROM current_card_purchase_keys",
      )
    )
      .map((row) => row.recognition_key)
      .sort(),
  ).toEqual(rows.map((row) => row.recognition_key!).sort());
  // A key the holder lookup failed to find would be planned as a second
  // recognition, which the guard refuses: a conflict, not NOTHING.
  const before = await w.snapshot();
  expect(counts(await w.sweep())).toEqual(NOTHING);
  expect(await w.snapshot()).toEqual(before);
}, 60_000);

test("keys the retire pass cannot retire never hold recognition back", async () => {
  const w = await world();
  const other: UsageRow = {
    date: "26/05/07",
    merchant: "架空店舗E",
    amount: "2,000",
    paymentType: "1回払い",
  };
  await w.vpass({ family: "web", fetchedAt: "2026-06-10T00:00:00.000Z", rows: [POSTED, other] });
  expect(await w.sweep()).toMatchObject({ recognized: 2, conflicts: 0, deferred: false });
  const [blocked] = (
    await w.all<{ event_id: string }>(
      "SELECT event_id FROM current_economic_events ORDER BY event_id LIMIT 1",
    )
  ).map((row) => row.event_id);
  // A store whose batches for one event always fail (a D1 error): that
  // event's retirement can never be written. A merged event (several keys)
  // is retired like any other now (card-purchase-merge.test.ts), so a failing
  // batch is the shape of a key this pass cannot retire.
  const bound = new WeakMap<object, unknown[]>();
  const failing = {
    prepare(sql: string) {
      const statement = w.db.prepare(sql);
      return new Proxy(statement, {
        get(target, property) {
          if (property === "bind")
            return (...args: unknown[]) => {
              const result = target.bind(...args);
              bound.set(result, args);
              return result;
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    batch: async (statements: D1PreparedStatement[]) => {
      if (statements.some((entry) => (bound.get(entry) ?? []).includes(`event:${blocked}`)))
        throw new Error("synthetic D1 failure");
      return w.db.batch(statements);
    },
  } as unknown as D1Database;
  const sweep = (options: CardPurchaseSweepOptions) =>
    cardPurchaseSweep(failing, { now: NOW, ...options });

  // A newer capture of the month drops both rows: both events are stale, and
  // two new rows are current.
  await w.vpass({
    family: "web",
    fetchedAt: "2026-06-20T00:00:00.000Z",
    rows: [
      { date: "26/05/09", merchant: "架空店舗D", amount: "2,500", paymentType: "1回払い" },
      { date: "26/05/10", merchant: "架空店舗F", amount: "300", paymentType: "1回払い" },
    ],
  });
  // The page is full (both stale keys), one event is retired and the other's
  // batch fails: the page was not retired whole, so recognition runs in the
  // same tick.
  expect(await sweep({ retireLimit: 2 })).toMatchObject({
    retired: 1,
    failed: 1,
    recognized: 2,
    deferred: false,
  });
  // Only the blocked event is left on the page, tick after tick, and it never
  // defers recognition.
  for (let tick = 0; tick < 2; tick += 1)
    expect(counts(await sweep({ retireLimit: 1 }))).toEqual({ ...NOTHING, failed: 1 });
  expect(await w.totals()).toMatchObject({ unresolved: 1 });
}, 60_000);

test("cursor: an exactly full last page wraps on the next tick, a row below the cursor is reached after the wrap, and an overlapping tick's move is kept", async () => {
  const w = await world();
  // Captured first, published later: its row has the lowest observation id.
  const late = await w.vpass({
    family: "web",
    card: "card-002",
    token: TOKEN_B,
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: [{ date: "26/05/02", merchant: "架空店舗L", amount: "400", paymentType: "1回払い" }],
    publish: false,
  });
  const capture = await w.vpass({
    family: "web",
    fetchedAt: "2026-06-10T00:00:00.000Z",
    rows: [
      POSTED,
      { date: "26/05/07", merchant: "架空店舗E", amount: "2,000", paymentType: "1回払い" },
    ],
  });
  const [a, b] = capture.observations;
  expect(late.observations[0]!).toBeLessThan(a!);
  const limits = { scanLimit: 2 };
  // Exactly one full page: the cursor stops at its last row...
  expect(await w.sweep(limits)).toMatchObject({ scanned: 2, recognized: 2 });
  expect(await w.cursor()).toBe(b!);
  // ...and the next tick finds an empty page and wraps.
  expect(await w.sweep(limits)).toMatchObject({ scanned: 0, ...NOTHING });
  expect(await w.cursor()).toBe(0);
  expect(await w.sweep(limits)).toMatchObject({ scanned: 2, ...NOTHING });
  expect(await w.cursor()).toBe(b!);

  // A row below the cursor becomes current: it is not skipped, only reached
  // after the wrap, and each row is written once.
  await w.publish(late);
  expect(await w.sweep(limits)).toMatchObject({ scanned: 0, ...NOTHING });
  expect(await w.cursor()).toBe(0);
  expect(await w.sweep(limits)).toMatchObject({ scanned: 2, recognized: 1 });
  expect(await w.cursor()).toBe(a!);
  expect(await w.sweep(limits)).toMatchObject({ scanned: 1, ...NOTHING });
  expect(await w.cursor()).toBe(0);
  expect(await w.count("SELECT count(*) AS n FROM economic_event_revisions")).toBe(3);

  // An overlapping tick moves the cursor after this tick read it: this tick's
  // own update is conditional on the value it read, so it leaves that move.
  const moved = late.observations[0]!;
  const overlapping = {
    prepare(sql: string) {
      if (!sql.startsWith("SELECT last_observation_id FROM card_purchase_scan_cursor"))
        return w.db.prepare(sql);
      return {
        async first() {
          const read = await w.db.prepare(sql).first();
          await w.db
            .prepare("UPDATE card_purchase_scan_cursor SET last_observation_id=? WHERE singleton=1")
            .bind(moved)
            .run();
          return read;
        },
      };
    },
    batch: (statements: D1PreparedStatement[]) => w.db.batch(statements),
  } as unknown as D1Database;
  expect(await cardPurchaseSweep(overlapping, { now: NOW, ...limits })).toMatchObject({
    scanned: 2,
    ...NOTHING,
  });
  expect(await w.cursor()).toBe(moved);
}, 90_000);

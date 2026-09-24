// MyJCB's relative statement labels in the card purchase lane
// (docs/observations.md, "Relative period labels are resolved from the capture
// time"). The collector keeps `detailMonth-N` verbatim; the lane resolves it
// from the capture time of the ledger artifact that carries it
// (relative-statement-period-v1), so a recognised purchase joins the
// statement the deployed statement parser reads from the same capture, and
// the operator view links 利用 → 請求. Every card, amount, merchant and date
// here is synthetic.
import { afterEach, expect, test } from "bun:test";
import { queryCardPurchases } from "../../../packages/application/src/query/card-purchases.ts";
import {
  cardPurchaseEventId,
  cardPurchaseRevision,
  classifyCardUsage,
  recognitionKey,
} from "../../../packages/domain/src/card-purchase.ts";
import type { SqlExecutor } from "../../../packages/read-model/src/reader.ts";
import { cardPurchaseRecognitionWrites } from "../../../packages/storage-d1/src/atomic/card-purchase-recognition.ts";
import { cardUsageFactOf, type CardPurchaseSweepResult } from "../src/card-purchase-job.ts";
import { disposeWorlds, NOW, world, type UsageRow, type World } from "./card-purchase-world.ts";

afterEach(disposeWorlds);

function counts(result: CardPurchaseSweepResult) {
  return {
    recognized: result.recognized,
    revised: result.revised,
    reanchored: result.reanchored,
    retired: result.retired,
    conflicts: result.conflicts,
    failed: result.failed,
    proposed: result.proposed,
  };
}
const NOTHING = {
  recognized: 0,
  revised: 0,
  reanchored: 0,
  retired: 0,
  conflicts: 0,
  failed: 0,
  proposed: 0,
};

function executor(w: World): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      (
        await w.db
          .prepare(sql)
          .bind(...args)
          .all<T>()
      ).results,
    first: async <T>(sql: string, args: readonly unknown[]) =>
      w.db
        .prepare(sql)
        .bind(...args)
        .first<T>(),
  };
}

/** Each recognition revision's action and stored period, oldest first. */
async function sidecars(w: World) {
  return w.all<{
    revision: number;
    action: string;
    status: string;
    statement_period: string | null;
  }>(
    `SELECT revision,action,json_extract(facts_json,'$.providerStatus') AS status,statement_period
     FROM card_purchase_recognitions ORDER BY event_id,revision`,
  );
}

const ROW: UsageRow = {
  date: "2026/09/10",
  merchant: "架空店舗P",
  amount: "1,000",
  paymentType: "1回払い",
  other: "1,000",
};
/** 2026-09-26 in Tokyo, after the 15th closing: position 0 is paid in 2026-11, position 1 in 2026-10. */
const CAPTURED = "2026-09-26T00:00:00.000Z";

test("a detailMonth-1 row's stored period is its statement's, from the same capture, and the explanation links them", async () => {
  const w = await world();
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-1",
    detailMonth: 1,
    fetchedAt: CAPTURED,
    rows: [ROW],
  });
  // The confirmed page of the same position and capture, read by the deployed
  // statement parser from its own heading and payment date.
  const statement = await w.myjcbStatement({
    fetchedAt: CAPTURED,
    detailMonth: 1,
    period: "detailMonth-1",
    heading: "2026年10月",
    paymentDay: "2026年10月13日(火)",
    total: "1,000",
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 1 });
  const [recognised] = await sidecars(w);
  const facts = await w.all<{ id: number; period: string; payment_date: string }>(
    "SELECT id,period,payment_date FROM card_statement_facts WHERE source_id='myjcb'",
  );
  expect(facts).toEqual([
    { id: statement.observations[0]!, period: "2026-10", payment_date: "2026-10-13" },
  ]);
  expect(recognised).toMatchObject({ action: "recognize", status: "confirmed" });
  expect(recognised!.statement_period).toBe(facts[0]!.period);
  // The stored label is untouched: the resolution is a derivation.
  expect(
    await w.all(
      "SELECT DISTINCT json_extract(extra_json,'$._kogane.period') AS label FROM transaction_observations",
    ),
  ).toEqual([{ label: "detailMonth-1" }]);

  const page = await queryCardPurchases(executor(w));
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({
    sourceId: "myjcb",
    state: "captured",
    statementPeriod: "2026-10",
    statement: {
      status: "linked",
      ref: {
        kind: "balance",
        id: `balance:${statement.observations[0]}`,
        revision: `parse_run:${statement.parse}`,
      },
      period: "2026-10",
      paymentDate: { kind: "local-date", value: "2026-10-13" },
    },
  });
  expect(counts(await w.sweep())).toEqual(NOTHING);
}, 120_000);

test("detailMonth-0 stores its resolved payment month; a position the rule does not place stays unrecognised", async () => {
  const w = await world();
  await w.myjcb({
    state: "unconfirmed",
    period: "detailMonth-0",
    fetchedAt: CAPTURED,
    rows: [{ ...ROW, date: "2026/09/20", merchant: "架空店舗Q", amount: "700", other: "700" }],
  });
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-2",
    detailMonth: 2,
    fetchedAt: CAPTURED,
    rows: [{ ...ROW, date: "2026/08/05", merchant: "架空店舗S", amount: "400", other: "400" }],
  });
  expect(counts(await w.sweep())).toMatchObject({ recognized: 2, conflicts: 0, failed: 0 });
  expect(
    (await sidecars(w))
      .map((row): [string, string | null] => [row.status, row.statement_period])
      .sort(),
  ).toEqual([
    ["confirmed", null],
    ["unconfirmed", "2026-11"],
  ]);
  const page = await queryCardPurchases(executor(w));
  const byStatus = new Map(page.items.map((item) => [item.state, item]));
  expect(byStatus.get("authorized")).toMatchObject({
    statementPeriod: "2026-11",
    statement: { status: "unlinked", reasonCode: "not_posted" },
  });
  expect(byStatus.get("captured")).toMatchObject({
    statementPeriod: null,
    statement: { status: "unlinked", reasonCode: "period_unrecognized" },
  });
}, 120_000);

test("a recognition stored without a period is revised with the resolved one, never rewritten", async () => {
  const w = await world();
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-1",
    detailMonth: 1,
    fetchedAt: CAPTURED,
    rows: [ROW],
  });
  // What the lane wrote before relative labels were resolved: the same row
  // with no capture time to resolve it from, so no statement period.
  const [row] = await w.usage();
  const before = { ...cardUsageFactOf(row!), capturedAt: null };
  const classified = classifyCardUsage(before);
  if (!classified.ok) throw new Error(classified.reasonCode);
  const draft = await cardPurchaseRevision({
    action: "recognize",
    eventId: await cardPurchaseEventId(classified.kind, recognitionKey(before)!),
    revision: 1,
    fact: before,
  });
  expect(draft?.sidecar.statementPeriod).toBeNull();
  const writes = cardPurchaseRecognitionWrites({ draft: draft!, expectedRevision: null, now: NOW });
  await w.db.batch(writes.map((write) => w.db.prepare(write.sql).bind(...write.binds)));

  // The content digest is unchanged (the period is not content), yet the
  // sidecar now has a period to record: one `revise`, append-only.
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, revised: 1 });
  expect(await sidecars(w)).toEqual([
    { revision: 1, action: "recognize", status: "confirmed", statement_period: null },
    { revision: 2, action: "revise", status: "confirmed", statement_period: "2026-10" },
  ]);
  expect(
    await w.count("SELECT count(DISTINCT content_digest) AS n FROM card_purchase_recognitions"),
  ).toBe(1);
  expect(await w.totals()).toMatchObject({ captured: "1000", unresolved: 0 });
  expect(counts(await w.sweep())).toEqual(NOTHING);
}, 120_000);

test("a pending row pairs with its posted row by usage month, and claims one statement only when both resolve to it", async () => {
  const w = await world();
  const matching = {
    ...ROW,
    date: "2026/09/12",
    merchant: "架空店舗T",
    amount: "900",
    other: "900",
  };
  // Captured on 2026-09-14 (JST): position 0 is the cycle paid in 2026-10.
  await w.myjcb({
    state: "unconfirmed",
    period: "detailMonth-0",
    fetchedAt: "2026-09-14T00:00:00.000Z",
    rows: [matching],
  });
  // After the closing the same cycle is position 1 (resolved to 2026-10) ...
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-1",
    detailMonth: 1,
    connection: "conn-a",
    fetchedAt: CAPTURED,
    rows: [matching],
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 2, proposed: 1 });
  const [resolved] = await w.all<{ rationale_codes_json: string }>(
    "SELECT rationale_codes_json FROM reconciliation_proposals",
  );
  expect(JSON.parse(resolved!.rationale_codes_json)).toEqual(
    expect.arrayContaining(["same_statement_period", "date_within_window", "amount_equal"]),
  );
  // A month later the next run lists a newer closed statement at position 1
  // and this one at position 2, which the rule does not place; nothing is
  // pending any more. The earlier captures leave the display (retired), and
  // the pair still meets by usage month, without a statement-period claim.
  await w.myjcb({
    state: "unconfirmed",
    period: "detailMonth-0",
    fetchedAt: "2026-10-26T00:00:00.000Z",
    rows: [],
  });
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-1",
    detailMonth: 1,
    fetchedAt: "2026-10-26T00:00:00.000Z",
    rows: [{ ...ROW, date: "2026/10/01", merchant: "架空店舗U", amount: "300", other: "300" }],
  });
  await w.myjcb({
    state: "confirmed",
    period: "detailMonth-2",
    detailMonth: 2,
    fetchedAt: "2026-10-26T00:00:00.000Z",
    rows: [matching],
  });
  expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 2, retired: 2, proposed: 1 });
  const rationales = (
    await w.all<{ rationale_codes_json: string }>(
      "SELECT rationale_codes_json FROM reconciliation_proposals ORDER BY created_at,id",
    )
  ).map((row) => JSON.parse(row.rationale_codes_json) as string[]);
  expect(rationales).toHaveLength(2);
  expect(rationales.filter((codes) => codes.includes("same_statement_period"))).toHaveLength(1);
  for (const codes of rationales)
    expect(codes).toEqual(expect.arrayContaining(["date_within_window", "amount_equal"]));
  expect(await w.totals()).toMatchObject({ captured: "1200", authorized: "0" });
  expect(counts(await w.sweep())).toEqual(NOTHING);
}, 120_000);

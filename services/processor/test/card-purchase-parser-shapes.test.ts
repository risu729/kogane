// The card purchase recognition contract (packages/domain/src/card-purchase.ts)
// against what the deployed Vpass and MyJCB parsers actually emit for payloads
// in the shapes production rows have (a one-digit Vpass payment-type code,
// full width on the web page and ASCII on the customized one; MyJCB's
// payment type inside the combined ご利用先など／支払区分 cell), rather than
// against hand-written rows. Every row, name and amount here is synthetic.
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import {
  cardPurchaseEventId,
  cardPurchaseRevision,
  classifyCardUsage,
  comparableCardPayment,
  recognitionKey,
  statementPeriod,
  type CardUsageFact,
} from "../../../packages/domain/src/card-purchase.ts";
import { exactQuantity, integerDecimal } from "../../../packages/domain/src/values.ts";
import { myJcbCreditLedger } from "../../../packages/parsers/src/parsers/myjcb.ts";
import { vpassStatementPage } from "../../../packages/parsers/src/parsers/vpass.ts";
import type { ArtifactMeta, TransactionObservation } from "../../../packages/parsers/src/types.ts";

const FIXTURES = new URL("../../../tests/fixtures/observation-pipeline/", import.meta.url);
const bytes = (path: string) => readFileSync(new URL(path, FIXTURES));

function meta(overrides: Partial<ArtifactMeta>): ArtifactMeta {
  return {
    id: 1,
    sourceId: "myjcb",
    runStatus: "success",
    runFailureCount: 0,
    dataset: "credit-ledger",
    url: null,
    mime: "application/json",
    fetchedAt: "2026-09-07T00:01:00.000Z",
    sha256: "0".repeat(64),
    ...overrides,
  };
}

/**
 * The payment type where the read model reads it (packages/read-model/src/
 * card-usage.ts `PAYMENT_TYPE`): Vpass web `data[6]`, Vpass customized
 * `bunkatsuYaku`, MyJCB `summaryCells[1]`. Empty text reads as absent.
 */
function paymentTypeOf(sourceId: string, extra: Record<string, unknown>): string | null {
  const kogane = (extra["_kogane"] ?? {}) as Record<string, unknown>;
  const value =
    sourceId === "myjcb"
      ? (extra["summaryCells"] as unknown[])[1]
      : kogane["statementFamily"] === "web"
        ? (extra["data"] as unknown[])[6]
        : extra["bunkatsuYaku"];
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

/** The read model's view of one parsed row, with identity resolved. */
function factOf(sourceId: string, row: TransactionObservation, index: number): CardUsageFact {
  const kogane = (row.extra["_kogane"] ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof kogane[key] === "string" ? (kogane[key] as string) : null);
  return {
    observationId: index + 1,
    parseRunId: 1,
    sourceId,
    producerId: "card-producer",
    externalIdNamespace: `${sourceId}-namespace-v1`,
    sourceAccount: row.sourceAccount,
    externalId: row.externalId ?? null,
    accountId: `acct-${sourceId}`,
    identityPolicyFamily: sourceId === "vpass" ? "vpass-card-binding" : "identity-default",
    providerStatus: row.status ?? null,
    amount: exactQuantity(row.currency!, integerDecimal(row.amountMinor!), "decimal-v1"),
    usageDate: row.asOf ?? null,
    paymentType: paymentTypeOf(sourceId, row.extra),
    statementPeriod: text("statementMonth") ?? text("period"),
    providerSaleCode: text("providerSaleCode"),
    usageAmountText: text("usageAmountText"),
    paymentAmountText: text("paymentAmountText"),
    newestRepresentation: true,
  };
}

function rows(
  parser: typeof myJcbCreditLedger,
  sourceId: string,
  data: Uint8Array,
  artifact: ArtifactMeta,
): CardUsageFact[] {
  return parser
    .parse(data, artifact)
    .observations.filter((row): row is TransactionObservation => row.kind === "transaction")
    .map((row, index) => factOf(sourceId, row, index));
}

/** Kind, state, magnitude and statement period, or the exclusion reason. */
function outcome(fact: CardUsageFact) {
  const classified = classifyCardUsage(fact);
  return classified.ok
    ? {
        kind: classified.kind,
        state: classified.state,
        amount:
          classified.magnitude.value.status === "exact"
            ? classified.magnitude.value.value.coefficient
            : null,
        period: statementPeriod(fact.statementPeriod),
      }
    : { excluded: classified.reasonCode };
}

function myjcb(file: string, state: string, period: string): CardUsageFact[] {
  return rows(
    myJcbCreditLedger,
    "myjcb",
    bytes(`myjcb/2026-09-07/run-synthetic/connection-a/${file}`),
    meta({ artifactKey: `connection-a/${file}`, statementState: state, period }),
  );
}

/** A MyJCB ledger in the production row shape, parsed by the deployed parser. */
function productionLedger(
  state: "confirmed" | "unconfirmed",
  period: string,
  ledgerRows: { summaryCells: string[]; expanded: Record<string, string> }[],
): CardUsageFact[] {
  const detailMonth = state === "confirmed" ? 2 : 0;
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
    rows: ledgerRows,
  };
  return rows(
    myJcbCreditLedger,
    "myjcb",
    new TextEncoder().encode(JSON.stringify(ledger)),
    meta({
      artifactKey: `connection-a/credit-ledger-0${detailMonth}.json`,
      statementState: state,
      period,
    }),
  );
}

test("MyJCB ledger rows as production shows them: 1回払 in the combined cell and 円 amounts are recognised, the installment slice is not", async () => {
  // Production rows: the merchant and the payment type share summaryCells[1];
  // the cell the parser takes for the payment type holds a two-character label.
  const [pending] = productionLedger("unconfirmed", "2026年9月お支払い分", [
    {
      summaryCells: ["2026/ 09/01", "架空予約 1回払", "架空", "2,000円"],
      expanded: { 今回のお支払い金額: "2,000円", 摘要: "未確定", 今回回数: "1", 備考: "" },
    },
  ]);
  const [purchase, slice, refund] = productionLedger("confirmed", "2026年7月お支払い分", [
    {
      summaryCells: ["2026/06/14", "架空店舗 1回払", "1,000円", "架空"],
      expanded: { ご利用金額: "1,000円", 摘要: "", 今回回数: "1", 備考: "", 訂正サイン: "" },
    },
    {
      summaryCells: ["2026/06/15", "架空家電 分割払い", "400円", "架空"],
      expanded: { ご利用金額: "1,200円", 摘要: "", 今回回数: "2", 備考: "", 訂正サイン: "" },
    },
    {
      summaryCells: ["2026/06/16", "架空返品 1回払", "-500円", "架空"],
      expanded: { ご利用金額: "-500円", 摘要: "取消", 今回回数: "1", 備考: "", 訂正サイン: "" },
    },
  ]);
  // What the read model hands over: the combined cell and display text, not numbers.
  expect([pending!.paymentType, pending!.usageAmountText, pending!.paymentAmountText]).toEqual([
    "架空予約 1回払",
    "2,000円",
    "2,000円",
  ]);
  expect(outcome(purchase!)).toEqual({
    kind: "purchase",
    state: "captured",
    amount: "1000",
    period: "2026-07",
  });
  expect(outcome(pending!)).toEqual({
    kind: "purchase",
    state: "authorized",
    amount: "2000",
    period: "2026-09",
  });
  expect(outcome(slice!)).toEqual({ excluded: "payment_type_unsupported" });
  // A payment type that drifted to look single cannot hide the slice.
  expect(outcome({ ...slice!, paymentType: "架空家電 1回払" })).toEqual({
    excluded: "installment_amount_differs",
  });
  expect(outcome(refund!)).toEqual({
    kind: "refund",
    state: "captured",
    amount: "500",
    period: "2026-07",
  });
  // Every recognised row becomes a valid draft whose sidecar carries the
  // statement's YYYY-MM and none of the provider's text.
  for (const fact of [pending!, purchase!, refund!]) {
    const classified = classifyCardUsage(fact);
    if (!classified.ok) throw new Error("unreachable");
    const draft = await cardPurchaseRevision({
      action: "recognize",
      eventId: await cardPurchaseEventId(classified.kind, recognitionKey(fact)!),
      revision: 1,
      fact,
    });
    expect(draft?.sidecar.statementPeriod).toBe(statementPeriod(fact.statementPeriod));
    expect(JSON.stringify(draft?.sidecar.facts)).not.toMatch(/円|回払|架空/u);
  }
  // Fail-safe on a shape production does not have: the synthetic fixture's
  // rows put 一回払い in a cell of their own and the merchant alone in the
  // combined cell, so nothing there states the payment type and the row is
  // skipped, never guessed from another cell.
  const [legacyPending] = myjcb("credit-ledger-00.json", "unconfirmed", "2026年9月お支払い分");
  expect(legacyPending!.paymentType).toBe("架空予約");
  expect(outcome(legacyPending!)).toEqual({ excluded: "payment_type_unsupported" });
});

test("the reconciliation rule reads MyJCB's display amounts as recognition does", () => {
  // A confirmed, positive, single-payment row in the production shape.
  const [row] = productionLedger("confirmed", "2026年7月お支払い分", [
    {
      summaryCells: ["2026/06/20", "架空店 1回払", "1,000円", "架空"],
      expanded: { ご利用金額: "1,000円", 摘要: "", 今回回数: "1", 備考: "", 訂正サイン: "" },
    },
  ]);
  expect(outcome(row!)).toEqual({
    kind: "purchase",
    state: "captured",
    amount: "1000",
    period: "2026-07",
  });
  const comparable = (fact: CardUsageFact) =>
    comparableCardPayment({
      sourceId: fact.sourceId,
      status: fact.providerStatus,
      usageAmountText: fact.usageAmountText,
      paymentAmountText: fact.paymentAmountText,
    });
  // What the parser hands over is display text, and the pending-to-posted
  // guard reads it with the same grammar recognition uses.
  expect([row!.usageAmountText, row!.paymentAmountText]).toEqual(["1,000円", "1,000円"]);
  expect(comparable(row!)).toBe(true);
  // The guard reads the amount texts, never the payment type, so it holds for
  // the fixture ledgers' rows as well, whatever cell their payment type is
  // in: the installment slice (400円 of 1,200円) and the refund (-500円)
  // never take part in matching; the pending row is not constrained.
  const [slice, refund] = myjcb("credit-ledger-02.json", "confirmed", "2026年7月お支払い分");
  expect([slice!.usageAmountText, slice!.paymentAmountText]).toEqual(["1,200円", "400円"]);
  expect(comparable(slice!)).toBe(false);
  expect(comparable(refund!)).toBe(false);
  const [pending] = myjcb("credit-ledger-00.json", "unconfirmed", "2026年9月お支払い分");
  expect(comparable(pending!)).toBe(true);
});

test("recognition and the matching guard never disagree on a parsed MyJCB row", () => {
  // Every usage/payment text pair below is parsed by the deployed ledger
  // parser, confirmed and unconfirmed, in the production row shape, next to
  // the fixture's own rows. With the payment type held single (the combined
  // cell's 1回払), a confirmed row takes part in pending-to-posted
  // matching exactly when recognition recognises it as a purchase, so no row
  // recognition excludes for its amounts (installment_amount_differs,
  // payment_split_unknown, refund_shape_unverified) is ever compared.
  const exact = ["1,200円", "1200円", "１，２００円", "￥1,200", " 1,200 円", "400円"];
  const signed = ["12,000円", "-500円", "-1,200円", "0円"];
  const unreadable = ["", "円", "1,20円", "1.5円", "01,200円", "1,200ドル"];
  const texts = [...exact, ...signed, ...unreadable];
  const period = "2026年10月お支払い分";
  const parsed = (state: "confirmed" | "unconfirmed", pairs: [string, string | undefined][]) => {
    const detailMonth = state === "confirmed" ? 1 : 0;
    const displayed = state === "confirmed" ? "今回のお支払い金額" : "ご利用金額";
    const other = state === "confirmed" ? "ご利用金額" : "今回のお支払い金額";
    const ledger = {
      schemaVersion: 1,
      detailMonth,
      period,
      state,
      headers: ["ご利用日", "ご利用先など", "支払区分", displayed],
      rows: pairs.map(([cell, text], index) => ({
        summaryCells: ["2026/09/10", `架空店${index} 1回払`, cell, "架空"],
        expanded: { ...(text === undefined ? {} : { [other]: text }), 摘要: "", 備考: "" },
      })),
    };
    return rows(
      myJcbCreditLedger,
      "myjcb",
      new TextEncoder().encode(JSON.stringify(ledger)),
      meta({
        artifactKey: `connection-a/credit-ledger-0${detailMonth}.json`,
        statementState: state,
        period,
      }),
    );
  };
  // The summary cell is the one amount the parser reads as a number, so it is
  // always exact; the expanded text is whatever the provider displayed.
  const cells = [...exact, ...signed];
  const pairs = cells.flatMap((cell) =>
    [...texts, undefined].map((text): [string, string | undefined] => [cell, text]),
  );
  const facts = [
    ...parsed("confirmed", pairs),
    ...parsed("unconfirmed", pairs),
    ...myjcb("credit-ledger-02.json", "confirmed", "2026年7月お支払い分"),
    ...myjcb("credit-ledger-00.json", "unconfirmed", "2026年9月お支払い分"),
  ];
  expect(facts).toHaveLength(pairs.length * 2 + 3);
  const seen = new Set<string>();
  for (const fact of facts) {
    const guard = comparableCardPayment({
      sourceId: fact.sourceId,
      status: fact.providerStatus,
      usageAmountText: fact.usageAmountText,
      paymentAmountText: fact.paymentAmountText,
    });
    const classified = classifyCardUsage({ ...fact, paymentType: "架空店 1回払" });
    const outcome = classified.ok ? classified.kind : classified.reasonCode;
    seen.add(`${fact.providerStatus}:${outcome}`);
    if (fact.providerStatus === "unconfirmed") {
      // A pending row is never constrained by the guard.
      expect(guard).toBe(true);
      continue;
    }
    expect({ outcome, guard }).toEqual({ outcome, guard: outcome === "purchase" });
  }
  // The matrix reaches every amount outcome on the confirmed side.
  for (const outcome of [
    "purchase",
    "refund",
    "amount_zero",
    "installment_amount_differs",
    "payment_split_unknown",
    "refund_shape_unverified",
  ])
    expect(seen).toContain(`confirmed:${outcome}`);
});

test("Vpass statement pages as parsed: web and customized rows, sale codes and refunds", () => {
  const vpass = (file: string) =>
    rows(
      vpassStatementPage,
      "vpass",
      bytes(`vpass-parser-boundaries/${file}`),
      meta({
        sourceId: "vpass",
        dataset: "statement-page",
        artifactKey: "months/202608/top-000.json",
        fetchUnitKey: "card-001",
        fetchedAt: "2026-08-30T00:00:00.000Z",
      }),
    );
  const [posted] = vpass("web.json");
  // Production codes: full width on the web page, ASCII on the customized one,
  // the same text the parser also writes to `description`.
  expect([posted!.paymentType, posted!.paymentType?.normalize("NFKC")]).toEqual(["１", "1"]);
  expect(outcome(posted!)).toEqual({
    kind: "purchase",
    state: "captured",
    amount: "1234",
    period: "2026-08",
  });
  const [sale, ret] = vpass("customized.json");
  expect([sale!.paymentType, ret!.paymentType]).toEqual(["1", "1"]);
  expect([sale!.providerSaleCode, ret!.providerSaleCode]).toEqual(["5", "6"]);
  expect(outcome(sale!)).toEqual({
    kind: "purchase",
    state: "authorized",
    amount: "2000",
    period: "2026-08",
  });
  expect(outcome(ret!)).toEqual({
    kind: "refund",
    state: "authorized",
    amount: "1500",
    period: "2026-08",
  });
  // Without the trusted card binding a Vpass card ordinal is not an identity.
  expect(outcome({ ...posted!, identityPolicyFamily: "identity-default" })).toEqual({
    excluded: "card_identity_unstable",
  });
  // Every code but 1 is unverified and stays excluded, as does the wording the
  // fixtures used to invent and the blank the amountless web rows carry.
  for (const paymentType of ["２", "2", "5", "", null, "1回払い", "一回払い"]) {
    expect(outcome({ ...posted!, paymentType })).toEqual({ excluded: "payment_type_unsupported" });
    expect(outcome({ ...sale!, paymentType })).toEqual({ excluded: "payment_type_unsupported" });
  }
});

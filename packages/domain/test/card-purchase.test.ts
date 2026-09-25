// The card purchase recognition contract, checked against the SC02, SC03 and
// SC04 fixtures (reused, not extended: fixtures.test.ts pins the inventory).
// Fixture amounts are in the provider's liability sign (a purchase positive, a
// refund negative); Layer B observations invert it (outflow negative), exactly
// as the Vpass and MyJCB parsers do, so every row below negates the fixture.
import { describe, expect, test } from "bun:test";
import {
  CARD_PURCHASE_POLICY,
  CARD_USAGE_EXCLUSIONS,
  cardPurchaseContent,
  cardPurchaseEventId,
  cardPurchaseRetirement,
  cardPurchaseRevision,
  cardPurchaseSummary,
  classifyCardUsage,
  comparableCardPayment,
  myjcbAgreedAmount,
  myjcbSinglePayment,
  MYJCB_NOT_SINGLE_WORDS,
  nextCardPurchaseAction,
  recognitionKey,
  statementPeriod,
  validCardPurchaseFacts,
  VPASS_CUSTOMIZED_SINGLE_PAYMENT_CODE,
  VPASS_WEB_SINGLE_PAYMENT_CODE,
  type CardPurchaseDraft,
  type CardUsageFact,
} from "../src/card-purchase.ts";
import { canonicalDigest } from "../src/context.ts";
import {
  eventTransition,
  legTotal,
  refundAllocation,
  validEconomicEventRevision,
  validSourceFactRef,
  type EconomicEventRevision,
  type EconomicLeg,
} from "../src/events.ts";
import { absentQuantity, exactQuantity, negateDecimal, type Quantity } from "../src/values.ts";
import { exact, loadFixture, ok, q, quantityText } from "./helpers.ts";

/** Observation amount (outflow negative) from a fixture's provider-signed text. */
const observed = (providerAmount: string): Quantity =>
  exactQuantity("JPY", negateDecimal(exact(q("JPY", providerAmount))), "decimal-v1");

function vpassRow(overrides: Partial<CardUsageFact> = {}): CardUsageFact {
  return {
    observationId: 101,
    parseRunId: 11,
    sourceId: "vpass",
    producerId: "card-producer",
    externalIdNamespace: "vpass-worker-card-v1",
    sourceAccount: "vpass:card-001",
    externalId: "vpass:card-001:202608:web:fingerprint:0",
    accountId: "acct-card",
    identityPolicyFamily: "vpass-card-binding",
    providerStatus: "posted",
    amount: observed("1234"),
    usageDate: "2026-08-15",
    // A posted (web family) row's payment-type code, full width as production shows it.
    paymentType: "１",
    statementPeriod: "202609",
    capturedAt: "2026-09-07T00:00:00.000Z",
    providerSaleCode: null,
    usageAmountText: null,
    paymentAmountText: null,
    newestRepresentation: true,
    ...overrides,
  };
}

function myjcbRow(overrides: Partial<CardUsageFact> = {}): CardUsageFact {
  return vpassRow({
    sourceId: "myjcb",
    externalIdNamespace: "myjcb-connection-v1",
    sourceAccount: "myjcb:connection-a:root",
    externalId: "myjcb-credit-ledger:confirmed:fingerprint:0",
    identityPolicyFamily: "identity-default",
    providerStatus: "confirmed",
    // The combined ご利用先など／支払区分 cell production MyJCB rows carry.
    paymentType: "架空店舗 1回払",
    statementPeriod: null,
    usageAmountText: "1,234",
    paymentAmountText: "1,234",
    ...overrides,
  });
}

async function recognise(fact: CardUsageFact, revision = 1): Promise<CardPurchaseDraft> {
  const classified = classifyCardUsage(fact);
  if (!classified.ok) throw new Error(`unexpected exclusion: ${classified.reasonCode}`);
  const key = recognitionKey(fact);
  if (!key) throw new Error("no key");
  const draft = await cardPurchaseRevision({
    action: revision === 1 ? "recognize" : "revise",
    eventId: await cardPurchaseEventId(classified.kind, key),
    revision,
    fact,
  });
  if (!draft) throw new Error("draft rejected");
  return draft;
}

function reason(fact: CardUsageFact): string {
  const classified = classifyCardUsage(fact);
  return classified.ok ? "recognised" : classified.reasonCode;
}

describe("SC03 pending, posted and a partial refund", () => {
  interface Sc03 {
    observations: { ref: string; providerStatus: string; amount: string }[];
    variants: { "pending-vanished": { expected: { inferredRefund: null } } };
  }
  const fixture = loadFixture<Sc03>("v2/sc03-pending-posted-refund.json");
  const byRef = new Map(fixture.observations.map((row) => [row.ref, row]));
  const vpassStatus = { pending: "unconfirmed", posted: "posted" } as const;
  const rowOf = (ref: string, overrides: Partial<CardUsageFact> = {}) => {
    const row = byRef.get(ref)!;
    return vpassRow({
      providerStatus: vpassStatus[row.providerStatus as keyof typeof vpassStatus],
      // What production shows: the customized (pending) family's bunkatsuYaku
      // is `0` on every row, the web family's data[6] a full-width `１`.
      paymentType: row.providerStatus === "pending" ? "0" : "１",
      amount: observed(row.amount),
      externalId: `vpass:card-001:202608:${row.providerStatus === "pending" ? "customized" : "web"}:${ref}:0`,
      ...overrides,
    });
  };

  test("SC03: pending 1,200 is authorized, posted 1,234 captured; authorized→captured allowed", () => {
    // The customized row's bunkatsuYaku `0`, a single payment as the owner confirmed.
    const pending = classifyCardUsage(rowOf("obs:card:pending-1", { providerSaleCode: "5" }));
    const posted = classifyCardUsage(rowOf("obs:card:posted-1"));
    expect(pending).toMatchObject({ ok: true, kind: "purchase", state: "authorized" });
    expect(posted).toMatchObject({ ok: true, kind: "purchase", state: "captured" });
    if (!pending.ok || !posted.ok) throw new Error("unreachable");
    expect(quantityText(pending.magnitude)).toBe("1200");
    expect(quantityText(posted.magnitude)).toBe("1234");
    expect(eventTransition("purchase", pending.state, posted.state)).toEqual({ ok: true });
    // The reverse is never a revision of one event.
    expect(eventTransition("purchase", "captured", "authorized").ok).toBe(false);
    // The same states hold for MyJCB's own status words.
    expect(
      classifyCardUsage(myjcbRow({ providerStatus: "unconfirmed" })) as { state?: string },
    ).toMatchObject({ state: "authorized" });
    expect(classifyCardUsage(myjcbRow()) as { state?: string }).toMatchObject({
      state: "captured",
    });
  });

  test("retirement has no live legs and infers neither refund nor cancellation (SC03 pending-vanished)", async () => {
    const pending = await recognise(rowOf("obs:card:pending-1"));
    const retired = await cardPurchaseRetirement({
      live: pending.revision,
      keys: pending.keys,
      sidecar: pending.sidecar,
    });
    expect(retired).not.toBeNull();
    expect(retired!.action).toBe("retire");
    expect(retired!.revision).toMatchObject({
      eventId: pending.revision.eventId,
      revision: 2,
      kind: "purchase",
      state: "unknown",
      unknownReason: "provider_status_absent",
      legs: [],
    });
    // Evidence is the last displayed row; nothing else is claimed.
    expect(retired!.revision.evidenceSupport).toEqual(pending.revision.evidenceSupport);
    expect(validEconomicEventRevision(retired!.revision)).toBe(true);
    expect(fixture.variants["pending-vanished"].expected.inferredRefund).toBeNull();
    // Neither a refund nor a canceled purchase appears; the figure moves to unresolved.
    const summary = ok(
      cardPurchaseSummary([{ ...pending.revision, supersededBy: "x@2" }, retired!.revision]),
    ).summary;
    expect(summary).toEqual({ units: [], unresolved: 1 });
    // An unknown event is not retired again, and a captured one may be.
    expect(
      await cardPurchaseRetirement({
        live: retired!.revision,
        keys: retired!.keys,
        sidecar: retired!.sidecar,
      }),
    ).toBeNull();
    expect(eventTransition("purchase", "captured", "unknown")).toEqual({ ok: true });
  });

  test("a refund is its own event with an increase leg and no allocation; refundAllocation reports refund_target_unknown", async () => {
    const refundRow = rowOf("obs:card:refund-1");
    const draft = await recognise(refundRow);
    expect(draft.revision.kind).toBe("refund");
    expect(draft.revision.eventId).toMatch(/^refund_[0-9a-f]{64}$/u);
    expect(draft.revision.legs).toHaveLength(1);
    expect(draft.revision.legs[0]).toMatchObject({
      role: "increase",
      basis: "purchase-recognition",
      subjectRef: "account:acct-card",
    });
    expect(quantityText(draft.revision.legs[0]!.quantity)).toBe("400");
    // The draft carries no allocation: a refund is never netted by recognition.
    expect(Object.keys(draft).sort()).toEqual([
      "action",
      "content",
      "contentDigest",
      "decisionRevisionId",
      "keys",
      "revision",
      "sidecar",
    ]);
    const outcome = ok(
      refundAllocation({
        purchase: q("JPY", "1234"),
        refunds: [],
        unallocatedRefunds: [draft.revision.legs[0]!.quantity],
      }),
    );
    expect(quantityText(outcome.net)).toBe("1234");
    expect(outcome.exceptions.map((exception) => exception.code)).toEqual([
      "refund_target_unknown",
    ]);
    // A Vpass customized return (sale code 6, bunkatsuYaku 0) is a pending
    // refund; an unconfirmed code (1) is not recognised.
    const customizedReturn = (paymentType: string) =>
      rowOf("obs:card:refund-1", {
        providerStatus: "unconfirmed",
        providerSaleCode: "6",
        paymentType,
      });
    expect(classifyCardUsage(customizedReturn("0"))).toMatchObject({
      ok: true,
      kind: "refund",
      state: "authorized",
    });
    expect(reason(customizedReturn("1"))).toBe("payment_type_unsupported");
    expect(reason(rowOf("obs:card:refund-1", { providerSaleCode: "5" }))).toBe(
      "refund_shape_unverified",
    );
    // MyJCB refunds need usage and payment to agree; otherwise the shape is unverified.
    const myjcbRefund = myjcbRow({
      amount: observed("-500"),
      usageAmountText: "-500",
      paymentAmountText: "-500",
    });
    expect(classifyCardUsage(myjcbRefund)).toMatchObject({ ok: true, kind: "refund" });
    expect(reason({ ...myjcbRefund, paymentAmountText: null })).toBe("refund_shape_unverified");
    expect(reason({ ...myjcbRefund, usageAmountText: "-1,000" })).toBe("refund_shape_unverified");
  });
});

describe("SC04 installments", () => {
  interface Sc04 {
    purchase: { amount: string };
    schedule: { principal: string }[];
  }
  const fixture = loadFixture<Sc04>("v2/sc04-installments.json");
  const usage = Number(fixture.purchase.amount).toLocaleString("en-US");
  const payment = Number(fixture.schedule[0]!.principal).toLocaleString("en-US");

  test("SC04: an installment slice (usage 12,000 / payment 4,000) is never recognised or compared", () => {
    expect([usage, payment]).toEqual(["12,000", "4,000"]);
    const slice = myjcbRow({
      amount: observed(fixture.schedule[0]!.principal),
      paymentType: "架空店舗 分割",
      usageAmountText: usage,
      paymentAmountText: payment,
    });
    expect(reason(slice)).toBe("payment_type_unsupported");
    // Even a payment type that drifted to look single cannot hide the slice.
    expect(reason({ ...slice, paymentType: "架空店舗 1回払" })).toBe("installment_amount_differs");
    expect(reason({ ...slice, paymentType: "架空店舗 1回払", paymentAmountText: null })).toBe(
      "payment_split_unknown",
    );
    // A pending usage row of the same purchase is not recognised either.
    expect(
      reason({
        ...slice,
        paymentType: "架空店舗 1回払",
        providerStatus: "unconfirmed",
        amount: observed(fixture.purchase.amount),
      }),
    ).toBe("installment_amount_differs");
    // The shared rule keeps the slice out of pending-to-posted matching too,
    // in plain digits and in the ledger's display text alike.
    const row = { sourceId: "myjcb", status: "confirmed" };
    for (const unit of ["", "円"]) {
      expect(
        comparableCardPayment({
          ...row,
          usageAmountText: `${usage}${unit}`,
          paymentAmountText: `${payment}${unit}`,
        }),
      ).toBe(false);
      expect(
        comparableCardPayment({
          ...row,
          usageAmountText: `${usage}${unit}`,
          paymentAmountText: `${usage}${unit}`,
        }),
      ).toBe(true);
    }
    expect(myjcbAgreedAmount(usage, payment)).toEqual({
      ok: false,
      reasonCode: "installment_amount_differs",
    });
  });

  test("MyJCB display text (1,234円, 1回払) is read with the ledger parser's grammar", () => {
    // The shapes the MyJCB ledger parser emits for production rows.
    const display = myjcbRow({
      paymentType: "架空店舗 1回払",
      usageAmountText: "1,234円",
      paymentAmountText: "1,234円",
    });
    expect(classifyCardUsage(display)).toMatchObject({ ok: true, kind: "purchase" });
    expect(reason({ ...display, providerStatus: "unconfirmed" })).toBe("recognised");
    // Width, spaces and a leading yen sign are normalised as the parser does.
    for (const text of ["１，２３４円", " 1,234 円", "¥1,234", "￥1,234", "1234"])
      expect(reason({ ...display, usageAmountText: text })).toBe("recognised");
    // A refund keeps the provider's minus sign on both texts.
    expect(
      classifyCardUsage({
        ...display,
        amount: observed("-500"),
        usageAmountText: "-500円",
        paymentAmountText: "-500円",
      }),
    ).toMatchObject({ ok: true, kind: "refund", state: "captured" });
    // The installment slice from the confirmed fixture (400円 of 1,200円, 分割払い).
    const slice = {
      ...display,
      amount: observed("400"),
      paymentType: "架空店舗B 分割払い",
      usageAmountText: "1,200円",
      paymentAmountText: "400円",
    };
    expect(reason(slice)).toBe("payment_type_unsupported");
    expect(reason({ ...slice, paymentType: "架空店舗B 1回払" })).toBe("installment_amount_differs");
    // Anything that is not an exact display integer is not read as a number.
    for (const text of ["1,23円", "1.5円", "1,234ドル", "円", "", "01,234円", "1,234円円"])
      expect(reason({ ...display, usageAmountText: text })).toBe("payment_split_unknown");
    expect(myjcbAgreedAmount("1,200円", "1,200")).toEqual({ ok: true, amount: 1200n });
  });

  test("pending-to-posted matching reads MyJCB amounts with the same grammar as recognition", () => {
    const confirmed = (usageAmountText: string | null, paymentAmountText: string | null) =>
      comparableCardPayment({
        sourceId: "myjcb",
        status: "confirmed",
        usageAmountText,
        paymentAmountText,
      });
    // The ledger parser's real display text is compared, as recognition reads it.
    expect(confirmed("1,200円", "1,200円")).toBe(true);
    for (const text of ["1,200", " 1,200 円", "１，２００円", "¥1,200", "￥1,200", "1200"])
      expect(confirmed(text, "1,200円")).toBe(true);
    // Usage must equal payment and be positive: an installment slice, a zero
    // and a refund are never compared.
    expect(confirmed("1,200円", "300円")).toBe(false);
    expect(confirmed("0円", "0円")).toBe(false);
    expect(confirmed("-500円", "-500円")).toBe(false);
    // A missing or unreadable text is never read as a number.
    for (const text of [null, "", "円", "1,20円", "1.5円", "01,200円", "1,200ドル"])
      expect(confirmed(text, "1,200円")).toBe(false);
    expect(confirmed("1,200円", null)).toBe(false);
    // One grammar: wherever recognition agrees on a positive amount, so does matching.
    for (const [usage, payment] of [
      ["1,200円", "1,200円"],
      ["1,200円", "400円"],
      ["-500円", "-500円"],
      ["1,200円", null],
      ["1,2000円", "12,000円"],
    ] as const) {
      const agreed = myjcbAgreedAmount(usage, payment);
      expect(confirmed(usage, payment)).toBe(agreed.ok && agreed.amount > 0n);
    }
    // Only MyJCB confirmed rows are constrained.
    for (const other of [
      { sourceId: "myjcb", status: "unconfirmed" },
      { sourceId: "vpass", status: "posted" },
    ])
      expect(
        comparableCardPayment({ ...other, usageAmountText: null, paymentAmountText: null }),
      ).toBe(true);
  });
});

describe("exclusions", () => {
  test("Vpass: a web (posted) row's code 1 (１) and a customized (pending) row's bunkatsuYaku 0 are single payments; every other code or wording is unsupported", () => {
    // The web family's production shape: a full-width digit in data[6], the
    // same code as ASCII 1 after NFKC.
    expect(reason(vpassRow({ paymentType: "１" }))).toBe("recognised");
    expect(reason(vpassRow({ paymentType: "1" }))).toBe("recognised");
    // The customized family's bunkatsuYaku is a different field: `0` on every
    // production row, a single payment as the owner confirmed. Every other
    // value, the web family's `1` included, is unconfirmed and unsupported.
    const customized = (paymentType: string | null, providerSaleCode: string) =>
      vpassRow({
        paymentType,
        providerStatus: "unconfirmed",
        providerSaleCode,
        amount: observed(providerSaleCode === "5" ? "1234" : "-1234"),
      });
    for (const providerSaleCode of ["5", "6"])
      for (const paymentType of ["0", "０"])
        expect(reason(customized(paymentType, providerSaleCode))).toBe("recognised");
    for (const paymentType of ["1", "１", "2", "00", " 0", "", null])
      for (const providerSaleCode of ["5", "6"])
        expect(reason(customized(paymentType, providerSaleCode))).toBe("payment_type_unsupported");
    // No web code other than 1 has been observed, so none is guessed: 2, 5, a
    // two-digit code, a blank (the amountless web rows) and absent are unsupported.
    for (const paymentType of ["２", "2", "5", "0", "０", "11", "01", "", " ", null])
      expect(reason(vpassRow({ paymentType }))).toBe("payment_type_unsupported");
    // Wording is not a Vpass shape any more, however single it reads, and a
    // padded code is not the code.
    for (const paymentType of [
      "1回払い",
      "１回払い",
      "一回払い",
      "1回払",
      "分割",
      "リボ",
      "ボーナス一括",
      " 1 ",
      "1 ",
    ])
      expect(reason(vpassRow({ paymentType }))).toBe("payment_type_unsupported");
    expect([VPASS_WEB_SINGLE_PAYMENT_CODE, VPASS_CUSTOMIZED_SINGLE_PAYMENT_CODE]).toEqual([
      "1",
      "0",
    ]);
  });

  test("MyJCB: the combined cell holds 1回払 and no installment, revolving, bonus or cash-advance word", () => {
    const single = [
      "架空店舗 1回払",
      "架空店舗 1回払い",
      "架空店舗 一回払い",
      "架空店舗 １回払",
      "架空店舗 1 回払",
      "架空店舗１回払",
      "1回払 架空店舗",
      // A merchant name ending in a digit, separated from the payment type.
      "架空店舗2 1回払",
      "ABC 12 1回払",
    ];
    for (const paymentType of single) {
      expect(myjcbSinglePayment(paymentType)).toBe(true);
      expect(reason(myjcbRow({ paymentType }))).toBe("recognised");
      expect(reason(myjcbRow({ paymentType, providerStatus: "unconfirmed" }))).toBe("recognised");
    }
    const unsupported = [
      "架空店舗 2回払",
      "架空店舗 2回払い",
      "架空店舗 二回払い",
      "架空店舗 11回払",
      "架空店舗 十一回払い",
      // A digit glued to the count reads as the larger count, never as 1.
      "架空店舗21回払",
      "架空店舗 分割払い",
      "架空店舗 分割(3回)",
      "架空店舗 1回払 分割",
      "架空店舗 リボ払",
      "架空店舗 ﾘﾎﾞ払い",
      "架空店舗 ボーナス1回払",
      "架空店舗 ボーナス一括",
      "架空店舗 キャッシング1回払い",
      "架空店舗 ｷｬｯｼﾝｸﾞ1回払",
      "架空店舗 1回払 2回払",
      "架空店舗 一括払い",
      // A merchant name holding one of the words excludes the row too: a
      // skipped purchase is safe, a guessed one is not.
      "架空リボン店 1回払",
      "架空分割店 1回払",
      // The shapes production MyJCB rows do not have: a merchant alone, the
      // two-character label of the cell the parser took for the payment type,
      // a Vpass code, blank and absent.
      "架空店舗",
      "架空",
      "1",
      "",
      "  ",
      null,
    ];
    for (const paymentType of unsupported) {
      expect(myjcbSinglePayment(paymentType)).toBe(false);
      expect(reason(myjcbRow({ paymentType }))).toBe("payment_type_unsupported");
    }
    expect([...MYJCB_NOT_SINGLE_WORDS]).toEqual(["分割", "リボ", "ボーナス", "キャッシング"]);
    // A MyJCB wording is not a Vpass code, and a Vpass code is not a MyJCB wording.
    expect(reason(vpassRow({ paymentType: "架空店舗 1回払" }))).toBe("payment_type_unsupported");
    expect(reason(myjcbRow({ paymentType: "１" }))).toBe("payment_type_unsupported");
  });

  test("amountless/unparsed/zero/non-JPY rows excluded with a reason, never zero (INV05)", () => {
    expect(
      reason(vpassRow({ amount: absentQuantity("JPY", "missing", "decimal-v1:missing") })),
    ).toBe("amount_not_exact");
    expect(
      reason(vpassRow({ amount: absentQuantity("JPY", "unparsed", "decimal-v1:unparsed") })),
    ).toBe("amount_not_exact");
    expect(reason(vpassRow({ amount: observed("0") }))).toBe("amount_zero");
    expect(reason(vpassRow({ amount: exactQuantity("USD", exact(observed("12"))) }))).toBe(
      "unit_unsupported",
    );
    expect(reason(vpassRow({ usageDate: null }))).toBe("date_absent");
    expect(reason(vpassRow({ usageDate: "2026-02-30" }))).toBe("date_absent");
    expect(reason(vpassRow({ accountId: null }))).toBe("account_not_resolved");
    expect(reason(vpassRow({ providerStatus: "canceled" }))).toBe("status_unsupported");
    expect(reason(vpassRow({ providerStatus: "confirmed" }))).toBe("status_unsupported");
    expect(reason(vpassRow({ sourceId: "smbc-bank" }))).toBe("status_unsupported");
    expect(reason(vpassRow({ newestRepresentation: false }))).toBe("superseded_representation");
    // Every reason used above is in the closed set.
    expect(CARD_USAGE_EXCLUSIONS).toContain("amount_not_exact");
  });

  test("Vpass without vpass-card-binding identity → card_identity_unstable", () => {
    expect(reason(vpassRow({ identityPolicyFamily: "identity-default" }))).toBe(
      "card_identity_unstable",
    );
    expect(reason(vpassRow({ identityPolicyFamily: null }))).toBe("card_identity_unstable");
    expect(reason(vpassRow({ externalId: null }))).toBe("card_identity_unstable");
    // MyJCB's connection-scoped identity is resolved by the default policy.
    expect(reason(myjcbRow())).toBe("recognised");
  });
});

describe("drafts and content identity", () => {
  test("drafts validate, have exactly one purchase-recognition leg on account:<id>, and object SourceFactRef evidence", async () => {
    const draft = await recognise(vpassRow());
    expect(validEconomicEventRevision(draft.revision)).toBe(true);
    expect(draft.revision).toMatchObject({
      kind: "purchase",
      state: "captured",
      basis: "purchase-recognition",
      effectiveTime: {
        kind: "local-date",
        value: "2026-08-15",
        zone: "Asia/Tokyo",
        basis: "provider",
      },
      decisionRevisionRef: draft.decisionRevisionId,
      supersededBy: null,
    });
    expect(draft.revision.legs).toEqual([
      {
        eventId: draft.revision.eventId,
        revision: 1,
        legIndex: 0,
        subjectRef: "account:acct-card",
        quantity: exactQuantity("JPY", exact(q("JPY", "1234")), "decimal-v1"),
        role: "decrease",
        basis: "purchase-recognition",
      },
    ]);
    expect(draft.revision.legs.some((leg) => leg.basis === "cash-movement")).toBe(false);
    expect(draft.revision.evidenceSupport).toEqual([
      { kind: "transaction", id: "transaction:101", revision: "parse_run:11" },
    ]);
    expect(draft.revision.evidenceSupport.every(validSourceFactRef)).toBe(true);
    expect(draft.keys).toEqual([
      {
        key: JSON.stringify([
          "vpass",
          "card-producer",
          "vpass-worker-card-v1",
          "vpass:card-001",
          "vpass:card-001:202608:web:fingerprint:0",
        ]),
        role: "posted",
        observationId: 101,
        parseRunId: 11,
      },
    ]);
    expect(draft.sidecar).toEqual({
      accountId: "acct-card",
      sourceId: "vpass",
      statementPeriod: "2026-09",
      facts: {
        providerStatus: "posted",
        amount: observed("1234"),
        usageDate: "2026-08-15",
        paymentType: "single-payment",
        amountCheck: "provider-amount",
        providerSaleCode: null,
      },
    });
    // The stored facts carry codes, amounts and dates only.
    expect(JSON.stringify(draft.sidecar.facts)).not.toMatch(/回払|１|架空/u);
    expect(validCardPurchaseFacts(draft.sidecar.facts)).toBe(true);
    expect(validCardPurchaseFacts({ ...draft.sidecar.facts, merchant: "synthetic shop" })).toBe(
      false,
    );
    expect(validCardPurchaseFacts({ ...draft.sidecar.facts, amount: observed("0") })).toBe(false);
    expect(draft.decisionRevisionId).toMatch(/^dr_cp_[0-9a-f]{64}$/u);
    expect(draft.contentDigest).toBe(await canonicalDigest(draft.content));
    // Event ids come from the policy and the key.
    expect(draft.revision.eventId).toBe(
      `purchase_${await canonicalDigest({ policy: CARD_PURCHASE_POLICY, key: JSON.parse(draft.keys[0]!.key) })}`,
    );
    // Inconsistent inputs are refused rather than repaired.
    const fact = vpassRow();
    const eventId = draft.revision.eventId;
    expect(
      await cardPurchaseRevision({ action: "recognize", eventId, revision: 2, fact }),
    ).toBeNull();
    expect(await cardPurchaseRevision({ action: "revise", eventId, revision: 1, fact })).toBeNull();
    expect(
      await cardPurchaseRevision({
        action: "recognize",
        eventId: eventId.replace("purchase_", "refund_"),
        revision: 1,
        fact,
      }),
    ).toBeNull();
    expect(
      await cardPurchaseRevision({
        action: "recognize",
        eventId,
        revision: 1,
        fact: vpassRow({ paymentType: "２" }),
      }),
    ).toBeNull();
  });

  test("content identity ignores observation/parse ids; account/amount/state/date changes are revisions", async () => {
    const first = await recognise(vpassRow());
    const refetched = await recognise(vpassRow({ observationId: 999, parseRunId: 77 }));
    expect(refetched.contentDigest).toBe(first.contentDigest);
    expect(refetched.decisionRevisionId).toBe(first.decisionRevisionId);
    expect(refetched.revision.evidenceSupport).not.toEqual(first.revision.evidenceSupport);
    const live = {
      kind: first.revision.kind,
      state: first.revision.state,
      contentDigest: first.contentDigest,
      statementPeriod: first.sidecar.statementPeriod,
    };
    const next = {
      kind: "purchase" as const,
      state: "captured" as const,
      statementPeriod: first.sidecar.statementPeriod,
    };
    expect(
      nextCardPurchaseAction({
        live: { ...live, evidenceAdopted: true },
        next: { ...next, contentDigest: refetched.contentDigest },
      }),
    ).toBe("none");
    // The cited parse is no longer published: same content, new anchor.
    expect(
      nextCardPurchaseAction({
        live: { ...live, evidenceAdopted: false },
        next: { ...next, contentDigest: refetched.contentDigest },
      }),
    ).toBe("reanchor");
    // The customized (pending) row of the same purchase: bunkatsuYaku `0`.
    const pendingRow = vpassRow({ providerStatus: "unconfirmed", paymentType: "0" });
    for (const changed of [
      vpassRow({ accountId: "acct-other" }),
      vpassRow({ amount: observed("1300") }),
      vpassRow({ usageDate: "2026-08-16" }),
      pendingRow,
    ]) {
      const draft = await recognise(changed);
      expect(draft.contentDigest).not.toBe(first.contentDigest);
      expect(
        nextCardPurchaseAction({
          live: { ...live, evidenceAdopted: true },
          next: { ...next, state: draft.revision.state, contentDigest: draft.contentDigest },
        }),
      ).toBe(draft.revision.state === "captured" ? "revise" : "blocked");
    }
    // A state change is a revision exactly when eventTransition allows it:
    // authorized → captured is, captured → authorized (above) is not.
    const authorized = await recognise(pendingRow);
    expect(
      nextCardPurchaseAction({
        live: {
          kind: "purchase",
          state: authorized.revision.state,
          contentDigest: authorized.contentDigest,
          evidenceAdopted: true,
          statementPeriod: authorized.sidecar.statementPeriod,
        },
        next: { ...next, contentDigest: first.contentDigest },
      }),
    ).toBe("revise");
    // A statement period or policy release is not content...
    const periodChanged = await recognise(vpassRow({ statementPeriod: "2026-10" }));
    expect(periodChanged.contentDigest).toBe(first.contentDigest);
    // ...but a sidecar period derived differently from the same row is still
    // a revision (a relative label resolved from its capture time), adopted
    // evidence or not, never "nothing to do".
    for (const evidenceAdopted of [true, false])
      expect(
        nextCardPurchaseAction({
          live: { ...live, evidenceAdopted, statementPeriod: null },
          next: { ...next, contentDigest: periodChanged.contentDigest, statementPeriod: "2026-10" },
        }),
      ).toBe("revise");
    // A later revision of the same content is its own decision.
    const second = await recognise(vpassRow(), 2);
    expect(second.contentDigest).toBe(first.contentDigest);
    expect(second.decisionRevisionId).not.toBe(first.decisionRevisionId);
    // First sight recognises; a kind change is never a revision; unknown may return.
    expect(
      nextCardPurchaseAction({ live: null, next: { ...next, contentDigest: first.contentDigest } }),
    ).toBe("recognize");
    expect(
      nextCardPurchaseAction({
        live: { ...live, evidenceAdopted: true },
        next: { kind: "refund", state: "captured", contentDigest: "other", statementPeriod: null },
      }),
    ).toBe("blocked");
    expect(
      nextCardPurchaseAction({
        live: { ...live, state: "unknown", evidenceAdopted: true },
        next: { ...next, contentDigest: first.contentDigest.replace(/.$/u, "x") },
      }),
    ).toBe("revise");
    // A leg without an exact amount has no content identity.
    expect(
      cardPurchaseContent(
        {
          ...first.revision,
          legs: [{ ...first.revision.legs[0]!, quantity: absentQuantity("JPY", "missing", "x") }],
        },
        first.keys,
      ),
    ).toBeNull();
  });
});

describe("totals", () => {
  const revision = (
    eventId: string,
    kind: EconomicEventRevision["kind"],
    state: EconomicEventRevision["state"],
    legs: [unitRef: string, amount: string, basis?: EconomicLeg["basis"]][],
  ): EconomicEventRevision => ({
    eventId,
    revision: 1,
    kind,
    state,
    unknownReason: state === "unknown" ? "provider_status_absent" : null,
    effectiveTime: {
      kind: "local-date",
      value: "2026-08-15",
      zone: "Asia/Tokyo",
      basis: "provider",
    },
    basis: "purchase-recognition",
    evidenceSupport: [
      { kind: "transaction", id: `transaction:${eventId}`, revision: "parse_run:1" },
    ],
    decisionRevisionRef: `dr_${eventId}`,
    supersededBy: null,
    legs: legs.map(([unitRef, amount, basis], legIndex) => ({
      eventId,
      revision: 1,
      legIndex,
      subjectRef: "account:acct-card",
      quantity: q(unitRef, amount),
      role: kind === "refund" ? "increase" : "decrease",
      basis: basis ?? "purchase-recognition",
    })),
  });

  test("summary never adds captured and authorized, nor different units", () => {
    const summary = ok(
      cardPurchaseSummary([
        revision("p1", "purchase", "captured", [["JPY", "1234"]]),
        revision("p2", "purchase", "captured", [["JPY", "0.5"]]),
        revision("p3", "purchase", "authorized", [["JPY", "1200"]]),
        revision("p4", "purchase", "captured", [["USD", "12.34"]]),
        revision("r1", "refund", "captured", [["JPY", "400"]]),
        revision("r2", "refund", "authorized", [["JPY", "50"]]),
        revision("u1", "purchase", "unknown", []),
        { ...revision("old", "purchase", "captured", [["JPY", "999"]]), supersededBy: "old@2" },
      ]),
    ).summary;
    expect(summary.unresolved).toBe(1);
    expect(
      summary.units.map((unit) => ({
        unitRef: unit.unitRef,
        captured: quantityText(unit.captured),
        authorized: quantityText(unit.authorized),
        capturedRefunds: quantityText(unit.capturedRefunds),
        authorizedRefunds: quantityText(unit.authorizedRefunds),
      })),
    ).toEqual([
      {
        unitRef: "JPY",
        captured: "1234.5",
        authorized: "1200",
        capturedRefunds: "400",
        authorizedRefunds: "50",
      },
      {
        unitRef: "USD",
        captured: "12.34",
        authorized: "0",
        capturedRefunds: "0",
        authorizedRefunds: "0",
      },
    ]);
    // There is no field that combines states or units.
    expect(Object.keys(summary.units[0]!).sort()).toEqual([
      "authorized",
      "authorizedRefunds",
      "captured",
      "capturedRefunds",
      "unitRef",
    ]);
    // A leg without an exact amount fails the summary instead of counting as zero.
    const broken = revision("b", "purchase", "captured", [["JPY", "1"]]);
    broken.legs[0]!.quantity = absentQuantity("JPY", "missing", "x");
    expect(cardPurchaseSummary([broken]).ok).toBe(false);
  });

  test("SC02: a settlement-shaped event (legs copied from card-settlement-commands.ts:113-129) adds 0 to purchase-recognition; a purchase adds 0 to cash-movement", async () => {
    interface Sc02 {
      events: { eventId: string; kind: string; purchaseCost?: string }[];
    }
    const fixture = loadFixture<Sc02>("v2/sc02-charge-purchase-settle.json");
    const cost = fixture.events.find((event) => event.kind === "purchase")!.purchaseCost!;
    const purchase = (await recognise(vpassRow({ amount: observed(cost) }))).revision;
    // What accepting a card settlement writes: a card_settlement/debited event
    // with a cash-movement leg and an unresolved obligation-change leg.
    const settlement: EconomicEventRevision = {
      ...revision("ev:settlement-1", "card_settlement", "debited", [
        ["JPY", "10000", "cash-movement"],
      ]),
      basis: "cash-movement",
      legs: [
        {
          eventId: "ev:settlement-1",
          revision: 1,
          legIndex: 0,
          subjectRef: "acct-bank",
          quantity: q("JPY", "10000"),
          role: "decrease",
          basis: "cash-movement",
        },
        {
          eventId: "ev:settlement-1",
          revision: 1,
          legIndex: 1,
          subjectRef: "acct-card",
          quantity: absentQuantity("JPY", "missing", "statement_principal_and_fees_unknown"),
          role: "unresolved",
          basis: "obligation-change",
        },
      ],
    };
    const settlementCash = settlement.legs.filter((leg) => leg.basis === "cash-movement");
    expect(
      quantityText(
        ok(legTotal(settlementCash, { unitRef: "JPY", basis: "purchase-recognition" })).quantity,
      ),
    ).toBe("0");
    expect(
      quantityText(
        ok(legTotal(purchase.legs, { unitRef: "JPY", basis: "cash-movement" })).quantity,
      ),
    ).toBe("0");
    expect(
      quantityText(
        ok(legTotal(purchase.legs, { unitRef: "JPY", basis: "purchase-recognition" })).quantity,
      ),
    ).toBe(cost);
    // The purchase summary ignores the settlement entirely.
    const summary = ok(cardPurchaseSummary([purchase, settlement])).summary;
    expect(summary.units.map((unit) => quantityText(unit.captured))).toEqual([cost]);
  });
});

test("statementPeriod yields card_statement_facts.period (YYYY-MM), from YYYY-MM/YYYYMM or the MyJCB label", () => {
  expect(statementPeriod("2026-09")).toBe("2026-09");
  expect(statementPeriod("202609")).toBe("2026-09");
  // MyJCB `_kogane.period` / settlementYM labels (collector fixtures) name the
  // month the statement is paid in, which is the statement parser's period.
  expect(statementPeriod("2026年7月お支払い分")).toBe("2026-07");
  expect(statementPeriod("2025年10月お支払い分")).toBe("2025-10");
  expect(statementPeriod("2026年9月")).toBe("2026-09");
  expect(statementPeriod("２０２６年 ７月 お支払い分")).toBe("2026-07");
  for (const value of [
    "2026-9",
    "20269",
    "2026-13",
    "202600",
    "2026年13月お支払い分",
    "2026年0月お支払い分",
    "2026年7月10日お支払い分",
    "26年7月お支払い分",
    "detailMonth-2",
    " 2026-09",
    "2026-09-01",
    "",
    null,
    202609,
  ])
    expect(statementPeriod(value)).toBeNull();
});

// The A10 vertical slice at the contract level: SC02 (charge, purchase,
// settlement), SC03 (pending, posted, partial refund), SC04 (instalments),
// SC05 (cross-currency transfer) and SC10 (platform payout), plus the state
// machines and the conservation rules of addendum 07 section 4. Every number
// here is synthetic and comes from addendum 03.
import { describe, expect, test } from "bun:test";
import type { Allocation } from "../src/decisions.ts";
import {
  conservationCheck,
  effectiveRate,
  eventTransition,
  legTotal,
  referenceQuoteDifference,
  refundAllocation,
  settlementCheck,
  splitFillCheck,
  validEconomicEventRevision,
  validObligationRevision,
  validSettlementRelation,
  type EconomicLeg,
  type RecognitionBasis,
  type SettlementRelation,
} from "../src/events.ts";
import { decimalLiteral, integerDecimal, subtractDecimals, sumDecimals } from "../src/values.ts";
import { exact, loadFixture, ok, q, quantityText } from "./helpers.ts";

const leg = (
  eventId: string,
  legIndex: number,
  subjectRef: string,
  unitRef: string,
  amount: string,
  role: EconomicLeg["role"],
  basis: RecognitionBasis = "cash-movement",
): EconomicLeg => ({
  eventId,
  revision: 1,
  legIndex,
  subjectRef,
  quantity: q(unitRef, amount),
  role,
  basis,
});

const today = { kind: "local-date", value: "2026-03-01", zone: null, basis: "provider" } as const;

describe("SC02 charge, purchase and settlement are three events, one purchase", () => {
  interface Sc02Fixture {
    accounts: Record<string, string>;
    opening: Record<string, string>;
    events: {
      eventId: string;
      kind: string;
      legs: { account: string; delta: string }[];
      purchaseCost?: string;
      observationRefs: string[];
    }[];
    expectedCounts: { observations: number; purchases: number };
  }

  test("net position is 97,000 and the cumulative purchase cost is 3,000 (AT38)", () => {
    const fixture = loadFixture<Sc02Fixture>("v2/sc02-charge-purchase-settle.json");
    // Each fixture event becomes one economic event with typed legs. A funding
    // leg and a settlement leg are cash movements; only the purchase carries
    // the purchase-recognition basis, so no read model can count them together.
    const legsByEvent = new Map<string, EconomicLeg[]>();
    for (const event of fixture.events) {
      const legs = event.legs.map((entry, index) => {
        const negative = entry.delta.startsWith("-");
        const liability = fixture.accounts[entry.account] === "liability";
        // For a liability account a positive delta is more debt: a decrease of
        // net position. Roles are stated, never inferred from the sign alone.
        const role: EconomicLeg["role"] = negative === liability ? "increase" : "decrease";
        return leg(
          event.eventId,
          index,
          `account:${entry.account}`,
          "JPY",
          entry.delta.replace("-", ""),
          role,
          event.kind === "purchase" ? "purchase-recognition" : "cash-movement",
        );
      });
      legsByEvent.set(event.eventId, legs);
    }
    // The charge and the settlement conserve value inside JPY; the purchase is
    // a one-sided consumption, so it declares its unresolved difference.
    expect(ok(conservationCheck({ legs: legsByEvent.get("ev:charge-1")! }))).toMatchObject({
      crossUnit: false,
    });
    expect(
      quantityText(
        ok(conservationCheck({ legs: legsByEvent.get("ev:settlement-1")! })).unresolvedDifference,
      ),
    ).toBe("0");
    const purchaseLegs = legsByEvent.get("ev:purchase-1")!;
    expect(
      quantityText(
        ok(legTotal(purchaseLegs, { unitRef: "JPY", basis: "purchase-recognition" })).quantity,
      ),
    ).toBe("3000");
    // Charge and settlement contribute nothing on the purchase basis.
    const everyLeg = [...legsByEvent.values()].flat();
    expect(
      quantityText(
        ok(legTotal(everyLeg, { unitRef: "JPY", basis: "purchase-recognition" })).quantity,
      ),
    ).toBe("3000");
    // Five observations, one purchase: the number of reports is not the number of purchases.
    expect(fixture.events.flatMap((event) => event.observationRefs)).toHaveLength(
      fixture.expectedCounts.observations,
    );
    expect(fixture.events.filter((event) => event.kind === "purchase")).toHaveLength(1);
    // Net position after every event: 100,000 + 10,000 − 10,000 − 3,000 ... on
    // assets minus liabilities, computed from the fixture the same way SYN03 does.
    const balances = new Map(
      Object.entries(fixture.opening).map(([k, v]) => [k, decimalLiteral(v)]),
    );
    for (const event of fixture.events)
      for (const entry of event.legs)
        balances.set(
          entry.account,
          sumDecimals([balances.get(entry.account)!, decimalLiteral(entry.delta)]),
        );
    const net = subtractDecimals(
      sumDecimals([...balances].filter(([k]) => fixture.accounts[k] === "asset").map(([, v]) => v)),
      sumDecimals(
        [...balances].filter(([k]) => fixture.accounts[k] === "liability").map(([, v]) => v),
      ),
    );
    expect(net).toEqual(integerDecimal(97000));
  });

  test("a card settlement never reaches `credited` without being debited first", () => {
    expect(eventTransition("card_settlement", "requested", "credited")).toMatchObject({
      ok: false,
      reasonCode: "transition_not_defined",
    });
    expect(eventTransition("card_settlement", "requested", "debited")).toEqual({ ok: true });
    // A purchase state is not a settlement state.
    expect(eventTransition("card_settlement", "requested", "captured")).toMatchObject({
      reasonCode: "state_not_in_family",
    });
  });
});

describe("SC03 pending, posted and a partial refund", () => {
  interface Sc03Fixture {
    unitRef: string;
    observations: { ref: string; providerStatus: string; amount: string }[];
    purchase: { ref: string; adoptedFrom: string };
    allocations: Allocation[];
    expected: { adoptedPurchase: string; netAfterRefund: string };
  }

  test("1,234 is captured, 834 is net after the allocated 400 refund (AT13, AT17)", () => {
    const fixture = loadFixture<Sc03Fixture>("v2/sc03-pending-posted-refund.json");
    const purchase = q(fixture.unitRef, fixture.expected.adoptedPurchase);
    const result = ok(refundAllocation({ purchase, refunds: fixture.allocations }));
    expect(quantityText(result.allocated)).toBe("400");
    expect(quantityText(result.net)).toBe(fixture.expected.netAfterRefund);
    expect(result.exceptions).toEqual([]);
    // The pending 1,200 never becomes a second purchase: it is not an input.
    expect(fixture.observations.filter((o) => o.providerStatus === "pending")).toHaveLength(1);
  });

  test("a refund with an unknown parent stays unallocated and visible", () => {
    const result = ok(
      refundAllocation({
        purchase: q("JPY", "1234"),
        refunds: [],
        unallocatedRefunds: [q("JPY", "400")],
      }),
    );
    expect(quantityText(result.allocated)).toBe("0");
    expect(quantityText(result.net)).toBe("1234");
    expect(result.exceptions).toEqual([
      { code: "refund_target_unknown", quantity: q("JPY", "400"), refs: [] },
    ]);
  });

  test("an over-refund is an exception state, never absorbed into the purchase", () => {
    const refund = (id: string, amount: string): Allocation => ({
      allocationId: id,
      sourceRef: "obs:refund",
      targetRef: "purchase:1",
      role: "refund",
      quantity: q("JPY", amount),
    });
    const result = ok(
      refundAllocation({
        purchase: q("JPY", "1234"),
        refunds: [refund("a", "1000"), refund("b", "500")],
      }),
    );
    expect(quantityText(result.allocated)).toBe("1234");
    expect(quantityText(result.net)).toBe("0");
    expect(result.exceptions).toEqual([
      { code: "over_refund", quantity: q("JPY", "266"), refs: ["a", "b"] },
    ]);
  });

  test("a vanished pending row produces no refund: nothing is inferred (AT14)", () => {
    // The disappearance is not an input to any function here; the net of a
    // purchase with no refund allocation is the purchase itself.
    const result = ok(refundAllocation({ purchase: q("JPY", "1200"), refunds: [] }));
    expect(quantityText(result.net)).toBe("1200");
    expect(result.exceptions).toEqual([]);
  });
});

describe("SC04 instalments", () => {
  interface Sc04Fixture {
    unitRef: string;
    obligation: { ref: string; outstanding: { unitRef: string } };
    schedule: { principal: string; fee: string; status: "confirmed" | "projected" }[];
    payments: { ref: string; allocations: Allocation[] }[];
  }

  test("8,000 principal remains, fee 100 confirmed is not the 200 planned (AT15, AT16)", () => {
    const fixture = loadFixture<Sc04Fixture>("v2/sc04-installments.json");
    const payment = fixture.payments[0]!;
    const principal = payment.allocations.find((a) => a.role === "principal")!;
    const settlements: SettlementRelation[] = [
      {
        settlementId: "settle:1",
        obligationId: "obligation:1",
        settlementComponentRef: payment.ref,
        allocated: principal.quantity,
        occurred: today,
        unresolvedDifference: null,
        decisionRevisionRef: "rev:1",
      },
    ];
    const result = ok(settlementCheck({ outstanding: q("JPY", "12000"), settlements }));
    expect(quantityText(result.remaining)).toBe("8000");
    expect(result.state).toBe("partially-settled");
    expect(result.unresolvedDifferences).toEqual([]);
    // A confirmed fee and a planned one are separate figures.
    const confirmed = sumDecimals(
      fixture.schedule.filter((s) => s.status === "confirmed").map((s) => decimalLiteral(s.fee)),
    );
    const projected = sumDecimals(
      fixture.schedule.filter((s) => s.status === "projected").map((s) => decimalLiteral(s.fee)),
    );
    expect(confirmed).toEqual(integerDecimal(100));
    expect(projected).toEqual(integerDecimal(200));
    // Paying 4,100 does not settle 4,100 of principal.
    expect(
      settlementCheck({
        outstanding: q("JPY", "12000"),
        settlements: [{ ...settlements[0]!, allocated: q("JPY", "12001") }],
      }),
    ).toMatchObject({ ok: false, error: { code: "allocation_exceeds_limit" } });
  });

  test("an obligation revision states the evidence for its state", () => {
    expect(
      validObligationRevision({
        obligationId: "obligation:1",
        revision: 1,
        creditorRef: "party:issuer",
        debtorRef: "party:self",
        principal: q("JPY", "12000"),
        feeComponents: [{ code: "instalment-fee", quantity: q("JPY", "100"), confirmed: true }],
        schedule: [
          {
            sequence: 1,
            due: today,
            principal: q("JPY", "4000"),
            fee: q("JPY", "100"),
            status: "confirmed",
          },
        ],
        state: "partially-settled",
        unknownReason: null,
        stateEvidenceRefs: ["transaction:1"],
        decisionRevisionRef: "rev:1",
        supersededBy: null,
      }),
    ).toBe(true);
    // `unknown` without a reason is refused.
    expect(
      validObligationRevision({
        obligationId: "obligation:1",
        revision: 1,
        creditorRef: "party:issuer",
        debtorRef: "party:self",
        principal: q("JPY", "12000"),
        feeComponents: [],
        schedule: [],
        state: "unknown",
        unknownReason: null,
        stateEvidenceRefs: [],
        decisionRevisionRef: "rev:1",
        supersededBy: null,
      }),
    ).toBe(false);
  });
});

describe("SC05 cross-currency transfer", () => {
  const legs: EconomicLeg[] = [
    leg("ev:transfer", 0, "account:aud", "AUD", "1005", "decrease"),
    leg("ev:transfer", 1, "account:aud", "AUD", "5", "fee"),
    leg("ev:transfer", 2, "account:jpy", "JPY", "95000", "increase"),
  ];

  test("cross-unit legs are reported per unit and never forced to zero (AT20)", () => {
    const result = ok(conservationCheck({ legs }));
    expect(result.crossUnit).toBe(true);
    expect(result.reasonCodes).toContain("cross_unit_requires_fx_model");
    expect(result.unresolvedDifference).toBeNull();
    expect(result.units.map((unit) => unit.unitRef)).toEqual(["AUD", "JPY"]);
    // The AUD side is 1,005 out with a 5 fee; the JPY side is 95,000 in. The
    // two are never added.
    expect(quantityText(result.units[0]!.decrease)).toBe("1005");
    expect(quantityText(result.units[0]!.fees)).toBe("5");
    expect(quantityText(result.units[1]!.increase)).toBe("95000");
  });

  test("the effective rate is 95 and the 2,000 reference gap is an estimate, not a fee (AT21)", () => {
    const rate = ok(effectiveRate({ principal: q("AUD", "1000"), received: q("JPY", "95000") }));
    expect(rate.rate).toEqual({ unitRef: "JPY/AUD", value: integerDecimal(95) });
    const difference = ok(
      referenceQuoteDifference({
        principal: q("AUD", "1000"),
        referenceRate: decimalLiteral("97"),
        received: q("JPY", "95000"),
        referenceRef: "quote:synthetic",
      }),
    );
    expect(difference.difference.kind).toBe("estimate");
    expect(quantityText(difference.difference.quantity)).toBe("2000");
    // Changing only the reference quote never changes the explicit fee.
    const other = ok(
      referenceQuoteDifference({
        principal: q("AUD", "1000"),
        referenceRate: decimalLiteral("100"),
        received: q("JPY", "95000"),
        referenceRef: "quote:synthetic-2",
      }),
    );
    expect(quantityText(other.difference.quantity)).toBe("5000");
    expect(quantityText(ok(conservationCheck({ legs })).units[0]!.fees)).toBe("5");
  });

  test("an unconfirmed arrival is not a credited transfer (AT22)", () => {
    const debited = {
      eventId: "ev:transfer",
      revision: 1,
      kind: "transfer" as const,
      state: "debited" as const,
      unknownReason: null,
      effectiveTime: today,
      basis: "cash-movement" as const,
      evidenceSupport: [{ kind: "transaction" as const, id: "transaction:1", revision: "pr:1" }],
      decisionRevisionRef: "rev:1",
      supersededBy: null,
      legs: [legs[0]!, legs[1]!],
    };
    expect(validEconomicEventRevision(debited)).toBe(true);
    expect(debited.state).not.toBe("credited");
    expect(eventTransition("transfer", "debited", "credited")).toEqual({ ok: true });
    // The receiving leg exists as an in-transit claim, but no state says it arrived.
    expect(eventTransition("transfer", "requested", "credited")).toMatchObject({
      reasonCode: "transition_not_defined",
    });
  });
});

describe("SC10 platform sales, fee and payout", () => {
  test("payout and bank credit are two evidences of one settlement (AT55)", () => {
    const sale = [leg("ev:sale", 0, "account:platform", "JPY", "10000", "increase")];
    const fee = [leg("ev:fee", 0, "account:platform", "JPY", "300", "fee")];
    const payoutLegs = [
      leg("ev:payout", 0, "account:platform", "JPY", "9700", "decrease"),
      leg("ev:payout", 1, "account:bank", "JPY", "9700", "increase"),
    ];
    const payout = {
      eventId: "ev:payout",
      revision: 1,
      kind: "platform_payout" as const,
      state: "credited" as const,
      unknownReason: null,
      effectiveTime: today,
      basis: "cash-movement" as const,
      // One settlement, two reports of it: the platform payout row and the
      // bank credit row. Two evidences never become two events (SC10).
      evidenceSupport: [
        { kind: "transaction" as const, id: "transaction:10", revision: "pr:1" },
        { kind: "transaction" as const, id: "transaction:11", revision: "pr:2" },
      ],
      decisionRevisionRef: "rev:1",
      supersededBy: null,
      legs: payoutLegs,
    };
    expect(validEconomicEventRevision(payout)).toBe(true);
    expect(payout.evidenceSupport).toHaveLength(2);
    expect(quantityText(ok(conservationCheck({ legs: payoutLegs })).unresolvedDifference)).toBe(
      "0",
    );
    // Sales 10,000, expense 300, net 9,700; the payout adds no revenue.
    const revenue = ok(legTotal([...sale], { unitRef: "JPY", role: "increase" })).quantity;
    const expense = ok(legTotal([...fee], { unitRef: "JPY", role: "fee" })).quantity;
    expect(quantityText(revenue)).toBe("10000");
    expect(quantityText(expense)).toBe("300");
    expect(subtractDecimals(exact(revenue), exact(expense))).toEqual(integerDecimal(9700));
    // Platform balance ends at zero: +10,000 − 300 − 9,700.
    const platform = [...sale, ...fee, ...payoutLegs].filter(
      (entry) => entry.subjectRef === "account:platform",
    );
    const movement = subtractDecimals(
      exact(ok(legTotal(platform, { unitRef: "JPY", role: "increase" })).quantity),
      sumDecimals([
        exact(ok(legTotal(platform, { unitRef: "JPY", role: "fee" })).quantity),
        exact(ok(legTotal(platform, { unitRef: "JPY", role: "decrease" })).quantity),
      ]),
    );
    expect(movement).toEqual(integerDecimal(0));
  });
});

describe("conservation, fills and settlement relations", () => {
  test("a single-unit event must balance, and the gap is reported rather than hidden", () => {
    const unbalanced = [
      leg("ev:x", 0, "account:a", "JPY", "1000", "decrease"),
      leg("ev:x", 1, "account:b", "JPY", "900", "increase"),
    ];
    expect(conservationCheck({ legs: unbalanced })).toMatchObject({
      ok: false,
      error: { code: "conservation_violated" },
    });
    const declared = ok(
      conservationCheck({ legs: unbalanced, unresolvedDifference: q("JPY", "100") }),
    );
    expect(quantityText(declared.unresolvedDifference)).toBe("100");
  });

  test("a leg without an exact amount is never treated as zero (INV05)", () => {
    const absent: EconomicLeg = {
      eventId: "ev:x",
      revision: 1,
      legIndex: 0,
      subjectRef: "account:a",
      quantity: { unitRef: "JPY", value: { status: "missing", reasonCode: "not_reported" } },
      role: "decrease",
      basis: "cash-movement",
    };
    expect(conservationCheck({ legs: [absent] })).toMatchObject({
      ok: false,
      error: { code: "value_not_exact" },
    });
  });

  test("fills never exceed the executed quantity", () => {
    const fill = (id: string, quantity: string): Allocation => ({
      allocationId: id,
      sourceRef: "order:1",
      targetRef: "execution:1",
      role: "fill",
      quantity: q("share:synthetic", quantity),
    });
    expect(
      quantityText(
        ok(
          splitFillCheck({
            executedQuantity: q("share:synthetic", "10"),
            fills: [fill("f1", "6"), fill("f2", "4")],
          }),
        ).remaining,
      ),
    ).toBe("0");
    expect(
      splitFillCheck({
        executedQuantity: q("share:synthetic", "10"),
        fills: [fill("f1", "6"), fill("f2", "5")],
      }),
    ).toMatchObject({ ok: false, error: { code: "allocation_exceeds_limit" } });
  });

  test("a settlement keeps its unresolved difference beside it, not inside the principal", () => {
    const settlement: SettlementRelation = {
      settlementId: "settle:1",
      obligationId: "obligation:1",
      settlementComponentRef: "leg:ev:pay#0",
      allocated: q("JPY", "4000"),
      occurred: today,
      unresolvedDifference: q("JPY", "12"),
      decisionRevisionRef: "rev:1",
    };
    expect(validSettlementRelation(settlement)).toBe(true);
    const result = ok(
      settlementCheck({ outstanding: q("JPY", "12000"), settlements: [settlement] }),
    );
    expect(quantityText(result.remaining)).toBe("8000");
    expect(result.unresolvedDifferences.map(quantityText)).toEqual(["12"]);
  });
});

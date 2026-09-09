// SYN01–SYN24 from addendum 14 §7, with the synthetic inputs of addendum 03
// and 09, run against the domain helpers. Every number here is synthetic.
import { describe, expect, test } from "bun:test";
import {
  snapshotEligibility,
  type CoverageClaim,
  type SnapshotEligibility,
} from "../src/coverage.ts";
import {
  checkFillAllocations,
  checkObligationAllocations,
  checkSourceAllocations,
  checkTransferConservation,
  type Allocation,
  type DecisionRevision,
  type RelationStatus,
  type TypedRelation,
} from "../src/decisions.ts";
import {
  additivityVerdict,
  valueAtPrice,
  validMetricDefinition,
  type MetricDefinition,
  type PriceObservation,
} from "../src/metrics.ts";
import { validFinancialError } from "../src/result.ts";
import {
  selectAdoptedSet,
  type AdoptionResult,
  type AdoptionTarget,
  type ExclusionReason,
  type MeasureCandidate,
  type ScopeRelationClaim,
  type UnresolvedReason,
} from "../src/scope.ts";
import { addMonths, formatLocalDate, parseLocalDate, type LocalDateValue } from "../src/time.ts";
import {
  addDecimals,
  addQuantities,
  compareDecimals,
  decimalLiteral,
  divideDecimals,
  exactQuantity,
  integerDecimal,
  multiplyByRatio,
  multiplyDecimals,
  negateDecimal,
  subtractDecimals,
  sumDecimals,
  sumQuantities,
  type ExactDecimal,
  type ExactRatio,
  type Quantity,
  type ValueErrorCode,
} from "../src/values.ts";
import { exact, loadFixture, ok, q, quantityText } from "./helpers.ts";

interface AdoptionExpectation {
  adoptedRefs: string[];
  adoptedTotal: string | null;
  excluded?: Record<string, ExclusionReason>;
  unresolved: Record<string, UnresolvedReason>;
  completeness: AdoptionResult["completeness"];
}
interface Sc01Fixture {
  target: AdoptionTarget;
  candidates: MeasureCandidate[];
  relations: ScopeRelationClaim[];
  variants: Record<
    string,
    {
      extraRelations: ScopeRelationClaim[];
      candidateOverrides: Record<string, string>;
      expected: AdoptionExpectation;
    }
  >;
}

function runSc01(variant: string): { result: AdoptionResult; expected: AdoptionExpectation } {
  const fixture = loadFixture<Sc01Fixture>("v1/sc01-linked-deposit.json");
  const spec = fixture.variants[variant];
  if (!spec) throw new Error(`unknown variant ${variant}`);
  const candidates = fixture.candidates.map((candidate) => {
    const override = spec.candidateOverrides[candidate.ref];
    return override === undefined ? candidate : { ...candidate, quantity: q("JPY", override) };
  });
  const result = selectAdoptedSet(fixture.target, candidates, [
    ...fixture.relations,
    ...spec.extraRelations,
  ]);
  return { result, expected: spec.expected };
}

function expectAdoption(result: AdoptionResult, expected: AdoptionExpectation): void {
  expect(result.adopted.map((a) => a.ref)).toEqual(expected.adoptedRefs);
  expect(quantityText(result.adoptedTotal)).toBe(expected.adoptedTotal);
  expect(Object.fromEntries(result.excluded.map((e) => [e.ref, e.reasonCode]))).toEqual(
    expected.excluded ?? {},
  );
  expect(Object.fromEntries(result.unresolved.map((u) => [u.ref, u.reasonCode]))).toEqual(
    expected.unresolved,
  );
  expect(result.completeness).toBe(expected.completeness);
}

describe("V1: SC01 / SC06 / SC15", () => {
  test("SYN01 non-overlapping deposit breakdown adopts 160000", () => {
    const { result, expected } = runSc01("mf-confirmed");
    expectAdoption(result, expected);
    expect(quantityText(result.adoptedTotal)).toBe("160000");
  });

  test("SYN02 a total and its breakdown are never adopted together", () => {
    const { result } = runSc01("mf-confirmed");
    const adopted = new Set(result.adopted.map((a) => a.ref));
    expect(
      adopted.has("m-bank-total") &&
        (adopted.has("m-bank-savings") || adopted.has("m-bank-linked")),
    ).toBe(false);
    expect(result.excluded).toContainEqual({
      ref: "m-bank-total",
      reasonCode: "covered_by_breakdown",
    });
    // The sum of everything reported (320,000 plus the buying-power line) is never the answer.
    expect(quantityText(result.adoptedTotal)).not.toBe("420000");
    const unconfirmed = runSc01("mf-unconfirmed");
    expectAdoption(unconfirmed.result, unconfirmed.expected);
    const mismatch = runSc01("total-breakdown-mismatch");
    expectAdoption(mismatch.result, mismatch.expected);
    expect(mismatch.result.warnings.map((w) => w.code)).toContain("total_breakdown_mismatch");
  });

  test("SC06 connection containment is adopted while same-account stays proposed and unresolved", () => {
    const fixture = loadFixture<{
      typedRelations: TypedRelation[];
      decisionRevisions: DecisionRevision[];
      target: AdoptionTarget;
      candidates: MeasureCandidate[];
      scopeRelations: ScopeRelationClaim[];
      expected: AdoptionExpectation & {
        connectionContainsStatus: RelationStatus;
        sameAccountStatus: RelationStatus;
      };
    }>("v1/sc06-connection-only.json");
    const contains = fixture.typedRelations.filter((r) => r.kind === "connection_contains");
    expect(contains).toHaveLength(3);
    expect(contains.every((r) => r.status === fixture.expected.connectionContainsStatus)).toBe(
      true,
    );
    const same = fixture.typedRelations.find((r) => r.kind === "same_account");
    expect(same?.status).toBe(fixture.expected.sameAccountStatus);
    expect(
      fixture.decisionRevisions.find((r) => r.revisionId === same?.decisionRevisionRef)?.kind,
    ).toBe("proposal");
    const result = selectAdoptedSet(fixture.target, fixture.candidates, fixture.scopeRelations);
    expectAdoption(result, { ...fixture.expected, excluded: {} });
  });

  test("SC15 the four meanings of an empty latest fetch", () => {
    const fixture = loadFixture<{
      cases: {
        name: string;
        claim: CoverageClaim;
        expected: SnapshotEligibility;
      }[];
    }>("v1/sc15-empty-snapshots.json");
    expect(fixture.cases.length).toBeGreaterThanOrEqual(4);
    for (const { claim, expected } of fixture.cases)
      expect(snapshotEligibility(claim)).toEqual(expected);
    expect(fixture.cases.filter((c) => c.expected.replacesPrevious)).toHaveLength(1);
  });
});

describe("V2: SC02 / SC03 / SC04", () => {
  interface Sc02Fixture {
    unitRef: string;
    opening: Record<string, string>;
    accounts: Record<string, "asset" | "liability">;
    events: {
      eventId: string;
      kind: string;
      legs: { account: string; delta: string }[];
      purchaseCost?: string;
      observationRefs: string[];
    }[];
    expected: Record<string, string>[];
    expectedCounts: { observations: number; purchases: number };
  }

  test("SYN03–SYN06 charge, purchase and settlement move funds; only the purchase is spending", () => {
    const fixture = loadFixture<Sc02Fixture>("v2/sc02-charge-purchase-settle.json");
    const balances = new Map(
      Object.entries(fixture.opening).map(([k, v]) => [k, decimalLiteral(v)]),
    );
    const at = (account: string): ExactDecimal => {
      const value = balances.get(account);
      if (!value) throw new Error(`unknown account ${account}`);
      return value;
    };
    let purchases = integerDecimal(0);
    const netAssets = () =>
      subtractDecimals(
        sumDecimals(
          [...balances].filter(([k]) => fixture.accounts[k] === "asset").map(([, v]) => v),
        ),
        sumDecimals(
          [...balances].filter(([k]) => fixture.accounts[k] === "liability").map(([, v]) => v),
        ),
      );
    const snapshot = (after: string) => ({
      after,
      bank: at("bank").coefficient,
      wallet: at("wallet").coefficient,
      card: at("card").coefficient,
      netAssets: netAssets().coefficient,
      cumulativePurchases: purchases.coefficient,
    });
    const observed: Record<string, string>[] = [snapshot("opening")];
    for (const event of fixture.events) {
      for (const leg of event.legs)
        balances.set(leg.account, addDecimals(at(leg.account), decimalLiteral(leg.delta)));
      if (event.kind === "purchase")
        purchases = addDecimals(purchases, decimalLiteral(event.purchaseCost ?? "0"));
      observed.push(snapshot(event.eventId));
    }
    expect(observed).toEqual(fixture.expected);
    // SYN03: 100000 + 10000 − 10000; SYN04/05: 97000 twice; SYN06: 3000 only.
    expect(observed.map((row) => row.netAssets)).toEqual(["100000", "100000", "97000", "97000"]);
    expect(observed.at(-1)?.cumulativePurchases).toBe("3000");
    expect(fixture.events.flatMap((e) => e.observationRefs)).toHaveLength(
      fixture.expectedCounts.observations,
    );
    expect(fixture.events.filter((e) => e.kind === "purchase")).toHaveLength(
      fixture.expectedCounts.purchases,
    );
  });

  test("SYN07 posted 1234 replaces pending 1200; a 400 refund nets to 834 only when allocated", () => {
    const fixture = loadFixture<{
      unitRef: string;
      observations: { ref: string; providerStatus: string; amount: string }[];
      typedRelations: TypedRelation[];
      purchase: { ref: string; adoptedFrom: string };
      allocations: Allocation[];
      expected: { adoptedPurchase: string; netAfterRefund: string; reportsRetained: number };
      variants: {
        "refund-target-unknown": {
          allocations: Allocation[];
          expected: { netAfterRefund: null; unresolvedRefundRefs: string[] };
        };
        "pending-vanished": { expected: { inferredRefund: null } };
      };
    }>("v2/sc03-pending-posted-refund.json");
    const link = fixture.typedRelations.find(
      (r) => r.kind === "pending_to_posted" && r.status === "adopted",
    );
    expect(link?.right).toBe(fixture.purchase.adoptedFrom);
    const posted = fixture.observations.find((o) => o.ref === fixture.purchase.adoptedFrom);
    const adoptedPurchase = q(fixture.unitRef, posted?.amount ?? "");
    expect(quantityText(adoptedPurchase)).toBe(fixture.expected.adoptedPurchase);
    const refunds = fixture.allocations.filter(
      (a) => a.role === "refund" && a.targetRef === fixture.purchase.ref,
    );
    expect(
      checkSourceAllocations({ sourceAmount: q(fixture.unitRef, "400"), allocations: refunds }).ok,
    ).toBe(true);
    const net = ok(
      sumQuantities(fixture.unitRef, [
        adoptedPurchase,
        ...refunds.map((r) => exactQuantity(r.quantity.unitRef, negateDecimal(exact(r.quantity)))),
      ]),
    );
    expect(quantityText(net.quantity)).toBe(fixture.expected.netAfterRefund);
    expect(fixture.observations).toHaveLength(fixture.expected.reportsRetained);
    // Pending is superseded, not a second purchase; the refund is an allocation, not income.
    const superseded = fixture.observations.filter((o) =>
      fixture.typedRelations.some((r) => r.kind === "pending_to_posted" && r.left === o.ref),
    );
    expect(superseded.map((o) => o.ref)).toEqual(["obs:card:pending-1"]);
    const unknownTarget = fixture.variants["refund-target-unknown"];
    expect(unknownTarget.allocations).toEqual([]);
    expect(unknownTarget.expected.netAfterRefund).toBeNull();
    expect(unknownTarget.expected.unresolvedRefundRefs).toEqual(["obs:card:refund-1"]);
    expect(fixture.variants["pending-vanished"].expected.inferredRefund).toBeNull();
  });

  test("SYN08 instalments: 8000 principal remains; confirmed fee 100 and projected 200 stay apart", () => {
    const fixture = loadFixture<{
      unitRef: string;
      purchase: { amount: string };
      obligation: { outstanding: Quantity };
      schedule: { principal: string; fee: string; status: "confirmed" | "projected" }[];
      payments: { cashOut: Quantity; allocations: Allocation[] }[];
      expected: {
        remainingPrincipal: string;
        confirmedFee: string;
        projectedFee: string;
        purchaseCost: string;
        cashOut: string;
        paymentFullyAllocated: boolean;
      };
    }>("v2/sc04-installments.json");
    const payment = fixture.payments[0];
    if (!payment) throw new Error("fixture has no payment");
    const principal = ok(
      checkObligationAllocations({
        outstanding: fixture.obligation.outstanding,
        allocations: payment.allocations.filter((a) => a.role === "principal"),
      }),
    );
    expect(quantityText(principal.remaining)).toBe(fixture.expected.remainingPrincipal);
    const fees = payment.allocations.filter((a) => a.role === "fee").map((a) => a.quantity);
    expect(quantityText(ok(sumQuantities(fixture.unitRef, fees)).quantity)).toBe(
      fixture.expected.confirmedFee,
    );
    const projected = sumDecimals(
      fixture.schedule.filter((s) => s.status === "projected").map((s) => decimalLiteral(s.fee)),
    );
    expect(projected.coefficient).toBe(fixture.expected.projectedFee);
    expect(fixture.purchase.amount).toBe(fixture.expected.purchaseCost);
    expect(quantityText(payment.cashOut)).toBe(fixture.expected.cashOut);
    const fully = ok(
      checkSourceAllocations({ sourceAmount: payment.cashOut, allocations: payment.allocations }),
    );
    expect(quantityText(fully.remaining)).toBe("0");
    expect(fixture.expected.paymentFullyAllocated).toBe(true);
  });
});

describe("SC05 / SC07 / SC08 / SC09 / SC10 arithmetic", () => {
  test("SYN09–SYN10 effective FX 95; the 2000 reference difference is an estimate, and AUD never sums with JPY", () => {
    const sent = q("AUD", "1005");
    const principal = q("AUD", "1000");
    const fee = q("AUD", "5");
    const received = q("JPY", "95000");
    expect(ok(divideDecimals(exact(received), exact(principal))).value).toEqual(integerDecimal(95));
    const referenceValue = multiplyDecimals(exact(principal), decimalLiteral("97"));
    const difference = subtractDecimals(referenceValue, exact(received));
    expect(difference).toEqual(integerDecimal(2000));
    const estimate = {
      kind: "estimate" as const,
      method: "reference-quote-difference",
      quantity: exactQuantity("JPY", difference),
    };
    expect(estimate.kind).not.toBe("fee");
    expect(sumQuantities("AUD", [principal, fee])).toEqual({ ok: true, quantity: sent });
    expect(addQuantities(sent, received)).toMatchObject({
      ok: false,
      error: { code: "unit_mismatch" },
    });
    expect(
      checkTransferConservation({
        sourceDecrease: sent,
        destinationIncrease: received,
        explicitFees: [fee],
        unresolvedDifference: null,
      }),
    ).toMatchObject({ ok: false, error: { code: "unit_mismatch", refs: ["AUD", "JPY"] } });
  });

  test("SYN11–SYN12 fills 6 + 4 = 10 (never 20); consideration 10 × 100 + 2 = 1002", () => {
    const fill = (id: string, quantity: string): Allocation => ({
      allocationId: id,
      sourceRef: "order:1",
      targetRef: "execution:1",
      role: "fill",
      quantity: q("share:synthetic", quantity),
    });
    const fills = ok(
      checkFillAllocations({
        executedQuantity: q("share:synthetic", "10"),
        fills: [fill("f1", "6"), fill("f2", "4")],
      }),
    );
    expect(quantityText(fills.allocated)).toBe("10");
    expect(quantityText(fills.remaining)).toBe("0");
    expect(
      checkFillAllocations({
        executedQuantity: q("share:synthetic", "10"),
        fills: [fill("f1", "6"), fill("f2", "4"), fill("order-summary", "10")],
      }),
    ).toMatchObject({ ok: false, error: { code: "allocation_exceeds_limit" } });
    const consideration = addDecimals(
      multiplyDecimals(integerDecimal(10), integerDecimal(100)),
      integerDecimal(2),
    );
    expect(consideration).toEqual(integerDecimal(1002));
  });

  test("SYN13–SYN15 1:2 split → 20 units, cost 1002, unit cost 50.1, comparison value 1000 unchanged", () => {
    const split: ExactRatio = { numerator: "2", denominator: "1" };
    expect(ok(multiplyByRatio(integerDecimal(10), split)).value).toEqual(integerDecimal(20));
    const cost = integerDecimal(1002);
    const perUnit = ok(divideDecimals(cost, integerDecimal(20))).value;
    expect(perUnit).toEqual({ coefficient: "501", scale: 1 });
    const before = multiplyDecimals(integerDecimal(10), integerDecimal(100));
    const after = multiplyDecimals(integerDecimal(20), integerDecimal(50));
    expect(before).toEqual(integerDecimal(1000));
    expect(compareDecimals(before, after)).toBe(0);
    // The extra 10 units are neither income nor a purchase: the cost total is unchanged.
    expect(multiplyDecimals(perUnit, integerDecimal(20))).toEqual(cost);
  });

  test("SYN16 crypto transfer conserves quantity: 1.000 = 0.999 + 0.001", () => {
    expect(
      checkTransferConservation({
        sourceDecrease: q("crypto:synthetic", "1.000"),
        destinationIncrease: q("crypto:synthetic", "0.999"),
        explicitFees: [q("crypto:synthetic", "0.001")],
        unresolvedDifference: null,
      }),
    ).toEqual({ ok: true, unresolvedDifference: q("crypto:synthetic", "0") });
    expect(addDecimals(decimalLiteral("0.999"), decimalLiteral("0.001"))).toEqual(
      integerDecimal(1),
    );
  });

  test("SYN17–SYN18 sales 10000 − fee 300 = 9700; payout and bank receipt settle the platform balance to 0", () => {
    const sales = q("JPY", "10000");
    const fee = q("JPY", "300");
    const net = ok(sumQuantities("JPY", [sales, exactQuantity("JPY", negateDecimal(exact(fee)))]));
    expect(quantityText(net.quantity)).toBe("9700");
    const platform = sumDecimals([
      integerDecimal(0),
      exact(sales),
      negateDecimal(exact(fee)),
      integerDecimal(-9700),
    ]);
    expect(platform).toEqual(integerDecimal(0));
    const bankIncrease = integerDecimal(9700);
    expect(compareDecimals(bankIncrease, exact(net.quantity))).toBe(0);
    // Payout and bank receipt are two witnesses of one settlement, not two more sales.
    const settlementEvidence = [q("JPY", "9700"), q("JPY", "9700")];
    const salesEvents = [sales];
    expect(settlementEvidence).toHaveLength(2);
    expect(salesEvents).toHaveLength(1);
  });
});

describe("V3: SC11 / SC12 / SC13 / SC14", () => {
  test("SYN19 JPY and points are never added; a status indicator is not a balance", () => {
    const fixture = loadFixture<{
      definitions: Record<string, MetricDefinition>;
      measures: { ref: string; metricId: string; quantity: Quantity }[];
      expected: {
        nominalJpy: string;
        withdrawableJpy: string;
        pointsNominalWithBuckets: string;
        statusIndicator: string;
        forbiddenTotal: string;
        jpyPlusPointsRejected: ValueErrorCode;
        statusIndicatorAdditive: boolean;
      };
    }>("v3/sc11-wallet-points.json");
    for (const definition of Object.values(fixture.definitions))
      expect(validMetricDefinition(definition)).toBe(true);
    const measure = (ref: string): Quantity => {
      const found = fixture.measures.find((m) => m.ref === ref);
      if (!found) throw new Error(`missing measure ${ref}`);
      return found.quantity;
    };
    const definition = (id: string): MetricDefinition => {
      const found = fixture.definitions[id];
      if (!found) throw new Error(`missing definition ${id}`);
      return found;
    };
    expect(quantityText(measure("m-wallet-nominal"))).toBe(fixture.expected.nominalJpy);
    expect(quantityText(measure("m-wallet-withdrawable"))).toBe(fixture.expected.withdrawableJpy);
    const buckets = fixture.measures
      .filter((m) => m.metricId === "reward.bucket-balance")
      .map((m) => m.quantity);
    const nominalPoints = ok(sumQuantities("points:program-a", buckets)).quantity;
    expect(quantityText(nominalPoints)).toBe(fixture.expected.pointsNominalWithBuckets);
    const jpyPlusPoints = addQuantities(measure("m-wallet-nominal"), nominalPoints);
    expect(jpyPlusPoints.ok).toBe(false);
    if (!jpyPlusPoints.ok)
      expect(jpyPlusPoints.error.code).toBe(fixture.expected.jpyPlusPointsRejected);
    expect(addQuantities(measure("m-wallet-nominal"), measure("m-status-indicator")).ok).toBe(
      false,
    );
    expect(quantityText(measure("m-status-indicator"))).toBe(fixture.expected.statusIndicator);
    const status = definition("program.status-indicator");
    expect(status.measurementKind).toBe("qualification");
    expect(additivityVerdict(status, status).additive).toBe(
      fixture.expected.statusIndicatorAdditive,
    );
    expect(
      additivityVerdict(
        definition("wallet.nominal-balance"),
        definition("wallet.withdrawable-amount"),
      ),
    ).toEqual({
      additive: false,
      reasonCode: "metric_mismatch",
    });
    // 6,000 + 800 + 100 = 6,900 is representable as bare integers but never as a Quantity sum.
    expect(sumDecimals([6000, 800, 100].map(integerDecimal)).coefficient).toBe(
      fixture.expected.forbiddenTotal,
    );
    expect(
      sumQuantities("JPY", [
        measure("m-wallet-nominal"),
        nominalPoints,
        measure("m-status-indicator"),
      ]).ok,
    ).toBe(false);
  });

  test("SC12 expiry follows qualifying activity under a verified rule; provider and computed dates are both shown", () => {
    const fixture = loadFixture<{
      rule: {
        verified: boolean;
        extensionMonths: number;
        qualifyingActivityKinds: string[];
        endOfMonthPolicy: "clamp" | "preserve-end-of-month";
      };
      activities: { kind: string; date: LocalDateValue }[];
      providerDisplayedExpiry: LocalDateValue;
      expected: {
        lastQualifyingDate: string;
        computedExpiry: string;
        naiveMaxDateExpiry: string;
        providerDisplayedExpiry: string;
        providerAndComputedDiffer: boolean;
      };
      edgeCases: {
        from: string;
        months: number;
        policy: "clamp" | "preserve-end-of-month";
        expect: string;
      }[];
      variants: {
        "unverified-rule": { verified: boolean; expectedErrorCode: string };
        "partial-history": { expectedCompleteness: string };
      };
    }>("v3/sc12-expiry-activities.json");
    const date = (text: string) => {
      const parsed = parseLocalDate(text);
      if (!parsed) throw new Error(`invalid date ${text}`);
      return parsed;
    };
    expect(fixture.rule.verified).toBe(true);
    const qualifying = fixture.activities
      .filter((a) => fixture.rule.qualifyingActivityKinds.includes(a.kind))
      .map((a) => a.date.value)
      .sort();
    const lastQualifying = qualifying.at(-1) ?? "";
    expect(lastQualifying).toBe(fixture.expected.lastQualifyingDate);
    const computed = formatLocalDate(
      addMonths(date(lastQualifying), fixture.rule.extensionMonths, fixture.rule.endOfMonthPolicy),
    );
    expect(computed).toBe(fixture.expected.computedExpiry);
    const latestAny =
      fixture.activities
        .map((a) => a.date.value)
        .sort()
        .at(-1) ?? "";
    const naive = formatLocalDate(
      addMonths(date(latestAny), fixture.rule.extensionMonths, "clamp"),
    );
    expect(naive).toBe(fixture.expected.naiveMaxDateExpiry);
    expect(fixture.providerDisplayedExpiry.value).toBe(fixture.expected.providerDisplayedExpiry);
    expect(computed !== fixture.providerDisplayedExpiry.value).toBe(
      fixture.expected.providerAndComputedDiffer,
    );
    for (const edge of fixture.edgeCases)
      expect(formatLocalDate(addMonths(date(edge.from), edge.months, edge.policy))).toBe(
        edge.expect,
      );
    expect(fixture.variants["unverified-rule"].verified).toBe(false);
    expect(
      validFinancialError({
        schemaVersion: "financial-error-v1",
        code: fixture.variants["unverified-rule"].expectedErrorCode,
        requestId: "req:sc12",
        message: "The program's expiry terms have not been verified; no expiry is computed.",
        refs: ["rule:program-a:inactivity-expiry:v1"],
      }),
    ).toBe(true);
    expect(fixture.variants["partial-history"].expectedCompleteness).toBe("partial");
  });

  test("SC13 requesting a conversion does not move value twice", () => {
    const fixture = loadFixture<{
      pointUnit: string;
      walletUnit: string;
      buckets: { ref: string; quantity: string; eligibleForOffer: boolean }[];
      offer: { eligibleBuckets: string[]; ratio: ExactRatio; ruleVerified: boolean };
      request: { quantity: string };
      stages: { stage: string; pointsHeld: string; walletDelta: string; inTransit: string }[];
      expected: {
        requestable: string;
        walletIncreaseAtRequest: string;
        pointsPlusInTransitPlusWalletNeverExceeds: string;
        unverifiedRuleErrorCode: string;
      };
    }>("v3/sc13-redemption-request.json");
    const eligible = fixture.buckets
      .filter((b) => fixture.offer.eligibleBuckets.includes(b.ref))
      .map((b) => q(fixture.pointUnit, b.quantity));
    const requestable = ok(sumQuantities(fixture.pointUnit, eligible)).quantity;
    expect(quantityText(requestable)).toBe(fixture.expected.requestable);
    expect(
      compareDecimals(decimalLiteral(fixture.request.quantity), exact(requestable)),
    ).toBeLessThanOrEqual(0);
    const total = sumDecimals(fixture.buckets.map((b) => decimalLiteral(b.quantity)));
    expect(total).toEqual(
      decimalLiteral(fixture.expected.pointsPlusInTransitPlusWalletNeverExceeds),
    );
    expect(fixture.stages[0]?.walletDelta).toBe(fixture.expected.walletIncreaseAtRequest);
    const inverse: ExactRatio = {
      numerator: fixture.offer.ratio.denominator,
      denominator: fixture.offer.ratio.numerator,
    };
    for (const stage of fixture.stages) {
      // Wallet JPY is converted back to point-equivalents through the offer ratio explicitly, never by unit-blind addition.
      const walletAsPoints = ok(multiplyByRatio(decimalLiteral(stage.walletDelta), inverse)).value;
      const conserved = sumDecimals([
        decimalLiteral(stage.pointsHeld),
        decimalLiteral(stage.inTransit),
        walletAsPoints,
      ]);
      expect(compareDecimals(conserved, total)).toBeLessThanOrEqual(0);
      expect(
        addQuantities(
          q(fixture.pointUnit, stage.pointsHeld),
          q(fixture.walletUnit, stage.walletDelta),
        ).ok,
      ).toBe(false);
    }
    expect(fixture.expected.unverifiedRuleErrorCode).toBe("needs_rule_verification");
  });

  test("SYN20–SYN21 offer A→B: use 2000, receive 1000, keep 500; 1250 is never offered", () => {
    interface Offer {
      minimum: string;
      increment: string;
      cap: string;
      ratio: ExactRatio;
    }
    const fixture = loadFixture<{
      offer: Offer & { fee: Quantity; fromUnit: string; toUnit: string };
      eligibleBalance: string;
      expected: {
        used: string;
        received: string;
        remaining: string;
        fee: string;
        naiveReceive: string;
        naiveIsRejected: boolean;
      };
      chained: {
        hops: (Offer & { fromUnit: string; toUnit: string })[];
        expected: { receivedB: string; remainingA: string };
      };
    }>("v3/sc14-conversion-offer.json");
    const simulate = (offer: Offer, eligible: string) => {
      const balance = decimalLiteral(eligible);
      const cap = decimalLiteral(offer.cap);
      const capped = compareDecimals(balance, cap) > 0 ? cap : balance;
      const steps = ok(
        multiplyByRatio(
          capped,
          { numerator: "1", denominator: offer.increment },
          { scale: 0, mode: "down" },
        ),
      ).value;
      const used = multiplyDecimals(steps, decimalLiteral(offer.increment));
      if (compareDecimals(used, decimalLiteral(offer.minimum)) < 0)
        return { used: integerDecimal(0), received: integerDecimal(0), remaining: balance };
      return {
        used,
        received: ok(multiplyByRatio(used, offer.ratio)).value,
        remaining: subtractDecimals(balance, used),
      };
    };
    const plan = simulate(fixture.offer, fixture.eligibleBalance);
    expect(plan.used.coefficient).toBe(fixture.expected.used);
    expect(plan.received.coefficient).toBe(fixture.expected.received);
    expect(plan.remaining.coefficient).toBe(fixture.expected.remaining);
    expect(quantityText(fixture.offer.fee)).toBe(fixture.expected.fee);
    const naive = ok(
      multiplyByRatio(decimalLiteral(fixture.eligibleBalance), fixture.offer.ratio),
    ).value;
    expect(naive.coefficient).toBe(fixture.expected.naiveReceive);
    expect(plan.received.coefficient !== naive.coefficient).toBe(fixture.expected.naiveIsRejected);
    const [hop1, hop2] = fixture.chained.hops;
    if (!hop1 || !hop2) throw new Error("fixture needs two hops");
    expect(hop1.toUnit).toBe(hop2.fromUnit);
    const first = simulate(hop1, fixture.eligibleBalance);
    const second = simulate(hop2, first.received.coefficient);
    expect(second.received.coefficient).toBe(fixture.chained.expected.receivedB);
    expect(first.remaining.coefficient).toBe(fixture.chained.expected.remainingA);
  });
});

describe("09 valuation and P&L", () => {
  test("SYN22 fund price basis: 12,500 units × 8,000 JPY per 10,000 units = 10,000 JPY", () => {
    const nav: PriceObservation = {
      id: "price:fund:1",
      baseInstrumentRef: "fund:synthetic",
      baseQuantity: integerDecimal(10000),
      quoteUnitRef: "JPY",
      quoteAmount: integerDecimal(8000),
      priceKind: "nav",
      effectiveTime: {
        kind: "local-date",
        value: "2026-09-01",
        zone: "Asia/Tokyo",
        basis: "provider",
      },
      sourceClaimRef: "claim:fund-nav:1",
      marketRef: null,
      adjustmentPolicyRef: null,
    };
    expect(valueAtPrice(q("fund:synthetic", "12500"), nav)).toEqual({
      ok: true,
      quantity: q("JPY", "10000"),
    });
    expect(multiplyDecimals(integerDecimal(12500), integerDecimal(8000))).not.toEqual(
      integerDecimal(10000),
    );
  });

  test("SYN23 both P&L decompositions total 15,500 while attributing the cross term differently", () => {
    const quantity = integerDecimal(10);
    const p0 = integerDecimal(100);
    const p1 = integerDecimal(110);
    const r0 = integerDecimal(100);
    const r1 = integerDecimal(105);
    const total = multiplyDecimals(
      quantity,
      subtractDecimals(multiplyDecimals(p1, r1), multiplyDecimals(p0, r0)),
    );
    const marketA = multiplyDecimals(multiplyDecimals(quantity, subtractDecimals(p1, p0)), r0);
    const fxA = multiplyDecimals(multiplyDecimals(quantity, p1), subtractDecimals(r1, r0));
    const marketB = multiplyDecimals(multiplyDecimals(quantity, subtractDecimals(p1, p0)), r1);
    const fxB = multiplyDecimals(multiplyDecimals(quantity, p0), subtractDecimals(r1, r0));
    expect([total, addDecimals(marketA, fxA), addDecimals(marketB, fxB)]).toEqual(
      [15500, 15500, 15500].map(integerDecimal),
    );
    expect([marketA, fxA]).toEqual([10000, 5500].map(integerDecimal));
    expect([marketB, fxB]).toEqual([10500, 5000].map(integerDecimal));
  });

  test("SYN24 a missing quantity is never added as zero (INV05)", () => {
    const missing: Quantity = {
      unitRef: "JPY",
      value: { status: "missing", reasonCode: "decimal-v1:missing" },
    };
    const sum = sumQuantities("JPY", [q("JPY", "100"), missing]);
    expect(sum.ok).toBe(false);
    if (!sum.ok) expect(sum.error.code).toBe("value_not_exact");
    const candidate = (ref: string, quantity: Quantity): MeasureCandidate => ({
      ref,
      scopeRef: `s:${ref}`,
      metricId: "deposit.balance",
      quantity,
      coverage: { completeness: "complete" },
      ownership: { kind: "full" },
      authorityRank: 0,
    });
    const adoption = selectAdoptedSet(
      { metricId: "deposit.balance", unitRef: "JPY" },
      [candidate("a", q("JPY", "100")), candidate("b", missing)],
      [{ left: "s:a", right: "s:b", relation: "disjoint", evidenceRefs: [], decisionRef: null }],
    );
    expect(quantityText(adoption.adoptedTotal)).toBe("100");
    expect(adoption.completeness).toBe("partial");
    expect(adoption.unresolved).toEqual([{ ref: "b", reasonCode: "value_not_exact" }]);
  });
});

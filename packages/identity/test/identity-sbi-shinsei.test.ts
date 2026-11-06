// SBI Shinsei identity policy versions (ADR 0076). Golden plans for policy 1
// and policy 2 over synthetic observations shaped like the parsers' rows:
// account references keep the same plan, key and source-account digest under
// both versions; the parser's two non-account references change only their
// classification, never their key.
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { SBI_SHINSEI_CUSTOMER_ACCOUNT } from "../../parsers/src/parsers/sbi-shinsei-balance-summary-and-stage.ts";
import { SBI_SHINSEI_FX_BOARD_ACCOUNT } from "../../parsers/src/parsers/sbi-shinsei-exchange-rate.ts";
import { otherIdentity, SBI_SHINSEI_POLICY_VERSION } from "../src/other.ts";
import type { IdentityInput, IdentityPlan } from "../src/types.ts";

const SOURCE = "sbi-shinsei-bank";
const PRODUCER = "synthetic-producer";
const ACCOUNT = "sbi-shinsei:synthetic-account";

function input(sourceAccount: string, fields: Partial<IdentityInput> = {}): IdentityInput {
  return {
    kind: "valuation",
    observationId: 1,
    parseRunId: 2,
    artifactId: 3,
    fetchRunId: 4,
    sourceId: SOURCE,
    producerId: PRODUCER,
    sourceAccount,
    currency: null,
    instrument: null,
    securityCode: null,
    securityName: null,
    market: null,
    subject: null,
    extra: {},
    ...fields,
  };
}

/** Synthetic rows mirroring the parsers' observed shapes (no provider values). */
const ROWS = {
  // sbi-shinsei-top-balances-and-activity / sbi-shinsei-common: a balance in
  // the account's native unit.
  balance: input(ACCOUNT, { kind: "balance", instrument: "AUD", extra: { currency: "AUD" } }),
  // The provider's yen equivalent of the same account.
  yenValuation: input(ACCOUNT, { subject: "AUD", currency: "JPY", extra: { currency: "AUD" } }),
  // An activity row of a yen account.
  transaction: input(ACCOUNT, { kind: "transaction", currency: "JPY" }),
  // sbi-shinsei-exchange-rate: one rate cell of the board, subject <CCY>.
  fxBoard: input("sbi-shinsei:fx-board", {
    subject: "USD",
    currency: "JPY",
    extra: { currency: "USD", customerCategory: "1", _kogane: { quoteCurrency: "JPY" } },
  }),
  // sbi-shinsei-balance-summary-and-stage: the stage category, no amount.
  customer: input("sbi-shinsei:customer", {
    subject: "customerCategory",
    currency: "XXX",
    extra: { customerCategory: "1", _kogane: { amountDisposition: "not-an-amount" } },
  }),
} as const;

const DEPOSIT = {
  label: "SBI新生銀行 預金口座",
  role: "deposit",
  status: "provider-local",
  reason: "provider-account-reference-with-native-unit",
} as const;

/** The plan with instruments reduced to their identifying fields. */
function golden(plan: IdentityPlan) {
  return {
    account: plan.account,
    instruments: plan.instruments.map((i) => [i.role, i.namespace, i.value, i.status]),
    issues: plan.issues,
  };
}

/** The source-account id the store derives (`identityKey("sa", ...)`), computed independently. */
function sourceAccountDigest(key: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([SOURCE, PRODUCER, key]))
    .digest("hex");
}

const at = (row: IdentityInput, policyVersion: number | undefined) =>
  otherIdentity(policyVersion === undefined ? row : { ...row, policyVersion });

describe("SBI Shinsei identity policy versions", () => {
  test("the non-account classification starts at policy 2", () => {
    expect(SBI_SHINSEI_POLICY_VERSION).toBe(2);
  });

  test("the reclassified references are the parsers' constants", () => {
    // The rule matches literal strings; a renamed parser constant would
    // silently fall back to the deposit mapping without this guard.
    expect(at(input(SBI_SHINSEI_FX_BOARD_ACCOUNT), 2).account.status).toBe("aggregate");
    expect(at(input(SBI_SHINSEI_CUSTOMER_ACCOUNT), 2).account.status).toBe("aggregate");
  });

  test("policy 1 golden: every reference is a provider-local deposit", () => {
    expect(golden(at(ROWS.balance, 1))).toEqual({
      account: { key: [ACCOUNT, "unit", "AUD"], ...DEPOSIT },
      instruments: [["unit", "iso4217", "AUD", "identified"]],
      issues: [],
    });
    expect(golden(at(ROWS.yenValuation, 1))).toEqual({
      account: { key: [ACCOUNT, "unit", "AUD"], ...DEPOSIT },
      instruments: [["unit", "iso4217", "JPY", "identified"]],
      issues: [],
    });
    expect(golden(at(ROWS.transaction, 1))).toEqual({
      account: { key: [ACCOUNT, "unit", "JPY"], ...DEPOSIT },
      instruments: [["unit", "iso4217", "JPY", "identified"]],
      issues: [],
    });
    // What policy 1 recorded for the two non-account references.
    expect(golden(at(ROWS.fxBoard, 1))).toEqual({
      account: { key: ["sbi-shinsei:fx-board", "unit", "USD"], ...DEPOSIT },
      instruments: [["unit", "iso4217", "JPY", "identified"]],
      issues: [],
    });
    expect(golden(at(ROWS.customer, 1))).toEqual({
      account: { key: ["sbi-shinsei:customer", "unit", "customerCategory"], ...DEPOSIT },
      instruments: [["unit", "unresolved-currency", "XXX", "unresolved"]],
      issues: [],
    });
  });

  test("policy 2 golden: account references unchanged, the board and the stage are not accounts", () => {
    for (const row of [ROWS.balance, ROWS.yenValuation, ROWS.transaction])
      expect(at(row, 2)).toEqual(at(row, 1));
    expect(golden(at(ROWS.fxBoard, 2))).toEqual({
      account: {
        key: ["sbi-shinsei:fx-board", "unit", "USD"],
        label: "SBI新生銀行 外貨為替レート",
        role: "valuation-aggregate",
        status: "aggregate",
        reason: "provider-fx-board-quotes-not-an-account",
      },
      instruments: [["unit", "iso4217", "JPY", "identified"]],
      issues: [],
    });
    expect(golden(at(ROWS.customer, 2))).toEqual({
      account: {
        key: ["sbi-shinsei:customer", "unit", "customerCategory"],
        label: "SBI新生銀行 お客さまステージ",
        role: "qualification-aggregate",
        status: "aggregate",
        reason: "provider-customer-stage-not-an-account",
      },
      instruments: [["unit", "unresolved-currency", "XXX", "unresolved"]],
      issues: [],
    });
  });

  test("account keys and their source-account digests are the same under both versions", () => {
    // Digests computed outside the code with `printf '%s' '<json>' | sha256sum`.
    const expected: [IdentityInput, string][] = [
      [ROWS.balance, "f2f7ec28d0a9635882692d9a33ab753d329a301ece070ba1601247e0616233eb"],
      [ROWS.yenValuation, "f2f7ec28d0a9635882692d9a33ab753d329a301ece070ba1601247e0616233eb"],
      [ROWS.transaction, "61f9c83e94985ec2dcd65d455a5a3c44bdfa50fee375dfef2de9d139e052c63d"],
      // The non-account references keep their policy-1 subject, so the
      // correction is a new revision of the same source account.
      [ROWS.fxBoard, "c1fcd6c9e3bdfbf770854cf5d7ae4d96373f56e6b0f6ef47bd81373d50977c91"],
      [ROWS.customer, "743c172592bbaf22fc8ce2432f8c4c521fad752d4aac989202e9f1293207891f"],
    ];
    for (const [row, digest] of expected)
      for (const version of [1, 2, 10, undefined])
        expect(sourceAccountDigest(at(row, version).account.key)).toBe(digest);
  });

  test("a resolver call without a version applies the newest rules", () => {
    expect(at(ROWS.fxBoard, undefined)).toEqual(at(ROWS.fxBoard, 2));
    expect(at(ROWS.customer, undefined)).toEqual(at(ROWS.customer, 2));
    expect(at(ROWS.fxBoard, 10)).toEqual(at(ROWS.fxBoard, 2));
  });

  test("only the two exact parser references are reclassified", () => {
    for (const reference of [
      "sbi-shinsei:fx-board:USD",
      "sbi-shinsei:FX-BOARD",
      "sbi-shinsei:customer-1",
      "sbi-shinsei: customer",
    ])
      expect(at(input(reference, { subject: "USD" }), 2).account).toMatchObject(DEPOSIT);
    // Another source's reference with the same text is never reclassified.
    expect(
      otherIdentity({ ...ROWS.fxBoard, sourceId: "sbi-securities", policyVersion: 2 }).account
        .status,
    ).toBe("unresolved");
  });
});

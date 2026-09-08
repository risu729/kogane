import { describe, expect, test } from "bun:test";
import { otherIdentity } from "../src/identity/other.ts";
import { currencyIdentity } from "../src/identity/instruments.ts";
import type { IdentityInput } from "../src/identity/types.ts";

function input(
  sourceId: string,
  sourceAccount: string,
  fields: Partial<IdentityInput> = {},
): IdentityInput {
  return {
    kind: "transaction",
    observationId: 1,
    parseRunId: 2,
    artifactId: 3,
    fetchRunId: 4,
    sourceId,
    producerId: "synthetic-producer",
    sourceAccount,
    currency: "JPY",
    instrument: null,
    securityCode: null,
    securityName: null,
    market: null,
    subject: null,
    extra: {},
    ...fields,
  };
}

describe("non-SBI account identification", () => {
  test("V Point common semantic buckets survive ordinal and run changes", () => {
    const extra = {
      point_type: 0,
      expiration: "2027-03-31",
      _kogane: { pointType: 0, expiration: "2027-03-31" },
    };
    const first = otherIdentity(
      input("v-point", "v-point:common:bucket-0", { extra, instrument: "V_POINT", currency: null }),
    );
    const next = otherIdentity(
      input("v-point", "v-point:common:bucket-2", {
        extra,
        fetchRunId: 9,
        instrument: "V_POINT",
        currency: null,
      }),
    );
    expect(first.account.key).toEqual(next.account.key);
    expect(first.account.status).toBe("provider-local");
    expect(first.issues).toEqual([]);
    expect(first.account.key).not.toEqual(
      otherIdentity(
        input("v-point", "v-point:common:bucket-0", {
          extra: { ...extra, point_type: 1, _kogane: {} },
        }),
      ).account.key,
    );
    expect(first.account.key).not.toEqual(
      otherIdentity(
        input("v-point", "v-point:common:bucket-0", {
          extra: { ...extra, expiration: "2027-04-30", _kogane: {} },
        }),
      ).account.key,
    );
  });
  test("conflicting V Point type or expiry keeps a run-scoped unresolved bucket", () => {
    for (const extra of [
      { point_type: 0, expiration: "", _kogane: { pointType: 1 } },
      { point_type: 0, expiration: "", _kogane: { expiration: "different" } },
      { point_type: "0", expiration: "" },
      { point_type: 0 },
    ]) {
      const result = otherIdentity(input("v-point", "v-point:common:bucket-0", { extra }));
      expect(result.account.status).toBe("unresolved");
      expect(result.account.key).toContain("fetch-run");
    }
  });
  test.each([
    ["global-pass", "global-pass:card", "debit-card-activity", "provider-local"],
    ["myjcb", "myjcb:synthetic-connection:root", "card-statement-aggregate", "aggregate"],
    ["smbc-bank", "smbc-bank:ordinary-yen", "deposit", "provider-local"],
    ["sony-bank", "sony-bank:deposit:AUD", "deposit", "provider-local"],
    ["sony-bank", "sony-bank:wallet", "debit-card-activity", "provider-local"],
    ["sony-bank", "sony-bank:gross", "valuation-aggregate", "aggregate"],
    ["sony-bank", "sony-bank:gross:asset:001", "valuation-aggregate", "aggregate"],
    ["sony-bank", "sony-bank:gross:asset:011", "valuation-aggregate", "aggregate"],
    ["sony-bank", "sony-bank:gross:loan:012", "valuation-aggregate", "aggregate"],
    ["sony-bank", "sony-bank:gross:loan:015", "valuation-aggregate", "aggregate"],
    ["sbi-shinsei-bank", "sbi-shinsei:synthetic-ref", "deposit", "provider-local"],
    ["sbi-vc-trade", "sbi-vc-trade:main", "exchange-account", "provider-local"],
    ["v-point", "v-point:member", "reward-account", "provider-local"],
    ["v-point", "v-point:smfg:smbc", "reward-display-aggregate", "aggregate"],
    ["v-point", "v-point:smfg:smcc", "reward-display-aggregate", "aggregate"],
    [
      "v-point-pay",
      "v-point-pay:notification-events",
      "wallet-notification-events",
      "provider-local",
    ],
    ["v-point-pay", "v-point-pay:prepaid-yen", "prepaid-wallet", "provider-local"],
    ["mobile-suica", "mobile-suica:sf", "stored-value", "provider-local"],
    [
      "moneyforward-me",
      `moneyforward-me:moneyforward-account-v1-${"a".repeat(64)}`,
      "aggregator-mirror",
      "provider-local",
    ],
    ["paypay", "paypay", "wallet-export", "provider-local"],
  ] as const)("%s %s recognizes the audited account scope", (source, account, role, status) => {
    const plan = otherIdentity(input(source, account));
    expect(plan.account.role).toBe(role);
    expect(plan.account.status).toBe(status);
    expect(plan.account.key[0]).toBe(account);
    expect(plan.issues).toEqual([]);
  });

  test.each([
    ["vpass", "vpass:card-001"],
    ["v-point", "v-point:common:bucket-0"],
    ["v-point", "v-point:store-limited:group-0:item-1"],
  ])("%s ordinals cannot merge across acquisitions", (source, account) => {
    const first = otherIdentity(input(source, account));
    const second = otherIdentity(input(source, account, { fetchRunId: 5 }));
    expect(first.account.status).toBe("unresolved");
    expect(first.account.key).not.toEqual(second.account.key);
    expect(first.issues).toHaveLength(1);
  });

  test.each([
    ["vpass", "vpass:root"],
    ["vpass", "vpass:card-1"],
    ["smbc-bank", "smbc-bank:ordinary-aud"],
    ["sbi-shinsei", "sbi-shinsei:synthetic-ref"],
    ["moneyforward-me", "moneyforward-me:account-001"],
    ["sony-bank", "sony-bank:gross:asset:012"],
    ["sony-bank", "sony-bank:deposit:XYZ"],
    ["myjcb", "myjcb:synthetic-connection:subcard"],
    ["unknown", "paypay"],
  ])("%s rejects unaudited account %s", (source, account) => {
    expect(otherIdentity(input(source, account)).account.status).toBe("unresolved");
  });

  test("MF identity survives ordinal changes but never aliases by name", () => {
    const account = `moneyforward-me:moneyforward-account-v1-${"a".repeat(64)}`;
    const a = otherIdentity(
      input("moneyforward-me", account, { extra: { accountOrdinal: 1, name: "SMBC" } }),
    );
    const b = otherIdentity(
      input("moneyforward-me", account, {
        fetchRunId: 9,
        extra: { accountOrdinal: 8, name: "SMBC" },
      }),
    );
    expect(a.account.key).toEqual(b.account.key);
    expect(a.account.role).toBe("aggregator-mirror");
    expect(a.account.key).not.toEqual(
      otherIdentity(input("smbc-bank", "smbc-bank:ordinary-yen")).account.key,
    );
  });

  test("Shinsei native and yen valuation retain one native unit account", () => {
    const balance = otherIdentity(
      input("sbi-shinsei-bank", "sbi-shinsei:synthetic-ref", {
        kind: "balance",
        instrument: "AUD",
        currency: null,
        extra: { currency: "AUD" },
      }),
    );
    const valuation = otherIdentity(
      input("sbi-shinsei-bank", "sbi-shinsei:synthetic-ref", {
        kind: "valuation",
        subject: "AUD",
        extra: { currency: "AUD" },
      }),
    );
    expect(balance.account.key).toEqual(valuation.account.key);
    expect(balance.instruments[0]!.value).toBe("AUD");
    expect(valuation.instruments[0]!.value).toBe("JPY");
  });
});

describe("instrument semantic boundaries", () => {
  test("conflicting exchange quote cannot create two instruments with one role", () => {
    const plan = otherIdentity(
      input("sbi-vc-trade", "sbi-vc-trade:main", {
        currency: "USD",
        extra: { _kogane: { currencyPair: { base: "BTC", quote: "JPY" } } },
      }),
    );
    expect(plan.instruments.filter((i) => i.role === "unit")).toHaveLength(1);
    expect(plan.issues).toContain("execution-quote-unit-conflict");
  });
  test("CNH differs from ISO CNY; points differ from money; unlisted code stays unresolved", () => {
    expect(currencyIdentity("JPY").namespace).toBe("iso4217");
    expect(currencyIdentity("CNH").namespace).not.toBe(currencyIdentity("CNY").namespace);
    expect(currencyIdentity("V_POINT").kind).toBe("reward");
    expect(currencyIdentity("XYZ").status).toBe("unresolved");
    expect(currencyIdentity("usd").status).toBe("unresolved");
  });
  test("Sony preserves usage and settlement units independently", () => {
    const p = otherIdentity(
      input("sony-bank", "sony-bank:wallet", {
        extra: { _kogane: { usageAmount: { currency: "AUD" } } },
      }),
    );
    expect(p.instruments.map((i) => [i.role, i.value])).toEqual([
      ["unit", "JPY"],
      ["usage-unit", "AUD"],
    ]);
  });
  test("SBI VC products stay provider scoped and do not imply an underlying coin", () => {
    const p = otherIdentity(
      input("sbi-vc-trade", "sbi-vc-trade:main", {
        kind: "position",
        currency: null,
        securityCode: "BTCJPY",
      }),
    );
    expect(p.instruments).toHaveLength(1);
    expect(p.instruments[0]!.kind).toBe("product");
    expect(p.instruments[0]!.value).toBe("BTCJPY");
  });
  test("explicit execution pair resolves asset codes without copying financial payload", () => {
    const p = otherIdentity(
      input("sbi-vc-trade", "sbi-vc-trade:main", {
        currency: null,
        extra: {
          productId: "BTCJPY",
          confidential: "do-not-copy",
          _kogane: { currencyPair: { base: "BTC", quote: "JPY" } },
        },
      }),
    );
    expect(p.instruments.map((i) => [i.role, i.kind, i.value])).toEqual([
      ["security", "product", "BTCJPY"],
      ["trade-unit", "crypto", "BTC"],
      ["unit", "money", "JPY"],
    ]);
    expect(JSON.stringify(p)).not.toContain("do-not-copy");
    expect(p.instruments[1]!.status).toBe("provider-local");
  });
  test("declined notification with no monetary evidence invents no instrument", () => {
    const p = otherIdentity(
      input("v-point-pay", "v-point-pay:notification-events", { currency: null }),
    );
    expect(p.instruments).toEqual([]);
  });
});

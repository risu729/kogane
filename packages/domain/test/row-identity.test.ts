// Identity admission of one stored row for a human-adopted writer (ADR 0054,
// G1b): the registry's provider identity functions and the closed refusals.
// Every value is synthetic.
import { describe, expect, test } from "bun:test";
import { aliasClassText, validAliasClass } from "../src/economic-contract.ts";
import {
  PROVIDER_IDENTITY_FUNCTIONS,
  providerIdentityFunction,
  transactionFamilyEntry,
} from "../src/event-families.ts";
import * as domain from "../src/index.ts";
import {
  humanAdoptedRowIdentity,
  rowOriginBasis,
  type HumanAdoptedRowInput,
} from "../src/row-identity.ts";

const smbc = (overrides: Partial<HumanAdoptedRowInput> = {}): HumanAdoptedRowInput => ({
  sourceId: "smbc-bank",
  parserName: "smbc-direct-transactions",
  sourceAccount: "smbc-bank:ordinary-yen",
  externalId: "synthetic-row-1",
  extra: { id: "synthetic-row-1", _kogane: { identityOrigin: "provider-id" } },
  accountId: "acct-synthetic-bank",
  ...overrides,
});

const shinsei = (overrides: Partial<HumanAdoptedRowInput> = {}): HumanAdoptedRowInput => ({
  sourceId: "sbi-shinsei-bank",
  parserName: "sbi-shinsei-top-balances-and-activity",
  sourceAccount: "sbi-shinsei:synthetic",
  externalId: "synthetic-ref-1",
  extra: { txnReferenceNo: "synthetic-ref-1", _kogane: { amountSignSource: "debit" } },
  accountId: "acct-synthetic-shinsei",
  ...overrides,
});

describe("provider identity functions", () => {
  test("each names a registry entry whose id the provider issues", () => {
    for (const declared of PROVIDER_IDENTITY_FUNCTIONS) {
      const entry = transactionFamilyEntry(declared.sourceId, declared.parserName);
      expect(entry).not.toBeNull();
      expect(["provider_id", "provider_id_tuple"]).toContain(entry!.identity.externalId);
      expect(declared.componentFields.length).toBeGreaterThan(0);
      for (const field of declared.componentFields)
        expect(field).toMatch(/^[A-Za-z][A-Za-z0-9]*$/u);
      expect(declared.ruleVersion).toMatch(/^[a-z0-9.-]{1,64}$/u);
    }
    expect(
      PROVIDER_IDENTITY_FUNCTIONS.map((declared) => `${declared.sourceId}/${declared.parserName}`),
    ).toEqual([
      "smbc-bank/smbc-direct-transactions",
      "sbi-shinsei-bank/sbi-shinsei-top-balances-and-activity",
    ]);
    expect(domain.humanAdoptedRowIdentity).toBe(humanAdoptedRowIdentity);
    expect(domain.PROVIDER_IDENTITY_FUNCTIONS).toBe(PROVIDER_IDENTITY_FUNCTIONS);
  });

  test("a declared scope admits its source accounts only; both functions declare every account", () => {
    for (const declared of PROVIDER_IDENTITY_FUNCTIONS) expect(declared.sourceAccounts).toBe("any");
    expect(
      providerIdentityFunction("smbc-bank", "smbc-direct-transactions", "smbc-bank:any-account"),
    ).not.toBeNull();
    expect(
      providerIdentityFunction("smbc-bank", "synthetic-parser", "smbc-bank:ordinary-yen"),
    ).toBeNull();
    const scoped = [
      { ...PROVIDER_IDENTITY_FUNCTIONS[0]!, sourceAccounts: ["smbc-bank:ordinary-yen"] },
    ];
    expect(
      providerIdentityFunction(
        "smbc-bank",
        "smbc-direct-transactions",
        "smbc-bank:ordinary-yen",
        scoped,
      ),
    ).toBe(scoped[0]!);
    expect(
      providerIdentityFunction("smbc-bank", "smbc-direct-transactions", "smbc-bank:other", scoped),
    ).toBeNull();
  });
});

describe("humanAdoptedRowIdentity", () => {
  test("an SMBC row whose origin is recorded is admitted with its alias class", () => {
    const admitted = humanAdoptedRowIdentity(smbc());
    expect(admitted).toEqual({
      admitted: true,
      aliasClass: {
        sourceId: "smbc-bank",
        components: ["synthetic-row-1"],
        accountId: "acct-synthetic-bank",
        ruleVersion: "smbc-meisai-id-v1",
      },
    });
    if (!admitted.admitted) throw new Error("unreachable");
    expect(validAliasClass(admitted.aliasClass)).toBe(true);
  });

  test("the alias class reads the provider field, never the stored id text, producer or namespace", () => {
    // The same fact with its external id rendered otherwise (a parser release
    // that prefixes ids) has the same class; another provider id has another.
    const a = humanAdoptedRowIdentity(smbc());
    const b = humanAdoptedRowIdentity(smbc({ externalId: "prefixed:synthetic-row-1" }));
    const c = humanAdoptedRowIdentity(
      smbc({ extra: { id: "synthetic-row-2", _kogane: { identityOrigin: "provider-id" } } }),
    );
    if (!a.admitted || !b.admitted || !c.admitted) throw new Error("expected admissions");
    expect(aliasClassText(b.aliasClass)).toBe(aliasClassText(a.aliasClass));
    expect(aliasClassText(c.aliasClass)).not.toBe(aliasClassText(a.aliasClass));
    expect(aliasClassText(a.aliasClass)).not.toContain("prefixed");
  });

  test("a row without a recorded origin is refused: identity_origin_unrecorded", () => {
    expect(humanAdoptedRowIdentity(smbc({ extra: { id: "synthetic-row-1" } }))).toEqual({
      admitted: false,
      refusal: "identity_origin_unrecorded",
    });
    expect(
      humanAdoptedRowIdentity(
        smbc({ extra: { id: "synthetic-row-1", _kogane: { identityOrigin: "parser" } } }),
      ),
    ).toEqual({ admitted: false, refusal: "identity_origin_unrecorded" });
    // SBI Shinsei: the function is declared, the parser records no origin.
    expect(humanAdoptedRowIdentity(shinsei())).toEqual({
      admitted: false,
      refusal: "identity_origin_unrecorded",
    });
    // A parser the registry does not know.
    expect(humanAdoptedRowIdentity(smbc({ parserName: "synthetic-parser" }))).toEqual({
      admitted: false,
      refusal: "identity_origin_unrecorded",
    });
  });

  test("a parser release that records the origin admits SBI Shinsei through its declared function", () => {
    const recorded = humanAdoptedRowIdentity(
      shinsei({
        extra: { txnReferenceNo: "synthetic-ref-1", _kogane: { identityOrigin: "provider-id" } },
      }),
    );
    expect(recorded).toEqual({
      admitted: true,
      aliasClass: {
        sourceId: "sbi-shinsei-bank",
        components: ["synthetic-ref-1"],
        accountId: "acct-synthetic-shinsei",
        ruleVersion: "sbi-shinsei-txn-reference-no-v1",
      },
    });
  });

  test("one provider id under two resolved accounts is two classes", () => {
    const a = humanAdoptedRowIdentity(smbc());
    const b = humanAdoptedRowIdentity(
      smbc({ sourceAccount: "smbc-bank:other", accountId: "acct-other" }),
    );
    if (!a.admitted || !b.admitted) throw new Error("expected admissions");
    expect(aliasClassText(a.aliasClass)).not.toBe(aliasClassText(b.aliasClass));
    // Two source accounts resolved to one account: one class.
    const c = humanAdoptedRowIdentity(smbc({ sourceAccount: "smbc-bank:other" }));
    if (!c.admitted) throw new Error("expected an admission");
    expect(aliasClassText(c.aliasClass)).toBe(aliasClassText(a.aliasClass));
  });

  test("fingerprints, digests and absent ids are refused", () => {
    const vpass: HumanAdoptedRowInput = {
      sourceId: "vpass",
      parserName: "vpass-statement-page",
      sourceAccount: "vpass:synthetic",
      externalId: "synthetic-fingerprint:1",
      extra: { _kogane: { identityOrigin: "fingerprint-occurrence" } },
      accountId: "acct-synthetic-card",
    };
    expect(humanAdoptedRowIdentity(vpass)).toEqual({
      admitted: false,
      refusal: "identity_fingerprint_only",
    });
    // V Point Pay records a digest under identityOrigin: still not a provider id.
    expect(
      humanAdoptedRowIdentity({
        ...vpass,
        sourceId: "v-point-pay",
        parserName: "v-point-pay-notification-event",
        extra: { _kogane: { identityOrigin: "provider-id" } },
      }),
    ).toEqual({ admitted: false, refusal: "identity_digest_not_provider" });
    expect(
      humanAdoptedRowIdentity({
        ...vpass,
        sourceId: "sbi-securities",
        parserName: "sbi-domestic-trade-records",
      }),
    ).toEqual({ admitted: false, refusal: "identity_fingerprint_only" });
    expect(humanAdoptedRowIdentity(smbc({ externalId: null }))).toEqual({
      admitted: false,
      refusal: "identity_absent",
    });
    expect(rowOriginBasis(smbc({ externalId: "" }))).toBe("absent");
  });

  test("a declared function whose provider field is missing computes nothing: identity_absent", () => {
    expect(
      humanAdoptedRowIdentity(smbc({ extra: { _kogane: { identityOrigin: "provider-id" } } })),
    ).toEqual({ admitted: false, refusal: "identity_absent" });
    expect(
      humanAdoptedRowIdentity(
        smbc({ extra: { id: 7, _kogane: { identityOrigin: "provider-id" } } }),
      ),
    ).toEqual({ admitted: false, refusal: "identity_absent" });
    expect(humanAdoptedRowIdentity(smbc({ extra: "not a record" }))).toEqual({
      admitted: false,
      refusal: "identity_origin_unrecorded",
    });
  });
});

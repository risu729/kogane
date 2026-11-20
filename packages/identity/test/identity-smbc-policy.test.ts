// SMBC identity policy versions (ADR 0118). Golden plans for policy 1 and
// policy 2 over the real AUD balance parser and synthetic inputs: policy 1 is
// unchanged (the AUD reference unresolved under the yen fallback label), and
// policy 2 classifies only that exact reference, with the same key.
import { describe, expect, test } from "bun:test";
import { smbcForeignOrdinaryBalance } from "../../parsers/src/parsers/smbc-foreign-ordinary.ts";
import type { ArtifactMeta, Observation } from "../../parsers/src/types.ts";
import { otherIdentity, SMBC_BANK_POLICY_VERSION } from "../src/other.ts";
import type { IdentityInput, IdentityPlan } from "../src/types.ts";

const AUD_ACCOUNT = "smbc-bank:ordinary-foreign-aud";

function input(sourceAccount: string, fields: Partial<IdentityInput> = {}): IdentityInput {
  return {
    kind: "balance",
    observationId: 1,
    parseRunId: 2,
    artifactId: 3,
    fetchRunId: 4,
    sourceId: "smbc-bank",
    producerId: "synthetic-producer",
    sourceAccount,
    currency: null,
    instrument: "AUD",
    securityCode: null,
    securityName: null,
    market: null,
    subject: null,
    extra: {},
    ...fields,
  };
}

/** The real parser over a synthetic capture of the observed balance shape. */
function parsedAudBalance(): Observation {
  const artifact: ArtifactMeta = {
    id: 1,
    sourceId: "smbc-bank",
    runStatus: "success",
    runFailureCount: 0,
    dataset: "foreign-ordinary-aud-balance",
    artifactKey: "foreign-ordinary-aud/balance.json",
    fetchUnitKey: "foreign-ordinary-aud-balance",
    mime: "application/json",
    url: null,
    fetchedAt: "2099-04-02T01:00:00.000Z",
    sha256: "0".repeat(64),
  };
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      currency: "AUD",
      amount: "123.45",
      yenEquivalent: "12000",
      referenceRate: "97.205",
      observedAt: "2099-04-02T01:00:00.000Z",
    }),
  );
  const { observations } = smbcForeignOrdinaryBalance.parse(bytes, artifact);
  expect(observations).toHaveLength(1);
  return observations[0]!;
}
function fromObservation(observation: Observation, fields: Partial<IdentityInput> = {}) {
  return input(observation.sourceAccount, {
    kind: observation.kind,
    instrument: "instrument" in observation ? observation.instrument : null,
    extra: observation.extra,
    ...fields,
  });
}

const AUD_UNIT = ["unit", "iso4217", "global", "AUD", "identified"];
const units = (plan: IdentityPlan) =>
  plan.instruments.map((i) => [i.role, i.namespace, i.scope, i.value, i.status]);

describe("SMBC identity policy versions", () => {
  test("the version is 2", () => {
    expect(SMBC_BANK_POLICY_VERSION).toBe(2);
  });

  test("policy 1 plans the AUD reference exactly as it shipped: unresolved, yen fallback label", () => {
    const observation = parsedAudBalance();
    expect(observation.sourceAccount).toBe(AUD_ACCOUNT);
    for (const fetchRunId of [4, 5]) {
      const plan = otherIdentity(fromObservation(observation, { policyVersion: 1, fetchRunId }));
      expect(plan.account).toEqual({
        key: [AUD_ACCOUNT],
        label: "三井住友銀行 円普通預金",
        role: "source-account",
        status: "unresolved",
        reason: "unrecognized-source-account",
      });
      expect(plan.issues).toEqual(["unrecognized-source-account"]);
      expect(units(plan)).toEqual([AUD_UNIT]);
    }
  });

  test("policy 2 classifies the AUD foreign ordinary deposit with its own label and the same key", () => {
    const observation = parsedAudBalance();
    const policy2 = otherIdentity(fromObservation(observation, { policyVersion: 2 }));
    expect(policy2.account).toEqual({
      key: [AUD_ACCOUNT],
      label: "三井住友銀行 外貨普通預金（AUD）",
      role: "deposit",
      status: "provider-local",
      reason: "collector-single-foreign-ordinary-aud-scope",
    });
    expect(policy2.issues).toEqual([]);
    expect(units(policy2)).toEqual([AUD_UNIT]);
    // A call without a version gets the newest rules.
    expect(otherIdentity(fromObservation(observation))).toEqual(policy2);
    // The key does not change with the run or the version, so a policy-2 run
    // revises the same source account instead of creating a second subject.
    expect(
      otherIdentity(fromObservation(observation, { policyVersion: 2, fetchRunId: 5 })).account.key,
    ).toEqual(policy2.account.key);
    expect(otherIdentity(fromObservation(observation, { policyVersion: 1 })).account.key).toEqual(
      policy2.account.key,
    );
    // It is not the yen ordinary deposit: another source account and label.
    const yen = otherIdentity(input("smbc-bank:ordinary-yen", { instrument: "JPY" }));
    expect(yen.account.key).not.toEqual(policy2.account.key);
    expect(yen.account.label).not.toBe(policy2.account.label);
  });

  test("the yen deposit plans identically under both versions", () => {
    for (const kind of ["balance", "transaction"] as const) {
      const fields = { kind, instrument: kind === "balance" ? "JPY" : null, currency: "JPY" };
      const policy1 = otherIdentity(
        input("smbc-bank:ordinary-yen", { ...fields, policyVersion: 1 }),
      );
      expect(
        otherIdentity(input("smbc-bank:ordinary-yen", { ...fields, policyVersion: 2 })),
      ).toEqual(policy1);
      expect(policy1.account).toEqual({
        key: ["smbc-bank:ordinary-yen"],
        label: "三井住友銀行 円普通預金",
        role: "deposit",
        status: "provider-local",
        reason: "audited-ordinary-yen-scope",
      });
    }
  });

  test("near shapes and other sources stay unresolved under policy 2", () => {
    for (const reference of [
      "smbc-bank:ordinary-aud",
      "smbc-bank:ordinary-foreign-usd",
      "smbc-bank:ordinary-foreign-AUD",
      "smbc-bank:ordinary-foreign-aud:extra",
      "smbc-bank:foreign-aud",
    ])
      expect(otherIdentity(input(reference, { policyVersion: 2 })).account).toEqual({
        key: [reference],
        label: "三井住友銀行 円普通預金",
        role: "source-account",
        status: "unresolved",
        reason: "unrecognized-source-account",
      });
    // The exact reference under another source is not SMBC's deposit.
    expect(
      otherIdentity(input(AUD_ACCOUNT, { sourceId: "sony-bank", policyVersion: 2 })).account.status,
    ).toBe("unresolved");
  });
});

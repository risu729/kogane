// The own-transfer proposal engine (ADR 0057, G3-a): policy refusal, the
// identity rules, ownership, the pairing rule and its ambiguity, and a
// mutation-style comparison of the pairing rule with an independent oracle.
// Every row is synthetic: invented accounts, ids, round amounts and dates.
import { describe, expect, test } from "bun:test";
import { aliasClassText, INITIAL_IDENTITY_EPOCH } from "../src/economic-contract.ts";
import * as domain from "../src/index.ts";
import {
  OWN_TRANSFER_ENGINE_RELEASE,
  OWN_TRANSFER_PAIR_REFUSALS,
  OWN_TRANSFER_PROPOSAL_CODES,
  OWN_TRANSFER_ROW_REFUSALS,
  OWN_TRANSFER_ROWS_MAX,
  OWN_TRANSFER_RUN_REFUSALS,
  proposeOwnTransfers,
  validOwnTransferPolicy,
  validOwnTransferProposal,
  type AccountOwnership,
  type AccountOwnershipSource,
  type OwnTransferPolicy,
  type OwnTransferProposalInput,
  type OwnTransferRowInput,
} from "../src/own-transfer-proposals.ts";
import { IDENTITY_REFUSALS } from "../src/economic-contract.ts";

const EXACT: OwnTransferPolicy = {
  policyVersion: "synthetic-own-transfer-policy-1",
  family: "bank-movement",
  currencyRule: "same-currency",
  window: { minDaysAfterDebit: 0, maxDaysAfterDebit: 2 },
  difference: { rule: "exact" },
};
const FEE: OwnTransferPolicy = {
  ...EXACT,
  policyVersion: "synthetic-own-transfer-policy-fee-1",
  difference: { rule: "fee-within", maxByCurrency: [{ currency: "JPY", amount: "10" }] },
};

/** Synthetic accounts: two own SMBC accounts, one own SBI Shinsei account, one someone else's. */
const OWNERSHIP: Record<string, AccountOwnership> = {
  "smbc-bank:synthetic-a": { state: "self", accountId: "acct-synthetic-a" },
  "smbc-bank:synthetic-b": { state: "self", accountId: "acct-synthetic-b" },
  "smbc-bank:synthetic-c": { state: "self", accountId: "acct-synthetic-c" },
  "smbc-bank:synthetic-other": { state: "other" },
  "sbi-shinsei:synthetic": { state: "self", accountId: "acct-synthetic-shinsei" },
  "sony-bank:synthetic": { state: "self", accountId: "acct-synthetic-sony" },
  "sbi-securities:synthetic": { state: "self", accountId: "acct-synthetic-broker" },
};
const ownership: AccountOwnershipSource = {
  version: "synthetic-ownership-1",
  ownershipOf: (_sourceId, sourceAccount) => OWNERSHIP[sourceAccount] ?? { state: "unresolved" },
};

interface RowSpec {
  id: number;
  account?: string;
  meisai?: string;
  amount: string;
  currency?: string;
  date?: string | null;
  producer?: string;
}
/** An SMBC-shaped row: provider id recorded as `provider-id`, as the parser records it. */
function smbc(spec: RowSpec): OwnTransferRowInput {
  const meisai = spec.meisai ?? `meisai-${spec.id}`;
  return {
    observationId: spec.id,
    parseRunId: 7,
    key: [
      "smbc-bank",
      spec.producer ?? "synthetic-producer",
      "synthetic-ns",
      spec.account ?? "smbc-bank:synthetic-a",
      meisai,
    ],
    parserName: "smbc-direct-transactions",
    extra: { id: meisai, _kogane: { identityOrigin: "provider-id" } },
    amount: spec.amount,
    currency: spec.currency ?? "JPY",
    postingDate: spec.date === undefined ? "2030-01-10" : spec.date,
  };
}
/**
 * An SBI-Shinsei-shaped row of a 0.1.2 run: `txnReferenceNo`, and no recorded
 * origin (the parser records the origin from release 0.1.3; rows of 0.1.2 runs
 * stay refused).
 */
function shinsei(id: number, amount: string): OwnTransferRowInput {
  return {
    observationId: id,
    parseRunId: 8,
    key: ["sbi-shinsei-bank", "synthetic-producer", null, "sbi-shinsei:synthetic", `ref-${id}`],
    parserName: "sbi-shinsei-top-balances-and-activity",
    extra: { txnReferenceNo: `ref-${id}` },
    amount,
    currency: "JPY",
    postingDate: "2030-01-10",
  };
}

const run = (
  rows: OwnTransferRowInput[],
  overrides: Partial<OwnTransferProposalInput> = {},
): ReturnType<typeof proposeOwnTransfers> =>
  proposeOwnTransfers({
    rows,
    ownership,
    policy: EXACT,
    identityEpoch: INITIAL_IDENTITY_EPOCH,
    held: { keys: [], aliasClasses: [] },
    ...overrides,
  });

async function ok(rows: OwnTransferRowInput[], overrides: Partial<OwnTransferProposalInput> = {}) {
  const result = await run(rows, overrides);
  if (!result.ok) throw new Error(`refused: ${result.refusal}`);
  return result;
}

const debitA = (id = 1, amount = "-1000") => smbc({ id, account: "smbc-bank:synthetic-a", amount });
const creditB = (id = 2, amount = "1000", date = "2030-01-10") =>
  smbc({ id, account: "smbc-bank:synthetic-b", amount, date });

describe("the policy is explicit and versioned", () => {
  test("no policy refuses the whole run: policy_missing", async () => {
    expect(await run([debitA(), creditB()], { policy: null })).toEqual({
      ok: false,
      refusal: "policy_missing",
    });
    expect(await run([debitA(), creditB()], { policy: undefined })).toEqual({
      ok: false,
      refusal: "policy_missing",
    });
  });

  test("an unversioned or unknown policy refuses the whole run: policy_unsupported", async () => {
    const broken: unknown[] = [
      {},
      { ...EXACT, policyVersion: "" },
      { ...EXACT, policyVersion: "Has Spaces" },
      (({ policyVersion: _v, ...rest }) => rest)(EXACT),
      { ...EXACT, family: "stored-value-movement" },
      { ...EXACT, currencyRule: "any" },
      { ...EXACT, window: { minDaysAfterDebit: 3, maxDaysAfterDebit: 1 } },
      { ...EXACT, window: { minDaysAfterDebit: 0, maxDaysAfterDebit: 32 } },
      { ...EXACT, window: { minDaysAfterDebit: 0, maxDaysAfterDebit: 1.5 } },
      { ...EXACT, difference: { rule: "fx" } },
      { ...EXACT, difference: { rule: "fee-within", maxByCurrency: [] } },
      {
        ...EXACT,
        difference: { rule: "fee-within", maxByCurrency: [{ currency: "JPY", amount: "0" }] },
      },
      {
        ...EXACT,
        difference: { rule: "fee-within", maxByCurrency: [{ currency: "JPY", amount: "1e1" }] },
      },
      {
        ...EXACT,
        difference: { rule: "fee-within", maxByCurrency: [{ currency: "jpy", amount: "1" }] },
      },
      { ...EXACT, extra: true },
    ];
    for (const policy of broken) {
      expect(validOwnTransferPolicy(policy)).toBe(false);
      expect(await run([debitA(), creditB()], { policy: policy as OwnTransferPolicy })).toEqual({
        ok: false,
        refusal: "policy_unsupported",
      });
    }
    expect(validOwnTransferPolicy(EXACT)).toBe(true);
    expect(validOwnTransferPolicy(FEE)).toBe(true);
  });

  test("other run refusals: the bound, the epoch and the ownership version", async () => {
    const rows = Array.from({ length: OWN_TRANSFER_ROWS_MAX + 1 }, (_, i) => debitA(i + 1));
    expect(await run(rows)).toEqual({ ok: false, refusal: "input_bound_exceeded" });
    // The bound itself is admitted.
    expect((await run(rows.slice(0, OWN_TRANSFER_ROWS_MAX))).ok).toBe(true);
    expect(await run([], { identityEpoch: "Not An Epoch" })).toEqual({
      ok: false,
      refusal: "identity_epoch_invalid",
    });
    expect(await run([], { ownership: { ...ownership, version: "" } })).toEqual({
      ok: false,
      refusal: "ownership_version_invalid",
    });
    expect(OWN_TRANSFER_RUN_REFUSALS).toContain("policy_missing");
  });
});

describe("rows: identity, family and ownership fail closed", () => {
  test("an SMBC-shaped row with a recorded provider-id origin is admitted", async () => {
    const result = await ok([debitA(), creditB()]);
    expect(result.rowRefusals).toEqual([]);
    expect(result.proposals).toHaveLength(1);
    const [proposal] = result.proposals;
    expect(proposal!.debit.aliasClass).toEqual({
      sourceId: "smbc-bank",
      components: ["meisai-1"],
      accountId: "acct-synthetic-a",
      ruleVersion: "smbc-meisai-id-v1",
    });
    expect(proposal!.debit.evidenceRef).toEqual({
      kind: "transaction",
      id: "transaction:1",
      revision: "parse_run:7",
    });
  });

  test("an SBI-Shinsei-shaped row without a recorded origin is refused: identity_origin_unrecorded", async () => {
    const result = await ok([shinsei(1, "-1000"), creditB()]);
    expect(result.rowRefusals).toEqual([{ observationId: 1, code: "identity_origin_unrecorded" }]);
    expect(result.proposals).toEqual([]);
  });

  test("an SMBC row whose origin is not recorded is refused the same way", async () => {
    const row = { ...debitA(), extra: { id: "meisai-1" } };
    expect((await ok([row, creditB()])).rowRefusals).toEqual([
      { observationId: 1, code: "identity_origin_unrecorded" },
    ]);
  });

  test("fingerprints, other families, unresolved and foreign accounts are refused with their codes", async () => {
    const fingerprint: OwnTransferRowInput = {
      ...debitA(3),
      key: ["sony-bank", "synthetic-producer", null, "sony-bank:synthetic", "fp-1"],
      parserName: "sony-bank-history-json",
      extra: { _kogane: { identityOrigin: "fingerprint-occurrence" } },
    };
    const broker: OwnTransferRowInput = {
      ...debitA(4),
      key: ["sbi-securities", "synthetic-producer", null, "sbi-securities:synthetic", "did-1"],
      parserName: "sbi-yen-detail-history",
      extra: {},
    };
    const unresolved = smbc({ id: 5, account: "smbc-bank:synthetic-unmapped", amount: "-1000" });
    const foreign = smbc({ id: 6, account: "smbc-bank:synthetic-other", amount: "1000" });
    const noDate = smbc({ id: 7, account: "smbc-bank:synthetic-c", amount: "1000", date: null });
    const notExact = smbc({ id: 8, account: "smbc-bank:synthetic-c", amount: "1e3" });
    const zero = smbc({ id: 9, account: "smbc-bank:synthetic-c", amount: "0" });
    const currency = smbc({ id: 10, account: "smbc-bank:synthetic-c", amount: "1", currency: "" });
    const result = await ok([
      fingerprint,
      broker,
      unresolved,
      foreign,
      noDate,
      notExact,
      zero,
      currency,
    ]);
    expect(result.rowRefusals).toEqual([
      { observationId: 3, code: "identity_fingerprint_only" },
      { observationId: 4, code: "family_unsupported" },
      { observationId: 5, code: "ownership_unresolved" },
      { observationId: 6, code: "owner_not_self" },
      { observationId: 7, code: "posting_date_missing" },
      { observationId: 8, code: "amount_not_exact" },
      { observationId: 9, code: "amount_zero" },
      { observationId: 10, code: "currency_invalid" },
    ]);
    // The identity codes are ADR 0054's own.
    for (const code of OWN_TRANSFER_ROW_REFUSALS.filter((code) => code.startsWith("identity_")))
      expect(IDENTITY_REFUSALS as readonly string[]).toContain(code);
  });

  test("a row already held by a card settlement claim is refused: alias_conflict, or the key when no class is recorded", async () => {
    const first = await ok([debitA(), creditB()]);
    const held = first.proposals[0]!.debit;
    const byAlias = await ok([debitA(), creditB()], {
      held: { keys: [], aliasClasses: [aliasClassText(held.aliasClass)] },
    });
    expect(byAlias.rowRefusals).toEqual([{ observationId: 1, code: "alias_conflict" }]);
    expect(byAlias.proposals).toEqual([]);
    // The same debit under another producer is the same fact: the class is held.
    const rekeyed = {
      ...debitA(),
      key: ["smbc-bank", "producer-2", "ns-2", "smbc-bank:synthetic-a", "meisai-1"] as const,
    };
    expect(
      (
        await ok([rekeyed as OwnTransferRowInput, creditB()], {
          held: { keys: [], aliasClasses: [aliasClassText(held.aliasClass)] },
        })
      ).rowRefusals,
    ).toEqual([{ observationId: 1, code: "alias_conflict" }]);
    const byKey = await ok([debitA(), creditB()], {
      held: { keys: [JSON.stringify(held.key)], aliasClasses: [] },
    });
    expect(byKey.rowRefusals).toEqual([{ observationId: 1, code: "economic_claim_held" }]);
  });

  test("rows that may be one fact are never asserted separate or the same (rule 3)", async () => {
    // One provider row under two producers with different keys: unresolved.
    const twin = smbc({
      id: 11,
      account: "smbc-bank:synthetic-a",
      amount: "-1000",
      meisai: "meisai-1",
      producer: "producer-2",
    });
    const result = await ok([debitA(), twin, creditB()]);
    expect(result.rowRefusals).toEqual([
      { observationId: 1, code: "duplicate_unresolved" },
      { observationId: 11, code: "duplicate_unresolved" },
    ]);
    expect(result.proposals).toEqual([]);
    // The same row captured again (same key, same values): one fact.
    const again = { ...debitA(), observationId: 21, parseRunId: 9 };
    const recaptured = await ok([again, debitA(), creditB()]);
    expect(recaptured.rowRefusals).toEqual([{ observationId: 21, code: "same_fact_recaptured" }]);
    expect(recaptured.proposals.map((p) => p.debit.observationId)).toEqual([1]);
    // A recapture whose value moved is not the same fact.
    const moved = { ...debitA(), observationId: 22, amount: "-999" };
    expect((await ok([moved, debitA(), creditB()])).rowRefusals).toEqual([
      { observationId: 1, code: "duplicate_unresolved" },
      { observationId: 22, code: "duplicate_unresolved" },
    ]);
  });
});

describe("pairing", () => {
  test("an equal pair inside the window is proposed with its codes and pins", async () => {
    const result = await ok([debitA(), creditB(2, "1000", "2030-01-11")]);
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0]!;
    expect(proposal.status).toBe("proposed");
    expect(proposal.codes).toEqual([
      "both_accounts_self",
      "same_currency",
      "date_within_window",
      "amount_equal",
    ]);
    expect(proposal.proposalId).toMatch(/^otp_[0-9a-f]{64}$/u);
    expect(proposal.policyVersion).toBe(EXACT.policyVersion);
    expect(proposal.engineRelease).toBe(OWN_TRANSFER_ENGINE_RELEASE);
    expect(proposal.identityEpoch).toBe(INITIAL_IDENTITY_EPOCH);
    expect(validOwnTransferProposal(proposal)).toBe(true);
    expect(result.manifest).toMatchObject({
      engineRelease: OWN_TRANSFER_ENGINE_RELEASE,
      policyVersion: EXACT.policyVersion,
      identityEpoch: INITIAL_IDENTITY_EPOCH,
      aliasRuleVersions: ["smbc-meisai-id-v1"],
      registryVersion: "transaction-family-registry-v3",
      ownershipVersion: "synthetic-ownership-1",
      arithmeticVersion: "exact-arith-v1",
      contractVersion: "economic-contract-v1",
    });
    expect(result.manifest.policyDigest).toMatch(/^[0-9a-f]{64}$/u);
    // No amount anywhere in the output.
    expect(JSON.stringify(result)).not.toContain("1000");
  });

  test("exact decimals: 1000 and 1000.00 are equal, under INV03", async () => {
    const result = await ok([debitA(1, "-1000.00"), creditB(2, "1000")]);
    expect(result.proposals[0]!.codes).toContain("amount_equal");
  });

  test("a fee difference: refused under an exact policy, proposed under one that allows it", async () => {
    const rows = [debitA(1, "-1010"), creditB(2, "1000")];
    expect((await ok(rows)).pairRefusals).toEqual([
      { debitObservationId: 1, creditObservationId: 2, code: "amount_outside_policy" },
    ]);
    const fee = await ok(rows, { policy: FEE });
    expect(fee.proposals[0]!.codes).toEqual([
      "both_accounts_self",
      "same_currency",
      "date_within_window",
      "difference_within_policy",
    ]);
    // One unit past the allowed fee, and a currency the policy does not list.
    expect(
      (await ok([debitA(1, "-1010.5"), creditB(2, "1000")], { policy: FEE })).pairRefusals,
    ).toHaveLength(1);
    const usd = [
      smbc({ id: 1, amount: "-101", currency: "USD" }),
      smbc({ id: 2, account: "smbc-bank:synthetic-b", amount: "100", currency: "USD" }),
    ];
    expect((await ok(usd, { policy: FEE })).pairRefusals[0]!.code).toBe("amount_outside_policy");
    // The policy is pinned: another policy is another proposal id.
    const exact = await ok([debitA(), creditB()]);
    const withFee = await ok([debitA(), creditB()], { policy: FEE });
    expect(exact.proposals[0]!.proposalId).not.toBe(withFee.proposals[0]!.proposalId);
  });

  test("a credit larger than the debit, or a partial amount, is never a fee", async () => {
    expect(
      (await ok([debitA(1, "-1000"), creditB(2, "1005")], { policy: FEE })).pairRefusals[0]!.code,
    ).toBe("amount_outside_policy");
    expect(
      (await ok([debitA(1, "-1000"), creditB(2, "500")], { policy: FEE })).pairRefusals[0]!.code,
    ).toBe("amount_outside_policy");
  });

  test("cross-currency is refused (FX is not supported); the same account on both sides is refused", async () => {
    const usd = smbc({ id: 2, account: "smbc-bank:synthetic-b", amount: "1000", currency: "USD" });
    expect((await ok([debitA(), usd])).pairRefusals).toEqual([
      { debitObservationId: 1, creditObservationId: 2, code: "currency_differs" },
    ]);
    const sameAccount = smbc({ id: 2, account: "smbc-bank:synthetic-a", amount: "1000" });
    expect((await ok([debitA(), sameAccount])).pairRefusals).toEqual([
      { debitObservationId: 1, creditObservationId: 2, code: "same_account" },
    ]);
  });

  test("the window's bounds are inclusive and directional", async () => {
    const at = async (date: string) =>
      (await ok([debitA(), creditB(2, "1000", date)])).proposals.length;
    expect(await at("2030-01-10")).toBe(1);
    expect(await at("2030-01-12")).toBe(1);
    expect(await at("2030-01-13")).toBe(0);
    expect(await at("2030-01-09")).toBe(0);
  });

  test("ties are never chosen: one debit and two credits, and two debits and one credit, need review", async () => {
    const credits = await ok([
      debitA(),
      creditB(2),
      smbc({ id: 3, account: "smbc-bank:synthetic-c", amount: "1000" }),
    ]);
    expect(credits.proposals).toHaveLength(2);
    for (const proposal of credits.proposals) {
      expect(proposal.status).toBe("needs_review");
      expect(proposal.codes).toContain("candidate_not_unique");
    }
    const debits = await ok([
      debitA(1),
      smbc({ id: 3, account: "smbc-bank:synthetic-c", amount: "-1000" }),
      creditB(2),
    ]);
    expect(debits.proposals.map((p) => p.status)).toEqual(["needs_review", "needs_review"]);
    // Two disjoint pairs are both proposed.
    const disjoint = await ok([
      debitA(1, "-1000"),
      creditB(2, "1000"),
      debitA(3, "-2000"),
      creditB(4, "2000"),
    ]);
    expect(disjoint.proposals.map((p) => p.status)).toEqual(["proposed", "proposed"]);
  });

  test("deterministic under permutation; a recapture keeps the proposal id and changes the digest", async () => {
    const rows = [debitA(1), creditB(2), debitA(3, "-2000"), creditB(4, "2000"), shinsei(5, "-1")];
    const forward = await ok(rows);
    const backward = await ok([...rows].reverse());
    expect(backward).toEqual(forward);
    const recapture = await ok([{ ...debitA(1), observationId: 31 }, creditB(2)]);
    const original = forward.proposals.find((p) => p.debit.observationId === 1)!;
    expect(recapture.proposals[0]!.proposalId).toBe(original.proposalId);
    expect(recapture.proposals[0]!.proposalDigest).not.toBe(original.proposalDigest);
  });

  test("the module is exported, its codes are closed lists", () => {
    expect(domain.proposeOwnTransfers).toBe(proposeOwnTransfers);
    for (const list of [
      OWN_TRANSFER_PAIR_REFUSALS,
      OWN_TRANSFER_PROPOSAL_CODES,
      OWN_TRANSFER_ROW_REFUSALS,
    ])
      expect(new Set(list).size).toBe(list.length);
  });
});

describe("review round 1: closed ownership, ids and competing counterparts", () => {
  test("an ownership state other than self or other is unresolved; self needs an account id", async () => {
    const odd: AccountOwnershipSource = {
      version: "synthetic-ownership-odd",
      ownershipOf: (_sourceId, sourceAccount) =>
        sourceAccount === "smbc-bank:synthetic-a"
          ? ({ state: "maybe", accountId: "acct-synthetic-a" } as unknown as AccountOwnership)
          : sourceAccount === "smbc-bank:synthetic-b"
            ? ({ state: "self" } as unknown as AccountOwnership)
            : ownership.ownershipOf(_sourceId, sourceAccount),
    };
    const result = await ok([debitA(), creditB()], { ownership: odd });
    expect(result.rowRefusals).toEqual([
      { observationId: 1, code: "ownership_unresolved" },
      { observationId: 2, code: "ownership_unresolved" },
    ]);
    expect(result.proposals).toEqual([]);
  });

  test("an observation id given twice is refused for both rows: row_invalid", async () => {
    const result = await ok([debitA(1), creditB(1), creditB(2)]);
    expect(result.rowRefusals).toEqual([
      { observationId: 1, code: "row_invalid" },
      { observationId: 1, code: "row_invalid" },
    ]);
  });

  test("the identity epoch is part of the proposal id", async () => {
    const base = (await ok([debitA(), creditB()])).proposals[0]!.proposalId;
    const later = (await ok([debitA(), creditB()], { identityEpoch: "identity-epoch-2" }))
      .proposals[0]!.proposalId;
    expect(later).not.toBe(base);
  });

  test("a competing credit refused as duplicate_unresolved still makes the pair need review", async () => {
    // Credit 3 (account c) is one provider row under two producers whose
    // values disagree: refused, but it fits debit 1 as well as credit 2 does.
    const twinA = smbc({
      id: 3,
      account: "smbc-bank:synthetic-c",
      amount: "1000",
      meisai: "meisai-3",
    });
    const twinB = smbc({
      id: 4,
      account: "smbc-bank:synthetic-c",
      amount: "1000",
      meisai: "meisai-3",
      producer: "producer-2",
      date: "2030-01-11",
    });
    const result = await ok([debitA(), creditB(), twinA, twinB]);
    expect(result.rowRefusals.map((r) => r.code)).toEqual([
      "duplicate_unresolved",
      "duplicate_unresolved",
    ]);
    expect(result.proposals.map((p) => p.status)).toEqual(["needs_review"]);
    expect(result.proposals[0]!.codes).toContain("candidate_not_unique");
    // A group that does not fit (another amount) leaves the pair proposed.
    const far = [
      smbc({ id: 3, account: "smbc-bank:synthetic-c", amount: "5000", meisai: "meisai-3" }),
      smbc({
        id: 4,
        account: "smbc-bank:synthetic-c",
        amount: "5000",
        meisai: "meisai-3",
        producer: "producer-2",
        date: "2030-01-11",
      }),
    ];
    expect((await ok([debitA(), creditB(), ...far])).proposals.map((p) => p.status)).toEqual([
      "proposed",
    ]);
  });

  test("a competing credit without a posting day still makes the pair need review", async () => {
    const dateless = smbc({ id: 3, account: "smbc-bank:synthetic-c", amount: "1000", date: null });
    const result = await ok([debitA(), creditB(), dateless]);
    expect(result.rowRefusals).toEqual([{ observationId: 3, code: "posting_date_missing" }]);
    expect(result.proposals.map((p) => p.status)).toEqual(["needs_review"]);
    // On the debit's own account it cannot be a counterpart: the pair stays proposed.
    const sameAccount = smbc({
      id: 3,
      account: "smbc-bank:synthetic-a",
      amount: "1000",
      date: null,
    });
    expect((await ok([debitA(), creditB(), sameAccount])).proposals.map((p) => p.status)).toEqual([
      "proposed",
    ]);
  });
});

describe("review round 2: a dateless recapture of a usable row", () => {
  test("fails closed: the row's own pair needs review", async () => {
    // Observation 3 is debit 1's provider row captured again without a posting day.
    const recapture = { ...debitA(1), observationId: 3, postingDate: null };
    const result = await ok([debitA(1), creditB(2), recapture]);
    expect(result.rowRefusals).toEqual([{ observationId: 3, code: "posting_date_missing" }]);
    expect(result.proposals.map((p) => p.status)).toEqual(["needs_review"]);
  });
});

describe("mutation-style: the pairing rule against an independent oracle", () => {
  // The oracle: integer minor units (scale 2) as bigint, the window and the
  // fee bound restated here, independent of the engine's decimal helpers.
  const oracle = (debit: bigint, credit: bigint, days: number, fee: bigint | null): string => {
    if (days < 0 || days > 2) return "date_outside_window";
    const difference = -debit - credit;
    const allowed = fee ?? 0n;
    return difference < 0n || difference > allowed
      ? "amount_outside_policy"
      : difference === 0n
        ? "amount_equal"
        : "difference_within_policy";
  };
  const text = (minor: bigint) => {
    const negative = minor < 0n;
    const abs = negative ? -minor : minor;
    return `${negative ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
  };

  test("every perturbation of amount, date and fee bound gives the oracle's answer", async () => {
    const debits = [-100000n, -100001n, -99999n, -101000n, -100999n, -1n];
    const credits = [100000n, 99000n, 99001n, 100001n, 1n];
    const days = [-1, 0, 1, 2, 3];
    const fees: (bigint | null)[] = [null, 1000n, 999n, 1n];
    let checked = 0;
    for (const fee of fees) {
      const policy: OwnTransferPolicy =
        fee === null
          ? EXACT
          : {
              ...EXACT,
              difference: {
                rule: "fee-within",
                maxByCurrency: [{ currency: "JPY", amount: text(fee) }],
              },
            };
      for (const debit of debits)
        for (const credit of credits)
          for (const day of days) {
            const date = `2030-01-${String(10 + day).padStart(2, "0")}`;
            const result = await ok([debitA(1, text(debit)), creditB(2, text(credit), date)], {
              policy,
            });
            const answer = result.proposals[0]?.codes.at(-1) ?? result.pairRefusals[0]?.code;
            expect(answer as string | undefined).toBe(oracle(debit, credit, day, fee));
            checked += 1;
          }
    }
    expect(checked).toBe(fees.length * debits.length * credits.length * days.length);
  });
});

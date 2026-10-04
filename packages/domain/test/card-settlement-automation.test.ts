import { expect, test } from "bun:test";
import {
  assessSettlementAutomation,
  type SettlementAutomationCandidate,
  type SettlementAutomationScope,
} from "../src/card-settlement-automation.ts";
import { cardSettlementCandidate } from "../src/card-settlement.ts";
import { exactQuantity, integerDecimal } from "../src/values.ts";

const amount = exactQuantity("JPY", integerDecimal(3000));
const date = {
  kind: "local-date" as const,
  value: "2099-01-10",
  zone: "Asia/Tokyo",
  basis: "provider" as const,
};
const candidate: SettlementAutomationCandidate = {
  statementKey: "card-month-a",
  bankKey: "debit-a",
  facts: cardSettlementCandidate(
    {
      ref: { kind: "balance", id: "balance:1", revision: "parse_run:1" },
      sourceId: "myjcb",
      sourceAccount: "myjcb:synthetic:root",
      accountId: "card-a",
      ownerRef: "party:a",
      amount,
      paymentDate: date,
      period: "2099-01",
    },
    {
      ref: { kind: "transaction", id: "transaction:2", revision: "parse_run:2" },
      sourceId: "smbc-bank",
      sourceAccount: "smbc-bank:ordinary-yen",
      accountId: "bank-a",
      ownerRef: "party:a",
      amount,
      occurred: date,
    },
    ["ownership:synthetic"],
  )!,
  sourceCurrent: true,
  ownershipCurrent: true,
  allocationAvailable: true,
  priorDecision: false,
  windowComplete: true,
  providerAccountEvidence: "supports",
  bankAccount: {
    comparable: true,
    sourceId: "smbc-bank",
    sourceAccount: "smbc-bank:ordinary-yen",
    accountType: "ordinary",
    branchCode: "123",
    accountNumber: "0012345",
    evidenceRefs: [{ kind: "transaction", id: "transaction:2", revision: "parse_run:2" }],
  },
};
const scope: SettlementAutomationScope = {
  authorizationRef: "policy:synthetic-accepted",
  cardAccountId: "card-a",
  bankAccountId: "bank-a",
  validFrom: "2099-01-01",
  validTo: null,
  bank: {
    sourceId: "smbc-bank",
    accountType: "ordinary",
    branchCode: "123",
    accountNumber: "0012345",
  },
};
const assess = (
  c = candidate,
  peers = [c],
  s: SettlementAutomationScope | null = scope,
  complete = true,
) => assessSettlementAutomation(c, peers, { scope: s, complete });

test("a fully evidenced and scoped one-to-one pair is only a shadow verdict", () => {
  const before = JSON.stringify(candidate);
  expect(assess()).toMatchObject({ outcome: "would_accept", blockers: [] });
  expect(JSON.stringify(candidate)).toBe(before);
  expect(assess(candidate, [candidate, { ...candidate }])).toMatchObject({
    outcome: "would_accept",
  });
});
test("both directions compete, even if a peer itself lacks ownership", () => {
  const otherDebit = { ...candidate, bankKey: "debit-b", ownershipCurrent: false };
  const otherBill = { ...candidate, statementKey: "card-month-b", ownershipCurrent: false };
  expect(assess(candidate, [candidate, otherDebit]).blockers).toContain(
    "statement_has_multiple_debits",
  );
  expect(assess(candidate, [candidate, otherBill]).blockers).toContain(
    "debit_has_multiple_statements",
  );
  expect(assess(candidate, [candidate, { ...otherDebit, sourceCurrent: false }]).outcome).toBe(
    "would_accept",
  );
});
test("missing scope, truncated input, missing coverage and old source facts remain reasons", () => {
  expect(assess(candidate, [candidate], null).blockers).toContain("scope_not_authorized");
  expect(assess(candidate, [candidate], scope, false).blockers).toContain(
    "candidate_set_incomplete",
  );
  expect(assess(candidate, []).blockers).toContain("candidate_set_incomplete");
  for (const [field, reason] of [
    ["sourceCurrent", "source_not_current"],
    ["ownershipCurrent", "ownership_not_established"],
    ["allocationAvailable", "allocation_unavailable"],
    ["windowComplete", "acquisition_incomplete"],
  ] as const)
    expect(assess({ ...candidate, [field]: false }).blockers).toContain(reason);
});
test("scope and account digits are checked independently of matching money", () => {
  expect(
    assess(candidate, [candidate], { ...scope, cardAccountId: "another-card" }).blockers,
  ).toContain("outside_authorized_scope");
  expect(assess(candidate, [candidate], { ...scope, validFrom: "2099-01-11" }).blockers).toContain(
    "outside_authorized_scope",
  );
  expect(assess(candidate, [candidate], { ...scope, validTo: "2098-12-31" }).blockers).toContain(
    "outside_authorized_scope",
  );
  expect(
    assess(candidate, [candidate], { ...scope, bank: { ...scope.bank, accountNumber: "9912345" } })
      .blockers,
  ).toContain("bank_account_scope_mismatch");
  expect(
    assess({
      ...candidate,
      bankAccount: {
        comparable: false,
        sourceId: "smbc-bank",
        sourceAccount: "smbc-bank:ordinary-yen",
        reason: "reference_without_account_number",
      },
    }).blockers,
  ).toContain("bank_account_number_missing");
});
test("contradictory evidence and any earlier decision cannot be auto-overridden", () => {
  expect(assess({ ...candidate, providerAccountEvidence: "conflicts" }).blockers).toContain(
    "provider_account_conflict",
  );
  expect(assess({ ...candidate, providerAccountEvidence: "unknown" }).blockers).toContain(
    "provider_account_unresolved",
  );
  expect(
    assess(candidate, [candidate, { ...candidate, priorDecision: true, sourceCurrent: false }])
      .blockers,
  ).toContain("prior_decision");
  // Vpass's documented absence is distinct from a failed MyJCB reading.
  expect(assess({ ...candidate, providerAccountEvidence: "absent" }).outcome).toBe("would_accept");
});

test("bank evidence is bound to this debit, never copied from another capture", () => {
  if (!candidate.bankAccount.comparable) throw new Error("fixture");
  const missing = { ...candidate.bankAccount };
  delete missing.evidenceRefs;
  expect(assess({ ...candidate, bankAccount: missing }).blockers).toContain(
    "bank_account_evidence_mismatch",
  );

  for (const change of [
    { sourceId: "another-bank" },
    { sourceAccount: "another-account" },
    { evidenceRefs: [] },
    {
      evidenceRefs: [
        { kind: "transaction" as const, id: "transaction:3", revision: "parse_run:2" },
      ],
    },
    {
      evidenceRefs: [
        { kind: "transaction" as const, id: "transaction:2", revision: "parse_run:3" },
      ],
    },
  ]) {
    const result = assess({ ...candidate, bankAccount: { ...candidate.bankAccount, ...change } });
    expect(result.outcome).toBe("blocked");
    expect(result.blockers).toContain("bank_account_evidence_mismatch");
  }
});

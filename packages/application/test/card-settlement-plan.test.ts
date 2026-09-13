import { describe, expect, test } from "bun:test";
import { cardSettlementCandidate } from "../../domain/src/card-settlement.ts";
import { exactQuantity, integerDecimal } from "../../domain/src/values.ts";
import type { CommandStore } from "../src/command/contract.ts";
import { resolveAndSimulate } from "../src/operations/targets.ts";

const amount = exactQuantity("JPY", integerDecimal(1234));
const date = {
  kind: "local-date" as const,
  value: "2026-06-15",
  zone: "Asia/Tokyo",
  basis: "provider" as const,
};
const facts = cardSettlementCandidate(
  {
    ref: { kind: "balance", id: "balance:1", revision: "parse_run:1" },
    sourceId: "myjcb",
    sourceAccount: "card",
    accountId: "card-account",
    ownerRef: "party:owner",
    amount,
    paymentDate: date,
    period: "2026-06",
  },
  {
    ref: { kind: "transaction", id: "transaction:2", revision: "parse_run:2" },
    sourceId: "smbc-bank",
    sourceAccount: "bank",
    accountId: "bank-account",
    ownerRef: "party:owner",
    amount,
    occurred: date,
  },
  ["decision:owner-proof"],
)!;
const row = {
  id: "candidate",
  facts_json: JSON.stringify(facts),
  status: "proposed",
  revision: 0,
  statement_current: 1,
  bank_current: 1,
  ownership_current: 1,
  allocation_available: 1,
};
function store(value: unknown): CommandStore {
  return { first: async <T>() => value as T | null, all: async () => [], batch: async () => [] };
}
const payload = { proposalId: "candidate", reason: "Reviewed statement and debit" };

describe("card settlement plan pins server facts", () => {
  test("plans the real candidate revision and exposes scope without financial values", async () => {
    const result = await resolveAndSimulate(store(row), "card-settlement.accept", payload);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.resolved.expectedRevisions).toEqual({ "card-settlement:candidate": 0 });
    expect(result.resolved.simulation).toMatchObject({
      affectedScopes: ["myjcb", "smbc-bank"],
      affectedParseRuns: 2,
      before: { attributedObservations: 2, relations: 0 },
      after: { attributedObservations: 2, relations: 1 },
    });
    expect(JSON.stringify(result.resolved.simulation)).not.toContain("1234");
    expect(result.resolved.targets[0]?.proposedTargetRef).toBe("accepted");
  });
  test("current evidence and allocation readiness are required even at the same decision revision", async () => {
    for (const flag of [
      "statement_current",
      "bank_current",
      "ownership_current",
      "allocation_available",
    ] as const) {
      expect(
        await resolveAndSimulate(store({ ...row, [flag]: 0 }), "card-settlement.accept", payload),
      ).toMatchObject({ ok: false, error: "stale_context" });
    }
  });

  test("missing and corrupt evidence cannot produce an approval plan", async () => {
    expect(await resolveAndSimulate(store(null), "card-settlement.accept", payload)).toMatchObject({
      ok: false,
      error: "target_missing",
    });
    expect(
      await resolveAndSimulate(
        store({ ...row, facts_json: "{" }),
        "card-settlement.accept",
        payload,
      ),
    ).toMatchObject({ ok: false, error: "incomplete_evidence" });
  });
  test("unknown ownership allows rejection but never acceptance", async () => {
    const unknown = {
      ...facts,
      ownership: "unknown",
      ownershipEvidenceRefs: [],
      statement: { ...facts.statement, ownerRef: null },
    };
    const unresolved = store({ ...row, facts_json: JSON.stringify(unknown) });
    expect(await resolveAndSimulate(unresolved, "card-settlement.accept", payload)).toMatchObject({
      ok: false,
      error: "needs_scope_resolution",
    });
    expect(await resolveAndSimulate(unresolved, "card-settlement.reject", payload)).toMatchObject({
      ok: true,
    });
  });
  test("withdrawal pins the accepted revision; terminal or unaccepted decisions cannot be withdrawn", async () => {
    const accepted = await resolveAndSimulate(
      store({ ...row, status: "accepted", revision: 1 }),
      "card-settlement.withdraw",
      payload,
    );
    expect(accepted).toMatchObject({
      ok: true,
      resolved: {
        expectedRevisions: { "card-settlement:candidate": 1 },
        targets: [{ proposedTargetRef: "withdrawn" }],
      },
    });
    for (const status of ["proposed", "rejected", "withdrawn"])
      expect(
        await resolveAndSimulate(store({ ...row, status }), "card-settlement.withdraw", payload),
      ).toMatchObject({ ok: false, error: "stale_context" });
    expect(
      await resolveAndSimulate(
        store({ ...row, status: "withdrawn" }),
        "card-settlement.accept",
        payload,
      ),
    ).toMatchObject({ ok: false, error: "stale_context" });
  });
});

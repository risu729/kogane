import { describe, expect, test } from "bun:test";
import { cardSettlementCandidate } from "../../domain/src/card-settlement.ts";
import { exactQuantity, integerDecimal } from "../../domain/src/values.ts";
import { CARD_SETTLEMENT_KEY_AVAILABLE_SQL } from "../../read-model/src/card-settlement-readiness.ts";
import { commandKey, type CommandStore } from "../src/command/contract.ts";
import { CARD_SETTLEMENT_BANK_ROW_SQL } from "../src/operations/card-settlement-target.ts";
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
  claim_available: 1,
  event_id: null,
};
/** The cited SMBC debit as the parser stores it: its provider id and recorded origin. */
const bankRow = {
  source_id: "smbc-bank",
  parser_name: "smbc-direct-transactions",
  source_account: "smbc-bank:ordinary-yen",
  external_id: "synthetic-debit",
  extra_json: JSON.stringify({
    id: "synthetic-debit",
    _kogane: { identityOrigin: "provider-id" },
  }),
};
function store(
  value: unknown,
  bank: unknown = bankRow,
  key: unknown = { key_available: 1 },
): CommandStore {
  return {
    first: async <T>(sql: string) =>
      (sql === CARD_SETTLEMENT_BANK_ROW_SQL
        ? bank
        : sql === CARD_SETTLEMENT_KEY_AVAILABLE_SQL
          ? key
          : value) as T | null,
    all: async () => [],
    batch: async () => [],
  };
}
const payload = { proposalId: "candidate", reason: "Reviewed statement and debit" };

describe("card settlement plan pins server facts", () => {
  test("plans the real candidate revision and exposes scope without financial values", async () => {
    const result = await resolveAndSimulate(store(row), "card-settlement.accept", payload);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    // The review, and the settlement event's head: no revision yet (ADR 0054).
    expect(result.resolved.expectedRevisions).toEqual({
      "card-settlement:candidate": 0,
      [`economic-event:${await commandKey("event", ["candidate"])}`]: 0,
    });
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
      "claim_available",
    ] as const) {
      expect(
        await resolveAndSimulate(store({ ...row, [flag]: 0 }), "card-settlement.accept", payload),
      ).toMatchObject({ ok: false, error: "stale_context" });
    }
  });

  test("a debit another writer consumes is refused with the guard's code (ADR 0054)", async () => {
    expect(
      await resolveAndSimulate(
        store({ ...row, claim_available: 0 }, bankRow, { key_available: 0 }),
        "card-settlement.accept",
        payload,
      ),
    ).toEqual({
      ok: false,
      error: "stale_context",
      refs: ["card-settlement:candidate", "economic_claim_held"],
    });
    // The key is free; the same fact is held under another key.
    expect(
      await resolveAndSimulate(
        store({ ...row, claim_available: 0 }, bankRow, { key_available: 1 }),
        "card-settlement.accept",
        payload,
      ),
    ).toEqual({
      ok: false,
      error: "stale_context",
      refs: ["card-settlement:candidate", "alias_conflict"],
    });
  });

  test("an SBI Shinsei debit stored by parser 0.1.3 is admitted; the same row stored by 0.1.2 is not", async () => {
    const shinsei = (kogane: Record<string, unknown>) => ({
      source_id: "sbi-shinsei-bank",
      parser_name: "sbi-shinsei-top-balances-and-activity",
      source_account: "sbi-shinsei:synthetic",
      external_id: "synthetic-ref",
      extra_json: JSON.stringify({
        txnReferenceNo: "synthetic-ref",
        _kogane: { amountSignSource: "debit", ...kogane },
      }),
    });
    // 0.1.3 records the origin: rule 2 no longer refuses, the plan is made
    // (a plan only; approval and commit stay a human's, ADR 0054).
    const admitted = await resolveAndSimulate(
      store(row, shinsei({ identityOrigin: "provider-id" })),
      "card-settlement.accept",
      payload,
    );
    expect(admitted.ok).toBe(true);
    // 0.1.2 recorded none.
    expect(
      await resolveAndSimulate(store(row, shinsei({})), "card-settlement.accept", payload),
    ).toEqual({
      ok: false,
      error: "unsupported_semantics",
      refs: ["card-settlement:candidate", "identity_origin_unrecorded"],
    });
  });

  test("the debit's identity must be admitted: a closed refusal, nothing adopted (ADR 0054)", async () => {
    const refused = async (bank: unknown) =>
      resolveAndSimulate(store(row, bank), "card-settlement.accept", payload);
    // No recorded origin (an SBI Shinsei row a 0.1.2 run stored; 0.1.3 records it).
    expect(
      await refused({
        source_id: "sbi-shinsei-bank",
        parser_name: "sbi-shinsei-top-balances-and-activity",
        source_account: "sbi-shinsei:synthetic",
        external_id: "synthetic-ref",
        extra_json: JSON.stringify({ txnReferenceNo: "synthetic-ref", _kogane: {} }),
      }),
    ).toEqual({
      ok: false,
      error: "unsupported_semantics",
      refs: ["card-settlement:candidate", "identity_origin_unrecorded"],
    });
    // An SMBC row whose parser recorded no origin.
    expect(
      await refused({ ...bankRow, extra_json: JSON.stringify({ id: "synthetic-debit" }) }),
    ).toEqual({
      ok: false,
      error: "unsupported_semantics",
      refs: ["card-settlement:candidate", "identity_origin_unrecorded"],
    });
    // A fingerprint id.
    expect(
      await refused({
        ...bankRow,
        source_id: "mizuho-bank",
        parser_name: "mizuho-ordinary-history",
        extra_json: "{}",
      }),
    ).toEqual({
      ok: false,
      error: "unsupported_semantics",
      refs: ["card-settlement:candidate", "identity_fingerprint_only"],
    });
    // An unreadable bank row is incomplete evidence.
    expect(await refused(null)).toMatchObject({ ok: false, error: "incomplete_evidence" });
    // A rejection reads no identity.
    expect(
      await resolveAndSimulate(store(row, null), "card-settlement.reject", payload),
    ).toMatchObject({ ok: true });
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
      store({ ...row, status: "accepted", revision: 1, event_id: "settlement-event" }),
      "card-settlement.withdraw",
      payload,
    );
    expect(accepted).toMatchObject({
      ok: true,
      resolved: {
        expectedRevisions: {
          "card-settlement:candidate": 1,
          // The accepted event revision the withdrawal supersedes.
          "economic-event:settlement-event": 1,
        },
        targets: [{ proposedTargetRef: "withdrawn" }],
      },
    });
    // Another live holder of the key: the release would wash a double holder (ADR 0054).
    expect(
      await resolveAndSimulate(
        store({ ...row, status: "accepted", revision: 1, event_id: "settlement-event" }, bankRow, {
          key_available: 0,
        }),
        "card-settlement.withdraw",
        payload,
      ),
    ).toEqual({
      ok: false,
      error: "needs_scope_resolution",
      refs: ["card-settlement:candidate", "economic_claim_conflict_unresolved"],
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

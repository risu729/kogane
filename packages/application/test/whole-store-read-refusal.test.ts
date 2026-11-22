// The whole-store read gate these reads share (`wholeStoreReadRefusal` and
// `narrowedScopeRefs` in src/grants.ts): the read's capability first, then
// both store axes whole-store, refused before anything is read. Each read's
// refusal is compared, as JSON text, with what its own hand-written gate
// answered before the gate was shared: `legacyGate` below is that code,
// frozen, and each read keeps its outcome wrapper. So the move changes no
// byte: the same code, request id, remedy, refs and ref order. This file
// imports only the reads, so it runs unchanged against the code before the
// move. Each call carries an argument the read refuses past its gate, so a
// read that checked it first would fail here. Synthetic grants only; no store
// is read (`untouched` throws).
import { describe, expect, it } from "bun:test";
import type { FinancialError } from "../../domain/src/result.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { financialError } from "../src/errors.ts";
import { type AgentCapability, fullGrant, type Grant, grantAllows } from "../src/grants.ts";
import { reviewAccountCandidates } from "../src/query/account-candidates.ts";
import { readAccountHistoryForGrant } from "../src/query/account-history-read.ts";
import { reviewCardDebitAccounts } from "../src/query/card-debit-accounts.ts";
import {
  readCardOwnershipForGrant,
  readCardSettlementsForGrant,
  readCardSettlementStatementsForGrant,
} from "../src/query/card-settlements-read.ts";
import { reviewUnmatchedCardStatements } from "../src/query/card-statements-unmatched.ts";
import { changesSinceGrantRefusal, readChangesSince } from "../src/query/changes-since.ts";
import { readEconomicRowReadinessForGrant } from "../src/query/economic-row-readiness-read.ts";
import { reviewInstrumentCandidates } from "../src/query/instrument-candidates-review.ts";
import { readInstrumentCoverage } from "../src/query/instrument-coverage.ts";
import { readInstrumentHistoryForGrant } from "../src/query/instrument-history-read.ts";
import { readPendingDecisions } from "../src/query/pending-decisions.ts";
import {
  explainCardPurchaseCards,
  explainCardPurchaseLines,
  explainCardPurchases,
} from "../src/query/purchases-explain.ts";
import { readReconstructedState } from "../src/query/reconstructed-state-read.ts";

/** The gate each read wrote out by hand before it was shared, frozen. */
function legacyGate(
  grant: Grant,
  capability: AgentCapability,
): { code: "unauthorized" | "evidence_restricted"; refs: string[] } | null {
  if (!grantAllows(grant, capability))
    return { code: "unauthorized", refs: [`capability:${capability}`] };
  const narrowed = [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
  return narrowed.length > 0 ? { code: "evidence_restricted", refs: narrowed } : null;
}

const untouched: SqlExecutor = {
  all: async () => {
    throw new Error("read");
  },
  first: async () => {
    throw new Error("read");
  },
};

const NOW = "2026-01-15T00:00:00Z";
/**
 * Arguments each read refuses, or throws on, once past its gate: a read that
 * checked its argument before its grant would answer that refusal instead.
 */
const BAD = "!bad";
const BEYOND = Number.MAX_SAFE_INTEGER;
const whole = fullGrant("synthetic");
const narrowed = (scopes: Partial<Grant["scopes"]>, capabilities = whole.capabilities): Grant => ({
  ...whole,
  scopes: { ...whole.scopes, ...scopes },
  capabilities,
});

/** Each grant a whole-store read refuses, by name. */
const GRANTS: Record<string, Grant> = {
  "no capability": narrowed({}, []),
  "no capability, both axes narrowed": narrowed({ sources: ["s"], accounts: ["a"] }, []),
  "sources narrowed": narrowed({ sources: ["s"] }),
  "accounts narrowed": narrowed({ accounts: ["a"] }),
  "both axes narrowed": narrowed({ sources: ["s"], accounts: ["a"] }),
  "both axes empty": narrowed({ sources: [], accounts: [] }),
};

type Wrapper = "ok" | "status" | "bare" | "reconstructed";
/** How each read wraps its refusal: `{ok: false, error}`, `{status: "refused", error}`, the error itself, or reconstructed state's `{ok: false, refusal, refs}`. */
function wrapped(
  wrapper: Wrapper,
  requestId: string,
  gate: NonNullable<ReturnType<typeof legacyGate>>,
): unknown {
  if (wrapper === "reconstructed")
    return {
      ok: false,
      refusal: gate.code === "unauthorized" ? "capability_missing" : "scope_restricted",
      refs: gate.refs,
    };
  const error: FinancialError = financialError(gate.code, requestId, gate.refs);
  if (wrapper === "bare") return error;
  return wrapper === "ok" ? { ok: false, error } : { status: "refused", error };
}

/** The reads whose gate is the only check before the store: they take no argument. */
const WITHOUT_ARGUMENT = new Set([
  "card-settlements.debit-accounts",
  "changes.since (the adapters' gate)",
]);

/** Every read that refuses a grant short of the whole store: its wrapper, request id, capability and call. */
const READS: Record<
  string,
  [Wrapper, string, AgentCapability, (grant: Grant) => Promise<unknown>]
> = {
  "accounts.candidates": [
    "ok",
    "accounts.candidates",
    "records.read",
    (grant) =>
      reviewAccountCandidates({ grant, sql: untouched, request: { offset: BEYOND } as never }),
  ],
  "accounts.history": [
    "ok",
    "accounts.history",
    "records.read",
    (grant) => readAccountHistoryForGrant({ grant, sql: untouched, sourceAccountId: BAD }),
  ],
  "card-settlements.debit-accounts": [
    "ok",
    "card-settlements.debit-accounts",
    "records.read",
    (grant) => reviewCardDebitAccounts({ grant, sql: untouched }),
  ],
  "card-settlements.read": [
    "status",
    "card-settlements.read",
    "records.read",
    (grant) => readCardSettlementsForGrant({ grant, sql: untouched, request: { bad: BAD } }),
  ],
  "card-settlements.statements": [
    "status",
    "card-settlements.statements",
    "records.read",
    (grant) =>
      readCardSettlementStatementsForGrant({ grant, sql: untouched, request: { bad: BAD } }),
  ],
  "card-settlements.ownership": [
    "status",
    "card-settlements.ownership",
    "records.read",
    (grant) => readCardOwnershipForGrant({ grant, sql: untouched, request: { bad: BAD } }),
  ],
  "card-settlements.unmatched": [
    "ok",
    "card-settlements.unmatched",
    "records.read",
    (grant) =>
      reviewUnmatchedCardStatements({
        grant,
        sql: untouched,
        request: { offset: BEYOND } as never,
      }),
  ],
  "changes.since (the adapters' gate)": [
    "bare",
    "changes.since",
    "records.read",
    async (grant) => changesSinceGrantRefusal(grant),
  ],
  "changes.since": [
    "ok",
    "changes.since",
    "records.read",
    (grant) =>
      readChangesSince({
        grant,
        sql: untouched,
        served: { events: true },
        request: { since: BAD },
        now: NOW,
      }),
  ],
  "economic-readiness.read": [
    "status",
    "economic-readiness.read",
    "records.read",
    (grant) => readEconomicRowReadinessForGrant({ grant, sql: untouched, request: { bad: BAD } }),
  ],
  "instruments.candidates": [
    "ok",
    "instruments.candidates",
    "records.read",
    (grant) =>
      reviewInstrumentCandidates({ grant, sql: untouched, request: { offset: BEYOND } as never }),
  ],
  "instruments.coverage": [
    "ok",
    "instruments.coverage",
    "summary.read",
    (grant) => readInstrumentCoverage({ grant, sql: untouched, source: "" }),
  ],
  "instruments.history": [
    "ok",
    "instruments.history",
    "records.read",
    (grant) => readInstrumentHistoryForGrant({ grant, sql: untouched, identifierId: BAD }),
  ],
  "decisions.pending": [
    "ok",
    "decisions.pending",
    "records.read",
    (grant) => readPendingDecisions({ grant, sql: untouched, served: {} as never, now: BAD }),
  ],
  "purchases.explain": [
    "ok",
    "purchases.explain",
    "records.read",
    (grant) =>
      explainCardPurchases({ grant, sql: untouched, request: { offset: BEYOND } as never }),
  ],
  "purchases.explain (cards)": [
    "ok",
    "purchases.explain",
    "records.read",
    (grant) => explainCardPurchaseCards({ grant, sql: untouched, request: { bad: BAD } as never }),
  ],
  "purchases.explain (lines)": [
    "ok",
    "purchases.explain",
    "records.read",
    (grant) => explainCardPurchaseLines({ grant, sql: untouched, request: { bad: BAD } as never }),
  ],
  "reconstructed-state.read": [
    "reconstructed",
    "",
    "records.read",
    (grant) => readReconstructedState({ grant, sql: untouched, body: { bad: BAD }, now: NOW }),
  ],
};

describe("a whole-store read refuses a narrower grant byte for byte as its own gate did", () => {
  for (const [read, [wrapper, requestId, capability, call]] of Object.entries(READS))
    it(read, async () => {
      for (const [name, grant] of Object.entries(GRANTS)) {
        const gate = legacyGate(grant, capability);
        expect(gate, name).not.toBeNull();
        expect(JSON.stringify(await call(grant)), name).toBe(
          JSON.stringify(wrapped(wrapper, requestId, gate!)),
        );
      }
    });

  it("gives each read an argument it refuses, or throws on, once past its gate", async () => {
    for (const [read, [, , , call]] of Object.entries(READS)) {
      if (WITHOUT_ARGUMENT.has(read)) continue;
      const outcome = await call(whole).then(
        (answer) => JSON.stringify(answer),
        (error: unknown) => String(error),
      );
      // A read that took the argument would reach the store, which throws `read`.
      expect(outcome, read).not.toBe(String(new Error("read")));
      expect(outcome, read).not.toMatch(
        /unauthorized|evidence_restricted|capability_missing|scope_restricted/u,
      );
    }
  });

  it("covers every refusal shape: the capability first, then each narrowed axis in order", () => {
    const refs = Object.values(GRANTS).map((grant) => legacyGate(grant, "records.read")?.refs);
    expect(refs).toEqual([
      ["capability:records.read"],
      ["capability:records.read"],
      ["scope:source"],
      ["scope:account"],
      ["scope:source", "scope:account"],
      ["scope:source", "scope:account"],
    ]);
  });
});

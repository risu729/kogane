// The statement allocation planner (ADR 0074, issue #548): what today's
// one-to-one matcher does with a statement two debits pay or one debit pays in
// part, the policy refusals, the INV06 exclusions, the closed outcomes for a
// shortfall or an excess, ambiguity within and across statements, and a
// property comparison with an independent brute-force oracle on seeded random
// inputs. Every value is synthetic: invented accounts, ids, keys, round
// amounts and dates in the shapes the bank adapters admit.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import * as domain from "../src/index.ts";
import {
  ALLOCATION_DEBIT_EXCLUSIONS,
  ALLOCATION_OUTCOME_CODES,
  ALLOCATION_PAIR_EXCLUSIONS,
  ALLOCATION_RATIONALE_CODES,
  ALLOCATION_RUN_REFUSALS,
  ALLOCATION_STATEMENT_REFUSALS,
  CARD_STATEMENT_ALLOCATION_DEBITS_MAX,
  CARD_STATEMENT_ALLOCATION_RELEASE,
  CARD_STATEMENT_ALLOCATION_STATEMENTS_MAX,
  planCardStatementAllocations,
  validCardStatementAllocationPolicy,
  type AllocationDebitExclusion,
  type AllocationDebitInput,
  type AllocationStatementInput,
  type CardStatementAllocationInput,
  type CardStatementAllocationPolicy,
  type CardStatementAllocationRun,
  type StatementAllocationResult,
} from "../src/card-settlement-allocation.ts";
import {
  cardSettlementCandidate,
  type CardBankDebitFact,
  type CardStatementFact,
} from "../src/card-settlement.ts";
import {
  absentQuantity,
  compareQuantities,
  decimalLiteral,
  exactQuantity,
  integerDecimal,
  normalizeDecimal,
  sumQuantities,
  type Quantity,
} from "../src/values.ts";

const POLICY: CardStatementAllocationPolicy = {
  policyVersion: "synthetic-allocation-policy-1",
  window: { minDaysFromDue: -3, maxDaysFromDue: 3 },
  maxDebitsPerAllocation: 2,
};

const yen = (amount: number | string): Quantity =>
  exactQuantity(
    "JPY",
    typeof amount === "string" ? decimalLiteral(amount) : integerDecimal(amount),
  );
const day = (value: string) =>
  ({ kind: "local-date", value, zone: "Asia/Tokyo", basis: "provider" }) as const;

function statement(
  id: number,
  amount: Quantity | number = 3000,
  options: Partial<CardStatementFact> & { key?: string } = {},
): AllocationStatementInput {
  const { key, ...fact } = options;
  return {
    statementKey: key ?? `["vpass","synthetic-card-${id}","2026-09"]`,
    statement: {
      ref: { kind: "balance", id: `balance:${id}`, revision: `parse_run:${id}` },
      sourceId: "vpass",
      sourceAccount: `vpass:synthetic-card-${id}`,
      accountId: `acct-card-${id}`,
      ownerRef: "party:synthetic-owner",
      amount: typeof amount === "number" ? yen(amount) : amount,
      paymentDate: day("2026-09-10"),
      period: "2026-09",
      ...fact,
    },
  };
}

function debit(
  id: number,
  amount: Quantity | number,
  options: Partial<CardBankDebitFact> & { key?: string; alias?: string | null } = {},
): AllocationDebitInput {
  const { key, alias, ...fact } = options;
  return {
    bankKey: key ?? `["smbc-bank","synthetic-bank","transaction",${id}]`,
    aliasClass:
      alias === undefined ? `["smbc-bank",["synthetic-meisai-${id}"],"acct-bank"]` : alias,
    debit: {
      ref: { kind: "transaction", id: `transaction:${id}`, revision: `parse_run:${100 + id}` },
      sourceId: "smbc-bank",
      sourceAccount: "smbc-bank:synthetic-bank",
      accountId: "acct-bank",
      ownerRef: "party:synthetic-owner",
      amount: typeof amount === "number" ? yen(amount) : amount,
      occurred: day("2026-09-10"),
      ...fact,
    },
  };
}

const NONE = { bankKeys: [], aliasClasses: [], statementKeys: [] };

function run(
  statements: readonly AllocationStatementInput[],
  debits: readonly AllocationDebitInput[],
  overrides: Partial<CardStatementAllocationInput> = {},
): Extract<CardStatementAllocationRun, { ok: true }> {
  const result = planCardStatementAllocations({
    statements,
    debits,
    policy: POLICY,
    held: NONE,
    ...overrides,
  });
  if (!result.ok) throw new Error(`run refused: ${result.refusal}`);
  return result;
}

const only = (
  result: Extract<CardStatementAllocationRun, { ok: true }>,
): StatementAllocationResult => result.statements[0]!;
const codesOf = (result: StatementAllocationResult): string[] =>
  result.outcome.status === "refused" ? [] : result.outcome.codes;
const memberIds = (result: StatementAllocationResult) =>
  result.outcome.status === "refused"
    ? []
    : result.outcome.allocations.map((allocation) => allocation.members.map((m) => m.ref.id));

describe("what the one-to-one matcher does today", () => {
  // `card_settlement_sweep` calls `cardSettlementCandidate` once per
  // (statement, debit) pair and writes a candidate only when it returns facts.
  test("a statement two debits pay together yields no candidate and no reason", () => {
    const s = statement(1, 3000).statement;
    expect(cardSettlementCandidate(s, debit(1, 1000).debit)).toBeNull();
    expect(cardSettlementCandidate(s, debit(2, 2000).debit)).toBeNull();
  });
  test("a debit that pays part of a statement yields no candidate and no reason", () => {
    expect(cardSettlementCandidate(statement(1, 3000).statement, debit(1, 2000).debit)).toBeNull();
  });
  test("the planner states both cases instead of dropping them", () => {
    expect(only(run([statement(1, 3000)], [debit(1, 1000), debit(2, 2000)])).outcome).toMatchObject(
      { status: "proposed" },
    );
    expect(only(run([statement(1, 3000)], [debit(1, 2000)])).outcome).toEqual({
      status: "unsupported",
      allocations: [],
      codes: ["no_exact_allocation", "in_window_debits_below_total"],
    });
  });
});

describe("policy and bounds", () => {
  test("a missing policy refuses the run; there is no default", () => {
    for (const policy of [null, undefined])
      expect(
        planCardStatementAllocations({ statements: [], debits: [], policy, held: NONE }),
      ).toEqual({ ok: false, refusal: "policy_missing" });
  });
  test("anything not exactly the policy shape is unsupported", () => {
    const bad: unknown[] = [
      { ...POLICY, policyVersion: "" },
      { ...POLICY, policyVersion: "Upper" },
      { ...POLICY, extra: true },
      { policyVersion: POLICY.policyVersion, window: POLICY.window },
      { ...POLICY, window: { minDaysFromDue: 4, maxDaysFromDue: 3 } },
      { ...POLICY, window: { minDaysFromDue: -32, maxDaysFromDue: 3 } },
      { ...POLICY, window: { minDaysFromDue: 0, maxDaysFromDue: 32 } },
      { ...POLICY, window: { minDaysFromDue: 0.5, maxDaysFromDue: 3 } },
      { ...POLICY, window: { minDaysFromDue: 0, maxDaysFromDue: 3, extra: 1 } },
      { ...POLICY, maxDebitsPerAllocation: 0 },
      { ...POLICY, maxDebitsPerAllocation: 4 },
      { ...POLICY, maxDebitsPerAllocation: 2.5 },
    ];
    for (const policy of bad) {
      expect(validCardStatementAllocationPolicy(policy)).toBe(false);
      expect(
        planCardStatementAllocations({
          statements: [],
          debits: [],
          policy: policy as CardStatementAllocationPolicy,
          held: NONE,
        }),
      ).toEqual({ ok: false, refusal: "policy_unsupported" });
    }
    expect(validCardStatementAllocationPolicy(POLICY)).toBe(true);
  });
  test("an input past a bound is refused whole, never cut", () => {
    const statements = Array.from(
      { length: CARD_STATEMENT_ALLOCATION_STATEMENTS_MAX + 1 },
      (_, i) => statement(i + 1),
    );
    const debits = Array.from({ length: CARD_STATEMENT_ALLOCATION_DEBITS_MAX + 1 }, (_, i) =>
      debit(i + 1, 1000),
    );
    const refused = { ok: false, refusal: "input_bound_exceeded" } as const;
    expect(
      planCardStatementAllocations({ statements, debits: [], policy: POLICY, held: NONE }),
    ).toEqual(refused);
    expect(
      planCardStatementAllocations({ statements: [], debits, policy: POLICY, held: NONE }),
    ).toEqual(refused);
    expect(
      planCardStatementAllocations({
        statements: statements.slice(1),
        debits: debits.slice(1),
        policy: POLICY,
        held: NONE,
      }).ok,
    ).toBe(true);
  });
  test("the manifest pins the release, the policy and the arithmetic", () => {
    expect(run([], []).manifest).toEqual({
      release: CARD_STATEMENT_ALLOCATION_RELEASE,
      policyVersion: POLICY.policyVersion,
      arithmeticVersion: "exact-arith-v1",
    });
  });
});

describe("exact allocations", () => {
  test("two debits whose exact sum is the total are one proposed allocation of both whole debits", () => {
    const result = only(run([statement(1, 3000)], [debit(2, 2000), debit(1, 1000)]));
    expect(result.outcome.status).toBe("proposed");
    if (result.outcome.status !== "proposed") return;
    const [allocation] = result.outcome.allocations;
    expect(allocation.kind).toBe("multiple-debits");
    expect(allocation.members.map((m) => [m.ref.id, m.allocated])).toEqual([
      ["transaction:1", yen(1000)],
      ["transaction:2", yen(2000)],
    ]);
    expect(allocation.allocatedTotal).toEqual(yen(3000));
    expect(allocation.rationaleCodes).toContain("amounts_sum_to_total");
    expect(allocation.ownership).toBe("established-same");
    expect(allocation.rejectionConditions).toEqual([
      "statement_changed",
      "bank_debit_changed",
      "allocation_already_used",
    ]);
  });
  test("a single equal debit is a single-debit allocation, the shape the sweep already proposes", () => {
    const result = only(run([statement(1, 3000)], [debit(1, 3000), debit(2, 500)]));
    expect(result.outcome).toMatchObject({
      status: "proposed",
      allocations: [
        { kind: "single-debit", rationaleCodes: expect.arrayContaining(["amount_equal"]) },
      ],
    });
    expect(
      cardSettlementCandidate(statement(1, 3000).statement, debit(1, 3000).debit),
    ).not.toBeNull();
  });
  test("decimal scales are compared exactly", () => {
    const total = exactQuantity("JPY", normalizeDecimal(30000n, 1));
    const result = only(
      run([statement(1, total)], [debit(1, yen("1000.5")), debit(2, yen("1999.5"))]),
    );
    expect(result.outcome.status).toBe("proposed");
    const off = only(
      run(
        [statement(1, 3000)],
        [debit(1, yen("1000.5")), debit(2, yen("1999.4999999999999999999"))],
      ),
    );
    expect(off.outcome.status).toBe("unsupported");
  });
  test("the size bound is the policy's: three debits need a policy that allows three", () => {
    const debits = [debit(1, 1000), debit(2, 1000), debit(3, 1000)];
    expect(only(run([statement(1, 3000)], debits)).outcome).toEqual({
      status: "unsupported",
      allocations: [],
      codes: ["no_exact_allocation"],
    });
    const three = only(
      run([statement(1, 3000)], debits, { policy: { ...POLICY, maxDebitsPerAllocation: 3 } }),
    );
    expect(memberIds(three)).toEqual([["transaction:1", "transaction:2", "transaction:3"]]);
    const single = only(
      run([statement(1, 3000)], [debit(1, 1000), debit(2, 2000)], {
        policy: { ...POLICY, maxDebitsPerAllocation: 1 },
      }),
    );
    expect(single.outcome.status).toBe("unsupported");
  });
  test("ownership is a rejection condition, never a refusal", () => {
    const unknown = only(
      run([statement(1, 3000)], [debit(1, 1000, { ownerRef: null }), debit(2, 2000)]),
    );
    expect(unknown.outcome).toMatchObject({
      status: "proposed",
      allocations: [
        {
          ownership: "unknown",
          rejectionConditions: expect.arrayContaining(["owner_not_established"]),
        },
      ],
    });
    const different = only(
      run(
        [statement(1, 3000)],
        [debit(1, 1000, { ownerRef: "party:synthetic-other" }), debit(2, 2000)],
      ),
    );
    expect(different.outcome).toMatchObject({
      status: "proposed",
      allocations: [
        { ownership: "different", rejectionConditions: expect.arrayContaining(["owner_differs"]) },
      ],
    });
  });
});

describe("no exact allocation is unsupported, with the direction of the difference", () => {
  test("a shortfall: the in-window debits together are below the total", () => {
    expect(codesOf(only(run([statement(1, 3000)], [debit(1, 1000), debit(2, 1500)])))).toEqual([
      "no_exact_allocation",
      "in_window_debits_below_total",
    ]);
  });
  test("an excess: one debit above the total", () => {
    expect(codesOf(only(run([statement(1, 3000)], [debit(1, 3500)])))).toEqual([
      "no_exact_allocation",
      "debit_above_total",
    ]);
  });
  test("both: a debit above the total and the rest below it is still one closed outcome", () => {
    // In-window sum 1000 + 4000 = 5000 is not below 3000; 4000 is above it.
    expect(codesOf(only(run([statement(1, 3000)], [debit(1, 1000), debit(2, 4000)])))).toEqual([
      "no_exact_allocation",
      "debit_above_total",
    ]);
  });
  test("debits that exceed the total together but match no combination name no direction", () => {
    expect(
      codesOf(only(run([statement(1, 3000)], [debit(1, 1200), debit(2, 1300), debit(3, 1400)]))),
    ).toEqual(["no_exact_allocation"]);
  });
  test("no debit in the window or the unit is its own code; no shortfall amount is invented", () => {
    const result = only(
      run(
        [statement(1, 3000)],
        [
          debit(1, 3000, { occurred: day("2026-09-14") }),
          debit(2, 3000, { occurred: day("2026-09-06") }),
          debit(3, exactQuantity("USD", integerDecimal(3000))),
        ],
      ),
    );
    expect(result.outcome).toEqual({
      status: "unsupported",
      allocations: [],
      codes: ["no_debit_in_window"],
    });
    expect(result.pairExclusions).toEqual([
      { debitRef: debit(1, 0).debit.ref, code: "date_outside_window" },
      { debitRef: debit(2, 0).debit.ref, code: "date_outside_window" },
      { debitRef: debit(3, 0).debit.ref, code: "currency_differs" },
    ]);
  });
  test("the window is the policy's and is signed: debit date minus due date", () => {
    const late = [debit(1, 1000, { occurred: day("2026-09-17") }), debit(2, 2000)];
    expect(only(run([statement(1, 3000)], late)).outcome.status).toBe("unsupported");
    const policy = { ...POLICY, window: { minDaysFromDue: 0, maxDaysFromDue: 7 } };
    expect(only(run([statement(1, 3000)], late, { policy })).outcome.status).toBe("proposed");
    const early = [debit(1, 1000, { occurred: day("2026-09-09") }), debit(2, 2000)];
    expect(only(run([statement(1, 3000)], early, { policy })).outcome.status).toBe("unsupported");
  });
  test("a mixed-currency combination is never formed", () => {
    const result = only(
      run(
        [statement(1, 3000)],
        [debit(1, 1000), debit(2, exactQuantity("USD", integerDecimal(2000)))],
      ),
    );
    expect(codesOf(result)).toEqual(["no_exact_allocation", "in_window_debits_below_total"]);
    expect(result.pairExclusions).toEqual([
      { debitRef: debit(2, 0).debit.ref, code: "currency_differs" },
    ]);
  });
});

describe("ambiguity is needs_review, never a choice", () => {
  test("two equal single debits", () => {
    const result = only(run([statement(1, 3000)], [debit(1, 3000), debit(2, 3000)]));
    expect(result.outcome).toMatchObject({
      status: "needs_review",
      codes: ["candidate_not_unique"],
    });
    expect(memberIds(result)).toEqual([["transaction:1"], ["transaction:2"]]);
  });
  test("a single debit and a disjoint two-debit combination", () => {
    const result = only(
      run([statement(1, 3000)], [debit(1, 3000), debit(2, 1000), debit(3, 2000)]),
    );
    expect(result.outcome.status).toBe("needs_review");
    expect(memberIds(result)).toEqual([["transaction:1"], ["transaction:2", "transaction:3"]]);
  });
  test("a debit two statements could use contests both", () => {
    const result = run([statement(1, 3000), statement(2, 1000)], [debit(1, 1000), debit(2, 2000)]);
    expect(result.statements.map((s) => s.outcome)).toMatchObject([
      {
        status: "needs_review",
        codes: ["candidate_not_unique", "debit_in_other_statement_allocation"],
      },
      {
        status: "needs_review",
        codes: ["candidate_not_unique", "debit_in_other_statement_allocation"],
      },
    ]);
  });
  test("disjoint statements are each proposed", () => {
    const result = run(
      [statement(1, 3000), statement(2, 500)],
      [debit(1, 1000), debit(2, 2000), debit(3, 500)],
    );
    expect(result.statements.map((s) => s.outcome.status)).toEqual(["proposed", "proposed"]);
  });
});

describe("every debit is one fact (INV06)", () => {
  test("held keys and alias classes, duplicates, repeats and unadmitted identities take no part", () => {
    const result = run(
      [statement(1, 3000)],
      [
        debit(1, 1000),
        debit(2, 2000, { key: "held-key" }),
        debit(3, 2000, { alias: "held-alias" }),
        debit(4, 2000, { key: "shared-key" }),
        debit(5, 2000, { key: "shared-key" }),
        debit(6, 2000, { alias: "shared-alias" }),
        debit(7, 2000, { alias: "shared-alias" }),
        debit(8, 2000),
        debit(8, 2000),
        debit(9, 2000, { alias: null }),
        debit(10, absentQuantity("JPY", "missing", "not_reported")),
        debit(11, 0),
        debit(12, -2000),
        debit(13, 2000, { occurred: { kind: "unknown", reasonCode: "not_reported" } }),
        { bankKey: "", aliasClass: null, debit: {} } as unknown as AllocationDebitInput,
      ],
      { held: { bankKeys: ["held-key"], aliasClasses: ["held-alias"], statementKeys: [] } },
    );
    expect(result.debitExclusions).toEqual([
      { debitRef: null, code: "debit_invalid" },
      ...[
        [10, "amount_not_exact"],
        [11, "amount_not_positive"],
        [12, "amount_not_positive"],
        [13, "debit_date_missing"],
        [2, "economic_claim_held"],
        [3, "alias_conflict"],
        [4, "duplicate_unresolved"],
        [5, "duplicate_unresolved"],
        [6, "duplicate_unresolved"],
        [7, "duplicate_unresolved"],
        [8, "debit_repeated"],
        [8, "debit_repeated"],
        [9, "identity_not_admitted"],
      ].map(([id, code]) => ({
        debitRef: debit(id as number, 0).debit.ref,
        code: code as AllocationDebitExclusion,
      })),
    ]);
    expect(codesOf(only(result))).toEqual(["no_exact_allocation", "in_window_debits_below_total"]);
  });
});

describe("statement refusals", () => {
  test("each refusal is closed and the statement plans nothing", () => {
    const result = run(
      [
        statement(1, absentQuantity("JPY", "missing", "not_reported")),
        statement(2, 0),
        statement(3, 3000, { paymentDate: { kind: "unknown", reasonCode: "not_reported" } }),
        statement(4, 3000, { key: "reserved" }),
        statement(5, 3000, { key: "twice" }),
        statement(6, 3000, { key: "twice" }),
        { statementKey: "", statement: {} } as unknown as AllocationStatementInput,
      ],
      [debit(1, 3000)],
      { held: { bankKeys: [], aliasClasses: [], statementKeys: ["reserved"] } },
    );
    expect(result.statements.map((s) => [s.statementRef?.id ?? null, s.outcome])).toEqual([
      [null, { status: "refused", code: "statement_invalid" }],
      ["balance:1", { status: "refused", code: "amount_not_exact" }],
      ["balance:2", { status: "refused", code: "amount_not_positive" }],
      ["balance:3", { status: "refused", code: "payment_date_missing" }],
      ["balance:4", { status: "refused", code: "statement_already_allocated" }],
      ["balance:5", { status: "refused", code: "statement_repeated" }],
      ["balance:6", { status: "refused", code: "statement_repeated" }],
    ]);
  });
});

describe("module surface", () => {
  test("exported from the package, closed code lists", () => {
    expect(domain.planCardStatementAllocations).toBe(planCardStatementAllocations);
    for (const list of [
      ALLOCATION_RUN_REFUSALS,
      ALLOCATION_STATEMENT_REFUSALS,
      ALLOCATION_DEBIT_EXCLUSIONS,
      ALLOCATION_PAIR_EXCLUSIONS,
      ALLOCATION_OUTCOME_CODES,
      ALLOCATION_RATIONALE_CODES,
    ])
      expect(new Set(list).size).toBe(list.length);
  });
  test("no code outside packages/domain calls the planner: it adopts nothing and writes nothing", async () => {
    const root = join(import.meta.dir, "..", "..", "..");
    const callers: string[] = [];
    for (const pattern of [
      "packages/*/src/**/*.ts",
      "services/*/src/**/*.ts",
      "apps/*/src/**/*.{ts,tsx}",
    ])
      for await (const path of new Glob(pattern).scan({ cwd: root })) {
        if (path.startsWith("packages/domain/")) continue;
        const text = await Bun.file(join(root, path)).text();
        if (
          text.includes("card-settlement-allocation.ts") ||
          text.includes("planCardStatementAllocations")
        )
          callers.push(path);
      }
    expect(callers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Property comparison with an independent oracle.

/** mulberry32, the same step as `seededRandom` in `scripts/load-fixture.ts`. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/** Brute force over every subset of the admitted debits, in integer yen-hundredths. */
function oracle(
  totals: readonly bigint[],
  debits: readonly { id: number; cents: bigint; unit: string; offset: number; usable: boolean }[],
  size: number,
  window: { min: number; max: number },
): string[][][] {
  return totals.map((total) => {
    const pool = debits.filter(
      (d) => d.usable && d.unit === "JPY" && d.offset >= window.min && d.offset <= window.max,
    );
    const found: string[][] = [];
    for (let mask = 1; mask < 1 << pool.length; mask++) {
      const chosen = pool.filter((_, i) => mask & (1 << i));
      if (chosen.length > size) continue;
      if (chosen.reduce((sum, d) => sum + d.cents, 0n) === total)
        found.push(chosen.map((d) => `transaction:${d.id}`).sort());
    }
    return found.sort((a, b) => a.length - b.length || (a.join("\n") < b.join("\n") ? -1 : 1));
  });
}

describe("property: the planner agrees with a brute-force oracle", () => {
  test("seeded random runs: exact sums, whole debits, no debit twice, held never used, order-free", () => {
    const seen = new Map<string, number>();
    for (let seed = 1; seed <= 300; seed++) {
      const random = mulberry32(seed);
      const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
      const size = 1 + Math.floor(random() * 3);
      const window = { min: -Math.floor(random() * 4), max: Math.floor(random() * 4) };
      const policy = {
        ...POLICY,
        window: { minDaysFromDue: window.min, maxDaysFromDue: window.max },
        maxDebitsPerAllocation: size,
      };
      const debitCount = Math.floor(random() * 12);
      const specs = Array.from({ length: debitCount }, (_, i) => {
        const cents =
          BigInt(pick([50, 100, 150, 200, 250, 300, 350, 500])) * 100n +
          BigInt(pick([0, 0, 0, 50]));
        const unit = random() < 0.1 ? "USD" : "JPY";
        const offset = Math.floor(random() * 11) - 5;
        const held = random() < 0.1;
        return { id: i + 1, cents, unit, offset, usable: !held, held };
      });
      const totals = Array.from(
        { length: 1 + Math.floor(random() * 3) },
        () => BigInt(pick([300, 450, 500, 600, 750, 1000])) * 100n + BigInt(pick([0, 50])),
      );
      const statements = totals.map((cents, i) =>
        statement(i + 1, exactQuantity("JPY", normalizeDecimal(cents, 2))),
      );
      const debits = specs.map((spec) =>
        debit(spec.id, exactQuantity(spec.unit, normalizeDecimal(spec.cents, 2)), {
          occurred: day(`2026-09-${String(10 + spec.offset).padStart(2, "0")}`),
        }),
      );
      const held = {
        bankKeys: specs.filter((s) => s.held).map((s) => debits[s.id - 1]!.bankKey),
        aliasClasses: [],
        statementKeys: [],
      };
      const result = run(statements, debits, { policy, held });
      expect(run(shuffle(statements, random), shuffle(debits, random), { policy, held })).toEqual(
        result,
      );

      const expected = oracle(totals, specs, size, window);
      const usage = new Map<string, number>();
      for (const [index, item] of result.statements.entries()) {
        const outcome = item.outcome;
        if (outcome.status === "refused") throw new Error(`seed ${seed}: unexpected refusal`);
        expect(memberIds(item)).toEqual(expected[index]!);
        for (const allocation of outcome.allocations) {
          const ids = allocation.members.map((m) => m.ref.id);
          expect(new Set(ids).size).toBe(ids.length);
          const sum = sumQuantities(
            "JPY",
            allocation.members.map((m) => m.allocated),
          );
          expect(
            sum.ok && compareQuantities(sum.quantity, statements[index]!.statement.amount),
          ).toEqual({
            ok: true,
            order: 0,
          });
          for (const member of allocation.members) {
            const spec = specs.find((s) => `transaction:${s.id}` === member.ref.id)!;
            expect(spec.held).toBe(false);
            expect(spec.unit).toBe("JPY");
            expect(member.allocated).toEqual(debits[spec.id - 1]!.debit.amount);
          }
        }
        if (outcome.status === "proposed")
          for (const member of outcome.allocations[0].members)
            usage.set(member.ref.id, (usage.get(member.ref.id) ?? 0) + 1);
        if (outcome.status === "unsupported") expect(expected[index]).toEqual([]);
        if (outcome.status === "needs_review")
          expect(outcome.codes[0]).toBe("candidate_not_unique");
        if (outcome.status === "proposed") expect(expected[index]!.length).toBe(1);
      }
      // Across every proposed statement of a run, no debit is proposed twice.
      for (const count of usage.values()) expect(count).toBe(1);
      for (const item of result.statements) {
        const outcome = item.outcome;
        const labels: string[] = [
          outcome.status,
          ...(outcome.status === "refused" ? [] : outcome.codes),
        ];
        if (outcome.status === "proposed" || outcome.status === "needs_review")
          labels.push(...outcome.allocations.map((allocation) => allocation.kind));
        for (const label of labels) seen.set(label, (seen.get(label) ?? 0) + 1);
      }
    }
    // The seeds draw every outcome and both allocation kinds, not only the easy ones.
    const rare = [
      "proposed",
      "needs_review",
      "unsupported",
      "single-debit",
      "multiple-debits",
      "candidate_not_unique",
      "debit_in_other_statement_allocation",
      "no_debit_in_window",
      "no_exact_allocation",
      "in_window_debits_below_total",
      "debit_above_total",
    ].filter((label) => (seen.get(label) ?? 0) < 5);
    expect(rare).toEqual([]);
  });
});

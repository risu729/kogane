// Statement allocation planner (ADR 0074, issue #548). A pure planner that,
// given card statement payment totals and bank debits an adapter already
// admits, proposes which debits together pay each statement exactly: one
// debit (the shape the `card_settlement_sweep` matcher already proposes) or
// two or three debits whose exact sum is the statement total.
//
// Nothing here adopts (INV07): no lane, command or writer calls this module.
// A statement whose admitted debits do not sum exactly to its total is
// `unsupported` with closed codes that say which way the amounts differ;
// a partial payment, an overpayment, a debit that pays more than one
// statement and a refund are not modelled, because no provider evidence of
// their shape has been observed (ADR 0004). No shortfall or remainder amount
// is computed for them: which debits are "the" partial payment would be a
// guess.
//
// Every debit is one fact (INV06): a debit given twice, two debits sharing a
// key or an alias class, and a debit whose key or alias class a live holder
// already holds take no part; a debit in more than one candidate allocation,
// of one statement or of two, makes every allocation it is in `needs_review`
// and none is chosen. A debit refused as an unresolved duplicate or for a
// missing date still competes (as in ADR 0057): if it could complete an exact
// allocation, the statement is `needs_review`, so the refusal never picks. Amounts are compared and added with the exact decimal
// helpers of `values.ts` (INV03); a value that is not exact is a reason,
// never zero (INV05). The date window and the most debits one allocation may
// combine come from an explicit, versioned policy without defaults; nothing
// in the repository supplies one. Nothing here reads storage or a clock.
//
// Every exact combination is counted, and the first
// `CARD_STATEMENT_ALLOCATION_LISTED_MAX` in the outcome's order are listed with
// that count and a closed truncation marker (ADR 0074, amendment 2026-11-07,
// "a bounded list of allocations"): the search visits each combination once
// and keeps at most twice that many, so a window of 32 equal debits (4,960
// three-debit sums) no longer builds thousands of allocations per statement.
import { type CardBankDebitFact, type CardStatementFact } from "./card-settlement.ts";
import { validSourceFactRef, type SourceFactRef } from "./events.ts";
import { hasExactKeys, isRecord, isSafeInt, isText } from "./guards.ts";
import { daysBetween, parseLocalDate, validTemporalValue, type TemporalValue } from "./time.ts";
import {
  ARITHMETIC_POLICY_VERSION,
  addQuantities,
  compareQuantities,
  sumQuantities,
  validQuantity,
  type Quantity,
} from "./values.ts";

/** The planner release, pinned in every manifest. A changed rule is a new release. */
export const CARD_STATEMENT_ALLOCATION_RELEASE = "card-statement-allocation-v2";
/** Statements one run reads at most; past it the run is refused, never cut. */
export const CARD_STATEMENT_ALLOCATION_STATEMENTS_MAX = 16;
/** Debits one run reads at most; past it the run is refused, never cut. */
export const CARD_STATEMENT_ALLOCATION_DEBITS_MAX = 32;
/** The most debits a policy may let one allocation combine. */
export const CARD_STATEMENT_ALLOCATION_SIZE_MAX = 3;
/** The furthest a policy's window may reach, in civil days either side of the due date. */
export const CARD_STATEMENT_ALLOCATION_WINDOW_DAYS_MAX = 31;
/**
 * Allocations one statement's outcome lists at most: the first in its order
 * (fewest debits first, then by member ref ids). Every exact combination is
 * still counted and decides the status and codes; past this many the outcome
 * says `allocationsTruncated: true` beside `allocationCount`, so nothing is
 * hidden silently (INV05). Without it one statement of 32 debits could list
 * 4,960 allocations (ADR 0074, amendment 2026-11-07).
 */
export const CARD_STATEMENT_ALLOCATION_LISTED_MAX = 50;

// ---------------------------------------------------------------------------
// The policy. Explicit and versioned; no field has a default.

export interface CardStatementAllocationPolicy {
  /** `[a-z0-9][a-z0-9.-]*`, at most 64 characters; pinned in the manifest. */
  policyVersion: string;
  /** The debit's civil date minus the statement's due date, inclusive bounds. */
  window: { minDaysFromDue: number; maxDaysFromDue: number };
  /** 1 to `CARD_STATEMENT_ALLOCATION_SIZE_MAX`. */
  maxDebitsPerAllocation: number;
}

const POLICY_VERSION = /^[a-z0-9][a-z0-9.-]{0,63}$/u;

/** Exact keys and closed values; anything else (an unversioned policy included) is unsupported. */
export function validCardStatementAllocationPolicy(
  value: unknown,
): value is CardStatementAllocationPolicy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["policyVersion", "window", "maxDebitsPerAllocation"]) ||
    typeof value.policyVersion !== "string" ||
    !POLICY_VERSION.test(value.policyVersion) ||
    !isRecord(value.window) ||
    !hasExactKeys(value.window, ["minDaysFromDue", "maxDaysFromDue"]) ||
    !isSafeInt(value.maxDebitsPerAllocation, 1, CARD_STATEMENT_ALLOCATION_SIZE_MAX)
  )
    return false;
  const { minDaysFromDue: min, maxDaysFromDue: max } = value.window;
  return (
    isSafeInt(
      min,
      -CARD_STATEMENT_ALLOCATION_WINDOW_DAYS_MAX,
      CARD_STATEMENT_ALLOCATION_WINDOW_DAYS_MAX,
    ) &&
    isSafeInt(
      max,
      -CARD_STATEMENT_ALLOCATION_WINDOW_DAYS_MAX,
      CARD_STATEMENT_ALLOCATION_WINDOW_DAYS_MAX,
    ) &&
    min <= max
  );
}

// ---------------------------------------------------------------------------
// Inputs.

export interface AllocationStatementInput {
  statement: CardStatementFact;
  /** `card_statement_facts.statement_key`. */
  statementKey: string;
}

export interface AllocationDebitInput {
  debit: CardBankDebitFact;
  /** `card_bank_debit_facts.bank_key` (the row's 5-tuple text). */
  bankKey: string;
  /**
   * The alias class text the registry's provider identity function computes
   * for the debit (`humanAdoptedRowIdentity`), or null when its identity is
   * not admitted (a fingerprint, or an SBI Shinsei row of a 0.1.2 run).
   */
  aliasClass: string | null;
}

/** What live holders already hold, as stored texts. */
export interface AllocationHeld {
  /** Keys held in book `cash-movement` (claims and accepted settlements). */
  bankKeys: readonly string[];
  /** Alias classes held in book `cash-movement`. */
  aliasClasses: readonly string[];
  /** Statement keys an accepted settlement reserves. */
  statementKeys: readonly string[];
}

export interface CardStatementAllocationInput {
  statements: readonly AllocationStatementInput[];
  debits: readonly AllocationDebitInput[];
  /** Required; there is no default policy. */
  policy: CardStatementAllocationPolicy | null | undefined;
  held: AllocationHeld;
}

// ---------------------------------------------------------------------------
// Closed codes.

/** Why a whole run is refused: nothing is planned. */
export const ALLOCATION_RUN_REFUSALS = [
  "policy_missing",
  "policy_unsupported",
  "input_bound_exceeded",
] as const;
export type AllocationRunRefusal = (typeof ALLOCATION_RUN_REFUSALS)[number];

/** Why one statement is not planned, in the order they are checked. */
export const ALLOCATION_STATEMENT_REFUSALS = [
  "statement_invalid",
  /** The same statement ref or key given twice: every copy is refused. */
  "statement_repeated",
  "amount_not_exact",
  "amount_not_positive",
  "payment_date_missing",
  /** An accepted settlement already reserves the statement key. */
  "statement_already_allocated",
] as const;
export type AllocationStatementRefusal = (typeof ALLOCATION_STATEMENT_REFUSALS)[number];

/** Why one debit takes no part in any allocation, in the order they are checked. */
export const ALLOCATION_DEBIT_EXCLUSIONS = [
  "debit_invalid",
  /** The same debit ref given twice: every copy is excluded. */
  "debit_repeated",
  "identity_not_admitted",
  "amount_not_exact",
  "amount_not_positive",
  "debit_date_missing",
  /** Two debits share a key or an alias class: never asserted separate or the same. */
  "duplicate_unresolved",
  "economic_claim_held",
  "alias_conflict",
] as const;
export type AllocationDebitExclusion = (typeof ALLOCATION_DEBIT_EXCLUSIONS)[number];

/** Why an admitted debit is not considered for one statement, in the order they are checked. */
export const ALLOCATION_PAIR_EXCLUSIONS = ["currency_differs", "date_outside_window"] as const;
export type AllocationPairExclusion = (typeof ALLOCATION_PAIR_EXCLUSIONS)[number];

/** What a statement's outcome states. */
export const ALLOCATION_OUTCOME_CODES = [
  /** More than one allocation, a member debit in another statement's allocation, or a competing refused debit. */
  "candidate_not_unique",
  /** A member debit is also in an allocation of another statement of this run. */
  "debit_in_other_statement_allocation",
  /**
   * A debit refused `duplicate_unresolved` (inside the window) or
   * `debit_date_missing` (the window cannot exclude it) could complete an
   * exact allocation: the refusal does not pick the statement's payer.
   */
  "excluded_debit_competes",
  /** No admitted debit of the statement's unit is inside the window. */
  "no_debit_in_window",
  /** In-window debits exist but no combination within the size bound sums to the total. */
  "no_exact_allocation",
  /** The in-window debits together are below the total (a shortfall: partial payments are not modelled). */
  "in_window_debits_below_total",
  /** An in-window debit is above the total (an excess: overpayment and multi-statement debits are not modelled). */
  "debit_above_total",
] as const;
export type AllocationOutcomeCode = (typeof ALLOCATION_OUTCOME_CODES)[number];

export const ALLOCATION_RATIONALE_CODES = [
  "authoritative_statement_total",
  "observed_bank_debit",
  "identity_admitted",
  "same_unit",
  "dates_within_policy_window",
  "amount_equal",
  "amounts_sum_to_total",
] as const;
export type AllocationRationaleCode = (typeof ALLOCATION_RATIONALE_CODES)[number];

// ---------------------------------------------------------------------------
// Outputs.

/** One debit of an allocation: its whole amount pays the statement. */
export interface AllocationMember {
  ref: SourceFactRef;
  bankKey: string;
  aliasClass: string;
  sourceId: string;
  sourceAccount: string;
  accountId: string | null;
  allocated: Quantity;
}

export interface CardStatementAllocation {
  kind: "single-debit" | "multiple-debits";
  /** Ordered by ref id. */
  members: AllocationMember[];
  /** The exact sum of the members' amounts; always equal to the statement total. */
  allocatedTotal: Quantity;
  rationaleCodes: AllocationRationaleCode[];
  rejectionConditions: string[];
  ownership: "established-same" | "unknown" | "different";
}

export type StatementAllocationOutcome =
  | { status: "refused"; code: AllocationStatementRefusal }
  /** Exactly one allocation, none of whose debits is in another candidate. A proposal, never a decision. */
  | {
      status: "proposed";
      allocations: [CardStatementAllocation];
      codes: [];
      allocationCount: 1;
      allocationsTruncated: false;
    }
  /**
   * Two or more candidates, a debit two statements could use, or a competing
   * refused debit: none is chosen. `allocationCount` is every exact
   * allocation; the first `CARD_STATEMENT_ALLOCATION_LISTED_MAX` are listed,
   * and `allocationsTruncated` is true exactly when the count is above that.
   */
  | {
      status: "needs_review";
      allocations: CardStatementAllocation[];
      codes: AllocationOutcomeCode[];
      allocationCount: number;
      allocationsTruncated: boolean;
    }
  /** No exact allocation: the codes say why; no amount is invented for the difference. */
  | {
      status: "unsupported";
      allocations: [];
      codes: AllocationOutcomeCode[];
      allocationCount: 0;
      allocationsTruncated: false;
    };

export interface StatementAllocationResult {
  statementRef: SourceFactRef | null;
  statementKey: string | null;
  outcome: StatementAllocationOutcome;
  /** Admitted debits this statement did not consider, with the first reason. */
  pairExclusions: { debitRef: SourceFactRef; code: AllocationPairExclusion }[];
}

export interface CardStatementAllocationManifest {
  release: typeof CARD_STATEMENT_ALLOCATION_RELEASE;
  policyVersion: string;
  arithmeticVersion: string;
}

export type CardStatementAllocationRun =
  | { ok: false; refusal: AllocationRunRefusal }
  | {
      ok: true;
      manifest: CardStatementAllocationManifest;
      /** One per input statement, ordered by statement ref id, key, refusal code, then ref revision. */
      statements: StatementAllocationResult[];
      /** Debits that take no part in any allocation, ordered by ref id, code, then ref revision. */
      debitExclusions: { debitRef: SourceFactRef | null; code: AllocationDebitExclusion }[];
    };

// ---------------------------------------------------------------------------
// The planner.

function exactPositive(quantity: Quantity): "exact" | "not_exact" | "not_positive" {
  if (quantity.value.status !== "exact") return "not_exact";
  return BigInt(quantity.value.value.coefficient) > 0n ? "exact" : "not_positive";
}

function localDate(value: TemporalValue): string | null {
  if (!validTemporalValue(value) || value.kind !== "local-date") return null;
  return parseLocalDate(value.value) === null ? null : value.value;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validStatementShape(input: unknown): input is AllocationStatementInput {
  if (!isRecord(input) || !isText(input.statementKey, 4096) || !isRecord(input.statement))
    return false;
  const statement = input.statement as unknown as CardStatementFact;
  return (
    validSourceFactRef(statement.ref) &&
    statement.ref.kind === "balance" &&
    (statement.sourceId === "vpass" || statement.sourceId === "myjcb") &&
    typeof statement.sourceAccount === "string" &&
    (statement.ownerRef === null || typeof statement.ownerRef === "string") &&
    (statement.accountId === null || typeof statement.accountId === "string") &&
    validQuantity(statement.amount)
  );
}

function validDebitShape(input: unknown): input is AllocationDebitInput {
  if (
    !isRecord(input) ||
    !isText(input.bankKey, 4096) ||
    !(input.aliasClass === null || isText(input.aliasClass, 4096)) ||
    !isRecord(input.debit)
  )
    return false;
  const debit = input.debit as unknown as CardBankDebitFact;
  return (
    validSourceFactRef(debit.ref) &&
    debit.ref.kind === "transaction" &&
    isText(debit.sourceId, 256) &&
    typeof debit.sourceAccount === "string" &&
    (debit.ownerRef === null || typeof debit.ownerRef === "string") &&
    (debit.accountId === null || typeof debit.accountId === "string") &&
    validQuantity(debit.amount)
  );
}

interface AdmittedDebit {
  input: AllocationDebitInput;
  aliasClass: string;
  date: string;
}

/** A debit refused before the search that still competes: its date, or null when it has none. */
interface CompetingDebit {
  input: AllocationDebitInput;
  date: string | null;
}

function ownershipOf(
  statement: CardStatementFact,
  members: readonly AdmittedDebit[],
): CardStatementAllocation["ownership"] {
  const owners = [statement.ownerRef, ...members.map((member) => member.input.debit.ownerRef)];
  const known = owners.filter((owner): owner is string => owner !== null);
  if (new Set(known).size > 1) return "different";
  return known.length === owners.length ? "established-same" : "unknown";
}

function allocationOf(
  statement: CardStatementFact,
  members: readonly AdmittedDebit[],
): CardStatementAllocation {
  const ownership = ownershipOf(statement, members);
  return {
    kind: members.length === 1 ? "single-debit" : "multiple-debits",
    members: members.map(({ input, aliasClass }) => ({
      ref: input.debit.ref,
      bankKey: input.bankKey,
      aliasClass,
      sourceId: input.debit.sourceId,
      sourceAccount: input.debit.sourceAccount,
      accountId: input.debit.accountId,
      allocated: input.debit.amount,
    })),
    allocatedTotal: statement.amount,
    rationaleCodes: [
      "authoritative_statement_total",
      "observed_bank_debit",
      "identity_admitted",
      "same_unit",
      "dates_within_policy_window",
      members.length === 1 ? "amount_equal" : "amounts_sum_to_total",
    ],
    rejectionConditions: [
      "statement_changed",
      "bank_debit_changed",
      "allocation_already_used",
      ...(ownership === "established-same"
        ? []
        : [ownership === "different" ? "owner_differs" : "owner_not_established"]),
    ],
    ownership,
  };
}

/**
 * Visits each combination of at most `size` debits (ordered by amount, then
 * ref id) whose exact sum equals `total`, in search order, until `visit`
 * returns true. Amounts are positive, so a branch whose running sum already
 * exceeds the total is not extended. Nothing is collected here: what the
 * caller keeps is the caller's bound.
 */
function visitExactCombinations<T extends { input: AllocationDebitInput }>(
  total: Quantity,
  debits: readonly T[],
  size: number,
  visit: (members: readonly T[]) => boolean,
): void {
  let stopped = false;
  const walk = (start: number, chosen: T[], sum: Quantity | null) => {
    for (let index = start; index < debits.length && !stopped; index++) {
      const debit = debits[index]!;
      const next =
        sum === null
          ? { ok: true as const, quantity: debit.input.debit.amount }
          : addQuantities(sum, debit.input.debit.amount);
      if (!next.ok) continue;
      const order = compareQuantities(next.quantity, total);
      if (!order.ok) continue;
      // Sorted ascending: every later debit is at least this one, so stop.
      if (order.order > 0) break;
      const members = [...chosen, debit];
      if (order.order === 0) stopped = visit(members);
      else if (members.length < size) walk(index + 1, members, next.quantity);
    }
  };
  walk(0, [], null);
}

/** The listing order: fewest members first, then by the members' ref ids (each list ordered by ref id). */
function listedOrder(a: readonly string[], b: readonly string[]): number {
  if (a.length !== b.length) return a.length - b.length;
  return compareText(a.join("\n"), b.join("\n"));
}

/** A statement's exact combinations: how many, which debits any of them uses, and the first ones. */
interface CandidateSummary {
  count: number;
  debitIds: ReadonlySet<string>;
  /** At most `CARD_STATEMENT_ALLOCATION_LISTED_MAX`, in `listedOrder`, members by ref id. */
  listed: AdmittedDebit[][];
}

const NO_CANDIDATES: CandidateSummary = { count: 0, debitIds: new Set(), listed: [] };

/**
 * Counts every exact combination and keeps the first
 * `CARD_STATEMENT_ALLOCATION_LISTED_MAX` in listing order. What is kept never
 * exceeds twice the bound: on reaching it, it is sorted and cut back, which
 * keeps exactly the first ones because the order is total (members are
 * distinct admitted debits, whose ref ids are unique).
 */
function summarizeCandidates(
  total: Quantity,
  debits: readonly AdmittedDebit[],
  size: number,
): CandidateSummary {
  let count = 0;
  const debitIds = new Set<string>();
  let kept: { ids: string[]; members: AdmittedDebit[] }[] = [];
  const cut = () => {
    kept.sort((a, b) => listedOrder(a.ids, b.ids));
    if (kept.length > CARD_STATEMENT_ALLOCATION_LISTED_MAX)
      kept = kept.slice(0, CARD_STATEMENT_ALLOCATION_LISTED_MAX);
  };
  visitExactCombinations(total, debits, size, (found) => {
    count++;
    const members = [...found].sort((a, b) =>
      compareText(a.input.debit.ref.id, b.input.debit.ref.id),
    );
    const ids = members.map((member) => member.input.debit.ref.id);
    for (const id of ids) debitIds.add(id);
    kept.push({ ids, members });
    if (kept.length >= 2 * CARD_STATEMENT_ALLOCATION_LISTED_MAX) cut();
    return false;
  });
  cut();
  return { count, debitIds, listed: kept.map((entry) => entry.members) };
}

/** Within one unit only: a comparison across units is not an order. */
function byAmountThenRef(
  a: { input: AllocationDebitInput },
  b: { input: AllocationDebitInput },
): number {
  const order = compareQuantities(a.input.debit.amount, b.input.debit.amount);
  if (order.ok && order.order !== 0) return order.order;
  return compareText(a.input.debit.ref.id, b.input.debit.ref.id);
}

/**
 * Plans each statement's allocation from the debits given. Deterministic:
 * the same input in any order gives the same output. Never adopts.
 */
export function planCardStatementAllocations(
  input: CardStatementAllocationInput,
): CardStatementAllocationRun {
  if (input.policy === null || input.policy === undefined)
    return { ok: false, refusal: "policy_missing" };
  if (!validCardStatementAllocationPolicy(input.policy))
    return { ok: false, refusal: "policy_unsupported" };
  const policy = input.policy;
  if (
    !Array.isArray(input.statements) ||
    !Array.isArray(input.debits) ||
    input.statements.length > CARD_STATEMENT_ALLOCATION_STATEMENTS_MAX ||
    input.debits.length > CARD_STATEMENT_ALLOCATION_DEBITS_MAX
  )
    return { ok: false, refusal: "input_bound_exceeded" };
  const heldKeys = new Set(input.held.bankKeys);
  const heldAliases = new Set(input.held.aliasClasses);
  const heldStatements = new Set(input.held.statementKeys);

  // Debits: shape, repetition, identity, value, date, then INV06.
  const debitExclusions: { debitRef: SourceFactRef | null; code: AllocationDebitExclusion }[] = [];
  const refCounts = new Map<string, number>();
  for (const item of input.debits)
    if (validDebitShape(item))
      refCounts.set(item.debit.ref.id, (refCounts.get(item.debit.ref.id) ?? 0) + 1);
  const valued: AdmittedDebit[] = [];
  const competing: CompetingDebit[] = [];
  for (const item of input.debits) {
    if (!validDebitShape(item)) {
      debitExclusions.push({ debitRef: null, code: "debit_invalid" });
      continue;
    }
    const ref = item.debit.ref;
    const exclude = (code: AllocationDebitExclusion) =>
      debitExclusions.push({ debitRef: ref, code });
    if ((refCounts.get(ref.id) ?? 0) > 1) exclude("debit_repeated");
    else if (item.aliasClass === null) exclude("identity_not_admitted");
    else {
      const value = exactPositive(item.debit.amount);
      const date = localDate(item.debit.occurred);
      if (value === "not_exact") exclude("amount_not_exact");
      else if (value === "not_positive") exclude("amount_not_positive");
      else if (date === null) {
        exclude("debit_date_missing");
        competing.push({ input: item, date: null });
      } else valued.push({ input: item, aliasClass: item.aliasClass, date });
    }
  }
  const keyCounts = new Map<string, number>();
  const aliasCounts = new Map<string, number>();
  for (const debit of valued) {
    keyCounts.set(debit.input.bankKey, (keyCounts.get(debit.input.bankKey) ?? 0) + 1);
    aliasCounts.set(debit.aliasClass, (aliasCounts.get(debit.aliasClass) ?? 0) + 1);
  }
  const admitted: AdmittedDebit[] = [];
  for (const debit of valued) {
    const ref = debit.input.debit.ref;
    if (
      (keyCounts.get(debit.input.bankKey) ?? 0) > 1 ||
      (aliasCounts.get(debit.aliasClass) ?? 0) > 1
    ) {
      debitExclusions.push({ debitRef: ref, code: "duplicate_unresolved" });
      competing.push({ input: debit.input, date: debit.date });
    } else if (heldKeys.has(debit.input.bankKey))
      debitExclusions.push({ debitRef: ref, code: "economic_claim_held" });
    else if (heldAliases.has(debit.aliasClass))
      debitExclusions.push({ debitRef: ref, code: "alias_conflict" });
    else admitted.push(debit);
  }
  // By ref id: the debits of several units are not ordered by amount here.
  admitted.sort((a, b) => compareText(a.input.debit.ref.id, b.input.debit.ref.id));
  // A ref id given at two revisions is two entries: the revision orders them,
  // so the output does not follow the input order.
  debitExclusions.sort(
    (a, b) =>
      compareText(a.debitRef?.id ?? "", b.debitRef?.id ?? "") ||
      compareText(a.code, b.code) ||
      compareText(a.debitRef?.revision ?? "", b.debitRef?.revision ?? ""),
  );

  // Statements: shape, repetition, value, date, reservation.
  const statementRefCounts = new Map<string, number>();
  const statementKeyCounts = new Map<string, number>();
  for (const item of input.statements)
    if (validStatementShape(item)) {
      statementRefCounts.set(
        item.statement.ref.id,
        (statementRefCounts.get(item.statement.ref.id) ?? 0) + 1,
      );
      statementKeyCounts.set(
        item.statementKey,
        (statementKeyCounts.get(item.statementKey) ?? 0) + 1,
      );
    }
  interface Planned {
    result: StatementAllocationResult;
    statement: CardStatementFact | null;
    candidates: CandidateSummary;
    inWindow: AdmittedDebit[];
    /** Whether a competing refused debit could complete an exact allocation. */
    competes: boolean;
  }
  const planned: Planned[] = [];
  for (const item of input.statements) {
    if (!validStatementShape(item)) {
      planned.push({
        result: {
          statementRef: null,
          statementKey: null,
          outcome: { status: "refused", code: "statement_invalid" },
          pairExclusions: [],
        },
        statement: null,
        candidates: NO_CANDIDATES,
        inWindow: [],
        competes: false,
      });
      continue;
    }
    const statement = item.statement;
    const refuse = (code: AllocationStatementRefusal): Planned => ({
      result: {
        statementRef: statement.ref,
        statementKey: item.statementKey,
        outcome: { status: "refused", code },
        pairExclusions: [],
      },
      statement: null,
      candidates: NO_CANDIDATES,
      inWindow: [],
      competes: false,
    });
    const value = exactPositive(statement.amount);
    const due = localDate(statement.paymentDate);
    if (
      (statementRefCounts.get(statement.ref.id) ?? 0) > 1 ||
      (statementKeyCounts.get(item.statementKey) ?? 0) > 1
    )
      planned.push(refuse("statement_repeated"));
    else if (value === "not_exact") planned.push(refuse("amount_not_exact"));
    else if (value === "not_positive") planned.push(refuse("amount_not_positive"));
    else if (due === null) planned.push(refuse("payment_date_missing"));
    else if (heldStatements.has(item.statementKey))
      planned.push(refuse("statement_already_allocated"));
    else {
      const dueDate = parseLocalDate(due)!;
      const pairExclusions: StatementAllocationResult["pairExclusions"] = [];
      const inWindow: AdmittedDebit[] = [];
      const withinWindow = (date: string): boolean => {
        const gap = daysBetween(dueDate, parseLocalDate(date)!);
        return gap >= policy.window.minDaysFromDue && gap <= policy.window.maxDaysFromDue;
      };
      for (const debit of admitted) {
        if (debit.input.debit.amount.unitRef !== statement.amount.unitRef)
          pairExclusions.push({ debitRef: debit.input.debit.ref, code: "currency_differs" });
        else if (!withinWindow(debit.date))
          pairExclusions.push({ debitRef: debit.input.debit.ref, code: "date_outside_window" });
        else inWindow.push(debit);
      }
      pairExclusions.sort((a, b) => compareText(a.debitRef.id, b.debitRef.id));
      const candidates = summarizeCandidates(
        statement.amount,
        [...inWindow].sort(byAmountThenRef),
        policy.maxDebitsPerAllocation,
      );
      // Only a statement that has a candidate can be demoted; one with none is
      // unsupported whatever a refused debit could have done.
      const rivals = competing.filter(
        (debit) =>
          debit.input.debit.amount.unitRef === statement.amount.unitRef &&
          (debit.date === null || withinWindow(debit.date)),
      );
      const rivalIds = new Set(rivals.map((debit) => debit.input.debit.ref.id));
      // The search stops at the first exact combination a rival completes.
      let competes = false;
      if (candidates.count > 0 && rivals.length > 0)
        visitExactCombinations(
          statement.amount,
          [...inWindow, ...rivals].sort(byAmountThenRef),
          policy.maxDebitsPerAllocation,
          (members) =>
            (competes = members.some((member) => rivalIds.has(member.input.debit.ref.id))),
        );
      planned.push({
        result: {
          statementRef: statement.ref,
          statementKey: item.statementKey,
          // Replaced below once every statement's candidates are known.
          outcome: {
            status: "unsupported",
            allocations: [],
            codes: [],
            allocationCount: 0,
            allocationsTruncated: false,
          },
          pairExclusions,
        },
        statement,
        // One unit only, so the amount order is total and the search may prune.
        candidates,
        inWindow,
        competes,
      });
    }
  }

  // Uniqueness: a statement is paid once, so two candidates of one statement
  // are ambiguous; a debit in the candidates of two statements contests both.
  const statementsByDebit = new Map<string, Set<number>>();
  planned.forEach((plan, index) => {
    for (const id of plan.candidates.debitIds) {
      const set = statementsByDebit.get(id) ?? new Set<number>();
      set.add(index);
      statementsByDebit.set(id, set);
    }
  });
  for (const plan of planned) {
    const statement = plan.statement;
    if (statement === null) continue;
    if (plan.candidates.count === 0) {
      const codes: AllocationOutcomeCode[] = [];
      if (plan.inWindow.length === 0) codes.push("no_debit_in_window");
      else {
        codes.push("no_exact_allocation");
        const sum = sumQuantities(
          statement.amount.unitRef,
          plan.inWindow.map((debit) => debit.input.debit.amount),
        );
        const below = sum.ok ? compareQuantities(sum.quantity, statement.amount) : null;
        if (below?.ok && below.order < 0) codes.push("in_window_debits_below_total");
        if (
          plan.inWindow.some((debit) => {
            const order = compareQuantities(debit.input.debit.amount, statement.amount);
            return order.ok && order.order > 0;
          })
        )
          codes.push("debit_above_total");
      }
      plan.result.outcome = {
        status: "unsupported",
        allocations: [],
        codes,
        allocationCount: 0,
        allocationsTruncated: false,
      };
      continue;
    }
    // Already in listing order, members by ref id.
    const allocations = plan.candidates.listed.map((members) => allocationOf(statement, members));
    const count = plan.candidates.count;
    const elsewhere = [...plan.candidates.debitIds].some(
      (id) => (statementsByDebit.get(id)?.size ?? 0) > 1,
    );
    if (count === 1 && !elsewhere && !plan.competes) {
      plan.result.outcome = {
        status: "proposed",
        allocations: [allocations[0]!],
        codes: [],
        allocationCount: 1,
        allocationsTruncated: false,
      };
      continue;
    }
    const codes: AllocationOutcomeCode[] = ["candidate_not_unique"];
    if (elsewhere) codes.push("debit_in_other_statement_allocation");
    if (plan.competes) codes.push("excluded_debit_competes");
    plan.result.outcome = {
      status: "needs_review",
      allocations,
      codes,
      allocationCount: count,
      allocationsTruncated: count > allocations.length,
    };
  }

  const statements = planned
    .map((plan) => plan.result)
    .sort(
      (a, b) =>
        compareText(a.statementRef?.id ?? "", b.statementRef?.id ?? "") ||
        compareText(a.statementKey ?? "", b.statementKey ?? "") ||
        compareText(
          a.outcome.status === "refused" ? a.outcome.code : "",
          b.outcome.status === "refused" ? b.outcome.code : "",
        ) ||
        compareText(a.statementRef?.revision ?? "", b.statementRef?.revision ?? ""),
    );
  return {
    ok: true,
    manifest: {
      release: CARD_STATEMENT_ALLOCATION_RELEASE,
      policyVersion: policy.policyVersion,
      arithmeticVersion: ARITHMETIC_POLICY_VERSION,
    },
    statements,
    debitExclusions,
  };
}

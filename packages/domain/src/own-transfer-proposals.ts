// Own-transfer proposals (ADR 0057, issue #549, stage G3-a). A pure engine that
// pairs a debit row and a credit row of the person's own deposit accounts into
// a *proposal* that the two rows are one movement between own accounts.
//
// Nothing here adopts (INV07). A proposal is evidence-backed (the two rows it
// cites, by observation and parse run, never an amount) and refusable: it
// carries closed codes, and an ambiguous pairing is `needs_review`, never
// chosen. No policy value is built in: the date window, the currency rule and
// how a difference between the two legs is treated come from an explicit,
// versioned policy, and without one the engine refuses (`policy_missing`,
// `policy_unsupported`). The policy values are owner items (ADR 0057).
//
// Identity follows ADR 0054's eight fail-closed rules through
// `humanAdoptedRowIdentity`: a row whose id the parser did not record as
// provider-issued (an SBI Shinsei row today) is refused with the rule's code,
// and every admitted row carries the alias class the registry's provider
// identity function computes. Account ownership is an input (#545): an
// unresolved account is a refusal, never a guess.
//
// Amounts are compared with the exact decimal helpers of `values.ts` (INV03);
// the output names rows, never values, so a log of it carries ids and codes.
// Nothing here reads storage or a clock.
import { canonicalDigest } from "./context.ts";
import {
  ECONOMIC_CONTRACT_VERSION,
  aliasClassText,
  consumptionKeyText,
  validAliasClass,
  validConsumptionKey,
  type AliasClass,
  type ConsumptionKey,
  type IdentityRefusal,
} from "./economic-contract.ts";
import { TRANSACTION_FAMILY_REGISTRY_VERSION, transactionFamilyEntry } from "./event-families.ts";
import { validSourceFactRef, type SourceFactRef } from "./events.ts";
import { hasExactKeys, isArrayOf, isOneOf, isRecord, isSafeInt, isText } from "./guards.ts";
import { humanAdoptedRowIdentity } from "./row-identity.ts";
import { daysBetween, parseLocalDate } from "./time.ts";
import {
  ARITHMETIC_POLICY_VERSION,
  compareDecimals,
  decimalFromString,
  isZeroDecimal,
  negateDecimal,
  subtractDecimals,
  type ExactDecimal,
} from "./values.ts";

/** The engine release, pinned in every proposal and manifest. A changed rule is a new release. */
export const OWN_TRANSFER_ENGINE_RELEASE = "own-transfer-proposals-v1";

/**
 * The writer release a future own-transfer writer (G3-b, not built) seals its
 * revisions with. The planners recognise an own-transfer event by it; no code
 * writes it today.
 */
export const OWN_TRANSFER_WRITER_RELEASE = "own-transfer-v1:economic-guard-v1";

/** The one family own-transfer pairing reads (ADR 0053): deposit account movements. */
export const OWN_TRANSFER_FAMILY = "bank-movement";

/** Rows one run reads at most; past it the run is refused, never cut. */
export const OWN_TRANSFER_ROWS_MAX = 500;

/** The furthest a policy's window may reach, in civil days either side of the debit. */
export const OWN_TRANSFER_WINDOW_DAYS_MAX = 31;

// ---------------------------------------------------------------------------
// The policy. Explicit and versioned; no field has a default.

/** How a difference between the debit's magnitude and the credit is treated. */
export type OwnTransferDifferenceRule =
  /** The credit equals the debit's magnitude. */
  | { rule: "exact" }
  /**
   * The debit's magnitude may exceed the credit by at most the stated amount
   * of the pair's currency (a transfer fee taken on the debit side). A credit
   * larger than the debit is never within it. A currency the list does not
   * name allows no difference.
   */
  | { rule: "fee-within"; maxByCurrency: readonly { currency: string; amount: string }[] };

export interface OwnTransferPolicy {
  /** `[a-z0-9][a-z0-9.-]*`, at most 64 characters; pinned per proposal. */
  policyVersion: string;
  family: typeof OWN_TRANSFER_FAMILY;
  /** Only one rule exists: both rows in one currency. Cross-currency (FX) is not supported. */
  currencyRule: "same-currency";
  /** The credit's posting day minus the debit's, inclusive bounds. */
  window: { minDaysAfterDebit: number; maxDaysAfterDebit: number };
  difference: OwnTransferDifferenceRule;
}

const POLICY_VERSION = /^[a-z0-9][a-z0-9.-]{0,63}$/u;
const CURRENCY = /^[A-Z]{3}$/u;

function positiveDecimal(text: unknown): ExactDecimal | null {
  if (typeof text !== "string") return null;
  const parsed = decimalFromString(text);
  return parsed.ok && compareDecimals(parsed.value, { coefficient: "0", scale: 0 }) > 0
    ? parsed.value
    : null;
}

function validDifferenceRule(value: unknown): value is OwnTransferDifferenceRule {
  if (!isRecord(value)) return false;
  if (value.rule === "exact") return hasExactKeys(value, ["rule"]);
  if (value.rule !== "fee-within" || !hasExactKeys(value, ["rule", "maxByCurrency"])) return false;
  const list = value.maxByCurrency;
  return (
    isArrayOf(
      (item): item is { currency: string; amount: string } =>
        isRecord(item) &&
        hasExactKeys(item, ["currency", "amount"]) &&
        typeof item.currency === "string" &&
        CURRENCY.test(item.currency) &&
        positiveDecimal(item.amount) !== null,
      16,
    )(list) &&
    list.length > 0 &&
    new Set(list.map((item) => item.currency)).size === list.length
  );
}

/** Exact keys and closed values; anything else (an unversioned policy included) is unsupported. */
export function validOwnTransferPolicy(value: unknown): value is OwnTransferPolicy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["policyVersion", "family", "currencyRule", "window", "difference"]) ||
    typeof value.policyVersion !== "string" ||
    !POLICY_VERSION.test(value.policyVersion) ||
    value.family !== OWN_TRANSFER_FAMILY ||
    value.currencyRule !== "same-currency" ||
    !isRecord(value.window) ||
    !hasExactKeys(value.window, ["minDaysAfterDebit", "maxDaysAfterDebit"])
  )
    return false;
  const { minDaysAfterDebit: min, maxDaysAfterDebit: max } = value.window;
  return (
    isSafeInt(min, -OWN_TRANSFER_WINDOW_DAYS_MAX, OWN_TRANSFER_WINDOW_DAYS_MAX) &&
    isSafeInt(max, -OWN_TRANSFER_WINDOW_DAYS_MAX, OWN_TRANSFER_WINDOW_DAYS_MAX) &&
    min <= max &&
    validDifferenceRule(value.difference)
  );
}

// ---------------------------------------------------------------------------
// Inputs.

/** Who an account's source account belongs to, as identity has established it (#545). */
export type AccountOwnership =
  | { state: "self"; accountId: string }
  | { state: "other" }
  | { state: "unresolved" };

/** The ownership read the engine is given; its version is pinned in the manifest. */
export interface AccountOwnershipSource {
  version: string;
  ownershipOf(sourceId: string, sourceAccount: string): AccountOwnership;
}

/** One stored transaction row, as its observation and parse run state it. */
export interface OwnTransferRowInput {
  observationId: number;
  parseRunId: number;
  /** The row's 5-tuple (`json_array` of the stored columns). */
  key: ConsumptionKey;
  parserName: string;
  /** `transaction_observations.extra_json`, parsed. */
  extra: unknown;
  /** The stored signed exact decimal text: negative is a debit, positive a credit. */
  amount: string;
  currency: string;
  /** The provider's posting day, `YYYY-MM-DD`, or null when the row states none. */
  postingDate: string | null;
}

/** Live holders in book `cash-movement`, as stored texts (key and alias class). */
export interface HeldCashClaims {
  keys: readonly string[];
  aliasClasses: readonly string[];
}

export interface OwnTransferProposalInput {
  rows: readonly OwnTransferRowInput[];
  ownership: AccountOwnershipSource;
  /** Required; there is no default policy. */
  policy: OwnTransferPolicy | null | undefined;
  /** The identity epoch the rows were read under (CORE 0070), pinned per proposal. */
  identityEpoch: string;
  held: HeldCashClaims;
}

// ---------------------------------------------------------------------------
// Closed codes.

/** Why a whole run is refused: nothing is proposed. */
export const OWN_TRANSFER_RUN_REFUSALS = [
  "policy_missing",
  "policy_unsupported",
  "input_bound_exceeded",
  "identity_epoch_invalid",
  "ownership_version_invalid",
] as const;
export type OwnTransferRunRefusal = (typeof OWN_TRANSFER_RUN_REFUSALS)[number];

/** Why one row takes no part. The identity codes are ADR 0054's rules, unchanged. */
export const OWN_TRANSFER_ROW_REFUSALS = [
  "row_invalid",
  "family_unsupported",
  "ownership_unresolved",
  "owner_not_self",
  "identity_absent",
  "identity_fingerprint_only",
  "identity_digest_not_provider",
  "identity_origin_unrecorded",
  "identity_resolver_missing",
  "amount_not_exact",
  "amount_zero",
  "currency_invalid",
  "posting_date_missing",
  /** Rows that may be one fact (one alias class) disagree: never asserted separate or the same. */
  "duplicate_unresolved",
  /** The same row captured again (same key, alias class and values): one fact, the lowest observation kept. */
  "same_fact_recaptured",
  "alias_conflict",
  "economic_claim_held",
] as const satisfies readonly string[];
export type OwnTransferRowRefusal = (typeof OWN_TRANSFER_ROW_REFUSALS)[number];

/** Why a debit and a credit are not a candidate, in the order they are checked. */
export const OWN_TRANSFER_PAIR_REFUSALS = [
  "same_account",
  "currency_differs",
  "date_outside_window",
  "amount_outside_policy",
] as const;
export type OwnTransferPairRefusal = (typeof OWN_TRANSFER_PAIR_REFUSALS)[number];

/** What a proposal states. `candidate_not_unique` makes it `needs_review`. */
export const OWN_TRANSFER_PROPOSAL_CODES = [
  "both_accounts_self",
  "same_currency",
  "date_within_window",
  "amount_equal",
  "difference_within_policy",
  "candidate_not_unique",
] as const;
export type OwnTransferProposalCode = (typeof OWN_TRANSFER_PROPOSAL_CODES)[number];

export const OWN_TRANSFER_PROPOSAL_STATUSES = ["proposed", "needs_review"] as const;
export type OwnTransferProposalStatus = (typeof OWN_TRANSFER_PROPOSAL_STATUSES)[number];

// ---------------------------------------------------------------------------
// Outputs.

/** One side of a proposal: the row, its identity and its owner's account. No amount. */
export interface OwnTransferLeg {
  observationId: number;
  parseRunId: number;
  evidenceRef: SourceFactRef;
  key: ConsumptionKey;
  aliasClass: AliasClass;
  accountId: string;
}

/** What pins a run: every version its answer depends on. */
export interface OwnTransferManifest {
  engineRelease: string;
  policyVersion: string;
  policyDigest: string;
  identityEpoch: string;
  /** The provider identity functions' versions the admitted rows' alias classes carry. */
  aliasRuleVersions: string[];
  registryVersion: string;
  ownershipVersion: string;
  arithmeticVersion: string;
  contractVersion: string;
}

export interface OwnTransferProposal {
  /** `otp_` + SHA-256 of the engine release, policy version, identity epoch and both alias classes. */
  proposalId: string;
  /** SHA-256 of everything else the proposal states. */
  proposalDigest: string;
  status: OwnTransferProposalStatus;
  codes: OwnTransferProposalCode[];
  debit: OwnTransferLeg;
  credit: OwnTransferLeg;
  policyVersion: string;
  engineRelease: string;
  identityEpoch: string;
}

export type OwnTransferProposalRun =
  | { ok: false; refusal: OwnTransferRunRefusal }
  | {
      ok: true;
      manifest: OwnTransferManifest;
      proposals: OwnTransferProposal[];
      rowRefusals: { observationId: number; code: OwnTransferRowRefusal }[];
      pairRefusals: {
        debitObservationId: number;
        creditObservationId: number;
        code: OwnTransferPairRefusal;
      }[];
    };

const IDENTITY_EPOCH = /^[a-z0-9.-]{1,64}$/u;
export const OWN_TRANSFER_PROPOSAL_ID = /^otp_[0-9a-f]{64}$/u;

/** The event an adopted proposal would write (G3-b): one per proposal, so a re-adoption is visible. */
export function ownTransferEventId(proposalId: string): string {
  return `own-transfer-${proposalId}`;
}

/** The planners' subject for a proposal (`own-transfer-proposal:<id>`); not an expected-revision subject. */
export function ownTransferProposalRef(proposalId: string): string {
  return `own-transfer-proposal:${proposalId}`;
}

/** The `SourceFactRef` of a transaction row, as every writer cites one. */
export function transactionRowRef(observationId: number, parseRunId: number): SourceFactRef {
  return {
    kind: "transaction",
    id: `transaction:${observationId}`,
    revision: `parse_run:${parseRunId}`,
  };
}

interface AdmittedRow {
  row: OwnTransferRowInput;
  leg: OwnTransferLeg;
  amount: ExactDecimal;
  day: number;
}

type IdentityCode = Extract<
  IdentityRefusal,
  | "identity_absent"
  | "identity_fingerprint_only"
  | "identity_digest_not_provider"
  | "identity_origin_unrecorded"
  | "identity_resolver_missing"
>;

function admitRow(
  row: OwnTransferRowInput,
  ownership: AccountOwnershipSource,
): { admitted: AdmittedRow } | { refusal: OwnTransferRowRefusal } {
  if (
    !isRecord(row) ||
    !isSafeInt(row.observationId, 1) ||
    !isSafeInt(row.parseRunId, 1) ||
    !validConsumptionKey(row.key) ||
    !isText(row.parserName, 256)
  )
    return { refusal: "row_invalid" };
  const [sourceId, , , sourceAccount, externalId] = row.key;
  const entry = transactionFamilyEntry(sourceId, row.parserName);
  if (entry === null || !entry.families.some((member) => member.family === OWN_TRANSFER_FAMILY))
    return { refusal: "family_unsupported" };
  const owner = ownership.ownershipOf(sourceId, sourceAccount);
  if (owner.state === "unresolved") return { refusal: "ownership_unresolved" };
  if (owner.state === "other") return { refusal: "owner_not_self" };
  const identity = humanAdoptedRowIdentity({
    sourceId,
    parserName: row.parserName,
    sourceAccount,
    externalId,
    extra: row.extra,
    accountId: owner.accountId,
  });
  if (!identity.admitted) return { refusal: identity.refusal satisfies IdentityCode };
  const amount = typeof row.amount === "string" ? decimalFromString(row.amount) : null;
  if (amount === null || !amount.ok) return { refusal: "amount_not_exact" };
  if (isZeroDecimal(amount.value)) return { refusal: "amount_zero" };
  if (typeof row.currency !== "string" || !CURRENCY.test(row.currency))
    return { refusal: "currency_invalid" };
  const date = typeof row.postingDate === "string" ? parseLocalDate(row.postingDate) : null;
  if (date === null) return { refusal: "posting_date_missing" };
  return {
    admitted: {
      row,
      amount: amount.value,
      day: daysBetween({ year: 1970, month: 1, day: 1 }, date),
      leg: {
        observationId: row.observationId,
        parseRunId: row.parseRunId,
        evidenceRef: transactionRowRef(row.observationId, row.parseRunId),
        key: row.key,
        aliasClass: identity.aliasClass,
        accountId: owner.accountId,
      },
    },
  };
}

function maxDifference(policy: OwnTransferPolicy, currency: string): ExactDecimal | null {
  if (policy.difference.rule === "exact") return { coefficient: "0", scale: 0 };
  const entry = policy.difference.maxByCurrency.find((item) => item.currency === currency);
  return entry === undefined ? null : positiveDecimal(entry.amount);
}

/**
 * Pair one debit with one credit: the first failing check, or the codes a
 * candidate carries. Exact decimals only; the difference is the debit's
 * magnitude minus the credit.
 */
function pairCheck(
  debit: AdmittedRow,
  credit: AdmittedRow,
  policy: OwnTransferPolicy,
): { refusal: OwnTransferPairRefusal } | { codes: OwnTransferProposalCode[] } {
  if (debit.leg.accountId === credit.leg.accountId) return { refusal: "same_account" };
  if (debit.row.currency !== credit.row.currency) return { refusal: "currency_differs" };
  const days = credit.day - debit.day;
  if (days < policy.window.minDaysAfterDebit || days > policy.window.maxDaysAfterDebit)
    return { refusal: "date_outside_window" };
  const difference = subtractDecimals(negateDecimal(debit.amount), credit.amount);
  const zero = { coefficient: "0", scale: 0 };
  const allowed = maxDifference(policy, debit.row.currency);
  const order = compareDecimals(difference, zero);
  if (order < 0 || allowed === null || compareDecimals(difference, allowed) > 0)
    return { refusal: "amount_outside_policy" };
  return {
    codes: [
      "both_accounts_self",
      "same_currency",
      "date_within_window",
      order === 0 ? "amount_equal" : "difference_within_policy",
    ],
  };
}

function sameValues(a: AdmittedRow, b: AdmittedRow): boolean {
  return (
    consumptionKeyText(a.leg.key) === consumptionKeyText(b.leg.key) &&
    compareDecimals(a.amount, b.amount) === 0 &&
    a.row.currency === b.row.currency &&
    a.day === b.day
  );
}

/**
 * Propose own transfers from one bounded set of rows. Deterministic: the same
 * input in any order gives the same output.
 */
export async function proposeOwnTransfers(
  input: OwnTransferProposalInput,
): Promise<OwnTransferProposalRun> {
  if (input.policy === null || input.policy === undefined)
    return { ok: false, refusal: "policy_missing" };
  if (!validOwnTransferPolicy(input.policy)) return { ok: false, refusal: "policy_unsupported" };
  const policy = input.policy;
  if (!Array.isArray(input.rows) || input.rows.length > OWN_TRANSFER_ROWS_MAX)
    return { ok: false, refusal: "input_bound_exceeded" };
  if (typeof input.identityEpoch !== "string" || !IDENTITY_EPOCH.test(input.identityEpoch))
    return { ok: false, refusal: "identity_epoch_invalid" };
  if (!isText(input.ownership.version, 128))
    return { ok: false, refusal: "ownership_version_invalid" };

  const rowRefusals: { observationId: number; code: OwnTransferRowRefusal }[] = [];
  const admitted: AdmittedRow[] = [];
  const rows = [...input.rows].sort((a, b) => a.observationId - b.observationId);
  for (const row of rows) {
    const result = admitRow(row, input.ownership);
    if ("refusal" in result)
      rowRefusals.push({
        observationId: isSafeInt(row?.observationId) ? row.observationId : 0,
        code: result.refusal,
      });
    else admitted.push(result.admitted);
  }

  // Rule 3: rows of one alias class are one fact observed again only when
  // they agree on key and values; otherwise none of them is used.
  const byAlias = new Map<string, AdmittedRow[]>();
  for (const row of admitted) {
    const text = aliasClassText(row.leg.aliasClass);
    byAlias.set(text, [...(byAlias.get(text) ?? []), row]);
  }
  const heldKeys = new Set(input.held.keys);
  const heldAliases = new Set(input.held.aliasClasses);
  const usable: AdmittedRow[] = [];
  for (const [alias, group] of byAlias) {
    const [first, ...rest] = group as [AdmittedRow, ...AdmittedRow[]];
    if (!rest.every((row) => sameValues(first, row))) {
      for (const row of group)
        rowRefusals.push({ observationId: row.leg.observationId, code: "duplicate_unresolved" });
      continue;
    }
    for (const row of rest)
      rowRefusals.push({ observationId: row.leg.observationId, code: "same_fact_recaptured" });
    if (heldAliases.has(alias)) {
      rowRefusals.push({ observationId: first.leg.observationId, code: "alias_conflict" });
      continue;
    }
    if (heldKeys.has(consumptionKeyText(first.leg.key))) {
      rowRefusals.push({ observationId: first.leg.observationId, code: "economic_claim_held" });
      continue;
    }
    usable.push(first);
  }
  usable.sort((a, b) => a.leg.observationId - b.leg.observationId);

  const debits = usable.filter((row) => row.amount.coefficient.startsWith("-"));
  const credits = usable.filter((row) => !row.amount.coefficient.startsWith("-"));
  const pairRefusals: {
    debitObservationId: number;
    creditObservationId: number;
    code: OwnTransferPairRefusal;
  }[] = [];
  const candidates: {
    debit: AdmittedRow;
    credit: AdmittedRow;
    codes: OwnTransferProposalCode[];
  }[] = [];
  for (const debit of debits)
    for (const credit of credits) {
      const checked = pairCheck(debit, credit, policy);
      if ("refusal" in checked)
        pairRefusals.push({
          debitObservationId: debit.leg.observationId,
          creditObservationId: credit.leg.observationId,
          code: checked.refusal,
        });
      else candidates.push({ debit, credit, codes: checked.codes });
    }

  // A row in more than one candidate is never assigned: every candidate it is
  // in needs review (ties, one debit and two credits, and the reverse).
  const degree = new Map<number, number>();
  for (const { debit, credit } of candidates)
    for (const id of [debit.leg.observationId, credit.leg.observationId])
      degree.set(id, (degree.get(id) ?? 0) + 1);

  const policyDigest = await canonicalDigest(policy as unknown as Record<string, unknown>);
  const proposals: OwnTransferProposal[] = [];
  for (const { debit, credit, codes } of candidates) {
    const ambiguous =
      (degree.get(debit.leg.observationId) ?? 0) > 1 ||
      (degree.get(credit.leg.observationId) ?? 0) > 1;
    const proposalCodes: OwnTransferProposalCode[] = ambiguous
      ? [...codes, "candidate_not_unique"]
      : codes;
    const proposalId = `otp_${await canonicalDigest({
      engineRelease: OWN_TRANSFER_ENGINE_RELEASE,
      policyVersion: policy.policyVersion,
      identityEpoch: input.identityEpoch,
      debit: aliasClassText(debit.leg.aliasClass),
      credit: aliasClassText(credit.leg.aliasClass),
    })}`;
    const body = {
      proposalId,
      status: (ambiguous ? "needs_review" : "proposed") as OwnTransferProposalStatus,
      codes: proposalCodes,
      debit: debit.leg,
      credit: credit.leg,
      policyVersion: policy.policyVersion,
      engineRelease: OWN_TRANSFER_ENGINE_RELEASE,
      identityEpoch: input.identityEpoch,
    };
    proposals.push({ ...body, proposalDigest: await canonicalDigest(proposalJson(body)) });
  }
  proposals.sort((a, b) => compareText(a.proposalId, b.proposalId));
  rowRefusals.sort((a, b) => a.observationId - b.observationId || compareText(a.code, b.code));

  return {
    ok: true,
    manifest: {
      engineRelease: OWN_TRANSFER_ENGINE_RELEASE,
      policyVersion: policy.policyVersion,
      policyDigest,
      identityEpoch: input.identityEpoch,
      aliasRuleVersions: [...new Set(admitted.map((row) => row.leg.aliasClass.ruleVersion))].sort(),
      registryVersion: TRANSACTION_FAMILY_REGISTRY_VERSION,
      ownershipVersion: input.ownership.version,
      arithmeticVersion: ARITHMETIC_POLICY_VERSION,
      contractVersion: ECONOMIC_CONTRACT_VERSION,
    },
    proposals,
    rowRefusals,
    pairRefusals,
  };
}

/** The canonical JSON form of a proposal's legs (keys and alias classes as their stored texts). */
function proposalJson(body: Omit<OwnTransferProposal, "proposalDigest">): Record<string, unknown> {
  const leg = (value: OwnTransferLeg) => ({
    observationId: value.observationId,
    parseRunId: value.parseRunId,
    key: consumptionKeyText(value.key),
    aliasClass: aliasClassText(value.aliasClass),
    accountId: value.accountId,
  });
  return { ...body, debit: leg(body.debit), credit: leg(body.credit) };
}

/** A proposal's shape, as the store's builder checks it before writing a row. */
export function validOwnTransferProposal(value: unknown): value is OwnTransferProposal {
  const validLeg = (leg: unknown): leg is OwnTransferLeg =>
    isRecord(leg) &&
    hasExactKeys(leg, [
      "observationId",
      "parseRunId",
      "evidenceRef",
      "key",
      "aliasClass",
      "accountId",
    ]) &&
    isSafeInt(leg.observationId, 1) &&
    isSafeInt(leg.parseRunId, 1) &&
    validSourceFactRef(leg.evidenceRef) &&
    sameRef(leg.evidenceRef, transactionRowRef(leg.observationId, leg.parseRunId)) &&
    validConsumptionKey(leg.key) &&
    validAliasClass(leg.aliasClass) &&
    isText(leg.accountId, 256) &&
    leg.aliasClass.accountId === leg.accountId &&
    leg.aliasClass.sourceId === leg.key[0];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "proposalId",
      "proposalDigest",
      "status",
      "codes",
      "debit",
      "credit",
      "policyVersion",
      "engineRelease",
      "identityEpoch",
    ]) ||
    typeof value.proposalId !== "string" ||
    !OWN_TRANSFER_PROPOSAL_ID.test(value.proposalId) ||
    typeof value.proposalDigest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.proposalDigest) ||
    !isOneOf(OWN_TRANSFER_PROPOSAL_STATUSES)(value.status) ||
    !isArrayOf(
      isOneOf(OWN_TRANSFER_PROPOSAL_CODES),
      OWN_TRANSFER_PROPOSAL_CODES.length,
    )(value.codes) ||
    new Set(value.codes).size !== value.codes.length ||
    value.codes.includes("candidate_not_unique") !== (value.status === "needs_review") ||
    !validLeg(value.debit) ||
    !validLeg(value.credit) ||
    value.debit.accountId === value.credit.accountId ||
    typeof value.policyVersion !== "string" ||
    !POLICY_VERSION.test(value.policyVersion) ||
    !isText(value.engineRelease, 64) ||
    typeof value.identityEpoch !== "string" ||
    !IDENTITY_EPOCH.test(value.identityEpoch)
  )
    return false;
  return true;
}

function sameRef(a: SourceFactRef, b: SourceFactRef): boolean {
  return a.kind === b.kind && a.id === b.id && a.revision === b.revision;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

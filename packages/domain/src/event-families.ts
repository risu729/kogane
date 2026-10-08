// Transaction-family registry (ADR 0053, issue #549). For every parser that
// emits transaction or position rows it states, as closed codes, which
// economic-event family the rows belong to, how the parser records the rows'
// identity, which status vocabulary and provider-stated link fields the rows
// carry, and whether an event writer exists for that family today, with the
// closed reasons why not.
//
// The registry is a statement about the code, not adoption: nothing reads it to
// write an event, and a `supported` membership names a writer that exists, not
// an event that has been written. It holds no provider value, amount, account
// identifier or merchant text; every entry was read off the parser source and
// is checked against the parsers' synthetic fixtures in
// packages/parsers/test/event-families.test.ts.
import { hasExactKeys, isOneOf, isRecord, isText } from "./guards.ts";

export const TRANSACTION_FAMILY_REGISTRY_VERSION = "transaction-family-registry-v1";

/**
 * The closed list of economic-event families.
 *
 * - `bank-movement`: an increase or decrease of a deposit or stored-value
 *   balance as the row states it (a bank account, a Suica SF balance, a PayPay
 *   balance), whatever caused it. An own-account transfer is two such rows.
 * - `fx-exchange`: one currency exchanged for another inside one provider.
 * - `overseas-remittance`: money sent to or received from another country.
 * - `securities-order`, `securities-execution`, `securities-settlement-cash`:
 *   a securities order, its fill (quantity change), and the cash that settles it.
 * - `crypto-execution`, `crypto-fiat-remittance`: a crypto-asset fill, and fiat
 *   moved into or out of the exchange account.
 * - `reward-exchange`: points earned, used, or exchanged into another program.
 * - `prepaid-funding`: stored value charged from a card, bank or other balance.
 * - `prepaid-notification`: a provider notice of stored-value use or charge.
 * - `card-purchase`, `card-settlement`: the card families that have writers.
 */
export const TRANSACTION_FAMILIES = [
  "bank-movement",
  "fx-exchange",
  "overseas-remittance",
  "securities-order",
  "securities-execution",
  "securities-settlement-cash",
  "crypto-execution",
  "crypto-fiat-remittance",
  "reward-exchange",
  "prepaid-funding",
  "prepaid-notification",
  "card-purchase",
  "card-settlement",
] as const;
export type TransactionFamily = (typeof TRANSACTION_FAMILIES)[number];

/**
 * Why no economic event is written for a family, or for one parser's rows of
 * it. Closed; a new reason is a reviewed contract change.
 *
 * - `no_event_writer`: no code writes events of this family from these rows.
 * - `identity_fingerprint_only`: the row id is a fingerprint of the row's
 *   content and position, not an id the provider issued.
 * - `identity_evidence_digest`: the row id is a digest of the stored evidence
 *   message, not an id the provider issued; another delivery of the same
 *   notice (a forwarded copy) can carry another id.
 * - `identity_origin_unrecorded`: the row id may be the provider's, but the
 *   parser records no `_kogane.identityOrigin`, so stage A reads it as unknown.
 * - `identity_absent`: the row carries no external id at all.
 * - `direction_code_unmapped`: which way the quantity or cash moves is a
 *   provider code nobody has mapped (ADR 0004: never guessed).
 * - `cash_amount_not_stated`: the row states no cash amount; quantity × price
 *   is never used in its place.
 * - `counterpart_not_stated`: no provider-stated id links the row to the row
 *   on the other side (the other account, the other currency, the funding card).
 * - `not_collected`: no collector captures the rows this family needs.
 * - `semantics_unobserved`: what the rows mean for this family has not been
 *   observed or confirmed by the owner.
 * - `snapshot_only`: the rows are holdings at a point in time, never a movement.
 * - `writer_guard_pending`: a writer needs the writer/guard contract shared
 *   with #550 and #556, which is under design review (a later ADR).
 */
export const FAMILY_UNSUPPORTED_REASONS = [
  "no_event_writer",
  "identity_fingerprint_only",
  "identity_evidence_digest",
  "identity_origin_unrecorded",
  "identity_absent",
  "direction_code_unmapped",
  "cash_amount_not_stated",
  "counterpart_not_stated",
  "not_collected",
  "semantics_unobserved",
  "snapshot_only",
  "writer_guard_pending",
] as const;
export type FamilyUnsupportedReason = (typeof FAMILY_UNSUPPORTED_REASONS)[number];

/**
 * Fields the provider states on the row that a leg builder could use.
 * `none` is exclusive. `execution_sub_number`: a fill's sub-number under one
 * execution id; `value_date`: a settlement (value) date stated apart from the
 * trade or usage date; `settlement_amount`: the amount in the settlement unit
 * stated beside a trade price or usage amount in another; `commission_stated`:
 * a commission or fee column; `exchange_rate_stated`: a conversion rate column.
 */
export const PROVIDER_LINK_CODES = [
  "execution_sub_number",
  "value_date",
  "settlement_amount",
  "commission_stated",
  "exchange_rate_stated",
  "none",
] as const;
export type ProviderLinkCode = (typeof PROVIDER_LINK_CODES)[number];

/**
 * What the row's external id is, read off the parser: a provider row id, a
 * tuple of provider ids, a digest of the stored evidence message, a parser
 * fingerprint of the row's fields plus an occurrence ordinal, a fingerprint the
 * collector computed, or no external id.
 */
export const EXTERNAL_ID_BASES = [
  "provider_id",
  "provider_id_tuple",
  "evidence_digest",
  "fingerprint_occurrence",
  "collector_fingerprint",
  "none",
] as const;
export type ExternalIdBasis = (typeof EXTERNAL_ID_BASES)[number];

/** The `_kogane` key a parser records its identity origin under. */
export const RECORDED_ORIGIN_KEYS = ["identityOrigin", "externalIdOrigin"] as const;
export type RecordedOriginKey = (typeof RECORDED_ORIGIN_KEYS)[number];

/**
 * What stage A (services/processor/src/reconciliation-job.ts `originOf`) reads
 * as the row's identifier origin. It reads only `$._kogane.identityOrigin`:
 * text naming a fingerprint or an occurrence is `fingerprint`, any other text
 * `provider`, and no `identityOrigin` (none recorded, or an origin recorded
 * under another key) is `unknown`. This is how the text is read, not what the
 * id is: `externalId` states that, and the two can disagree (V Point Pay).
 */
export const STAGE_A_ORIGIN_READINGS = ["provider", "fingerprint", "unknown"] as const;
export type StageAOriginReading = (typeof STAGE_A_ORIGIN_READINGS)[number];

export interface RecordedIdentity {
  /** What the external id is, read off the parser. */
  externalId: ExternalIdBasis;
  /** Null when the parser records no origin under either key. */
  originKey: RecordedOriginKey | null;
  /** `unknown` exactly when `originKey` is not `identityOrigin`. */
  stageAReads: StageAOriginReading;
}

export const REGISTRY_OBSERVATION_KINDS = ["transaction", "position"] as const;
export type RegistryObservationKind = (typeof REGISTRY_OBSERVATION_KINDS)[number];

/** The `status` column the rows carry: none, a closed set, or provider text kept verbatim. */
export type StatusVocabulary =
  | { kind: "absent" }
  | { kind: "closed"; values: readonly string[] }
  | { kind: "provider-verbatim" };

export const WRITER_STATUSES = ["supported", "unsupported"] as const;
export type WriterStatus = (typeof WRITER_STATUSES)[number];

/** A family the rows belong to, and whether a writer exists for them. */
export type FamilyMembership =
  | { family: TransactionFamily; writer: "supported"; reasons: readonly [] }
  | {
      family: TransactionFamily;
      writer: "unsupported";
      reasons: readonly FamilyUnsupportedReason[];
    };

export interface TransactionFamilyEntry {
  sourceId: string;
  parserName: string;
  observationKinds: readonly RegistryObservationKind[];
  identity: RecordedIdentity;
  statuses: StatusVocabulary;
  providerLinks: readonly ProviderLinkCode[];
  /** Non-empty; the first membership is the rows' primary family. */
  families: readonly FamilyMembership[];
}

export interface FamilySupport {
  writer: WriterStatus;
  /** Reasons that hold for the family whatever the source; empty when supported. */
  reasons: readonly FamilyUnsupportedReason[];
}

const PENDING: readonly FamilyUnsupportedReason[] = ["no_event_writer", "writer_guard_pending"];

/** The family-level statement. A supported family can still have unsupported sources. */
export const FAMILY_SUPPORT: Readonly<Record<TransactionFamily, FamilySupport>> = {
  "bank-movement": { writer: "unsupported", reasons: PENDING },
  "fx-exchange": { writer: "unsupported", reasons: PENDING },
  "overseas-remittance": {
    writer: "unsupported",
    reasons: ["no_event_writer", "semantics_unobserved", "writer_guard_pending"],
  },
  "securities-order": { writer: "unsupported", reasons: ["no_event_writer", "not_collected"] },
  "securities-execution": { writer: "unsupported", reasons: PENDING },
  "securities-settlement-cash": { writer: "unsupported", reasons: PENDING },
  "crypto-execution": { writer: "unsupported", reasons: PENDING },
  "crypto-fiat-remittance": { writer: "unsupported", reasons: PENDING },
  "reward-exchange": { writer: "unsupported", reasons: ["no_event_writer", "not_collected"] },
  "prepaid-funding": { writer: "unsupported", reasons: PENDING },
  "prepaid-notification": {
    writer: "unsupported",
    reasons: ["no_event_writer", "semantics_unobserved"],
  },
  "card-purchase": { writer: "supported", reasons: [] },
  "card-settlement": { writer: "supported", reasons: [] },
};

const supported = (family: TransactionFamily): FamilyMembership => ({
  family,
  writer: "supported",
  reasons: [],
});
const unsupported = (
  family: TransactionFamily,
  ...extra: FamilyUnsupportedReason[]
): FamilyMembership => ({
  family,
  writer: "unsupported",
  reasons: FAMILY_UNSUPPORTED_REASONS.filter(
    (reason) =>
      reason === "no_event_writer" ||
      FAMILY_SUPPORT[family].reasons.includes(reason) ||
      extra.includes(reason),
  ),
});
const identity = (
  externalId: ExternalIdBasis,
  originKey: RecordedOriginKey | null = null,
  stageAReads: StageAOriginReading = "unknown",
): RecordedIdentity => ({ externalId, originKey, stageAReads });
const ABSENT: StatusVocabulary = { kind: "absent" };
const POSTED: StatusVocabulary = { kind: "closed", values: ["posted"] };
const NO_LINK: readonly ProviderLinkCode[] = ["none"];

/**
 * One entry per (sourceId, parserName) of `packages/parsers` PARSERS whose
 * rows are transactions or positions. Ordered by source, then parser.
 */
export const TRANSACTION_FAMILY_REGISTRY: readonly TransactionFamilyEntry[] = [
  {
    // GLOBAL PASS debit card activity: fingerprint of all provider fields
    // (+ page) + occurrence; no status; amounts may be unsigned; whether a
    // pending row keeps its id when it is confirmed is unproven. The expanded
    // view must carry exactly three " Fee" fields (Transaction, ATM, FX) among
    // its ten; the observed view also states the local and funded currency
    // amounts and the applicable rate (kept in `expandedFields`).
    sourceId: "global-pass",
    parserName: "global-pass-activity",
    observationKinds: ["transaction"],
    identity: identity("fingerprint_occurrence", "identityOrigin", "fingerprint"),
    statuses: ABSENT,
    providerLinks: ["settlement_amount", "commission_stated", "exchange_rate_stated"],
    families: [
      unsupported("card-purchase", "identity_fingerprint_only", "semantics_unobserved"),
      unsupported("fx-exchange", "identity_fingerprint_only", "semantics_unobserved"),
    ],
  },
  {
    sourceId: "mizuho-bank",
    parserName: "mizuho-ordinary-history",
    observationKinds: ["transaction"],
    identity: identity("fingerprint_occurrence", "identityOrigin", "fingerprint"),
    statuses: POSTED,
    providerLinks: NO_LINK,
    families: [unsupported("bank-movement", "identity_fingerprint_only", "counterpart_not_stated")],
  },
  {
    // Rows of kind charge (card → SF), payment, rail and bus; the funding card
    // of a charge is not stated.
    sourceId: "mobile-suica",
    parserName: "mobile-suica-sf-history",
    observationKinds: ["transaction"],
    identity: identity("fingerprint_occurrence", "identityOrigin", "fingerprint"),
    statuses: POSTED,
    providerLinks: NO_LINK,
    families: [
      unsupported("bank-movement", "identity_fingerprint_only"),
      unsupported("prepaid-funding", "identity_fingerprint_only", "counterpart_not_stated"),
    ],
  },
  {
    // Aggregator copies of rows other sources collect directly (#545).
    sourceId: "moneyforward-me",
    parserName: "moneyforward-monthly-transactions",
    observationKinds: ["transaction"],
    identity: identity("fingerprint_occurrence", "identityOrigin", "fingerprint"),
    statuses: ABSENT,
    providerLinks: NO_LINK,
    families: [unsupported("bank-movement", "identity_fingerprint_only", "counterpart_not_stated")],
  },
  {
    sourceId: "myjcb",
    parserName: "myjcb-credit-ledger",
    observationKinds: ["transaction"],
    identity: identity("fingerprint_occurrence", "identityOrigin", "fingerprint"),
    statuses: { kind: "closed", values: ["confirmed", "unconfirmed"] },
    providerLinks: NO_LINK,
    families: [supported("card-purchase")],
  },
  {
    // `transactionNumber` is a provider row id, but the parser records no
    // `_kogane` at all. The method column names the funding instrument as text.
    sourceId: "paypay",
    parserName: "paypay-csv",
    observationKinds: ["transaction"],
    identity: identity("provider_id"),
    statuses: ABSENT,
    providerLinks: ["settlement_amount", "exchange_rate_stated"],
    families: [
      unsupported("bank-movement", "identity_origin_unrecorded", "semantics_unobserved"),
      unsupported("prepaid-funding", "identity_origin_unrecorded", "counterpart_not_stated"),
      unsupported("fx-exchange", "identity_origin_unrecorded", "semantics_unobserved"),
    ],
  },
  {
    sourceId: "sbi-securities",
    parserName: "sbi-domestic-cash-positions",
    observationKinds: ["position"],
    identity: identity("none"),
    statuses: ABSENT,
    providerLinks: NO_LINK,
    families: [unsupported("securities-execution", "snapshot_only")],
  },
  {
    // `record.id` is the collector's fingerprint of the table cells plus an
    // occurrence, recorded under `_kogane.externalIdOrigin`; the trade type is
    // raw text; the collector record carries a value date.
    sourceId: "sbi-securities",
    parserName: "sbi-domestic-trade-records",
    observationKinds: ["transaction"],
    identity: identity("collector_fingerprint", "externalIdOrigin"),
    statuses: ABSENT,
    providerLinks: ["value_date"],
    families: [
      unsupported(
        "securities-execution",
        "identity_fingerprint_only",
        "identity_origin_unrecorded",
        "direction_code_unmapped",
      ),
    ],
  },
  {
    sourceId: "sbi-securities",
    parserName: "sbi-foreign-cash-positions",
    observationKinds: ["position"],
    identity: identity("none"),
    statuses: ABSENT,
    providerLinks: NO_LINK,
    families: [unsupported("securities-execution", "snapshot_only")],
  },
  {
    // Canonical-row fingerprint + occurrence; `tradeRecordTypeCode` unmapped;
    // amount in the settlement currency, price in the trade currency, value
    // date; no fee field and no order id.
    sourceId: "sbi-securities",
    parserName: "sbi-foreign-trade-records",
    observationKinds: ["transaction"],
    identity: identity("fingerprint_occurrence", "identityOrigin", "fingerprint"),
    statuses: POSTED,
    providerLinks: ["value_date", "settlement_amount"],
    families: [
      unsupported("securities-execution", "identity_fingerprint_only", "direction_code_unmapped"),
    ],
  },
  {
    // The provider `did` is the row id; no origin is recorded; `payDepKbn`
    // gives the direction; no security code links a row to a trade.
    sourceId: "sbi-securities",
    parserName: "sbi-yen-detail-history",
    observationKinds: ["transaction"],
    identity: identity("provider_id"),
    statuses: POSTED,
    providerLinks: NO_LINK,
    families: [
      unsupported(
        "securities-settlement-cash",
        "identity_origin_unrecorded",
        "counterpart_not_stated",
      ),
    ],
  },
  {
    // `txnReferenceNo`, no origin recorded, no status; debit/credit columns;
    // `tradeTypeCode` kept unmapped; one native currency per account.
    sourceId: "sbi-shinsei-bank",
    parserName: "sbi-shinsei-top-balances-and-activity",
    observationKinds: ["transaction"],
    identity: identity("provider_id"),
    statuses: ABSENT,
    providerLinks: NO_LINK,
    families: [
      unsupported("bank-movement", "identity_origin_unrecorded", "counterpart_not_stated"),
      unsupported(
        "fx-exchange",
        "identity_origin_unrecorded",
        "counterpart_not_stated",
        "semantics_unobserved",
      ),
      supported("card-settlement"),
    ],
  },
  {
    // JPY REMITTANCE_DEPOSIT / REMITTANCE_WITHDRAW only; `processStatusType`
    // kept verbatim; no bank-side link.
    sourceId: "sbi-vc-trade",
    parserName: "sbi-vc-cashflows",
    observationKinds: ["transaction"],
    identity: identity("provider_id"),
    statuses: { kind: "provider-verbatim" },
    providerLinks: ["value_date"],
    families: [
      unsupported("crypto-fiat-remittance", "identity_origin_unrecorded", "counterpart_not_stated"),
    ],
  },
  {
    // (`CExecutionId`, `CExecutionIdSubNo`); no amount or currency on the row.
    sourceId: "sbi-vc-trade",
    parserName: "sbi-vc-executions",
    observationKinds: ["transaction"],
    identity: identity("provider_id_tuple"),
    statuses: ABSENT,
    providerLinks: ["execution_sub_number", "value_date", "commission_stated"],
    families: [
      unsupported("crypto-execution", "identity_origin_unrecorded", "cash_amount_not_stated"),
    ],
  },
  {
    sourceId: "sbi-vc-trade",
    parserName: "sbi-vc-position-summary",
    observationKinds: ["position"],
    identity: identity("none"),
    statuses: ABSENT,
    providerLinks: NO_LINK,
    families: [unsupported("crypto-execution", "snapshot_only")],
  },
  {
    sourceId: "smbc-bank",
    parserName: "smbc-direct-transactions",
    observationKinds: ["transaction"],
    identity: identity("provider_id", "identityOrigin", "provider"),
    statuses: POSTED,
    providerLinks: NO_LINK,
    families: [
      unsupported("bank-movement", "counterpart_not_stated"),
      supported("card-settlement"),
    ],
  },
  {
    sourceId: "sony-bank",
    parserName: "sony-bank-history-csv",
    observationKinds: ["transaction"],
    identity: identity("fingerprint_occurrence", "identityOrigin", "fingerprint"),
    statuses: POSTED,
    providerLinks: ["exchange_rate_stated"],
    families: [
      unsupported("bank-movement", "identity_fingerprint_only", "counterpart_not_stated"),
      unsupported(
        "fx-exchange",
        "identity_fingerprint_only",
        "counterpart_not_stated",
        "semantics_unobserved",
      ),
    ],
  },
  {
    sourceId: "sony-bank",
    parserName: "sony-bank-history-json",
    observationKinds: ["transaction"],
    identity: identity("fingerprint_occurrence", "identityOrigin", "fingerprint"),
    statuses: POSTED,
    providerLinks: ["exchange_rate_stated"],
    families: [
      unsupported("bank-movement", "identity_fingerprint_only", "counterpart_not_stated"),
      unsupported(
        "fx-exchange",
        "identity_fingerprint_only",
        "counterpart_not_stated",
        "semantics_unobserved",
      ),
    ],
  },
  {
    // Sony Bank WALLET debit card: pending (未確定) or posted with a confirmed
    // date; usage and transaction amounts, fee columns and a conversion rate;
    // the deposit debit for the same money carries no link to the row.
    sourceId: "sony-bank",
    parserName: "sony-bank-wallet-history",
    observationKinds: ["transaction"],
    identity: identity("fingerprint_occurrence", "identityOrigin", "fingerprint"),
    statuses: { kind: "closed", values: ["pending", "posted"] },
    providerLinks: ["value_date", "settlement_amount", "commission_stated", "exchange_rate_stated"],
    families: [
      unsupported("card-purchase", "identity_fingerprint_only", "counterpart_not_stated"),
      unsupported("fx-exchange", "identity_fingerprint_only", "semantics_unobserved"),
    ],
  },
  {
    // No provider id or posted marker was observed.
    sourceId: "st-george",
    parserName: "st-george-transactions",
    observationKinds: ["transaction"],
    identity: identity("fingerprint_occurrence", "identityOrigin", "fingerprint"),
    statuses: ABSENT,
    providerLinks: NO_LINK,
    families: [unsupported("bank-movement", "identity_fingerprint_only", "counterpart_not_stated")],
  },
  {
    // The id is the SHA-256 of the stored notification message: for a direct
    // delivery the outer message hash, for a forwarded one not (so two
    // deliveries of one notice can carry two ids). The parser records it as
    // `normalized-event-id`, which stage A reads as provider-issued — a limit
    // until a parser release records its origin. A notification does not
    // establish settlement; charge events fund the balance from a source the
    // notice does not link.
    sourceId: "v-point-pay",
    parserName: "v-point-pay-notification-event",
    observationKinds: ["transaction"],
    identity: identity("evidence_digest", "identityOrigin", "provider"),
    statuses: { kind: "closed", values: ["notified", "declined"] },
    providerLinks: NO_LINK,
    families: [
      unsupported("prepaid-notification", "identity_evidence_digest"),
      unsupported(
        "prepaid-funding",
        "identity_evidence_digest",
        "counterpart_not_stated",
        "semantics_unobserved",
      ),
    ],
  },
  {
    // No external id (`providerStableId: unavailable`); point division and
    // type are unmapped provider enums. The date the points were reflected
    // (`date_reflect`) is stated apart from the use date (`date_use`).
    sourceId: "v-point",
    parserName: "v-point-history-page",
    observationKinds: ["transaction"],
    identity: identity("none"),
    statuses: ABSENT,
    providerLinks: ["value_date"],
    families: [unsupported("reward-exchange", "identity_absent", "semantics_unobserved")],
  },
  {
    // The customized (unconfirmed) rows have an exact key set that includes
    // the local-currency amount and code (`genchiKin`, `tukaRyaku`) and the
    // conversion rate (`kanzanRate`). Not declared: `tesuWariKin` (equal to the
    // usage amount on the fixture rows; whether it is ever a separate fee is
    // unobserved), `kanzanDate` (a conversion date, not a settlement date) and
    // the row `shiharaiDate` (empty on every fixture row; meaning unobserved).
    sourceId: "vpass",
    parserName: "vpass-statement-page",
    observationKinds: ["transaction"],
    identity: identity("fingerprint_occurrence", "identityOrigin", "fingerprint"),
    statuses: { kind: "closed", values: ["posted", "unconfirmed"] },
    providerLinks: ["settlement_amount", "exchange_rate_stated"],
    families: [
      supported("card-purchase"),
      unsupported("fx-exchange", "identity_fingerprint_only", "semantics_unobserved"),
    ],
  },
];

/** The entry for one parser, or null when its rows are not in the registry. */
export function transactionFamilyEntry(
  sourceId: string,
  parserName: string,
): TransactionFamilyEntry | null {
  return (
    TRANSACTION_FAMILY_REGISTRY.find(
      (entry) => entry.sourceId === sourceId && entry.parserName === parserName,
    ) ?? null
  );
}

/** Every entry whose rows belong to the family, in registry order. */
export function transactionFamilyEntries(
  family: TransactionFamily,
): readonly TransactionFamilyEntry[] {
  return TRANSACTION_FAMILY_REGISTRY.filter((entry) =>
    entry.families.some((membership) => membership.family === family),
  );
}

/**
 * Why no event is written for some or all rows of the family: the
 * family-level reasons plus every unsupported membership's, in the order of
 * `FAMILY_UNSUPPORTED_REASONS`. Empty only when every source has a writer.
 */
export function familyUnsupportedReasons(
  family: TransactionFamily,
): readonly FamilyUnsupportedReason[] {
  const found = new Set<FamilyUnsupportedReason>(FAMILY_SUPPORT[family].reasons);
  for (const entry of transactionFamilyEntries(family))
    for (const membership of entry.families)
      if (membership.family === family) for (const reason of membership.reasons) found.add(reason);
  return FAMILY_UNSUPPORTED_REASONS.filter((reason) => found.has(reason));
}

const isFamily = isOneOf(TRANSACTION_FAMILIES);
const isReason = isOneOf(FAMILY_UNSUPPORTED_REASONS);
const isLink = isOneOf(PROVIDER_LINK_CODES);
const isBasis = isOneOf(EXTERNAL_ID_BASES);
const isOriginKey = isOneOf(RECORDED_ORIGIN_KEYS);
const isReading = isOneOf(STAGE_A_ORIGIN_READINGS);
const isKind = isOneOf(REGISTRY_OBSERVATION_KINDS);

function distinctNonEmpty<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => guard(item)) &&
    new Set(value).size === value.length
  );
}

function validIdentity(value: unknown): value is RecordedIdentity {
  if (!isRecord(value) || !hasExactKeys(value, ["externalId", "originKey", "stageAReads"]))
    return false;
  if (!isBasis(value.externalId) || !isReading(value.stageAReads)) return false;
  if (value.originKey !== null && !isOriginKey(value.originKey)) return false;
  return (value.originKey === "identityOrigin") === (value.stageAReads !== "unknown");
}

function validStatuses(value: unknown): value is StatusVocabulary {
  if (!isRecord(value)) return false;
  if (value.kind === "absent" || value.kind === "provider-verbatim")
    return hasExactKeys(value, ["kind"]);
  return (
    value.kind === "closed" &&
    hasExactKeys(value, ["kind", "values"]) &&
    distinctNonEmpty(value.values, (item): item is string => isText(item, 64))
  );
}

function validMembership(value: unknown): value is FamilyMembership {
  if (!isRecord(value) || !hasExactKeys(value, ["family", "writer", "reasons"])) return false;
  if (!isFamily(value.family) || !Array.isArray(value.reasons)) return false;
  if (value.writer === "supported") return value.reasons.length === 0;
  return (
    value.writer === "unsupported" &&
    distinctNonEmpty(value.reasons, isReason) &&
    value.reasons.includes("no_event_writer")
  );
}

/** Structural check of one entry: exact keys, closed codes, no duplicates. */
export function validTransactionFamilyEntry(value: unknown): value is TransactionFamilyEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "sourceId",
      "parserName",
      "observationKinds",
      "identity",
      "statuses",
      "providerLinks",
      "families",
    ])
  )
    return false;
  if (!isText(value.sourceId, 64) || !isText(value.parserName, 128)) return false;
  if (!distinctNonEmpty(value.observationKinds, isKind)) return false;
  if (!validIdentity(value.identity) || !validStatuses(value.statuses)) return false;
  if (!distinctNonEmpty(value.providerLinks, isLink)) return false;
  if (value.providerLinks.includes("none") && value.providerLinks.length !== 1) return false;
  if (!distinctNonEmpty(value.families, validMembership)) return false;
  const families = (value.families as FamilyMembership[]).map((membership) => membership.family);
  return new Set(families).size === families.length;
}

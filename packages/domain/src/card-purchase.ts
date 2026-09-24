// Card purchase recognition: one provider usage row of a verified card becomes
// one `purchase` or `refund` event on the `purchase-recognition` basis.
//
// The provider itself states that the charge was posted to that card, inside
// one verified namespace (source + producer + external id namespace + source
// account), so recognising the row asserts no correspondence between claims
// (INV07). It is still recorded as a `rule` decision. The scope is deliberately
// narrow: only single-payment rows with an exact amount and a stable card
// identity are recognised; every other row is excluded with a reason code from
// a closed set and never guessed (INV05). Installment, revolving and bonus rows
// are never recognised.
//
// Nothing here reads storage or a clock. The guarded write that stores a draft
// is `packages/storage-d1/src/atomic/card-purchase-recognition.ts`, and the
// schema that enforces one live holder per recognition key is CORE 0047.
import { canonicalDigest } from "./context.ts";
import {
  eventTransition,
  legTotal,
  validEconomicEventRevision,
  type EconomicEventKind,
  type EconomicEventRevision,
  type EconomicLeg,
  type EventState,
  type LegRole,
  type RecognitionBasis,
  type SourceFactRef,
  type UnknownStateReason,
} from "./events.ts";
import { hasExactKeys, isOneOf, isRecord } from "./guards.ts";
import { validLocalDateText, type TemporalValue } from "./time.ts";
import {
  compareDecimals,
  exactQuantity,
  integerDecimal,
  negateDecimal,
  validQuantity,
  type ExactDecimal,
  type Quantity,
  type ValueError,
} from "./values.ts";

export const CARD_PURCHASE_POLICY = "card-purchase-recognition-v1";
/** The actor every rule decision of this policy is recorded under. */
export const CARD_PURCHASE_ACTOR = `rule:${CARD_PURCHASE_POLICY}`;
/** The provider usage date is a Japanese civil date, as for card statements. */
export const CARD_PURCHASE_ZONE = "Asia/Tokyo";
/** The one basis these events carry; a card purchase moves no cash by itself. */
export const CARD_PURCHASE_BASIS: RecognitionBasis = "purchase-recognition";
/**
 * Payment types that are a single payment, compared after NFKC and trimming:
 * Vpass writes `1回払い`, MyJCB's ledger writes `一回払い`
 * (tests/fixtures/observation-pipeline/myjcb). Anything else (2回払い, 分割,
 * リボ, ボーナス一括, blank, a wording this list does not know yet) is
 * `payment_type_unsupported`: drift fails safe.
 */
export const SINGLE_PAYMENT_TYPES = ["1回払い", "一回払い"] as const;
/** Vpass rows need the trusted card binding; a card ordinal is not an identity. */
export const VPASS_STABLE_IDENTITY_FAMILY = "vpass-card-binding";

export const CARD_PURCHASE_SOURCES = ["vpass", "myjcb"] as const;
export type CardPurchaseSourceId = (typeof CARD_PURCHASE_SOURCES)[number];

/** Provider status → event state, per source. Any other status is unsupported. */
const PROVIDER_STATES: Record<CardPurchaseSourceId, Record<string, "captured" | "authorized">> = {
  vpass: { posted: "captured", unconfirmed: "authorized" },
  myjcb: { confirmed: "captured", unconfirmed: "authorized" },
};
export const CARD_PURCHASE_PROVIDER_STATUSES = ["posted", "confirmed", "unconfirmed"] as const;
export type CardPurchaseProviderStatus = (typeof CARD_PURCHASE_PROVIDER_STATUSES)[number];

/** Why a row is not recognised. Closed: a new reason is a reviewed contract change. */
export const CARD_USAGE_EXCLUSIONS = [
  "account_not_resolved",
  "card_identity_unstable",
  "amount_not_exact",
  "amount_zero",
  "unit_unsupported",
  "payment_type_unsupported",
  "installment_amount_differs",
  "payment_split_unknown",
  "refund_shape_unverified",
  "status_unsupported",
  "date_absent",
  "superseded_representation",
] as const;
export type CardUsageExclusion = (typeof CARD_USAGE_EXCLUSIONS)[number];

/** What one stored revision did; the same closed list as the 0047 CHECK. */
export const CARD_PURCHASE_ACTIONS = [
  "recognize",
  "revise",
  "reanchor",
  "retire",
  "merge",
  "split",
] as const;
export type CardPurchaseAction = (typeof CARD_PURCHASE_ACTIONS)[number];
export type CardPurchaseKind = Extract<EconomicEventKind, "purchase" | "refund">;
export type CardPurchaseKeyRole = "posted" | "pending";

/**
 * One current provider usage row, as the read model returns it. Every field is
 * a code, an identifier, an amount or a date: the merchant and any other
 * provider text are deliberately absent, so they cannot reach a stored fact.
 */
export interface CardUsageFact {
  observationId: number;
  parseRunId: number;
  sourceId: string;
  producerId: string;
  externalIdNamespace: string | null;
  sourceAccount: string;
  externalId: string | null;
  /** The resolved Layer C account; null while identity has not resolved it. */
  accountId: string | null;
  /** `identity_run_contexts.policy_family` of the run that resolved the account. */
  identityPolicyFamily: string | null;
  /** Provider status verbatim: Vpass `posted`/`unconfirmed`, MyJCB `confirmed`/`unconfirmed`. */
  providerStatus: string | null;
  /** The decimal-v1 amount of the row: outflow negative, inflow positive. */
  amount: Quantity;
  /** Provider usage date, `YYYY-MM-DD`. Never the statement or payment date. */
  usageDate: string | null;
  /** Provider payment type (支払区分); compared, never stored. */
  paymentType: string | null;
  /** `_kogane.statementMonth` or `_kogane.period` as parsed; normalised by `statementPeriod`. */
  statementPeriod: string | null;
  /** Vpass customized `uriageKbn`: `5` sale, `6` return. */
  providerSaleCode: string | null;
  /** MyJCB `ご利用金額` and `今回のお支払い金額` display texts. */
  usageAmountText: string | null;
  paymentAmountText: string | null;
  /** False when a newer representation of the same account/source/state/period exists. */
  newestRepresentation: boolean;
}

/**
 * The key a provider row is recognised under:
 * `[source_id, producer_id, external_id_namespace, source_account, external_id]`,
 * the same shape as the 0044 `bank_key`. Its JSON text equals SQLite's
 * `json_array(...)` of the same columns, which the 0047 key guard re-derives.
 */
export type RecognitionKey = readonly [
  sourceId: string,
  producerId: string,
  externalIdNamespace: string | null,
  sourceAccount: string,
  externalId: string,
];

/** One recognition key row of a revision. */
export interface CardPurchaseKey {
  /** `JSON.stringify(RecognitionKey)`. */
  key: string;
  role: CardPurchaseKeyRole;
  observationId: number;
  parseRunId: number;
}

/** The sidecar `facts_json`: codes, amounts and dates only, never provider text. */
export interface CardPurchaseFacts {
  providerStatus: CardPurchaseProviderStatus;
  /** The signed decimal-v1 amount of the displayed row (outflow negative). */
  amount: Quantity;
  usageDate: string;
  /** A code; the provider's own wording is never stored. */
  paymentType: "single-payment";
  /** How the amount was verified: the one provider amount, or MyJCB usage equal to payment. */
  amountCheck: "provider-amount" | "usage-equals-payment";
  providerSaleCode: "5" | "6" | null;
}
export const CARD_PURCHASE_FACT_KEYS = [
  "providerStatus",
  "amount",
  "usageDate",
  "paymentType",
  "amountCheck",
  "providerSaleCode",
] as const;

/** The sidecar row of one revision, apart from its event id, revision and digest. */
export interface CardPurchaseSidecar {
  accountId: string;
  sourceId: CardPurchaseSourceId;
  /** `YYYY-MM`, or null when the provider period is not in a recognised shape. */
  statementPeriod: string | null;
  facts: CardPurchaseFacts;
}

export type CardUsageClassification =
  | {
      ok: true;
      kind: CardPurchaseKind;
      state: "captured" | "authorized";
      /** Positive exact magnitude of the leg, in the row's unit. */
      magnitude: Quantity;
    }
  | { ok: false; reasonCode: CardUsageExclusion };

// ---------------------------------------------------------------------------
// The shared MyJCB installment rule
// ---------------------------------------------------------------------------

/**
 * A MyJCB display amount, read with the grammar the MyJCB ledger parser reads
 * its own amount cell with (`packages/parsers/src/parsers/myjcb.ts`
 * `jpyAmount`): NFKC, whitespace removed, an optional leading yen sign and
 * trailing `円`, then an exact integer with optional thousands separators and
 * an optional leading minus (`1,200円`, `-500円`). Anything else is not read as
 * a number.
 */
function myjcbDisplayInteger(value: string | null): bigint | null {
  if (value === null) return null;
  const text = value
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .replace(/^[¥\\]/u, "")
    .replace(/円$/u, "");
  if (!/^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/u.test(text)) return null;
  return BigInt(text.replaceAll(",", ""));
}

export type MyjcbAmountCheck =
  | { ok: true; amount: bigint }
  | { ok: false; reasonCode: "payment_split_unknown" | "installment_amount_differs" };

/**
 * MyJCB's posted amount can be an installment slice: the usage total and this
 * statement's payment differ. Only a row whose explicit usage and payment
 * totals are both readable and equal is one full payment. The amount is in the
 * provider's sign (a refund is negative). This is the one MyJCB amount rule:
 * recognition (`classifyCardUsage`) and pending-to-posted matching
 * (`comparableCardPayment`) both read the texts through it.
 */
export function myjcbAgreedAmount(
  usageAmountText: string | null,
  paymentAmountText: string | null,
): MyjcbAmountCheck {
  const usage = myjcbDisplayInteger(usageAmountText);
  const payment = myjcbDisplayInteger(paymentAmountText);
  if (usage === null || payment === null) return { ok: false, reasonCode: "payment_split_unknown" };
  if (usage !== payment) return { ok: false, reasonCode: "installment_amount_differs" };
  return { ok: true, amount: usage };
}

/**
 * Whether a row may take part in pending-to-posted matching: a MyJCB confirmed
 * row only when its usage and payment totals agree (`myjcbAgreedAmount`, so the
 * texts are read as the ledger parser reads them: `1,200円`, `¥1,200`, full
 * width) and are positive; every other row is unaffected. An installment slice
 * (usage 12,000 / payment 4,000), an unreadable or missing text, a zero and a
 * refund are never compared.
 */
export function comparableCardPayment(row: {
  sourceId: string;
  status: string | null;
  usageAmountText: string | null;
  paymentAmountText: string | null;
}): boolean {
  if (row.sourceId !== "myjcb" || row.status !== "confirmed") return true;
  const agreed = myjcbAgreedAmount(row.usageAmountText, row.paymentAmountText);
  return agreed.ok && agreed.amount > 0n;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * The statement period as `card_statement_facts.period` stores it (`YYYY-MM`),
 * so a purchase joins its statement on (account, source, period):
 *
 * - `YYYY-MM` and `YYYYMM` (Vpass `_kogane.statementMonth`, MyJCB's numeric
 *   `settlementYM`);
 * - MyJCB's `_kogane.period` label, `YYYY年M月お支払い分` or `YYYY年M月` after
 *   NFKC and whitespace removal. The label names the month the statement is
 *   paid in, which is the period the MyJCB statement parser derives from its
 *   payment date and cross-checks against this same label.
 *
 * Every other shape (the collector's `detailMonth-N` fallback, a date, free
 * text) is null, never a guess.
 */
export function statementPeriod(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const numeric = /^(\d{4})(?:-(\d{2})|(\d{2}))$/u.exec(value);
  const label = numeric
    ? null
    : /^(\d{4})年(\d{1,2})月(?:お支払い分)?$/u.exec(value.normalize("NFKC").replace(/\s+/gu, ""));
  const year = numeric?.[1] ?? label?.[1];
  const month = numeric ? (numeric[2] ?? numeric[3]!) : label?.[2]?.padStart(2, "0");
  if (year === undefined || month === undefined) return null;
  const number = Number(month);
  return number >= 1 && number <= 12 ? `${year}-${month}` : null;
}

function isCardSource(value: string): value is CardPurchaseSourceId {
  return (CARD_PURCHASE_SOURCES as readonly string[]).includes(value);
}

function singlePayment(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.normalize("NFKC").trim();
  return (SINGLE_PAYMENT_TYPES as readonly string[]).includes(normalized);
}

function exactOf(quantity: Quantity): ExactDecimal | null {
  return quantity.value.status === "exact" ? quantity.value.value : null;
}

/**
 * Recognised kind, state and magnitude of one row, or the reason it is not
 * recognised. The checks run in a fixed order so a row always reports the same
 * reason. A zero, missing, unparsed or non-JPY amount is excluded, never zero.
 */
export function classifyCardUsage(fact: CardUsageFact): CardUsageClassification {
  const fail = (reasonCode: CardUsageExclusion): CardUsageClassification => ({
    ok: false,
    reasonCode,
  });
  if (!fact.newestRepresentation) return fail("superseded_representation");
  const state = isCardSource(fact.sourceId)
    ? PROVIDER_STATES[fact.sourceId][fact.providerStatus ?? ""]
    : undefined;
  if (state === undefined) return fail("status_unsupported");
  if (fact.accountId === null || fact.accountId.length === 0) return fail("account_not_resolved");
  if (
    fact.externalId === null ||
    fact.externalId.length === 0 ||
    (fact.sourceId === "vpass" && fact.identityPolicyFamily !== VPASS_STABLE_IDENTITY_FAMILY)
  )
    return fail("card_identity_unstable");
  if (!validLocalDateText(fact.usageDate)) return fail("date_absent");
  if (fact.amount.value.status !== "exact") return fail("amount_not_exact");
  const { value: amount, normalizationVersion } = fact.amount.value;
  if (fact.amount.unitRef !== "JPY") return fail("unit_unsupported");
  const sign = compareDecimals(amount, integerDecimal(0));
  if (sign === 0) return fail("amount_zero");
  if (!singlePayment(fact.paymentType)) return fail("payment_type_unsupported");
  const kind: CardPurchaseKind = sign < 0 ? "purchase" : "refund";
  // The observation sign is the inverse of the provider's liability sign.
  const magnitude = sign < 0 ? negateDecimal(amount) : amount;
  if (fact.sourceId === "vpass" && fact.providerSaleCode !== null) {
    // A customized row states sale (5) or return (6); it must agree with the sign.
    if (kind === "refund" && fact.providerSaleCode !== "6") return fail("refund_shape_unverified");
    if (kind === "purchase" && fact.providerSaleCode !== "5") return fail("status_unsupported");
  }
  if (fact.sourceId === "myjcb") {
    const agreed = myjcbAgreedAmount(fact.usageAmountText, fact.paymentAmountText);
    const matches =
      agreed.ok && compareDecimals(integerDecimal(agreed.amount), negateDecimal(amount)) === 0;
    if (kind === "refund" && !matches) return fail("refund_shape_unverified");
    if (!agreed.ok) return fail(agreed.reasonCode);
    if (!matches) return fail("installment_amount_differs");
  }
  return {
    ok: true,
    kind,
    state,
    magnitude: exactQuantity(fact.amount.unitRef, magnitude, normalizationVersion),
  };
}

/** The immutable Layer B reference of a row: never a bare string (SourceFactRef). */
export function cardUsageRef(
  fact: Pick<CardUsageFact, "observationId" | "parseRunId">,
): SourceFactRef {
  return {
    kind: "transaction",
    id: `transaction:${fact.observationId}`,
    revision: `parse_run:${fact.parseRunId}`,
  };
}

/** The recognition key of a row, or null when the row has no external id. */
export function recognitionKey(fact: CardUsageFact): RecognitionKey | null {
  if (fact.externalId === null || fact.externalId.length === 0) return null;
  return [
    fact.sourceId,
    fact.producerId,
    fact.externalIdNamespace,
    fact.sourceAccount,
    fact.externalId,
  ];
}

/**
 * `purchase_<sha256>` or `refund_<sha256>` over the policy and the key that
 * first recognised the event. A key already held by a live event keeps that
 * event's id instead; this only names a new one.
 */
export async function cardPurchaseEventId(
  kind: CardPurchaseKind,
  key: RecognitionKey,
): Promise<string> {
  return `${kind}_${await canonicalDigest({ policy: CARD_PURCHASE_POLICY, key: [...key] })}`;
}

const EVENT_ID = /^(purchase|refund)_[0-9a-f]{64}$/u;

// ---------------------------------------------------------------------------
// Content identity and drafts
// ---------------------------------------------------------------------------

/**
 * The object whose digest identifies a revision's content. Observation ids,
 * parse-run ids and the policy release are excluded on purpose: a re-fetch
 * that shows the same row is not a new revision.
 */
export interface CardPurchaseContent {
  kind: EconomicEventKind;
  state: EventState;
  unknownReason: UnknownStateReason | null;
  effectiveTime: TemporalValue;
  basis: RecognitionBasis;
  legs: {
    subjectRef: string;
    unitRef: string;
    coefficient: string;
    scale: number;
    role: LegRole;
    basis: RecognitionBasis;
  }[];
  keys: { key: string; role: CardPurchaseKeyRole }[];
}

/** Content of a revision and its keys, or null when a leg is not exact. */
export function cardPurchaseContent(
  revision: Pick<
    EconomicEventRevision,
    "kind" | "state" | "unknownReason" | "effectiveTime" | "basis" | "legs"
  >,
  keys: readonly Pick<CardPurchaseKey, "key" | "role">[],
): CardPurchaseContent | null {
  const legs: CardPurchaseContent["legs"] = [];
  for (const leg of [...revision.legs].sort((a, b) => a.legIndex - b.legIndex)) {
    const value = exactOf(leg.quantity);
    if (value === null) return null;
    legs.push({
      subjectRef: leg.subjectRef,
      unitRef: leg.quantity.unitRef,
      coefficient: value.coefficient,
      scale: value.scale,
      role: leg.role,
      basis: leg.basis,
    });
  }
  return {
    kind: revision.kind,
    state: revision.state,
    unknownReason: revision.unknownReason,
    effectiveTime: revision.effectiveTime,
    basis: revision.basis,
    legs,
    keys: keys
      .map((key) => ({ key: key.key, role: key.role }))
      .sort((a, b) =>
        a.key < b.key ? -1 : a.key > b.key ? 1 : a.role < b.role ? -1 : a.role > b.role ? 1 : 0,
      ),
  };
}

/** `dr_cp_<sha256>`: one decision per (event, revision, content, action). */
export async function cardPurchaseDecisionId(input: {
  eventId: string;
  revision: number;
  contentDigest: string;
  action: CardPurchaseAction;
}): Promise<string> {
  return `dr_cp_${await canonicalDigest({
    eventId: input.eventId,
    revision: input.revision,
    contentDigest: input.contentDigest,
    action: input.action,
  })}`;
}

/** The first revision is an `accept`; every later one supersedes the live one. */
export function cardPurchaseDecisionKind(action: CardPurchaseAction): "accept" | "supersede" {
  return action === "recognize" ? "accept" : "supersede";
}

/** The decision reason: codes only, never provider text. */
export function cardPurchaseDecisionReason(action: CardPurchaseAction): string {
  return `${CARD_PURCHASE_POLICY}:${action}`;
}

/** A revision ready for the guarded write: the event revision, its keys, sidecar and identity. */
export interface CardPurchaseDraft {
  action: CardPurchaseAction;
  /** Validated by `validEconomicEventRevision`. */
  revision: EconomicEventRevision;
  keys: CardPurchaseKey[];
  sidecar: CardPurchaseSidecar;
  content: CardPurchaseContent;
  contentDigest: string;
  decisionRevisionId: string;
}

async function draft(
  action: CardPurchaseAction,
  body: Omit<EconomicEventRevision, "decisionRevisionRef" | "supersededBy">,
  keys: CardPurchaseKey[],
  sidecar: CardPurchaseSidecar,
): Promise<CardPurchaseDraft | null> {
  const content = cardPurchaseContent(body, keys);
  if (content === null || keys.length === 0) return null;
  const contentDigest = await canonicalDigest(content);
  const decisionRevisionId = await cardPurchaseDecisionId({
    eventId: body.eventId,
    revision: body.revision,
    contentDigest,
    action,
  });
  const revision: EconomicEventRevision = {
    ...body,
    decisionRevisionRef: decisionRevisionId,
    supersededBy: null,
  };
  if (!validEconomicEventRevision(revision) || !validCardPurchaseFacts(sidecar.facts)) return null;
  return { action, revision, keys, sidecar, content, contentDigest, decisionRevisionId };
}

function providerStatusOf(value: string | null): CardPurchaseProviderStatus | null {
  return isOneOf(CARD_PURCHASE_PROVIDER_STATUSES)(value) ? value : null;
}

/**
 * A live revision read from one displayed row: exactly one
 * `purchase-recognition` leg on `account:<id>` (a purchase decreases net
 * position, a refund increases it, as in SC02), no cash-movement leg, no
 * allocation, and the row itself as `SourceFactRef` evidence. Null when the row
 * is not recognisable or the input is inconsistent.
 */
export async function cardPurchaseRevision(input: {
  action: "recognize" | "revise" | "reanchor";
  eventId: string;
  /** 1 for a first recognition, otherwise the live revision + 1. */
  revision: number;
  fact: CardUsageFact;
}): Promise<CardPurchaseDraft | null> {
  const { action, eventId, revision, fact } = input;
  const recognised = classifyCardUsage(fact);
  const key = recognitionKey(fact);
  const providerStatus = providerStatusOf(fact.providerStatus);
  if (
    !recognised.ok ||
    key === null ||
    providerStatus === null ||
    fact.accountId === null ||
    fact.usageDate === null ||
    !isCardSource(fact.sourceId) ||
    !Number.isSafeInteger(revision) ||
    (action === "recognize") !== (revision === 1) ||
    EVENT_ID.exec(eventId)?.[1] !== recognised.kind
  )
    return null;
  const leg: EconomicLeg = {
    eventId,
    revision,
    legIndex: 0,
    subjectRef: `account:${fact.accountId}`,
    quantity: recognised.magnitude,
    role: recognised.kind === "purchase" ? "decrease" : "increase",
    basis: CARD_PURCHASE_BASIS,
  };
  const saleCode = fact.providerSaleCode === "5" || fact.providerSaleCode === "6";
  return draft(
    action,
    {
      eventId,
      revision,
      kind: recognised.kind,
      state: recognised.state,
      unknownReason: null,
      effectiveTime: {
        kind: "local-date",
        value: fact.usageDate,
        zone: CARD_PURCHASE_ZONE,
        basis: "provider",
      },
      basis: CARD_PURCHASE_BASIS,
      evidenceSupport: [cardUsageRef(fact)],
      legs: [leg],
    },
    [
      {
        key: JSON.stringify(key),
        role: recognised.state === "captured" ? "posted" : "pending",
        observationId: fact.observationId,
        parseRunId: fact.parseRunId,
      },
    ],
    {
      accountId: fact.accountId,
      sourceId: fact.sourceId,
      statementPeriod: statementPeriod(fact.statementPeriod),
      facts: {
        providerStatus,
        amount: fact.amount,
        usageDate: fact.usageDate,
        paymentType: "single-payment",
        amountCheck: fact.sourceId === "myjcb" ? "usage-equals-payment" : "provider-amount",
        providerSaleCode: saleCode ? (fact.providerSaleCode as "5" | "6") : null,
      },
    },
  );
}

/**
 * The live event's row is no longer displayed (or a reviewed link was
 * withdrawn): a revision in state `unknown` with the reason, **no legs**, and
 * the last displayed row as evidence. It infers neither a refund nor a
 * cancellation (SC03 pending-vanished). Null when the transition is not
 * allowed, e.g. the event is already unknown.
 */
export async function cardPurchaseRetirement(input: {
  live: EconomicEventRevision;
  keys: readonly CardPurchaseKey[];
  sidecar: CardPurchaseSidecar;
  reason?: Extract<UnknownStateReason, "provider_status_absent" | "conflicting_evidence">;
}): Promise<CardPurchaseDraft | null> {
  const { live, sidecar } = input;
  if (
    !validEconomicEventRevision(live) ||
    live.supersededBy !== null ||
    (live.kind !== "purchase" && live.kind !== "refund") ||
    live.basis !== CARD_PURCHASE_BASIS ||
    !eventTransition(live.kind, live.state, "unknown").ok
  )
    return null;
  return draft(
    "retire",
    {
      eventId: live.eventId,
      revision: live.revision + 1,
      kind: live.kind,
      state: "unknown",
      unknownReason: input.reason ?? "provider_status_absent",
      effectiveTime: live.effectiveTime,
      basis: CARD_PURCHASE_BASIS,
      evidenceSupport: [...live.evidenceSupport],
      legs: [],
    },
    input.keys.map((key) => ({ ...key })),
    { ...sidecar, facts: { ...sidecar.facts } },
  );
}

export type CardPurchaseNextAction = "none" | "recognize" | "revise" | "reanchor" | "blocked";

/**
 * What the writer should do for one key. Same content with evidence that is
 * still adopted is nothing to do; same content whose evidence parse is no
 * longer published is re-anchored to the current row; changed content is a
 * revision when the state change is allowed by `eventTransition` (a correction
 * inside one state is always allowed). A different kind is never a revision.
 */
export function nextCardPurchaseAction(input: {
  live: {
    kind: EconomicEventKind;
    state: EventState;
    contentDigest: string;
    /** Every parse run the live evidence cites is still published. */
    evidenceAdopted: boolean;
  } | null;
  next: { kind: CardPurchaseKind; state: EventState; contentDigest: string };
}): CardPurchaseNextAction {
  const { live, next } = input;
  if (live === null) return "recognize";
  if (live.kind !== next.kind) return "blocked";
  if (live.contentDigest === next.contentDigest) return live.evidenceAdopted ? "none" : "reanchor";
  if (live.state === next.state) return "revise";
  return eventTransition(live.kind, live.state, next.state).ok ? "revise" : "blocked";
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/** Per unit, states kept apart. There is deliberately no combined total. */
export interface CardPurchaseUnitTotals {
  unitRef: string;
  captured: Quantity;
  authorized: Quantity;
  capturedRefunds: Quantity;
  authorizedRefunds: Quantity;
}
export interface CardPurchaseSummary {
  units: CardPurchaseUnitTotals[];
  /** Live purchase/refund events in state `unknown`: counted, never summed. */
  unresolved: number;
}

/**
 * State-separated totals of the **live** purchase/refund revisions. Only
 * `purchase-recognition` legs are read, so a settlement's cash leg adds
 * nothing; `captured` and `authorized` are never added together, and neither
 * are two units. A leg without an exact amount fails the summary.
 */
export function cardPurchaseSummary(
  events: readonly EconomicEventRevision[],
): { ok: true; summary: CardPurchaseSummary } | { ok: false; error: ValueError } {
  const live = events.filter(
    (event) =>
      event.supersededBy === null && (event.kind === "purchase" || event.kind === "refund"),
  );
  const bucket = (kind: CardPurchaseKind, state: EventState): EconomicLeg[] =>
    live
      .filter((event) => event.kind === kind && event.state === state)
      .flatMap((event) => event.legs.filter((leg) => leg.basis === CARD_PURCHASE_BASIS));
  const buckets = {
    captured: bucket("purchase", "captured"),
    authorized: bucket("purchase", "authorized"),
    capturedRefunds: bucket("refund", "captured"),
    authorizedRefunds: bucket("refund", "authorized"),
  };
  const unitRefs = [
    ...new Set(
      Object.values(buckets)
        .flat()
        .map((leg) => leg.quantity.unitRef),
    ),
  ].sort();
  const units: CardPurchaseUnitTotals[] = [];
  for (const unitRef of unitRefs) {
    const totals: Partial<Record<keyof typeof buckets, Quantity>> = {};
    for (const [name, legs] of Object.entries(buckets) as [keyof typeof buckets, EconomicLeg[]][]) {
      const total = legTotal(legs, { unitRef, basis: CARD_PURCHASE_BASIS });
      if (!total.ok) return total;
      totals[name] = total.quantity;
    }
    units.push({
      unitRef,
      captured: totals.captured!,
      authorized: totals.authorized!,
      capturedRefunds: totals.capturedRefunds!,
      authorizedRefunds: totals.authorizedRefunds!,
    });
  }
  return {
    ok: true,
    summary: { units, unresolved: live.filter((event) => event.state === "unknown").length },
  };
}

// ---------------------------------------------------------------------------
// Stored facts
// ---------------------------------------------------------------------------

/** Fail closed on a malformed or text-bearing `facts_json` instead of displaying it. */
export function validCardPurchaseFacts(value: unknown): value is CardPurchaseFacts {
  if (!isRecord(value) || !hasExactKeys(value, CARD_PURCHASE_FACT_KEYS)) return false;
  const amount = value.amount;
  return (
    isOneOf(CARD_PURCHASE_PROVIDER_STATUSES)(value.providerStatus) &&
    validQuantity(amount) &&
    amount.value.status === "exact" &&
    amount.value.value.coefficient !== "0" &&
    validLocalDateText(value.usageDate) &&
    value.paymentType === "single-payment" &&
    (value.amountCheck === "provider-amount" || value.amountCheck === "usage-equals-payment") &&
    (value.providerSaleCode === null ||
      value.providerSaleCode === "5" ||
      value.providerSaleCode === "6")
  );
}

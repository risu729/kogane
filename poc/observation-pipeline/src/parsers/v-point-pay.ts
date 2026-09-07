import type {
  ArtifactMeta,
  BalanceObservation,
  Observation,
  Parser,
  ParseResult,
  TransactionObservation,
} from "../types.ts";
import { decodeUtf8, isObject } from "./util.ts";

const SOURCE_ID = "v-point-pay";
const TRANSACTION_SOURCE_ACCOUNT = "v-point-pay:notification-events";
const BALANCE_SOURCE_ACCOUNT = "v-point-pay:prepaid-yen";
const DATASET = "notification-event";
const ARTIFACT_KEY = "normalized-event.json";
const MIME = "application/json";
const SCHEMA_V1 = "vpoint-pay-email-event-v1";
const SCHEMA_V2 = "vpoint-pay-email-event-v2";
const PROVENANCE_SCHEMA = "vpoint-pay-email-source-provenance-v1";
const EXPECTED_RECIPIENT = "vpointpay@takuk.me";
const EXPECTED_SENDER = "info@prepaid.smbc-card.com";
const SHA256 = /^[0-9a-f]{64}$/u;
const CORE_KEYS = [
  "amountYen",
  "balanceYen",
  "detail",
  "eventType",
  "id",
  "merchant",
  "occurredAt",
  "schemaVersion",
  "sourceMessageId",
  "subject",
  "usedPoints",
] as const;
const PROVENANCE_KEYS = [
  "authenticationProvenance",
  "delivery",
  "envelopeFrom",
  "envelopeTo",
  "outerMessageSha256",
  "schemaVersion",
  "sourceVerification",
  "storedMessageScope",
] as const;

type EventType = "usage" | "charge" | "balance-addition" | "declined";

interface Event {
  schemaVersion: typeof SCHEMA_V1 | typeof SCHEMA_V2;
  id: string;
  occurredAt: string;
  eventType: EventType;
  subject: string;
  merchant: string | null;
  detail: string | null;
  amountYen: number | null;
  usedPoints: number | null;
  balanceYen: number | null;
}

export const vPointPayNotificationEvent: Parser = {
  name: "v-point-pay-notification-event",
  version: "1.0.0",

  accepts(artifact: ArtifactMeta): boolean {
    return (
      artifact.sourceId === SOURCE_ID &&
      artifact.dataset === DATASET &&
      artifact.artifactKey === ARTIFACT_KEY &&
      artifact.mime === MIME
    );
  },

  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    if (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) {
      throw new Error("V Point Pay observations require a successful failure-free fetch run");
    }
    const event = parseEvent(bytes);
    const declined = event.eventType === "declined";
    if (!declined && event.amountYen === null) {
      throw new Error("V Point Pay non-declined notification amountYen must not be null");
    }
    const magnitude = Math.abs(event.amountYen ?? 0);
    const signedAmount = event.eventType === "usage" && magnitude !== 0 ? -magnitude : magnitude;
    const transaction: TransactionObservation = {
      kind: "transaction",
      sourceAccount: TRANSACTION_SOURCE_ACCOUNT,
      externalId: event.id,
      status: declined ? "declined" : "notified",
      ...(!declined
        ? {
            amountMinor: signedAmount,
            amountText: String(signedAmount),
            amountScale: 0,
            currency: "JPY",
          }
        : {}),
      description: event.merchant ?? event.detail ?? event.subject,
      ...(event.merchant ? { counterparty: event.merchant } : {}),
      asOf: event.occurredAt,
      observedAt: event.occurredAt,
      rawLocator: "json:$",
      extra: {
        eventType: event.eventType,
        subject: event.subject,
        merchant: event.merchant,
        detail: event.detail,
        amountYen: event.amountYen,
        usedPoints: event.usedPoints,
        balanceYen: event.balanceYen,
        _kogane: {
          canonicalDataset: DATASET,
          derivedFromDataset: "notification-mail",
          direction: declined
            ? "no-posted-cashflow"
            : event.eventType === "usage"
              ? "outflow-notified"
              : "inflow-notified",
          amountDisposition: declined ? "attempted-not-posted" : "notification-amount-not-settled",
          amountSignSource: "eventType",
          settlementDisposition: declined
            ? "declined-by-provider"
            : "not-established-by-notification",
          fundingSplitDisposition: "not-inferred-from-total-and-used-points",
          identityOrigin: "normalized-event-id",
          usedPointsDisposition: "extra-only",
        },
      },
    };
    const observations: Observation[] = [transaction];
    if (event.balanceYen !== null) {
      const balance: BalanceObservation = {
        kind: "balance",
        sourceAccount: BALANCE_SOURCE_ACCOUNT,
        metric: "prepaid_balance_after_event",
        amountMinor: event.balanceYen,
        amountText: String(event.balanceYen),
        amountScale: 0,
        instrument: "JPY",
        asOf: event.occurredAt,
        observedAt: event.occurredAt,
        rawLocator: "json:$.balanceYen",
        extra: {
          eventType: event.eventType,
          balanceYen: event.balanceYen,
          _kogane: {
            canonicalDataset: DATASET,
            derivedFromDataset: "notification-mail",
            balanceScope: "v-point-pay-prepaid-yen",
            sourceEventId: event.id,
          },
        },
      };
      observations.push(balance);
    }
    return { observations, warnings: [] };
  },
};

function parseEvent(bytes: Uint8Array): Event {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("V Point Pay notification-event must be valid JSON", { cause: error });
    throw error;
  }
  if (!isObject(value)) throw new Error("V Point Pay notification-event must be an object");
  const schemaVersion = value["schemaVersion"];
  if (schemaVersion !== SCHEMA_V1 && schemaVersion !== SCHEMA_V2) {
    throw new Error("V Point Pay notification-event schemaVersion is unsupported");
  }
  exactKeys(value, schemaVersion === SCHEMA_V2 ? [...CORE_KEYS, "sourceProvenance"] : CORE_KEYS);
  const id = strictString(value["id"], "id", 64);
  if (!SHA256.test(id)) throw new Error("V Point Pay notification-event id is invalid");
  nullableString(value["sourceMessageId"], "sourceMessageId", 1_000);
  const occurredAt = utcInstant(value["occurredAt"], "occurredAt");
  const eventType = parseEventType(value["eventType"]);
  const subject = strictString(value["subject"], "subject", 500);
  if (classifySubject(subject) !== eventType)
    throw new Error("V Point Pay notification-event subject contradicts eventType");
  const merchant = nullableString(value["merchant"], "merchant", 2_000);
  const detail = nullableString(value["detail"], "detail", 2_000);
  const amountYen = nullableSignedInteger(value["amountYen"], "amountYen");
  const usedPoints = nullableNonNegativeInteger(value["usedPoints"], "usedPoints");
  const balanceYen = nullableNonNegativeInteger(value["balanceYen"], "balanceYen");
  if (schemaVersion === SCHEMA_V2) validateProvenance(value["sourceProvenance"], id);
  return {
    schemaVersion,
    id,
    occurredAt,
    eventType,
    subject,
    merchant,
    detail,
    amountYen,
    usedPoints,
    balanceYen,
  };
}

function validateProvenance(value: unknown, id: string): void {
  if (!isObject(value)) throw new Error("V Point Pay sourceProvenance must be an object");
  exactKeys(value, PROVENANCE_KEYS, "sourceProvenance");
  const envelopeFrom = mailbox(value["envelopeFrom"], "sourceProvenance.envelopeFrom");
  const envelopeTo = mailbox(value["envelopeTo"], "sourceProvenance.envelopeTo");
  const outerHash = strictString(
    value["outerMessageSha256"],
    "sourceProvenance.outerMessageSha256",
    64,
  );
  if (!SHA256.test(outerHash))
    throw new Error("V Point Pay sourceProvenance outer hash is invalid");
  const direct =
    value["delivery"] === "direct" &&
    value["storedMessageScope"] === "smtp-message" &&
    envelopeFrom === EXPECTED_SENDER &&
    outerHash === id;
  const forwarded =
    value["delivery"] === "forwarded-rfc822" &&
    value["storedMessageScope"] === "forwarded-rfc822-part" &&
    outerHash !== id;
  if (
    value["schemaVersion"] !== PROVENANCE_SCHEMA ||
    value["sourceVerification"] !== "source_unverified" ||
    value["authenticationProvenance"] !== "not-exposed-by-cloudflare-email-event" ||
    envelopeTo !== EXPECTED_RECIPIENT ||
    (!direct && !forwarded)
  ) {
    throw new Error("V Point Pay sourceProvenance contradicts the Layer A contract");
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label = "notification-event",
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`V Point Pay ${label} has schema drift`);
  }
}

function strictString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
  ) {
    throw new Error(`V Point Pay notification-event ${label} must be a bounded string`);
  }
  return value;
}

function nullableString(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : strictString(value, label, maximum);
}

function nullableNonNegativeInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 1_000_000_000_000
  ) {
    throw new Error(`V Point Pay notification-event ${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function nullableSignedInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Math.abs(value as number) > 1_000_000_000_000) {
    throw new Error(`V Point Pay notification-event ${label} must be a bounded safe integer`);
  }
  return value as number;
}

function utcInstant(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 35)
    throw new Error(`V Point Pay notification-event ${label} must be a canonical UTC instant`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
    throw new Error(`V Point Pay notification-event ${label} must be a canonical UTC instant`);
  return value;
}

function mailbox(value: unknown, label: string): string {
  const result = strictString(value, label, 320).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/u.test(result)) throw new Error(`V Point Pay ${label} must be a mailbox`);
  return result;
}

function parseEventType(value: unknown): EventType {
  if (
    value === "usage" ||
    value === "charge" ||
    value === "balance-addition" ||
    value === "declined"
  )
    return value;
  throw new Error("V Point Pay notification-event eventType is unsupported");
}

function classifySubject(subject: string): EventType | null {
  if (subject.includes("ご利用のお知らせ")) return "usage";
  if (subject.includes("チャージ受付のお知らせ")) return "charge";
  if (subject.includes("プリペイド残高加算のお知らせ")) return "balance-addition";
  if (
    subject.includes("ご利用不可のお知らせ") ||
    subject.includes("カードがご利用頂けませんでした")
  )
    return "declined";
  return null;
}

import PostalMime, { type Email } from "postal-mime";
import { CentralClient, centralDescriptorSha256 } from "./central";
import type {
  AddUnitReportRequest,
  ArtifactRequest,
  EmailOriginRequest,
  StorageOriginRequest,
} from "../../../packages/evidence-contract/src/index";
import { ImportError } from "./error";
import type { CentralInventoryItem } from "./types";

const SOURCE = "v-point-pay";
const EXTERNAL_SOURCE = "v-point-pay-email";
const PRODUCER = "collector-r2-importer";
const CENTRAL_CLIENT_ID = "collector-r2-v-point-pay-email";
const INGEST_CONTRACT_VERSION = "vpoint-pay-email-r2-v2";
const EVENT_SCHEMA_V1 = "vpoint-pay-email-event-v1";
const EVENT_SCHEMA_V2 = "vpoint-pay-email-event-v2";
const EXTERNAL_ID_NAMESPACE = "vpoint-pay-email-pair-v2";
const SOURCE_PROVENANCE_SCHEMA = "vpoint-pay-email-source-provenance-v1";
const EXPECTED_RECIPIENT = "vpointpay@takuk.me";
const STORAGE_CONTAINER = "kogane-vpoint-pay-collector-poc";
const STORAGE_TEMPLATE = "raw/v-point-pay-email/{date}/{message-sha256}.{extension}";
const FINGERPRINT_VERSION = "collector-r2-v1";
const SENDER = "info@prepaid.smbc-card.com";
const KEY =
  /^raw\/v-point-pay-email\/(20\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/([0-9a-f]{64})\.json$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_EML_BYTES = 2 * 1024 * 1024;

type JsonObject = Record<string, unknown>;
type EventType = "usage" | "charge" | "balance-addition" | "declined";

interface EmailEvent {
  schemaVersion: typeof EVENT_SCHEMA_V1 | typeof EVENT_SCHEMA_V2;
  id: string;
  sourceMessageId: string | null;
  occurredAt: string;
  eventType: EventType;
  subject: string;
  merchant: string | null;
  detail: string | null;
  amountYen: number | null;
  usedPoints: number | null;
  balanceYen: number | null;
  sourceProvenance?: EmailSourceProvenance;
}

interface EmailSourceProvenance {
  schemaVersion: typeof SOURCE_PROVENANCE_SCHEMA;
  delivery: "direct" | "forwarded-rfc822";
  storedMessageScope: "smtp-message" | "forwarded-rfc822-part";
  sourceVerification: "source_unverified";
  envelopeFrom: string;
  envelopeTo: string;
  outerMessageSha256: string;
  authenticationProvenance: "not-exposed-by-cloudflare-email-event";
}

interface VerifiedPair {
  event: EmailEvent;
  rawBytes: Uint8Array;
  normalizedBytes: Uint8Array;
  rawSha256: string;
  normalizedSha256: string;
  rawKey: string;
  normalizedKey: string;
}

export interface ImportVPointPayEmailOptions {
  bucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  importerVersion: string;
  normalizedKey: string;
}

export interface VPointPayEmailImportResult {
  source: typeof EXTERNAL_SOURCE;
  status: "sealed";
  centralRunId: number;
  artifactCount: 2;
  sealed: true;
  allObjectsReused: boolean;
}

export async function auditVPointPayEmailPair(
  bucket: R2Bucket,
  normalizedKey: string,
): Promise<{ eventType: EventType }> {
  const pair = await readVerifiedPair(bucket, normalizedKey);
  return { eventType: pair.event.eventType };
}

export async function validateVPointPayEmailPairForLayerB(
  bucket: R2Bucket,
  normalizedKey: string,
): Promise<{ normalizedBytes: Uint8Array; eventType: EventType; occurredAt: string }> {
  const pair = await readVerifiedPair(bucket, normalizedKey);
  return {
    normalizedBytes: pair.normalizedBytes,
    eventType: pair.event.eventType,
    occurredAt: pair.event.occurredAt,
  };
}

export async function importVPointPayEmailPair(
  options: ImportVPointPayEmailOptions,
): Promise<VPointPayEmailImportResult> {
  const startedAtMs = Date.now();
  const attemptId = `attempt-${crypto.randomUUID()}`;
  const pair = await readVerifiedPair(options.bucket, options.normalizedKey);
  let centralRunId: number | undefined;
  let accepted = 0;
  let reused = 0;
  let phase = "central_create";
  try {
    const central = new CentralClient(
      options.centralService,
      options.centralToken,
      CENTRAL_CLIENT_ID,
    );
    centralRunId = await central.createRun({
      producerId: PRODUCER,
      sourceId: SOURCE,
      externalIdNamespace: EXTERNAL_ID_NAMESPACE,
      externalSessionId: pair.event.id,
      sourceRunKey: `email-pair-${INGEST_CONTRACT_VERSION}`,
    });
    phase = "unit";
    const unitId = await central.addUnit(centralRunId, {
      unitKind: "message",
      unitKey: "notification",
      terminalReportRequired: true,
    });
    const inventory: CentralInventoryItem[] = [];
    const rawDescriptor = await providerDescriptor(pair, unitId, options.fingerprintKey);
    const rawDescriptorSha256 = await centralDescriptorSha256(rawDescriptor);
    phase = "raw_upload";
    if (await central.uploadObject(centralRunId, pair.rawSha256, pair.rawBytes)) reused += 1;
    else accepted += 1;
    phase = "raw_catalogue";
    const acceptedRawDescriptorSha256 = await central.addArtifact(centralRunId, rawDescriptor);
    if (acceptedRawDescriptorSha256 !== rawDescriptorSha256) {
      throw new Error("central_descriptor_mismatch");
    }
    inventory.push({
      artifactKey: "notification.eml",
      sha256: pair.rawSha256,
      descriptorSha256: rawDescriptorSha256,
    });
    const normalizedDescriptor = await eventDescriptor(
      pair,
      centralRunId,
      unitId,
      options.fingerprintKey,
    );
    const normalizedDescriptorSha256 = await centralDescriptorSha256(normalizedDescriptor);
    phase = "normalized_upload";
    if (await central.uploadObject(centralRunId, pair.normalizedSha256, pair.normalizedBytes))
      reused += 1;
    else accepted += 1;
    phase = "normalized_catalogue";
    const acceptedNormalizedDescriptorSha256 = await central.addArtifact(
      centralRunId,
      normalizedDescriptor,
    );
    if (acceptedNormalizedDescriptorSha256 !== normalizedDescriptorSha256) {
      throw new Error("central_descriptor_mismatch");
    }
    inventory.push({
      artifactKey: "normalized-event.json",
      sha256: pair.normalizedSha256,
      descriptorSha256: normalizedDescriptorSha256,
    });
    const eventAtMs = Date.parse(pair.event.occurredAt);
    const terminal = {
      reportKey: "terminal",
      reportKind: "terminal",
      producerStatus: "success",
      normalizedOutcome: "success",
      startedAtMs: eventAtMs,
      startedAtBasis: "source",
      completedAtMs: eventAtMs,
      completedAtBasis: "source",
      declaredArtifactCount: 2,
    } satisfies Omit<AddUnitReportRequest, "artifactCountScope">;
    phase = "unit_report";
    await central.addUnitReport(unitId, { ...terminal, artifactCountScope: "direct" });
    phase = "run_report";
    await central.addRunReport(centralRunId, {
      ...terminal,
      producerVersion: INGEST_CONTRACT_VERSION,
      manifestSchemaVersion: pair.event.schemaVersion,
      artifactCountScope: "all_catalogued",
    });
    phase = "seal";
    await central.seal(centralRunId, inventory, attemptId, startedAtMs, "email_batch");
    return {
      source: EXTERNAL_SOURCE,
      status: "sealed",
      centralRunId,
      artifactCount: 2,
      sealed: true,
      allObjectsReused: reused === 2,
    };
  } catch (error) {
    if (centralRunId !== undefined) {
      try {
        const central = new CentralClient(
          options.centralService,
          options.centralToken,
          CENTRAL_CLIENT_ID,
        );
        await central.recordAttempt(centralRunId, {
          externalAttemptId: attemptId,
          outcome: accepted + reused > 0 ? "incomplete" : "failed",
          startedAtMs,
          completedAtMs: Date.now(),
          expectedArtifactCount: 2,
          observedArtifactCount: accepted + reused,
          acceptedArtifactCount: accepted,
          reusedArtifactCount: reused,
          rejectedArtifactCount: Math.max(2 - accepted - reused, 0),
          errorCode: `${phase}_failed`,
          ingestClientVersion: options.importerVersion,
        });
      } catch {
        // Preserve the original failure; attempt recording is best effort.
      }
    }
    throw error;
  }
}

async function readVerifiedPair(bucket: R2Bucket, normalizedKey: string): Promise<VerifiedPair> {
  const match = KEY.exec(normalizedKey);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
    throw new ImportError(400, "vpoint_pay_email_key_invalid");
  }
  const id = match[4];
  const prefix = normalizedKey.slice(0, -".json".length);
  const rawKey = `${prefix}.eml`;
  const expected = [rawKey, normalizedKey].sort();
  await assertExactPairInventory(bucket, prefix, expected);
  const [rawObject, normalizedObject] = await Promise.all([
    bucket.get(rawKey),
    bucket.get(normalizedKey),
  ]);
  if (!rawObject || !normalizedObject) throw new ImportError(409, "vpoint_pay_email_pair_missing");
  if (
    rawObject.size < 1 ||
    rawObject.size > MAX_EML_BYTES ||
    normalizedObject.size < 1 ||
    normalizedObject.size > MAX_JSON_BYTES
  ) {
    throw new ImportError(409, "vpoint_pay_email_size_invalid");
  }
  if (
    rawObject.httpMetadata?.contentType !== "message/rfc822" ||
    normalizedObject.httpMetadata?.contentType !== "application/json"
  ) {
    throw new ImportError(409, "vpoint_pay_email_content_type_invalid");
  }
  const [rawBytes, normalizedBytes] = await Promise.all([
    rawObject.arrayBuffer().then((value) => new Uint8Array(value)),
    normalizedObject.arrayBuffer().then((value) => new Uint8Array(value)),
  ]);
  const [rawSha256, normalizedSha256] = await Promise.all([
    sha256Hex(rawBytes),
    sha256Hex(normalizedBytes),
  ]);
  if (rawSha256 !== id) throw new ImportError(409, "vpoint_pay_email_raw_hash_mismatch");
  assertNativeSha256WhenPresent(rawObject, rawSha256);
  assertNativeSha256WhenPresent(normalizedObject, normalizedSha256);
  const event = parseEvent(normalizedBytes);
  if (event.id !== id || event.occurredAt.slice(0, 10) !== `${match[1]}-${match[2]}-${match[3]}`) {
    throw new ImportError(409, "vpoint_pay_email_identity_mismatch");
  }
  const metadata =
    event.schemaVersion === EVENT_SCHEMA_V1
      ? { source: EXTERNAL_SOURCE, eventType: event.eventType, sha256: id }
      : {
          source: EXTERNAL_SOURCE,
          eventType: event.eventType,
          sha256: id,
          eventSchema: EVENT_SCHEMA_V2,
          delivery: event.sourceProvenance!.delivery,
          sourceVerification: "source_unverified",
        };
  assertExactMetadata(rawObject.customMetadata, metadata);
  assertExactMetadata(normalizedObject.customMetadata, metadata);
  const derived = await deriveEvent(rawBytes);
  if (canonicalJson(derived) !== canonicalJson(eventCore(event))) {
    throw new ImportError(409, "vpoint_pay_email_derivation_mismatch");
  }
  await assertExactPairInventory(bucket, prefix, expected);
  return { event, rawBytes, normalizedBytes, rawSha256, normalizedSha256, rawKey, normalizedKey };
}

async function assertExactPairInventory(
  bucket: R2Bucket,
  prefix: string,
  expected: string[],
): Promise<void> {
  const listed = await bucket.list({ prefix, limit: 3 });
  const actual = listed.objects.map((object) => object.key).sort();
  if (
    listed.truncated ||
    actual.length !== 2 ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ImportError(409, "vpoint_pay_email_pair_inventory_mismatch");
  }
}

function parseEvent(bytes: Uint8Array): EmailEvent {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ImportError(409, "vpoint_pay_email_json_invalid");
  }
  if (!isRecord(value)) throw new ImportError(409, "vpoint_pay_email_json_invalid");
  const coreKeys = [
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
  ];
  const keys =
    value.schemaVersion === EVENT_SCHEMA_V2
      ? [...coreKeys, "sourceProvenance"].sort()
      : coreKeys.sort();
  if (
    !sameStrings(Object.keys(value).sort(), keys) ||
    (value.schemaVersion !== EVENT_SCHEMA_V1 && value.schemaVersion !== EVENT_SCHEMA_V2) ||
    typeof value.id !== "string" ||
    !SHA256.test(value.id) ||
    !isNullableText(value.sourceMessageId, 1_000) ||
    !canonicalInstant(value.occurredAt) ||
    !isEventType(value.eventType) ||
    !safeText(value.subject, 500) ||
    !isNullableText(value.merchant, 2_000) ||
    !isNullableText(value.detail, 2_000) ||
    !nullableAmount(value.amountYen) ||
    !nullableAmount(value.usedPoints) ||
    !nullableAmount(value.balanceYen)
  ) {
    throw new ImportError(409, "vpoint_pay_email_event_invalid");
  }
  const sourceProvenance =
    value.schemaVersion === EVENT_SCHEMA_V2
      ? parseSourceProvenance(value.sourceProvenance, value.id)
      : undefined;
  return {
    schemaVersion: value.schemaVersion,
    id: value.id,
    sourceMessageId: value.sourceMessageId,
    occurredAt: value.occurredAt,
    eventType: value.eventType,
    subject: value.subject,
    merchant: value.merchant,
    detail: value.detail,
    amountYen: value.amountYen,
    usedPoints: value.usedPoints,
    balanceYen: value.balanceYen,
    ...(sourceProvenance ? { sourceProvenance } : {}),
  };
}

function parseSourceProvenance(value: unknown, messageSha256: string): EmailSourceProvenance {
  if (!isRecord(value)) throw new ImportError(409, "vpoint_pay_email_provenance_invalid");
  const keys = [
    "authenticationProvenance",
    "delivery",
    "envelopeFrom",
    "envelopeTo",
    "outerMessageSha256",
    "schemaVersion",
    "sourceVerification",
    "storedMessageScope",
  ].sort();
  const envelopeFrom = canonicalMailbox(value.envelopeFrom);
  const envelopeTo = canonicalMailbox(value.envelopeTo);
  const delivery = value.delivery;
  const direct =
    delivery === "direct" &&
    value.storedMessageScope === "smtp-message" &&
    envelopeFrom === SENDER &&
    value.outerMessageSha256 === messageSha256;
  const forwarded =
    delivery === "forwarded-rfc822" &&
    value.storedMessageScope === "forwarded-rfc822-part" &&
    envelopeFrom !== null &&
    typeof value.outerMessageSha256 === "string" &&
    SHA256.test(value.outerMessageSha256) &&
    value.outerMessageSha256 !== messageSha256;
  if (
    !sameStrings(Object.keys(value).sort(), keys) ||
    value.schemaVersion !== SOURCE_PROVENANCE_SCHEMA ||
    value.sourceVerification !== "source_unverified" ||
    value.authenticationProvenance !== "not-exposed-by-cloudflare-email-event" ||
    envelopeTo !== EXPECTED_RECIPIENT ||
    (!direct && !forwarded)
  ) {
    throw new ImportError(409, "vpoint_pay_email_provenance_invalid");
  }
  return {
    schemaVersion: SOURCE_PROVENANCE_SCHEMA,
    delivery,
    storedMessageScope: value.storedMessageScope,
    sourceVerification: "source_unverified",
    envelopeFrom: envelopeFrom!,
    envelopeTo,
    outerMessageSha256: value.outerMessageSha256,
    authenticationProvenance: "not-exposed-by-cloudflare-email-event",
  } as EmailSourceProvenance;
}

async function deriveEvent(raw: Uint8Array): Promise<EmailEvent> {
  let email: Email;
  try {
    email = await PostalMime.parse(raw);
  } catch {
    throw new ImportError(409, "vpoint_pay_email_mime_invalid");
  }
  const address = email.from && "address" in email.from ? email.from.address : undefined;
  if (address?.trim().toLowerCase() !== SENDER || !email.text || !email.date) {
    throw new ImportError(409, "vpoint_pay_email_sender_invalid");
  }
  const subject = email.subject?.trim() ?? "";
  const eventType = classifySubject(subject);
  const occurredAt = new Date(email.date);
  if (!eventType || !Number.isFinite(occurredAt.getTime())) {
    throw new ImportError(409, "vpoint_pay_email_message_invalid");
  }
  const text = normalizeText(email.text);
  const amountLabel =
    eventType === "usage"
      ? "利用金額"
      : eventType === "charge"
        ? "チャージ金額"
        : eventType === "balance-addition"
          ? "加算額"
          : "利用金額";
  const balanceLabel =
    eventType === "charge"
      ? "チャージ後の残高"
      : eventType === "balance-addition"
        ? "加算後のプリペイド残高"
        : "利用後の残高";
  return {
    schemaVersion: EVENT_SCHEMA_V1,
    id: await sha256Hex(raw),
    sourceMessageId: email.messageId ?? null,
    occurredAt: occurredAt.toISOString(),
    eventType,
    subject,
    merchant: field(text, "利用先"),
    detail: field(text, eventType === "balance-addition" ? "加算方法" : "取引内容"),
    amountYen: yenField(text, amountLabel),
    usedPoints: pointsField(text, "内、利用Vポイント数"),
    balanceYen: yenField(text, balanceLabel),
  };
}

function eventCore(event: EmailEvent): EmailEvent {
  return {
    schemaVersion: EVENT_SCHEMA_V1,
    id: event.id,
    sourceMessageId: event.sourceMessageId,
    occurredAt: event.occurredAt,
    eventType: event.eventType,
    subject: event.subject,
    merchant: event.merchant,
    detail: event.detail,
    amountYen: event.amountYen,
    usedPoints: event.usedPoints,
    balanceYen: event.balanceYen,
  };
}

async function providerDescriptor(
  pair: VerifiedPair,
  unitId: number,
  key: string,
): Promise<ArtifactRequest> {
  return {
    artifactKey: "notification.eml",
    artifactRole: "user_capture",
    payloadFidelity: "unknown",
    containerKind: "single",
    lineageDisposition: "not_applicable",
    dataset: "notification-mail",
    formatId: "internet-message-format",
    formatVersion: "rfc822",
    declaredMediaType: "message/rfc822",
    mediaTypeBasis: "file_metadata",
    fetchedAtMs: Date.parse(pair.event.occurredAt),
    fetchedAtBasis: "source",
    fetchUnitId: unitId,
    pageGroupId: null,
    pageIndex: null,
    sequence: 0,
    sha256: pair.rawSha256,
    byteSize: pair.rawBytes.byteLength,
    http: null,
    storage: await storageOrigin(pair.rawKey, key),
    file: null,
    email: await emailOrigin(pair.event, pair.rawSha256),
    ranges: [],
    transformSteps: [],
    relations: [],
  };
}

async function eventDescriptor(
  pair: VerifiedPair,
  runId: number,
  unitId: number,
  key: string,
): Promise<ArtifactRequest> {
  return {
    artifactKey: "normalized-event.json",
    artifactRole: "collector_derived",
    payloadFidelity: "transformed",
    containerKind: "single",
    lineageDisposition: "linked",
    dataset: "notification-event",
    formatId: "vpoint-pay-email-event-json",
    formatVersion: pair.event.schemaVersion,
    declaredMediaType: "application/json",
    mediaTypeBasis: "file_metadata",
    fetchedAtMs: Date.parse(pair.event.occurredAt),
    fetchedAtBasis: "source",
    fetchUnitId: unitId,
    pageGroupId: null,
    pageIndex: null,
    sequence: 1,
    sha256: pair.normalizedSha256,
    byteSize: pair.normalizedBytes.byteLength,
    http: null,
    storage: await storageOrigin(pair.normalizedKey, key),
    file: null,
    email: null,
    ranges: [],
    transformSteps: [
      {
        stepIndex: 0,
        stepKind: "extracted",
        transformerId: "vpoint-pay-email-parser",
        transformerVersion: pair.event.schemaVersion,
      },
    ],
    relations: [
      {
        parentRunId: runId,
        parentArtifactKey: "notification.eml",
        relation: "input",
        transformerId: "vpoint-pay-email-parser",
        transformerVersion: pair.event.schemaVersion,
      },
    ],
  };
}

async function emailOrigin(event: EmailEvent, rawSha256: string): Promise<EmailOriginRequest> {
  const provenance = event.sourceProvenance;
  const envelopeDomain = provenance ? provenance.envelopeFrom.split("@")[1]! : null;
  return {
    transportShape:
      provenance?.delivery === "direct" ? "direct" : provenance ? "forwarded_rfc822" : "unknown",
    senderDomain: provenance ? envelopeDomain : null,
    receivedAtMs: Date.parse(event.occurredAt),
    receivedAtBasis: "rfc_date",
    messageIdSha256: event.sourceMessageId === null ? null : await sha256Hex(event.sourceMessageId),
    partIndex: null,
    mimePartPath: null,
    innerMessageSha256: provenance?.delivery === "forwarded-rfc822" ? rawSha256 : null,
    innerSenderDomain: provenance?.delivery === "forwarded-rfc822" ? "prepaid.smbc-card.com" : null,
    filenameTemplate: null,
    filenameFingerprint: null,
    fingerprintKeyVersion: null,
    redactionVersion: "v1",
  };
}

function canonicalMailbox(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const canonical = value.trim().toLowerCase();
  return canonical.length > 0 && canonical.length <= 320 && /^[^\s@]+@[^\s@]+$/u.test(canonical)
    ? canonical
    : null;
}

async function storageOrigin(
  objectKey: string,
  fingerprintKey: string,
): Promise<StorageOriginRequest> {
  if (!SHA256.test(fingerprintKey)) throw new ImportError(500, "fingerprint_configuration_invalid");
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    owned(hexBytes(fingerprintKey)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(objectKey),
  );
  return {
    storageKind: "r2",
    containerName: STORAGE_CONTAINER,
    objectKeyTemplate: STORAGE_TEMPLATE,
    objectKeyFingerprint: bytesHex(new Uint8Array(signature)),
    fingerprintKeyVersion: FINGERPRINT_VERSION,
    redactionVersion: "v1",
    objectVersion: null,
    etag: null,
    lastModifiedAtMs: null,
    lastModifiedAtBasis: null,
  };
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

function normalizeText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("：", ":")
    .replaceAll("Ｖ", "V")
    .replaceAll("　", " ");
}

function field(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = text.match(new RegExp(`(?:◇\\s*)?${escaped}\\s*:\\s*([^\\n]+)`, "u"))?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

function yenField(text: string, label: string): number | null {
  const value = field(text, label)?.match(/(-?[0-9,]+)\s*円/u)?.[1];
  return value ? Number(value.replaceAll(",", "")) : null;
}

function pointsField(text: string, label: string): number | null {
  const value = field(text, label)?.match(/(-?[0-9,]+)\s*ポイント/u)?.[1];
  return value ? Number(value.replaceAll(",", "")) : null;
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 35) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function safeText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
  );
}

function isNullableText(value: unknown, max: number): value is string | null {
  return value === null || safeText(value, max);
}

function nullableAmount(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      Math.abs(value) <= 1_000_000_000_000)
  );
}

function isEventType(value: unknown): value is EventType {
  return (
    value === "usage" || value === "charge" || value === "balance-addition" || value === "declined"
  );
}

function assertExactMetadata(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
): void {
  if (
    !actual ||
    !sameStrings(Object.keys(actual).sort(), Object.keys(expected).sort()) ||
    Object.keys(expected).some((key) => actual[key] !== expected[key])
  ) {
    throw new ImportError(409, "vpoint_pay_email_metadata_invalid");
  }
}

function assertNativeSha256WhenPresent(object: R2ObjectBody, expected: string): void {
  const native = object.checksums.sha256;
  if (native && bytesHex(new Uint8Array(native)) !== expected) {
    throw new ImportError(409, "vpoint_pay_email_native_checksum_mismatch");
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const value = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return bytesHex(new Uint8Array(await crypto.subtle.digest("SHA-256", owned(value))));
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
}

function bytesHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function owned(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

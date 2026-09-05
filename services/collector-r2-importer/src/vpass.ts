import { CentralClient } from "./central";
import { ImportError } from "./error";
import type { CentralInventoryItem } from "./types";

const SOURCE = "vpass" as const;
const PRODUCER = "collector-r2-importer";
const INGEST_CONTRACT_VERSION = "vpass-r2-v1";
const CENTRAL_CLIENT_ID = "collector-r2-vpass";
const STORAGE_CONTAINER = "kogane-vpass-collector-poc";
const STORAGE_TEMPLATE = "vpass/{date}/{run-id}/{artifact}";
const FINGERPRINT_VERSION = "collector-r2-v1";
const SOURCE_CONTENT_TYPE = "application/json; charset=utf-8";
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACTS = 512;
const MAX_PREFIX_OBJECTS = MAX_ARTIFACTS + 1;
export const VPASS_TRANSFER_CHUNK_SIZE = 5;
const TRANSFER_TOKEN_PREFIX = "vpass-transfer-v1";
const SHA256 = /^[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MONTH = /^\d{6}$/u;
const PAGE_GROUP_KEY = /^(?:\d{6}|card-\d{3}-\d{6})$/u;
const RUN_ID = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u;
const RECORD_KEY =
  /^vpass\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(?:\/(card-(\d{3})))?\/(manifest|error)\.json$/u;

type JsonObject = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Outcome = "success" | "failed";

interface MonthSummary {
  pages: number;
  transactions: number;
}

interface SourceRecord {
  kind: "manifest" | "error";
  key: string;
  prefix: string;
  runId: string;
  cardLabel: string;
  startedAt: string;
  completedAt: string;
  status: Outcome;
  schemaVersion: "vpass-worker-card-v1" | "vpass-worker-single-card-v1" | "vpass-worker-error-v1";
  sourceArtifactCount: number;
}

interface VerifiedArtifact {
  artifactKey: string;
  dataset: string;
  sourceKey: string;
  bytes: Uint8Array;
  sha256: string;
  pageGroupKey?: string;
  pageIndex?: number;
}

interface LoadedRun {
  record: SourceRecord;
  artifacts: VerifiedArtifact[];
  pageGroups: Array<{ key: string; count: number }>;
}

interface PageGroupReference {
  key: string;
  id: number;
}

interface TransferState {
  v: 1;
  recordKey: string;
  centralRunId: number;
  unitId: number;
  pageGroups: PageGroupReference[];
  inventoryId: number;
  inventorySha256: string;
  offset: number;
}

interface ArtifactPlan {
  artifact: VerifiedArtifact;
  descriptor: JsonObject;
  inventory: CentralInventoryItem;
}

export type VpassImportResult = VpassImportDeferred | VpassImportSealed;

export interface VpassImportDeferred {
  source: typeof SOURCE;
  recordKey: string;
  status: "deferred";
  reason: "worker_invocation_limit";
  artifactCount: number;
  nextOffset: number;
  continuation: string;
}

export interface VpassImportSealed {
  source: typeof SOURCE;
  recordKey: string;
  status: "sealed";
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  finalChunkAllObjectsReused: boolean;
}

export async function importVpassRun(options: {
  bucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  importerVersion: string;
  recordKey: string;
  continuation?: string;
}): Promise<VpassImportResult> {
  const startedAtMs = Date.now();
  const attemptId = `attempt-${crypto.randomUUID()}`;
  let centralRunId: number | undefined;
  let acceptedArtifactCount = 0;
  let reusedArtifactCount = 0;
  let expectedArtifactCount = 0;
  let phase = "source_validation";
  try {
    const validated = await validateVpassRun(options.bucket, options.recordKey);
    expectedArtifactCount = validated.artifacts.length;
    if (expectedArtifactCount < 1 || expectedArtifactCount > MAX_ARTIFACTS) {
      throw new ImportError(409, "central_inventory_limit");
    }
    const central = new CentralClient(
      options.centralService,
      options.centralToken,
      CENTRAL_CLIENT_ID,
    );
    let state: TransferState;
    let initialized = false;
    if (options.continuation) {
      state = await decodeTransferState(options.continuation, options.fingerprintKey);
      validateTransferState(state, validated, options.recordKey);
      centralRunId = state.centralRunId;
    } else {
      initialized = true;
      phase = "central_create";
      centralRunId = await central.createRun({
        producerId: PRODUCER,
        sourceId: SOURCE,
        externalIdNamespace: validated.record.schemaVersion,
        externalSessionId: validated.record.runId,
        sourceRunKey: `${validated.record.cardLabel}-${INGEST_CONTRACT_VERSION}`,
      });
      phase = "unit_catalogue";
      const unitId = await central.addUnit(centralRunId, {
        unitKind: "card",
        unitKey: validated.record.cardLabel,
        terminalReportRequired: true,
      });
      phase = "page_group_catalogue";
      const pageGroups: PageGroupReference[] = [];
      for (const group of validated.pageGroups) {
        pageGroups.push({
          key: group.key,
          id: await central.addPageGroup(centralRunId, {
            pageGroupKey: `statement-${group.key}`,
            declaredPageCount: group.count,
          }),
        });
      }
      phase = "inventory_plan";
      const initialPlans = await artifactPlans(
        validated,
        centralRunId,
        unitId,
        pageGroups,
        options.fingerprintKey,
      );
      const inventory = sortedInventory(initialPlans);
      const inventorySha256 = await sha256Hex(
        new TextEncoder().encode(canonicalJson(inventory as unknown as JsonValue)),
      );
      state = {
        v: 1,
        recordKey: options.recordKey,
        centralRunId,
        unitId,
        pageGroups,
        inventoryId: await central.beginInventory(centralRunId, inventorySha256, inventory.length),
        inventorySha256,
        offset: 0,
      };
    }

    phase = "inventory_plan";
    const plans = await artifactPlans(
      validated,
      state.centralRunId,
      state.unitId,
      state.pageGroups,
      options.fingerprintKey,
    );
    const inventorySha256 = await sha256Hex(
      new TextEncoder().encode(canonicalJson(sortedInventory(plans) as unknown as JsonValue)),
    );
    if (inventorySha256 !== state.inventorySha256) {
      throw new ImportError(409, "transfer_inventory_mismatch");
    }
    const end = Math.min(state.offset + VPASS_TRANSFER_CHUNK_SIZE, plans.length);
    const chunkInventory: CentralInventoryItem[] = [];
    for (const plan of plans.slice(state.offset, end)) {
      phase = "object_upload";
      const reused = await central.uploadObject(
        state.centralRunId,
        plan.artifact.sha256,
        plan.artifact.bytes,
      );
      if (reused) reusedArtifactCount += 1;
      else acceptedArtifactCount += 1;
      phase = "artifact_catalogue";
      const descriptorSha256 = await central.addArtifact(state.centralRunId, plan.descriptor);
      if (descriptorSha256 !== plan.inventory.descriptorSha256) {
        throw new Error("central_descriptor_mismatch");
      }
      chunkInventory.push(plan.inventory);
    }
    if (chunkInventory.length > 0) {
      phase = "inventory_catalogue";
      await central.addInventoryItems(state.centralRunId, state.inventoryId, chunkInventory);
    }
    if (end < plans.length || initialized) {
      return {
        source: SOURCE,
        recordKey: options.recordKey,
        status: "deferred",
        reason: "worker_invocation_limit",
        artifactCount: plans.length,
        nextOffset: end,
        continuation: await encodeTransferState({ ...state, offset: end }, options.fingerprintKey),
      };
    }

    phase = "terminal_reports";
    const report = {
      reportKey: "terminal",
      reportKind: "terminal",
      producerStatus: validated.record.status,
      normalizedOutcome: validated.record.status,
      startedAtMs: Date.parse(validated.record.startedAt),
      startedAtBasis: "manifest",
      completedAtMs: Date.parse(validated.record.completedAt),
      completedAtBasis: "manifest",
      declaredArtifactCount: plans.length,
      artifactCountScope: "direct",
      ...(validated.record.status === "failed" ? { safeFailureCode: "collector-failed" } : {}),
    };
    await central.addUnitReport(state.unitId, report);
    await central.addRunReport(state.centralRunId, {
      ...report,
      producerVersion: INGEST_CONTRACT_VERSION,
      manifestSchemaVersion: validated.record.schemaVersion,
      artifactCountScope: "all_catalogued",
    });
    phase = "seal";
    await central.sealStagedInventory(
      state.centralRunId,
      state.inventoryId,
      attemptId,
      startedAtMs,
    );
    return {
      source: SOURCE,
      recordKey: options.recordKey,
      status: "sealed",
      centralRunId: state.centralRunId,
      artifactCount: plans.length,
      sealed: true,
      finalChunkAllObjectsReused: acceptedArtifactCount === 0,
    };
  } catch (error) {
    if (centralRunId !== undefined) {
      try {
        const central = new CentralClient(
          options.centralService,
          options.centralToken,
          CENTRAL_CLIENT_ID,
        );
        const transferred = acceptedArtifactCount + reusedArtifactCount;
        await central.recordAttempt(centralRunId, {
          externalAttemptId: attemptId,
          outcome: transferred > 0 ? "incomplete" : "failed",
          startedAtMs,
          completedAtMs: Date.now(),
          expectedArtifactCount,
          observedArtifactCount: transferred,
          acceptedArtifactCount,
          reusedArtifactCount,
          rejectedArtifactCount: Math.max(expectedArtifactCount - transferred, 0),
          errorCode: `${phase}_failed`,
          ingestClientVersion: options.importerVersion,
        });
      } catch {
        // Best effort only; preserve the original strict import failure.
      }
    }
    throw error;
  }
}

export async function validateVpassRun(bucket: R2Bucket, recordKey: string): Promise<LoadedRun> {
  const path = parseRecordKey(recordKey);
  const recordObject = await readSourceObject(bucket, recordKey, MAX_RECORD_BYTES);
  const recordJson = parseJsonBytes(recordObject.bytes, "record_json_invalid");
  const prefixKeys = await exactPrefixKeys(bucket, path.prefix);
  let loaded: LoadedRun;
  if (path.kind === "error") {
    loaded = await loadErrorRecord(bucket, recordJson, recordKey, path, prefixKeys);
  } else if (path.cardLabel) {
    loaded = await loadCardSnapshotManifest(bucket, recordJson, recordKey, path, prefixKeys);
  } else {
    loaded = await loadDiscreteManifest(bucket, recordJson, recordKey, path, prefixKeys);
  }
  const after = await exactPrefixKeys(bucket, path.prefix);
  if (!sameStrings(prefixKeys, after)) throw new ImportError(409, "prefix_inventory_changed");
  return loaded;
}

interface RecordPath {
  year: string;
  month: string;
  day: string;
  runId: string;
  cardLabel?: string;
  cardIndex?: number;
  kind: "manifest" | "error";
  prefix: string;
}

function parseRecordKey(key: string): RecordPath {
  const match = RECORD_KEY.exec(key);
  if (!match) throw new ImportError(400, "record_key_invalid");
  const [, year, month, day, runId, cardLabel, cardDigits, kind] = match;
  const date = `${year}-${month}-${day}`;
  const runStartedAt = runIdToIso(runId!);
  if (!isIso(runStartedAt) || runStartedAt.slice(0, 10) !== date) {
    throw new ImportError(400, "record_key_invalid");
  }
  const cardIndex = cardDigits === undefined ? undefined : Number(cardDigits);
  if (cardIndex !== undefined && (!Number.isSafeInteger(cardIndex) || cardIndex < 1)) {
    throw new ImportError(400, "record_key_invalid");
  }
  return {
    year: year!,
    month: month!,
    day: day!,
    runId: runId!,
    ...(cardLabel === undefined ? {} : { cardLabel }),
    ...(cardIndex === undefined ? {} : { cardIndex }),
    kind: kind as "manifest" | "error",
    prefix: key.slice(0, -(kind!.length + ".json".length)),
  };
}

async function loadErrorRecord(
  bucket: R2Bucket,
  value: JsonObject,
  recordKey: string,
  path: RecordPath,
  prefixKeys: string[],
): Promise<LoadedRun> {
  exactObjectKeys(
    value,
    path.cardLabel
      ? ["runId", "startedAt", "failedAt", "status", "message", "selectedCardIndex", "objectCount"]
      : ["runId", "startedAt", "failedAt", "status", "message", "objectCount"],
    "error_schema_invalid",
  );
  const startedAt = requiredIso(value.startedAt, "error_started_at_invalid");
  const failedAt = requiredIso(value.failedAt, "error_failed_at_invalid");
  const expectedObjectCount = !path.cardLabel && prefixKeys.length > 1 ? prefixKeys.length - 2 : 1;
  if (
    value.runId !== path.runId ||
    startedAt !== runIdToIso(path.runId) ||
    Date.parse(failedAt) < Date.parse(startedAt) ||
    value.status !== "error" ||
    value.objectCount !== expectedObjectCount ||
    (path.cardIndex !== undefined && value.selectedCardIndex !== path.cardIndex)
  ) {
    throw new ImportError(409, "error_semantics_invalid");
  }
  if (!path.cardLabel && prefixKeys.length > 1) {
    return loadLegacyPartialError(bucket, value, recordKey, path, prefixKeys, startedAt, failedAt);
  }
  if (!sameStrings(prefixKeys, [recordKey]))
    throw new ImportError(409, "prefix_inventory_mismatch");
  const safeDetails = parseSafeError(value.message);
  const centralValue = {
    schemaVersion: "vpass-worker-error-v1",
    source: SOURCE,
    runId: path.runId,
    card: path.cardLabel ?? "run",
    startedAt,
    completedAt: failedAt,
    status: "failed",
    failure: safeDetails,
  } satisfies JsonValue;
  const bytes = encodeCanonical(centralValue);
  return {
    record: {
      kind: "error",
      key: recordKey,
      prefix: path.prefix,
      runId: path.runId,
      cardLabel: path.cardLabel ?? "run",
      startedAt,
      completedAt: failedAt,
      status: "failed",
      schemaVersion: "vpass-worker-error-v1",
      sourceArtifactCount: 1,
    },
    artifacts: [
      {
        artifactKey: "error.json",
        dataset: "collector-error",
        sourceKey: recordKey,
        bytes,
        sha256: await sha256Hex(bytes),
      },
    ],
    pageGroups: [],
  };
}

async function loadLegacyPartialError(
  bucket: R2Bucket,
  value: JsonObject,
  recordKey: string,
  path: RecordPath,
  prefixKeys: string[],
  startedAt: string,
  failedAt: string,
): Promise<LoadedRun> {
  if (
    typeof value.message !== "string" ||
    value.message.length < 1 ||
    value.message.length > 2_000 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value.message)
  ) {
    throw new ImportError(409, "error_message_invalid");
  }
  const cardListKey = `${path.prefix}session/card-list.json`;
  if (!prefixKeys.includes(cardListKey)) throw new ImportError(409, "legacy_card_list_missing");
  const cardListObject = await readSourceObject(bucket, cardListKey, MAX_SOURCE_OBJECT_BYTES);
  const cardList = parseEnvelopeBytes(cardListObject.bytes, "card_list_json_invalid");
  const cards = cardListEntries(cardList);
  const cardObject = new RegExp(
    `^${escapeRegex(path.prefix)}cards/(card-(\\d{3}))/(select-card|web-meisai-top)\\.json$`,
    "u",
  );
  const pageObject = new RegExp(
    `^${escapeRegex(path.prefix)}cards/(card-(\\d{3}))/months/(\\d{6})/(top|answer)-(\\d{3})\\.json$`,
    "u",
  );
  interface LegacyCard {
    label: string;
    index: number;
    selectKey?: string;
    discoveryKey?: string;
    pages: Map<string, Array<{ key: string; kind: "top" | "answer"; index: number }>>;
  }
  const groups = new Map<number, LegacyCard>();
  for (const key of prefixKeys) {
    if (key === recordKey || key === cardListKey) continue;
    const direct = cardObject.exec(key);
    const page = pageObject.exec(key);
    if (!direct && !page) throw new ImportError(409, "prefix_inventory_mismatch");
    const match = direct ?? page!;
    const index = Number(match[2]);
    const label = match[1]!;
    if (
      !Number.isSafeInteger(index) ||
      index < 1 ||
      label !== `card-${String(index).padStart(3, "0")}`
    ) {
      throw new ImportError(409, "legacy_card_inventory_invalid");
    }
    const group: LegacyCard = groups.get(index) ?? {
      label,
      index,
      pages: new Map<string, Array<{ key: string; kind: "top" | "answer"; index: number }>>(),
    };
    if (direct) {
      if (direct[3] === "select-card") {
        if (group.selectKey) throw new ImportError(409, "legacy_card_inventory_invalid");
        group.selectKey = key;
      } else {
        if (group.discoveryKey) throw new ImportError(409, "legacy_card_inventory_invalid");
        group.discoveryKey = key;
      }
    } else {
      const month = page![3]!;
      const pages = group.pages.get(month) ?? [];
      pages.push({ key, kind: page![4] as "top" | "answer", index: Number(page![5]) });
      group.pages.set(month, pages);
    }
    groups.set(index, group);
  }
  const ordered = [...groups.values()].sort((left, right) => left.index - right.index);
  if (
    ordered.length < 1 ||
    ordered.length > cards.length ||
    ordered.some(
      (group, index) => group.index !== index + 1 || !group.selectKey || !group.discoveryKey,
    )
  ) {
    throw new ImportError(409, "legacy_card_inventory_invalid");
  }

  const artifacts: VerifiedArtifact[] = [];
  await addSanitizedEnvelope(
    artifacts,
    "session/card-list.json",
    "card-list",
    cardListKey,
    cardList,
    true,
  );
  const pageGroups: Array<{ key: string; count: number }> = [];
  for (const [cardOffset, group] of ordered.entries()) {
    const selectionObject = await readSourceObject(
      bucket,
      group.selectKey!,
      MAX_SOURCE_OBJECT_BYTES,
    );
    const selection = parseEnvelopeBytes(selectionObject.bytes, "card_selection_json_invalid");
    await addSanitizedEnvelope(
      artifacts,
      `cards/${group.label}/select-card.json`,
      "card-selection",
      group.selectKey!,
      selection,
    );
    const discoveryObject = await readSourceObject(
      bucket,
      group.discoveryKey!,
      MAX_SOURCE_OBJECT_BYTES,
    );
    const discovery = parseEnvelopeBytes(discoveryObject.bytes, "month_discovery_json_invalid");
    await addSanitizedEnvelope(
      artifacts,
      `cards/${group.label}/web-meisai-top.json`,
      "month-discovery",
      group.discoveryKey!,
      discovery,
    );
    const discovered = availableMonths(discovery);
    const captured = discovered.filter((month) => group.pages.has(month));
    if (
      !sameStrings([...group.pages.keys()].sort(), captured.slice().sort()) ||
      captured.some((month, index) => month !== discovered[index])
    ) {
      throw new ImportError(409, "legacy_month_complement_invalid");
    }
    const isFinalCard = cardOffset === ordered.length - 1;
    if (!isFinalCard && captured.length !== discovered.length) {
      throw new ImportError(409, "legacy_month_complement_invalid");
    }
    for (const [monthOffset, month] of captured.entries()) {
      const descriptors = group.pages.get(month)!.sort((left, right) => left.index - right.index);
      const pages: Array<{ kind: "top" | "answer"; index: number; envelope: JsonObject }> = [];
      for (const descriptor of descriptors) {
        const object = await readSourceObject(bucket, descriptor.key, MAX_SOURCE_OBJECT_BYTES);
        pages.push({
          kind: descriptor.kind,
          index: descriptor.index,
          envelope: parseEnvelopeBytes(object.bytes, "statement_page_json_invalid"),
        });
      }
      const transactions = pages.reduce(
        (total, page) => total + statementPage(page.envelope, page.kind).rows,
        0,
      );
      const mayBeIncomplete =
        isFinalCard && monthOffset === captured.length - 1 && captured.length === discovered.length;
      try {
        validateMonthPages(month, pages, { pages: pages.length, transactions }, transactions);
      } catch (error) {
        if (
          !(
            mayBeIncomplete &&
            error instanceof ImportError &&
            error.code === "statement_pagination_incomplete"
          )
        )
          throw error;
      }
      const pageGroupKey = `${group.label}-${month}`;
      pageGroups.push({ key: pageGroupKey, count: pages.length });
      for (const [index, page] of pages.entries()) {
        await addSanitizedEnvelope(
          artifacts,
          `cards/${group.label}/months/${month}/${page.kind}-${String(page.index).padStart(3, "0")}.json`,
          "statement-page",
          descriptors[index]!.key,
          page.envelope,
          false,
          pageGroupKey,
          page.index,
        );
      }
    }
  }
  const errorBytes = encodeCanonical({
    schemaVersion: "vpass-worker-error-v1",
    source: SOURCE,
    runId: path.runId,
    card: "run",
    startedAt,
    completedAt: failedAt,
    status: "failed",
    failure: { category: "collector", errorType: "legacy", code: "legacy-collection-failed" },
  });
  artifacts.push({
    artifactKey: "error.json",
    dataset: "collector-error",
    sourceKey: recordKey,
    bytes: errorBytes,
    sha256: await sha256Hex(errorBytes),
  });
  return {
    record: {
      kind: "error",
      key: recordKey,
      prefix: path.prefix,
      runId: path.runId,
      cardLabel: "run",
      startedAt,
      completedAt: failedAt,
      status: "failed",
      schemaVersion: "vpass-worker-error-v1",
      sourceArtifactCount: prefixKeys.length,
    },
    artifacts,
    pageGroups,
  };
}

async function loadCardSnapshotManifest(
  bucket: R2Bucket,
  value: JsonObject,
  recordKey: string,
  path: RecordPath,
  prefixKeys: string[],
): Promise<LoadedRun> {
  const manifest = parseSuccessManifest(value, path, true);
  const snapshotKey = `${path.prefix}snapshot.json`;
  if (!sameStrings(prefixKeys, [recordKey, snapshotKey].sort(binaryCompare))) {
    throw new ImportError(409, "prefix_inventory_mismatch");
  }
  if (manifest.objectCount !== 2) throw new ImportError(409, "manifest_object_count_mismatch");
  const snapshotObject = await readSourceObject(bucket, snapshotKey, MAX_SOURCE_OBJECT_BYTES);
  const snapshot = parseJsonBytes(snapshotObject.bytes, "snapshot_json_invalid");
  exactObjectKeys(
    snapshot,
    [
      "format",
      "runId",
      "selectedCardIndex",
      "cardListRawJson",
      "selectCardRawJson",
      "webMeisaiTopRawJson",
      "months",
    ],
    "snapshot_schema_invalid",
  );
  if (
    snapshot.format !== "kogane-vpass-r2-snapshot/v1" ||
    snapshot.runId !== path.runId ||
    snapshot.selectedCardIndex !== path.cardIndex
  ) {
    throw new ImportError(409, "snapshot_identity_mismatch");
  }
  const cardList = parseEnvelopeString(snapshot.cardListRawJson, "card_list_json_invalid");
  const cards = cardListEntries(cardList);
  if (cards.length !== manifest.cardCount || path.cardIndex! > cards.length) {
    throw new ImportError(409, "card_inventory_mismatch");
  }
  const selection = parseEnvelopeString(snapshot.selectCardRawJson, "card_selection_json_invalid");
  const discovery = parseEnvelopeString(
    snapshot.webMeisaiTopRawJson,
    "month_discovery_json_invalid",
  );
  if (!sameStrings(availableMonths(discovery), Object.keys(manifest.months).sort().reverse())) {
    throw new ImportError(409, "month_discovery_mismatch");
  }
  const months = requiredRecord(snapshot.months, "snapshot_months_invalid");
  if (!sameStrings(Object.keys(months).sort(), Object.keys(manifest.months).sort())) {
    throw new ImportError(409, "snapshot_month_inventory_mismatch");
  }
  const artifacts: VerifiedArtifact[] = [];
  await addSanitizedEnvelope(artifacts, "card-list.json", "card-list", snapshotKey, cardList, true);
  await addSanitizedEnvelope(
    artifacts,
    "select-card.json",
    "card-selection",
    snapshotKey,
    selection,
  );
  await addSanitizedEnvelope(
    artifacts,
    "web-meisai-top.json",
    "month-discovery",
    snapshotKey,
    discovery,
  );
  for (const month of Object.keys(manifest.months).sort().reverse()) {
    const capture = requiredRecord(months[month], "snapshot_month_invalid");
    exactObjectKeys(capture, ["pages", "transactionCount"], "snapshot_month_invalid");
    if (!Array.isArray(capture.pages) || capture.pages.length > 100) {
      throw new ImportError(409, "snapshot_pages_invalid");
    }
    const pageInputs = capture.pages.map((entry, index) => {
      const page = requiredRecord(entry, "snapshot_page_invalid");
      exactObjectKeys(page, ["kind", "index", "rawJson"], "snapshot_page_invalid");
      if ((page.kind !== "top" && page.kind !== "answer") || page.index !== index) {
        throw new ImportError(409, "snapshot_page_order_invalid");
      }
      return {
        kind: page.kind as "top" | "answer",
        index,
        envelope: parseEnvelopeString(page.rawJson, "statement_page_json_invalid"),
      };
    });
    validateMonthPages(month, pageInputs, manifest.months[month]!, capture.transactionCount);
    for (const page of pageInputs) {
      await addSanitizedEnvelope(
        artifacts,
        `months/${month}/${page.kind}-${String(page.index).padStart(3, "0")}.json`,
        "statement-page",
        snapshotKey,
        page.envelope,
        false,
        month,
        page.index,
      );
    }
  }
  const manifestBytes = sanitizedManifestBytes(manifest, path, "vpass-worker-card-v1");
  artifacts.push({
    artifactKey: "manifest.json",
    dataset: "collector-manifest",
    sourceKey: recordKey,
    bytes: manifestBytes,
    sha256: await sha256Hex(manifestBytes),
  });
  return {
    record: sourceRecord(manifest, recordKey, path, "vpass-worker-card-v1"),
    artifacts,
    pageGroups: Object.entries(manifest.months).map(([key, summary]) => ({
      key,
      count: summary.pages,
    })),
  };
}

async function loadDiscreteManifest(
  bucket: R2Bucket,
  value: JsonObject,
  recordKey: string,
  path: RecordPath,
  prefixKeys: string[],
): Promise<LoadedRun> {
  const manifest = parseSuccessManifest(value, path, false);
  if (prefixKeys.length !== manifest.objectCount || !prefixKeys.includes(recordKey)) {
    throw new ImportError(409, "prefix_inventory_mismatch");
  }
  const discoveryKey = `${path.prefix}web-meisai-top.json`;
  if (!prefixKeys.includes(discoveryKey)) throw new ImportError(409, "month_discovery_missing");
  const pageKey = new RegExp(
    `^${escapeRegex(path.prefix)}months/(\\d{6})/(top|answer)-(\\d{3})\\.json$`,
    "u",
  );
  const allowed = new Set([recordKey, discoveryKey]);
  const grouped = new Map<string, Array<{ key: string; kind: "top" | "answer"; index: number }>>();
  for (const key of prefixKeys) {
    if (allowed.has(key)) continue;
    const match = pageKey.exec(key);
    if (!match) throw new ImportError(409, "prefix_inventory_mismatch");
    const month = match[1]!;
    const pages = grouped.get(month) ?? [];
    pages.push({ key, kind: match[2] as "top" | "answer", index: Number(match[3]) });
    grouped.set(month, pages);
  }
  if (!sameStrings([...grouped.keys()].sort(), Object.keys(manifest.months).sort())) {
    throw new ImportError(409, "page_month_inventory_mismatch");
  }
  const discoveryObject = await readSourceObject(bucket, discoveryKey, MAX_SOURCE_OBJECT_BYTES);
  const discovery = parseEnvelopeBytes(discoveryObject.bytes, "month_discovery_json_invalid");
  if (!sameStrings(availableMonths(discovery), Object.keys(manifest.months).sort().reverse())) {
    throw new ImportError(409, "month_discovery_mismatch");
  }
  const artifacts: VerifiedArtifact[] = [];
  await addSanitizedEnvelope(
    artifacts,
    "web-meisai-top.json",
    "month-discovery",
    discoveryKey,
    discovery,
  );
  for (const month of Object.keys(manifest.months).sort().reverse()) {
    const descriptors = grouped.get(month)!.sort((left, right) => left.index - right.index);
    const pages: Array<{ kind: "top" | "answer"; index: number; envelope: JsonObject }> = [];
    for (const descriptor of descriptors) {
      const object = await readSourceObject(bucket, descriptor.key, MAX_SOURCE_OBJECT_BYTES);
      pages.push({
        kind: descriptor.kind,
        index: descriptor.index,
        envelope: parseEnvelopeBytes(object.bytes, "statement_page_json_invalid"),
      });
    }
    validateMonthPages(month, pages, manifest.months[month]!, manifest.months[month]!.transactions);
    for (const page of pages) {
      await addSanitizedEnvelope(
        artifacts,
        `months/${month}/${page.kind}-${String(page.index).padStart(3, "0")}.json`,
        "statement-page",
        descriptors[page.index]!.key,
        page.envelope,
        false,
        month,
        page.index,
      );
    }
  }
  const manifestBytes = sanitizedManifestBytes(manifest, path, "vpass-worker-single-card-v1");
  artifacts.push({
    artifactKey: "manifest.json",
    dataset: "collector-manifest",
    sourceKey: recordKey,
    bytes: manifestBytes,
    sha256: await sha256Hex(manifestBytes),
  });
  return {
    record: sourceRecord(manifest, recordKey, path, "vpass-worker-single-card-v1"),
    artifacts,
    pageGroups: Object.entries(manifest.months).map(([key, summary]) => ({
      key,
      count: summary.pages,
    })),
  };
}

interface ParsedSuccessManifest {
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "success";
  monthCount: number;
  pageCount: number;
  transactionCount: number;
  objectCount: number;
  cardCount?: number;
  selectedCardIndex?: number;
  months: Record<string, MonthSummary>;
}

function parseSuccessManifest(
  value: JsonObject,
  path: RecordPath,
  cardScoped: boolean,
): ParsedSuccessManifest {
  exactObjectKeys(
    value,
    cardScoped
      ? [
          "runId",
          "startedAt",
          "completedAt",
          "cardCount",
          "selectedCardIndex",
          "monthCount",
          "pageCount",
          "transactionCount",
          "objectCount",
          "status",
          "months",
        ]
      : [
          "runId",
          "startedAt",
          "completedAt",
          "monthCount",
          "pageCount",
          "transactionCount",
          "objectCount",
          "status",
          "months",
        ],
    "manifest_schema_invalid",
  );
  const startedAt = requiredIso(value.startedAt, "manifest_started_at_invalid");
  const completedAt = requiredIso(value.completedAt, "manifest_completed_at_invalid");
  const monthsValue = requiredRecord(value.months, "manifest_months_invalid");
  const months: Record<string, MonthSummary> = {};
  for (const [month, summaryValue] of Object.entries(monthsValue)) {
    if (!MONTH.test(month)) throw new ImportError(409, "manifest_month_invalid");
    const summary = requiredRecord(summaryValue, "manifest_month_invalid");
    exactObjectKeys(summary, ["pages", "transactions"], "manifest_month_invalid");
    if (
      !boundedInteger(summary.pages, 0, 100) ||
      !boundedInteger(summary.transactions, 0, 100_000)
    ) {
      throw new ImportError(409, "manifest_month_invalid");
    }
    months[month] = { pages: summary.pages, transactions: summary.transactions };
  }
  const cardCount = cardScoped ? value.cardCount : undefined;
  const selectedCardIndex = cardScoped ? value.selectedCardIndex : undefined;
  if (
    value.runId !== path.runId ||
    startedAt !== runIdToIso(path.runId) ||
    Date.parse(completedAt) < Date.parse(startedAt) ||
    value.status !== "success" ||
    !boundedInteger(value.monthCount, 1, 60) ||
    !boundedInteger(value.pageCount, 1, 6_000) ||
    !boundedInteger(value.transactionCount, 0, 10_000_000) ||
    !boundedInteger(value.objectCount, 1, MAX_PREFIX_OBJECTS) ||
    Object.keys(months).length !== value.monthCount ||
    Object.values(months).reduce((sum, entry) => sum + entry.pages, 0) !== value.pageCount ||
    Object.values(months).reduce((sum, entry) => sum + entry.transactions, 0) !==
      value.transactionCount ||
    (cardScoped &&
      (!boundedInteger(cardCount, 1, 999) ||
        !boundedInteger(selectedCardIndex, 1, cardCount) ||
        selectedCardIndex !== path.cardIndex))
  ) {
    throw new ImportError(409, "manifest_semantics_invalid");
  }
  return {
    runId: path.runId,
    startedAt,
    completedAt,
    status: "success",
    monthCount: value.monthCount,
    pageCount: value.pageCount,
    transactionCount: value.transactionCount,
    objectCount: value.objectCount,
    ...(cardScoped
      ? { cardCount: cardCount as number, selectedCardIndex: selectedCardIndex as number }
      : {}),
    months,
  };
}

function sourceRecord(
  manifest: ParsedSuccessManifest,
  recordKey: string,
  path: RecordPath,
  schemaVersion: SourceRecord["schemaVersion"],
): SourceRecord {
  return {
    kind: "manifest",
    key: recordKey,
    prefix: path.prefix,
    runId: path.runId,
    cardLabel: path.cardLabel ?? "card-001",
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt,
    status: "success",
    schemaVersion,
    sourceArtifactCount: manifest.objectCount,
  };
}

function sanitizedManifestBytes(
  manifest: ParsedSuccessManifest,
  path: RecordPath,
  schemaVersion: SourceRecord["schemaVersion"],
): Uint8Array {
  const months: Record<string, JsonValue> = Object.fromEntries(
    Object.entries(manifest.months)
      .sort(([left], [right]) => binaryCompare(left, right))
      .map(([month, summary]) => [
        month,
        {
          pages: summary.pages,
          transactions: summary.transactions,
        },
      ]),
  );
  return encodeCanonical({
    schemaVersion,
    source: SOURCE,
    runId: manifest.runId,
    card: path.cardLabel ?? "card-001",
    startedAt: manifest.startedAt,
    completedAt: manifest.completedAt,
    status: manifest.status,
    monthCount: manifest.monthCount,
    pageCount: manifest.pageCount,
    transactionCount: manifest.transactionCount,
    months,
  });
}

function parseSafeError(value: unknown): Record<string, JsonValue> {
  if (typeof value !== "string" || value.length < 2 || value.length > 2_000) {
    throw new ImportError(409, "error_message_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ImportError(409, "error_message_invalid");
  }
  const details = requiredRecord(parsed, "error_message_invalid");
  const optional = new Set(["httpStatus", "code"]);
  const allowed = ["category", "errorType", ...optional];
  if (
    Object.keys(details).some((key) => !allowed.includes(key)) ||
    !Object.hasOwn(details, "category") ||
    !Object.hasOwn(details, "errorType") ||
    ![
      "http",
      "timeout",
      "network",
      "configuration",
      "authentication",
      "response",
      "unknown",
    ].includes(String(details.category)) ||
    typeof details.errorType !== "string" ||
    !/^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(details.errorType) ||
    !(details.httpStatus === undefined || boundedInteger(details.httpStatus, 100, 599)) ||
    !(
      details.code === undefined ||
      (typeof details.code === "string" && /^[a-z0-9_-]{1,100}$/u.test(details.code))
    )
  ) {
    throw new ImportError(409, "error_message_invalid");
  }
  return {
    category: details.category as string,
    errorType: details.errorType,
    ...(details.httpStatus === undefined ? {} : { httpStatus: details.httpStatus }),
    ...(details.code === undefined ? {} : { code: details.code }),
  };
}

function validateMonthPages(
  month: string,
  pages: Array<{ kind: "top" | "answer"; index: number; envelope: JsonObject }>,
  summary: MonthSummary,
  captureTransactionCount: unknown,
): void {
  if (
    !MONTH.test(month) ||
    pages.length !== summary.pages ||
    pages.length < 1 ||
    !boundedInteger(captureTransactionCount, 0, 10_000_000) ||
    captureTransactionCount !== summary.transactions ||
    pages.some((page, index) => page.index !== index) ||
    pages[0]!.kind !== "top"
  ) {
    throw new ImportError(409, "statement_pagination_invalid");
  }
  const parsed = pages.map((page) => statementPage(page.envelope, page.kind));
  const family = parsed[0]!.family;
  if (
    parsed.some((page) => page.family !== family) ||
    (family === "web" && pages.some((page) => page.kind !== "top")) ||
    (family === "customized" && pages.slice(1).some((page) => page.kind !== "answer")) ||
    parsed.reduce((sum, page) => sum + page.rows, 0) !== summary.transactions
  ) {
    throw new ImportError(409, "statement_pagination_invalid");
  }
  if (family === "web") {
    const seen = new Set<string>();
    for (const [index, page] of parsed.entries()) {
      const terminal =
        (page.allCount !== null && page.nextPageRow !== null && page.allCount < page.nextPageRow) ||
        (page.rows === 0 && index > 0);
      if (index === parsed.length - 1) {
        if (!terminal) throw new ImportError(409, "statement_pagination_incomplete");
      } else {
        if (terminal || page.nextPageRow === null || seen.has(String(page.nextPageRow))) {
          throw new ImportError(409, "statement_pagination_invalid");
        }
        seen.add(String(page.nextPageRow));
      }
    }
  } else {
    const total = parsed[0]!.total;
    if (total === null || total < 0) throw new ImportError(409, "statement_total_invalid");
    const last = parsed.at(-1)!;
    if (summary.transactions < total && last.rows !== 0) {
      throw new ImportError(409, "statement_pagination_incomplete");
    }
    if (parsed.slice(1, -1).some((page) => page.rows === 0)) {
      throw new ImportError(409, "statement_pagination_invalid");
    }
  }
}

function statementPage(
  envelope: JsonObject,
  kind: "top" | "answer",
): {
  family: "web" | "customized";
  rows: number;
  allCount: number | null;
  nextPageRow: number | null;
  total: number | null;
} {
  const content = objectAt(envelope, "body", "content");
  const web = objectAt(content, "WebMeisaiTopDisplayServiceBean");
  const customized = objectAt(content, "CustomizedMeisaiAnsDisplayServiceBean");
  if ((web === null) === (customized === null)) {
    throw new ImportError(409, "statement_page_shape_invalid");
  }
  if (kind === "answer" && !customized) throw new ImportError(409, "statement_page_shape_invalid");
  if (web) {
    const detail = objectAt(web, "webMeisaiTopK3Vo");
    return {
      family: "web",
      rows: arrayAt(web, "meisaiList").length,
      allCount: integer(detail?.allCnt),
      nextPageRow: integer(detail?.nextPageRow),
      total: null,
    };
  }
  return {
    family: "customized",
    rows: arrayAt(customized, "meisaiList").length,
    allCount: null,
    nextPageRow: null,
    total: integer(customized!.total),
  };
}

async function addSanitizedEnvelope(
  artifacts: VerifiedArtifact[],
  artifactKey: string,
  dataset: string,
  sourceKey: string,
  envelope: JsonObject,
  cardList = false,
  pageGroupKey?: string,
  pageIndex?: number,
): Promise<void> {
  const sanitized = sanitizeEnvelope(envelope, cardList);
  const bytes = encodeCanonical(sanitized);
  artifacts.push({
    artifactKey,
    dataset,
    sourceKey,
    bytes,
    sha256: await sha256Hex(bytes),
    ...(pageGroupKey === undefined ? {} : { pageGroupKey }),
    ...(pageIndex === undefined ? {} : { pageIndex }),
  });
}

function sanitizeEnvelope(envelope: JsonObject, cardList: boolean): JsonValue {
  const sanitized = sanitizeJson(envelope, false);
  if (!isRecord(sanitized)) throw new ImportError(409, "sanitizer_output_invalid");
  if (cardList) {
    const bean = objectAt(sanitized, "body", "content", "DropdownListInitDisplayServiceBean");
    const list = bean?.multiCardInfoList;
    if (!Array.isArray(list)) throw new ImportError(409, "card_inventory_invalid");
    bean!.multiCardInfoList = list.map((entry, index) => {
      if (!isRecord(entry)) throw new ImportError(409, "card_inventory_invalid");
      return Object.fromEntries(
        Object.entries(entry).map(([key, value]) => {
          if (key === "name") return [key, `card-${String(index + 1).padStart(3, "0")}`];
          if (key === "value") return [key, "<redacted-card-reference>"];
          return [key, value];
        }),
      );
    });
  }
  assertSanitized(sanitized, cardList);
  return sanitized;
}

function sanitizeJson(value: unknown, sensitiveContext: boolean): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return sensitiveContext && typeof value === "string" && value.length > 0
      ? "<redacted-vpass-sensitive>"
      : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ImportError(409, "json_number_invalid");
    return sensitiveContext ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeJson(entry, sensitiveContext));
  if (!isRecord(value)) throw new ImportError(409, "json_value_invalid");
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      const sensitive = sensitiveContext || sensitiveKey(key);
      if (sensitive) return [key, "<redacted-vpass-sensitive>"];
      return [key, sanitizeJson(child, false)];
    }),
  );
}

function sensitiveKey(key: string): boolean {
  return /(?:auth|token|session|cookie|password|userid|device|csrf|card.*(?:key|id)|identify)/iu.test(
    key,
  );
}

function assertSanitized(value: JsonValue, cardList: boolean): void {
  const visit = (child: JsonValue): void => {
    if (Array.isArray(child)) {
      child.forEach(visit);
      return;
    }
    if (child === null || typeof child !== "object") return;
    for (const [key, nested] of Object.entries(child)) {
      if (sensitiveKey(key) && nested !== "<redacted-vpass-sensitive>") {
        throw new ImportError(409, "sanitizer_sensitive_value_retained");
      }
      visit(nested);
    }
  };
  visit(value);
  if (cardList) {
    const list = objectAt(
      value,
      "body",
      "content",
      "DropdownListInitDisplayServiceBean",
    )?.multiCardInfoList;
    if (
      !Array.isArray(list) ||
      list.some(
        (entry, index) =>
          !isRecord(entry) ||
          entry.name !== `card-${String(index + 1).padStart(3, "0")}` ||
          entry.value !== "<redacted-card-reference>",
      )
    ) {
      throw new ImportError(409, "sanitizer_card_reference_retained");
    }
  }
}

function parseEnvelopeString(value: unknown, code: string): JsonObject {
  if (typeof value !== "string" || value.length < 2 || value.length > MAX_SOURCE_OBJECT_BYTES) {
    throw new ImportError(409, code);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ImportError(409, code);
  }
  return validateEnvelope(parsed, code);
}

function parseEnvelopeBytes(bytes: Uint8Array, code: string): JsonObject {
  return validateEnvelope(parseJsonBytes(bytes, code), code);
}

function validateEnvelope(value: unknown, code: string): JsonObject {
  const envelope = requiredRecord(value, code);
  const header = objectAt(envelope, "header");
  const body = objectAt(envelope, "body");
  const resultCode = header?.resultCode;
  if (!header || !body || !(resultCode === 0 || resultCode === "0" || resultCode === "0000")) {
    throw new ImportError(409, code);
  }
  return envelope;
}

function cardListEntries(envelope: JsonObject): JsonObject[] {
  const entries = objectAt(
    envelope,
    "body",
    "content",
    "DropdownListInitDisplayServiceBean",
  )?.multiCardInfoList;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 999) {
    throw new ImportError(409, "card_inventory_invalid");
  }
  return entries.map((entry) => {
    const card = requiredRecord(entry, "card_inventory_invalid");
    if (
      typeof card.name !== "string" ||
      card.name.length < 1 ||
      card.name.length > 500 ||
      typeof card.value !== "string" ||
      card.value.length < 1 ||
      card.value.length > 2_000
    ) {
      throw new ImportError(409, "card_inventory_invalid");
    }
    return card;
  });
}

function availableMonths(envelope: JsonObject): string[] {
  const content = objectAt(envelope, "body", "content");
  if (!content) throw new ImportError(409, "month_discovery_invalid");
  const sources = [
    objectAt(content, "WebMeisaiTopDisplayServiceBean")?.seikyuYMList,
    objectAt(content, "WebMeisaiCommonDisplayServiceBean")?.comSeikyuYMList,
    objectAt(content, "CustomizedMeisaiAnsDisplayServiceBean")?.seikyuYMList,
  ];
  const result = new Set<string>();
  for (const source of sources) {
    if (source === undefined) continue;
    if (!Array.isArray(source)) throw new ImportError(409, "month_discovery_invalid");
    for (const entry of source) {
      const pair = requiredRecord(entry, "month_discovery_invalid");
      exactObjectKeys(pair, ["name", "value"], "month_discovery_invalid");
      if (typeof pair.name !== "string" || typeof pair.value !== "string") {
        throw new ImportError(409, "month_discovery_invalid");
      }
      if (pair.name === "---お選びください---" && pair.value === "") continue;
      const onward = /^(\d{4})年(\d{2})月以降$/u.exec(pair.name);
      if (onward && pair.value === `${onward[1]}${onward[2]}1`) continue;
      if (!MONTH.test(pair.value)) throw new ImportError(409, "month_discovery_invalid");
      const year = pair.value.slice(0, 4);
      const month = pair.value.slice(4);
      if (pair.name !== `${year}年${month}月` && pair.name !== `${year}年${Number(month)}月`) {
        throw new ImportError(409, "month_discovery_invalid");
      }
      result.add(pair.value);
    }
  }
  if (result.size === 0) throw new ImportError(409, "month_discovery_invalid");
  return [...result].sort().reverse();
}

async function readSourceObject(
  bucket: R2Bucket,
  key: string,
  maximum: number,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const object = await bucket.get(key);
  if (!object) throw new ImportError(409, "source_object_missing");
  if (object.size < 1 || object.size > maximum)
    throw new ImportError(409, "source_object_size_invalid");
  if (object.httpMetadata?.contentType !== SOURCE_CONTENT_TYPE) {
    throw new ImportError(409, "source_content_type_mismatch");
  }
  if (object.customMetadata && Object.keys(object.customMetadata).length !== 0) {
    throw new ImportError(409, "source_metadata_mismatch");
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== object.size) throw new ImportError(409, "source_object_size_mismatch");
  const sha256 = await sha256Hex(bytes);
  const native = object.checksums.sha256;
  if (native && bytesHex(new Uint8Array(native)) !== sha256) {
    throw new ImportError(409, "source_native_checksum_mismatch");
  }
  return { bytes, sha256 };
}

async function exactPrefixKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, limit: 1_000, ...(cursor ? { cursor } : {}) });
    keys.push(...listed.objects.map((object) => object.key));
    if (keys.length > MAX_PREFIX_OBJECTS) throw new ImportError(409, "prefix_inventory_too_large");
    const next = listed.truncated ? listed.cursor : undefined;
    if (listed.truncated && !next) throw new ImportError(409, "prefix_cursor_missing");
    if (next && next === cursor) throw new ImportError(409, "prefix_cursor_did_not_advance");
    cursor = next;
  } while (cursor);
  return keys.sort(binaryCompare);
}

async function artifactPlans(
  validated: LoadedRun,
  centralRunId: number,
  unitId: number,
  pageGroups: PageGroupReference[],
  fingerprintKey: string,
): Promise<ArtifactPlan[]> {
  const plans: ArtifactPlan[] = [];
  for (const [sequence, artifact] of validated.artifacts.entries()) {
    const pageGroupId =
      artifact.pageGroupKey === undefined
        ? null
        : pageGroups.find((entry) => entry.key === artifact.pageGroupKey)?.id;
    if (pageGroupId === undefined) throw new ImportError(400, "transfer_page_group_mismatch");
    const descriptor = normalizedDescriptor({
      artifactKey: artifact.artifactKey,
      artifactRole:
        artifact.dataset === "collector-manifest"
          ? "collector_derived"
          : artifact.dataset === "collector-error"
            ? "collector_report"
            : artifact.dataset === "statement-page"
              ? "provider_response"
              : "collector_context",
      dataset: artifact.dataset,
      formatId: `vpass-${artifact.dataset}-json`,
      fetchedAtMs: Date.parse(validated.record.completedAt),
      fetchUnitId: unitId,
      pageGroupId,
      pageIndex: artifact.pageIndex ?? null,
      sequence,
      sha256: artifact.sha256,
      byteSize: artifact.bytes.byteLength,
      storage: await storageOrigin(artifact.sourceKey, fingerprintKey),
    });
    plans.push({
      artifact,
      descriptor,
      inventory: {
        artifactKey: artifact.artifactKey,
        sha256: artifact.sha256,
        descriptorSha256: await descriptorSha256(descriptor),
      },
    });
  }
  return plans;
}

function normalizedDescriptor(input: {
  artifactKey: string;
  artifactRole: string;
  dataset: string;
  formatId: string;
  fetchedAtMs: number;
  fetchUnitId: number;
  pageGroupId: number | null;
  pageIndex: number | null;
  sequence: number;
  sha256: string;
  byteSize: number;
  storage: JsonObject;
}): JsonObject {
  return {
    artifactKey: input.artifactKey,
    artifactRole: input.artifactRole,
    payloadFidelity: "transformed",
    containerKind: "single",
    lineageDisposition: "source_not_retained_for_security",
    dataset: input.dataset,
    formatId: input.formatId,
    formatVersion: "vpass-central-sanitized-v1",
    declaredMediaType: "application/json",
    mediaTypeBasis: "operator",
    fetchedAtMs: input.fetchedAtMs,
    fetchedAtBasis: "manifest",
    fetchUnitId: input.fetchUnitId,
    pageGroupId: input.pageGroupId,
    pageIndex: input.pageIndex,
    sequence: input.sequence,
    sha256: input.sha256,
    byteSize: input.byteSize,
    http: null,
    storage: input.storage,
    file: null,
    email: null,
    ranges: [],
    transformSteps: [
      {
        stepIndex: 0,
        stepKind: "redacted",
        transformerId: "vpass-json-sanitizer",
        transformerVersion: "v1",
      },
      {
        stepIndex: 1,
        stepKind: "reencoded",
        transformerId: "vpass-json-sanitizer",
        transformerVersion: "v1",
      },
    ],
    relations: [],
  };
}

async function storageOrigin(key: string, fingerprintKey: string): Promise<JsonObject> {
  if (!SHA256.test(fingerprintKey)) throw new ImportError(500, "fingerprint_configuration_invalid");
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(hexBytes(fingerprintKey)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(key));
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

async function encodeTransferState(state: TransferState, keyHex: string): Promise<string> {
  const payload = new TextEncoder().encode(canonicalJson(state as unknown as JsonValue));
  const encoded = base64Url(payload);
  const signature = await hmacHex(
    keyHex,
    new TextEncoder().encode(`${TRANSFER_TOKEN_PREFIX}\0${encoded}`),
  );
  return `${TRANSFER_TOKEN_PREFIX}.${encoded}.${signature}`;
}

async function decodeTransferState(token: string, keyHex: string): Promise<TransferState> {
  if (token.length > 8_000) throw new ImportError(400, "transfer_token_invalid");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TRANSFER_TOKEN_PREFIX || !SHA256.test(parts[2]!)) {
    throw new ImportError(400, "transfer_token_invalid");
  }
  const expected = await hmacHex(
    keyHex,
    new TextEncoder().encode(`${TRANSFER_TOKEN_PREFIX}\0${parts[1]}`),
  );
  if (!timingSafeHexEqual(expected, parts[2]!)) {
    throw new ImportError(400, "transfer_token_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(parts[1]!)));
  } catch {
    throw new ImportError(400, "transfer_token_invalid");
  }
  const input = requiredRecord(parsed, "transfer_token_invalid");
  exactObjectKeys(
    input,
    [
      "v",
      "recordKey",
      "centralRunId",
      "unitId",
      "pageGroups",
      "inventoryId",
      "inventorySha256",
      "offset",
    ],
    "transfer_token_invalid",
  );
  if (
    input.v !== 1 ||
    typeof input.recordKey !== "string" ||
    !RECORD_KEY.test(input.recordKey) ||
    !positiveInteger(input.centralRunId) ||
    !positiveInteger(input.unitId) ||
    !Array.isArray(input.pageGroups) ||
    input.pageGroups.length > 60 ||
    !positiveInteger(input.inventoryId) ||
    typeof input.inventorySha256 !== "string" ||
    !SHA256.test(input.inventorySha256) ||
    !boundedInteger(input.offset, 0, MAX_ARTIFACTS)
  ) {
    throw new ImportError(400, "transfer_token_invalid");
  }
  const pageGroups = input.pageGroups.map((entry): PageGroupReference => {
    const value = requiredRecord(entry, "transfer_token_invalid");
    exactObjectKeys(value, ["key", "id"], "transfer_token_invalid");
    if (
      typeof value.key !== "string" ||
      !PAGE_GROUP_KEY.test(value.key) ||
      !positiveInteger(value.id)
    ) {
      throw new ImportError(400, "transfer_token_invalid");
    }
    return { key: value.key, id: value.id as number };
  });
  if (
    new Set(pageGroups.map((entry) => entry.key)).size !== pageGroups.length ||
    new Set(pageGroups.map((entry) => entry.id)).size !== pageGroups.length
  ) {
    throw new ImportError(400, "transfer_token_invalid");
  }
  return {
    v: 1,
    recordKey: input.recordKey,
    centralRunId: input.centralRunId as number,
    unitId: input.unitId as number,
    pageGroups,
    inventoryId: input.inventoryId as number,
    inventorySha256: input.inventorySha256,
    offset: input.offset as number,
  };
}

function validateTransferState(state: TransferState, loaded: LoadedRun, recordKey: string): void {
  const keys = loaded.pageGroups.map((entry) => entry.key);
  if (
    state.recordKey !== recordKey ||
    state.offset > loaded.artifacts.length ||
    !sameStrings(
      state.pageGroups.map((entry) => entry.key),
      keys,
    )
  ) {
    throw new ImportError(400, "transfer_state_mismatch");
  }
}

async function hmacHex(keyHex: string, bytes: Uint8Array): Promise<string> {
  if (!SHA256.test(keyHex)) throw new ImportError(500, "fingerprint_configuration_invalid");
  const key = await crypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(hexBytes(keyHex)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, ownedArrayBuffer(bytes))));
}

function timingSafeHexEqual(left: string, right: string): boolean {
  const leftBytes = hexBytes(left);
  const rightBytes = hexBytes(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBuffer, b: ArrayBuffer) => boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(ownedArrayBuffer(leftBytes), ownedArrayBuffer(rightBytes));
  }
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

function sortedInventory(plans: ArtifactPlan[]): CentralInventoryItem[] {
  return plans
    .map((plan) => plan.inventory)
    .sort((left, right) => binaryCompare(left.artifactKey, right.artifactKey));
}

function descriptorSha256(descriptor: JsonObject): Promise<string> {
  const { http, storage, file, email, ...fields } = descriptor;
  const normalized = {
    ...fields,
    origins: {
      http: http ?? null,
      storage: storage ?? null,
      file: file ?? null,
      email: email ?? null,
    },
  };
  return sha256Hex(new TextEncoder().encode(canonicalJson(normalized as JsonValue)));
}

function parseJsonBytes(bytes: Uint8Array, code: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ImportError(409, code);
  }
  return requiredRecord(parsed, code);
}

function requiredRecord(value: unknown, code: string): JsonObject {
  if (!isRecord(value)) throw new ImportError(409, code);
  return value;
}

function exactObjectKeys(value: JsonObject, expected: string[], code: string): void {
  const actual = Object.keys(value).sort(binaryCompare);
  const sorted = [...expected].sort(binaryCompare);
  if (!sameStrings(actual, sorted)) throw new ImportError(409, code);
}

function requiredIso(value: unknown, code: string): string {
  if (typeof value !== "string" || !isIso(value)) throw new ImportError(409, code);
  return value;
}

function isIso(value: string): boolean {
  return ISO.test(value) && new Date(value).toISOString() === value;
}

function runIdToIso(runId: string): string {
  const match = RUN_ID.exec(runId);
  if (!match) throw new ImportError(400, "record_key_invalid");
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`;
}

function objectAt(value: unknown, ...path: string[]): JsonObject | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return isRecord(current) ? current : null;
}

function arrayAt(value: unknown, ...path: string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function encodeCanonical(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}

function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => binaryCompare(left, right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ImportError(409, "json_number_invalid");
  }
  return value;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new ImportError(400, "transfer_token_invalid");
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesHex(new Uint8Array(await crypto.subtle.digest("SHA-256", ownedArrayBuffer(bytes))));
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (part) => Number.parseInt(part, 16));
}

function bytesHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

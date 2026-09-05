import { CentralClient } from "./central";
import { ImportError } from "./error";
import {
  myJcbManifestKeyMatch,
  normalizeMyJcbArtifactPayload,
  normalizeMyJcbManifestForCentral,
  parseMyJcbManifest,
  type MyJcbArtifactManifest,
  type MyJcbConnection,
  type MyJcbManifest,
  type VerifiedMyJcbArtifact,
} from "./myjcb-schema";
import type { CentralInventoryItem } from "./types";

const SOURCE = "myjcb" as const;
const PRODUCER = "collector-r2-importer";
const INGEST_CONTRACT_VERSION = "myjcb-r2-v1";
const CENTRAL_CLIENT_ID = "collector-r2-myjcb";
const STORAGE_CONTAINER = "kogane-myjcb-collector-poc";
const STORAGE_TEMPLATE = "raw/myjcb/{date}/{run-id}/{artifact}";
const FINGERPRINT_VERSION = "collector-r2-v1";
const MAX_MANIFEST_BYTES = 3 * 1024 * 1024;
const MAX_ARTIFACTS = 512;
const MAX_PREFIX_OBJECTS = MAX_ARTIFACTS + 1;
export const MYJCB_TRANSFER_CHUNK_SIZE = 5;
const TRANSFER_TOKEN_PREFIX = "myjcb-transfer-v1";
const SHA256 = /^[0-9a-f]{64}$/u;

type JsonObject = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface LoadedRun {
  manifest: MyJcbManifest;
  centralManifestBytes: Uint8Array;
  centralManifestSha256: string;
  artifacts: VerifiedMyJcbArtifact[];
}

interface ArtifactPlan {
  source: VerifiedMyJcbArtifact | null;
  bytes: number;
  sha256: string;
  descriptor: JsonObject;
  inventory: CentralInventoryItem;
}

interface UnitReference {
  connectionId: string;
  unitId: number;
}

interface TransferState {
  v: 1;
  manifestKey: string;
  centralRunId: number;
  inventoryId: number;
  inventorySha256: string;
  units: UnitReference[];
  offset: number;
}

export type MyJcbImportResult = MyJcbImportDeferred | MyJcbImportSealed;

export interface MyJcbImportDeferred {
  source: typeof SOURCE;
  manifestKey: string;
  status: "deferred";
  reason: "worker_invocation_limit";
  artifactCount: number;
  nextOffset: number;
  continuation: string;
}

export interface MyJcbImportSealed {
  source: typeof SOURCE;
  manifestKey: string;
  status: "sealed";
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  finalChunkAllObjectsReused: boolean;
}

export async function importMyJcbRun(options: {
  bucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  importerVersion: string;
  manifestKey: string;
  continuation?: string;
}): Promise<MyJcbImportResult> {
  const startedAtMs = Date.now();
  const attemptId = `attempt-${crypto.randomUUID()}`;
  let centralRunId: number | undefined;
  let acceptedArtifactCount = 0;
  let reusedArtifactCount = 0;
  let expectedArtifactCount = 0;
  let phase = "source_validation";
  try {
    const validated = await validateMyJcbRun(options.bucket, options.manifestKey);
    expectedArtifactCount = validated.artifacts.length + 1;
    if (expectedArtifactCount > MAX_ARTIFACTS + 1) {
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
      validateTransferState(state, validated.manifest, options.manifestKey, expectedArtifactCount);
      centralRunId = state.centralRunId;
    } else {
      initialized = true;
      phase = "central_create";
      centralRunId = await central.createRun({
        producerId: PRODUCER,
        sourceId: SOURCE,
        externalIdNamespace: validated.manifest.schemaVersion,
        externalSessionId: validated.manifest.runId,
        sourceRunKey: `full-snapshot-${INGEST_CONTRACT_VERSION}`,
      });
      phase = "unit_catalogue";
      const units: UnitReference[] = [];
      for (const connection of validated.manifest.connections) {
        units.push({
          connectionId: connection.connectionId,
          unitId: await central.addUnit(centralRunId, {
            unitKind: "connection",
            unitKey: connection.connectionId,
            terminalReportRequired: true,
          }),
        });
      }
      phase = "inventory_plan";
      const initialPlans = await artifactPlans(
        validated,
        centralRunId,
        units,
        options.manifestKey,
        options.fingerprintKey,
      );
      const inventory = sortedInventory(initialPlans);
      const inventorySha256 = await sha256Hex(
        new TextEncoder().encode(canonicalJson(inventory as unknown as JsonValue)),
      );
      state = {
        v: 1,
        manifestKey: options.manifestKey,
        centralRunId,
        inventoryId: await central.beginInventory(centralRunId, inventorySha256, inventory.length),
        inventorySha256,
        units,
        offset: 0,
      };
    }

    phase = "inventory_plan";
    const plans = await artifactPlans(
      validated,
      state.centralRunId,
      state.units,
      options.manifestKey,
      options.fingerprintKey,
    );
    const inventory = sortedInventory(plans);
    const inventorySha256 = await sha256Hex(
      new TextEncoder().encode(canonicalJson(inventory as unknown as JsonValue)),
    );
    if (inventorySha256 !== state.inventorySha256) {
      throw new ImportError(409, "transfer_inventory_mismatch");
    }
    const end = Math.min(state.offset + MYJCB_TRANSFER_CHUNK_SIZE, plans.length);
    const chunkInventory: CentralInventoryItem[] = [];
    for (const plan of plans.slice(state.offset, end)) {
      phase = "object_upload";
      const bytes = plan.source ? plan.source.centralBytes : validated.centralManifestBytes;
      const reused = await central.uploadObject(state.centralRunId, plan.sha256, bytes);
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
      const nextState: TransferState = { ...state, offset: end };
      return {
        source: SOURCE,
        manifestKey: options.manifestKey,
        status: "deferred",
        reason: "worker_invocation_limit",
        artifactCount: plans.length,
        nextOffset: end,
        continuation: await encodeTransferState(nextState, options.fingerprintKey),
      };
    }

    phase = "unit_reports";
    for (const connection of validated.manifest.connections) {
      const unit = state.units.find((entry) => entry.connectionId === connection.connectionId)!;
      await central.addUnitReport(unit.unitId, {
        reportKey: "terminal",
        reportKind: "terminal",
        producerStatus: connection.status,
        normalizedOutcome:
          connection.status === "human-required" ? "human_required" : connection.status,
        startedAtMs: Date.parse(validated.manifest.startedAt),
        startedAtBasis: "manifest",
        completedAtMs: Date.parse(validated.manifest.completedAt),
        completedAtBasis: "manifest",
        declaredArtifactCount: connection.artifactCount,
        artifactCountScope: "direct",
        ...(connection.status === "success"
          ? {}
          : {
              safeFailureCode: safeConnectionFailureCode(connection, validated.manifest),
            }),
      });
    }
    phase = "run_report";
    await central.addRunReport(state.centralRunId, {
      reportKey: "terminal",
      reportKind: "terminal",
      producerVersion: options.importerVersion,
      manifestSchemaVersion: validated.manifest.schemaVersion,
      producerStatus: validated.manifest.status,
      normalizedOutcome: validated.manifest.status,
      startedAtMs: Date.parse(validated.manifest.startedAt),
      startedAtBasis: "manifest",
      completedAtMs: Date.parse(validated.manifest.completedAt),
      completedAtBasis: "manifest",
      declaredArtifactCount: plans.length,
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
      manifestKey: options.manifestKey,
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
        // Best effort only; the original strict import error must be preserved.
      }
    }
    throw error;
  }
}

export async function validateMyJcbRun(bucket: R2Bucket, manifestKey: string): Promise<LoadedRun> {
  const manifestObject = await bucket.get(manifestKey);
  if (!manifestObject) throw new ImportError(404, "manifest_not_found");
  if (manifestObject.size > MAX_MANIFEST_BYTES) throw new ImportError(413, "manifest_too_large");
  if (manifestObject.httpMetadata?.contentType !== "application/json") {
    throw new ImportError(409, "manifest_content_type_mismatch");
  }
  const manifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
  const manifestSha256 = await sha256Hex(manifestBytes);
  assertNativeSha256(manifestObject, manifestSha256);
  const manifest = parseMyJcbManifest(manifestBytes, manifestKey);
  assertExactMetadata(
    manifestObject.customMetadata,
    {
      source: manifest.source,
      status: manifest.status,
      runId: manifest.runId,
    },
    "manifest_metadata_mismatch",
  );
  const expectedKeys = [...manifest.artifacts.map((artifact) => artifact.key), manifestKey];
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  await assertExactPrefix(bucket, prefix, expectedKeys);
  const artifacts: VerifiedMyJcbArtifact[] = [];
  for (const artifact of manifest.artifacts) {
    const bytes = await readVerifiedArtifact(bucket, artifact, manifest);
    const connection = manifest.connections.find(
      (entry) => entry.connectionId === artifact.connectionId,
    )!;
    const centralBytes = normalizeMyJcbArtifactPayload(artifact, bytes, connection);
    artifacts.push({
      artifact,
      centralBytes,
      centralSha256: await sha256Hex(centralBytes),
    });
  }
  await assertExactPrefix(bucket, prefix, expectedKeys);
  const centralManifestBytes = normalizeMyJcbManifestForCentral(manifest);
  return {
    manifest,
    centralManifestBytes,
    centralManifestSha256: await sha256Hex(centralManifestBytes),
    artifacts,
  };
}

async function readVerifiedArtifact(
  bucket: R2Bucket,
  artifact: MyJcbArtifactManifest,
  manifest: MyJcbManifest,
): Promise<Uint8Array> {
  const object = await bucket.get(artifact.key);
  if (!object) throw new ImportError(409, "artifact_missing");
  if (object.size !== artifact.bytes) throw new ImportError(409, "artifact_size_mismatch");
  if (object.httpMetadata?.contentType !== artifact.mediaType) {
    throw new ImportError(409, "artifact_content_type_mismatch");
  }
  assertExactMetadata(
    object.customMetadata,
    {
      source: manifest.source,
      dataset: artifact.dataset,
      sha256: artifact.sha256,
      ...(artifact.statementState ? { statementState: artifact.statementState } : {}),
      ...(artifact.period ? { period: artifact.period } : {}),
    },
    "artifact_metadata_mismatch",
  );
  assertNativeSha256(object, artifact.sha256);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256Hex(bytes)) !== artifact.sha256) {
    throw new ImportError(409, "artifact_checksum_mismatch");
  }
  return bytes;
}

async function artifactPlans(
  validated: LoadedRun,
  centralRunId: number,
  units: UnitReference[],
  manifestKey: string,
  fingerprintKey: string,
): Promise<ArtifactPlan[]> {
  const plans: ArtifactPlan[] = [];
  const sourceArtifactKeys = new Set(
    validated.artifacts.map((entry) => `${entry.artifact.connectionId}/${entry.artifact.filename}`),
  );
  for (const [sequence, verified] of validated.artifacts.entries()) {
    const unit = units.find((entry) => entry.connectionId === verified.artifact.connectionId);
    if (!unit) throw new ImportError(400, "transfer_unit_mismatch");
    const descriptor = await dataDescriptor({
      artifact: verified.artifact,
      centralBytes: verified.centralBytes.byteLength,
      centralSha256: verified.centralSha256,
      centralRunId,
      unitId: unit.unitId,
      completedAt: validated.manifest.completedAt,
      sequence,
      fingerprintKey,
      sourceArtifactKeys,
    });
    plans.push({
      source: verified,
      bytes: verified.centralBytes.byteLength,
      sha256: verified.centralSha256,
      descriptor,
      inventory: {
        artifactKey: `${verified.artifact.connectionId}/${verified.artifact.filename}`,
        sha256: verified.centralSha256,
        descriptorSha256: await descriptorSha256(descriptor),
      },
    });
  }
  const manifestDescriptorValue = await manifestDescriptor({
    manifest: validated.manifest,
    key: manifestKey,
    bytes: validated.centralManifestBytes.byteLength,
    sha256: validated.centralManifestSha256,
    sequence: validated.artifacts.length,
    fingerprintKey,
  });
  plans.push({
    source: null,
    bytes: validated.centralManifestBytes.byteLength,
    sha256: validated.centralManifestSha256,
    descriptor: manifestDescriptorValue,
    inventory: {
      artifactKey: "manifest.json",
      sha256: validated.centralManifestSha256,
      descriptorSha256: await descriptorSha256(manifestDescriptorValue),
    },
  });
  return plans;
}

async function dataDescriptor(options: {
  artifact: MyJcbArtifactManifest;
  centralBytes: number;
  centralSha256: string;
  centralRunId: number;
  unitId: number;
  completedAt: string;
  sequence: number;
  fingerprintKey: string;
  sourceArtifactKeys: Set<string>;
}): Promise<JsonObject> {
  const artifact = options.artifact;
  const html = artifact.mediaType.startsWith("text/html");
  const ledger = artifact.dataset === "credit-ledger";
  const discovery = artifact.dataset === "discovery";
  const providerResponse = artifact.dataset === "credit-past-months";
  const providerExport =
    artifact.dataset === "credit-csv" ||
    artifact.dataset === "credit-pdf" ||
    artifact.dataset === "credit-ofx";
  const parentKey = ledger
    ? `${artifact.connectionId}/credit-detail-${String(artifact.ordinal).padStart(2, "0")}.html`
    : null;
  const parentPresent = parentKey !== null && options.sourceArtifactKeys.has(parentKey);
  return normalizedDescriptor({
    artifactKey: `${artifact.connectionId}/${artifact.filename}`,
    artifactRole: html
      ? "sanitized_provider_capture"
      : providerResponse
        ? "provider_response"
        : providerExport
          ? "provider_export"
          : discovery
            ? "collector_summary"
            : "collector_derived",
    payloadFidelity: html
      ? "transformed"
      : providerResponse || providerExport
        ? "exact"
        : "generated",
    lineageDisposition: html
      ? "source_not_retained_for_security"
      : ledger
        ? parentPresent
          ? "linked"
          : "source_bytes_not_available"
        : discovery
          ? "source_bytes_not_available"
          : "not_applicable",
    dataset: artifact.dataset,
    formatId: formatId(artifact),
    formatVersion: validatedFormatVersion(artifact),
    declaredMediaType: artifact.mediaType.split(";", 1)[0]!,
    mediaTypeBasis: "manifest",
    fetchedAtMs: Date.parse(options.completedAt),
    fetchedAtBasis: "manifest",
    fetchUnitId: options.unitId,
    sequence: options.sequence,
    sha256: options.centralSha256,
    byteSize: options.centralBytes,
    storage: await storageOrigin(artifact.key, options.fingerprintKey),
    transformSteps: html
      ? [
          {
            stepIndex: 0,
            stepKind: "redacted",
            transformerId: "myjcb-sanitizer",
            transformerVersion: "v1",
          },
          {
            stepIndex: 1,
            stepKind: "reencoded",
            transformerId: "myjcb-sanitizer",
            transformerVersion: "v1",
          },
          {
            stepIndex: 2,
            stepKind: "redacted",
            transformerId: "myjcb-central-html-sanitizer",
            transformerVersion: "v2",
          },
          {
            stepIndex: 3,
            stepKind: "reencoded",
            transformerId: "myjcb-central-html-sanitizer",
            transformerVersion: "v2",
          },
        ]
      : ledger
        ? [
            {
              stepIndex: 0,
              stepKind: "extracted",
              transformerId: "myjcb-ledger-parser",
              transformerVersion: "v1",
            },
            {
              stepIndex: 1,
              stepKind: "generated",
              transformerId: "myjcb-ledger-parser",
              transformerVersion: "v1",
            },
          ]
        : discovery
          ? [
              {
                stepIndex: 0,
                stepKind: "extracted",
                transformerId: "myjcb-discovery-parser",
                transformerVersion: "v1",
              },
              {
                stepIndex: 1,
                stepKind: "generated",
                transformerId: "myjcb-discovery-parser",
                transformerVersion: "v1",
              },
            ]
          : [],
    relations: parentPresent
      ? [
          {
            parentRunId: options.centralRunId,
            parentArtifactKey: parentKey,
            relation: "input",
            transformerId: "myjcb-ledger-parser",
            transformerVersion: "v1",
          },
        ]
      : [],
  });
}

async function manifestDescriptor(options: {
  manifest: MyJcbManifest;
  key: string;
  bytes: number;
  sha256: string;
  sequence: number;
  fingerprintKey: string;
}): Promise<JsonObject> {
  return normalizedDescriptor({
    artifactKey: "manifest.json",
    artifactRole: "collector_manifest",
    payloadFidelity: "transformed",
    lineageDisposition: "source_not_retained_for_security",
    dataset: "collector-manifest",
    formatId: "myjcb-collector-manifest-json",
    formatVersion: "myjcb-central-manifest-v2",
    declaredMediaType: "application/json",
    mediaTypeBasis: "manifest",
    fetchedAtMs: Date.parse(options.manifest.completedAt),
    fetchedAtBasis: "manifest",
    fetchUnitId: null,
    sequence: options.sequence,
    sha256: options.sha256,
    byteSize: options.bytes,
    storage: await storageOrigin(options.key, options.fingerprintKey),
    transformSteps: [
      {
        stepIndex: 0,
        stepKind: "redacted",
        transformerId: "myjcb-central-manifest-sanitizer",
        transformerVersion: "v2",
      },
      {
        stepIndex: 1,
        stepKind: "reencoded",
        transformerId: "myjcb-central-manifest-sanitizer",
        transformerVersion: "v2",
      },
    ],
    relations: [],
  });
}

function normalizedDescriptor(input: {
  artifactKey: string;
  artifactRole: string;
  payloadFidelity: string;
  lineageDisposition: string;
  dataset: string;
  formatId: string;
  formatVersion: string;
  declaredMediaType: string;
  mediaTypeBasis: string;
  fetchedAtMs: number;
  fetchedAtBasis: string;
  fetchUnitId: number | null;
  sequence: number;
  sha256: string;
  byteSize: number;
  storage: JsonObject;
  transformSteps: JsonObject[];
  relations: JsonObject[];
}): JsonObject {
  return {
    artifactKey: input.artifactKey,
    artifactRole: input.artifactRole,
    payloadFidelity: input.payloadFidelity,
    containerKind: "single",
    lineageDisposition: input.lineageDisposition,
    dataset: input.dataset,
    formatId: input.formatId,
    formatVersion: input.formatVersion,
    declaredMediaType: input.declaredMediaType,
    mediaTypeBasis: input.mediaTypeBasis,
    fetchedAtMs: input.fetchedAtMs,
    fetchedAtBasis: input.fetchedAtBasis,
    fetchUnitId: input.fetchUnitId,
    pageGroupId: null,
    pageIndex: null,
    sequence: input.sequence,
    sha256: input.sha256,
    byteSize: input.byteSize,
    http: null,
    storage: input.storage,
    file: null,
    email: null,
    ranges: [],
    transformSteps: input.transformSteps,
    relations: input.relations,
  };
}

function formatId(artifact: MyJcbArtifactManifest): string {
  if (artifact.mediaType.startsWith("text/html"))
    return `myjcb-${artifact.dataset}-html-utf8-sanitized`;
  if (artifact.dataset === "credit-past-months") return "myjcb-credit-past-months-json-rpc";
  if (artifact.dataset === "credit-ledger") return "myjcb-credit-ledger-json";
  if (artifact.dataset === "discovery") return "myjcb-discovery-json";
  if (artifact.dataset === "credit-csv") return "myjcb-credit-statement-csv-cp932";
  if (artifact.dataset === "credit-pdf") return "myjcb-credit-statement-pdf";
  if (artifact.dataset === "credit-ofx") return "myjcb-credit-statement-ofx";
  throw new ImportError(409, "artifact_format_unmapped");
}

function validatedFormatVersion(artifact: MyJcbArtifactManifest): string {
  return artifact.mediaType.startsWith("text/html")
    ? "myjcb-central-sanitized-v2"
    : "myjcb-worker-poc-v1";
}

function safeConnectionFailureCode(connection: MyJcbConnection, manifest: MyJcbManifest): string {
  const failures = manifest.failures.filter(
    (failure) => failure.connectionId === connection.connectionId,
  );
  if (connection.status === "human-required") return "authentication-human-required";
  if (failures.some((failure) => failure.operation === "collect")) return "collection-failed";
  return "staging-write-failed";
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

async function assertExactPrefix(
  bucket: R2Bucket,
  prefix: string,
  expectedKeys: string[],
): Promise<void> {
  const actual: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, limit: 1_000, ...(cursor ? { cursor } : {}) });
    actual.push(...listed.objects.map((object) => object.key));
    cursor = listed.truncated ? listed.cursor : undefined;
    if (listed.truncated && !cursor) throw new ImportError(409, "prefix_cursor_missing");
    if (actual.length > MAX_PREFIX_OBJECTS)
      throw new ImportError(409, "prefix_inventory_too_large");
  } while (cursor);
  actual.sort(binaryCompare);
  const expected = [...expectedKeys].sort(binaryCompare);
  if (!sameStrings(actual, expected)) throw new ImportError(409, "prefix_inventory_mismatch");
}

async function encodeTransferState(state: TransferState, keyHex: string): Promise<string> {
  const payload = new TextEncoder().encode(canonicalJson(state as unknown as JsonValue));
  const signature = await hmacHex(
    keyHex,
    new TextEncoder().encode(`${TRANSFER_TOKEN_PREFIX}\0${base64Url(payload)}`),
  );
  return `${TRANSFER_TOKEN_PREFIX}.${base64Url(payload)}.${signature}`;
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
  if (!timingSafeHexEqual(expected, parts[2]!))
    throw new ImportError(400, "transfer_token_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(parts[1]!)));
  } catch {
    throw new ImportError(400, "transfer_token_invalid");
  }
  const input = record(parsed);
  exactKeys(input, [
    "v",
    "manifestKey",
    "centralRunId",
    "inventoryId",
    "inventorySha256",
    "units",
    "offset",
  ]);
  if (
    input.v !== 1 ||
    typeof input.manifestKey !== "string" ||
    !myJcbManifestKeyMatch(input.manifestKey) ||
    !positiveInteger(input.centralRunId) ||
    !positiveInteger(input.inventoryId) ||
    typeof input.inventorySha256 !== "string" ||
    !SHA256.test(input.inventorySha256) ||
    !Array.isArray(input.units) ||
    input.units.length < 1 ||
    input.units.length > 16 ||
    !Number.isSafeInteger(input.offset) ||
    (input.offset as number) < 0
  ) {
    throw new ImportError(400, "transfer_token_invalid");
  }
  const units = input.units.map((value): UnitReference => {
    const unit = record(value);
    exactKeys(unit, ["connectionId", "unitId"]);
    if (
      typeof unit.connectionId !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(unit.connectionId) ||
      !positiveInteger(unit.unitId)
    )
      throw new ImportError(400, "transfer_token_invalid");
    return { connectionId: unit.connectionId, unitId: unit.unitId as number };
  });
  return {
    v: 1,
    manifestKey: input.manifestKey,
    centralRunId: input.centralRunId as number,
    inventoryId: input.inventoryId as number,
    inventorySha256: input.inventorySha256,
    units,
    offset: input.offset as number,
  };
}

function validateTransferState(
  state: TransferState,
  manifest: MyJcbManifest,
  manifestKey: string,
  expectedArtifactCount: number,
): void {
  if (
    state.manifestKey !== manifestKey ||
    state.offset > expectedArtifactCount ||
    state.units.length !== manifest.connections.length ||
    state.units.some(
      (unit, index) => unit.connectionId !== manifest.connections[index]!.connectionId,
    ) ||
    new Set(state.units.map((unit) => unit.unitId)).size !== state.units.length
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

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("base64url_invalid");
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sortedInventory(plans: ArtifactPlan[]): CentralInventoryItem[] {
  return plans
    .map((plan) => plan.inventory)
    .sort((left, right) => binaryCompare(left.artifactKey, right.artifactKey));
}

function assertExactMetadata(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
  code: string,
): void {
  if (!actual) throw new ImportError(409, code);
  const left = Object.keys(actual).sort(binaryCompare);
  const right = Object.keys(expected).sort(binaryCompare);
  if (!sameStrings(left, right) || !right.every((key) => actual[key] === expected[key])) {
    throw new ImportError(409, code);
  }
}

function assertNativeSha256(object: R2ObjectBody, expected: string): void {
  const native = object.checksums.sha256;
  if (native && bytesHex(new Uint8Array(native)) !== expected) {
    throw new ImportError(409, "artifact_native_checksum_mismatch");
  }
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
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError("canonical numbers must be safe integers");
  }
  return value;
}

function record(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ImportError(400, "transfer_token_invalid");
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: string[]): void {
  const expected = [...keys].sort(binaryCompare);
  const actual = Object.keys(value).sort(binaryCompare);
  if (!sameStrings(actual, expected)) throw new ImportError(400, "transfer_token_invalid");
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

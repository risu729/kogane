import { CentralClient } from "./central";
import { ImportError } from "./error";
import { moneyForwardAccountKeys } from "./moneyforward-account-identity";
import {
  moneyForwardManifestKeyMatch,
  normalizeMoneyForwardManifestForCentral,
  parseMoneyForwardManifest,
  validateMoneyForwardArtifactPayload,
  type MoneyForwardArtifactManifest,
  type MoneyForwardManifest,
  type VerifiedMoneyForwardArtifact,
} from "./moneyforward-schema";
import type { CentralInventoryItem } from "./types";

const SOURCE = "moneyforward-me" as const;
const PRODUCER = "collector-r2-importer";
export const INGEST_CONTRACT_VERSION = "moneyforward-r2-v2";
const CENTRAL_CLIENT_ID = "collector-r2-moneyforward";
const STORAGE_CONTAINER = "kogane-moneyforward-collector-poc";
const STORAGE_TEMPLATE = "raw/moneyforward/{date}/{run-id}/{artifact}";
const FINGERPRINT_VERSION = "collector-r2-v1";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_RUN_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_ARTIFACTS = 833;
const MAX_CENTRAL_ARTIFACTS = MAX_SOURCE_ARTIFACTS + 1;
const MAX_PREFIX_OBJECTS = MAX_CENTRAL_ARTIFACTS;
export const MONEYFORWARD_TRANSFER_CHUNK_SIZE = 5;
const TRANSFER_TOKEN_PREFIX = "moneyforward-transfer-v3";
const TRANSFER_TOKEN_AAD = new TextEncoder().encode(TRANSFER_TOKEN_PREFIX);
const SHA256 = /^[0-9a-f]{64}$/u;

type JsonObject = Record<string, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface LoadedRun {
  manifest: MoneyForwardManifest;
  manifestByteSize: number;
  manifestSha256: string;
  centralManifestBytes: Uint8Array;
  centralManifestSha256: string;
  artifacts: VerifiedMoneyForwardArtifact[];
}

interface ArtifactPlan {
  source: VerifiedMoneyForwardArtifact | null;
  byteSize: number;
  sha256: string;
  descriptor: JsonObject;
  inventory: CentralInventoryItem;
}

interface TransferState {
  v: 2;
  manifestKey: string;
  sourceManifestSha256: string;
  centralRunId: number;
  unitId: number;
  accountUnitIds: Array<[number, number]>;
  inventoryId: number;
  inventorySha256: string;
  offset: number;
}

export type MoneyForwardImportResult = MoneyForwardImportDeferred | MoneyForwardImportSealed;

export interface MoneyForwardImportDeferred {
  source: typeof SOURCE;
  status: "deferred";
  reason: "worker_invocation_limit";
  artifactCount: number;
  nextOffset: number;
  continuation: string;
}

export interface MoneyForwardImportSealed {
  source: typeof SOURCE;
  status: "sealed";
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  finalChunkAllObjectsReused: boolean;
}

export interface AuditMoneyForwardResult {
  source: typeof SOURCE;
  schemaVersion: MoneyForwardManifest["schemaVersion"];
  status: MoneyForwardManifest["status"];
  artifactCount: number;
  accountDetailCount: number;
  monthlyFragmentCount: number;
}

export async function auditMoneyForwardRun(options: {
  bucket: R2Bucket;
  manifestKey: string;
}): Promise<AuditMoneyForwardResult> {
  const validated = await validateMoneyForwardRun(options.bucket, options.manifestKey);
  return {
    source: SOURCE,
    schemaVersion: validated.manifest.schemaVersion,
    status: validated.manifest.status,
    artifactCount: validated.artifacts.length,
    accountDetailCount: validated.manifest.accountDetailCount,
    monthlyFragmentCount: validated.manifest.monthlyFragmentCount,
  };
}

export async function moneyForwardTransferOffset(token: string, keyHex: string): Promise<number> {
  return (await decodeTransferState(token, keyHex)).offset;
}

export async function importMoneyForwardRun(options: {
  bucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  importerVersion: string;
  manifestKey: string;
  continuation?: string;
}): Promise<MoneyForwardImportResult> {
  const startedAtMs = Date.now();
  const attemptId = `attempt-${crypto.randomUUID()}`;
  let centralRunId: number | undefined;
  let acceptedArtifactCount = 0;
  let reusedArtifactCount = 0;
  let expectedArtifactCount = 0;
  let phase = "source_validation";
  try {
    const validated = await validateMoneyForwardRun(options.bucket, options.manifestKey);
    const accountKeys = await moneyForwardAccountKeys(validated.artifacts, options.fingerprintKey);
    if (
      validated.manifest.status === "success" &&
      accountKeys.size !== validated.manifest.accountDetailCount
    ) {
      throw new ImportError(409, "account_identity_incomplete");
    }
    expectedArtifactCount = validated.artifacts.length + 1;
    if (expectedArtifactCount > MAX_CENTRAL_ARTIFACTS) {
      throw new ImportError(409, "central_inventory_limit");
    }
    const central = new CentralClient(
      options.centralService,
      options.centralToken,
      CENTRAL_CLIENT_ID,
    );
    let state: TransferState;
    if (options.continuation) {
      state = await decodeTransferState(options.continuation, options.fingerprintKey);
      validateTransferState(
        state,
        options.manifestKey,
        validated.manifestSha256,
        expectedArtifactCount,
      );
      if (
        state.accountUnitIds.length !== accountKeys.size ||
        state.accountUnitIds.some(([ordinal]) => !accountKeys.has(ordinal))
      ) {
        throw new ImportError(400, "transfer_state_mismatch");
      }
      centralRunId = state.centralRunId;
    } else {
      phase = "central_create";
      centralRunId = await central.createRun({
        producerId: PRODUCER,
        sourceId: SOURCE,
        externalIdNamespace: validated.manifest.schemaVersion,
        externalSessionId: validated.manifest.runId,
        sourceRunKey: `full-snapshot-${INGEST_CONTRACT_VERSION}`,
      });
      phase = "unit_catalogue";
      const unitId = await central.addUnit(centralRunId, {
        unitKind: "collection",
        unitKey: "account",
        terminalReportRequired: true,
      });
      const accountUnitIds: Array<[number, number]> = [];
      for (const [ordinal, unitKey] of accountKeys) {
        accountUnitIds.push([
          ordinal,
          await central.addUnit(centralRunId, {
            unitKind: "account",
            unitKey,
            terminalReportRequired: true,
          }),
        ]);
      }
      phase = "inventory_plan";
      const initialPlans = await artifactPlans(
        validated,
        unitId,
        accountUnitIds,
        options.manifestKey,
        options.fingerprintKey,
      );
      const inventory = sortedInventory(initialPlans);
      const inventorySha256 = await sha256Hex(
        new TextEncoder().encode(canonicalJson(inventory as unknown as JsonValue)),
      );
      state = {
        v: 2,
        manifestKey: options.manifestKey,
        sourceManifestSha256: validated.manifestSha256,
        centralRunId,
        unitId,
        accountUnitIds,
        inventoryId: await central.beginInventory(centralRunId, inventorySha256, inventory.length),
        inventorySha256,
        offset: 0,
      };
    }

    phase = "inventory_plan";
    const plans = await artifactPlans(
      validated,
      state.unitId,
      state.accountUnitIds,
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
    const end = Math.min(state.offset + MONEYFORWARD_TRANSFER_CHUNK_SIZE, plans.length);
    if (end <= state.offset) throw new ImportError(409, "transfer_cursor_did_not_advance");
    const chunkInventory: CentralInventoryItem[] = [];
    for (const plan of plans.slice(state.offset, end)) {
      phase = "object_upload";
      const current = await currentPlanBytes(options.bucket, plan, validated, options.manifestKey);
      const reused = await central.uploadObject(state.centralRunId, plan.sha256, current);
      if (reused) reusedArtifactCount += 1;
      else acceptedArtifactCount += 1;
      phase = "artifact_catalogue";
      const actualDescriptorSha256 = await central.addArtifact(state.centralRunId, plan.descriptor);
      if (actualDescriptorSha256 !== plan.inventory.descriptorSha256) {
        throw new Error("central_descriptor_mismatch");
      }
      chunkInventory.push(plan.inventory);
    }
    phase = "inventory_catalogue";
    await central.addInventoryItems(state.centralRunId, state.inventoryId, chunkInventory);
    if (end < plans.length) {
      const nextState = { ...state, offset: end };
      return {
        source: SOURCE,
        status: "deferred",
        reason: "worker_invocation_limit",
        artifactCount: plans.length,
        nextOffset: end,
        continuation: await encodeTransferState(nextState, options.fingerprintKey),
      };
    }

    phase = "unit_report";
    for (const unitId of [state.unitId, ...state.accountUnitIds.map(([, id]) => id)]) {
      await central.addUnitReport(unitId, {
        reportKey: "terminal",
        reportKind: "terminal",
        producerStatus: validated.manifest.status,
        normalizedOutcome: validated.manifest.status,
        startedAtMs: Date.parse(validated.manifest.startedAt),
        startedAtBasis: "manifest",
        completedAtMs: Date.parse(validated.manifest.completedAt),
        completedAtBasis: "manifest",
        declaredArtifactCount: plans.filter((plan) => plan.descriptor.fetchUnitId === unitId)
          .length,
        artifactCountScope: "direct",
        ...(validated.manifest.status === "success"
          ? {}
          : { safeFailureCode: safeFailureCode(validated.manifest) }),
      });
    }
    phase = "run_report";
    await central.addRunReport(state.centralRunId, {
      reportKey: "terminal",
      reportKind: "terminal",
      producerVersion: INGEST_CONTRACT_VERSION,
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
        // Attempt reporting is best effort; preserve the original strict error.
      }
    }
    throw error;
  }
}

export async function validateMoneyForwardRun(
  bucket: R2Bucket,
  manifestKey: string,
): Promise<LoadedRun> {
  const manifestObject = await bucket.get(manifestKey);
  if (!manifestObject) throw new ImportError(404, "manifest_not_found");
  if (manifestObject.size > MAX_MANIFEST_BYTES) throw new ImportError(413, "manifest_too_large");
  if (manifestObject.httpMetadata?.contentType !== "application/json") {
    throw new ImportError(409, "manifest_content_type_mismatch");
  }
  const manifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
  const manifestSha256 = await sha256Hex(manifestBytes);
  assertNativeSha256(manifestObject, manifestSha256);
  const manifest = parseMoneyForwardManifest(manifestBytes, manifestKey);
  assertExactMetadata(
    manifestObject.customMetadata,
    { source: manifest.source, status: manifest.status, runId: manifest.runId },
    "manifest_metadata_mismatch",
  );
  const expectedKeys = [...manifest.artifacts.map((artifact) => artifact.key), manifestKey];
  const prefix = manifestKey.slice(0, -"manifest.json".length);
  await assertExactPrefix(bucket, prefix, expectedKeys);
  const artifacts: VerifiedMoneyForwardArtifact[] = [];
  let runBytes = manifestBytes.byteLength;
  for (const artifact of manifest.artifacts) {
    const bytes = await readVerifiedArtifact(bucket, artifact);
    runBytes += bytes.byteLength;
    if (runBytes > MAX_RUN_BYTES) throw new ImportError(413, "run_too_large");
    validateMoneyForwardArtifactPayload(artifact, bytes, manifest);
    artifacts.push({ artifact, bytes });
  }
  await assertExactPrefix(bucket, prefix, expectedKeys);
  const centralManifestBytes = normalizeMoneyForwardManifestForCentral(manifest);
  return {
    manifest,
    manifestByteSize: manifestBytes.byteLength,
    manifestSha256,
    centralManifestBytes,
    centralManifestSha256: await sha256Hex(centralManifestBytes),
    artifacts,
  };
}

async function readVerifiedArtifact(
  bucket: R2Bucket,
  artifact: MoneyForwardArtifactManifest,
): Promise<Uint8Array> {
  const object = await bucket.get(artifact.key);
  if (!object) throw new ImportError(409, "artifact_missing");
  if (object.size !== artifact.bytes) throw new ImportError(409, "artifact_size_mismatch");
  if (object.httpMetadata?.contentType !== artifact.mediaType) {
    throw new ImportError(409, "artifact_content_type_mismatch");
  }
  assertExactMetadata(
    object.customMetadata,
    { dataset: artifact.dataset, sha256: artifact.sha256 },
    "artifact_metadata_mismatch",
  );
  assertNativeSha256(object, artifact.sha256);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256Hex(bytes)) !== artifact.sha256) {
    throw new ImportError(409, "artifact_checksum_mismatch");
  }
  return bytes;
}

async function currentPlanBytes(
  bucket: R2Bucket,
  plan: ArtifactPlan,
  validated: LoadedRun,
  manifestKey: string,
): Promise<Uint8Array> {
  const current = plan.source
    ? await readVerifiedArtifact(bucket, plan.source.artifact)
    : await readCurrentCentralManifest(bucket, manifestKey, validated);
  if (plan.source)
    validateMoneyForwardArtifactPayload(plan.source.artifact, current, validated.manifest);
  if (current.byteLength !== plan.byteSize || (await sha256Hex(current)) !== plan.sha256) {
    throw new ImportError(409, "artifact_changed_during_import");
  }
  return current;
}

async function readCurrentCentralManifest(
  bucket: R2Bucket,
  manifestKey: string,
  validated: LoadedRun,
): Promise<Uint8Array> {
  const object = await requiredObject(bucket, manifestKey);
  if (
    object.size !== validated.manifestByteSize ||
    object.httpMetadata?.contentType !== "application/json"
  ) {
    throw new ImportError(409, "artifact_changed_during_import");
  }
  assertExactMetadata(
    object.customMetadata,
    {
      source: validated.manifest.source,
      status: validated.manifest.status,
      runId: validated.manifest.runId,
    },
    "artifact_changed_during_import",
  );
  assertNativeSha256(object, validated.manifestSha256);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256Hex(bytes)) !== validated.manifestSha256) {
    throw new ImportError(409, "artifact_changed_during_import");
  }
  return normalizeMoneyForwardManifestForCentral(parseMoneyForwardManifest(bytes, manifestKey));
}

async function requiredObject(bucket: R2Bucket, key: string): Promise<R2ObjectBody> {
  const object = await bucket.get(key);
  if (!object) throw new ImportError(409, "artifact_changed_during_import");
  return object;
}

async function artifactPlans(
  validated: LoadedRun,
  unitId: number,
  accountUnitIds: Array<[number, number]>,
  manifestKey: string,
  fingerprintKey: string,
): Promise<ArtifactPlan[]> {
  const plans: ArtifactPlan[] = [];
  for (const [sequence, verified] of validated.artifacts.entries()) {
    const descriptor = await dataDescriptor({
      artifact: verified.artifact,
      unitId:
        accountUnitIds.find(([ordinal]) => ordinal === verified.artifact.accountOrdinal)?.[1] ??
        unitId,
      completedAt: validated.manifest.completedAt,
      sequence,
      fingerprintKey,
    });
    plans.push({
      source: verified,
      byteSize: verified.bytes.byteLength,
      sha256: verified.artifact.sha256,
      descriptor,
      inventory: {
        artifactKey: verified.artifact.filename,
        sha256: verified.artifact.sha256,
        descriptorSha256: await descriptorSha256(descriptor),
      },
    });
  }
  const descriptor = await manifestDescriptor({
    manifest: validated.manifest,
    manifestKey,
    byteSize: validated.centralManifestBytes.byteLength,
    sha256: validated.centralManifestSha256,
    sequence: plans.length,
    fingerprintKey,
  });
  plans.push({
    source: null,
    byteSize: validated.centralManifestBytes.byteLength,
    sha256: validated.centralManifestSha256,
    descriptor,
    inventory: {
      artifactKey: "manifest.json",
      sha256: validated.centralManifestSha256,
      descriptorSha256: await descriptorSha256(descriptor),
    },
  });
  return plans;
}

async function dataDescriptor(options: {
  artifact: MoneyForwardArtifactManifest;
  unitId: number;
  completedAt: string;
  sequence: number;
  fingerprintKey: string;
}): Promise<JsonObject> {
  const artifact = options.artifact;
  return normalizedDescriptor({
    artifactKey: artifact.filename,
    artifactRole: "provider_response",
    payloadFidelity: "exact",
    lineageDisposition: "not_applicable",
    dataset: artifact.dataset,
    formatId:
      artifact.kind === "accounts-index"
        ? "moneyforward-accounts-index-html"
        : artifact.kind === "account-detail"
          ? "moneyforward-account-detail-html"
          : "moneyforward-monthly-transactions-html-fragment",
    formatVersion: "moneyforward-worker-poc-v1",
    declaredMediaType: "text/html",
    mediaTypeBasis: "manifest",
    fetchedAtMs: Date.parse(options.completedAt),
    fetchedAtBasis: "manifest",
    fetchUnitId: options.unitId,
    sequence: options.sequence,
    sha256: artifact.sha256,
    byteSize: artifact.bytes,
    storage: await storageOrigin(artifact.key, options.fingerprintKey),
  });
}

async function manifestDescriptor(options: {
  manifest: MoneyForwardManifest;
  manifestKey: string;
  byteSize: number;
  sha256: string;
  sequence: number;
  fingerprintKey: string;
}): Promise<JsonObject> {
  return normalizedDescriptor({
    artifactKey: "manifest.json",
    artifactRole: "collector_manifest",
    payloadFidelity: "generated",
    lineageDisposition: "source_bytes_not_available",
    dataset: "collector-manifest",
    formatId: "moneyforward-collector-manifest-json",
    formatVersion: "moneyforward-central-manifest-v1",
    declaredMediaType: "application/json",
    mediaTypeBasis: "manifest",
    fetchedAtMs: Date.parse(options.manifest.completedAt),
    fetchedAtBasis: "manifest",
    fetchUnitId: null,
    sequence: options.sequence,
    sha256: options.sha256,
    byteSize: options.byteSize,
    storage: await storageOrigin(options.manifestKey, options.fingerprintKey),
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
}): JsonObject {
  return {
    ...input,
    containerKind: "single",
    pageGroupId: null,
    pageIndex: null,
    http: null,
    file: null,
    email: null,
    ranges: [],
    transformSteps: [],
    relations: [],
  };
}

function safeFailureCode(manifest: MoneyForwardManifest): string {
  return manifest.failures.some((failure) => failure.operation === "collect")
    ? "collection-failed"
    : "staging-write-failed";
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
    const next = listed.truncated ? listed.cursor : undefined;
    if (listed.truncated && !next) throw new ImportError(409, "prefix_cursor_missing");
    if (listed.truncated && next === cursor) {
      throw new ImportError(409, "prefix_cursor_did_not_advance");
    }
    cursor = next;
    if (actual.length > MAX_PREFIX_OBJECTS)
      throw new ImportError(409, "prefix_inventory_too_large");
  } while (cursor);
  actual.sort(binaryCompare);
  const expected = [...expectedKeys].sort(binaryCompare);
  if (!sameStrings(actual, expected)) throw new ImportError(409, "prefix_inventory_mismatch");
}

async function encodeTransferState(state: TransferState, keyHex: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await transferEncryptionKey(keyHex);
  const plaintext = new TextEncoder().encode(canonicalJson(state as unknown as JsonValue));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: ownedArrayBuffer(iv),
      additionalData: ownedArrayBuffer(TRANSFER_TOKEN_AAD),
      tagLength: 128,
    },
    key,
    ownedArrayBuffer(plaintext),
  );
  return `${TRANSFER_TOKEN_PREFIX}.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function decodeTransferState(token: string, keyHex: string): Promise<TransferState> {
  if (token.length > 8_000) throw new ImportError(400, "transfer_token_invalid");
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts[0] !== TRANSFER_TOKEN_PREFIX ||
    !/^[A-Za-z0-9_-]{16}$/u.test(parts[1]!) ||
    !/^[A-Za-z0-9_-]{22,7900}$/u.test(parts[2]!)
  ) {
    throw new ImportError(400, "transfer_token_invalid");
  }
  const key = await transferEncryptionKey(keyHex);
  let parsed: unknown;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ownedArrayBuffer(fromBase64Url(parts[1]!)),
        additionalData: ownedArrayBuffer(TRANSFER_TOKEN_AAD),
        tagLength: 128,
      },
      key,
      ownedArrayBuffer(fromBase64Url(parts[2]!)),
    );
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    throw new ImportError(400, "transfer_token_invalid");
  }
  const input = record(parsed);
  exactKeys(input, [
    "v",
    "manifestKey",
    "sourceManifestSha256",
    "centralRunId",
    "unitId",
    "accountUnitIds",
    "inventoryId",
    "inventorySha256",
    "offset",
  ]);
  if (
    input.v !== 2 ||
    typeof input.manifestKey !== "string" ||
    !moneyForwardManifestKeyMatch(input.manifestKey) ||
    typeof input.sourceManifestSha256 !== "string" ||
    !SHA256.test(input.sourceManifestSha256) ||
    !positiveInteger(input.centralRunId) ||
    !positiveInteger(input.unitId) ||
    !validAccountUnitIds(input.accountUnitIds, input.unitId) ||
    !positiveInteger(input.inventoryId) ||
    typeof input.inventorySha256 !== "string" ||
    !SHA256.test(input.inventorySha256) ||
    !positiveInteger(input.offset) ||
    (input.offset as number) > MAX_CENTRAL_ARTIFACTS
  ) {
    throw new ImportError(400, "transfer_token_invalid");
  }
  return input as unknown as TransferState;
}

async function transferEncryptionKey(keyHex: string): Promise<CryptoKey> {
  if (!SHA256.test(keyHex)) throw new ImportError(500, "fingerprint_configuration_invalid");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${TRANSFER_TOKEN_PREFIX}\0${keyHex}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function validAccountUnitIds(value: unknown, rootUnitId: unknown): boolean {
  if (!Array.isArray(value) || value.length > 64) return false;
  const ordinals = new Set<number>();
  const units = new Set<unknown>([rootUnitId]);
  return value.every((entry: unknown) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !positiveInteger(entry[0]) ||
      entry[0] > 64 ||
      !positiveInteger(entry[1]) ||
      ordinals.has(entry[0]) ||
      units.has(entry[1])
    )
      return false;
    ordinals.add(entry[0]);
    units.add(entry[1]);
    return true;
  });
}

function validateTransferState(
  state: TransferState,
  manifestKey: string,
  sourceManifestSha256: string,
  expectedArtifactCount: number,
): void {
  if (
    state.manifestKey !== manifestKey ||
    state.sourceManifestSha256 !== sourceManifestSha256 ||
    state.offset >= expectedArtifactCount
  ) {
    throw new ImportError(400, "transfer_state_mismatch");
  }
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
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64Url(bytes) !== value) throw new Error("base64url_invalid");
  return bytes;
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

export function descriptorSha256(descriptor: JsonObject): Promise<string> {
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

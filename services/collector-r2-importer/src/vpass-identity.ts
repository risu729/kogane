import { CentralClient, centralDescriptorSha256 } from "./central";
import type {
  AddUnitReportRequest,
  ArtifactRequest,
} from "../../../packages/evidence-contract/src/index";
import { ImportError } from "./error";
import { validateVpassRun } from "./vpass";

export const VPASS_BINDING_CONTRACT = "vpass-card-binding-v1";
const SOURCE = "vpass";
const PRODUCER = "collector-r2-importer";
const IDENTITY = /^vpass-card-v1-[0-9a-f]{64}$/u;
type ObjectValue = Record<string, unknown>;
export interface VpassCardBinding {
  schemaVersion: typeof VPASS_BINDING_CONTRACT;
  accountIdentity: string;
  fingerprintKeyVersion: "collector-r2-v1";
  sourceSession: string;
  sourceNamespace: string;
  sourceCardOrdinal: string;
  snapshotSha256: string;
  manifestSha256: string;
  sourceObjectFingerprint: string;
  checks: { selectedCardDescriptor: true; selectionDiscoveryCardCode: true };
}
interface DerivedBinding {
  binding: VpassCardBinding;
  startedAt: string;
  completedAt: string;
}
export type VpassBindingResult =
  | { status: "sealed"; bindingRunId: number; artifactCount: 1 }
  | { status: "unavailable"; reason: "source-layout-has-no-selection-identity" };

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ImportError(409, "vpass_binding_shape_invalid");
  return value as ObjectValue;
}
function envelope(value: unknown): ObjectValue {
  if (typeof value !== "string") throw new ImportError(409, "vpass_binding_envelope_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ImportError(409, "vpass_binding_json_invalid");
  }
  const result = object(parsed);
  const code = object(result.header).resultCode;
  if (code !== 0 && code !== "0" && code !== "0000")
    throw new ImportError(409, "vpass_binding_response_failed");
  return result;
}
function descriptor(value: unknown, length: number): string {
  if (typeof value !== "string" || value.length !== length || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new ImportError(409, "vpass_binding_identifier_invalid");
  return value;
}
async function hmac(keyHex: string, value: string): Promise<string> {
  if (!/^[0-9a-f]{64}$/u.test(keyHex))
    throw new ImportError(500, "fingerprint_configuration_invalid");
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(keyHex.match(/../gu)!, (v) => Number.parseInt(v, 16)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function hash(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
}
async function read(bucket: R2Bucket, key: string): Promise<{ value: ObjectValue; sha: string }> {
  const obj = await bucket.get(key);
  if (
    !obj ||
    obj.size < 1 ||
    obj.size > 8 * 1024 * 1024 ||
    obj.httpMetadata?.contentType !== "application/json; charset=utf-8" ||
    Object.keys(obj.customMetadata ?? {}).length
  )
    throw new ImportError(409, "vpass_binding_source_invalid");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const sha = await hash(bytes);
  if (bytes.length !== obj.size || (obj.checksums.sha256 && hex(obj.checksums.sha256) !== sha))
    throw new ImportError(409, "vpass_binding_source_integrity");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ImportError(409, "vpass_binding_json_invalid");
  }
  return { value: object(parsed), sha };
}

/** Original tuple stays within this module. Rotating dropdown selectors never form identity. */
export async function deriveVpassCardBinding(
  bucket: R2Bucket,
  recordKey: string,
  fingerprintKey: string,
): Promise<DerivedBinding | null> {
  const match =
    /^vpass\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\/(card-\d{3})\/manifest\.json$/u.exec(
      recordKey,
    );
  // Full validator rejects malformed keys and validates legacy evidence, without inventing a binding.
  if (!match) {
    await validateVpassRun(bucket, recordKey);
    return null;
  }
  const snapshotKey = recordKey.replace(/manifest\.json$/u, "snapshot.json");
  const beforeManifest = await read(bucket, recordKey),
    beforeSnapshot = await read(bucket, snapshotKey);
  const validated = await validateVpassRun(bucket, recordKey);
  const afterManifest = await read(bucket, recordKey),
    afterSnapshot = await read(bucket, snapshotKey);
  if (beforeManifest.sha !== afterManifest.sha || beforeSnapshot.sha !== afterSnapshot.sha)
    throw new ImportError(409, "vpass_binding_source_changed");
  if (
    validated.record.status !== "success" ||
    validated.record.schemaVersion !== "vpass-worker-card-v1"
  )
    return null;
  const snapshot = beforeSnapshot.value;
  const listEnvelope = envelope(snapshot.cardListRawJson);
  const entries = object(
    object(object(listEnvelope.body).content).DropdownListInitDisplayServiceBean,
  ).multiCardInfoList;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 999)
    throw new ImportError(409, "vpass_binding_card_inventory_invalid");
  const cards = entries.map(object);
  const names = cards.map((c) => c.name),
    selectors = cards.map((c) => c.value);
  if (
    names.some((n) => typeof n !== "string" || n.length < 1) ||
    selectors.some((v) => typeof v !== "string" || v.length < 1) ||
    new Set(names).size !== cards.length ||
    new Set(selectors).size !== cards.length
  )
    throw new ImportError(409, "vpass_binding_card_inventory_ambiguous");
  const ordinal = Number(match[5]!.slice(5));
  if (snapshot.selectedCardIndex !== ordinal || snapshot.runId !== match[4])
    throw new ImportError(409, "vpass_binding_scope_mismatch");
  const selectionValue = object(envelope(snapshot.selectCardRawJson).header).vpSessionBean;
  const discoveryValue = object(envelope(snapshot.webMeisaiTopRawJson).header).vpSessionBean;
  if (selectionValue === undefined && discoveryValue === undefined) return null;
  const selection = object(selectionValue);
  const discovery = object(discoveryValue);
  const externalId = descriptor(selection.externalId, 32),
    globalid = descriptor(selection.globalid, 32),
    cardCode = descriptor(selection.cardCode, 13);
  if (
    discovery.cardCode !== cardCode ||
    typeof selection.cardName !== "string" ||
    selection.cardName !== discovery.cardName ||
    selection.cardName !== cards[ordinal - 1]?.name
  )
    throw new ImportError(409, "vpass_binding_selection_discovery_mismatch");
  const accountIdentity = `vpass-card-v1-${await hmac(fingerprintKey, JSON.stringify([VPASS_BINDING_CONTRACT, externalId, globalid, cardCode]))}`;
  if (!IDENTITY.test(accountIdentity)) throw new ImportError(500, "vpass_binding_identity_invalid");
  return {
    binding: {
      schemaVersion: VPASS_BINDING_CONTRACT,
      accountIdentity,
      fingerprintKeyVersion: "collector-r2-v1",
      sourceSession: validated.record.runId,
      sourceNamespace: validated.record.schemaVersion,
      sourceCardOrdinal: validated.record.cardLabel,
      snapshotSha256: beforeSnapshot.sha,
      manifestSha256: beforeManifest.sha,
      sourceObjectFingerprint: await hmac(fingerprintKey, snapshotKey),
      checks: { selectedCardDescriptor: true, selectionDiscoveryCardCode: true },
    },
    startedAt: validated.record.startedAt,
    completedAt: validated.record.completedAt,
  };
}

/** Seven sequential central requests; no new financial artifacts or provider login. */
export async function importVpassCardBinding(options: {
  bucket: R2Bucket;
  centralService: Fetcher;
  centralToken: string;
  fingerprintKey: string;
  recordKey: string;
}): Promise<VpassBindingResult> {
  const derived = await deriveVpassCardBinding(
    options.bucket,
    options.recordKey,
    options.fingerprintKey,
  );
  if (!derived) return { status: "unavailable", reason: "source-layout-has-no-selection-identity" };
  const { binding } = derived;
  const central = new CentralClient(
    options.centralService,
    options.centralToken,
    "collector-r2-vpass",
  );
  const startedAtMs = Date.now();
  const runId = await central.createRun({
    producerId: PRODUCER,
    sourceId: SOURCE,
    externalIdNamespace: binding.sourceNamespace,
    externalSessionId: binding.sourceSession,
    sourceRunKey: `${binding.sourceCardOrdinal}-${VPASS_BINDING_CONTRACT}`,
  });
  const unitId = await central.addUnit(runId, {
    unitKind: "card",
    unitKey: binding.accountIdentity,
    terminalReportRequired: true,
  });
  const bytes = new TextEncoder().encode(`${JSON.stringify(binding)}\n`),
    sha256 = await hash(bytes);
  await central.uploadObject(runId, sha256, bytes);
  const descriptorBody: ArtifactRequest = {
    artifactKey: "card-identity-binding.json",
    artifactRole: "collector_derived",
    payloadFidelity: "transformed",
    containerKind: "single",
    lineageDisposition: "source_not_retained_for_security",
    dataset: "card-identity-binding",
    formatId: "vpass-card-identity-binding-json",
    formatVersion: "1",
    declaredMediaType: "application/json",
    mediaTypeBasis: "operator",
    fetchedAtMs: Date.parse(derived.completedAt),
    fetchedAtBasis: "manifest",
    fetchUnitId: unitId,
    pageGroupId: null,
    pageIndex: null,
    sequence: 0,
    sha256,
    byteSize: bytes.byteLength,
    http: null,
    storage: {
      storageKind: "r2",
      containerName: "kogane-vpass-collector-poc",
      objectKeyTemplate: "vpass/{date}/{run-id}/{artifact}",
      objectKeyFingerprint: binding.sourceObjectFingerprint,
      fingerprintKeyVersion: binding.fingerprintKeyVersion,
      redactionVersion: "v1",
      objectVersion: null,
      etag: null,
      lastModifiedAtMs: null,
      lastModifiedAtBasis: null,
    },
    file: null,
    email: null,
    ranges: [],
    transformSteps: [
      {
        stepIndex: 0,
        stepKind: "extracted",
        transformerId: "vpass-card-binding",
        transformerVersion: "v1",
      },
      {
        stepIndex: 1,
        stepKind: "redacted",
        transformerId: "vpass-card-binding",
        transformerVersion: "v1",
      },
    ],
    relations: [],
  };
  const descriptorSha256 = await central.addArtifact(runId, descriptorBody);
  if (descriptorSha256 !== (await centralDescriptorSha256(descriptorBody)))
    throw new ImportError(409, "vpass_binding_descriptor_mismatch");
  const report = {
    reportKey: "terminal",
    reportKind: "terminal",
    producerStatus: "success",
    normalizedOutcome: "success",
    startedAtMs: Date.parse(derived.startedAt),
    startedAtBasis: "manifest",
    completedAtMs: Date.parse(derived.completedAt),
    completedAtBasis: "manifest",
    declaredArtifactCount: 1,
  } satisfies Omit<AddUnitReportRequest, "artifactCountScope">;
  await central.addUnitReport(unitId, { ...report, artifactCountScope: "direct" });
  await central.addRunReport(runId, {
    ...report,
    artifactCountScope: "all_catalogued",
    producerVersion: VPASS_BINDING_CONTRACT,
    manifestSchemaVersion: binding.schemaVersion,
  });
  await central.seal(
    runId,
    [{ artifactKey: descriptorBody.artifactKey, sha256, descriptorSha256 }],
    `attempt-${crypto.randomUUID()}`,
    startedAtMs,
    "operator",
  );
  return { status: "sealed", bindingRunId: runId, artifactCount: 1 };
}

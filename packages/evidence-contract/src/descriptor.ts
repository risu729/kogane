// Artifact descriptor contract, version "descriptor-v1".
//
//   unknown ──parseArtifactRequest──▶ ValidatedArtifactRequest
//   ArtifactRequest ──normalizeDescriptorV1──▶ CanonicalDescriptorV1
//   CanonicalDescriptorV1 ──encodeDescriptorV1──▶ bytes ──descriptorDigestV1──▶ sha256
//
// The normalizer and encoder define persisted descriptor_sha256 values and
// are frozen: see docs/evidence-contract.md before touching anything here.
import { descriptorDigestV1 } from "./digest";
import { binaryCompare, encodeCanonicalV1, isRecord, type JsonValue } from "./json";
import {
  parseOrigins,
  type EmailOrigin,
  type EmailOriginRequest,
  type FileOrigin,
  type FileOriginRequest,
  type HttpOrigin,
  type HttpOriginRequest,
  type StorageOrigin,
  type StorageOriginRequest,
} from "./origins";
import {
  parseRangeFields,
  RANGE_FIELD_KEYS,
  type RangeFields,
  type RangeFieldsRequest,
} from "./ranges";
import {
  ContractError,
  ID,
  OPAQUE,
  SHA256,
  arrayValue,
  enumValue,
  exactKeys,
  integerValue,
  object,
  rejectDuplicate,
  requiredEnum,
  requiredInteger,
  requiredString,
  stringValue,
} from "./validate";

export type ArtifactRole =
  | "provider_response"
  | "provider_export"
  | "provider_document"
  | "provider_message"
  | "collector_manifest"
  | "collector_error"
  | "collector_summary"
  | "collector_derived"
  | "sanitized_provider_capture"
  | "user_capture";
export type PayloadFidelity =
  | "exact"
  | "transport_decoded"
  | "transformed"
  | "generated"
  | "unknown";
export type ContainerKind = "single" | "bundle" | "archive" | "multipart" | "unknown";
export type LineageDisposition =
  | "linked"
  | "embedded_source_bytes"
  | "source_not_retained_for_security"
  | "source_bytes_not_available"
  | "not_applicable";
export type MediaTypeBasis =
  | "response_header"
  | "manifest"
  | "file_metadata"
  | "operator"
  | "unknown";
export type FetchedAtBasis =
  | "source"
  | "response"
  | "manifest"
  | "file_metadata"
  | "operator"
  | "unknown";
export type TransformStepKind =
  | "transport_decoded"
  | "decrypted"
  | "redacted"
  | "reencoded"
  | "bundled"
  | "rendered"
  | "extracted"
  | "generated";
export type RelationKind = "input" | "described_by";

export interface ArtifactRangeRequest extends RangeFieldsRequest {
  rangeKey: string;
}
export interface ArtifactRange extends RangeFields {
  rangeKey: string;
}
export interface TransformStepRequest {
  stepIndex: number;
  stepKind: TransformStepKind;
  transformerId: string;
  transformerVersion: string;
}
export type TransformStep = TransformStepRequest;
export interface RelationClaimRequest {
  /** Omitted means the run the artifact is being added to. */
  parentRunId?: number | null;
  parentArtifactKey: string;
  relation: RelationKind;
  transformerId: string;
  transformerVersion: string;
}
export interface RelationClaim {
  parentRunId: number;
  parentArtifactKey: string;
  relation: RelationKind;
  transformerId: string;
  transformerVersion: string;
}

/**
 * External artifact request as accepted by POST /v1/runs/{runId}/artifacts.
 * Optional keys may be omitted or null. Every key is hash-relevant.
 */
export interface ArtifactRequest {
  artifactKey: string;
  artifactRole: ArtifactRole;
  payloadFidelity: PayloadFidelity;
  /** Omitted means "single" on the server. */
  containerKind?: ContainerKind | null;
  lineageDisposition: LineageDisposition;
  dataset?: string | null;
  formatId?: string | null;
  formatVersion?: string | null;
  declaredMediaType?: string | null;
  mediaTypeBasis?: MediaTypeBasis | null;
  fetchedAtMs?: number | null;
  fetchedAtBasis?: FetchedAtBasis | null;
  fetchUnitId?: number | null;
  pageGroupId?: number | null;
  pageIndex?: number | null;
  sequence?: number | null;
  sha256: string;
  byteSize: number;
  http?: HttpOriginRequest | null;
  storage?: StorageOriginRequest | null;
  file?: FileOriginRequest | null;
  email?: EmailOriginRequest | null;
  ranges?: ArtifactRangeRequest[];
  transformSteps?: TransformStepRequest[];
  relations?: RelationClaimRequest[];
}

/** Artifact request after server validation: every key present, defaults applied, arrays sorted. */
export interface ValidatedArtifactRequest {
  artifactKey: string;
  artifactRole: ArtifactRole;
  payloadFidelity: PayloadFidelity;
  containerKind: ContainerKind;
  lineageDisposition: LineageDisposition;
  dataset: string | null;
  formatId: string | null;
  formatVersion: string | null;
  declaredMediaType: string | null;
  mediaTypeBasis: MediaTypeBasis | null;
  fetchedAtMs: number | null;
  fetchedAtBasis: FetchedAtBasis | null;
  fetchUnitId: number | null;
  pageGroupId: number | null;
  pageIndex: number | null;
  sequence: number | null;
  sha256: string;
  byteSize: number;
  http: HttpOrigin | null;
  storage: StorageOrigin | null;
  file: FileOrigin | null;
  email: EmailOrigin | null;
  ranges: ArtifactRange[];
  transformSteps: TransformStep[];
  relations: RelationClaim[];
}

type OriginSlot<T> = Exclude<T, undefined> | null;

/**
 * Hashed shape of an artifact descriptor. For a validated request every key
 * is present; for a raw client request only the keys named in
 * {@link normalizeDescriptorV1} are filled and the rest stay as given.
 */
export type CanonicalDescriptorV1<T extends ArtifactRequest = ValidatedArtifactRequest> = Omit<
  T,
  | "http"
  | "storage"
  | "file"
  | "email"
  | "fetchUnitId"
  | "pageGroupId"
  | "pageIndex"
  | "ranges"
  | "transformSteps"
  | "relations"
> & {
  fetchUnitId: number | null;
  pageGroupId: number | null;
  pageIndex: number | null;
  origins: {
    http: OriginSlot<T["http"]>;
    storage: StorageOrigin | null;
    file: OriginSlot<T["file"]>;
    email: OriginSlot<T["email"]>;
  };
  ranges: Exclude<T["ranges"], undefined>;
  transformSteps: Exclude<T["transformSteps"], undefined>;
  relations: Exclude<T["relations"], undefined>;
};

export const ARTIFACT_REQUEST_KEYS = [
  "artifactKey",
  "artifactRole",
  "payloadFidelity",
  "containerKind",
  "lineageDisposition",
  "dataset",
  "formatId",
  "formatVersion",
  "declaredMediaType",
  "mediaTypeBasis",
  "fetchedAtMs",
  "fetchedAtBasis",
  "fetchUnitId",
  "pageGroupId",
  "pageIndex",
  "sequence",
  "sha256",
  "byteSize",
  "http",
  "storage",
  "file",
  "email",
  "ranges",
  "transformSteps",
  "relations",
] as const;

/**
 * Rebuild a storage origin in the exact shape raw-evidence persists: the ten
 * known keys, optional ones null-filled, anything else dropped. Moved
 * verbatim from the importer's central.ts; frozen for descriptor-v1.
 */
export function normalizeStorageOriginV1(
  value: StorageOriginRequest | null | undefined,
): StorageOrigin | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new TypeError("storage origin must be an object");
  return {
    storageKind: value.storageKind,
    containerName: value.containerName,
    objectKeyTemplate: value.objectKeyTemplate,
    objectKeyFingerprint: value.objectKeyFingerprint,
    fingerprintKeyVersion: value.fingerprintKeyVersion,
    redactionVersion: value.redactionVersion,
    objectVersion: value.objectVersion ?? null,
    etag: value.etag ?? null,
    lastModifiedAtMs: value.lastModifiedAtMs ?? null,
    lastModifiedAtBasis: value.lastModifiedAtBasis ?? null,
  };
}

/**
 * descriptor-v1 normalization, moved verbatim from the importer's
 * centralDescriptorSha256. It null-fills fetchUnitId / pageGroupId /
 * pageIndex, defaults the three arrays to [], groups the four origin slots
 * under `origins` (storage rebuilt by {@link normalizeStorageOriginV1}, the
 * others passed through), and spreads every other key as given. It does not
 * validate, sort, lower-case, or fill any other optional key; a client that
 * wants the server's canonical form must call parseArtifactRequest first.
 */
export function normalizeDescriptorV1<T extends ArtifactRequest>(
  descriptor: T,
): CanonicalDescriptorV1<T> {
  const {
    http,
    storage,
    file,
    email,
    fetchUnitId,
    pageGroupId,
    pageIndex,
    ranges,
    transformSteps,
    relations,
    ...fields
  } = descriptor;
  return {
    ...fields,
    fetchUnitId: fetchUnitId ?? null,
    pageGroupId: pageGroupId ?? null,
    pageIndex: pageIndex ?? null,
    origins: {
      http: http ?? null,
      storage: normalizeStorageOriginV1(storage),
      file: file ?? null,
      email: email ?? null,
    },
    ranges: ranges ?? [],
    transformSteps: transformSteps ?? [],
    relations: relations ?? [],
  } as unknown as CanonicalDescriptorV1<T>;
}

/** Canonical bytes of a normalized descriptor (sorted-key JSON, UTF-8). */
export function encodeDescriptorV1(value: CanonicalDescriptorV1<ArtifactRequest>): Uint8Array {
  return encodeCanonicalV1(value as unknown as JsonValue);
}

/** normalize → encode → digest, the digest raw-evidence stores as descriptor_sha256. */
export async function descriptorSha256V1(descriptor: ArtifactRequest): Promise<string> {
  return descriptorDigestV1(encodeDescriptorV1(normalizeDescriptorV1(descriptor)));
}

function mediaTypeValue(value: unknown): string | null {
  const mediaType = stringValue(value, "declared_media_type", { optional: true, max: 255 });
  if (mediaType === null) return null;
  const normalized = mediaType.toLowerCase();
  const token = "[a-z0-9][a-z0-9!#$&^_.+-]{0,126}";
  if (!new RegExp(`^${token}/${token}$`).test(normalized)) {
    throw new ContractError("invalid_declared_media_type");
  }
  return normalized;
}

/**
 * Strict runtime validation of an artifact request body (moved from
 * raw-evidence store.ts). Unknown keys are rejected; the result carries the
 * server's canonical values: defaults filled, media type lower-cased, ranges
 * / steps / relations de-duplicated and sorted, origins validated.
 */
export function parseArtifactRequest(
  input: unknown,
  context: { runId: number },
): ValidatedArtifactRequest {
  const body = object(input);
  exactKeys(body, ARTIFACT_REQUEST_KEYS);
  const ranges = arrayValue(body.ranges, "ranges", 100).map((entry): ArtifactRange => {
    const value = object(entry);
    exactKeys(value, ["rangeKey", ...RANGE_FIELD_KEYS]);
    return {
      rangeKey: requiredString(value.rangeKey, "range_key", { max: 200, pattern: OPAQUE }),
      ...parseRangeFields(value),
    };
  });
  rejectDuplicate(ranges, (value) => value.rangeKey, "duplicate_artifact_range_key");
  ranges.sort((left, right) => binaryCompare(left.rangeKey, right.rangeKey));

  const transformSteps = arrayValue(body.transformSteps, "transform_steps", 100).map(
    (entry): TransformStep => {
      const value = object(entry);
      exactKeys(value, ["stepIndex", "stepKind", "transformerId", "transformerVersion"]);
      return {
        stepIndex: (() => {
          const stepIndex = requiredInteger(value.stepIndex, "step_index");
          if (stepIndex > 1000) throw new ContractError("invalid_step_index");
          return stepIndex;
        })(),
        stepKind: requiredEnum(value.stepKind, "step_kind", [
          "transport_decoded",
          "decrypted",
          "redacted",
          "reencoded",
          "bundled",
          "rendered",
          "extracted",
          "generated",
        ] as const),
        transformerId: requiredString(value.transformerId, "transformer_id", { pattern: ID }),
        transformerVersion: requiredString(value.transformerVersion, "transformer_version", {
          max: 200,
        }),
      };
    },
  );
  rejectDuplicate(
    transformSteps,
    (value) => String(value.stepIndex),
    "duplicate_transform_step_index",
  );
  transformSteps.sort((left, right) => left.stepIndex - right.stepIndex);

  const relations = arrayValue(body.relations, "relations", 100).map((entry): RelationClaim => {
    const value = object(entry);
    exactKeys(value, [
      "parentRunId",
      "parentArtifactKey",
      "relation",
      "transformerId",
      "transformerVersion",
    ]);
    return {
      parentRunId: requiredInteger(value.parentRunId ?? context.runId, "parent_run_id"),
      parentArtifactKey: requiredString(value.parentArtifactKey, "parent_artifact_key", {
        pattern: OPAQUE,
      }),
      relation: requiredEnum(value.relation, "relation", ["input", "described_by"] as const),
      transformerId: requiredString(value.transformerId, "transformer_id", { pattern: ID }),
      transformerVersion: requiredString(value.transformerVersion, "transformer_version", {
        max: 200,
      }),
    };
  });
  rejectDuplicate(
    relations,
    (value) => `${value.parentRunId}\0${value.parentArtifactKey}\0${value.relation}`,
    "duplicate_artifact_relation",
  );
  relations.sort(
    (left, right) =>
      left.parentRunId - right.parentRunId ||
      binaryCompare(
        `${left.parentArtifactKey}\0${left.relation}`,
        `${right.parentArtifactKey}\0${right.relation}`,
      ),
  );

  const origins = parseOrigins(body);
  const parsed: ValidatedArtifactRequest = {
    artifactKey: requiredString(body.artifactKey, "artifact_key", { pattern: OPAQUE }),
    artifactRole: requiredEnum(body.artifactRole, "artifact_role", [
      "provider_response",
      "provider_export",
      "provider_document",
      "provider_message",
      "collector_manifest",
      "collector_error",
      "collector_summary",
      "collector_derived",
      "sanitized_provider_capture",
      "user_capture",
    ] as const),
    payloadFidelity: requiredEnum(body.payloadFidelity, "payload_fidelity", [
      "exact",
      "transport_decoded",
      "transformed",
      "generated",
      "unknown",
    ] as const),
    containerKind: requiredEnum(body.containerKind ?? "single", "container_kind", [
      "single",
      "bundle",
      "archive",
      "multipart",
      "unknown",
    ] as const),
    lineageDisposition: requiredEnum(body.lineageDisposition, "lineage_disposition", [
      "linked",
      "embedded_source_bytes",
      "source_not_retained_for_security",
      "source_bytes_not_available",
      "not_applicable",
    ] as const),
    dataset: stringValue(body.dataset, "dataset", { optional: true, max: 200 }),
    formatId: stringValue(body.formatId, "format_id", { optional: true, max: 200 }),
    formatVersion: stringValue(body.formatVersion, "format_version", { optional: true, max: 100 }),
    declaredMediaType: mediaTypeValue(body.declaredMediaType),
    mediaTypeBasis: enumValue(
      body.mediaTypeBasis,
      "media_type_basis",
      ["response_header", "manifest", "file_metadata", "operator", "unknown"] as const,
      true,
    ),
    fetchedAtMs: integerValue(body.fetchedAtMs, "fetched_at_ms", true),
    fetchedAtBasis: enumValue(
      body.fetchedAtBasis,
      "fetched_at_basis",
      ["source", "response", "manifest", "file_metadata", "operator", "unknown"] as const,
      true,
    ),
    fetchUnitId: integerValue(body.fetchUnitId, "fetch_unit_id", true),
    pageGroupId: integerValue(body.pageGroupId, "page_group_id", true),
    pageIndex: integerValue(body.pageIndex, "page_index", true),
    sequence: integerValue(body.sequence, "sequence", true),
    sha256: requiredString(body.sha256, "sha256", { pattern: SHA256 }),
    byteSize: requiredInteger(body.byteSize, "byte_size"),
    http: origins.http,
    storage: origins.storage,
    file: origins.file,
    email: origins.email,
    ranges,
    transformSteps,
    relations,
  };
  if (
    (parsed.declaredMediaType === null) !== (parsed.mediaTypeBasis === null) ||
    (parsed.fetchedAtMs === null) !== (parsed.fetchedAtBasis === null) ||
    (parsed.pageGroupId === null) !== (parsed.pageIndex === null)
  ) {
    throw new ContractError("artifact_field_pair_mismatch");
  }
  return parsed;
}

export interface DescriptorContract {
  readonly contractVersion: "descriptor-v1";
  parseRequest(input: unknown, context: { runId: number }): ValidatedArtifactRequest;
  normalize<T extends ArtifactRequest>(request: T): CanonicalDescriptorV1<T>;
  encode(value: CanonicalDescriptorV1<ArtifactRequest>): Uint8Array;
  digest(canonicalBytes: Uint8Array): Promise<string>;
}

export const descriptorContractV1: DescriptorContract = {
  contractVersion: "descriptor-v1",
  parseRequest: parseArtifactRequest,
  normalize: normalizeDescriptorV1,
  encode: encodeDescriptorV1,
  digest: descriptorDigestV1,
};

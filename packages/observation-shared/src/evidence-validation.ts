import type {
  EvidenceArtifact,
  EvidenceArtifactDetail,
  EvidenceArtifactId,
  EvidenceArtifactList,
  EvidenceMeta,
  EvidenceRun,
  EvidenceRunId,
  EvidenceRunList,
} from "./evidence-contract.ts";
import { EVIDENCE_PAGE_LIMIT } from "./evidence-contract.ts";

type Check<T> = (value: unknown) => value is T;
type Shape<T> = { [K in keyof T]-?: Check<T[K]> };
const record: Check<Record<string, unknown>> = (value): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text: Check<string> = (value): value is string => typeof value === "string";
const count: Check<number> = (value): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hash: Check<string> = (value): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const instant: Check<string> = (value): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value))
    return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
};
export const isEvidenceSourceId: Check<string> = (value): value is string =>
  typeof value === "string" && /^[a-z0-9-]{1,100}$/u.test(value);
function opaqueId(value: unknown, prefix: string): boolean {
  if (typeof value !== "string" || !value.startsWith(prefix)) return false;
  const integer = value.slice(prefix.length);
  return /^[1-9]\d*$/u.test(integer) && Number.isSafeInteger(Number(integer));
}
export const isEvidenceRunId: Check<EvidenceRunId> = (value): value is EvidenceRunId =>
  opaqueId(value, "r_");
export const isEvidenceArtifactId: Check<EvidenceArtifactId> = (
  value,
): value is EvidenceArtifactId => opaqueId(value, "a_");
export const isEvidenceCursor: Check<string> = (value): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,2048}$/u.test(value);
function nullable<T>(check: Check<T>): Check<T | null> {
  return (value): value is T | null => value === null || check(value);
}
function array<T>(check: Check<T>): Check<T[]> {
  return (value): value is T[] =>
    Array.isArray(value) && value.length <= EVIDENCE_PAGE_LIMIT && value.every(check);
}
function literal<T extends string | number | boolean>(...values: T[]): Check<T> {
  return (value): value is T => values.some((entry) => entry === value);
}
function object<T>(shape: Shape<T>): Check<T> {
  return (value): value is T =>
    record(value) &&
    Object.entries(shape).every(([key, check]) => (check as Check<unknown>)(value[key]));
}
const nullableText = nullable(text);
const basis = nullable(
  literal("source", "manifest", "schedule", "file_metadata", "email", "operator", "unknown"),
);
const version = literal("evidence-v1");
const runShape = object<EvidenceRun>({
  id: isEvidenceRunId,
  sourceId: isEvidenceSourceId,
  producerId: isEvidenceSourceId,
  recordedAt: instant,
  sealedAt: instant,
  outcome: literal("success", "partial", "failed", "human_required", "cancelled", "unknown"),
  startedAt: nullable(instant),
  startedAtBasis: basis,
  completedAt: nullable(instant),
  completedAtBasis: basis,
  artifactCount: count,
});
const run: Check<EvidenceRun> = (value): value is EvidenceRun =>
  runShape(value) &&
  (value.startedAt === null) === (value.startedAtBasis === null) &&
  (value.completedAt === null) === (value.completedAtBasis === null) &&
  (value.startedAt === null ||
    value.completedAt === null ||
    Date.parse(value.completedAt) >= Date.parse(value.startedAt));
const artifactFields = {
  id: isEvidenceArtifactId,
  runId: isEvidenceRunId,
  artifactKey: text,
  role: literal(
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
  ),
  payloadFidelity: literal("exact", "transport_decoded", "transformed", "generated", "unknown"),
  dataset: nullableText,
  sha256: hash,
  byteSize: count,
  recordedAt: instant,
} satisfies Shape<EvidenceArtifact>;
const artifact = object<EvidenceArtifact>(artifactFields);
const meta = object<EvidenceMeta>({
  apiVersion: version,
  source: object<EvidenceMeta["source"]>({
    kind: literal("central-raw-store"),
    classification: literal("financial"),
  }),
  capabilities: object<EvidenceMeta["capabilities"]>({
    readOnly: literal(true),
    rawEvidence: literal(true),
    parsedObservations: (value): value is boolean => typeof value === "boolean",
    liveCollectors: literal(false),
  }),
  sources: array(object<EvidenceMeta["sources"][number]>({ id: isEvidenceSourceId, label: text })),
});
const runs = object<EvidenceRunList>({
  apiVersion: version,
  sourceId: isEvidenceSourceId,
  coverage: literal("sealed-only"),
  items: array(run),
  nextCursor: nullable(isEvidenceCursor),
});
const artifacts = object<EvidenceArtifactList>({
  apiVersion: version,
  run,
  items: array(artifact),
  nextCursor: nullable(isEvidenceCursor),
});
const detail = object<EvidenceArtifactDetail>({
  apiVersion: version,
  run,
  artifact: object<EvidenceArtifactDetail["artifact"]>({
    ...artifactFields,
    descriptorSha256: hash,
    containerKind: literal("single", "bundle", "archive", "multipart", "unknown"),
    lineageDisposition: literal(
      "linked",
      "embedded_source_bytes",
      "source_not_retained_for_security",
      "source_bytes_not_available",
      "not_applicable",
    ),
    formatId: nullableText,
    formatVersion: nullableText,
    declaredMediaType: nullableText,
  }),
});

export type EvidenceRequest =
  | { kind: "meta" }
  | { kind: "runs"; sourceId: string; cursor: string | null }
  | { kind: "artifacts"; runId: EvidenceRunId; cursor: string | null }
  | { kind: "artifact"; runId: EvidenceRunId; artifactId: EvidenceArtifactId };

/** Only known same-origin JSON routes are eligible; raw bytes are linked separately. */
export function evidenceRequest(path: string): EvidenceRequest | undefined {
  if (!path.startsWith("/api/evidence/v1/")) return undefined;
  let url: URL;
  try {
    url = new URL(path, "https://evidence.invalid");
  } catch {
    return undefined;
  }
  if (url.origin !== "https://evidence.invalid" || url.hash) return undefined;
  const parts = url.pathname.slice("/api/evidence/v1/".length).split("/");
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "cursor") || keys.length > 1) return undefined;
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && !isEvidenceCursor(cursor)) return undefined;
  if (parts.length === 1 && parts[0] === "meta" && cursor === null) return { kind: "meta" };
  if (
    parts.length === 3 &&
    parts[0] === "sources" &&
    isEvidenceSourceId(parts[1]) &&
    parts[2] === "runs"
  )
    return { kind: "runs", sourceId: parts[1], cursor };
  if (parts[0] === "runs" && isEvidenceRunId(parts[1]) && parts[2] === "artifacts") {
    if (parts.length === 3) return { kind: "artifacts", runId: parts[1], cursor };
    if (parts.length === 4 && isEvidenceArtifactId(parts[3]) && cursor === null)
      return { kind: "artifact", runId: parts[1], artifactId: parts[3] };
  }
  return undefined;
}
const unique = (values: string[]): boolean => new Set(values).size === values.length;

export function validEvidenceResponse(path: string, value: unknown): boolean {
  const request = evidenceRequest(path);
  if (!request) return false;
  switch (request.kind) {
    case "meta":
      return (
        meta(value) && value.sources.length > 0 && unique(value.sources.map((source) => source.id))
      );
    case "runs":
      return (
        runs(value) &&
        value.sourceId === request.sourceId &&
        value.items.every((item) => item.sourceId === request.sourceId) &&
        unique(value.items.map((item) => item.id)) &&
        (value.nextCursor === null ||
          (value.items.length > 0 && value.nextCursor !== request.cursor))
      );
    case "artifacts":
      return (
        artifacts(value) &&
        value.run.id === request.runId &&
        value.items.every((item) => item.runId === request.runId) &&
        unique(value.items.map((item) => item.id)) &&
        value.items.length <= value.run.artifactCount &&
        (value.nextCursor === null ||
          (value.items.length > 0 && value.nextCursor !== request.cursor))
      );
    case "artifact":
      return (
        detail(value) &&
        value.run.id === request.runId &&
        value.artifact.runId === request.runId &&
        value.artifact.id === request.artifactId
      );
  }
}

// Production evidence DTOs. These do not represent parsed financial observations.
export const EVIDENCE_API_VERSION = "evidence-v1" as const;
export const EVIDENCE_PAGE_LIMIT = 50;
export type EvidenceRunId = `r_${number}`;
export type EvidenceArtifactId = `a_${number}`;
export type EvidenceOutcome =
  | "success"
  | "partial"
  | "failed"
  | "human_required"
  | "cancelled"
  | "unknown";
export type EvidenceTimeBasis =
  | "source"
  | "manifest"
  | "schedule"
  | "file_metadata"
  | "email"
  | "operator"
  | "unknown";
export type EvidenceRole =
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
export type EvidencePayloadFidelity =
  | "exact"
  | "transport_decoded"
  | "transformed"
  | "generated"
  | "unknown";
export type EvidenceContainerKind = "single" | "bundle" | "archive" | "multipart" | "unknown";
export type EvidenceLineageDisposition =
  | "linked"
  | "embedded_source_bytes"
  | "source_not_retained_for_security"
  | "source_bytes_not_available"
  | "not_applicable";

export interface EvidenceSource {
  id: string;
  label: string;
}
export interface EvidenceMeta {
  apiVersion: typeof EVIDENCE_API_VERSION;
  source: { kind: "central-raw-store"; classification: "financial" };
  capabilities: {
    readOnly: true;
    rawEvidence: true;
    parsedObservations: boolean;
    liveCollectors: false;
  };
  sources: EvidenceSource[];
}
export interface EvidenceRun {
  id: EvidenceRunId;
  sourceId: string;
  producerId: string;
  recordedAt: string;
  sealedAt: string;
  /** Collector result; sealing confirms storage and never implies collection success. */
  outcome: EvidenceOutcome;
  startedAt: string | null;
  startedAtBasis: EvidenceTimeBasis | null;
  completedAt: string | null;
  completedAtBasis: EvidenceTimeBasis | null;
  artifactCount: number;
}
export interface EvidenceRunList {
  apiVersion: typeof EVIDENCE_API_VERSION;
  sourceId: string;
  coverage: "sealed-only";
  items: EvidenceRun[];
  nextCursor: string | null;
}
export interface EvidenceArtifact {
  id: EvidenceArtifactId;
  runId: EvidenceRunId;
  artifactKey: string;
  role: EvidenceRole;
  payloadFidelity: EvidencePayloadFidelity;
  dataset: string | null;
  sha256: string;
  byteSize: number;
  recordedAt: string;
}
export interface EvidenceArtifactList {
  apiVersion: typeof EVIDENCE_API_VERSION;
  run: EvidenceRun;
  items: EvidenceArtifact[];
  nextCursor: string | null;
}
export interface EvidenceArtifactDetail {
  apiVersion: typeof EVIDENCE_API_VERSION;
  run: EvidenceRun;
  artifact: EvidenceArtifact & {
    descriptorSha256: string;
    containerKind: EvidenceContainerKind;
    lineageDisposition: EvidenceLineageDisposition;
    formatId: string | null;
    formatVersion: string | null;
    declaredMediaType: string | null;
  };
}

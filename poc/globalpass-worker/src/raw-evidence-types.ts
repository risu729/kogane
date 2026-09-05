export type RawEvidenceImportResult =
  | RawEvidenceImportSealed
  | RawEvidenceImportDeferred;

export interface RawEvidenceImportSealed {
  source: "prestia-globalpass";
  manifestKey: string;
  status: "sealed";
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  finalChunkAllObjectsReused: boolean;
}

export interface RawEvidenceImportDeferred {
  source: "prestia-globalpass";
  manifestKey: string;
  status: "deferred";
  reason: "worker_invocation_limit";
  artifactCount: number;
  nextOffset: number;
}

export interface RawEvidenceBackfillPageResult {
  source: "prestia-globalpass";
  scannedObjectCount: number;
  importedManifestCount: number;
  skippedManifestCount: number;
  deferredManifestCount: number;
  failedManifestCount: number;
  nextCursor: string | null;
  truncated: boolean;
  failureCode?: string;
  failedManifestKey?: string;
  result?: RawEvidenceImportResult;
}

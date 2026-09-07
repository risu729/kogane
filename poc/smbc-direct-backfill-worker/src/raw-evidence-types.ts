export interface RawEvidenceDeferred {
  source: "smbc-direct";
  manifestKey: string;
  status: "deferred";
  reason: "worker_invocation_limit" | "central_inventory_limit";
  artifactCount: number;
  nextOffset: number;
}

export interface RawEvidenceSealed {
  source: "smbc-direct";
  manifestKey: string;
  status: "sealed";
  centralRunId: number;
  artifactCount: number;
  sealed: true;
  finalChunkAllObjectsReused: boolean;
}

export type RawEvidenceImportResult = RawEvidenceDeferred | RawEvidenceSealed;

export interface RawEvidenceBackfillPageResult {
  source: "smbc-direct";
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

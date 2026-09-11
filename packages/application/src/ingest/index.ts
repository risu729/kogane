// Registration use cases (unified plan U05, 02 §3).
//
// The legacy ingest Worker (`kogane-ingest`) is now a thin adapter over these
// functions: it authenticates, parses the request body, and turns an
// `IngestError` into the status code it has always returned. The Processor
// will call the same functions directly when it registers a terminal run,
// with no HTTP hop and no second copy of the SQL.
export {
  assertSame,
  IngestError,
  SHA256,
  type EvidenceBucketLike,
  type IngestEnv,
  type PutObjectOptions,
  type RecordValue,
  type StoredObjectLike,
} from "./contract.ts";
export { loadRun, requireActiveClient, requireRoute } from "./access.ts";
export { httpScopeAllowed, validateOriginScope } from "./origins.ts";
export { addRunReport, createRun, type CreatedRun } from "./registration.ts";
export { addPageGroup, addRunRange, addUnit, addUnitReport } from "./structure.ts";
export {
  adoptStoredObject,
  blobKeyFor,
  hexBytes,
  putObject,
  verifyObject,
  type ObjectUpload,
  type StoredObject,
  type VerificationOutcome,
} from "./objects.ts";
export { addArtifact, type CataloguedArtifact } from "./catalogue.ts";
export {
  addInventoryItems,
  beginInventory,
  getInventoryStatus,
  type InventoryStatus,
} from "./inventory.ts";
export { addFailedAttempt, sealRun, sealStagedInventory, type SealedRun } from "./seal.ts";
export { directRegistrationPort, type RunRegistrationPort } from "./port.ts";

// Registration use cases used in-process by the Processor.
// Contract validation, conflict detection and idempotency live here.
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

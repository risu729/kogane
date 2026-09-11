// The registration use cases moved to `packages/application/src/ingest`
// (unified plan U05) and the SQL under them to `packages/storage-d1`. This
// module keeps the historical import path for the Worker and its tests.
//
// One signature change came with the move: the use cases take an already
// parsed request body instead of a `Request`, because a Processor registering
// a terminal run has no request to hand them. The adapter reads the body with
// `readJson` and passes it on; the wire protocol is unchanged.
export {
  addArtifact,
  addFailedAttempt,
  addInventoryItems,
  beginInventory,
  addRunReport,
  createRun,
  getInventoryStatus,
  putObject,
  sealRun,
  sealStagedInventory,
  verifyObject,
  type CataloguedArtifact,
  type CreatedRun,
  type InventoryStatus,
  type ObjectUpload,
  type SealedRun,
  type StoredObject,
  type VerificationOutcome,
} from "../../../packages/application/src/ingest/index.ts";

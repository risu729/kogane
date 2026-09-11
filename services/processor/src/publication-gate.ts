// The publication gate moved to packages/storage-d1 (unified plan U05): the
// adoption pointer is CORE state that the App and the Processor must move the
// same way, so its statements live with the rest of the CORE SQL. This module
// keeps the historical import path for the Worker, the ops routes and their
// tests; there is no second implementation.
export {
  ACTOR_PATTERN,
  REPAIR_LIMIT_DEFAULT,
  REPAIR_LIMIT_MAX,
  publicationConsistency,
  publicationStatements,
  publishBatch,
  repairPublication,
  type PublicationConsistency,
  type PublicationMismatch,
  type PublishInput,
  type RepairRequest,
  type RepairResult,
} from "../../../packages/storage-d1/src/atomic/publication.ts";

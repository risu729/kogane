// The decision outbox dispatcher moved to packages/storage-d1 (unified plan
// U05): it is CORE state — decision revisions, receipts and the outbox — that
// the App and the Processor must drive the same way. This module keeps the
// historical import path; there is no second implementation.
export * from "../../../packages/storage-d1/src/core/decision-outbox.ts";

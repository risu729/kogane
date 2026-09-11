// The identity projection's CORE writes moved to packages/storage-d1 (unified
// plan U05): they are database access the App and the Processor must share,
// not pipeline-specific logic. This module keeps the historical import path;
// there is no second implementation.
export * from "../../../packages/storage-d1/src/core/identity-store.ts";

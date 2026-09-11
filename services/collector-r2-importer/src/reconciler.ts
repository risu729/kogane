// The R2 outbox reconciler moved to the Processor (unified plan 02 §2, U08):
// the Processor is the new owner of terminal reconciliation, and the message
// schema, the source table and the bounded repair walk are the same code on
// both sides. This module keeps the historical import path for this Worker,
// its scripts and its tests; there is no second implementation.
export {
  parseMessage,
  processReconcilerMessage,
  RECONCILER_SCHEMA,
  RECONCILER_SOURCES,
  REPAIR_LIST_LIMIT,
  weeklyRepairSeeds,
  type ImportMessage,
  type ImportOutcome,
  type InternalMessage,
  type ParsedMessage,
  type ReconcilerDependencies,
  type ReconcilerSource,
  type ReconcilerSourceSpec,
  type RepairMessage,
} from "../../observation-pipeline/src/legacy-import/reconciler.ts";

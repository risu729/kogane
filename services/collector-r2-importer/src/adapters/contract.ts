// The import contract moved to the Processor (unified plan 02 §2, U08). This
// module keeps the historical import path for this Worker's twelve per-source
// adapters, which stay here — each binds this Worker's own R2 bindings and
// secrets — until U15 retires it.
//
// `ImportAdapter` and `RepairPolicy` are re-exported already bound to this
// Worker's `Env`, so the per-source adapters below are typed exactly as they
// were before the move.
import type {
  ImportAdapter as GenericImportAdapter,
  ImportStepResult,
  RepairPolicy as GenericRepairPolicy,
} from "../../../observation-pipeline/src/legacy-import/adapters/contract.ts";

export {
  assertNoResume,
  httpCommand,
  httpNoResume,
  httpTokenResume,
  resumeFromWire,
  resumeOffset,
  resumeToken,
  type ImportCommand,
  type ImportExecution,
  type ImportMode,
  type ImportSource,
  type ImportStepResult,
  type ImportHttpRoutes,
  type LegacyOutboxBucket,
  type ResumeKind,
  type ResumeState,
  type TerminalKeyField,
} from "../../../observation-pipeline/src/legacy-import/adapters/contract.ts";

/** The generic adapter, bound to this Worker's environment. */
export type ImportAdapter<TResult extends ImportStepResult = ImportStepResult> =
  GenericImportAdapter<TResult, Env>;
export type RepairPolicy = GenericRepairPolicy<Env>;

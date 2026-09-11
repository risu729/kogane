// The legacy import layer the Processor absorbed from the R2 importer (U08).
//
// Two halves meet here.
//
//   * `reconciler.ts` and `adapters/` are the importer's own machinery, moved
//     verbatim. The importer keeps running until U15 and imports them back
//     through re-export shims, so there is one implementation, not two.
//   * `LEGACY_ADAPTERS` in `packages/collection` maps a legacy per-source
//     bucket layout onto a `terminal-v1` persist plan, which is how a run
//     that exists only in an old bucket can be re-persisted under the shared
//     contract (plan 03 §7: the old buckets stay readable until nothing is
//     left only there).
//
// The two halves are matched, not merged. `RECONCILER_SOURCES` is the
// authority on where a legacy run lives and which object ends it — it is the
// table the importer has been running against — and the collection adapters
// are checked against it rather than inventing a second grammar. A source
// with no collection adapter is listed as uncovered instead of being given a
// guessed layout.
import {
  LEGACY_ADAPTERS,
  matchLegacyTerminal,
  type LegacyCollectionAdapter,
  type LegacyRunIdentity,
} from "../../../../packages/collection/src/adapters.ts";
import { RECONCILER_SOURCES, type ReconcilerSource } from "./reconciler.ts";

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
} from "./reconciler.ts";
export { ImportError } from "./error.ts";
export {
  checkImportAdapterRegistry,
  executeImportWith,
  reconcilerOutcome,
  routeIndex,
  type AdapterRegistry,
} from "./adapters/registry.ts";
export {
  type ImportAdapter,
  type ImportCommand,
  type ImportMode,
  type ImportSource,
  type ImportStepResult,
  type LegacyOutboxBucket,
  type RepairPolicy,
  type ResumeKind,
  type ResumeState,
} from "./adapters/contract.ts";

/** The legacy sources a `packages/collection` adapter can re-persist today. */
export const COVERED_LEGACY_SOURCES: readonly ReconcilerSource[] = LEGACY_ADAPTERS.map(
  (adapter) => adapter.sourceId,
).filter((source): source is ReconcilerSource => Object.hasOwn(RECONCILER_SOURCES, source));

/**
 * The legacy sources the importer reconciles that have no collection adapter
 * yet. Naming them is the point: each needs its own reviewed mapping from its
 * own manifest shape, and guessing one would produce a terminal that claims
 * something the collector never said.
 */
export function uncoveredLegacySources(): ReconcilerSource[] {
  const covered = new Set<string>(COVERED_LEGACY_SOURCES);
  return (Object.keys(RECONCILER_SOURCES) as ReconcilerSource[]).filter(
    (source) => !covered.has(source),
  );
}

export interface LegacyTerminalMatch {
  adapter: LegacyCollectionAdapter;
  identity: LegacyRunIdentity;
  /** The legacy bucket the key belongs to, from the reconciler's own table. */
  bucket: string;
}

/**
 * The collection adapter whose layout claims this legacy key, if any.
 *
 * The key must satisfy both grammars: the reconciler's terminal pattern for
 * that source — the one the importer has been running — and the adapter's own
 * matcher. A key only one of them accepts is a disagreement between the two
 * descriptions of one bucket, and is refused rather than half-handled.
 */
export function matchLegacyTerminalKey(key: string): LegacyTerminalMatch | null {
  const matched = matchLegacyTerminal(key);
  if (!matched) return null;
  const source = matched.adapter.sourceId;
  if (!Object.hasOwn(RECONCILER_SOURCES, source)) return null;
  const spec = RECONCILER_SOURCES[source as ReconcilerSource];
  if (!spec.terminal.test(key)) return null;
  return { adapter: matched.adapter, identity: matched.identity, bucket: spec.bucket };
}

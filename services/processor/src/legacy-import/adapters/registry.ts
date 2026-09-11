// The source-agnostic half of the legacy import registry, moved here from
// `services/collector-r2-importer/src/adapters/index.ts` by U08.
//
// What moved is everything that does not name a bank: routing a versioned
// HTTP path to an adapter, executing one import step, turning a step result
// into the Queue continuation contract, and the CI consistency check between
// the adapters and the reconciler's source table. What stayed in the importer
// is the registry literal itself and the twelve per-source `step` functions,
// because each of them binds that Worker's own R2 bindings and secrets; the
// importer keeps running unchanged until U15 retires it.
//
// The env is a type parameter for the same reason: this module is compiled
// into the Processor, which has no per-source bindings and must not grow any.
import { ImportError } from "../error.ts";
import { type ImportOutcome } from "../reconciler.ts";
import {
  type ImportAdapter,
  type ImportCommand,
  type ImportExecution,
  type ImportStepResult,
  type ResumeKind,
  type ResumeState,
} from "./contract.ts";

/** Adapters by source id. The importer's literal registry satisfies it. */
export type AdapterRegistry<TEnv = unknown> = Readonly<
  Record<string, ImportAdapter<ImportStepResult, TEnv>>
>;

export function routeIndex<TEnv>(
  registry: AdapterRegistry<TEnv>,
  select: (adapter: ImportAdapter<ImportStepResult, TEnv>) => string | undefined,
): ReadonlyMap<string, ImportAdapter<ImportStepResult, TEnv>> {
  const index = new Map<string, ImportAdapter<ImportStepResult, TEnv>>();
  for (const adapter of Object.values(registry)) {
    const path = select(adapter);
    if (path !== undefined) index.set(path, adapter);
  }
  return index;
}

export const importRunPath = (
  adapter: ImportAdapter<ImportStepResult, never>,
): string | undefined => adapter.http?.importRun;
export const backfillPath = (adapter: ImportAdapter<ImportStepResult, never>): string | undefined =>
  adapter.http?.backfillPage.path;

/**
 * The single application command behind every entry point. HTTP routes,
 * backfill cursors and the Queue reconciler all validate their own wire
 * shape, then call this with the internal command and resume state.
 */
export async function executeImportWith<TEnv, TResult extends ImportStepResult>(
  adapter: ImportAdapter<TResult, TEnv>,
  env: TEnv,
  source: string,
  command: ImportCommand,
  resume: ResumeState,
): Promise<ImportExecution<TResult>> {
  if (command.source !== source) throw new ImportError(500, "import_command_source_mismatch");
  if (resume.kind !== "none" && resume.kind !== adapter.resumeKind) {
    throw new ImportError(500, "import_resume_kind_mismatch");
  }
  const result = await adapter.step(env, command, resume);
  const step: ImportStepResult = result;
  return { result, status: step.status === "deferred" ? "deferred" : "sealed" };
}

/** Maps a source result to the Queue continuation contract; fails closed on non-progress. */
export function reconcilerOutcome(result: ImportStepResult): ImportOutcome {
  if (result.status !== "deferred") return { status: "sealed" };
  if (!Number.isSafeInteger(result.nextOffset) || (result.nextOffset ?? 0) <= 0) {
    throw new ImportError(409, "reconciler_import_stalled");
  }
  const resume = result.continuation ?? result.nextOffset;
  if (resume === undefined) throw new ImportError(409, "reconciler_continuation_missing");
  return { status: "deferred", resume, progress: result.nextOffset! };
}

const ROUTE_PATTERN = /^\/v1\/[a-z0-9-]+\/(?:import-run|backfill-page)$/u;
const CONTRACT_VERSION_PATTERN = /^[a-z0-9-]+-v\d+$/u;

/**
 * Registry consistency problems; empty when adapters and reconciler sources
 * agree. The parameters exist so tests can prove the check rejects drift.
 */
export function checkImportAdapterRegistry<TEnv>(
  registry: AdapterRegistry<TEnv>,
  sources: Readonly<Record<string, { readonly resume: ResumeKind }>>,
): string[] {
  const problems: string[] = [];
  const select = registry as AdapterRegistry<never>;
  const importRuns = routeIndex(select, importRunPath);
  const backfills = routeIndex(select, backfillPath);
  for (const [source, spec] of Object.entries(sources)) {
    const adapter = registry[source];
    if (!adapter) {
      problems.push(`${source}: reconciler source has no import adapter`);
      continue;
    }
    if (adapter.id !== source) problems.push(`${source}: adapter id is ${adapter.id}`);
    if (adapter.resumeKind !== spec.resume) {
      problems.push(
        `${source}: adapter resume kind ${adapter.resumeKind} != reconciler ${spec.resume}`,
      );
    }
  }
  for (const [key, adapter] of Object.entries(registry)) {
    if (!Object.hasOwn(sources, key)) {
      problems.push(`${key}: adapter has no reconciler source`);
    }
    if (!CONTRACT_VERSION_PATTERN.test(adapter.contractVersion)) {
      problems.push(`${key}: contract version is not a versioned source contract id`);
    }
    if (typeof adapter.repairPolicy?.outbox !== "function") {
      problems.push(`${key}: repair policy declares no outbox binding`);
    }
    if (!adapter.http) continue;
    const { importRun, backfillPage } = adapter.http;
    if (!ROUTE_PATTERN.test(importRun) || !importRun.endsWith("/import-run")) {
      problems.push(`${key}: import-run path is not a versioned import-run route`);
    }
    if (!ROUTE_PATTERN.test(backfillPage.path) || !backfillPage.path.endsWith("/backfill-page")) {
      problems.push(`${key}: backfill-page path is not a versioned backfill-page route`);
    }
    if (!Number.isSafeInteger(backfillPage.cursorBudget) || backfillPage.cursorBudget <= 0) {
      problems.push(`${key}: backfill cursor budget must be a positive integer`);
    }
    if (importRuns.get(importRun) !== (adapter as ImportAdapter<ImportStepResult, never>)) {
      problems.push(`${key}: import-run route is not routed to this adapter`);
    }
    if (backfills.get(backfillPage.path) !== (adapter as ImportAdapter<ImportStepResult, never>)) {
      problems.push(`${key}: backfill-page route is not routed to this adapter`);
    }
  }
  return problems;
}

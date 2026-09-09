import { ImportError } from "../error";
import { RECONCILER_SOURCES, type ImportOutcome } from "../reconciler";
import {
  type ImportAdapter,
  type ImportCommand,
  type ImportExecution,
  type ImportSource,
  type ImportStepResult,
  type ResumeState,
} from "./contract";
import { GLOBAL_PASS_ADAPTER } from "./global-pass";
import { MOBILE_SUICA_ADAPTER } from "./mobile-suica";
import { MONEYFORWARD_ADAPTER } from "./moneyforward";
import { MYJCB_ADAPTER } from "./myjcb";
import { SBI_SECURITIES_ADAPTER } from "./sbi-securities";
import { SBI_SHINSEI_ADAPTER } from "./sbi-shinsei";
import { SBI_VC_TRADE_ADAPTER } from "./sbi-vc-trade";
import { SMBC_DIRECT_ADAPTER } from "./smbc-direct";
import { SONY_BANK_ADAPTER } from "./sony-bank";
import { V_POINT_ADAPTER } from "./v-point";
import { V_POINT_PAY_EMAIL_ADAPTER } from "./v-point-pay-email";
import { VPASS_ADAPTER } from "./vpass";

export type {
  ImportAdapter,
  ImportCommand,
  ImportExecution,
  ImportMode,
  ImportSource,
  ImportStepResult,
  ResumeKind,
  ResumeState,
} from "./contract";

/**
 * One adapter per reconciler source. Adding a source means adding its adapter
 * here and its queue spec to `RECONCILER_SOURCES`; `checkImportAdapterRegistry`
 * fails CI when the two disagree.
 */
export const IMPORT_ADAPTERS = {
  "global-pass": GLOBAL_PASS_ADAPTER,
  "mobile-suica": MOBILE_SUICA_ADAPTER,
  moneyforward: MONEYFORWARD_ADAPTER,
  myjcb: MYJCB_ADAPTER,
  "sbi-securities": SBI_SECURITIES_ADAPTER,
  "sbi-shinsei": SBI_SHINSEI_ADAPTER,
  "sbi-vc-trade": SBI_VC_TRADE_ADAPTER,
  "smbc-direct": SMBC_DIRECT_ADAPTER,
  "sony-bank": SONY_BANK_ADAPTER,
  vpass: VPASS_ADAPTER,
  "v-point": V_POINT_ADAPTER,
  "v-point-pay-email": V_POINT_PAY_EMAIL_ADAPTER,
} as const satisfies { readonly [K in ImportSource]: ImportAdapter & { readonly id: K } };

export type ImportAdapters = typeof IMPORT_ADAPTERS;
export type AdapterResult<S extends ImportSource> = Awaited<ReturnType<ImportAdapters[S]["step"]>>;

const ADAPTERS: readonly ImportAdapter[] = Object.values(IMPORT_ADAPTERS);
const IMPORT_RUN_ROUTES: ReadonlyMap<string, ImportAdapter> = new Map(
  ADAPTERS.flatMap((adapter) => (adapter.http ? [[adapter.http.importRun, adapter]] : [])),
);
const BACKFILL_ROUTES: ReadonlyMap<string, ImportAdapter> = new Map(
  ADAPTERS.flatMap((adapter) => (adapter.http ? [[adapter.http.backfillPage.path, adapter]] : [])),
);

export function importAdapter<S extends ImportSource>(source: S): ImportAdapters[S] {
  return IMPORT_ADAPTERS[source];
}

export function importRunAdapter(pathname: string): ImportAdapter | undefined {
  return IMPORT_RUN_ROUTES.get(pathname);
}

export function backfillAdapter(pathname: string): ImportAdapter | undefined {
  return BACKFILL_ROUTES.get(pathname);
}

/**
 * The single application command behind every entry point. HTTP routes,
 * backfill cursors, and the Queue reconciler all validate their own wire
 * shape, then call this with the internal command and resume state.
 */
export async function executeImport<S extends ImportSource>(
  env: Env,
  source: S,
  command: ImportCommand,
  resume: ResumeState,
): Promise<ImportExecution<AdapterResult<S>>> {
  const adapter: ImportAdapter = IMPORT_ADAPTERS[source];
  if (command.source !== source) throw new ImportError(500, "import_command_source_mismatch");
  if (resume.kind !== "none" && resume.kind !== adapter.resumeKind) {
    throw new ImportError(500, "import_resume_kind_mismatch");
  }
  const result = (await adapter.step(env, command, resume)) as AdapterResult<S>;
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

/** Registry consistency problems; empty when adapters and reconciler sources agree. */
export function checkImportAdapterRegistry(): string[] {
  const problems: string[] = [];
  const registry: Record<string, ImportAdapter | undefined> = IMPORT_ADAPTERS;
  for (const source of Object.keys(RECONCILER_SOURCES) as ImportSource[]) {
    const adapter = registry[source];
    if (!adapter) {
      problems.push(`${source}: reconciler source has no import adapter`);
      continue;
    }
    if (adapter.id !== source) problems.push(`${source}: adapter id is ${adapter.id}`);
    const expected = RECONCILER_SOURCES[source].resume;
    if (adapter.resumeKind !== expected) {
      problems.push(
        `${source}: adapter resume kind ${adapter.resumeKind} != reconciler ${expected}`,
      );
    }
  }
  for (const [key, adapter] of Object.entries(registry)) {
    if (!adapter) continue;
    if (!Object.hasOwn(RECONCILER_SOURCES, key)) {
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
    if (importRunAdapter(importRun) !== adapter) {
      problems.push(`${key}: import-run route is not routed to this adapter`);
    }
    if (backfillAdapter(backfillPage.path) !== adapter) {
      problems.push(`${key}: backfill-page route is not routed to this adapter`);
    }
  }
  return problems;
}

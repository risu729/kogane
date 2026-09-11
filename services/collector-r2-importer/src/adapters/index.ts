// The per-source import registry of this Worker.
//
// U08 moved the source-agnostic half — route indexing, one import step, the
// Queue continuation mapping and the registry consistency check — to
// `services/observation-pipeline/src/legacy-import/adapters/registry.ts`,
// because that logic is the Processor's now. What stays here is the registry
// literal and the twelve per-source adapters, each of which binds this
// Worker's own R2 bindings and secrets. Nothing about this Worker's behaviour
// changed; it keeps running until U15 retires it.
import {
  type AdapterRegistry,
  checkImportAdapterRegistry as checkRegistry,
  executeImportWith,
  reconcilerOutcome,
  routeIndex,
} from "../../../observation-pipeline/src/legacy-import/adapters/registry.ts";
import { RECONCILER_SOURCES, type ImportOutcome } from "../reconciler";
import {
  type ImportAdapter,
  type ImportCommand,
  type ImportExecution,
  type ImportSource,
  type ResumeKind,
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
export { reconcilerOutcome };

/**
 * One adapter per reconciler source. Adding a source means adding its adapter
 * here and its queue spec to `RECONCILIER_SOURCES`; `checkImportAdapterRegistry`
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

const registry = IMPORT_ADAPTERS as unknown as AdapterRegistry<Env>;
const IMPORT_RUN_ROUTES = routeIndex(registry, (adapter) => adapter.http?.importRun);
const BACKFILL_ROUTES = routeIndex(registry, (adapter) => adapter.http?.backfillPage.path);

export function importAdapter<S extends ImportSource>(source: S): ImportAdapters[S] {
  return IMPORT_ADAPTERS[source];
}

export function importRunAdapter(pathname: string): ImportAdapter | undefined {
  return IMPORT_RUN_ROUTES.get(pathname) as ImportAdapter | undefined;
}

export function backfillAdapter(pathname: string): ImportAdapter | undefined {
  return BACKFILL_ROUTES.get(pathname) as ImportAdapter | undefined;
}

/** This Worker's entry point into the shared execution step. */
export function executeImport<S extends ImportSource>(
  env: Env,
  source: S,
  command: ImportCommand,
  resume: ResumeState,
): Promise<ImportExecution<AdapterResult<S>>> {
  const adapter = IMPORT_ADAPTERS[source] as unknown as ImportAdapter<AdapterResult<S>>;
  return executeImportWith(adapter, env, source, command, resume);
}

/** Registry consistency, with this Worker's registry and source table. */
export function checkImportAdapterRegistry(
  adapters: Readonly<Record<string, ImportAdapter>> = IMPORT_ADAPTERS,
  sources: Readonly<Record<string, { readonly resume: ResumeKind }>> = RECONCILER_SOURCES,
): string[] {
  return checkRegistry(adapters as unknown as AdapterRegistry<Env>, sources);
}

export type { ImportOutcome };

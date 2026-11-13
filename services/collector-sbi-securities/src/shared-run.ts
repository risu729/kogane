// Shared DATA-bucket persistence for the SBI Securities collector (unified
// plan U09, chapter 03, decisions D7/D12).
//
// With `COLLECTION_TARGET=shared` the run is written through
// `packages/collection` — every artifact content-addressed under `objects/`,
// the `terminal-v1` manifest last — instead of per-artifact writes into the
// per-source bucket followed by the central importer call. The bytes are the
// same `JSON.stringify(artifact.body)` the legacy path stores and the importer
// forwards centrally today.
//
// The passkey credential, the handshake key and the session ids stay in the
// secrets and in `src/sbi.ts`; none of them is an artifact, and a failure
// becomes a machine code here rather than the redacted provider message the
// legacy manifest keeps (12 §6).
import { safeErrorDetails } from "../../../packages/collector-diagnostics/src/index";
import {
  persistRun,
  sha256Hex,
  type CoverageStatus,
  type PersistArtifact,
  type PersistRunPlan,
  type PersistRunResult,
  type ProviderOutcome,
  type R2BucketLike,
  type TerminalRange,
  type TerminalRunFields,
  type TerminalTransformation,
  type TerminalUnit,
} from "../../../packages/collection/src/index";
import type { Artifact, CollectionScope } from "./types";
import { sbiArtifactKey, SbiHistoryError } from "./history-windows";
import { isAssetHistoryError } from "../../../packages/parsers/src/parsers/sbi-asset-history-schema";
import { assetHistoryInventoryComplete } from "./asset-history";
import { cashHistoryInventoryComplete } from "./cash-history";
import { CashHistoryError } from "../../../packages/parsers/src/parsers/sbi-cash-history-schema";
import { IncomeHistoryError } from "../../../packages/parsers/src/parsers/sbi-income-history-schema";
import { incomeHistoryInventoryComplete } from "./income-history";
import { MailboxError } from "./mailbox-bootstrap";
import type { MailboxUnit } from "./mailbox";

export const SBI_SECURITIES_SOURCE = "sbi-securities";
export const SHARED_PRODUCER = "collector-sbi-securities";
/**
 * What extracts a stored dataset from provider responses: this collector,
 * named by its own id (ADR 0021).
 */
const TRANSFORMER_ID = "collector-sbi-securities";
const UNIT_KIND = "scope";
const FALLBACK_ERROR_CODE = "collector_failed";
/** The manifest's own machine-code charset; a code that fails it is replaced. */
const SAFE_CODE = /^[a-z0-9][a-z0-9_-]{0,99}$/u;

type UnitScope = "domestic" | "foreign";
const SUPPLEMENTAL_UNITS = [
  "cash-history-yen",
  "cash-history-foreign",
  "income-history-income",
  "income-history-gains",
  "weekly-assets",
] as const;
export type SupplementalUnit = (typeof SUPPLEMENTAL_UNITS)[number];

/** Closed dataset membership: retained inputs and outputs share completeness. */
export function supplementalUnit(dataset: string): SupplementalUnit | undefined {
  switch (dataset) {
    case "yen-detail-history":
    case "yen-detail-history-page-source":
      return "cash-history-yen";
    case "foreign-cash-history":
    case "foreign-cash-history-page-source":
      return "cash-history-foreign";
    case "income-payments":
    case "income-payments-summary-source":
    case "income-payments-rows-source":
      return "income-history-income";
    case "realised-gains":
    case "realised-gains-all-summary-source":
    case "realised-gains-summary-source":
    case "realised-gains-rows-source":
      return "income-history-gains";
    case "account-assets-history":
    case "account-assets-history-source":
    case "account-assets-history-inventory":
      return "weekly-assets";
    default:
      return undefined;
  }
}

/** One failure, reduced to what a terminal may state. */
export interface SharedFailure {
  readonly scope: UnitScope | "mailbox";
  readonly unitKey?: SupplementalUnit;
  readonly code: string;
}

export interface SbiSharedRun {
  readonly runId: string;
  readonly producerVersion: string;
  readonly attemptId: string;
  readonly operationId?: string;
  readonly acquisitionSessionRef?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly status: "success" | "partial" | "failed";
  /** What the trigger asked for: `all`, `domestic` or `foreign`. */
  readonly scope: CollectionScope;
  /** The trade-history window the trigger asked for, when it named one. */
  readonly window?: { readonly from: string; readonly to: string };
  readonly artifacts: readonly Artifact[];
  readonly failures: readonly SharedFailure[];
  readonly mailboxUnits?: readonly MailboxUnit[];
}

/** Core dependencies retain their old scope; supplements share their inputs. */
function datasetScope(dataset: string): UnitScope | SupplementalUnit {
  const supplement = supplementalUnit(dataset);
  if (supplement !== undefined) return supplement;
  return dataset.startsWith("foreign-") ? "foreign" : "domestic";
}

function scopesFor(scope: CollectionScope): UnitScope[] {
  return scope === "all" ? ["domestic", "foreign"] : [scope];
}

/**
 * The machine code a terminal may carry for one failure. `safeErrorDetails`
 * already refuses to expose a provider message; this maps what is left to a
 * stable code, so no free-text ever reaches the manifest.
 */
export function safeFailureCode(error: unknown): string {
  if (error instanceof MailboxError) return error.code;
  if (error instanceof IncomeHistoryError) return error.code;
  if (error instanceof CashHistoryError) return error.code;
  if (isAssetHistoryError(error)) return error.code;
  if (error instanceof SbiHistoryError) return error.code;
  const details = safeErrorDetails(error);
  if (details.code !== undefined && SAFE_CODE.test(details.code)) return details.code;
  switch (details.category) {
    case "http":
      return "provider_http_failed";
    case "timeout":
      return "provider_timeout";
    case "network":
      return "provider_network_failed";
    case "configuration":
      return "credential_configuration_required";
    case "authentication":
      return "authentication_required";
    case "response":
      return "provider_response_invalid";
    default:
      return "operation_failed";
  }
}

/** Builds the plan without writing anything, so a test can read the manifest. */
export async function sbiRunPlan(run: SbiSharedRun): Promise<PersistRunPlan> {
  // A missing or changed retained input invalidates only its entire dependent
  // supplement, including every weekly shard. Unattributed failures stay core.
  for (const unitKey of SUPPLEMENTAL_UNITS) {
    const captured = run.artifacts.filter(
      (artifact) => supplementalUnit(artifact.dataset) === unitKey,
    );
    const complete = unitKey.startsWith("income-")
      ? await incomeHistoryInventoryComplete(captured)
      : unitKey.startsWith("cash-")
        ? await cashHistoryInventoryComplete(captured)
        : await assetHistoryInventoryComplete(captured);
    if (!complete) {
      const code = unitKey.startsWith("income-")
        ? "sbi_income_history_source_inventory"
        : unitKey.startsWith("cash-")
          ? "sbi_cash_history_source_inventory"
          : "sbi_asset_history_shard_inventory";
      run = {
        ...run,
        status: run.status === "failed" ? "failed" : "partial",
        failures: [...run.failures, { scope: "domestic", unitKey, code }],
      };
    }
  }
  // Hash sequentially so the document ceiling does not also become that many
  // concurrent WebCrypto buffer copies.
  const artifacts: PersistArtifact[] = [];
  for (const artifact of run.artifacts) artifacts.push(await plannedArtifact(artifact));
  const scopes: (UnitScope | SupplementalUnit)[] = scopesFor(run.scope);
  for (const unitKey of SUPPLEMENTAL_UNITS)
    if (
      run.artifacts.some((artifact) => supplementalUnit(artifact.dataset) === unitKey) ||
      run.failures.some((failure) => failure.unitKey === unitKey)
    )
      scopes.push(unitKey);
  const providerOutcome: ProviderOutcome = run.status;
  const coverageStatus = coverageFor(providerOutcome);
  const safeErrorCode =
    providerOutcome === "success"
      ? undefined
      : failureCode(run.failures.map((entry) => entry.code));
  // Per scope, exactly as the central unit report is built today: a scope with
  // no failure succeeded, a scope that produced nothing failed, anything else
  // is partial.
  const units: TerminalUnit[] = scopes.map((scope) => {
    const failures = run.failures.filter((entry) => (entry.unitKey ?? entry.scope) === scope);
    const count = artifacts.filter((artifact) => artifact.unitKey === scope).length;
    const unitCoverage: CoverageStatus =
      failures.length === 0 ? "complete" : count === 0 ? "unknown" : "partial";
    const unitCode = failures.length === 0 ? undefined : failureCode(failures.map((e) => e.code));
    return {
      unitKey: scope,
      unitKind: UNIT_KIND,
      artifactCount: count,
      coverageStatus: unitCoverage,
      ...(unitCode === undefined ? {} : { safeErrorCode: unitCode }),
    };
  });
  for (const unit of run.mailboxUnits ?? [])
    units.push({
      ...unit,
      unitKind: "document",
      artifactCount: artifacts.filter((artifact) => artifact.unitKey === unit.unitKey).length,
    });
  const ranges: TerminalRange[] =
    run.window === undefined
      ? []
      : [
          {
            rangeKey: "requested-window",
            rangeKind: "requested",
            precision: "date",
            basis: "request",
            startValue: run.window.from,
            endValue: run.window.to,
          },
        ];
  for (const artifact of run.artifacts) {
    if (artifact.window === undefined) continue;
    ranges.push({
      rangeKey: `${sbiArtifactKey(artifact)}:requested`,
      rangeKind: "requested",
      precision: "date",
      basis: "request",
      startValue: artifact.window.from,
      endValue: artifact.window.to,
      unitKey: datasetScope(artifact.dataset),
    });
  }
  const fields: TerminalRunFields = {
    source: SBI_SECURITIES_SOURCE,
    producer: SHARED_PRODUCER,
    producerVersion: run.producerVersion,
    runId: run.runId,
    attemptId: run.attemptId,
    ...(run.operationId === undefined ? {} : { operationId: run.operationId }),
    ...(run.acquisitionSessionRef === undefined
      ? {}
      : { acquisitionSessionRef: run.acquisitionSessionRef }),
    // Positions are a snapshot whatever the trigger said; the window only
    // bounds the trade histories, so it is a requested range and the scope is
    // a date range only when one was asked for.
    requestedScope: {
      scopeKind: run.window === undefined ? "full_snapshot" : "date_range",
      startValue: run.window?.from ?? null,
      endValue: run.window?.to ?? null,
      unitKeys: units.map((unit) => unit.unitKey),
    },
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    providerOutcome,
    coverageStatus,
    persistenceComplete: true,
    ...(safeErrorCode === undefined ? {} : { safeErrorCode }),
    units,
    ranges,
    reports: [],
    transformations: artifacts.flatMap((artifact, index) =>
      artifact.role === "provider_response" || artifact.role === "provider_document"
        ? []
        : [
            extraction(
              artifact,
              run.producerVersion,
              (run.artifacts[index]!.inputArtifactKeys ?? []).filter((key) =>
                artifacts.some((parent) => parent.artifactKey === key),
              ),
            ),
          ],
    ),
  };
  return { run: fields, artifacts };
}

export async function persistSbiRun(
  bucket: R2BucketLike,
  run: SbiSharedRun,
): Promise<PersistRunResult> {
  return await persistRun(bucket, await sbiRunPlan(run));
}

/**
 * The lineage a derived dataset states (ADR 0021). Each dataset is the
 * collector's own envelope around what it read from provider responses — the
 * MTS payload with its result codes, the GraphQL and main-site JSON, the trade
 * history pages bundled into one object — and none of those responses is
 * stored, so the step names no input artifact; the Processor records that as
 * `source_bytes_not_available` rather than inventing a parent. Weekly history
 * is the exception: its exact source bytes are retained, and its inventory
 * and year shards name their kept inputs.
 */
function extraction(
  artifact: PersistArtifact,
  producerVersion: string,
  inputs: readonly string[],
): TerminalTransformation {
  return {
    transformationId: `${artifact.artifactKey}:extracted`,
    stepKind: "extracted",
    transformerId: TRANSFORMER_ID,
    transformerVersion: producerVersion,
    inputArtifactKeys: [...inputs],
    outputArtifactKey: artifact.artifactKey,
  };
}

function coverageFor(outcome: ProviderOutcome): CoverageStatus {
  return outcome === "success" ? "complete" : outcome === "partial" ? "partial" : "unknown";
}

function failureCode(codes: readonly string[]): string {
  return codes.find((candidate) => SAFE_CODE.test(candidate)) ?? FALLBACK_ERROR_CODE;
}

async function plannedArtifact(artifact: Artifact): Promise<PersistArtifact> {
  const bytes = artifact.bytes ?? new TextEncoder().encode(JSON.stringify(artifact.body));
  return {
    artifactKey: sbiArtifactKey(artifact),
    sha256: await sha256Hex(bytes),
    byteSize: bytes.byteLength,
    mediaType: artifact.mediaType,
    // Every dataset is the collector's own view of provider responses (the
    // GraphQL `data`, the main-site JSON parsed and bundled, the MTS payload
    // in an envelope), which is the role the central descriptor gave them; the
    // terminal's `extracted` step says so (ADR 0021).
    role: artifact.role ?? "collector_derived",
    unitKey:
      supplementalUnit(artifact.dataset) ?? artifact.unitKey ?? datasetScope(artifact.dataset),
    body: { kind: "bytes", bytes },
  };
}

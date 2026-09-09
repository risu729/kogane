// Synthetic snapshot fixtures shared by the snapshot selection tests. Every
// row is invented here; sources are synthetic and the parser names are the
// registry's so the policy table applies to them.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  insertCoverageClaims,
  insertFetchArtifact,
  insertFetchRun,
  insertObservation,
  insertParseIssues,
  insertParseRun,
  listArtifacts,
  openStore,
  putRawObject,
  upsertSource,
  type Store,
} from "../src/store.ts";
import { currentPositions, currentValuations, latestBalances } from "../src/queries.ts";
import { containerClaim } from "../src/parsers/coverage.ts";
import { FOREIGN_POSITION_SNAPSHOT_VERSION, type SnapshotPolicyId } from "../src/snapshot-query.ts";
import type {
  BalanceObservation,
  CoverageClaim,
  Observation,
  ParseIssue,
  PositionObservation,
  ValuationObservation,
} from "../src/types.ts";

const cleanup: (() => void)[] = [];
/** Call from afterEach: closes and deletes every store opened by `database`. */
export function closeStores(): void {
  for (const close of cleanup.splice(0)) close();
}
export function database(): Store {
  const directory = mkdtempSync(join(tmpdir(), "kogane-current-snapshots-"));
  const store = openStore(directory);
  cleanup.push(() => {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return store;
}

/** Overrides applied to the default complete container claim of a snapshot. */
export type CoverageOverrides = Partial<CoverageClaim>;

export interface Snapshot {
  parser: string;
  parserVersion?: string;
  dataset: string;
  source?: string;
  unit?: string;
  time?: string;
  status?: "success" | "partial" | "failed";
  failureCount?: number;
  parseStatus?: "ok" | "error" | "missing";
  warnings?: string[];
  issues?: ParseIssue[];
  /**
   * Contract v2 claim. Omitted: a legacy parse with no claim at all. `{}`:
   * a complete container claim for the artifact's scope with
   * `observedCount = observations.length`. Fields override that claim.
   */
  coverage?: CoverageOverrides;
  runId?: number;
  observations: Observation[];
}
let sequence = 0;
export function snapshot(store: Store, options: Snapshot) {
  const sourceId = options.source ?? "synthetic-source";
  const time = options.time ?? "2026-09-01T00:00:00.000Z";
  upsertSource(store, { id: sourceId, provider: "Synthetic", ingestion: "collector-r2" });
  const runId =
    options.runId ??
    insertFetchRun(store, {
      sourceId,
      externalRunId: `synthetic-${++sequence}`,
      tool: "synthetic-query-test",
      startedAt: time,
      completedAt: time,
      status: options.status ?? "success",
      failureCount:
        options.failureCount ??
        (options.status === undefined || options.status === "success" ? 0 : 1),
    });
  const raw = putRawObject(store, new TextEncoder().encode("{}"), "application/json");
  const artifactId = insertFetchArtifact(store, {
    sourceId,
    fetchRunId: runId,
    dataset: options.dataset,
    ...(options.unit === undefined ? {} : { fetchUnitKey: options.unit }),
    fetchedAt: time,
    mime: "application/json",
    sha256: raw.sha256,
  });
  if (options.parseStatus === "missing") return { runId, artifactId };
  const parseId = insertParseRun(store, {
    artifactId,
    parserName: options.parser,
    parserVersion:
      options.parserVersion ??
      (options.parser === "sbi-foreign-cash-positions"
        ? FOREIGN_POSITION_SNAPSHOT_VERSION
        : "0.1.0"),
    parsedAt: time,
    status: options.parseStatus ?? "ok",
    warnings: options.warnings ?? [],
  });
  for (const observation of options.observations) insertObservation(store, parseId, observation);
  if (options.issues) insertParseIssues(store, parseId, options.issues);
  if (options.coverage) {
    const artifact = listArtifacts(store).find((entry) => entry.id === artifactId)!;
    const claim: CoverageClaim = {
      ...containerClaim({
        artifact,
        issues: options.issues ?? [],
        observedCount: options.observations.length,
        evidenceRefs: ["json:$"],
      }),
      ...options.coverage,
    };
    insertCoverageClaims(store, parseId, [claim], {
      status: artifact.runStatus,
      failureCount: artifact.runFailureCount,
    });
  }
  return { runId, artifactId, parseId };
}

/** Switch one dataset's selection policy; the operational table is mutable. */
export function activatePolicy(store: Store, parser: string, policy: SnapshotPolicyId): void {
  const result = store.db
    .query(
      "UPDATE dataset_snapshot_policies SET policy_id = ?1, updated_at_ms = 1 WHERE parser_name = ?2",
    )
    .run(policy, parser);
  if (result.changes !== 1) throw new Error(`no policy row for ${parser}`);
}

export const position = (code = "TEST"): PositionObservation => ({
  kind: "position",
  sourceAccount: "synthetic-account",
  securityCode: code,
  market: "XTEST",
  quantityText: "1",
  quantityScale: 0,
  rawLocator: "json:$.rows[0]",
  extra: {},
});
export const valuation = (subject = "TEST"): ValuationObservation => ({
  kind: "valuation",
  sourceAccount: "synthetic-account",
  subject,
  metric: "value",
  amountMinor: 1,
  currency: "JPY",
  rawLocator: "json:$.rows[0]",
  extra: {},
});
export const balance = (instrument = "JPY", account = "synthetic-account"): BalanceObservation => ({
  kind: "balance",
  sourceAccount: account,
  metric: "balance",
  instrument,
  amountMinor: 1,
  rawLocator: "json:$.rows[0]",
  extra: {},
});
export function facts(parser: string, label: string): Observation[] {
  if (parser.includes("positions")) return [position(label), valuation(label)];
  if (parser === "sbi-vc-position-summary") return [position(label)];
  if (parser === "sbi-account-assets-current") return [valuation(label)];
  if (parser === "sony-bank-gross-balance" || parser.endsWith("top-balances-and-activity")) {
    return [balance(label), valuation(label)];
  }
  return [balance(label)];
}
export function count(store: Store): number {
  return (
    currentPositions(store).length + currentValuations(store).length + latestBalances(store).length
  );
}
/** Every current row's label-bearing text, for "OLD is gone" assertions. */
export function currentText(store: Store): string {
  return JSON.stringify([currentPositions(store), currentValuations(store), latestBalances(store)]);
}

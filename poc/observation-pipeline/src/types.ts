// Shared types for the observation-pipeline PoC.
//
// The parser contract is the important part: a parser is a deterministic,
// versioned, side-effect-free function from raw bytes to typed observations.
// It never fetches, never reads the clock, and never drops provider fields it
// does not recognize — unrecognized material goes into `extra`.

import type { CoverageClaim, ParseIssue } from "../../../packages/domain/src/coverage.ts";
export type { CoverageClaim, ParseIssue } from "../../../packages/domain/src/coverage.ts";

export interface ArtifactMeta {
  id: number;
  sourceId: string;
  /** Terminal status of the layer-A fetch run that owns this artifact. */
  runStatus: "success" | "partial" | "failed";
  /** Number of collector failures recorded by the owning fetch run. */
  runFailureCount: number;
  /** Exact provider query window carried by collector manifests, when present. */
  runWindow?: { from: string; to: string };
  dataset: string | null;
  /** Run-relative collector artifact key, when the source manifest declares one. */
  artifactKey?: string | null;
  /** Stable collector unit key (for example a card label), when declared by Layer A. */
  fetchUnitKey?: string | null;
  /** Provider/collector statement state attached to this specific artifact. */
  statementState?: string | null;
  /** Provider statement period attached to this specific artifact. */
  period?: string | null;
  url: string | null;
  mime: string;
  fetchedAt: string;
  sha256: string;
}

export interface TransactionObservation {
  kind: "transaction";
  sourceAccount: string;
  externalId?: string;
  status?: string;
  amountMinor?: number;
  amountText?: string;
  amountScale?: number;
  currency?: string;
  description?: string;
  counterparty?: string;
  asOf?: string;
  observedAt?: string;
  rawLocator: string;
  extra: Record<string, unknown>;
}

export interface BalanceObservation {
  kind: "balance";
  sourceAccount: string;
  metric: string;
  amountMinor?: number;
  amountText?: string;
  amountScale?: number;
  instrument: string;
  asOf?: string;
  observedAt?: string;
  rawLocator: string;
  extra: Record<string, unknown>;
}

export interface PositionObservation {
  kind: "position";
  sourceAccount: string;
  securityCode: string;
  securityName?: string;
  market?: string;
  quantityText: string;
  quantityScale: number;
  currency?: string;
  asOf?: string;
  observedAt?: string;
  rawLocator: string;
  extra: Record<string, unknown>;
}

export interface ValuationObservation {
  kind: "valuation";
  sourceAccount: string;
  subject: string;
  metric: string;
  amountMinor?: number;
  amountText?: string;
  amountScale?: number;
  currency: string;
  asOf?: string;
  observedAt?: string;
  rawLocator: string;
  extra: Record<string, unknown>;
}

export type Observation =
  | TransactionObservation
  | BalanceObservation
  | PositionObservation
  | ValuationObservation;

/**
 * Parser output. Contract v1 is `observations` plus human-readable `warnings`.
 * Contract v2 (design review D01) adds typed `issues` and `coverage`, which are
 * the machine-readable record of what could not be read and what scope the
 * parse proves. Snapshot selection reads the coverage claim; it never reads
 * warning text. A parser that omits both is a "legacy" parser: its parse runs
 * store nothing beyond warnings, and the `legacy-warning-compat-v1` snapshot
 * policy keeps applying to its datasets. Nothing synthesizes `complete` for it.
 */
export interface ParseResult {
  observations: Observation[];
  /** For people. Text may change freely; no selection rule reads it. */
  warnings: string[];
  /** Typed diagnostics: what was unreadable, at what locator, with what impact. */
  issues?: ParseIssue[];
  /** One claim per container scope the parse proves or fails to prove complete. */
  coverage?: CoverageClaim[];
}

export interface Parser {
  name: string;
  version: string;
  /** Decide from artifact metadata only — parsers are selected, then applied. */
  accepts(artifact: ArtifactMeta): boolean;
  /** Deterministic: same bytes + same metadata -> same observations. */
  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult;
}

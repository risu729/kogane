// Browser-safe HTTP contracts. No database, runtime, or UI imports.
// Amount strings retain exact minor units; formatting never changes these values.
import type { ObservationOrganization } from "./organization-contract.ts";
import type { ApiCapabilities } from "./api-schema.ts";
export type { ApiCapabilities } from "./api-schema.ts";
export type ObservationKind = "transaction" | "balance" | "position" | "valuation";

/** Production list responses add this coverage record; local fixture APIs may omit it. */
export interface ApiCoverage {
  limit: number;
  truncated: boolean;
  /** Artifact pages use a descending, immutable artifact-id cursor. */
  nextCursor?: string | null;
  /** Derived observation pages use deterministic ordering; reset on scope changes. */
  nextOffset?: number | null;
  latestNextOffset?: number | null;
}

export interface FilterOptions {
  sources: string[];
  accounts: {
    source_id: string;
    source_account: string;
    display_name?: string | null;
    organization_ambiguous?: boolean;
  }[];
  instruments: string[];
  metrics: string[];
}

/** Connection names the UI has labels for. Any other name is shown generically. */
export type SourceKind = "local-store" | "central-store";

export interface ApiMetadata {
  /** Registered parsing jobs only; not collector freshness or full source coverage. */
  parsingHealth?: { pending: number; running: number; failed: number };
  apiVersion: 1;
  source: {
    /**
     * Informational: where the data comes from, for labels only. Behaviour
     * switches on `capabilities`; renaming a kind must not change the UI.
     */
    kind: SourceKind | (string & {});
    /** Synthetic is an explicit assertion by an isolated fixture-only startup. */
    classification: "unknown" | "synthetic" | "financial";
  };
  /** Explicit, versioned capabilities; see `api-schema.ts`. Never an auth switch. */
  capabilities: ApiCapabilities;
}

export interface Warnings {
  /** Parsed warning strings; empty when the stored value could not be read. */
  list: string[];
  /** The stored text, so an unreadable value can be shown rather than hidden. */
  raw: string | null;
  parsed: boolean;
}

/**
 * One partial fetch run that refreshed some but not all of a dataset's units
 * (design review D13, policy `unit-independent-v1`). Counts and identifiers
 * only: unit keys are provider-owned labels and are not reported here.
 */
export interface UnitUpdateSummary {
  source_id: string;
  dataset: string;
  fetch_run_id: number;
  fetched_at: string;
  /** Units of this run whose own terminal report succeeded, so their evidence is new. */
  updated_units: number;
  /** Units of this run that failed; their previous snapshot still stands. */
  stale_units: number;
}

export interface Overview {
  counts: { table: string; rows: number }[];
  /**
   * Present only when a partial run updated some units of a dataset on the
   * `unit` eligibility scope, which no dataset uses until an operator enables
   * it. A reader that sees this key must not describe the run as a complete
   * refresh of the dataset.
   */
  unitUpdates?: UnitUpdateSummary[];
  sources: {
    id: string;
    provider: string;
    ingestion: string;
    artifact_count: number;
  }[];
  fetchRuns: {
    id: number;
    source_id: string;
    tool: string;
    external_run_id: string | null;
    status: string;
    started_at: string;
    completed_at: string | null;
  }[];
  parseRuns: {
    id: number;
    fetch_artifact_id: number;
    parser_name: string;
    parser_version: string;
    parsed_at: string;
    status: string;
    warnings: Warnings;
    error: string | null;
    superseded_by_parse_run_id: number | null;
  }[];
}

export interface TransactionRow {
  normalized?: import("./normalized-decimal.ts").NormalizedDecimal;
  interpretation?: import("./activity-semantics.ts").ActivityMeaning;
  organization?: ObservationOrganization;
  id: number;
  source_id: string;
  source_account: string;
  as_of: string | null;
  amount_minor: string | null;
  amount_text: string | null;
  currency: string | null;
  description: string | null;
  counterparty: string | null;
  external_id: string | null;
  status: string | null;
  parser: string;
}

export interface BalanceRow {
  normalized?: import("./normalized-decimal.ts").NormalizedDecimal;
  interpretation?: import("./balance-semantics.ts").BalanceInterpretation;
  organization?: ObservationOrganization;
  id: number;
  source_id: string;
  source_account: string;
  metric: string;
  instrument: string;
  amount_minor: string | null;
  amount_text: string | null;
  as_of: string | null;
  observed_at: string | null;
  parser: string;
}

export interface BalanceHistoryRow extends BalanceRow {
  superseded_by_parse_run_id: number | null;
  parse_status: string;
}

export interface PositionRow {
  normalized?: import("./normalized-decimal.ts").NormalizedDecimal;
  organization?: ObservationOrganization;
  id: number;
  source_id: string;
  source_account: string;
  security_code: string;
  security_name: string | null;
  market: string | null;
  quantity_text: string;
  quantity_scale: number;
  currency: string | null;
  as_of: string | null;
  parser: string;
}

export interface ValuationRow {
  normalized?: import("./normalized-decimal.ts").NormalizedDecimal;
  organization?: ObservationOrganization;
  id: number;
  source_id: string;
  source_account: string;
  subject: string;
  metric: string;
  amount_minor: string | null;
  amount_text: string | null;
  currency: string;
  as_of: string | null;
  parser: string;
}

export interface PositionWithValuations {
  position: PositionRow;
  valuations: ValuationRow[];
}

export interface ArtifactRow {
  id: number;
  source_id: string;
  dataset: string | null;
  url: string | null;
  mime: string;
  fetched_at: string;
  sha256: string;
  parse_run_count: number;
  transaction_count: number;
  balance_count: number;
  position_count: number;
  valuation_count: number;
}

export interface ObservationRef {
  kind: ObservationKind;
  id: number;
  summary: string;
}

export interface ParseRunDetail {
  id: number;
  parser_name: string;
  parser_version: string;
  parsed_at: string;
  status: string;
  error: string | null;
  warnings: Warnings;
  superseded_by_parse_run_id: number | null;
  observations: ObservationRef[];
}

export interface ArtifactDetail {
  artifact: {
    id: number;
    source_id: string;
    dataset: string | null;
    url: string | null;
    method: string | null;
    http_status: number | null;
    mime: string;
    fetched_at: string;
    sha256: string;
    size: number;
    content_type: string;
    fetch_run_id: number;
    tool: string;
    external_run_id: string | null;
    fetch_status: string;
    started_at: string;
    completed_at: string | null;
  };
  parseRuns: ParseRunDetail[];
}

export interface Provenance {
  parse_run_id: number;
  parser_name: string;
  parser_version: string;
  parsed_at: string;
  parse_status: string;
  error: string | null;
  warnings: Warnings;
  superseded_by_parse_run_id: number | null;
  artifact_id: number;
  source_id: string;
  dataset: string | null;
  url: string | null;
  mime: string;
  fetched_at: string;
  sha256: string;
  size: number;
  content_type: string;
  fetch_run_id: number;
  tool: string;
  external_run_id: string | null;
  fetch_status: string;
  started_at: string;
  completed_at: string | null;
}

export interface ObservationDetail {
  normalized?: import("./normalized-decimal.ts").NormalizedDecimal;
  organization?: ObservationOrganization;
  interpretationContext?: import("./api-schema.ts").InterpretationContext;
  kind: ObservationKind;
  row: Record<string, unknown>;
  extra: unknown;
  extraRaw: string;
  extraParsed: boolean;
  provenance: Provenance | undefined;
}

// ── v2 balance read model (review D10/D11) ──────────────────────────────
//
// `/api/v2/balances/latest` and `/api/v2/balances/history` are separate
// budgets over one fixed snapshot. Each item keeps the v1-shaped evidence row
// under `row`, so a display that already understands a balance row keeps
// working, and adds the typed read-model fields next to it: the quantity a
// calculation may use, what the measure means, whether it was adopted, and
// what time the value refers to.

export type BalanceAdoptionState = "adopted" | "excluded" | "unresolved" | "conflict" | "stale";

export interface ObservedQuantityWire {
  normalized: import("./normalized-decimal.ts").NormalizedDecimal;
  unitReference: string | null;
  /** Kept as evidence; never a second numeric contract. */
  sourceRepresentation: {
    amountText: string | null;
    legacyMinorUnits: string | null;
    /** Null when the currency has no exponent in the legacy parser contract. */
    legacyMinorUnitExponent: number | null;
  };
}

export interface MeasureDescriptor {
  metricId: string;
  definitionRelease: string;
  measurementKind: string;
  aggregationRule: string;
}

export interface BalanceEvidenceMember {
  ref: string;
  observationId: number;
  metric: string;
}

export interface BalanceAdoption {
  state: BalanceAdoptionState;
  reasonCode: string | null;
  /** Every witness of this one measurement; its length is the evidence count. */
  memberEvidence: BalanceEvidenceMember[];
  evidenceCount: number;
}

/** `TemporalReference` of packages/domain, as it travels on the wire. */
export interface TemporalReferenceWire {
  role: string;
  time: Record<string, unknown>;
}

export interface LatestBalanceItem {
  observationId: number;
  row: BalanceRow;
  quantity: ObservedQuantityWire;
  metric: MeasureDescriptor;
  adoption: BalanceAdoption;
  temporal: TemporalReferenceWire;
  freshness: { state: "current" | "stale" | "unknown"; reasonCode: string | null };
}

export interface BalanceHistoryItem {
  observationId: number;
  row: BalanceHistoryRow;
  quantity: ObservedQuantityWire;
  metric: MeasureDescriptor;
  temporal: TemporalReferenceWire;
}

export interface SnapshotPageInfo {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
  snapshotId: string;
  paginationVersion: "keyset-v2";
}

export interface SnapshotDataCoverage {
  completeness: "complete" | "partial" | "unknown";
  stale: boolean;
  reasons: string[];
}

/**
 * Assets the adopted set accounts for, per unit. There is deliberately no
 * `netWorth` field: unfetched liabilities mean an asset subtotal is not even
 * a lower bound, so `liabilitiesCoverage` states that it is unknown
 * (addendum 05 section 5).
 */
export interface KnownAssetsSubtotals {
  policyRelease: string;
  knownAssetsSubtotal:
    | { unitRef: string; coefficient: string; scale: number; adoptedCount: number }[]
    | null;
  liabilitiesCoverage: "unknown";
  reasonCode: string | null;
}

export interface LatestBalancePage {
  schemaVersion: "snapshot-page-v1";
  items: LatestBalanceItem[];
  page: SnapshotPageInfo;
  dataCoverage: SnapshotDataCoverage;
  subtotals: KnownAssetsSubtotals;
  interpretationContext: import("./api-schema.ts").InterpretationContext;
}

export interface BalanceHistoryPage {
  schemaVersion: "snapshot-page-v1";
  items: BalanceHistoryItem[];
  page: SnapshotPageInfo;
  dataCoverage: SnapshotDataCoverage;
  interpretationContext: import("./api-schema.ts").InterpretationContext;
}

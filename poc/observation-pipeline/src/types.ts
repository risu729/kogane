// Shared types for the observation-pipeline PoC.
//
// The parser contract is the important part: a parser is a deterministic,
// versioned, side-effect-free function from raw bytes to typed observations.
// It never fetches, never reads the clock, and never drops provider fields it
// does not recognize — unrecognized material goes into `extra`.

export interface ArtifactMeta {
  id: number;
  sourceId: string;
  dataset: string | null;
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

export interface ParseResult {
  observations: Observation[];
  warnings: string[];
}

export interface Parser {
  name: string;
  version: string;
  /** Decide from artifact metadata only — parsers are selected, then applied. */
  accepts(artifact: ArtifactMeta): boolean;
  /** Deterministic: same bytes + same metadata -> same observations. */
  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult;
}

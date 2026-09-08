/** Layer C input: immutable Layer B plus its acquisition provenance. */
export interface IdentityInput {
  kind: "transaction" | "balance" | "position" | "valuation";
  observationId: number;
  parseRunId: number;
  artifactId: number;
  fetchRunId: number;
  sourceId: string;
  producerId: string;
  sourceAccount: string;
  currency: string | null;
  instrument: string | null;
  securityCode: string | null;
  securityName: string | null;
  market: string | null;
  subject: string | null;
  extra: Record<string, unknown>;
  /** Store-verified sidecar evidence, never sourced from provider extra_json. */
  trustedVpassBinding?: { cardToken: string; bindingArtifactId: number; financialUnitId: number };
}

export type ResolutionStatus = "identified" | "provider-local" | "aggregate" | "unresolved";
export interface AccountIdentity {
  /** Exact provider reference + discriminators, not a display label. */
  key: string[];
  label: string;
  role: string;
  status: ResolutionStatus;
  reason: string;
}

export interface InstrumentIdentity {
  role: "unit" | "security" | "trade-unit" | "usage-unit";
  kind: "money" | "security" | "crypto" | "reward" | "product" | "unknown";
  namespace: string;
  scope: string;
  value: string;
  label: string;
  status: ResolutionStatus;
  reason: string;
  /** Identifier semantics, never balances or financial amounts. */
  details: Record<string, string>;
}

export interface IdentityPlan {
  account: AccountIdentity;
  instruments: InstrumentIdentity[];
  issues: string[];
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

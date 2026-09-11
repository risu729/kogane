// Synthetic projection rows for the READ adapter tests. No provider name, no
// account number and no real amount appears here or anywhere else in this
// package's tests.
import type { DerivedScopeRelation, ProjectionRow } from "../../read-model/src/index.ts";
import { inputRefDigest, type SnapshotInputRef } from "../src/read/identity.ts";

export function projectionRow(
  rowSeq: number,
  overrides: Partial<ProjectionRow> = {},
): ProjectionRow {
  return {
    scopeKey: `balsyntheticsetparseracct-${String(rowSeq)}balanceJPY`,
    subjectScopeKey: `source-local:synthetic:acct-${String(rowSeq)}`,
    rowSeq,
    representativeObservationRef: `balance:${String(1000 + rowSeq)}`,
    memberEvidence: [
      { ref: `balance:${String(1000 + rowSeq)}`, observationId: 1000 + rowSeq, metric: "balance" },
    ],
    memberMetrics: ["balance"],
    evidenceCount: 1,
    metricId: "cash.balance",
    definitionRelease: "metric-registry-v1",
    quantityCoefficient: "1200",
    quantityScale: 0,
    valueStatus: "exact",
    unitRef: "JPY",
    state: "adopted",
    reasonCode: null,
    asOfRole: "effective",
    asOfKind: "instant",
    asOfValue: "2026-09-01T00:00:00.000Z",
    temporal: {
      role: "effective",
      time: {
        kind: "instant",
        value: "2026-09-01T00:00:00.000Z",
        zone: "UTC",
        basis: "provider",
      },
    },
    freshness: "current",
    freshnessReason: null,
    sortAsOf: "2026-09-01T00:00:00.000Z",
    sourceId: "synthetic",
    sourceAccount: `acct-${String(rowSeq)}`,
    metric: "balance",
    instrument: "JPY",
    parser: "synthetic@1",
    observationId: 1000 + rowSeq,
    parseRunId: 7,
    fetchArtifactId: 9,
    amountMinor: "1200",
    amountText: "1,200",
    asOf: "2026-09-01T00:00:00.000Z",
    observedAt: "2026-09-01T00:00:00.000Z",
    measureView: "balances",
    latestInGroup: true,
    ...overrides,
  };
}

export function decisionRelation(decisionRevisionId: string): DerivedScopeRelation {
  return {
    fromScopeKey: "source-local:synthetic:acct-0",
    toScopeKey: "source-local:synthetic:acct-1",
    relation: "same",
    source: "decision",
    decisionRevisionId,
    release: "scope-relations-v1",
  };
}

export async function decisionRef(id: string): Promise<SnapshotInputRef> {
  return {
    kind: "decision_revision",
    id,
    digest: await inputRefDigest("decision_revision", id, id),
  };
}

export const DIGEST_A = "a".repeat(64);
export const DIGEST_B = "b".repeat(64);

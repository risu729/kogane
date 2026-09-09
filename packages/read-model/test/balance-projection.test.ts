// The latest-balance projection builder against the V1 scenario fixtures of
// packages/domain. Every value is synthetic and comes from the design-review
// scenarios; nothing here describes a real account or balance.
//
// The builder is the step that turns provider rows into candidates and
// records what happened to each one. The adoption decision itself belongs to
// `selectAdoptedSet` in packages/domain, which has its own tests; what is
// proved here is that the projection hands it the right candidates and
// relations, and stores the outcome with its reason code.
import { describe, expect, test } from "bun:test";
import {
  ADOPTION_SUBJECT_BOUND,
  buildBalanceProjection,
  knownAssetMetricIds,
  scopeRelationsFromEntityRelations,
  temporalReferenceFor,
  type DerivedScopeRelation,
  type ProjectionCandidate,
} from "../src/balance-projection";
import { authorityRank, AUTHORITY_RANKS } from "../src/authority";
import { snapshotEligibility } from "../../domain/src/coverage.ts";
import sc01 from "../../domain/fixtures/v1/sc01-linked-deposit.json";
import sc06 from "../../domain/fixtures/v1/sc06-connection-only.json";
import sc15 from "../../domain/fixtures/v1/sc15-empty-snapshots.json";
import type { CoverageClaim } from "../../domain/src/coverage.ts";

/** A deposit balance the metric registry resolves to `deposit.balance`. */
function deposit(
  scopeKey: string,
  subject: string,
  amount: string,
  options: Partial<ProjectionCandidate> = {},
): ProjectionCandidate {
  return {
    scopeKey,
    subjectScopeKey: subject,
    subjectStatus: "identified",
    observationId: Number(scopeKey.replace(/\D/gu, "")) || 1,
    parseRunId: 1,
    fetchArtifactId: 1,
    sourceId: "smbc-bank",
    sourceAccount: `synthetic:${scopeKey}`,
    parser: "smbc-direct-balance@1",
    parserName: "smbc-direct-balance",
    metric: "account_balance",
    instrument: "JPY",
    amountMinor: amount,
    amountText: null,
    asOf: "2026-09-08",
    observedAt: "2026-09-08T07:00:00Z",
    normalized: {
      policyVersion: "decimal-v1",
      status: "exact",
      coefficient: amount,
      scale: 0,
      basis: "minor_units",
    },
    memberEvidence: [],
    witnessConflict: false,
    coverage: { completeness: "complete", reasonCode: null },
    freshness: { state: "current", reasonCode: null },
    authorityRank: AUTHORITY_RANKS.direct,
    measureView: "balances",
    latestInGroup: true,
    ...options,
  };
}

function relation(
  from: string,
  to: string,
  kind: DerivedScopeRelation["relation"],
): DerivedScopeRelation {
  return {
    fromScopeKey: from,
    toScopeKey: to,
    relation: kind,
    source: "decision",
    decisionRevisionId: "rev:synthetic:1",
    release: "scope-relations-v1",
  };
}

const stateOf = (build: ReturnType<typeof buildBalanceProjection>, scopeKey: string) =>
  build.rows.find((row) => row.scopeKey === scopeKey)!;

describe("balance projection builder", () => {
  test("SC01: the bank breakdown is adopted and a second route stays an unknown overlap", () => {
    // Same shape as fixtures/v1/sc01-linked-deposit.json: an ordinary and a
    // linked deposit, the bank's own total over both, and a second route
    // restating the total whose terminal accounts were never confirmed.
    expect(sc01.target).toEqual({ metricId: "deposit.balance", unitRef: "JPY" });
    const candidates = [
      deposit("m-bank-savings", "scope:bank:savings", "60000"),
      deposit("m-bank-linked", "scope:bank:linked", "100000"),
      deposit("m-bank-total", "scope:bank:total", "160000", { subjectStatus: "aggregate" }),
      // A second route reporting the same total, whose terminal accounts were
      // never confirmed: a different source, an unresolved subject, and the
      // lower authority of a restatement.
      deposit("m-route-total", "scope:route:bank-total", "160000", {
        subjectStatus: "unresolved",
        sourceId: "sbi-shinsei-bank",
        parser: "sbi-shinsei-top-balances-and-activity@1",
        parserName: "sbi-shinsei-top-balances-and-activity",
        sourceAccount: "synthetic:route",
        authorityRank: AUTHORITY_RANKS.aggregator,
      }),
    ];
    const relations = [
      relation("scope:bank:savings", "scope:bank:total", "subset"),
      relation("scope:bank:linked", "scope:bank:total", "subset"),
      relation("scope:bank:savings", "scope:bank:linked", "disjoint"),
    ];
    const build = buildBalanceProjection(candidates, relations);
    // 60,000 + 100,000 = 160,000 is adopted; the total is excluded because the
    // breakdown covers it, and both are never counted at once (SC01, INV06).
    expect(stateOf(build, "m-bank-savings").state).toBe("adopted");
    expect(stateOf(build, "m-bank-linked").state).toBe("adopted");
    expect(stateOf(build, "m-bank-total")).toMatchObject({
      state: "excluded",
      reasonCode: "covered_by_breakdown",
    });
    // The unconfirmed route is neither adopted nor deleted: it is shown as a
    // possible duplicate, and its 160,000 is never added on top.
    expect(stateOf(build, "m-route-total")).toMatchObject({
      state: "unresolved",
      reasonCode: "overlap_unknown",
    });
    expect(build.completeness).toBe("partial");
    expect(build.reasons).toContain("unresolved:overlap_unknown");
    // Independently of the comparison above: exactly the two leaf measures.
    expect(
      build.rows.filter((row) => row.state === "adopted").map((row) => row.quantityCoefficient),
    ).toEqual(["100000", "60000"]);
  });

  test("SC01 variant: a total that disagrees with its breakdown adopts neither side", () => {
    const candidates = [
      deposit("m-bank-savings", "scope:bank:savings", "60000"),
      deposit("m-bank-linked", "scope:bank:linked", "100000"),
      deposit("m-bank-total", "scope:bank:total", "150000", { subjectStatus: "aggregate" }),
    ];
    const build = buildBalanceProjection(candidates, [
      relation("scope:bank:savings", "scope:bank:total", "subset"),
      relation("scope:bank:linked", "scope:bank:total", "subset"),
      relation("scope:bank:savings", "scope:bank:linked", "disjoint"),
    ]);
    for (const key of ["m-bank-savings", "m-bank-linked", "m-bank-total"])
      expect(stateOf(build, key)).toMatchObject({
        state: "unresolved",
        reasonCode: "total_breakdown_mismatch",
      });
    expect(build.rows.some((row) => row.state === "adopted")).toBe(false);
  });

  test("SC06: an accepted connection is a containment; a proposed same-account is not a relation", () => {
    const relations = scopeRelationsFromEntityRelations(
      sc06.typedRelations.map((row) => ({
        id: row.relationId,
        kind: row.kind,
        from_ref: row.left,
        to_ref: row.right,
        status: row.status === "adopted" ? "accepted" : row.status,
        decision_revision_id: row.decisionRevisionRef,
      })),
    );
    // The three connection_contains claims become subsets of the connection.
    expect(relations).toHaveLength(3);
    expect(relations.every((row) => row.relation === "subset")).toBe(true);
    expect(relations.map((row) => row.toScopeKey)).toEqual([
      "connection:mf:x",
      "connection:mf:x",
      "connection:mf:x",
    ]);
    // The proposed same_account contributes nothing: knowing the connection
    // never establishes which terminal account a line belongs to.
    expect(relations.some((row) => row.relation === "same")).toBe(false);

    const candidates = [
      deposit("m-direct-yen", "source_account:direct:yen-ordinary", "60000"),
      deposit("m-direct-linked", "source_account:direct:linked-deposit", "100000"),
      deposit("m-connection-line", "source_account:mf:x:line-1", "60000", {
        subjectStatus: "unresolved",
        sourceId: "sbi-shinsei-bank",
        parser: "sbi-shinsei-top-balances-and-activity@1",
        parserName: "sbi-shinsei-top-balances-and-activity",
        sourceAccount: "synthetic:mf-line",
        authorityRank: AUTHORITY_RANKS.aggregator,
      }),
    ];
    const build = buildBalanceProjection(candidates, relations);
    expect(stateOf(build, "m-direct-yen").state).toBe("adopted");
    expect(stateOf(build, "m-direct-linked").state).toBe("adopted");
    expect(stateOf(build, "m-connection-line")).toMatchObject({
      state: "unresolved",
      reasonCode: "overlap_unknown",
    });
    expect(sc06.expected.unresolved).toEqual({ "m-mf-line-1": "overlap_unknown" });
  });

  test("SC15: the four meanings of an empty fetch stay four different answers", () => {
    const outcomes = sc15.cases.map((entry) => snapshotEligibility(entry.claim as CoverageClaim));
    expect(
      outcomes.map((outcome) => `${String(outcome.replacesPrevious)}:${outcome.reasonCode}`),
    ).toEqual(
      sc15.cases.map(
        (entry) => `${String(entry.expected.replacesPrevious)}:${entry.expected.reasonCode}`,
      ),
    );
    // Only the complete empty container replaces the previous holdings; the
    // rest keep the old row and are shown as stale with their own reason.
    expect(outcomes.filter((outcome) => outcome.replacesPrevious)).toHaveLength(1);
    const staleCandidate = deposit("m-stale", "scope:bank:savings", "60000", {
      freshness: { state: "stale", reasonCode: "no_new_observation" },
    });
    const build = buildBalanceProjection([staleCandidate], []);
    expect(stateOf(build, "m-stale")).toMatchObject({
      state: "stale",
      reasonCode: "no_new_observation",
      freshness: "stale",
    });
    expect(build.stale).toBe(true);
    expect(build.completeness).toBe("partial");
  });

  test("a disagreeing witness bundle stays a conflict and is never collapsed", () => {
    const build = buildBalanceProjection(
      [deposit("m-conflict", "scope:bank:savings", "60000", { witnessConflict: true })],
      [],
    );
    expect(stateOf(build, "m-conflict")).toMatchObject({
      state: "conflict",
      reasonCode: "witness_value_conflict",
    });
  });

  test("a value that is not exact is never adopted and never becomes zero", () => {
    const build = buildBalanceProjection(
      [
        deposit("m-missing", "scope:bank:savings", "0", {
          normalized: {
            policyVersion: "decimal-v1",
            status: "missing",
            coefficient: null,
            scale: null,
            basis: "none",
          },
        }),
      ],
      [],
    );
    expect(stateOf(build, "m-missing")).toMatchObject({
      state: "unresolved",
      reasonCode: "value_not_exact",
      quantityCoefficient: null,
      valueStatus: "missing",
    });
  });

  test("rows are ordered as_of descending then scope key ascending, with a dense position", () => {
    const build = buildBalanceProjection(
      [
        deposit("b", "scope:b", "1", { asOf: "2026-09-01" }),
        deposit("a", "scope:a", "2", { asOf: "2026-09-09" }),
        deposit("c", "scope:c", "3", { asOf: "2026-09-09" }),
        deposit("d", "scope:d", "4", { asOf: null, observedAt: null }),
      ],
      [],
    );
    expect(build.rows.map((row) => row.scopeKey)).toEqual(["a", "c", "b", "d"]);
    expect(build.rows.map((row) => row.rowSeq)).toEqual([0, 1, 2, 3]);
    // An unknown time sorts last and says so instead of being given a date.
    expect(stateOf(build, "d").asOfKind).toBe("unknown");
  });

  test("a target with more scopes than the build bound is unresolved, never silently adopted", () => {
    const candidates = Array.from({ length: ADOPTION_SUBJECT_BOUND + 1 }, (_, index) =>
      deposit(`m-${String(index).padStart(4, "0")}`, `scope:${String(index)}`, "1"),
    );
    const build = buildBalanceProjection(candidates, []);
    expect(build.rows.every((row) => row.state === "unresolved")).toBe(true);
    expect(build.rows.every((row) => row.reasonCode === "adoption_target_oversized")).toBe(true);
  });

  test("temporal references keep the precision of the stored value", () => {
    expect(temporalReferenceFor("2026-09-08", null)).toEqual({
      role: "effective",
      time: { kind: "local-date", value: "2026-09-08", zone: null, basis: "provider" },
    });
    expect(temporalReferenceFor(null, "2026-09-08T07:00:00Z")).toEqual({
      role: "observed",
      time: { kind: "instant", value: "2026-09-08T07:00:00Z", zone: "UTC", basis: "provider" },
    });
    expect(temporalReferenceFor("2026-09-08T16:00:00+09:00", null)).toEqual({
      role: "effective",
      time: {
        kind: "instant",
        value: "2026-09-08T16:00:00+09:00",
        zone: "Etc/GMT-9",
        basis: "provider",
      },
    });
    expect(temporalReferenceFor("2026-09", null).time).toEqual({
      kind: "unknown",
      reasonCode: "time_text_unrecognised",
    });
    expect(temporalReferenceFor(null, null).time).toEqual({
      kind: "unknown",
      reasonCode: "no_recorded_time",
    });
  });

  test("the source authority policy ranks aggregators below direct sources", () => {
    expect(authorityRank("smbc-bank")).toBe(AUTHORITY_RANKS.direct);
    expect(authorityRank("moneyforward")).toBe(AUTHORITY_RANKS.aggregator);
    expect(authorityRank("synthetic-unknown-source")).toBe(AUTHORITY_RANKS.unreviewed);
  });

  test("only sum-disjoint currency stocks may enter a known-assets subtotal", () => {
    const ids = knownAssetMetricIds();
    expect(ids).toContain("deposit.balance");
    // Capacities, aggregates, statement amounts, period totals, reward units
    // and balances restated after a transaction are all excluded.
    for (const excluded of [
      "broker.buying-power",
      "bank.gross-asset-aggregate",
      "card.statement-payment-amount",
      "reward.bucket-balance",
      "deposit.balance-after-transaction",
      "unknown",
    ])
      expect(ids).not.toContain(excluded);
  });
});

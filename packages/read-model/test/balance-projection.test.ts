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
    accountEntity: null,
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

  test("two routes each accepted as the same account as a third are one measurement (INV06)", () => {
    // A reviewer accepted `same_account` for each of two second routes against
    // one direct account, and nothing between the two routes. Read in scope
    // key order (route 1, route 2, direct), the first-match grouping put route
    // 2 apart from {route 1, direct} and adopted both route 2 and the direct
    // reading: one balance twice in the adopted set and the subtotal. The two
    // routes come from one source, so the within-source policy also declares
    // them disjoint; the accepted `same` claims still make one measurement of
    // the three (ADR 0001's amendment of 2026-11-18).
    const route = (scopeKey: string, subject: string) =>
      deposit(scopeKey, subject, "100000", {
        subjectStatus: "unresolved",
        sourceId: "sbi-shinsei-bank",
        parser: "sbi-shinsei-top-balances-and-activity@1",
        parserName: "sbi-shinsei-top-balances-and-activity",
        sourceAccount: `synthetic:${scopeKey}`,
        authorityRank: AUTHORITY_RANKS.aggregator,
      });
    const relations = scopeRelationsFromEntityRelations(
      ["source_account:route:1", "source_account:route:2"].map((from, index) => ({
        id: `relation:synthetic:${String(index)}`,
        kind: "same_account",
        from_ref: from,
        to_ref: "source_account:direct:shared",
        status: "accepted",
        decision_revision_id: `rev:synthetic:${String(index)}`,
      })),
    );
    const build = buildBalanceProjection(
      [
        route("m-route-1", "source_account:route:1"),
        route("m-route-2", "source_account:route:2"),
        deposit("m-shared", "source_account:direct:shared", "100000"),
      ],
      relations,
    );
    expect(
      build.relations.filter(
        (relation) =>
          relation.fromScopeKey === "source_account:route:1" &&
          relation.toScopeKey === "source_account:route:2",
      ),
    ).toMatchObject([{ relation: "disjoint", source: "policy" }]);
    expect(stateOf(build, "m-shared").state).toBe("adopted");
    for (const scopeKey of ["m-route-1", "m-route-2"])
      expect(stateOf(build, scopeKey)).toMatchObject({
        state: "excluded",
        reasonCode: "duplicate_evidence",
      });
    expect(
      build.rows.filter((row) => row.state === "adopted").map((row) => row.quantityCoefficient),
    ).toEqual(["100000"]);
  });

  test("a provider-local Mizuho account adopts as before and never sums with an aggregator line", () => {
    // Identity policy 2 moved Mizuho ordinary deposits from `unresolved` to
    // `provider-local`. Adoption and overlap must not change: two accounts the
    // provider lists apart stay disjoint, and an aggregator line for the same
    // bank stays a possible duplicate even when that line is identified.
    const build = (mizuho: ProjectionCandidate["subjectStatus"], line: typeof mizuho) =>
      buildBalanceProjection(
        [
          ...["001:1234567", "001:7654321"].map((account, index) =>
            deposit(`m-mizuho-${String(index)}`, `source_account:mizuho:${account}`, "50000", {
              subjectStatus: mizuho,
              sourceId: "mizuho-bank",
              sourceAccount: `mizuho-bank:ordinary:${account}`,
              parser: "mizuho-account-list@1.0.0",
              parserName: "mizuho-account-list",
            }),
          ),
          // A second route restating one of them inside the same target, as in
          // SC06. (MoneyForward's own rows resolve to no registered metric and
          // never share the `deposit.balance` target at all.)
          deposit("m-aggregator-line", "source_account:route:mizuho-line", "50000", {
            subjectStatus: line,
            sourceId: "sbi-shinsei-bank",
            parser: "sbi-shinsei-top-balances-and-activity@1",
            parserName: "sbi-shinsei-top-balances-and-activity",
            sourceAccount: "synthetic:route-mizuho-line",
            authorityRank: AUTHORITY_RANKS.aggregator,
          }),
        ],
        [],
      );
    const outcome = (result: ReturnType<typeof buildBalanceProjection>) =>
      result.rows.map((row) => [row.scopeKey, row.state, row.reasonCode]);
    const before = build("unresolved", "unresolved");
    for (const after of [
      build("provider-local", "unresolved"),
      build("provider-local", "identified"),
    ])
      expect(outcome(after)).toEqual(outcome(before));
    expect(stateOf(before, "m-mizuho-0").state).toBe("adopted");
    expect(stateOf(before, "m-mizuho-1").state).toBe("adopted");
    expect(stateOf(before, "m-aggregator-line")).toMatchObject({
      state: "unresolved",
      reasonCode: "overlap_unknown",
    });
    expect(
      before.rows.filter((row) => row.state === "adopted").map((row) => row.quantityCoefficient),
    ).toEqual(["50000", "50000"]);
  });

  test("listed direct deposits at different institutions are disjoint without identity adoption", () => {
    // Two banks' own deposit balances in one target, provider-local, with no
    // adopted relation between them. v1 ranked `mizuho-bank` unreviewed, so
    // the other bank was adopted and Mizuho alone was left unresolved; as two
    // direct sources the deposit allow-list now establishes disjointness.
    const build = (mizuhoRank: number) =>
      buildBalanceProjection(
        [
          deposit("m-smbc", "source_account:smbc:ordinary", "70000", {
            subjectStatus: "provider-local",
            authorityRank: authorityRank("smbc-bank"),
          }),
          deposit("m-mizuho", "source_account:mizuho:ordinary", "50000", {
            subjectStatus: "provider-local",
            sourceId: "mizuho-bank",
            sourceAccount: "mizuho-bank:ordinary:001:1234567",
            parser: "mizuho-account-list@1.0.0",
            parserName: "mizuho-account-list",
            authorityRank: mizuhoRank,
          }),
        ],
        [],
      );
    const v1 = build(AUTHORITY_RANKS.unreviewed);
    expect(stateOf(v1, "m-smbc").state).toBe("adopted");
    expect(stateOf(v1, "m-mizuho")).toMatchObject({
      state: "unresolved",
      reasonCode: "overlap_unknown",
    });
    const v2 = build(authorityRank("mizuho-bank"));
    for (const scopeKey of ["m-smbc", "m-mizuho"])
      expect(stateOf(v2, scopeKey)).toMatchObject({
        state: "adopted",
        reasonCode: null,
      });
  });

  test("all registry-listed bank deposit readings qualify, but other metrics and unknown sources do not", () => {
    const smbc = deposit("m-smbc", "smbc-own", "11", { subjectStatus: "provider-local" });
    for (const [sourceId, parserName, metric] of [
      ["sbi-shinsei-bank", "sbi-shinsei-yen-deposit-account", "yen_deposit_account_balance"],
      ["sbi-shinsei-bank", "sbi-shinsei-yen-deposit-account", "yen_deposit_savings_balance"],
      ["sbi-shinsei-bank", "sbi-shinsei-top-balances-and-activity", "account_balance"],
      ["mizuho-bank", "mizuho-account-list", "account_balance"],
    ] as const) {
      const other = deposit("m-other", "other-own", "17", {
        sourceId,
        parserName,
        metric,
        subjectStatus: "provider-local",
      });
      const build = buildBalanceProjection([smbc, other], []);
      expect(build.rows.map((row) => [row.state, row.reasonCode])).toEqual([
        ["adopted", null],
        ["adopted", null],
      ]);
      expect(build.relations).toHaveLength(1);
      for (const subjectStatus of ["aggregate", "unresolved"] as const) {
        const excluded = buildBalanceProjection([smbc, { ...other, subjectStatus }], []);
        expect(excluded.relations).toHaveLength(0);
        expect(excluded.rows.every((row) => row.reasonCode === "overlap_unknown")).toBe(true);
      }
      for (const patch of [
        { authorityRank: AUTHORITY_RANKS.aggregator },
        { sourceId: "unknown-bank" },
        { sourceId: "moneyforward" },
        { parserName: "unknown-parser" },
        { metric: "unlisted_balance" },
      ]) {
        expect(buildBalanceProjection([smbc, { ...other, ...patch }], []).relations).toHaveLength(
          0,
        );
      }
    }
  });

  test("a shared scope with an unlisted witness cannot gain the new policy by input order", () => {
    const smbc = deposit("m-smbc", "smbc-own", "11", { subjectStatus: "provider-local" });
    const direct = deposit("m-direct", "shinsei-own", "17", {
      sourceId: "sbi-shinsei-bank",
      parserName: "sbi-shinsei-top-balances-and-activity",
      subjectStatus: "provider-local",
    });
    const restated = {
      ...direct,
      scopeKey: "m-restated",
      authorityRank: AUTHORITY_RANKS.aggregator,
    };
    for (const witnesses of [
      [direct, restated],
      [restated, direct],
    ])
      expect(buildBalanceProjection([smbc, ...witnesses], []).relations).toHaveLength(0);
  });

  describe("two references identity maps to one account entity (ADR 0001's amendment of 2026-11-20)", () => {
    // Eight provider-local references of one source, each its own entity,
    // and a ninth reference whose current mapping names the entity of the
    // first. v2 declared all nine listed apart and adopted nine amounts.
    const smbc = (index: number, entity = `account:synthetic:${String(index)}`) =>
      deposit(`m-smbc-${String(index)}`, `source_account:smbc:${String(index)}`, "1000", {
        subjectStatus: "provider-local",
        accountEntity: entity,
      });
    const eight = Array.from({ length: 8 }, (_, index) => smbc(index));
    const second = deposit("m-smbc-second", "source_account:smbc:second", "1000", {
      subjectStatus: "provider-local",
      accountEntity: "account:synthetic:0",
    });
    const adopted = (build: ReturnType<typeof buildBalanceProjection>) =>
      build.rows.filter((row) => row.state === "adopted").map((row) => row.scopeKey);

    test("references of different entities still count separately", () => {
      const build = buildBalanceProjection(eight, []);
      expect(adopted(build)).toHaveLength(8);
      expect(build.completeness).toBe("complete");
      // 8 choose 2 policy relations, every one of them `disjoint`.
      expect(build.relations).toHaveLength(28);
    });

    test("a second reference of one entity is neither adopted nor declared disjoint", () => {
      for (const order of [
        [...eight, second],
        [second, ...[...eight].reverse()],
      ]) {
        const build = buildBalanceProjection(order, []);
        // The entity's two references stay unresolved with the closed reason;
        // the seven other accounts are adopted exactly as before.
        expect([...adopted(build)].sort()).toEqual(
          [1, 2, 3, 4, 5, 6, 7].map((index) => `m-smbc-${String(index)}`),
        );
        for (const scopeKey of ["m-smbc-0", "m-smbc-second"])
          expect(stateOf(build, scopeKey)).toMatchObject({
            state: "unresolved",
            reasonCode: "account_entity_shared",
          });
        expect(build.reasons).toEqual(["unresolved:account_entity_shared"]);
        expect(build.completeness).toBe("partial");
        expect(
          build.relations.filter((relation) =>
            [relation.fromScopeKey, relation.toScopeKey].every((key) =>
              ["source_account:smbc:0", "source_account:smbc:second"].includes(key),
            ),
          ),
        ).toEqual([]);
        expect(
          build.relations.every(
            (relation) => relation.release === "distinct-identified-accounts-v3",
          ),
        ).toBe(true);
      }
    });

    test("an input captured before the field existed builds as v2 did", () => {
      const legacy = [...eight, second].map((candidate) => {
        const { accountEntity: _omitted, ...rest } = candidate;
        return rest as ProjectionCandidate;
      });
      expect(adopted(buildBalanceProjection(legacy, []))).toHaveLength(9);
    });

    test("an accepted same_account between the two references bundles them into one", () => {
      const relations = scopeRelationsFromEntityRelations([
        {
          id: "relation:synthetic:same",
          kind: "same_account",
          from_ref: "source_account:smbc:second",
          to_ref: "source_account:smbc:0",
          status: "accepted",
          decision_revision_id: "rev:synthetic:same",
        },
      ]);
      const build = buildBalanceProjection([...eight, second], relations);
      expect(adopted(build)).toHaveLength(8);
      expect(stateOf(build, "m-smbc-0").state).toBe("adopted");
      expect(stateOf(build, "m-smbc-second")).toMatchObject({
        state: "excluded",
        reasonCode: "duplicate_evidence",
      });
      expect(build.completeness).toBe("complete");
    });

    test("cross-source identified references of one entity are not disjoint", () => {
      // Two direct banks' own deposit readings, both identified and at two
      // listed institutions: v2 declared them disjoint twice over.
      const mizuho = (entity: string) =>
        deposit("m-mizuho", "source_account:mizuho:ordinary", "1000", {
          sourceId: "mizuho-bank",
          sourceAccount: "mizuho-bank:ordinary:synthetic",
          parser: "mizuho-account-list@1.0.0",
          parserName: "mizuho-account-list",
          accountEntity: entity,
        });
      const own = deposit("m-smbc", "source_account:smbc:ordinary", "1000", {
        accountEntity: "account:synthetic:shared",
      });
      const apart = buildBalanceProjection([own, mizuho("account:synthetic:other")], []);
      expect(adopted(apart)).toEqual(["m-mizuho", "m-smbc"]);
      const shared = buildBalanceProjection([own, mizuho("account:synthetic:shared")], []);
      expect(shared.relations).toEqual([]);
      expect(adopted(shared)).toEqual([]);
      for (const scopeKey of ["m-mizuho", "m-smbc"])
        expect(stateOf(shared, scopeKey)).toMatchObject({
          state: "unresolved",
          reasonCode: "account_entity_shared",
        });
      // A lower-authority route of the same entity: authority keeps the
      // direct reading adopted and names the route's reason.
      const route = deposit("m-route", "source_account:route:ordinary", "1000", {
        sourceId: "sbi-shinsei-bank",
        parser: "sbi-shinsei-top-balances-and-activity@1",
        parserName: "sbi-shinsei-top-balances-and-activity",
        sourceAccount: "synthetic:route",
        authorityRank: AUTHORITY_RANKS.aggregator,
        accountEntity: "account:synthetic:shared",
      });
      const ranked = buildBalanceProjection([own, route], []);
      expect(adopted(ranked)).toEqual(["m-smbc"]);
      expect(stateOf(ranked, "m-route")).toMatchObject({
        state: "unresolved",
        reasonCode: "account_entity_shared",
      });
    });

    test("aggregates beside members are unchanged", () => {
      // SC01's shape with an entity on every scope: the breakdown is adopted,
      // the bank's total is covered by it and the second route stays an
      // unknown overlap with its v2 reason.
      const candidates = [
        deposit("m-bank-savings", "scope:bank:savings", "60000", {
          accountEntity: "account:synthetic:savings",
        }),
        deposit("m-bank-linked", "scope:bank:linked", "100000", {
          accountEntity: "account:synthetic:linked",
        }),
        deposit("m-bank-total", "scope:bank:total", "160000", {
          subjectStatus: "aggregate",
          accountEntity: "account:synthetic:total",
        }),
        deposit("m-route-total", "scope:route:bank-total", "160000", {
          subjectStatus: "unresolved",
          sourceId: "sbi-shinsei-bank",
          parser: "sbi-shinsei-top-balances-and-activity@1",
          parserName: "sbi-shinsei-top-balances-and-activity",
          sourceAccount: "synthetic:route",
          authorityRank: AUTHORITY_RANKS.aggregator,
          accountEntity: "account:synthetic:route",
        }),
      ];
      const relations = [
        relation("scope:bank:savings", "scope:bank:total", "subset"),
        relation("scope:bank:linked", "scope:bank:total", "subset"),
      ];
      const outcome = (build: ReturnType<typeof buildBalanceProjection>) =>
        build.rows.map((row) => [row.scopeKey, row.state, row.reasonCode]);
      const withEntities = buildBalanceProjection(candidates, relations);
      const without = buildBalanceProjection(
        candidates.map((candidate) => ({ ...candidate, accountEntity: null })),
        relations,
      );
      expect(outcome(withEntities)).toEqual(outcome(without));
      expect([...adopted(withEntities)].sort()).toEqual(["m-bank-linked", "m-bank-savings"]);
      expect(stateOf(withEntities, "m-bank-total").reasonCode).toBe("covered_by_breakdown");
      expect(stateOf(withEntities, "m-route-total").reasonCode).toBe("overlap_unknown");
    });

    test("an unknown overlap with no shared entity keeps its own reason", () => {
      // The second reference shares an entity, but the aggregate line beside
      // them does not: its overlap is still `overlap_unknown`.
      const total = deposit("m-total", "source_account:smbc:total", "9000", {
        subjectStatus: "aggregate",
        accountEntity: "account:synthetic:total",
      });
      const build = buildBalanceProjection([...eight, second, total], []);
      expect(stateOf(build, "m-total")).toMatchObject({
        state: "unresolved",
        reasonCode: "overlap_unknown",
      });
      expect(stateOf(build, "m-smbc-second").reasonCode).toBe("account_entity_shared");
    });

    // A lower-authority route at another source, provider-local, so no policy
    // rule relates it to the bank's references by itself.
    const routeLine = (scopeKey: string, subject: string, entity: string) =>
      deposit(scopeKey, subject, "1000", {
        subjectStatus: "provider-local",
        sourceId: "sbi-shinsei-bank",
        parser: "sbi-shinsei-top-balances-and-activity@1",
        parserName: "sbi-shinsei-top-balances-and-activity",
        sourceAccount: `synthetic:${scopeKey}`,
        authorityRank: AUTHORITY_RANKS.aggregator,
        accountEntity: entity,
      });

    test("a decided part that shares an entity keeps its whole from being declared disjoint", () => {
      // The route line is decided a part of the bank's first account and
      // shares the second account's entity. Declaring the two bank accounts
      // disjoint made the part disjoint from the second account through
      // step 7's one-step derivation, and both were adopted.
      const whole = deposit("m-whole", "source_account:smbc:whole", "1000", {
        accountEntity: "account:synthetic:whole",
      });
      const other = deposit("m-other", "source_account:smbc:other", "1000", {
        accountEntity: "account:synthetic:shared",
      });
      const part = routeLine("m-part", "source_account:route:part", "account:synthetic:shared");
      const build = buildBalanceProjection(
        [whole, other, part],
        [relation("source_account:route:part", "source_account:smbc:whole", "subset")],
      );
      expect(adopted(build)).toEqual(["m-other"]);
      expect(stateOf(build, "m-whole").reasonCode).toBe("covered_by_breakdown");
      expect(stateOf(build, "m-part")).toMatchObject({
        state: "unresolved",
        reasonCode: "account_entity_shared",
      });
      expect(build.relations.filter((entry) => entry.source === "policy")).toEqual([]);
    });

    test("a scope decided the same as one that shares an entity is not declared disjoint", () => {
      // The bank's first account is decided the same account as a route line,
      // and the route line shares the second account's entity. Declaring the
      // two bank accounts disjoint adopted both.
      const first = deposit("m-first", "source_account:smbc:first", "1000", {
        accountEntity: "account:synthetic:first",
      });
      const second = deposit("m-second", "source_account:smbc:second", "1000", {
        accountEntity: "account:synthetic:shared",
      });
      const line = routeLine("m-line", "source_account:route:line", "account:synthetic:shared");
      const build = buildBalanceProjection(
        [first, second, line],
        [relation("source_account:smbc:first", "source_account:route:line", "same")],
      );
      expect(adopted(build)).toEqual([]);
      expect(stateOf(build, "m-line").reasonCode).toBe("duplicate_evidence");
      for (const scopeKey of ["m-first", "m-second"])
        expect(stateOf(build, scopeKey)).toMatchObject({
          state: "unresolved",
          reasonCode: "account_entity_shared",
        });
      // Only a shared entity withholds the policy: beside a third bank
      // account of its own entity, the first stays declared disjoint from it.
      const third = deposit("m-third", "source_account:smbc:third", "1000", {
        accountEntity: "account:synthetic:third",
      });
      expect(
        buildBalanceProjection(
          [first, third, line],
          [relation("source_account:smbc:first", "source_account:route:line", "same")],
        ).relations.filter((entry) => entry.source === "policy"),
      ).toHaveLength(1);
    });

    test("a decided part lies inside its whole's entity", () => {
      // A route line shares the bank account's entity and is decided to hold
      // the bank's pocket. The pocket covers the line, and declaring the
      // pocket and the account disjoint (listed apart) adopted both: the
      // pocket's money inside the account, counted twice.
      const pocket = deposit("m-pocket", "source_account:smbc:pocket", "1000", {
        accountEntity: "account:synthetic:pocket",
      });
      const account = deposit("m-account", "source_account:smbc:account", "1000", {
        accountEntity: "account:synthetic:shared",
      });
      const line = routeLine("m-line", "source_account:route:line", "account:synthetic:shared");
      const build = buildBalanceProjection(
        [pocket, account, line],
        [relation("source_account:smbc:pocket", "source_account:route:line", "subset")],
      );
      expect(stateOf(build, "m-line").reasonCode).toBe("covered_by_breakdown");
      expect(adopted(build)).toEqual([]);
      for (const scopeKey of ["m-pocket", "m-account"])
        expect(stateOf(build, scopeKey)).toMatchObject({
          state: "unresolved",
          reasonCode: "account_entity_shared",
        });
      // Two pockets of one entity are not shared by that alone.
      const second = deposit("m-second", "source_account:smbc:second", "1000", {
        accountEntity: "account:synthetic:second",
      });
      expect(
        buildBalanceProjection(
          [pocket, second, line],
          [
            relation("source_account:smbc:pocket", "source_account:route:line", "subset"),
            relation("source_account:smbc:second", "source_account:route:line", "subset"),
          ],
        ).relations.filter((entry) => entry.source === "policy"),
      ).toHaveLength(1);
    });

    test("a part two decisions deep still keeps its outer whole from being declared disjoint", () => {
      // part ⊂ middle ⊂ outer, and the part shares the second account's
      // entity. The middle covers nothing once the part covers it, so the
      // outer stands alone, and declaring it disjoint from the second account
      // adopted both.
      const outer = deposit("m-outer", "source_account:smbc:outer", "1000", {
        accountEntity: "account:synthetic:outer",
      });
      const second = deposit("m-second", "source_account:smbc:second", "1000", {
        accountEntity: "account:synthetic:shared",
      });
      // The middle is the route's aggregate line, so the policy does not
      // declare it disjoint from the part it is decided to hold.
      const middle = {
        ...routeLine("m-middle", "source_account:route:middle", "account:synthetic:mid"),
        subjectStatus: "aggregate" as const,
      };
      const part = routeLine("m-part", "source_account:route:part", "account:synthetic:shared");
      const build = buildBalanceProjection(
        [outer, second, middle, part],
        [
          relation("source_account:route:part", "source_account:route:middle", "subset"),
          relation("source_account:route:middle", "source_account:smbc:outer", "subset"),
        ],
      );
      expect(adopted(build)).toEqual([]);
      for (const scopeKey of ["m-outer", "m-second"])
        expect(stateOf(build, scopeKey)).toMatchObject({
          state: "unresolved",
          reasonCode: "account_entity_shared",
        });
    });

    test("a same chain through scopes outside the target still carries the entity", () => {
      // first ≡ x ≡ y ≡ line, x and y have no candidate here, and the line
      // shares the second account's entity. The target's relations alone
      // missed x ≡ y, and declaring the two bank accounts disjoint adopted
      // both.
      const first = deposit("m-first", "source_account:smbc:first", "1000", {
        accountEntity: "account:synthetic:first",
      });
      const second = deposit("m-second", "source_account:smbc:second", "1000", {
        accountEntity: "account:synthetic:shared",
      });
      const line = routeLine("m-line", "source_account:route:line", "account:synthetic:shared");
      const build = buildBalanceProjection(
        [first, second, line],
        [
          relation("source_account:smbc:first", "source_account:other:x", "same"),
          relation("source_account:other:x", "source_account:other:y", "same"),
          relation("source_account:other:y", "source_account:route:line", "same"),
        ],
      );
      expect(adopted(build)).toEqual([]);
      for (const scopeKey of ["m-first", "m-second"])
        expect(stateOf(build, scopeKey)).toMatchObject({
          state: "unresolved",
          reasonCode: "account_entity_shared",
        });
    });

    test("a chain that passes through an entity still carries it", () => {
      // The route's pocket line shares the bank pocket's entity and is
      // decided a part of the route's account line, which shares the bank
      // account's entity. No decision touches the bank pocket or the bank
      // account, and the closure read only their own decisions, so the two
      // were declared disjoint (listed apart) and both adopted: the pocket's
      // money inside the account, counted twice.
      const pocket = deposit("m-pocket", "source_account:smbc:pocket", "1000", {
        accountEntity: "account:synthetic:pocket",
      });
      const account = deposit("m-account", "source_account:smbc:account", "3000", {
        accountEntity: "account:synthetic:account",
      });
      const pocketLine = routeLine(
        "m-pocket-line",
        "source_account:route:pocket",
        "account:synthetic:pocket",
      );
      const accountLine = routeLine(
        "m-account-line",
        "source_account:route:account",
        "account:synthetic:account",
      );
      const build = buildBalanceProjection(
        [pocket, account, pocketLine, accountLine],
        [relation("source_account:route:pocket", "source_account:route:account", "subset")],
      );
      expect(adopted(build)).toEqual([]);
      for (const scopeKey of ["m-pocket", "m-account"])
        expect(stateOf(build, scopeKey)).toMatchObject({
          state: "unresolved",
          reasonCode: "account_entity_shared",
        });
      expect(
        build.relations.some(
          (entry) =>
            entry.source === "policy" &&
            [entry.fromScopeKey, entry.toScopeKey].sort().join(" ") ===
              "source_account:smbc:account source_account:smbc:pocket",
        ),
      ).toBe(false);
    });
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
    expect(authorityRank("moneyforward-me")).toBe(AUTHORITY_RANKS.aggregator);
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

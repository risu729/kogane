// Snapshot policy ownership (design review D01, A03): the policy table seed
// must mirror the SNAPSHOT_DATASETS registry, every dataset must start on the
// legacy adapter, and the shadow comparison must agree on the synthetic
// fixture set except where the two policies intentionally disagree.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PARSERS } from "../src/parsers/registry.ts";
import { containerScopeKey } from "../src/parsers/coverage.ts";
import { sbiForeignCashBalances } from "../src/parsers/sbi-foreign-cash-balances.ts";
import {
  containerScopeKeySql,
  FOREIGN_POSITION_SNAPSHOT_VERSION,
  LEGACY_SNAPSHOT_POLICY,
  LOCAL_SNAPSHOT_RELATIONS,
  SNAPSHOT_DATASETS,
  snapshotPolicyComparisonSql,
  type SnapshotPolicyComparisonRow,
} from "../src/snapshot-query.ts";
import { listArtifacts, type Store } from "../src/store.ts";
import { balance, closeStores, database, facts, snapshot } from "./snapshot-fixture.ts";

afterEach(closeStores);

interface PolicyRow {
  source_id: string;
  dataset: string;
  parser_name: string;
  policy_id: string;
  policy_version: number;
  required_parser_version: string | null;
  replaces_previous_on_complete_empty: number;
  unit_scope: string;
}
function policyRows(store: Store): PolicyRow[] {
  return store.db
    .query("SELECT * FROM dataset_snapshot_policies ORDER BY parser_name, dataset")
    .all() as PolicyRow[];
}

describe("dataset_snapshot_policies seed", () => {
  test("mirrors SNAPSHOT_DATASETS exactly, so a new snapshot parser without a policy row fails CI", () => {
    const rows = policyRows(database());
    const seeded = rows.map((row) => [row.parser_name, row.dataset] as const).sort();
    const registry = [...SNAPSHOT_DATASETS].sort();
    expect(seeded).toEqual(registry);
    for (const [parser] of SNAPSHOT_DATASETS)
      expect(
        PARSERS.some((candidate) => candidate.name === parser),
        parser,
      ).toBe(true);
    // The migration file itself, not only the applied table, names every row.
    const sql = readFileSync(
      join(import.meta.dir, "../../../services/raw-evidence/migrations/0025_parse_coverage.sql"),
      "utf8",
    );
    for (const [parser, dataset] of SNAPSHOT_DATASETS)
      expect(sql).toContain(`'${dataset}','${parser}'`);
  });

  test("every dataset starts on legacy-warning-compat-v1 at run scope, so nothing changes on deploy", () => {
    for (const row of policyRows(database())) {
      expect(row.policy_id).toBe(LEGACY_SNAPSHOT_POLICY);
      expect(row.policy_version).toBe(1);
      expect(row.unit_scope).toBe("run");
      expect(row.replaces_previous_on_complete_empty).toBe(1);
      expect(row.required_parser_version).toBe(
        row.parser_name === "sbi-foreign-cash-positions" ? FOREIGN_POSITION_SNAPSHOT_VERSION : null,
      );
      // The declared owner source is the one the parser accepts.
      const parser = PARSERS.find((candidate) => candidate.name === row.parser_name)!;
      expect(
        parser.accepts({
          id: 1,
          sourceId: row.source_id,
          runStatus: "success",
          runFailureCount: 0,
          dataset: row.dataset,
          url: null,
          mime: "application/json",
          fetchedAt: "2026-09-07T00:00:00.000Z",
          sha256: "0".repeat(64),
          artifactKey: "balance.normalized.json",
        }),
        row.parser_name,
      ).toBe(true);
    }
  });

  test("the SQL scope key equals the claim scope key written by parsers", () => {
    const store = database();
    const base = { parser: "sbi-vc-cash-balances", dataset: "cash-balances" };
    snapshot(store, { ...base, observations: [] });
    snapshot(store, { ...base, unit: "card-a", observations: [] });
    const artifacts = listArtifacts(store);
    const keys = store.db
      .query(
        `SELECT ${containerScopeKeySql("fa")} AS scope_key FROM fetch_artifacts fa ORDER BY fa.id`,
      )
      .all() as { scope_key: string }[];
    expect(keys.map((row) => row.scope_key)).toEqual(artifacts.map(containerScopeKey));
    expect(keys[1]?.scope_key).toBe("synthetic-source/cash-balances/unit=card-a");
  });
});

function compare(store: Store): SnapshotPolicyComparisonRow[] {
  return store.db
    .query(snapshotPolicyComparisonSql(LOCAL_SNAPSHOT_RELATIONS))
    .all() as SnapshotPolicyComparisonRow[];
}
const differing = (rows: SnapshotPolicyComparisonRow[]) =>
  rows.filter((row) => row.legacy_artifact_id !== row.coverage_artifact_id);

describe("shadow comparison of legacy-warning-compat-v1 and coverage-v1", () => {
  test("agrees on every synthetic dataset when converted parsers claim what the adapter inferred", () => {
    const store = database();
    for (const [parser, dataset] of SNAPSHOT_DATASETS) {
      snapshot(store, { parser, dataset, observations: facts(parser, "OLD"), coverage: {} });
      snapshot(store, { parser, dataset, observations: facts(parser, "NEW"), coverage: {} });
      snapshot(store, { parser, dataset, unit: "u", observations: [], coverage: {} });
    }
    // Harmless warnings on the tolerant parsers: both policies keep the parse.
    const foreign = { parser: sbiForeignCashBalances.name, dataset: "foreign-cash-balances" };
    // The claim's scope key comes from the artifact the parser is given.
    const meta = listArtifacts(store).find(
      (artifact) => artifact.dataset === foreign.dataset && artifact.fetchUnitKey === null,
    )!;
    const parsed = sbiForeignCashBalances.parse(
      new TextEncoder().encode(
        JSON.stringify({
          listForeignScheduleCashBalances: {
            foreignCashBalances: [
              {
                currencyCashBalances: [
                  {
                    currencyCode: "USD",
                    foreignScheduleCashBalances: [{ keepCash: "1.001", totalBalance: "2" }],
                  },
                ],
              },
            ],
          },
        }),
      ),
      meta,
    );
    snapshot(store, {
      ...foreign,
      time: "2026-09-03T00:00:00.000Z",
      observations: parsed.observations,
      warnings: parsed.warnings,
      issues: parsed.issues!,
      coverage: parsed.coverage![0]!,
    });
    const rows = compare(store);
    expect(rows.length).toBe(SNAPSHOT_DATASETS.length * 2);
    expect(differing(rows)).toEqual([]);
    expect(rows.every((row) => row.legacy_artifact_id !== null)).toBe(true);
  });

  test("lists exactly the intended corrections where the policies disagree", () => {
    const store = database();
    const foreign = { parser: sbiForeignCashBalances.name, dataset: "foreign-cash-balances" };
    // Both agree on the baseline.
    const baseline = snapshot(store, { ...foreign, observations: [balance("OLD")], coverage: {} });
    // Correction 1: a reworded (translated) warning on a complete container.
    // The adapter cannot read the text and falls back to the older snapshot;
    // coverage-v1 adopts the newer complete snapshot.
    const reworded = snapshot(store, {
      ...foreign,
      time: "2026-09-02T00:00:00.000Z",
      observations: [balance("NEW")],
      warnings: ["json:$.x: 未対応フィールドは extra に保持"],
      coverage: {},
    });
    // Correction 2: allow-listed warning text on a parse whose claim says the
    // container is partial. The adapter adopts it; coverage-v1 refuses.
    const positions = { parser: "sbi-foreign-cash-positions", dataset: "foreign-cash-positions" };
    const complete = snapshot(store, {
      ...positions,
      observations: [balance("COMPLETE")],
      coverage: {},
    });
    const partial = snapshot(store, {
      ...positions,
      time: "2026-09-02T00:00:00.000Z",
      observations: [],
      warnings: ["json:$.x: evaluation_amount 1.5 has no exact JPY minor-unit form; kept as text"],
      coverage: {
        completeness: "partial",
        membershipComplete: false,
        failureCause: "container_unreadable",
        absenceMeaning: "not-observed",
      },
    });
    expect(differing(compare(store))).toEqual([
      {
        source_id: "synthetic-source",
        parser_name: foreign.parser,
        dataset: foreign.dataset,
        fetch_unit_key: null,
        legacy_artifact_id: baseline.artifactId,
        coverage_artifact_id: reworded.artifactId,
      },
      {
        source_id: "synthetic-source",
        parser_name: positions.parser,
        dataset: positions.dataset,
        fetch_unit_key: null,
        legacy_artifact_id: partial.artifactId,
        coverage_artifact_id: complete.artifactId,
      },
    ]);
    // The comparison is independent of which policy the table activates.
    store.db.query("UPDATE dataset_snapshot_policies SET policy_id = 'coverage-v1'").run();
    expect(differing(compare(store))).toHaveLength(2);
  });
});

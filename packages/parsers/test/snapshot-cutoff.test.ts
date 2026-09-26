// `SnapshotCteOptions.cutoffParam` (docs/reported-state.md): without it the
// snapshot CTE text is byte for byte what every current reader composed before
// the option existed, and with it the only change is the two cutoff clauses.
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  CURRENT_SNAPSHOT,
  LOCAL_SNAPSHOT_RELATIONS,
  SNAPSHOT_CTES,
  snapshotCtes,
  snapshotPolicyComparisonSql,
  type SnapshotRelations,
} from "../src/snapshot-query.ts";

const PRODUCTION: SnapshotRelations = {
  fetchArtifacts: "observation_fetch_artifacts",
  fetchRuns: "observation_fetch_runs",
  parseRuns: "parse_runs",
  publishedParseRuns: "published_parse_runs",
};
const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("snapshot CTEs with and without a capture-time cutoff", () => {
  // Digests of the text shipped before `cutoffParam` existed (origin/main
  // bd3f1a5), so any drift in the unbounded text fails here.
  test("without cutoffParam every composed text is unchanged", () => {
    expect(digest(snapshotCtes(LOCAL_SNAPSHOT_RELATIONS))).toBe(
      "18e17607a7f760538a2f73b297636d97580ae221f37a10638dc955ffa35a9cc0",
    );
    expect(digest(snapshotCtes(PRODUCTION))).toBe(
      "18e93a606aabcde75a80ba46eba3a41a8dd4a5a517589da0972467b31621badb",
    );
    expect(digest(snapshotCtes(PRODUCTION, { policy: "coverage-v1", prefix: "coverage_" }))).toBe(
      "6fd7718cd00877c0b9fa3841cba8533d2eb98debaadfcf13189465742a1508f0",
    );
    expect(digest(snapshotPolicyComparisonSql(PRODUCTION))).toBe(
      "94ea92683698e6c4ff1fbbfc6d55c43fb115bcb863db89d9617acded411cc5a8",
    );
    expect(digest(SNAPSHOT_CTES + CURRENT_SNAPSHOT)).toBe(
      "dbcec3a9c34da3ec677214021ca172911ac08f98d76a9de1ee8db2d8791154d4",
    );
    expect(snapshotCtes(PRODUCTION, {})).toBe(snapshotCtes(PRODUCTION));
  });

  test("with cutoffParam only the two cutoff clauses are added", () => {
    const bounded = snapshotCtes(PRODUCTION, { prefix: "dated_", cutoffParam: "?1" });
    const snapshotClause = "\n     AND MAX(fa.fetched_at) < ?1";
    const containerClause = "\n    AND fa.fetched_at < ?1";
    expect(bounded.split(snapshotClause)).toHaveLength(2);
    expect(bounded.split(containerClause)).toHaveLength(2);
    expect(bounded.replace(snapshotClause, "").replace(containerClause, "")).toBe(
      snapshotCtes(PRODUCTION, { prefix: "dated_" }),
    );
  });

  test("the cutoff is a parameter reference, never a value", () => {
    for (const cutoffParam of ["'2026-09-26'", "?0", "?1; DROP", ":cutoff", "?1234", ""])
      expect(() => snapshotCtes(PRODUCTION, { cutoffParam })).toThrow("invalid_cutoff_param");
  });
});

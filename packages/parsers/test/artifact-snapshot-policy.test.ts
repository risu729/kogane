import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ARTIFACT_SNAPSHOT_CONTAINERS, containerScopeKeySql } from "../src/snapshot-query.ts";
import { containerScopeKey } from "../src/parsers/coverage.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import type { ArtifactMeta } from "../src/types.ts";
import { mizuhoAccountHtml } from "./mizuho-fixture.ts";

const fixtures: Readonly<Record<string, () => string>> = {
  "mizuho-account-list": mizuhoAccountHtml,
};

test("artifact-container policies match one registered parser and complete coverage for null and named datasets", () => {
  expect(Object.keys(fixtures).sort()).toEqual(
    ARTIFACT_SNAPSHOT_CONTAINERS.map((entry) => entry.parserName).sort(),
  );
  for (const entry of ARTIFACT_SNAPSHOT_CONTAINERS) {
    for (const dataset of [null, entry.dataset]) {
      const artifact: ArtifactMeta = {
        id: 1,
        sourceId: entry.sourceId,
        artifactKey: entry.artifactKey,
        fetchUnitKey: entry.fetchUnitKey,
        dataset,
        mime: "text/html",
        url: null,
        fetchedAt: "2026-09-13T00:00:00.000Z",
        sha256: "0".repeat(64),
        runStatus: "success",
        runFailureCount: 0,
      };
      const matches = PARSERS.filter((parser) => parser.accepts(artifact));
      expect(matches.map((parser) => parser.name)).toEqual([entry.parserName]);
      const result = matches[0]!.parse(
        new TextEncoder().encode(fixtures[entry.parserName]!()),
        artifact,
      );
      expect(result.coverage).toEqual([
        expect.objectContaining({
          scopeKey: containerScopeKey(artifact),
          mode: "complete-container",
          membershipComplete: true,
          completeness: "complete",
          failureCause: null,
        }),
      ]);
    }
  }
});

test("SQL and parser scope keys agree when terminal-v1 omits the dataset", () => {
  const db = new Database(":memory:");
  try {
    for (const dataset of [null, "mizuho-account-list-html"]) {
      const artifact = {
        sourceId: "mizuho-bank",
        dataset,
        fetchUnitKey: "account-list",
      } as ArtifactMeta;
      const row = db
        .query(`SELECT ${containerScopeKeySql("fa")} AS scope_key FROM
        (SELECT ? AS source_id, ? AS dataset, ? AS fetch_unit_key) fa`)
        .get(artifact.sourceId, dataset, artifact.fetchUnitKey!) as { scope_key: string };
      expect(row.scope_key).toBe(containerScopeKey(artifact));
    }
  } finally {
    db.close();
  }
});

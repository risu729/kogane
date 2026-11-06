import { beforeAll, expect, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { QualityStore } from "../../read-model/test/collection-quality-fixture.ts";
import { fullCoreSchema } from "../../read-model/test/card-usage-scale-fixture.ts";
import type { SqlExecutor } from "../../read-model/src/reader.ts";
import { queryCollectionQualityCells } from "../src/query/collection-quality.ts";
import { validCollectionQualityCells } from "../../observation-shared/src/collection-quality-contract.ts";
beforeAll(() => fullCoreSchema().close(), 60000);
function executor(store: QualityStore): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      store.db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(sql: string, args: readonly unknown[]) =>
      (store.db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}
test("new declared units with no artifacts remain visible, never current or empty success", async () => {
  const store = new QualityStore();
  try {
    const run = store.run({
      source: "vpass",
      at: "2099-01-01T00:00:00Z",
      outcome: "partial",
      artifacts: [],
      units: {
        "synthetic-card-auth": { outcome: "human_required", code: "human_required_reauth" },
        "synthetic-card-empty": { outcome: "success" },
        "synthetic-card-unknown": { outcome: "unknown" },
      },
    });
    const page = await queryCollectionQualityCells(executor(store), {
      sourceId: "vpass",
      offset: 0,
    });
    expect(validCollectionQualityCells(page)).toBe(true);
    expect(page!.cells).toHaveLength(3);
    for (const cell of page!.cells) {
      expect(cell).toMatchObject({
        dataset: null,
        parser: null,
        state: "no-current",
        current: null,
        newest: { fetchRunId: run.run, artifacts: 0, observations: 0, rawStored: 0 },
      });
      expect(cell.reasons).toContain("unit_without_artifacts");
      expect(cell.reasons).toContain("no_current_capture");
      expect(cell.reasons).not.toContain("published_without_observations");
    }
    expect(page!.cells.find((cell) => cell.unitKey === "synthetic-card-auth")!.reasons).toContain(
      "user_action_required",
    );
    expect(
      page!.cells.find((cell) => cell.unitKey === "synthetic-card-unknown")!.reasons,
    ).toContain("unit_outcome_unknown");
  } finally {
    store.db.close();
  }
});
test("an artifact preserves its unknown declared unit outcome without inventing one for unscoped artifacts", async () => {
  const store = new QualityStore();
  try {
    store.run({
      source: "vpass",
      at: "2099-01-01T00:00:00Z",
      units: {
        "synthetic-unknown": { outcome: "unknown" },
        "synthetic-known": { outcome: "success" },
      },
      artifacts: [
        {
          key: "months/209901/top-unknown.json",
          dataset: "statement-page",
          unit: "synthetic-unknown",
        },
        { key: "months/209901/top-known.json", dataset: "statement-page", unit: "synthetic-known" },
        { key: "months/209901/top-unscoped.json", dataset: "statement-page" },
      ],
    });
    const page = await queryCollectionQualityCells(executor(store), {
      sourceId: "vpass",
      offset: 0,
    });
    expect(validCollectionQualityCells(page)).toBe(true);
    expect(page!.cells).toHaveLength(3);
    const unknown = page!.cells.find((cell) => cell.unitKey === "synthetic-unknown")!;
    expect(unknown.newest.artifacts).toBe(1);
    expect(unknown.reasons).toContain("unit_outcome_unknown");
    expect(unknown.reasons).toContain("unit_failed");
    expect(unknown.reasons).toContain("not_parse_eligible");
    expect(unknown.reasons).not.toContain("unit_without_artifacts");
    for (const key of ["synthetic-known", null]) {
      const cell = page!.cells.find((value) => value.unitKey === key)!;
      expect(cell.newest.artifacts).toBe(1);
      expect(cell.reasons).not.toContain("unit_outcome_unknown");
    }
  } finally {
    store.db.close();
  }
});
test("an older parsed unit and a later failed empty attempt are both explained; recovery removes the unit-only row", async () => {
  const store = new QualityStore();
  try {
    const first = store.run({
      source: "vpass",
      at: "2099-01-01T00:00:00Z",
      units: { "synthetic-card": { outcome: "success" } },
      artifacts: [
        { key: "months/209901/top-001.json", dataset: "statement-page", unit: "synthetic-card" },
      ],
    });
    store.parse(first.artifacts[0]!, "vpass-statement-page", { kind: "published" });
    store.run({
      source: "vpass",
      at: "2099-01-02T00:00:00Z",
      units: { "synthetic-card": { outcome: "failed", code: "page_missing" } },
      artifacts: [],
    });
    const before = await queryCollectionQualityCells(executor(store), {
      sourceId: "vpass",
      offset: 0,
    });
    expect(before!.cells).toHaveLength(2);
    expect(before!.cells.find((cell) => cell.parser !== null)!.reasons).toContain(
      "not_in_latest_run",
    );
    expect(before!.cells.find((cell) => cell.parser === null)!.newest.unitFailureCode).toBe(
      "page_missing",
    );
    const recovered = store.run({
      source: "vpass",
      at: "2099-01-03T00:00:00Z",
      units: { "synthetic-card": { outcome: "success" } },
      artifacts: [
        { key: "months/209901/top-001.json", dataset: "statement-page", unit: "synthetic-card" },
      ],
    });
    store.parse(recovered.artifacts[0]!, "vpass-statement-page", { kind: "published" });
    const after = await queryCollectionQualityCells(executor(store), {
      sourceId: "vpass",
      offset: 0,
    });
    expect(after!.cells).toHaveLength(1);
    expect(after!.cells[0]!.newest.fetchRunId).toBe(recovered.run);
    expect(after!.cells[0]!.reasons).not.toContain("unit_without_artifacts");
    expect(validCollectionQualityCells(after)).toBe(true);
  } finally {
    store.db.close();
  }
});
test("empty publication, absent identity, unresolved identity and a corrected mapping stay distinct", async () => {
  const store = new QualityStore();
  try {
    const run = store.run({
      source: "sony-bank",
      at: "2099-01-01T00:00:00Z",
      artifacts: [{ key: "yen-history-page-0001.json", dataset: "yen-history-page-0001" }],
    });
    const parse = store.parse(run.artifacts[0]!, "sony-bank-history-json", { kind: "published" })!;
    const read = async () =>
      (await queryCollectionQualityCells(executor(store), { sourceId: "sony-bank", offset: 0 }))!
        .cells[0]!;
    const empty = await read();
    expect(empty.newest.observations).toBe(0);
    expect(empty.reasons).toContain("published_without_observations");
    store.db.run(
      "INSERT INTO transaction_observations(id,parse_run_id,source_account,raw_locator,extra_json) VALUES(?,?,?,'$[0]','{}')",
      [90001, parse, "synthetic-account"],
    );
    expect((await read()).reasons).toContain("identity_not_recorded");
    store.db.run(
      "INSERT INTO source_accounts VALUES('synthetic-ref','sony-bank','collector-r2-importer','[\"synthetic-account\"]')",
    );
    store.db.run(
      "INSERT INTO accounts VALUES('synthetic-account','Synthetic account','deposit','unresolved')",
    );
    store.db.run(
      "INSERT INTO account_mappings VALUES('synthetic-map-1','synthetic-ref',1,'synthetic-account','rule','synthetic_unresolved',1,'2099-01-01','Synthetic account','unresolved')",
    );
    for (const policy of [1, 2]) {
      const id = `synthetic-identity-${policy}`;
      store.db.run("INSERT INTO identity_runs VALUES(?,?,?,'2099-01-01')", [id, parse, policy]);
      store.db.run(
        "INSERT INTO identity_observations VALUES(?,?,'transaction',90001,'synthetic-ref','synthetic-map-1','[]')",
        [`synthetic-observation-${policy}`, id],
      );
      store.db.run("INSERT INTO identity_run_seals VALUES(?,1,'2099-01-01')", [id]);
    }
    const unresolved = await read();
    // Two sealed policies do not double-count one observation.
    expect(unresolved.newest.observations).toBe(1);
    expect(unresolved.newest.unresolvedIdentities).toBe(1);
    expect(unresolved.reasons).toContain("identity_unresolved");
    expect(unresolved.reasons).not.toContain("identity_not_recorded");
    expect(unresolved.reasons).not.toContain("published_without_observations");
    store.db.run(
      "INSERT INTO account_mappings VALUES('synthetic-map-2','synthetic-ref',2,'synthetic-account','manual','synthetic_review',2,'2099-01-02','Synthetic account','identified')",
    );
    const corrected = await read();
    expect(corrected.newest.unresolvedIdentities).toBe(0);
    expect(corrected.reasons).not.toContain("identity_unresolved");
    expect(corrected.reasons).toContain("retention_not_assessed");
    expect(store.all<{ n: number }>("SELECT count(*) AS n FROM identity_observations")[0]!.n).toBe(
      2,
    );
  } finally {
    store.db.close();
  }
});

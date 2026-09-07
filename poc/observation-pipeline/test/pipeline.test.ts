import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestFile, ingestRunDirectory } from "../src/ingest.ts";
import { runParsers } from "../src/parse.ts";
import {
  currentPositions,
  currentTransactions,
  currentValuations,
  latestBalances,
} from "../src/queries.ts";
import {
  insertFetchArtifact,
  insertFetchRun,
  insertObservation,
  insertParseRun,
  listArtifacts,
  openStore,
  putRawObject,
  upsertSource,
  type Store,
} from "../src/store.ts";
import type { Parser } from "../src/types.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const SBI_RUN = join(FIXTURES, "sbi-securities", "2026-08-20", "run-20260820-210000-poc01");
const SBI_VC_RUN = join(FIXTURES, "sbi-vc-trade", "2026-09-07", "run-20260907-synthetic01");

function tempStore(): Store {
  return openStore(mkdtempSync(join(tmpdir(), "kogane-poc-")));
}

function count(store: Store, table: string): number {
  return (store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("ingestion", () => {
  test("collector manifests must declare an exact terminal status", () => {
    for (const status of [undefined, "human-required", "SUCCESS"]) {
      const store = tempStore();
      const directory = mkdtempSync(join(tmpdir(), "kogane-run-status-"));
      writeFileSync(join(directory, "artifact.json"), "{}");
      const manifest: Record<string, unknown> = {
        runId: `bad-status-${String(status)}`,
        startedAt: "2026-08-20T00:00:00Z",
        artifacts: [{ dataset: "artifact" }],
      };
      if (status !== undefined) manifest.status = status;
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
      expect(() => ingestRunDirectory(store, directory, { id: "x", provider: "X" })).toThrow(
        /explicit run status|unknown run status/u,
      );
      expect(count(store, "fetch_runs")).toBe(0);
      expect(count(store, "fetch_artifacts")).toBe(0);
    }
  });

  test("migrates v2 fetch runs without making legacy partial output current", () => {
    const directory = mkdtempSync(join(tmpdir(), "kogane-v2-store-"));
    const db = new Database(join(directory, "kogane-poc.sqlite"), {
      create: true,
    });
    db.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, ingestion TEXT NOT NULL
      ) STRICT;
      CREATE TABLE fetch_runs (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id),
        external_run_id TEXT,
        tool TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        UNIQUE (source_id, external_run_id)
      ) STRICT;
      INSERT INTO sources VALUES ('legacy', 'Legacy', 'collector-r2');
      INSERT INTO fetch_runs
        (source_id, external_run_id, tool, started_at, status)
      VALUES ('legacy', 'partial-1', 'import-run', '2026-09-01T00:00:00Z', 'partial');
      PRAGMA user_version = 2;
    `);
    db.close();
    const store = openStore(directory);
    const row = store.db
      .query("SELECT status, failure_count, window_start, window_end FROM fetch_runs")
      .get() as {
      status: string;
      failure_count: number;
      window_start: string | null;
      window_end: string | null;
    };
    expect(row).toEqual({
      status: "partial",
      failure_count: 1,
      window_start: null,
      window_end: null,
    });
    expect(
      (store.db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(5);
  });

  test("migrates v3 artifact rows with nullable collector identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "kogane-v3-store-"));
    const db = new Database(join(directory, "kogane-poc.sqlite"), { create: true });
    db.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, ingestion TEXT NOT NULL
      ) STRICT;
      CREATE TABLE fetch_runs (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id),
        external_run_id TEXT,
        tool TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        UNIQUE (source_id, external_run_id)
      ) STRICT;
      CREATE TABLE raw_objects (
        sha256 TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        blob_key TEXT NOT NULL
      ) STRICT;
      CREATE TABLE fetch_artifacts (
        id INTEGER PRIMARY KEY,
        fetch_run_id INTEGER NOT NULL REFERENCES fetch_runs(id),
        source_id TEXT NOT NULL REFERENCES sources(id),
        dataset TEXT,
        url TEXT,
        method TEXT,
        http_status INTEGER,
        mime TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        sha256 TEXT NOT NULL REFERENCES raw_objects(sha256)
      ) STRICT;
      INSERT INTO sources VALUES ('legacy', 'Legacy', 'collector-r2');
      INSERT INTO fetch_runs
        (id, source_id, external_run_id, tool, started_at, status, failure_count)
      VALUES (1, 'legacy', 'success-1', 'import-run', '2026-09-01T00:00:00Z', 'success', 0);
      INSERT INTO raw_objects VALUES ('${"0".repeat(64)}', 0, 'application/json', '00/zero');
      INSERT INTO fetch_artifacts
        (fetch_run_id, source_id, dataset, mime, fetched_at, sha256)
      VALUES (1, 'legacy', 'legacy-data', 'application/json', '2026-09-01T00:00:00Z', '${"0".repeat(64)}');
      PRAGMA user_version = 3;
    `);
    db.close();
    const store = openStore(directory);
    const row = store.db
      .query("SELECT artifact_key, statement_state, period FROM fetch_artifacts")
      .get() as { artifact_key: null; statement_state: null; period: null };
    expect(row).toEqual({ artifact_key: null, statement_state: null, period: null });
    expect(
      (store.db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(5);
  });

  test("migrates v4 collector identity without losing it when adding run windows", () => {
    const directory = mkdtempSync(join(tmpdir(), "kogane-v4-store-"));
    const db = new Database(join(directory, "kogane-poc.sqlite"), { create: true });
    db.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, ingestion TEXT NOT NULL
      ) STRICT;
      CREATE TABLE fetch_runs (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id),
        external_run_id TEXT,
        tool TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL,
        failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
        UNIQUE (source_id, external_run_id)
      ) STRICT;
      CREATE TABLE raw_objects (
        sha256 TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        blob_key TEXT NOT NULL
      ) STRICT;
      CREATE TABLE fetch_artifacts (
        id INTEGER PRIMARY KEY,
        fetch_run_id INTEGER NOT NULL REFERENCES fetch_runs(id),
        source_id TEXT NOT NULL REFERENCES sources(id),
        dataset TEXT,
        artifact_key TEXT,
        statement_state TEXT,
        period TEXT,
        url TEXT,
        method TEXT,
        http_status INTEGER,
        mime TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        sha256 TEXT NOT NULL REFERENCES raw_objects(sha256)
      ) STRICT;
      INSERT INTO sources VALUES ('legacy', 'Legacy', 'collector-r2');
      INSERT INTO fetch_runs
        (id, source_id, external_run_id, tool, started_at, status, failure_count)
      VALUES (1, 'legacy', 'success-1', 'import-run', '2026-09-01T00:00:00Z', 'success', 0);
      INSERT INTO raw_objects VALUES ('${"0".repeat(64)}', 0, 'application/json', '00/zero');
      INSERT INTO fetch_artifacts
        (fetch_run_id, source_id, dataset, artifact_key, statement_state, period, mime, fetched_at, sha256)
      VALUES (1, 'legacy', 'credit-ledger', 'connection/ledger.json', 'confirmed', '2026-09',
              'application/json', '2026-09-01T00:00:00Z', '${"0".repeat(64)}');
      PRAGMA user_version = 4;
    `);
    db.close();
    const store = openStore(directory);
    expect(store.db.query("SELECT window_start, window_end FROM fetch_runs").get()).toEqual({
      window_start: null,
      window_end: null,
    });
    expect(
      store.db.query("SELECT artifact_key, statement_state, period FROM fetch_artifacts").get(),
    ).toEqual({
      artifact_key: "connection/ledger.json",
      statement_state: "confirmed",
      period: "2026-09",
    });
    expect(
      (store.db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(5);
  });

  test("run-directory ingestion is idempotent", () => {
    const store = tempStore();
    const source = { id: "sbi-securities", provider: "SBI Securities" };
    const first = ingestRunDirectory(store, SBI_RUN, source);
    expect(first.skippedExisting).toBe(false);
    expect(first.artifacts).toBe(4);
    const second = ingestRunDirectory(store, SBI_RUN, source);
    expect(second.skippedExisting).toBe(true);
    expect(count(store, "fetch_runs")).toBe(1);
    expect(count(store, "fetch_artifacts")).toBe(4);
    expect(count(store, "raw_objects")).toBe(4);
  });

  test("persists an exact collector query window and rejects invalid calendar bounds", () => {
    const directory = mkdtempSync(join(tmpdir(), "kogane-run-window-"));
    writeFileSync(join(directory, "artifact.json"), "{}");
    const manifest = {
      runId: "window-test",
      startedAt: "2026-09-30T00:00:00Z",
      status: "success",
      window: { from: "2026-09-01", to: "2026-09-30" },
      artifacts: [{ dataset: "artifact" }],
      failures: [],
    };
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
    const store = tempStore();
    ingestRunDirectory(store, directory, { id: "window-source", provider: "Window Source" });
    expect(store.db.query("SELECT window_start, window_end FROM fetch_runs").get()).toEqual({
      window_start: "2026-09-01",
      window_end: "2026-09-30",
    });
    store.db.exec("UPDATE fetch_runs SET window_end = NULL;");
    expect(() => listArtifacts(store)).toThrow("window is incomplete");

    const invalidDirectory = mkdtempSync(join(tmpdir(), "kogane-run-window-invalid-"));
    writeFileSync(join(invalidDirectory, "artifact.json"), "{}");
    writeFileSync(
      join(invalidDirectory, "manifest.json"),
      JSON.stringify({
        ...manifest,
        runId: "invalid-window",
        window: { from: "2026-02-30", to: "2026-03-01" },
      }),
    );
    expect(() =>
      ingestRunDirectory(store, invalidDirectory, {
        id: "window-source",
        provider: "Window Source",
      }),
    ).toThrow("window is invalid");
  });

  test("SBI VC collector run ingestion verifies all six source-separated artifacts", () => {
    const store = tempStore();
    const source = { id: "sbi-vc-trade", provider: "SBI VC Trade" };
    const first = ingestRunDirectory(store, SBI_VC_RUN, source);
    expect(first).toMatchObject({
      artifacts: 6,
      deduplicated: 0,
      skippedExisting: false,
    });
    expect(ingestRunDirectory(store, SBI_VC_RUN, source).skippedExisting).toBe(true);
    expect(count(store, "fetch_artifacts")).toBe(6);
  });

  test("identical bytes under different names store one blob", () => {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-exports-"));
    writeFileSync(join(directory, "a.csv"), "same,bytes\n1,2\n");
    writeFileSync(join(directory, "b.csv"), "same,bytes\n1,2\n");
    const options = {
      source: { id: "paypay", provider: "PayPay" },
      mime: "text/csv",
      fetchedAt: "2026-08-21T09:00:00Z",
    };
    ingestFile(store, join(directory, "a.csv"), options);
    const second = ingestFile(store, join(directory, "b.csv"), options);
    expect(second.deduplicated).toBe(1);
    expect(count(store, "fetch_artifacts")).toBe(2); // both fetches are history
    expect(count(store, "raw_objects")).toBe(1); // one content-addressed blob
    // re-ingesting the same file is a no-op
    expect(ingestFile(store, join(directory, "a.csv"), options).skippedExisting).toBe(true);
  });

  test("a rejected run leaves nothing behind and can be re-ingested", () => {
    const store = tempStore();
    const source = { id: "x", provider: "X" };
    const directory = mkdtempSync(join(tmpdir(), "kogane-bad-run-"));
    writeFileSync(join(directory, "some-dataset.json"), "{}");
    const manifest = (sha256: string): string =>
      JSON.stringify({
        runId: "bad-run",
        startedAt: "2026-08-20T00:00:00Z",
        status: "success",
        failures: [],
        artifacts: [{ dataset: "some-dataset", sha256, bytes: 2 }],
      });
    writeFileSync(join(directory, "manifest.json"), manifest("f".repeat(64)));
    expect(() => ingestRunDirectory(store, directory, source)).toThrow(/does not match manifest/u);
    // The failure must not leave a run row, or every later attempt at this run
    // would be a silent no-op.
    expect(count(store, "fetch_runs")).toBe(0);
    expect(count(store, "fetch_artifacts")).toBe(0);

    const realHash = createHash("sha256").update("{}").digest("hex");
    writeFileSync(join(directory, "manifest.json"), manifest(realHash));
    const recovered = ingestRunDirectory(store, directory, source);
    expect(recovered.skippedExisting).toBe(false);
    expect(recovered.artifacts).toBe(1);
  });

  test("a run whose file is missing leaves nothing behind", () => {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-missing-"));
    writeFileSync(join(directory, "present.json"), "{}");
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        runId: "partial-run",
        startedAt: "2026-08-20T00:00:00Z",
        status: "success",
        failures: [],
        artifacts: [{ dataset: "present" }, { dataset: "absent" }],
      }),
    );
    expect(() => ingestRunDirectory(store, directory, { id: "x", provider: "X" })).toThrow();
    expect(count(store, "fetch_runs")).toBe(0);
    expect(count(store, "fetch_artifacts")).toBe(0);
  });

  test("a manifest listing a dataset twice is rejected", () => {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-dupe-"));
    writeFileSync(join(directory, "ds.json"), "{}");
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        runId: "dupe-run",
        startedAt: "2026-08-20T00:00:00Z",
        status: "success",
        failures: [],
        artifacts: [{ dataset: "ds" }, { dataset: "ds" }],
      }),
    );
    expect(() => ingestRunDirectory(store, directory, { id: "x", provider: "X" })).toThrow(
      /more than once/u,
    );
    expect(count(store, "fetch_runs")).toBe(0);
  });

  test("collector manifests must explicitly declare status and failure evidence", () => {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-manifest-outcome-"));
    writeFileSync(join(directory, "ds.json"), "{}");
    const base = {
      runId: "missing-outcome",
      startedAt: "2026-09-07T00:00:00Z",
      artifacts: [{ dataset: "ds" }],
    };
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({ ...base, failures: [] }));
    expect(() => ingestRunDirectory(store, directory, { id: "x", provider: "X" })).toThrow(
      /unknown run status/u,
    );
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({ ...base, status: "success" }));
    expect(() => ingestRunDirectory(store, directory, { id: "x", provider: "X" })).toThrow(
      /failures must be an array/u,
    );
    expect(count(store, "fetch_runs")).toBe(0);
    expect(count(store, "fetch_artifacts")).toBe(0);

    const valid = { ...base, runId: "existing-outcome", status: "success", failures: [] };
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(valid));
    expect(ingestRunDirectory(store, directory, { id: "x", provider: "X" }).artifacts).toBe(1);
    const { status: _status, ...missingStatus } = valid;
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(missingStatus));
    expect(() => ingestRunDirectory(store, directory, { id: "x", provider: "X" })).toThrow(
      /unknown run status/u,
    );
  });

  test("re-fetching an unchanged export records a second confirmation", () => {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-confirm-"));
    const path = join(directory, "export.csv");
    writeFileSync(path, "same,bytes\n1,2\n");
    const source = { id: "paypay", provider: "PayPay" };
    ingestFile(store, path, {
      source,
      mime: "text/csv",
      fetchedAt: "2026-01-01T00:00:00Z",
    });
    const second = ingestFile(store, path, {
      source,
      mime: "text/csv",
      fetchedAt: "2026-06-01T00:00:00Z",
    });
    // "we confirmed the same state again" is preserved as its own fetch,
    // without duplicating the blob (docs/design.md).
    expect(second.skippedExisting).toBe(false);
    expect(second.deduplicated).toBe(1);
    expect(count(store, "fetch_artifacts")).toBe(2);
    expect(count(store, "raw_objects")).toBe(1);
  });
});

function fakeParser(version: string, marker: string): Parser {
  return {
    name: "fake-parser",
    version,
    accepts: (artifact) => artifact.sourceId === "fake",
    parse: (_bytes, _artifact) => ({
      observations: [
        {
          kind: "transaction",
          sourceAccount: "fake:account",
          description: marker,
          amountMinor: 1,
          currency: "JPY",
          rawLocator: "json:$",
          extra: {},
        },
      ],
      warnings: [],
    }),
  };
}

describe("parse runs", () => {
  function storeWithFakeArtifact(): Store {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-fake-"));
    writeFileSync(join(directory, "artifact.json"), '{"anything": true}');
    ingestFile(store, join(directory, "artifact.json"), {
      source: { id: "fake", provider: "Fake" },
      mime: "application/json",
      fetchedAt: "2026-08-21T00:00:00Z",
    });
    return store;
  }

  test("same parser version is parsed once", () => {
    const store = storeWithFakeArtifact();
    const parser = fakeParser("0.1.0", "v1");
    expect(runParsers(store, [parser]).parsed).toBe(1);
    const again = runParsers(store, [parser]);
    expect(again.parsed).toBe(0);
    expect(again.skipped).toBe(1);
    expect(count(store, "transaction_observations")).toBe(1);
  });

  test("partial and failed fetch runs remain raw evidence and never become observations", () => {
    for (const status of ["partial", "failed"] as const) {
      const store = tempStore();
      upsertSource(store, { id: "fake", provider: "Fake", ingestion: "collector-r2" });
      const fetchRunId = insertFetchRun(store, {
        sourceId: "fake",
        externalRunId: `run-${status}`,
        tool: "import-run",
        startedAt: "2026-08-21T00:00:00Z",
        completedAt: "2026-08-21T00:01:00Z",
        status,
      });
      const raw = putRawObject(store, new TextEncoder().encode("{}"), "application/json");
      insertFetchArtifact(store, {
        fetchRunId,
        sourceId: "fake",
        dataset: "statement",
        mime: "application/json",
        fetchedAt: "2026-08-21T00:01:00Z",
        sha256: raw.sha256,
      });
      const summary = runParsers(store, [fakeParser("0.1.0", "must-not-run")]);
      expect(summary).toMatchObject({
        parsed: 0,
        blocked: 1,
        observations: 0,
        errors: 0,
      });
      expect(count(store, "parse_runs")).toBe(0);
      expect(count(store, "transaction_observations")).toBe(0);
      expect(count(store, "fetch_artifacts")).toBe(1);
    }
  });

  test("pagination-total-changed partial runs produce zero current observations", () => {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-partial-page-"));
    const dataset = "executions-historical-page-0002";
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        meta: { status: "OK", timestamp: "2026/09/07 09:00:06" },
        body: {
          list: [{ CExecutionId: "synthetic", CExecutionIdSubNo: "1" }],
          pageNumber: 1,
          pageSize: 30,
          totalNumOfPages: 2,
          totalSize: 32,
        },
      }),
    );
    writeFileSync(join(directory, `${dataset}.json`), bytes);
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        runId: "partial-pagination-total-changed",
        startedAt: "2026-09-07T00:00:00.000Z",
        completedAt: "2026-09-07T00:00:06.000Z",
        status: "partial",
        artifacts: [
          {
            dataset,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.byteLength,
          },
        ],
        failures: [
          {
            operation: "collect",
            errorCode: "executions_historical_pagination_total_changed",
          },
        ],
      }),
    );
    const ingested = ingestRunDirectory(store, directory, {
      id: "sbi-vc-trade",
      provider: "SBI VC Trade",
    });
    const summary = runParsers(store);
    expect(summary).toMatchObject({
      parsed: 0,
      errors: 0,
      blocked: 1,
      observations: 0,
    });
    expect(count(store, "parse_runs")).toBe(0);
    expect(currentTransactions(store)).toEqual([]);

    // Defense in depth for stores produced by the pre-policy parser: even an
    // old successful parse attached to a partial fetch run is not current.
    const artifactId = (store.db.query("SELECT id FROM fetch_artifacts").get() as { id: number })
      .id;
    const parseRunId = insertParseRun(store, {
      artifactId,
      parserName: "legacy-sbi-vc-executions",
      parserVersion: "0.1.0",
      parsedAt: "2026-09-07T00:01:00.000Z",
      status: "ok",
      warnings: [],
    });
    insertObservation(store, parseRunId, {
      kind: "transaction",
      sourceAccount: "sbi-vc-trade:main",
      externalId: "legacy-partial-observation",
      rawLocator: "json:$.body.list[0]",
      extra: {},
    });
    insertObservation(store, parseRunId, {
      kind: "balance",
      sourceAccount: "sbi-vc-trade:main",
      metric: "cash_balance",
      instrument: "JPY",
      amountMinor: 1,
      rawLocator: "json:$.body.balance",
      extra: {},
    });
    insertObservation(store, parseRunId, {
      kind: "position",
      sourceAccount: "sbi-vc-trade:main",
      securityCode: "BTCJPY",
      quantityText: "1",
      quantityScale: 0,
      currency: "JPY",
      rawLocator: "json:$.body.position",
      extra: {},
    });
    insertObservation(store, parseRunId, {
      kind: "valuation",
      sourceAccount: "sbi-vc-trade:main",
      subject: "BTCJPY",
      metric: "market_value",
      currency: "JPY",
      amountMinor: 1,
      rawLocator: "json:$.body.valuation",
      extra: {},
    });
    expect(ingested.artifacts).toBe(1);
    expect(currentTransactions(store)).toEqual([]);
    expect(latestBalances(store)).toEqual([]);
    expect(currentPositions(store)).toEqual([]);
    expect(currentValuations(store)).toEqual([]);
  });

  test("current executions collapse recent and historical overlap to historical", () => {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-sbi-vc-overlap-"));
    writeFileSync(join(directory, "recent.json"), "{}");
    writeFileSync(join(directory, "historical.json"), "{}");
    const source = { id: "sbi-vc-trade", provider: "SBI VC Trade" };
    ingestFile(store, join(directory, "recent.json"), {
      source,
      mime: "application/json",
      fetchedAt: "2026-09-07T00:00:00Z",
    });
    ingestFile(store, join(directory, "historical.json"), {
      source,
      mime: "application/json",
      fetchedAt: "2026-09-07T00:00:01Z",
    });
    const artifacts = store.db.query("SELECT id FROM fetch_artifacts ORDER BY id").all() as {
      id: number;
    }[];
    for (const [index, sourceView] of ["recent", "historical"].entries()) {
      const artifactRow = artifacts[index];
      if (artifactRow === undefined) throw new Error("missing test artifact");
      const parseRunId = insertParseRun(store, {
        artifactId: artifactRow.id,
        parserName: "sbi-vc-executions",
        parserVersion: "0.1.0",
        parsedAt: `2026-09-07T00:01:0${index}Z`,
        status: "ok",
        warnings: [],
      });
      insertObservation(store, parseRunId, {
        kind: "transaction",
        sourceAccount: "sbi-vc-trade:main",
        externalId: '["execution","1"]',
        description: sourceView,
        rawLocator: "json:$.body.list[0]",
        extra: { _kogane: { sourceView } },
      });
    }
    expect(currentTransactions(store).map((row) => row.description)).toEqual(["historical"]);
    expect(count(store, "transaction_observations")).toBe(2);
  });

  test("current SMBC Direct transactions use the latest fetched complete range snapshot", () => {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-smbc-direct-refetch-"));
    writeFileSync(join(directory, "newer.json"), "{}");
    writeFileSync(join(directory, "stale.json"), "{}");
    writeFileSync(join(directory, "empty.json"), "{}");
    const source = { id: "smbc-bank", provider: "SMBC Direct" };
    ingestFile(store, join(directory, "newer.json"), {
      source,
      mime: "application/json",
      fetchedAt: "2026-09-07T00:00:02Z",
    });
    ingestFile(store, join(directory, "stale.json"), {
      source,
      mime: "application/json",
      fetchedAt: "2026-09-07T00:00:01Z",
    });
    ingestFile(store, join(directory, "empty.json"), {
      source,
      mime: "application/json",
      fetchedAt: "2026-09-07T00:00:03Z",
    });
    store.db
      .query(
        `UPDATE fetch_artifacts
         SET dataset = 'transactions-normalized',
             artifact_key = 'transactions/20260801-20260831.normalized.json'`,
      )
      .run();
    const artifacts = store.db.query("SELECT id FROM fetch_artifacts ORDER BY id").all() as {
      id: number;
    }[];
    for (const [index, description] of ["newer", "stale"].entries()) {
      const artifactRow = artifacts[index];
      if (artifactRow === undefined) throw new Error("missing test artifact");
      const parseRunId = insertParseRun(store, {
        artifactId: artifactRow.id,
        parserName: "smbc-direct-transactions",
        parserVersion: "1.0.0",
        parsedAt: `2026-09-07T00:01:0${index}Z`,
        status: "ok",
        warnings: [],
      });
      insertObservation(store, parseRunId, {
        kind: "transaction",
        sourceAccount: "smbc-bank:ordinary-yen",
        externalId: "same-provider-id",
        description,
        rawLocator: "json:$.transactions[0]",
        extra: {},
      });
    }
    expect(currentTransactions(store).map((row) => row.description)).toEqual(["newer"]);
    expect(count(store, "transaction_observations")).toBe(2);
    const emptyArtifact = artifacts[2];
    if (emptyArtifact === undefined) throw new Error("missing empty test artifact");
    insertParseRun(store, {
      artifactId: emptyArtifact.id,
      parserName: "smbc-direct-transactions",
      parserVersion: "1.0.0",
      parsedAt: "2026-09-07T00:01:02Z",
      status: "ok",
      warnings: [],
    });
    expect(currentTransactions(store)).toEqual([]);
    expect(count(store, "transaction_observations")).toBe(2);
  });

  test("current GLOBAL PASS transactions use the latest fetched monthly snapshot", () => {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-global-pass-refetch-"));
    writeFileSync(join(directory, "older.html"), "<!doctype html>");
    writeFileSync(join(directory, "newer.html"), "<!doctype html>");
    writeFileSync(join(directory, "empty.html"), "<!doctype html>");
    const source = { id: "global-pass", provider: "GLOBAL PASS" };
    ingestFile(store, join(directory, "older.html"), {
      source,
      mime: "text/html",
      fetchedAt: "2026-09-07T00:00:01Z",
    });
    ingestFile(store, join(directory, "newer.html"), {
      source,
      mime: "text/html",
      fetchedAt: "2026-09-07T00:00:02Z",
    });
    ingestFile(store, join(directory, "empty.html"), {
      source,
      mime: "text/html",
      fetchedAt: "2026-09-07T00:00:03Z",
    });
    store.db
      .query(
        `UPDATE fetch_artifacts
         SET dataset = 'globalpass-activity',
             artifact_key = 'activity-2099-02.html'`,
      )
      .run();
    const artifacts = store.db.query("SELECT id FROM fetch_artifacts ORDER BY id").all() as {
      id: number;
    }[];
    for (const [index, description] of ["older", "newer"].entries()) {
      const artifactRow = artifacts[index];
      if (artifactRow === undefined) throw new Error("missing GLOBAL PASS test artifact");
      const parseRunId = insertParseRun(store, {
        artifactId: artifactRow.id,
        parserName: "global-pass-activity",
        parserVersion: "1.0.0",
        parsedAt: `2026-09-07T00:01:0${index}Z`,
        status: "ok",
        warnings: [],
      });
      insertObservation(store, parseRunId, {
        kind: "transaction",
        sourceAccount: "global-pass:card",
        externalId: "same-provider-evidence",
        description,
        rawLocator: "html:activity-record=1",
        extra: {},
      });
    }
    expect(currentTransactions(store).map((row) => row.description)).toEqual(["newer"]);
    expect(count(store, "transaction_observations")).toBe(2);
    const emptyArtifact = artifacts[2];
    if (emptyArtifact === undefined) throw new Error("missing empty GLOBAL PASS test artifact");
    insertParseRun(store, {
      artifactId: emptyArtifact.id,
      parserName: "global-pass-activity",
      parserVersion: "1.0.0",
      parsedAt: "2026-09-07T00:01:02Z",
      status: "ok",
      warnings: [],
    });
    expect(currentTransactions(store)).toEqual([]);
    expect(count(store, "transaction_observations")).toBe(2);
  });

  test("current SBI Shinsei transactions collapse refetches only within source and account", () => {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-sbi-shinsei-overlap-"));
    const cases = [
      ["sbi-shinsei-bank", "sbi-shinsei:primary", "older-refetch"],
      ["sbi-shinsei-bank", "sbi-shinsei:primary", "newer-refetch"],
      ["sbi-shinsei-bank", "sbi-shinsei:secondary", "other-account"],
      ["synthetic-other-bank", "sbi-shinsei:primary", "other-source"],
    ] as const;
    for (const [index, [sourceId, sourceAccount, description]] of cases.entries()) {
      const path = join(directory, `${index}.json`);
      writeFileSync(path, "{}");
      ingestFile(store, path, {
        source: { id: sourceId, provider: sourceId },
        mime: "application/json",
        fetchedAt: `2026-09-07T00:00:0${index}Z`,
      });
      const artifactRow = store.db
        .query("SELECT id FROM fetch_artifacts ORDER BY id DESC LIMIT 1")
        .get() as { id: number };
      const parseRunId = insertParseRun(store, {
        artifactId: artifactRow.id,
        parserName: "sbi-shinsei-top-balances-and-activity",
        parserVersion: "0.1.0",
        parsedAt: `2026-09-07T00:01:0${index}Z`,
        status: "ok",
        warnings: [],
      });
      insertObservation(store, parseRunId, {
        kind: "transaction",
        sourceAccount,
        externalId: "SYNTHETIC-SHARED-REFERENCE",
        description,
        rawLocator: "json:$.responseParam.activity.responseParam.activityDetails[0]",
        extra: { _kogane: { sourceView: "top_activity" } },
      });
    }
    expect(currentTransactions(store).map((row) => row.description)).toEqual([
      "other-source",
      "other-account",
      "newer-refetch",
    ]);
    expect(count(store, "transaction_observations")).toBe(4);
  });

  test("current V Point Pay views deduplicate events and keep the latest successful balance", () => {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-v-point-pay-current-"));
    for (const name of ["newer", "duplicate", "stale", "failed"]) {
      writeFileSync(join(directory, `${name}.json`), "{}");
    }
    const source = { id: "v-point-pay", provider: "V Point Pay" };
    const inputs = [
      ["newer", "2026-08-04T00:00:00.000Z", "success", 0],
      ["duplicate", "2026-08-05T00:00:00.000Z", "success", 0],
      ["stale", "2026-08-01T00:00:00.000Z", "success", 0],
      ["failed", "2026-08-06T00:00:00.000Z", "failed", 1],
    ] as const;
    for (const [name, fetchedAt, status, failureCount] of inputs) {
      ingestFile(store, join(directory, `${name}.json`), {
        source,
        mime: "application/json",
        fetchedAt,
      });
      store.db
        .query(
          `UPDATE fetch_runs SET status = ?, failure_count = ? WHERE id = (SELECT MAX(id) FROM fetch_runs)`,
        )
        .run(status, failureCount);
    }
    store.db
      .query(
        `UPDATE fetch_artifacts SET dataset = 'notification-event', artifact_key = 'normalized-event.json'`,
      )
      .run();
    const artifacts = store.db.query("SELECT id FROM fetch_artifacts ORDER BY id").all() as {
      id: number;
    }[];
    for (const [index, row] of artifacts.entries()) {
      const parseRunId = insertParseRun(store, {
        artifactId: row.id,
        parserName: "v-point-pay-notification-event",
        parserVersion: "1.0.0",
        parsedAt: `2026-08-07T00:00:0${index}.000Z`,
        status: "ok",
        warnings: [],
      });
      insertObservation(store, parseRunId, {
        kind: "transaction",
        sourceAccount: "v-point-pay:prepaid-yen",
        externalId: index < 2 ? "same-event" : `event-${index}`,
        description: inputs[index]![0],
        rawLocator: "json:$",
        extra: {},
      });
      insertObservation(store, parseRunId, {
        kind: "balance",
        sourceAccount: "v-point-pay:prepaid-yen",
        metric: "prepaid_balance_after_event",
        instrument: "JPY",
        amountMinor: index + 1,
        asOf: inputs[index]![1],
        observedAt: inputs[index]![1],
        rawLocator: "json:$.balanceYen",
        extra: {},
      });
    }
    expect(
      currentTransactions(store)
        .map((row) => row.description)
        .sort(),
    ).toEqual(["duplicate", "stale"]);
    expect(latestBalances(store)).toMatchObject([{ amount_minor: "2", as_of: inputs[1]![1] }]);
    expect(count(store, "transaction_observations")).toBe(4);
    expect(count(store, "balance_observations")).toBe(4);
  });

  test("a newer parser version supersedes, never deletes", () => {
    const store = storeWithFakeArtifact();
    runParsers(store, [fakeParser("0.1.0", "old")]);
    const summary = runParsers(store, [fakeParser("0.2.0", "new")]);
    expect(summary.parsed).toBe(1);
    expect(summary.superseded).toBe(1);
    // both parse runs and both observation sets still exist
    expect(count(store, "parse_runs")).toBe(2);
    expect(count(store, "transaction_observations")).toBe(2);
    const current = store.db
      .query(
        `SELECT t.description FROM transaction_observations t
         JOIN parse_runs p ON p.id = t.parse_run_id
         WHERE p.superseded_by_parse_run_id IS NULL`,
      )
      .all() as { description: string }[];
    expect(current.map((row) => row.description)).toEqual(["new"]);
    const superseded = store.db
      .query(
        `SELECT p.parser_version, s.parser_version AS by_version FROM parse_runs p
         JOIN parse_runs s ON s.id = p.superseded_by_parse_run_id`,
      )
      .all() as { parser_version: string; by_version: string }[];
    expect(superseded).toEqual([{ parser_version: "0.1.0", by_version: "0.2.0" }]);
  });

  test("a throwing parser records an error parse run", () => {
    const store = storeWithFakeArtifact();
    const broken: Parser = {
      name: "fake-parser",
      version: "0.1.0",
      accepts: (artifact) => artifact.sourceId === "fake",
      parse: () => {
        throw new Error("boom");
      },
    };
    const summary = runParsers(store, [broken]);
    expect(summary.errors).toBe(1);
    const run = store.db.query("SELECT status, error FROM parse_runs").get() as {
      status: string;
      error: string;
    };
    expect(run.status).toBe("error");
    expect(run.error).toBe("boom");
    expect(count(store, "transaction_observations")).toBe(0);
  });

  function currentDescriptions(store: Store): string[] {
    return (
      store.db
        .query(
          `SELECT t.description FROM transaction_observations t
           JOIN parse_runs p ON p.id = t.parse_run_id
           WHERE p.superseded_by_parse_run_id IS NULL AND p.status = 'ok'
           ORDER BY t.id`,
        )
        .all() as { description: string }[]
    ).map((row) => row.description);
  }

  test("an error parse run never supersedes a good one, and stays retryable", () => {
    const store = storeWithFakeArtifact();
    runParsers(store, [fakeParser("0.1.0", "good")]);
    const broken: Parser = {
      name: "fake-parser",
      version: "0.2.0",
      accepts: (artifact) => artifact.sourceId === "fake",
      parse: () => {
        throw new Error("transient");
      },
    };
    const failed = runParsers(store, [broken]);
    expect(failed.errors).toBe(1);
    expect(failed.superseded).toBe(0);
    // The healthy observations are still current: a transient failure must not
    // empty the current view.
    expect(currentDescriptions(store)).toEqual(["good"]);

    // The same version can be retried once the parser is fixed, without
    // inventing a version number to get past the failed attempt.
    const retried = runParsers(store, [fakeParser("0.2.0", "fixed")]);
    expect(retried.parsed).toBe(1);
    expect(retried.superseded).toBe(1);
    expect(currentDescriptions(store)).toEqual(["fixed"]);
  });

  test("running an older parser version does not make stale output current", () => {
    const store = storeWithFakeArtifact();
    runParsers(store, [fakeParser("0.2.0", "newer")]);
    const summary = runParsers(store, [fakeParser("0.1.0", "older")]);
    expect(summary.parsed).toBe(1);
    // Both runs exist and both observation sets are retained, but the newer
    // version stays current regardless of the order the parsers ran in.
    expect(count(store, "parse_runs")).toBe(2);
    expect(count(store, "transaction_observations")).toBe(2);
    expect(currentDescriptions(store)).toEqual(["newer"]);
  });

  test("a failed observation insert leaves no partially-parsed 'ok' run", () => {
    const store = storeWithFakeArtifact();
    const partial: Parser = {
      name: "fake-parser",
      version: "0.1.0",
      accepts: (artifact) => artifact.sourceId === "fake",
      parse: () => ({
        warnings: [],
        observations: [
          {
            kind: "transaction",
            sourceAccount: "fake:account",
            description: "first",
            amountMinor: 1,
            currency: "JPY",
            rawLocator: "json:$[0]",
            extra: {},
          },
          {
            kind: "transaction",
            sourceAccount: "fake:account",
            description: "second",
            // STRICT rejects a non-integral value in an INTEGER column.
            amountMinor: 1.5,
            currency: "JPY",
            rawLocator: "json:$[1]",
            extra: {},
          },
        ],
      }),
    };
    const summary = runParsers(store, [partial]);
    expect(summary.errors).toBe(1);
    expect(summary.parsed).toBe(0);
    // Neither a truncated observation set nor a run claiming success.
    expect(count(store, "transaction_observations")).toBe(0);
    const run = store.db.query("SELECT status FROM parse_runs").get() as {
      status: string;
    };
    expect(run.status).toBe("error");
  });

  test("a missing blob fails only its own artifact, not the sweep", () => {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-blobs-"));
    writeFileSync(join(directory, "a.json"), '{"n": 1}');
    writeFileSync(join(directory, "b.json"), '{"n": 2}');
    const source = { id: "fake", provider: "Fake" };
    ingestFile(store, join(directory, "a.json"), {
      source,
      mime: "application/json",
      fetchedAt: "2026-08-21T00:00:00Z",
    });
    ingestFile(store, join(directory, "b.json"), {
      source,
      mime: "application/json",
      fetchedAt: "2026-08-21T01:00:00Z",
    });
    const blobKey = (
      store.db.query("SELECT blob_key FROM raw_objects ORDER BY sha256").get() as {
        blob_key: string;
      }
    ).blob_key;
    rmSync(join(store.blobDir, ...blobKey.split("/")));

    const summary = runParsers(store, [fakeParser("0.1.0", "ok")]);
    expect(summary.errors).toBe(1);
    expect(summary.parsed).toBe(1); // the healthy artifact was still parsed
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestFile, ingestRunDirectory } from "../src/ingest.ts";
import { runParsers } from "../src/parse.ts";
import { openStore, type Store } from "../src/store.ts";
import type { Parser } from "../src/types.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
const SBI_RUN = join(
  FIXTURES,
  "sbi-securities",
  "2026-08-20",
  "run-20260820-210000-poc01",
);

function tempStore(): Store {
  return openStore(mkdtempSync(join(tmpdir(), "kogane-poc-")));
}

function count(store: Store, table: string): number {
  return (store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("ingestion", () => {
  test("run-directory ingestion is idempotent", () => {
    const store = tempStore();
    const source = { id: "sbi-securities", provider: "SBI Securities" };
    const first = ingestRunDirectory(store, SBI_RUN, source);
    expect(first.skippedExisting).toBe(false);
    expect(first.artifacts).toBe(3);
    const second = ingestRunDirectory(store, SBI_RUN, source);
    expect(second.skippedExisting).toBe(true);
    expect(count(store, "fetch_runs")).toBe(1);
    expect(count(store, "fetch_artifacts")).toBe(3);
    expect(count(store, "raw_objects")).toBe(3);
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

  test("hash mismatch against the manifest is rejected", () => {
    const store = tempStore();
    const directory = mkdtempSync(join(tmpdir(), "kogane-bad-run-"));
    writeFileSync(join(directory, "some-dataset.json"), "{}");
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        runId: "bad-run",
        startedAt: "2026-08-20T00:00:00Z",
        status: "success",
        artifacts: [{ dataset: "some-dataset", sha256: "f".repeat(64), bytes: 2 }],
      }),
    );
    expect(() =>
      ingestRunDirectory(store, directory, { id: "x", provider: "X" }),
    ).toThrow(/does not match manifest/u);
  });
});

function fakeParser(version: string, marker: string): Parser {
  return {
    name: "fake-parser",
    version,
    accepts: (artifact) => artifact.sourceId === "fake",
    parse: (_bytes, artifact) => ({
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
    const run = store.db
      .query("SELECT status, error FROM parse_runs")
      .get() as { status: string; error: string };
    expect(run.status).toBe("error");
    expect(run.error).toBe("boom");
    expect(count(store, "transaction_observations")).toBe(0);
  });
});

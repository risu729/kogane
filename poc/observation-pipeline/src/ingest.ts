// Layer-A ingestion, standing in for the phase-2 importer CLI
// (`kogane import-kuebiko` / `kogane ingest-file`, docs/collection.md).
//
// Two paths, both converging on the same tables:
//   * ingestRunDirectory — a collector run directory shaped like the R2
//     layout poc/sbi-securities-worker actually writes: manifest.json
//     (schemaVersion sbi-worker-poc-v1) plus one JSON file per dataset.
//     Artifact hashes are verified against the manifest before anything is
//     recorded.
//   * ingestFile — a single manually-downloaded export (CSV etc.), the
//     `ingest-file` path for browser downloads CDP capture cannot see.
//
// Both are idempotent: re-ingesting the same run or file is a no-op, because
// runs are keyed by external run id and blobs by SHA-256.

import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  insertFetchArtifact,
  insertFetchRun,
  openStore,
  putRawObject,
  sha256Hex,
  upsertSource,
  type Store,
} from "./store.ts";
import { isObject } from "./parsers/util.ts";

export interface IngestSummary {
  runId: number;
  artifacts: number;
  deduplicated: number;
  skippedExisting: boolean;
}

export function ingestRunDirectory(
  store: Store,
  directory: string,
  source: { id: string; provider: string },
): IngestSummary {
  const manifestBytes = readFileSync(join(directory, "manifest.json"));
  const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
  if (
    !isObject(manifest) ||
    typeof manifest["runId"] !== "string" ||
    !Array.isArray(manifest["artifacts"])
  ) {
    throw new Error(`${directory}/manifest.json is not a collection manifest`);
  }
  upsertSource(store, { ...source, ingestion: "collector-r2" });

  const existing = store.db
    .query("SELECT id FROM fetch_runs WHERE source_id = ?1 AND external_run_id = ?2")
    .get(source.id, manifest["runId"]) as { id: number } | null;
  if (existing) {
    return { runId: existing.id, artifacts: 0, deduplicated: 0, skippedExisting: true };
  }

  const startedAt = String(manifest["startedAt"] ?? new Date(0).toISOString());
  const completedAt =
    typeof manifest["completedAt"] === "string" ? manifest["completedAt"] : undefined;
  const runId = insertFetchRun(store, {
    sourceId: source.id,
    externalRunId: manifest["runId"],
    tool: "import-run",
    startedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
    status: String(manifest["status"] ?? "success"),
  });

  let artifacts = 0;
  let deduplicated = 0;
  for (const entry of manifest["artifacts"]) {
    if (!isObject(entry) || typeof entry["dataset"] !== "string") {
      throw new Error(`${directory}/manifest.json has a malformed artifact entry`);
    }
    const dataset = entry["dataset"];
    const bytes = readFileSync(join(directory, `${dataset}.json`));
    const digest = sha256Hex(bytes);
    if (typeof entry["sha256"] === "string" && entry["sha256"] !== digest) {
      throw new Error(
        `${dataset}: bytes hash ${digest} does not match manifest sha256 ${entry["sha256"]}`,
      );
    }
    const stored = putRawObject(store, bytes, "application/json");
    if (stored.deduplicated) deduplicated += 1;
    insertFetchArtifact(store, {
      fetchRunId: runId,
      sourceId: source.id,
      dataset,
      mime: "application/json",
      fetchedAt: completedAt ?? startedAt,
      sha256: stored.sha256,
    });
    artifacts += 1;
  }
  return { runId, artifacts, deduplicated, skippedExisting: false };
}

export function ingestFile(
  store: Store,
  path: string,
  options: {
    source: { id: string; provider: string };
    mime: string;
    fetchedAt: string;
  },
): IngestSummary {
  upsertSource(store, { ...options.source, ingestion: "file-export" });
  const bytes = readFileSync(path);
  const digest = sha256Hex(bytes);
  const externalRunId = `file:${basename(path)}:${digest.slice(0, 16)}`;
  const existing = store.db
    .query("SELECT id FROM fetch_runs WHERE source_id = ?1 AND external_run_id = ?2")
    .get(options.source.id, externalRunId) as { id: number } | null;
  if (existing) {
    return { runId: existing.id, artifacts: 0, deduplicated: 0, skippedExisting: true };
  }
  const runId = insertFetchRun(store, {
    sourceId: options.source.id,
    externalRunId,
    tool: "ingest-file",
    startedAt: options.fetchedAt,
    completedAt: options.fetchedAt,
    status: "success",
  });
  const stored = putRawObject(store, bytes, options.mime);
  insertFetchArtifact(store, {
    fetchRunId: runId,
    sourceId: options.source.id,
    url: `file:${basename(path)}`,
    mime: options.mime,
    fetchedAt: options.fetchedAt,
    sha256: stored.sha256,
  });
  return {
    runId,
    artifacts: 1,
    deduplicated: stored.deduplicated ? 1 : 0,
    skippedExisting: false,
  };
}

/** Ingest every fixture shipped with the PoC. */
export function ingestFixtures(store: Store, fixturesDir: string): void {
  const sbiRunsRoot = join(fixturesDir, "sbi-securities");
  for (const day of readdirSync(sbiRunsRoot)) {
    for (const run of readdirSync(join(sbiRunsRoot, day))) {
      const summary = ingestRunDirectory(store, join(sbiRunsRoot, day, run), {
        id: "sbi-securities",
        provider: "SBI Securities",
      });
      console.log(
        `ingest sbi-securities ${day}/${run}: ` +
          (summary.skippedExisting
            ? "already ingested"
            : `${summary.artifacts} artifacts (${summary.deduplicated} deduplicated)`),
      );
    }
  }
  const paypayDir = join(fixturesDir, "paypay");
  for (const file of readdirSync(paypayDir)) {
    const summary = ingestFile(store, join(paypayDir, file), {
      source: { id: "paypay", provider: "PayPay" },
      mime: "text/csv",
      fetchedAt: "2026-08-21T09:00:00Z",
    });
    console.log(
      `ingest paypay ${file}: ` +
        (summary.skippedExisting ? "already ingested" : `${summary.artifacts} artifact`),
    );
  }
}

if (import.meta.main) {
  const store = openStore();
  ingestFixtures(store, join(import.meta.dir, "..", "fixtures"));
}

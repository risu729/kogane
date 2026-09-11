// Synthetic substrate for the shared-R2 tests.
//
// CORE is the real schema: every migration from 0001, on a database with
// foreign keys on, so the triggers, CHECK constraints and views the
// registration writes against are the deployed ones rather than a stub that
// agrees with the code by construction. The bucket is the same in-memory R2
// stand-in `packages/collection` tests its writer with, so both sides of
// "the terminal is the completion record" are exercised against one model of
// R2 — and it records every `put`, which is how "registration writes no
// bytes" is asserted rather than asserted about (G1-15).
//
// Everything here is invented: `kogane-synthetic` is the source the financial
// views already exclude, and no amount, account or provider appears.
import type { Database } from "bun:sqlite";
import { sqliteD1, fullCoreDatabase } from "../../../packages/storage-d1/test/sqlite.ts";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket.ts";
import type { CollectionEnv } from "../src/collection/index.ts";
import {
  persistRun,
  type PersistArtifact,
  type PersistRunPlan,
} from "../../../packages/collection/src/writer.ts";
import type { TerminalRunFields } from "../../../packages/collection/src/manifest.ts";

export const SOURCE = "kogane-synthetic";
export const PRODUCER = "synthetic-collector";
export const CLIENT = "processor-shared-r2";
export const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
export const DATA_BUCKET = "kogane-raw-evidence";

export interface CollectionHarness {
  db: Database;
  bucket: FakeR2Bucket;
  env: CollectionEnv & { OPS_DISPATCH_ENABLED?: string };
}

/** CORE plus the registry rows a registration needs, and an empty bucket. */
export function collectionHarness(vars: Partial<Record<string, string>> = {}): CollectionHarness {
  const db = fullCoreDatabase();
  db.exec(`
    INSERT INTO sources (id, provider, display_name)
      VALUES ('${SOURCE}', 'Synthetic', 'Synthetic source');
    INSERT INTO producers (id, kind, display_name)
      VALUES ('${PRODUCER}', 'collector', 'Synthetic collector');
    INSERT INTO producer_sources (producer_id, source_id) VALUES ('${PRODUCER}', '${SOURCE}');
    INSERT INTO ingest_clients (id, display_name) VALUES ('${CLIENT}', 'Processor');
    INSERT INTO ingest_client_producers (ingest_client_id, producer_id)
      VALUES ('${CLIENT}', '${PRODUCER}');
    INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id)
      VALUES ('${CLIENT}', '${PRODUCER}', '${SOURCE}');
  `);
  const bucket = new FakeR2Bucket();
  return {
    db,
    bucket,
    env: {
      DB: sqliteD1(db) as CollectionEnv["DB"],
      EVIDENCE: bucket as unknown as CollectionEnv["EVIDENCE"],
      SHARED_R2_INGEST_ENABLED: "true",
      COLLECTION_INGEST_CLIENT: CLIENT,
      COLLECTION_DATA_BUCKET: DATA_BUCKET,
      COLLECTION_ACCOUNT_ID: ACCOUNT_ID,
      ...vars,
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function artifact(
  artifactKey: string,
  text: string,
  overrides: Partial<Omit<PersistArtifact, "artifactKey" | "body">> = {},
): Promise<PersistArtifact> {
  const bytes = new TextEncoder().encode(text);
  return {
    artifactKey,
    sha256: await sha256Hex(bytes),
    byteSize: bytes.byteLength,
    mediaType: "application/json",
    role: "provider_response",
    body: { kind: "bytes", bytes },
    ...overrides,
  };
}

export function run(overrides: Partial<TerminalRunFields> = {}): TerminalRunFields {
  return {
    source: SOURCE,
    producer: PRODUCER,
    producerVersion: "synthetic-collector-1.0.0",
    runId: "run-001",
    attemptId: "attempt-001",
    requestedScope: {
      scopeKind: "full_snapshot",
      startValue: null,
      endValue: null,
      unitKeys: [],
    },
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:01:00.000Z",
    providerOutcome: "success",
    coverageStatus: "unknown",
    persistenceComplete: true,
    units: [],
    ranges: [],
    reports: [],
    transformations: [],
    ...overrides,
  };
}

/** Persist one synthetic run exactly as a shared-R2 collector would. */
export async function persistSyntheticRun(
  harness: CollectionHarness,
  overrides: { run?: Partial<TerminalRunFields>; artifacts?: readonly PersistArtifact[] } = {},
): Promise<PersistRunPlan> {
  const plan: PersistRunPlan = {
    run: run(overrides.run),
    artifacts: overrides.artifacts ?? [
      await artifact("balance.json", '{"synthetic":true}'),
      await artifact("statement.json", '{"synthetic":"statement"}'),
    ],
  };
  const result = await persistRun(harness.bucket, plan);
  if (result.outcome === "conflict") {
    throw new Error(`unexpected persist conflict: ${result.reasonCode}`);
  }
  return plan;
}

/** An R2 event notification for one terminal, as the bucket emits them. */
export function notification(
  source: string,
  runId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    account: ACCOUNT_ID,
    action: "PutObject",
    bucket: DATA_BUCKET,
    object: { key: `runs/${source}/${runId}/terminal.json`, size: 512, eTag: "etag-1" },
    eventTime: "2026-09-01T00:01:00.000Z",
    ...overrides,
  };
}

export function rows<T>(db: Database, sql: string, ...binds: unknown[]): T[] {
  return db.query(sql).all(...(binds as never[])) as T[];
}

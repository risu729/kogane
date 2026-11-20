// The parse pipeline's appends skip only the conflict they expect: a re-issued
// job, a recomputed metadata projection or input, a registered release, a
// survey page that has its cursor. Each statement names its key
// (`ON CONFLICT(<key>) DO NOTHING`), or is a plain INSERT where no earlier row
// can hold the key (a parse run's input reference). They used `INSERT OR
// IGNORE`, which SQLite also applies to CHECK and NOT NULL failures, so a row
// the schema refused was skipped with no error.
//
// Where the shipped constraints refuse no row the code builds, a test adds one
// CHECK to the real table (`refuse` below): a column whose CHECK names the
// synthetic row, the shape a migration that tightens the table would leave. It
// is added with `ALTER TABLE … ADD COLUMN`, which D1 runs, rather than a
// table rebuild. Every value is synthetic.
import { afterAll, expect, test } from "bun:test";
import {
  LEGACY_METADATA_RELEASE,
  MANIFEST_METADATA_RELEASE,
  extractMetadata,
  persistProjection,
} from "../src/metadata-extractors/index.ts";
import type { MetadataArtifact, MetadataExtraction } from "../src/metadata-extractors/types.ts";
import { WORK_ITEM_PROGRESS_SQL } from "../src/lane-progress-sql.ts";
import { maintenanceSurveyLane } from "../src/maintenance-survey/lane.ts";
import type { SurveyConfig } from "../src/maintenance-survey/config.ts";
import {
  registerDeployedReleases,
  releaseIdentity,
  releaseInsert,
  type RegisteredRelease,
} from "../src/releases.ts";
import { sweep } from "../src/worker.ts";
import { PARSERS } from "../../../packages/parsers/src/parsers/registry.ts";
import { seedArtifact, startPipeline } from "./harness.ts";

// Started while the module loads, so a timed-out case cannot take its
// workerd with it; every case shares it.
const { mf, env } = await startPipeline();
afterAll(async () => {
  await mf.dispose();
});

const balance = { amount: 1, currency: "JPY", observedAt: "2026-09-07T00:00:00.000Z" };
const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql)
    .bind(...binds)
    .first<number>("n"))!;
/** Adds a CHECK that refuses the rows `check` is false for. */
const refuse = (table: string, check: string) =>
  env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN refusal_probe INTEGER CHECK(${check})`).run();
const withdraw = (table: string) =>
  env.DB.prepare(`ALTER TABLE ${table} DROP COLUMN refusal_probe`).run();
const workItem = (run: number) =>
  env.DB.prepare(
    "SELECT cursor_artifact_id,processed_at_ms,jobs_created FROM observation_work_items WHERE fetch_run_id=?",
  )
    .bind(run)
    .first<{ cursor_artifact_id: number; processed_at_ms: number | null; jobs_created: number }>();

test("a page re-issued after an interrupted sweep creates no second job", async () => {
  await seedArtifact(
    env,
    610,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  // The sweep stops after its job inserts and before the item's cursor moves.
  const interrupted = {
    ...env,
    DB: new Proxy(env.DB, {
      get(target, key, receiver) {
        if (key !== "prepare") return Reflect.get(target, key, receiver);
        return (sql: string) => {
          if (sql === WORK_ITEM_PROGRESS_SQL) throw new Error("synthetic_interruption");
          return target.prepare(sql);
        };
      },
    }),
  } as Env;
  await expect(sweep(interrupted, { lane: "incremental" })).rejects.toThrow(
    "synthetic_interruption",
  );
  expect(
    await count("SELECT count(*) n FROM observation_parse_jobs WHERE fetch_artifact_id=610"),
  ).toBe(1);
  expect(await workItem(610)).toMatchObject({ cursor_artifact_id: 0, processed_at_ms: null });
  // The next sweep reads the same page again: its inserts change nothing, and
  // the item still counts its one job from the table.
  const again = await sweep(env, { lane: "incremental" });
  expect(again.lanes.incremental).toMatchObject({ created: 0, workItems: 1, parsed: 1 });
  expect(
    await count("SELECT count(*) n FROM observation_parse_jobs WHERE fetch_artifact_id=610"),
  ).toBe(1);
  expect(await workItem(610)).toMatchObject({ cursor_artifact_id: 610, jobs_created: 1 });
});

test("a job the schema refuses fails the sweep before the cursor moves, and is created once it is accepted", async () => {
  await seedArtifact(
    env,
    611,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  await refuse("observation_parse_jobs", "fetch_artifact_id<>611");
  try {
    // `OR IGNORE` skipped the job, moved the item's cursor past 611 and
    // recorded the item as processed: the artifact was never parsed.
    await expect(sweep(env, { lane: "incremental" })).rejects.toThrow(/CHECK constraint failed/u);
    expect(
      await count("SELECT count(*) n FROM observation_parse_jobs WHERE fetch_artifact_id=611"),
    ).toBe(0);
    expect(await workItem(611)).toMatchObject({ cursor_artifact_id: 0, processed_at_ms: null });
  } finally {
    await withdraw("observation_parse_jobs");
  }
  const accepted = await sweep(env, { lane: "incremental" });
  expect(accepted.lanes.incremental).toMatchObject({ created: 1, workItems: 1, parsed: 1 });
  expect(await workItem(611)).toMatchObject({ cursor_artifact_id: 611, jobs_created: 1 });
});

test("a parse whose input reference the schema refuses fails instead of publishing without it", async () => {
  await seedArtifact(
    env,
    620,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  // The attempt's parse run is the next id: parse runs are never deleted.
  const next = (await count("SELECT coalesce(max(id),0)+1 n FROM parse_runs"))!;
  await refuse("parse_input_references", `parse_run_id<>${next}`);
  try {
    const result = await sweep(env, { lane: "incremental" });
    expect(result.lanes.incremental).toMatchObject({ created: 1, parsed: 0, error: 1 });
  } finally {
    await withdraw("parse_input_references");
  }
  expect(
    await env.DB.prepare(
      "SELECT id,status,error FROM parse_runs WHERE fetch_artifact_id=620",
    ).all(),
  ).toMatchObject({ results: [{ id: next, status: "error", error: "persistence_failed" }] });
  expect(
    await count("SELECT count(*) n FROM parse_input_references WHERE parse_run_id=?", next),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT status,last_error_code FROM observation_parse_jobs WHERE fetch_artifact_id=620",
    ).first(),
  ).toEqual({ status: "pending", last_error_code: "persistence_failed" });
});

const artifact = (id: number): MetadataArtifact => ({
  id,
  fetch_run_id: id,
  source_id: "smbc-bank",
  dataset: "balance-normalized",
  artifact_key: "balance.normalized.json",
  mime: "application/json",
  sha256: "a".repeat(64),
});
const extraction = (inputs: MetadataExtraction["inputs"]): MetadataExtraction => ({
  status: "ok",
  output: { mime: null, period: "synthetic-period", statementState: "synthetic-state" },
  inputs,
  inputDigest: "b".repeat(64),
  manifestArtifactId: null,
});
const NOW = "2026-11-19T00:00:00.000Z";

test("a recomputed metadata projection and its inputs are one row each", async () => {
  await seedArtifact(
    env,
    630,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  const computed = extraction([{ artifactId: 630, role: "subject", rawSha256: "a".repeat(64) }]);
  const first = await persistProjection(
    env.DB,
    artifact(630),
    MANIFEST_METADATA_RELEASE,
    computed,
    NOW,
  );
  const second = await persistProjection(
    env.DB,
    artifact(630),
    MANIFEST_METADATA_RELEASE,
    computed,
    NOW,
  );
  expect(second).toBe(first);
  expect(
    await count("SELECT count(*) n FROM metadata_projections WHERE fetch_artifact_id=630"),
  ).toBe(1);
  expect(
    await count("SELECT count(*) n FROM metadata_projection_inputs WHERE projection_id=?", first),
  ).toBe(1);
});

test("a metadata projection or input the schema refuses raises instead of being left out", async () => {
  await seedArtifact(
    env,
    631,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  // A status the CHECK refuses. `OR IGNORE` skipped it, and the caller only
  // noticed by finding no row (`metadata_projection_missing`).
  await expect(
    persistProjection(
      env.DB,
      artifact(631),
      MANIFEST_METADATA_RELEASE,
      { ...extraction([]), status: "refused" as never },
      NOW,
    ),
  ).rejects.toThrow(/CHECK constraint failed/u);
  expect(
    await count("SELECT count(*) n FROM metadata_projections WHERE fetch_artifact_id=631"),
  ).toBe(0);
  // An input without its raw digest: `OR IGNORE` dropped it with no error,
  // and the projection read as complete without it.
  await expect(
    persistProjection(
      env.DB,
      artifact(631),
      MANIFEST_METADATA_RELEASE,
      extraction([
        { artifactId: 631, role: "subject", rawSha256: "a".repeat(64) },
        { artifactId: 631, role: "collector_manifest", rawSha256: null as never },
      ]),
      NOW,
    ),
  ).rejects.toThrow(/NOT NULL constraint failed/u);
  // The inputs are one batch: none of them is written. The projection,
  // written before them, stays without its inputs (a documented limit).
  expect(
    await count(
      "SELECT count(*) n FROM metadata_projection_inputs i JOIN metadata_projections p ON p.id=i.projection_id WHERE p.fetch_artifact_id=631",
    ),
  ).toBe(0);
});

test("the legacy extractor keeps an artifact's first metadata row, and a refused row raises", async () => {
  await seedArtifact(
    env,
    632,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  await seedArtifact(
    env,
    633,
    "smbc-bank",
    "balance-normalized",
    "balance.normalized.json",
    balance,
  );
  const context = {
    db: env.DB,
    read: async (): Promise<Uint8Array> => {
      throw new Error("synthetic_no_read");
    },
  };
  await extractMetadata(context, artifact(632), LEGACY_METADATA_RELEASE);
  await extractMetadata(context, artifact(632), LEGACY_METADATA_RELEASE);
  expect(
    await count("SELECT count(*) n FROM observation_artifact_metadata WHERE fetch_artifact_id=632"),
  ).toBe(1);
  // The table has no CHECK today; one a later migration adds is not skipped.
  await refuse("observation_artifact_metadata", "fetch_artifact_id<>633");
  try {
    await expect(extractMetadata(context, artifact(633), LEGACY_METADATA_RELEASE)).rejects.toThrow(
      /CHECK constraint failed/u,
    );
  } finally {
    await withdraw("observation_artifact_metadata");
  }
  expect(
    await count("SELECT count(*) n FROM observation_artifact_metadata WHERE fetch_artifact_id=633"),
  ).toBe(0);
});

test("a registered release is skipped by its id and counted once; a refused release raises", async () => {
  const parser = PARSERS[0]!;
  const identity = await releaseIdentity(parser, LEGACY_METADATA_RELEASE);
  // The deployed registry, registered (the sweeps above may already have done
  // it, unless an earlier file's sweep set this isolate's once-only flag),
  // then registered again: the second pass writes and counts nothing.
  const before = await count("SELECT count(*) n FROM parser_releases");
  const written = await registerDeployedReleases(env.DB, PARSERS, true);
  const releases = await count("SELECT count(*) n FROM parser_releases");
  expect(releases).toBe(before + written);
  expect(releases).toBeGreaterThanOrEqual(PARSERS.length);
  expect(await registerDeployedReleases(env.DB, PARSERS, true)).toBe(0);
  expect(await count("SELECT count(*) n FROM parser_releases")).toBe(releases);
  // A new release: written once, then skipped by its id.
  const synthetic: RegisteredRelease = {
    parser,
    metadataExtractorRelease: LEGACY_METADATA_RELEASE,
    ...identity,
    releaseId: `${parser.name}-${parser.version}-${"c".repeat(16)}`,
  };
  expect((await releaseInsert(env.DB, synthetic, NOW).run()).meta.changes).toBe(1);
  expect((await releaseInsert(env.DB, synthetic, NOW).run()).meta.changes).toBe(0);
  // A manifest without its code digest: `OR IGNORE` skipped it with no error.
  const refused: RegisteredRelease = {
    ...synthetic,
    releaseId: `${parser.name}-${parser.version}-${"d".repeat(16)}`,
    manifest: { ...identity.manifest, codeDigest: null as never },
  };
  await expect(releaseInsert(env.DB, refused, NOW).run()).rejects.toThrow(
    /NOT NULL constraint failed/u,
  );
  expect(
    await count("SELECT count(*) n FROM parser_releases WHERE release_id=?", refused.releaseId),
  ).toBe(0);
});

const surveyTarget = (id: string) => ({
  id,
  source: "mizuho-bank",
  url: "https://www.mizuhobank.co.jp/direct/time.html",
  scope: "collection" as const,
  timezone: "Asia/Tokyo" as const,
  cadenceHours: 24,
  terms: "confirmed" as const,
  cost: "confirmed" as const,
  fetch: "enabled" as const,
});
const noFetch = async (): Promise<Response> => {
  throw new Error("synthetic_no_fetch");
};

test("a survey page keeps its cursor, and a cursor the schema refuses fails the tick", async () => {
  const later = "2099-01-01T00:00:00.000Z";
  await env.DB.prepare(
    "INSERT INTO maintenance_survey_cursors(target_id,next_due_at) VALUES('synthetic-page',?)",
  )
    .bind(later)
    .run();
  const kept = await maintenanceSurveyLane(env, {
    config: { targetsPerTick: 1, targets: [surveyTarget("synthetic-page")] } as SurveyConfig,
    transport: noFetch,
  });
  expect(kept).toMatchObject({ targets: 1, due: 0 });
  expect(
    await env.DB.prepare(
      "SELECT next_due_at FROM maintenance_survey_cursors WHERE target_id='synthetic-page'",
    ).first<string>("next_due_at"),
  ).toBe(later);
  // An id the target CHECK refuses; the validated configuration never holds
  // one. `OR IGNORE` left it without a cursor, so it was never surveyed.
  await expect(
    maintenanceSurveyLane(env, {
      config: {
        targetsPerTick: 1,
        targets: [surveyTarget("Synthetic_Refused")],
      } as SurveyConfig,
      transport: noFetch,
    }),
  ).rejects.toThrow(/CHECK constraint failed/u);
  expect(
    await count(
      "SELECT count(*) n FROM maintenance_survey_cursors WHERE target_id='Synthetic_Refused'",
    ),
  ).toBe(0);
});

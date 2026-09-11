// Metadata extraction as a versioned transform (design review D02, A04;
// docs/release-adoption.md), plus the 0027/0028 upgrade on an existing store
// and the behaviour with the release flag off.
//
// The MyJCB fixture is the case the review describes: a statement state was
// stored once, the extraction rule is later corrected, and the manifest is
// still there. The correction must be expressible without rewriting the
// stored value and without changing what an existing parse read.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Miniflare } from "miniflare";
import { parseJob, sweep } from "../src/worker.ts";
import { inputFingerprint, releaseIdentity } from "../src/releases.ts";
import {
  LEGACY_METADATA_RELEASE,
  MANIFEST_METADATA_RELEASE,
} from "../src/metadata-extractors/index.ts";
import { applyMigration, layerBMigrations, seedArtifact, startPipeline } from "./harness.ts";
import { smbcDirectBalance } from "../../../packages/parsers/src/parsers/smbc-direct.ts";

let mf: Miniflare;
let env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline(layerBMigrations(), {
    RELEASE_CANDIDATES_ENABLED: "true",
  }));
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

const LEDGER = JSON.parse(
  readFileSync(
    new URL(
      "../../../tests/fixtures/observation-pipeline/myjcb/2026-09-07/run-synthetic/connection-a/credit-ledger-00.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { state: string; period: string };

async function post(path: string, body: unknown) {
  const response = await mf.dispatchFetch(`https://pipeline.internal${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}
async function get(path: string) {
  const response = await mf.dispatchFetch(`https://pipeline.internal${path}`);
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}
const projections = (artifactId: number) =>
  env.DB.prepare(
    "SELECT id,extractor_release,input_digest,output_json,status FROM metadata_projections WHERE fetch_artifact_id=? ORDER BY id",
  )
    .bind(artifactId)
    .all<{
      id: number;
      extractor_release: string;
      input_digest: string;
      output_json: string;
      status: string;
    }>()
    .then((rows) => rows.results);

/** The MyJCB fixture plus its sanitized central manifest, as pipeline.test.ts
 * seeds it: the artifact carries the statement state only through the run's
 * manifest. */
async function seedMyJcb(artifactId: number, manifestId: number) {
  await seedArtifact(
    env,
    artifactId,
    "myjcb",
    "credit-ledger",
    "connection-a/credit-ledger-00.json",
    LEDGER,
  );
  await env.DB.prepare(
    "INSERT INTO fetch_units(id,fetch_run_id,unit_key) VALUES(?,?,'connection-a')",
  )
    .bind(artifactId, artifactId)
    .run();
  await env.DB.prepare("UPDATE fetch_artifacts SET fetch_unit_id=? WHERE id=?")
    .bind(artifactId, artifactId)
    .run();
  const manifest = {
    artifacts: [
      {
        connectionId: "connection-a",
        filename: "credit-ledger-00.json",
        dataset: "credit-ledger",
        statementState: LEDGER.state,
        period: LEDGER.period,
      },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  await env.EVIDENCE.put(sha, bytes);
  await env.DB.prepare("INSERT OR IGNORE INTO raw_objects VALUES(?,?,?)")
    .bind(sha, bytes.length, sha)
    .run();
  await env.DB.prepare(
    "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,declared_media_type,fetched_at_ms,recorded_at_ms,sha256,artifact_role) VALUES(?,?,'myjcb',NULL,'manifest.json',NULL,'application/json',0,0,?,'collector_manifest')",
  )
    .bind(manifestId, artifactId, sha)
    .run();
  return manifestId;
}

test("a stale stored value is listed for re-extraction, and old parses keep their inputs", async () => {
  const manifestId = await seedMyJcb(50, 51);
  await seedMyJcb(52, 53);
  // The state the review describes for artifact 52: a wrong value was stored
  // once by an earlier extraction, and the append-only table cannot be
  // corrected. The MyJCB parser requires its metadata to agree with the
  // document, so the stale value does not just mislead the result - it makes
  // the parse fail, and only a re-extraction can fix it.
  await env.DB.prepare(
    "INSERT INTO observation_artifact_metadata(fetch_artifact_id,statement_state,period,metadata_manifest_artifact_id) VALUES(52,'stale-state','stale-period',NULL)",
  ).run();
  await env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
  await sweep(env);
  const parsed = (await env.DB.prepare(
    "SELECT id FROM parse_runs WHERE fetch_artifact_id=50 AND status='ok' ORDER BY id LIMIT 1",
  ).first<number>("id"))!;
  expect(parsed).toBeGreaterThan(0);
  expect(
    await env.DB.prepare(
      "SELECT error FROM parse_runs WHERE fetch_artifact_id=52 ORDER BY id LIMIT 1",
    ).first<string>("error"),
  ).toBe("parser_rejected");
  // The legacy release reproduces the pre-A04 behaviour exactly: the stored
  // value wins for 52, and 50 takes its values from the manifest.
  expect(
    await env.DB.prepare(
      "SELECT statement_state FROM observation_fetch_artifacts WHERE id=52",
    ).first<string>("statement_state"),
  ).toBe("stale-state");
  const legacy = (await projections(50)).filter(
    (row) => row.extractor_release === LEGACY_METADATA_RELEASE,
  );
  expect(legacy).toHaveLength(1);
  expect(legacy[0]).toMatchObject({ input_digest: "unknown", status: "ok" });
  expect(JSON.parse(legacy[0]!.output_json)).toEqual({
    period: LEDGER.period,
    statementState: LEDGER.state,
  });
  expect(
    (
      await env.DB.prepare(
        "SELECT input_artifact_id,role FROM metadata_projection_inputs WHERE projection_id=?",
      )
        .bind(legacy[0]!.id)
        .all<{ input_artifact_id: number; role: string }>()
    ).results,
  ).toEqual([{ input_artifact_id: manifestId, role: "collector_manifest" }]);
  const reference = await env.DB.prepare(
    "SELECT metadata_projection_id,input_fingerprint FROM parse_input_references WHERE parse_run_id=?",
  )
    .bind(parsed)
    .first<{ metadata_projection_id: number; input_fingerprint: string }>();
  expect(reference?.metadata_projection_id).toBe(legacy[0]!.id);

  // An explicit re-extraction: it never skips because a value exists, it
  // records its inputs, and it leaves old projections and old parse
  // references alone. The two collector manifests are in scope and have no
  // metadata of their own, so their extraction is recorded as an error rather
  // than silently dropped.
  const reextract = await post("/metadata/reextract", {
    source: "myjcb",
    extractorRelease: MANIFEST_METADATA_RELEASE,
  });
  expect(reextract.status).toBe(200);
  expect(reextract.json).toMatchObject({
    release: MANIFEST_METADATA_RELEASE,
    examined: 4,
    ok: 2,
    errors: 2,
    complete: true,
  });
  const versioned = (await projections(52)).filter(
    (row) => row.extractor_release === MANIFEST_METADATA_RELEASE,
  );
  expect(versioned).toHaveLength(1);
  expect(versioned[0]!.input_digest).toMatch(/^[0-9a-f]{64}$/u);
  expect(JSON.parse(versioned[0]!.output_json)).toEqual({
    mime: null,
    period: LEDGER.period,
    statementState: LEDGER.state,
  });
  // The old projection of 52 and the old parse reference of 50 are untouched.
  expect(
    (await projections(52))
      .filter((row) => row.extractor_release === LEGACY_METADATA_RELEASE)
      .map((row) => JSON.parse(row.output_json)),
  ).toEqual([{ period: "stale-period", statementState: "stale-state" }]);
  expect(
    await env.DB.prepare(
      "SELECT metadata_projection_id FROM parse_input_references WHERE parse_run_id=?",
    )
      .bind(parsed)
      .first<number>("metadata_projection_id"),
  ).toBe(legacy[0]!.id);

  // The operator listing: ids and changed field names, never the values.
  const differences = await get(`/metadata/differences?release=${MANIFEST_METADATA_RELEASE}`);
  expect(differences.status).toBe(200);
  expect(differences.json).toMatchObject({ compared: 2, differing: 1 });
  expect(differences.json.differences).toEqual([
    { artifactId: 52, changed: ["period", "statementState"] },
  ]);
  expect(JSON.stringify(differences.json)).not.toContain("stale-state");
  expect(JSON.stringify(differences.json)).not.toContain(LEDGER.state);

  // A release that names the new extractor is a different transformation, so
  // the same evidence has a different input fingerprint under it.
  const row = (await env.DB.prepare(
    "SELECT sha256,fetched_at,dataset,artifact_key,fetch_unit_key,mime FROM observation_fetch_artifacts WHERE id=50",
  ).first<{
    sha256: string;
    fetched_at: string;
    dataset: string;
    artifact_key: string;
    fetch_unit_key: string;
    mime: string;
  }>())!;
  const parser = (await env.DB.prepare(
    "SELECT parser_name,parser_version FROM parse_runs WHERE id=?",
  )
    .bind(parsed)
    .first<{ parser_name: string; parser_version: string }>())!;
  const meta = {
    id: 50,
    sourceId: "myjcb",
    runStatus: "success" as const,
    runFailureCount: 0,
    dataset: row.dataset,
    artifactKey: row.artifact_key,
    fetchUnitKey: row.fetch_unit_key,
    url: null,
    mime: row.mime,
    fetchedAt: row.fetched_at,
    sha256: row.sha256,
    statementState: LEDGER.state,
    period: LEDGER.period,
  };
  const legacyIdentity = await releaseIdentity(
    { name: parser.parser_name, version: parser.parser_version },
    LEGACY_METADATA_RELEASE,
  );
  const versionedIdentity = await releaseIdentity(
    { name: parser.parser_name, version: parser.parser_version },
    MANIFEST_METADATA_RELEASE,
  );
  expect(versionedIdentity.releaseId).not.toBe(legacyIdentity.releaseId);
  const legacyFingerprint = await inputFingerprint({
    rawSha256: row.sha256,
    meta,
    manifestDigest: legacyIdentity.manifestDigest,
  });
  expect(legacyFingerprint).toBe(reference!.input_fingerprint);
  // Deterministic: the same manifest over the same evidence, again.
  expect(
    await inputFingerprint({
      rawSha256: row.sha256,
      meta,
      manifestDigest: legacyIdentity.manifestDigest,
    }),
  ).toBe(legacyFingerprint);
  expect(
    await inputFingerprint({
      rawSha256: row.sha256,
      meta,
      manifestDigest: versionedIdentity.manifestDigest,
    }),
  ).not.toBe(legacyFingerprint);
  // Different metadata under the same manifest is a different input too.
  expect(
    await inputFingerprint({
      rawSha256: row.sha256,
      meta: { ...meta, statementState: "stale-state", period: "stale-period" },
      manifestDigest: legacyIdentity.manifestDigest,
    }),
  ).not.toBe(legacyFingerprint);
}, 60000);

test("a re-extraction that reads the same evidence twice records one projection", async () => {
  const before = await projections(50);
  const first = await post("/metadata/reextract", {
    source: "myjcb",
    extractorRelease: MANIFEST_METADATA_RELEASE,
  });
  expect(first.json).toMatchObject({ examined: 4, ok: 2, errors: 2 });
  expect(await projections(50)).toEqual(before);
  // Invalid commands change nothing.
  for (const body of [
    { source: "MyJCB", extractorRelease: MANIFEST_METADATA_RELEASE },
    { source: "myjcb", extractorRelease: "not-a-release" },
    { source: "myjcb", extractorRelease: MANIFEST_METADATA_RELEASE, limit: 0 },
    { source: "myjcb", extractorRelease: MANIFEST_METADATA_RELEASE, limit: 10_000 },
  ])
    expect((await post("/metadata/reextract", body)).status, JSON.stringify(body)).toBe(400);
  expect(await projections(50)).toEqual(before);
}, 30000);

test("with the release flag off a targeted job publishes normally and no command route exists", async () => {
  const off = await startPipeline();
  try {
    await seedArtifact(off.env, 60, "smbc-bank", "balance-normalized", "balance.normalized.json", {
      amount: 1,
      currency: "JPY",
      observedAt: "2026-09-07T00:00:00.000Z",
    });
    const identity = await releaseIdentity({ name: "smbc-direct-balance", version: "1.0.0" });
    await off.env.DB.prepare(
      "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,target_release) VALUES(60,'smbc-direct-balance','1.0.0','pending',?)",
    )
      .bind(identity.releaseId)
      .run();
    expect(
      await parseJob(
        off.env,
        {
          fetch_artifact_id: 60,
          parser_name: "smbc-direct-balance",
          parser_version: "1.0.0",
          attempts: 0,
          target_release: identity.releaseId,
        },
        smbcDirectBalance,
      ),
    ).toBe("parsed");
    // The target release is ignored: this is an ordinary publication, and no
    // candidate row exists anywhere.
    expect(
      await off.env.DB.prepare(
        "SELECT publication_kind FROM published_parse_runs WHERE fetch_artifact_id=60",
      ).first<string>("publication_kind"),
    ).toBe("normal");
    expect(
      await off.env.DB.prepare("SELECT count(*) AS n FROM parse_run_candidates").first<number>("n"),
    ).toBe(0);
    // The input fingerprint is still recorded, which is what makes a later
    // comparison possible at all.
    expect(
      await off.env.DB.prepare(
        "SELECT count(*) AS n FROM parse_input_references WHERE parser_release_id=?",
      )
        .bind(identity.releaseId)
        .first<number>("n"),
    ).toBe(1);
    for (const path of [
      "/release/register",
      "/release/compare",
      "/release/activate",
      "/release/rollback",
      "/metadata/reextract",
    ]) {
      const response = await off.mf.dispatchFetch(`https://pipeline.internal${path}`, {
        method: "POST",
        body: "{}",
      });
      expect(response.status, path).toBe(404);
    }
    // The read-only audit routes stay available.
    const status = await off.mf.dispatchFetch("https://pipeline.internal/release/status");
    expect(status.status).toBe(200);
  } finally {
    await off.mf.dispose();
  }
}, 60000);

test("0027 and 0028 apply to a store that already has metadata and parses, and backfill exactly", async () => {
  const upgrade = await startPipeline(
    layerBMigrations().filter((name) => !name.startsWith("0027_") && !name.startsWith("0028_")),
  );
  try {
    const db = upgrade.env.DB;
    for (const id of [1, 2, 3])
      await seedArtifact(
        upgrade.env,
        id,
        "smbc-bank",
        "balance-normalized",
        "balance.normalized.json",
        {
          amount: 1,
          currency: "JPY",
          observedAt: "2026-09-07T00:00:00.000Z",
        },
      );
    // A manifest artifact one metadata row points at, one row with values and
    // no manifest, and one row that recorded "no value at all".
    await db
      .prepare(
        "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,declared_media_type,fetched_at_ms,recorded_at_ms,sha256,artifact_role) SELECT 9,1,'smbc-bank',NULL,'manifest.json','application/json',0,0,sha256,'collector_manifest' FROM fetch_artifacts WHERE id=1",
      )
      .run();
    await db.batch([
      db.prepare("INSERT INTO observation_artifact_metadata VALUES(1,'confirmed','2026-09',9)"),
      db.prepare("INSERT INTO observation_artifact_metadata VALUES(2,NULL,'2026-08',NULL)"),
      db.prepare("INSERT INTO observation_artifact_metadata VALUES(3,NULL,NULL,NULL)"),
    ]);
    const before = (
      await db
        .prepare("SELECT * FROM observation_artifact_metadata ORDER BY fetch_artifact_id")
        .all<Record<string, unknown>>()
    ).results;

    await applyMigration(db, "0027_metadata_projections.sql");
    await applyMigration(db, "0028_parse_releases.sql");

    // The legacy table is untouched, and every row became a projection of the
    // compatibility extractor with an honest 'unknown' digest.
    expect(
      (
        await db
          .prepare("SELECT * FROM observation_artifact_metadata ORDER BY fetch_artifact_id")
          .all<Record<string, unknown>>()
      ).results,
    ).toEqual(before);
    expect(
      (
        await db
          .prepare(
            "SELECT fetch_artifact_id,extractor_release,input_digest,output_digest,output_json,status FROM metadata_projections ORDER BY fetch_artifact_id",
          )
          .all<Record<string, unknown>>()
      ).results,
    ).toEqual([
      {
        fetch_artifact_id: 1,
        extractor_release: "legacy-metadata-v1",
        input_digest: "unknown",
        output_digest: "unknown",
        output_json: '{"period":"2026-09","statementState":"confirmed"}',
        status: "ok",
      },
      {
        fetch_artifact_id: 2,
        extractor_release: "legacy-metadata-v1",
        input_digest: "unknown",
        output_digest: "unknown",
        output_json: '{"period":"2026-08","statementState":null}',
        status: "ok",
      },
      {
        fetch_artifact_id: 3,
        extractor_release: "legacy-metadata-v1",
        input_digest: "unknown",
        output_digest: "unknown",
        output_json: '{"period":null,"statementState":null}',
        status: "absent",
      },
    ]);
    // Only the recorded manifest reference becomes an input; nothing else.
    expect(
      (
        await db
          .prepare(
            "SELECT p.fetch_artifact_id,i.input_artifact_id,i.role FROM metadata_projection_inputs i JOIN metadata_projections p ON p.id=i.projection_id",
          )
          .all<Record<string, unknown>>()
      ).results,
    ).toEqual([{ fetch_artifact_id: 1, input_artifact_id: 9, role: "collector_manifest" }]);
    // Idempotent: the backfill statements add nothing the second time.
    await applyMigration(db, "0027_metadata_projections.sql").catch(() => undefined);
    expect(
      await db.prepare("SELECT count(*) AS n FROM metadata_projections").first<number>("n"),
    ).toBe(3);
    // The new tables are empty and the gaps view agrees with the old one.
    for (const table of [
      "parser_releases",
      "parse_run_candidates",
      "release_comparisons",
      "active_releases",
      "release_activation_events",
      "parse_input_references",
    ])
      expect(await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>("n"), table).toBe(
        0,
      );
    expect(
      await db.prepare("SELECT count(*) AS n FROM publication_gate_gaps").first<number>("n"),
    ).toBe(0);
    // The Worker keeps working on the upgraded store.
    await upgrade.env.DB.prepare("UPDATE observation_scan_state SET cursor=0").run();
    const swept = await sweep(upgrade.env);
    expect(swept.parsed).toBeGreaterThan(0);
    expect(
      await db.prepare("SELECT count(*) AS n FROM parser_releases").first<number>("n"),
    ).toBeGreaterThan(0);
  } finally {
    await upgrade.mf.dispose();
  }
}, 60000);

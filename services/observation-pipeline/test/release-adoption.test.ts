// Candidate results, comparison, adoption and rollback (design review D02/D03,
// AT65, A04; docs/release-adoption.md). The scenarios are the ones the review
// asks for: an old and a new Worker running at the same time, an expired lease
// during a candidate write, an interrupted comparison, an empty candidate
// result, a late-completing old version, an activation conflict, and a
// rollback that restores the exact previous result set.
//
// Every fixture is synthetic. The smbc-direct parsers are used because their
// inputs are small JSON documents; no provider data is involved.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { parseJob } from "../src/worker.ts";
import { candidateBatch } from "../src/release-adoption.ts";
import { inputFingerprint, releaseIdentity, releaseInsert } from "../src/releases.ts";
import {
  LEGACY_METADATA_RELEASE,
  type MetadataExtractorRelease,
} from "../src/metadata-extractors/index.ts";
import { layerBMigrations, seedArtifact, startPipeline } from "./harness.ts";
import {
  smbcDirectBalance,
  smbcDirectTransactions,
} from "../../../packages/parsers/src/parsers/smbc-direct.ts";

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

const PARSER = "smbc-direct-balance";
const SOURCE = "smbc-bank";
const DATASET = "balance-normalized";
const balance = { amount: 1, currency: "JPY", observedAt: "2026-09-07T00:00:00.000Z" };

const artifact = (id: number) =>
  seedArtifact(env, id, SOURCE, DATASET, "balance.normalized.json", balance);

async function registerRelease(
  version: string,
  extractor: MetadataExtractorRelease = LEGACY_METADATA_RELEASE,
) {
  const identity = await releaseIdentity({ name: PARSER, version }, extractor);
  await releaseInsert(
    env.DB,
    {
      parser: { name: PARSER, version },
      metadataExtractorRelease: extractor,
      ...identity,
    },
    "2026-09-07T00:00:00.000Z",
  ).run();
  return identity;
}

/** One parse attempt through the production path, optionally aimed at a
 * release, exactly as a replay plan's job would be. */
async function run(artifactId: number, version: string, targetRelease: string | null = null) {
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,target_release) VALUES(?,?,?,'pending',?)",
  )
    .bind(artifactId, PARSER, version, targetRelease)
    .run();
  return parseJob(
    env,
    {
      fetch_artifact_id: artifactId,
      parser_name: PARSER,
      parser_version: version,
      attempts: 0,
      target_release: targetRelease,
    },
    { ...smbcDirectBalance, version },
  );
}

const published = (artifactId: number) =>
  env.DB.prepare(
    "SELECT parse_run_id,publication_kind,release_id FROM published_parse_runs WHERE fetch_artifact_id=?",
  )
    .bind(artifactId)
    .first<{ parse_run_id: number; publication_kind: string; release_id: string | null }>();
const candidateRow = (parseRunId: number) =>
  env.DB.prepare(
    "SELECT release_id,state,fingerprint FROM parse_run_candidates WHERE parse_run_id=?",
  )
    .bind(parseRunId)
    .first<{ release_id: string; state: string; fingerprint: string }>();
const runRow = (id: number) =>
  env.DB.prepare(
    "SELECT id,status,parser_version,superseded_by_parse_run_id FROM parse_runs WHERE id=?",
  )
    .bind(id)
    .first<{
      id: number;
      status: string;
      parser_version: string;
      superseded_by_parse_run_id: number | null;
    }>();
const runIdAt = (artifactId: number, version: string) =>
  env.DB.prepare(
    "SELECT id FROM parse_runs WHERE fetch_artifact_id=? AND parser_name=? AND parser_version=? AND status='ok'",
  )
    .bind(artifactId, PARSER, version)
    .first<number>("id");
async function post(path: string, body: unknown) {
  const response = await mf.dispatchFetch(`https://pipeline.internal${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}
test("a candidate result is written like any parse and published like none", async () => {
  await artifact(200);
  expect(await run(200, "1.0.0")).toBe("parsed");
  const adopted = (await runIdAt(200, "1.0.0"))!;
  const candidateRelease = await registerRelease("2.0.0");
  expect(await run(200, "2.0.0", candidateRelease.releaseId)).toBe("parsed");
  const candidate = (await runIdAt(200, "2.0.0"))!;

  // The publication pointer never moved, and the candidate is marked as one.
  expect(await published(200)).toMatchObject({
    parse_run_id: adopted,
    publication_kind: "normal",
    release_id: null,
  });
  expect(await candidateRow(candidate)).toMatchObject({
    release_id: candidateRelease.releaseId,
    state: "candidate",
  });
  // Neither run supersedes the other: the candidate is not history, and the
  // adopted run is not replaced by something nobody approved.
  expect(await runRow(adopted)).toMatchObject({ superseded_by_parse_run_id: null, status: "ok" });
  expect(await runRow(candidate)).toMatchObject({
    superseded_by_parse_run_id: null,
    status: "ok",
  });
  // The operational view sees no gap; the raw legacy comparison is the audit
  // path where a candidate does show, and repair still refuses to publish it.
  expect(
    (
      await env.DB.prepare(
        "SELECT parse_run_id FROM publication_gate_gaps WHERE fetch_artifact_id=200",
      ).all<{ parse_run_id: number }>()
    ).results,
  ).toEqual([]);
  expect(
    (
      await env.DB.prepare(
        "SELECT parse_run_id,mismatch FROM publication_gate_mismatches WHERE fetch_artifact_id=200",
      ).all<{ parse_run_id: number; mismatch: string }>()
    ).results,
  ).toEqual([{ parse_run_id: candidate, mismatch: "legacy_only" }]);
  const repair = await post("/publication/repair", { actor: "operator-1", reason: "gap check" });
  expect(repair.json).toEqual({ repaired: 0, remaining: 0 });
  expect(await published(200)).toMatchObject({ parse_run_id: adopted });
}, 30000);

test("the input fingerprint is the manifest and the evidence, and it is stable", async () => {
  const adopted = (await runIdAt(200, "1.0.0"))!;
  const candidate = (await runIdAt(200, "2.0.0"))!;
  const references = (
    await env.DB.prepare(
      `SELECT r.parse_run_id,r.parser_release_id,r.input_fingerprint,p.extractor_release
        FROM parse_input_references r
        JOIN metadata_projections p ON p.id=r.metadata_projection_id
        WHERE r.parse_run_id IN (?1,?2) ORDER BY r.parse_run_id`,
    )
      .bind(adopted, candidate)
      .all<{
        parse_run_id: number;
        parser_release_id: string;
        input_fingerprint: string;
        extractor_release: string;
      }>()
  ).results;
  expect(references).toHaveLength(2);
  expect(references.every((row) => row.extractor_release === LEGACY_METADATA_RELEASE)).toBe(true);
  // Same evidence, different transform manifest (the semantic version is part
  // of it): the fingerprint distinguishes the two inputs.
  expect(references[0]!.input_fingerprint).not.toBe(references[1]!.input_fingerprint);
  expect(await candidateRow(candidate)).toMatchObject({
    fingerprint: references[1]!.input_fingerprint,
  });

  // Recomputing from the same manifest and the same evidence reproduces it.
  const sha = await env.DB.prepare("SELECT sha256 FROM fetch_artifacts WHERE id=200").first<string>(
    "sha256",
  );
  const identity = await releaseIdentity({ name: PARSER, version: "1.0.0" });
  const meta = {
    id: 200,
    sourceId: SOURCE,
    runStatus: "success" as const,
    runFailureCount: 0,
    dataset: DATASET,
    artifactKey: "balance.normalized.json",
    fetchUnitKey: null,
    statementState: null,
    period: null,
    url: null,
    mime: "application/json",
    fetchedAt: (await env.DB.prepare(
      "SELECT fetched_at FROM observation_fetch_artifacts WHERE id=200",
    ).first<string>("fetched_at"))!,
    sha256: sha!,
  };
  const recomputed = await inputFingerprint({
    rawSha256: sha!,
    meta,
    manifestDigest: identity.manifestDigest,
  });
  expect(recomputed).toBe(references[0]!.input_fingerprint);
  expect(
    await inputFingerprint({ rawSha256: sha!, meta, manifestDigest: identity.manifestDigest }),
  ).toBe(recomputed);
  expect((await releaseIdentity({ name: PARSER, version: "1.0.0" })).releaseId).toBe(
    identity.releaseId,
  );
}, 30000);

test("a candidate write whose lease expired records nothing at all", async () => {
  await artifact(201);
  expect(await run(201, "1.0.0")).toBe("parsed");
  const release = await registerRelease("2.0.0");
  const pending = await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(201,?,'2.0.0','2026-09-08T00:00:00.000Z','pending','[]') RETURNING id",
  )
    .bind(PARSER)
    .first<{ id: number }>();
  await env.DB.prepare(
    "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,lease_token,lease_until_ms) VALUES(201,?,'2.0.0','running','expired-candidate',?)",
  )
    .bind(PARSER, Date.now() - 1)
    .run();
  const input = {
    parseId: pending!.id,
    token: "expired-candidate",
    releaseId: release.releaseId,
    fingerprint: "f".repeat(64),
    createdAt: "2026-09-08T00:00:00.000Z",
    now: Date.now(),
  };
  const expired = await env.DB.batch(candidateBatch(env.DB, input));
  expect(expired[0]?.meta.changes).toBe(0);
  expect(await runRow(pending!.id)).toMatchObject({ status: "pending" });
  expect(await candidateRow(pending!.id)).toBeNull();
  // The control: the same batch with a live lease records the candidate and
  // still leaves the publication pointer where it was.
  const adopted = (await runIdAt(201, "1.0.0"))!;
  await env.DB.prepare(
    "UPDATE observation_parse_jobs SET lease_until_ms=? WHERE lease_token='expired-candidate'",
  )
    .bind(Date.now() + 60_000)
    .run();
  const live = await env.DB.batch(candidateBatch(env.DB, { ...input, now: Date.now() }));
  expect(live[0]?.meta.changes).toBe(1);
  expect(await candidateRow(pending!.id)).toMatchObject({ state: "candidate" });
  expect(await published(201)).toMatchObject({ parse_run_id: adopted });
}, 30000);

test("a late-completing older version is superseded by the adopted run, never by a candidate", async () => {
  await artifact(202);
  expect(await run(202, "1.0.0")).toBe("parsed");
  const adopted = (await runIdAt(202, "1.0.0"))!;
  const release = await registerRelease("2.0.0");
  expect(await run(202, "2.0.0", release.releaseId)).toBe("parsed");
  const candidate = (await runIdAt(202, "2.0.0"))!;
  // An older version finishing late: it is born superseded by the run readers
  // actually use, not by the unapproved candidate at the higher version.
  expect(await run(202, "0.9.0")).toBe("parsed");
  const late = (await runIdAt(202, "0.9.0"))!;
  expect(await runRow(late)).toMatchObject({ superseded_by_parse_run_id: adopted });
  expect(await published(202)).toMatchObject({ parse_run_id: adopted });
  expect(await runRow(candidate)).toMatchObject({ superseded_by_parse_run_id: null });
  expect(await candidateRow(candidate)).toMatchObject({ state: "candidate" });
}, 30000);

test("a Worker that predates the gate supersedes a candidate, which is why rolling back past it is refused", async () => {
  await artifact(203);
  expect(await run(203, "1.0.0")).toBe("parsed");
  const release = await registerRelease("2.0.0");
  expect(await run(203, "2.0.0", release.releaseId)).toBe("parsed");
  const candidate = (await runIdAt(203, "2.0.0"))!;
  // The pre-gate publish transaction, verbatim: no projection, and a
  // supersession statement that does not know about candidates.
  const old = await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(203,?,'3.0.0','2026-09-08T00:00:00.000Z','ok','[]') RETURNING id",
  )
    .bind(PARSER)
    .first<{ id: number }>();
  await env.DB.prepare(
    `UPDATE parse_runs SET superseded_by_parse_run_id=? WHERE fetch_artifact_id=203 AND parser_name=? AND id<>? AND status='ok' AND superseded_by_parse_run_id IS NULL`,
  )
    .bind(old!.id, PARSER, old!.id)
    .run();
  // This is the documented hazard, asserted rather than assumed: an old writer
  // turns a candidate into replaced history, where normal history reads show
  // it. docs/publication-gate.md therefore forbids rolling back to a build
  // that predates the gate once candidates are enabled.
  expect(await runRow(candidate)).toMatchObject({ superseded_by_parse_run_id: old!.id });
  // The new writer, running at the same time on another artifact, is
  // unaffected and keeps its own projection correct.
  await artifact(204);
  expect(await run(204, "1.0.0")).toBe("parsed");
  expect(await published(204)).toMatchObject({ parse_run_id: await runIdAt(204, "1.0.0") });
}, 30000);

test("comparison, adoption and rollback keep the visible result set exactly reproducible", async () => {
  // Its own store: comparison and activation are dataset-scoped, so the
  // scenario must not see candidates other tests left in the same dataset.
  const scope = await startPipeline(layerBMigrations(), { RELEASE_CANDIDATES_ENABLED: "true" });
  try {
    const db = scope.env.DB;
    const local = {
      artifact: (id: number) =>
        seedArtifact(scope.env, id, SOURCE, DATASET, "balance.normalized.json", balance),
      run: async (artifactId: number, version: string, target: string | null = null) => {
        await db
          .prepare(
            "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,target_release) VALUES(?,?,?,'pending',?)",
          )
          .bind(artifactId, PARSER, version, target)
          .run();
        return parseJob(
          scope.env,
          {
            fetch_artifact_id: artifactId,
            parser_name: PARSER,
            parser_version: version,
            attempts: 0,
            target_release: target,
          },
          { ...smbcDirectBalance, version },
        );
      },
      register: async (version: string) => {
        const identity = await releaseIdentity({ name: PARSER, version });
        await releaseInsert(
          db,
          {
            parser: { name: PARSER, version },
            metadataExtractorRelease: LEGACY_METADATA_RELEASE,
            ...identity,
          },
          "2026-09-07T00:00:00.000Z",
        ).run();
        return identity;
      },
      runId: (artifactId: number, version: string) =>
        db
          .prepare(
            "SELECT id FROM parse_runs WHERE fetch_artifact_id=? AND parser_version=? AND status='ok'",
          )
          .bind(artifactId, version)
          .first<number>("id"),
      pointer: (artifactId: number) =>
        db
          .prepare(
            "SELECT parse_run_id,publication_kind,release_id FROM published_parse_runs WHERE fetch_artifact_id=?",
          )
          .bind(artifactId)
          .first<Record<string, unknown>>(),
      /** Every balance observation a gated reader sees, in id order. */
      visible: async () =>
        (
          await db
            .prepare(
              `SELECT b.id,b.parse_run_id,b.source_account,b.metric,b.amount_minor,b.instrument
                FROM balance_observations b JOIN published_parse_runs x ON x.parse_run_id=b.parse_run_id
                ORDER BY b.id`,
            )
            .all<Record<string, unknown>>()
        ).results,
      post: async (path: string, body: unknown) => {
        const response = await scope.mf.dispatchFetch(`https://pipeline.internal${path}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
        return { status: response.status, json: (await response.json()) as Record<string, any> };
      },
    };
    const target = { source: SOURCE, dataset: DATASET, parser: PARSER };

    await local.artifact(210);
    await local.artifact(211);
    for (const id of [210, 211]) expect(await local.run(id, "1.0.0")).toBe("parsed");
    const before = await local.visible();
    expect(before).toHaveLength(2);
    const baseRuns = [await local.runId(210, "1.0.0"), await local.runId(211, "1.0.0")];

    const candidateRelease = await local.register("2.0.0");
    // An interrupted comparison: computed with only one artifact re-parsed,
    // then recomputed once the second candidate exists. Both are kept.
    expect(await local.run(210, "2.0.0", candidateRelease.releaseId)).toBe("parsed");
    const partial = await local.post("/release/compare", {
      ...target,
      releaseId: candidateRelease.releaseId,
    });
    expect(partial.status).toBe(200);
    expect(partial.json.artifacts).toEqual({
      base: 2,
      candidate: 1,
      compared: 1,
      candidateOnly: 0,
    });
    expect(await local.visible()).toEqual(before);
    expect(await local.run(211, "2.0.0", candidateRelease.releaseId)).toBe("parsed");
    const complete = await local.post("/release/compare", {
      ...target,
      releaseId: candidateRelease.releaseId,
    });
    expect(complete.json.artifacts).toEqual({
      base: 2,
      candidate: 2,
      compared: 2,
      candidateOnly: 0,
    });
    // Identical parsers over identical evidence: every locator matches on the
    // contract's comparison key and no exact value differs.
    expect(complete.json.countsByKind).toEqual([{ kind: "balance", base: 2, candidate: 2 }]);
    expect(complete.json.locators).toEqual({
      matched: 2,
      baseOnly: 0,
      candidateOnly: 0,
      ambiguous: 0,
    });
    expect(complete.json.values).toEqual({ compared: 2, differing: 0, missingOnOneSide: 0 });
    expect(complete.json.coverage).toEqual({ baseClaims: 2, candidateClaims: 2, differing: 0 });
    expect(complete.json.emptyContainers).toEqual({
      baseEmptyCandidateNot: 0,
      candidateEmptyBaseNot: 0,
    });
    expect(complete.json.sample).toEqual([]);
    // No financial value leaves the route: only counts, ids and locators.
    expect(JSON.stringify(complete.json)).not.toMatch(/amount|coefficient|JPY/u);
    expect(complete.json.comparisonId).toBeGreaterThan(partial.json.comparisonId);
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM release_comparisons WHERE candidate_release_id=?")
        .bind(candidateRelease.releaseId)
        .first<number>("n"),
    ).toBe(2);

    // An activation naming the wrong current release is refused, and nothing
    // changes.
    const conflict = await local.post("/release/activate", {
      ...target,
      releaseId: candidateRelease.releaseId,
      expectedActiveReleaseId: "smbc-direct-balance-9.9.9-0000000000000000",
      actor: "operator-1",
      reason: "wrong expectation",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toEqual({ error: "release_activation_conflict" });
    expect(await local.visible()).toEqual(before);
    expect(
      await db.prepare("SELECT count(*) AS n FROM release_activation_events").first<number>("n"),
    ).toBe(0);

    const activated = await local.post("/release/activate", {
      ...target,
      releaseId: candidateRelease.releaseId,
      expectedActiveReleaseId: null,
      actor: "operator-1",
      reason: "adopt candidate",
    });
    expect(activated.status).toBe(200);
    expect(activated.json).toMatchObject({ kind: "activate", changed: true, pointersMoved: 2 });
    const after = await local.visible();
    expect(after).not.toEqual(before);
    expect(after.map((row) => row.parse_run_id)).toEqual([
      await local.runId(210, "2.0.0"),
      await local.runId(211, "2.0.0"),
    ]);
    expect(await local.pointer(210)).toMatchObject({
      publication_kind: "activation",
      release_id: candidateRelease.releaseId,
    });
    expect(
      (
        await db
          .prepare("SELECT state FROM parse_run_candidates WHERE release_id=?")
          .bind(candidateRelease.releaseId)
          .all<{ state: string }>()
      ).results.map((row) => row.state),
    ).toEqual(["adopted", "adopted"]);
    // Repeating the identical command is idempotent and writes nothing new.
    const repeat = await local.post("/release/activate", {
      ...target,
      releaseId: candidateRelease.releaseId,
      expectedActiveReleaseId: null,
      actor: "operator-1",
      reason: "adopt candidate",
    });
    expect(repeat.json).toMatchObject({ changed: false, pointersMoved: 0 });
    expect(await local.visible()).toEqual(after);

    // Rollback: each key goes back to the run its activation replaced, and the
    // visible set is exactly the one from before the activation.
    const baseRelease = await releaseIdentity({ name: PARSER, version: "1.0.0" });
    const rolled = await local.post("/release/rollback", {
      ...target,
      releaseId: baseRelease.releaseId,
      expectedActiveReleaseId: candidateRelease.releaseId,
      actor: "operator-1",
      reason: "regression found",
    });
    expect(rolled.status).toBe(200);
    expect(rolled.json).toMatchObject({ kind: "rollback", changed: true, retained: 0 });
    expect(await local.visible()).toEqual(before);
    expect(await local.pointer(210)).toMatchObject({
      parse_run_id: baseRuns[0]!,
      publication_kind: "rollback",
    });
    // Nothing was un-written: every run is still ok and still unsuperseded.
    for (const id of [baseRuns[0]!, baseRuns[1]!, (await local.runId(210, "2.0.0"))!])
      expect(
        await db
          .prepare(
            "SELECT status,superseded_by_parse_run_id AS superseded FROM parse_runs WHERE id=?",
          )
          .bind(id)
          .first<Record<string, unknown>>(),
      ).toEqual({ status: "ok", superseded: null });
    expect(
      (
        await db
          .prepare("SELECT kind,count(*) AS n FROM publication_events GROUP BY kind ORDER BY kind")
          .all<{ kind: string; n: number }>()
      ).results,
    ).toEqual([
      { kind: "activation", n: 2 },
      { kind: "normal", n: 2 },
      { kind: "rollback", n: 2 },
    ]);
    expect(
      (
        await db
          .prepare(
            "SELECT kind,previous_release_id,new_release_id,actor,expected_previous,pointers_moved FROM release_activation_events ORDER BY id",
          )
          .all<Record<string, unknown>>()
      ).results,
    ).toEqual([
      {
        kind: "activate",
        previous_release_id: null,
        new_release_id: candidateRelease.releaseId,
        actor: "operator-1",
        expected_previous: null,
        pointers_moved: 2,
      },
      {
        kind: "rollback",
        previous_release_id: candidateRelease.releaseId,
        new_release_id: baseRelease.releaseId,
        actor: "operator-1",
        expected_previous: candidateRelease.releaseId,
        pointers_moved: 2,
      },
    ]);
    const status = await scope.mf.dispatchFetch("https://pipeline.internal/release/status");
    const body = (await status.json()) as Record<string, any>;
    expect(body.active).toEqual([
      expect.objectContaining({
        source_id: SOURCE,
        dataset: DATASET,
        parser_name: PARSER,
        release_id: baseRelease.releaseId,
      }),
    ]);
  } finally {
    await scope.mf.dispose();
  }
}, 60000);

test("an empty candidate result is a result: it compares as empty and activates nothing", async () => {
  const emptyParser = "smbc-direct-transactions";
  const emptyDataset = "transactions-normalized";
  const payload = {
    range: { start: "2026-09-01", end: "2026-09-07" },
    transactions: [],
    depositsTotal: 0,
    withdrawalsTotal: 0,
  };
  await seedArtifact(
    env,
    220,
    SOURCE,
    emptyDataset,
    "transactions/20260901-20260907.normalized.json",
    payload,
  );
  const normal = async (version: string, targetRelease: string | null) => {
    await env.DB.prepare(
      "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,target_release) VALUES(220,?,?,'pending',?)",
    )
      .bind(emptyParser, version, targetRelease)
      .run();
    return parseJob(
      env,
      {
        fetch_artifact_id: 220,
        parser_name: emptyParser,
        parser_version: version,
        attempts: 0,
        target_release: targetRelease,
      },
      { ...smbcDirectTransactions, version },
    );
  };
  expect(await normal("1.0.0", null)).toBe("parsed");
  const identity = await releaseIdentity({ name: emptyParser, version: "2.0.0" });
  await releaseInsert(
    env.DB,
    {
      parser: { name: emptyParser, version: "2.0.0" },
      metadataExtractorRelease: LEGACY_METADATA_RELEASE,
      ...identity,
    },
    "2026-09-07T00:00:00.000Z",
  ).run();
  expect(await normal("2.0.0", identity.releaseId)).toBe("parsed");
  const comparison = await post("/release/compare", {
    source: SOURCE,
    dataset: emptyDataset,
    parser: emptyParser,
    releaseId: identity.releaseId,
  });
  // Both sides produced no observation: no locator, no value difference, and
  // no empty-container difference either, because neither side is empty
  // relative to the other.
  expect(comparison.json.artifacts).toMatchObject({ compared: 1 });
  expect(comparison.json.countsByKind).toEqual([]);
  expect(comparison.json.locators).toEqual({
    matched: 0,
    baseOnly: 0,
    candidateOnly: 0,
    ambiguous: 0,
  });
  expect(comparison.json.emptyContainers).toEqual({
    baseEmptyCandidateNot: 0,
    candidateEmptyBaseNot: 0,
  });
  // A comparison of a release with no candidate run at all is still a valid,
  // recorded summary, and activating it moves no pointer.
  const unusedRelease = await releaseIdentity({ name: emptyParser, version: "3.0.0" });
  await releaseInsert(
    env.DB,
    {
      parser: { name: emptyParser, version: "3.0.0" },
      metadataExtractorRelease: LEGACY_METADATA_RELEASE,
      ...unusedRelease,
    },
    "2026-09-07T00:00:00.000Z",
  ).run();
  const emptyComparison = await post("/release/compare", {
    source: SOURCE,
    dataset: emptyDataset,
    parser: emptyParser,
    releaseId: unusedRelease.releaseId,
  });
  expect(emptyComparison.json.artifacts).toMatchObject({ candidate: 0, compared: 0 });
  const activation = await post("/release/activate", {
    source: SOURCE,
    dataset: emptyDataset,
    parser: emptyParser,
    releaseId: unusedRelease.releaseId,
    expectedActiveReleaseId: null,
    actor: "operator-1",
    reason: "nothing to adopt",
  });
  expect(activation.json).toMatchObject({ changed: true, pointersMoved: 0 });
  expect(
    await env.DB.prepare(
      "SELECT parse_run_id FROM published_parse_runs WHERE fetch_artifact_id=220",
    ).first<number>("parse_run_id"),
  ).toBe(
    (await env.DB.prepare(
      "SELECT id FROM parse_runs WHERE fetch_artifact_id=220 AND parser_version='1.0.0' AND status='ok'",
    ).first<number>("id"))!,
  );
}, 60000);

test("registering the same parser version with a different transform is refused", async () => {
  const identity = await releaseIdentity({ name: PARSER, version: "1.0.0" });
  await expect(
    env.DB.prepare(
      `INSERT INTO parser_releases(release_id,parser_name,semantic_version,code_digest,
        input_contract_version,output_contract_version,metadata_extractor_release,
        dependency_digests_json,registered_at)
       VALUES('smbc-direct-balance-1.0.0-forged',?,'1.0.0','deadbeef','artifact-meta-v1','parse-result-v2',?,'{}','2026-09-07T00:00:00.000Z')`,
    )
      .bind(PARSER, LEGACY_METADATA_RELEASE)
      .run(),
  ).rejects.toThrow(/code digest changed without a version change/u);
  // The same code registered under a second metadata extractor release is a
  // different release, not a conflict.
  const reextracted = await registerRelease("1.0.0", "manifest-metadata-v2");
  expect(reextracted.releaseId).not.toBe(identity.releaseId);
  expect(reextracted.manifest.metadataExtractorRelease).toBe("manifest-metadata-v2");
  // Registering an undeployed version through the route is refused.
  const refused = await post("/release/register", { parser: PARSER, version: "9.9.9" });
  expect(refused.status).toBe(400);
  expect(refused.json).toEqual({ error: "parser_not_deployed" });
}, 30000);

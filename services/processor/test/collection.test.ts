// Shared-R2 terminal consumption (unified plan 03, U08).
//
// Acceptance rows G1-04, G1-05, G1-06, G1-10, G1-11, G1-12, G1-13, G1-14 and
// G1-15 are each named in a test below. Everything is synthetic: the source is
// `kogane-synthetic`, which the financial views already exclude, and no
// amount, account, credential or provider text appears anywhere.
import { expect, test } from "bun:test";
import {
  collectionScan,
  handleTerminalNotification,
  registerCollectionRun,
  sharedR2IngestEnabled,
} from "../src/collection/index.ts";
import { parseTerminalNotification } from "../src/collection/notifications.ts";
import {
  ACCOUNT_ID,
  artifact,
  collectionHarness,
  DATA_BUCKET,
  notification,
  persistSyntheticRun,
  rows,
  SOURCE,
  type CollectionHarness,
} from "./collection-harness.ts";
import { objectKey, terminalKey } from "../../../packages/collection/src/keys.ts";

interface RunRow {
  id: number;
  run_id: string;
  terminal_digest: string;
  blocked_code: string | null;
  fetch_run_id: number | null;
  registered_at: string | null;
  provider_outcome: string | null;
  coverage_status: string | null;
}
interface StageRow {
  stage: string;
  state: string;
  failure_code: string | null;
  evidence_ref: string | null;
}

const collectionRuns = (h: CollectionHarness) =>
  rows<RunRow>(h.db, "SELECT * FROM collection_runs ORDER BY id");
const stages = (h: CollectionHarness, id: number) =>
  rows<StageRow>(
    h.db,
    "SELECT stage,state,failure_code,evidence_ref FROM collection_run_stages WHERE collection_run_id=? ORDER BY id",
    id,
  );
const countOf = (h: CollectionHarness, sql: string): number =>
  (h.db.query(sql).get() as { n: number }).n;

test("the flag is off unless it is set, and an off lane is not a completed scan", async () => {
  const harness = collectionHarness({ SHARED_R2_INGEST_ENABLED: "false" });
  expect(sharedR2IngestEnabled(undefined)).toBe(false);
  expect(sharedR2IngestEnabled("")).toBe(false);
  expect(sharedR2IngestEnabled("yes")).toBe(false);
  expect(sharedR2IngestEnabled("1")).toBe(true);
  expect(sharedR2IngestEnabled("true")).toBe(true);
  await persistSyntheticRun(harness);
  const summary = await collectionScan(harness.env);
  expect(summary).toMatchObject({ enabled: false, status: "skipped", listed: 0 });
  expect(collectionRuns(harness)).toEqual([]);
  // The cursor did not move either: a flag being off is not progress.
  expect(countOf(harness, "SELECT pages_completed AS n FROM collection_scan_state")).toBe(0);
  expect(
    await handleTerminalNotification(harness.env, { body: notification(SOURCE, "run-001") }),
  ).toEqual({ outcome: "flag_off" });
});

test("a persisted run registers into CORE and is sealed (G1-10)", async () => {
  const harness = collectionHarness();
  const plan = await persistSyntheticRun(harness);
  const result = await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-001" });
  expect(result).toMatchObject({ outcome: "registered", artifacts: 2 });
  if (result.outcome !== "registered") throw new Error("unreachable");

  // The run, its report, both artifacts, its inventory and its seal.
  expect(countOf(harness, `SELECT count(*) AS n FROM fetch_runs`)).toBe(1);
  expect(countOf(harness, `SELECT count(*) AS n FROM fetch_artifacts WHERE fetch_run_id=1`)).toBe(
    2,
  );
  expect(countOf(harness, `SELECT count(*) AS n FROM fetch_run_seals WHERE fetch_run_id=1`)).toBe(
    1,
  );
  expect(
    countOf(
      harness,
      `SELECT count(*) AS n FROM fetch_run_reports WHERE fetch_run_id=1 AND report_kind='terminal'`,
    ),
  ).toBe(1);
  // The stored objects are the collector's, byte for byte: CORE points at the
  // same content-addressed keys the terminal named.
  const stored = rows<{ blob_key: string; sha256: string }>(
    harness.db,
    "SELECT sha256,blob_key FROM raw_objects ORDER BY sha256",
  );
  expect(stored.map((row) => row.blob_key).sort()).toEqual(
    plan.artifacts.map((entry) => objectKey(entry.sha256)).sort(),
  );

  const [row] = collectionRuns(harness);
  expect(row).toMatchObject({
    run_id: "run-001",
    blocked_code: null,
    fetch_run_id: result.fetchRunId,
    provider_outcome: "success",
  });
  expect(row!.registered_at).not.toBeNull();
  expect(stages(harness, row!.id)).toEqual([
    {
      stage: "persisted",
      state: "completed",
      failure_code: null,
      evidence_ref: row!.terminal_digest,
    },
    {
      stage: "registered",
      state: "completed",
      failure_code: null,
      evidence_ref: String(result.fetchRunId),
    },
  ]);
});

test("registration writes no bytes to the shared bucket (G1-15)", async () => {
  const harness = collectionHarness();
  await persistSyntheticRun(harness);
  // Everything the collector wrote, and nothing else may follow.
  const afterPersist = [...harness.bucket.putKeys];
  expect(afterPersist).toContain(terminalKey(SOURCE, "run-001"));

  await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-001" });
  expect(harness.bucket.putKeys).toEqual(afterPersist);
  // A second registration of the same run is a no-op and still writes nothing.
  await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-001" });
  expect(harness.bucket.putKeys).toEqual(afterPersist);
  // The contract has no copy operation at all, so there is none to call.
  expect("copy" in harness.bucket).toBe(false);
});

test("the same terminal delivered twice registers once (G1-05, G1-11)", async () => {
  const harness = collectionHarness();
  await persistSyntheticRun(harness);
  const message = { body: notification(SOURCE, "run-001") };
  expect(await handleTerminalNotification(harness.env, message)).toEqual({
    outcome: "registered",
  });
  // The response to the first delivery was lost; the queue redelivers it.
  expect(await handleTerminalNotification(harness.env, message)).toEqual({
    outcome: "already_registered",
  });
  expect(await handleTerminalNotification(harness.env, message)).toEqual({
    outcome: "already_registered",
  });
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_runs")).toBe(1);
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(1);
  expect(collectionRuns(harness)).toHaveLength(1);
  // One `registered` completion, not one per delivery.
  expect(
    countOf(
      harness,
      "SELECT count(*) AS n FROM collection_run_stages WHERE stage='registered' AND state='completed'",
    ),
  ).toBe(1);
});

test("a lost notification is recovered by the scan without re-fetching (G1-04)", async () => {
  const harness = collectionHarness();
  await persistSyntheticRun(harness);
  // The collector finished and the notification never arrived: nothing in
  // CORE, and the bytes are already in the bucket.
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_runs")).toBe(0);
  const before = [...harness.bucket.putKeys];

  const summary = await collectionScan(harness.env);
  expect(summary).toMatchObject({ status: "scanned", listed: 1, registered: 1 });
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(1);
  // Recovery read the bucket; it did not ask the provider for anything, and
  // it did not write a byte.
  expect(harness.bucket.putKeys).toEqual(before);
});

test("a run whose terminal is confirmed late is found without a max-timestamp (G1-12)", async () => {
  const harness = collectionHarness();
  // A newer run finishes and registers first.
  await persistSyntheticRun(harness, { run: { runId: "run-900" } });
  await collectionScan(harness.env);
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_runs")).toBe(1);

  // Only now does the older run's terminal land. Its id sorts *before* the
  // one already handled and its timestamps are older, so a watermark or a
  // "since the last success" window would step straight over it.
  await persistSyntheticRun(harness, {
    run: {
      runId: "run-100",
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:30.000Z",
    },
  });
  const summary = await collectionScan(harness.env);
  expect(summary).toMatchObject({ listed: 2, registered: 1, alreadyRegistered: 1 });
  expect(
    rows<{ source_run_key: string }>(
      harness.db,
      "SELECT source_run_key FROM fetch_runs ORDER BY source_run_key",
    ).map((row) => row.source_run_key.split(":")[0]),
  ).toEqual(["run-100", "run-900"]);
});

test("a second manifest under the same run id is a conflict (G1-06)", async () => {
  const harness = collectionHarness();
  await persistSyntheticRun(harness);
  await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-001" });
  const registered = collectionRuns(harness)[0]!;

  // A different collector attempt overwrites the terminal with a different
  // manifest. `persistRun` refuses that, so the only way it happens is a
  // writer that does not use the contract; the Processor must still not
  // merge the two.
  const replacement = await artifact("other.json", '{"synthetic":"other"}');
  await harness.bucket.seed(objectKey(replacement.sha256), new TextEncoder().encode("x"));
  const conflicting = await persistSyntheticRun(harness, {
    run: { runId: "run-002", attemptId: "attempt-002" },
  });
  // Move the second run's terminal on top of the first run's key by hand.
  const second = await harness.bucket.get(terminalKey(SOURCE, "run-002"));
  const bytes = new Uint8Array(await second!.arrayBuffer());
  const text = new TextDecoder().decode(bytes).replaceAll("run-002", "run-001");
  harness.bucket.entries.delete(terminalKey(SOURCE, "run-001"));
  await harness.bucket.seed(terminalKey(SOURCE, "run-001"), new TextEncoder().encode(text), {
    contentType: "application/json",
  });
  expect(conflicting.run.runId).toBe("run-002");

  const result = await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-001" });
  expect(result).toMatchObject({ outcome: "blocked", code: "terminal_digest_conflict" });
  // The first registration is untouched: no second fetch run, no re-pointing.
  const all = collectionRuns(harness);
  expect(all).toHaveLength(2);
  expect(all.find((row) => row.id === registered.id)).toMatchObject({
    blocked_code: null,
    fetch_run_id: registered.fetch_run_id,
  });
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_runs")).toBe(1);
});

test("a missing or resized referenced object never seals and records why (G1-14)", async () => {
  const harness = collectionHarness();
  const plan = await persistSyntheticRun(harness);
  // The object the terminal names is gone from the bucket.
  const missing = objectKey(plan.artifacts[0]!.sha256);
  harness.bucket.entries.delete(missing);

  const result = await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-001" });
  expect(result).toMatchObject({ outcome: "blocked", code: "object_missing" });
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(0);
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_runs")).toBe(0);
  const row = collectionRuns(harness)[0]!;
  expect(row.blocked_code).toBe("object_missing");
  expect(stages(harness, row.id).at(-1)).toMatchObject({
    stage: "registered",
    state: "blocked",
    failure_code: "object_missing",
  });

  // The same check catches a size that disagrees with the manifest.
  const other = collectionHarness();
  const otherPlan = await persistSyntheticRun(other);
  const key = objectKey(otherPlan.artifacts[1]!.sha256);
  other.bucket.entries.delete(key);
  await other.bucket.seed(key, new TextEncoder().encode("short"), {
    customMetadata: { sha256: otherPlan.artifacts[1]!.sha256, byteSize: "5" },
  });
  expect(
    await registerCollectionRun(other.env, { source: SOURCE, runId: "run-001" }),
  ).toMatchObject({ outcome: "blocked", code: "object_size_mismatch" });
  expect(countOf(other, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(0);
});

test("a corrupt terminal is blocked and the scan keeps going (G1-13)", async () => {
  const harness = collectionHarness();
  await persistSyntheticRun(harness, { run: { runId: "run-050" } });
  await persistSyntheticRun(harness, { run: { runId: "run-100" } });
  // Whatever wrote it, the terminal of the first run is not a manifest.
  harness.bucket.entries.delete(terminalKey(SOURCE, "run-050"));
  await harness.bucket.seed(terminalKey(SOURCE, "run-050"), new TextEncoder().encode("{not json"), {
    contentType: "application/json",
  });

  const summary = await collectionScan(harness.env);
  expect(summary).toMatchObject({ listed: 2, blocked: 1, registered: 1 });
  const blocked = collectionRuns(harness).find((row) => row.run_id === "run-050")!;
  expect(blocked.blocked_code).toBe("terminal_not_json");
  // An unvalidated terminal has no provider outcome: the corruption is not
  // evidence about what the provider returned.
  expect(blocked.provider_outcome).toBeNull();
  expect(blocked.coverage_status).toBeNull();
  expect(stages(harness, blocked.id)).toEqual([
    {
      stage: "persisted",
      state: "blocked",
      failure_code: "terminal_not_json",
      evidence_ref: null,
    },
  ]);
  // The later run registered on the same page.
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(1);

  // A second sweep does not create a second record for the same bad bytes.
  await collectionScan(harness.env);
  expect(collectionRuns(harness).filter((row) => row.run_id === "run-050")).toHaveLength(1);
});

test("a half-registered run stays unsealed and the next tick finishes it (G1-10)", async () => {
  const harness = collectionHarness();
  await persistSyntheticRun(harness, {
    artifacts: [
      await artifact("a.json", '{"synthetic":"a"}'),
      await artifact("b.json", '{"synthetic":"b"}'),
      await artifact("c.json", '{"synthetic":"c"}'),
    ],
  });
  // One artifact per call: the budget runs out before the run can be sealed.
  const first = await registerCollectionRun(
    harness.env,
    { source: SOURCE, runId: "run-001" },
    { artifactBudget: 1 },
  );
  expect(first).toMatchObject({ outcome: "pending", catalogued: 1, artifacts: 3 });
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(0);
  // The partial run exists but is not sealed, so no normal reader sees it.
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_runs")).toBe(1);
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_artifacts WHERE fetch_run_id=1")).toBe(
    1,
  );

  // The same budget again: the artifact already catalogued is skipped, not
  // re-adopted as a no-op that spends the budget, so the run converges over
  // as many ticks as it needs instead of re-cataloguing its first page
  // forever (03 §6: "only what is missing").
  const second = await registerCollectionRun(
    harness.env,
    { source: SOURCE, runId: "run-001" },
    { artifactBudget: 1 },
  );
  expect(second).toMatchObject({ outcome: "pending", catalogued: 2, artifacts: 3 });
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_artifacts WHERE fetch_run_id=1")).toBe(
    2,
  );
  const done = await registerCollectionRun(
    harness.env,
    { source: SOURCE, runId: "run-001" },
    { artifactBudget: 1 },
  );
  expect(done.outcome).toBe("registered");
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_runs")).toBe(1);
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_artifacts WHERE fetch_run_id=1")).toBe(
    3,
  );
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(1);
});

test("the scan walks the whole prefix in bounded pages and starts over", async () => {
  const harness = collectionHarness();
  for (const runId of ["run-001", "run-002", "run-003"]) {
    await persistSyntheticRun(harness, { run: { runId } });
  }
  const first = await collectionScan(harness.env, { pageLimit: 2 });
  expect(first).toMatchObject({ listed: 2, registered: 2, cycleComplete: false });
  const second = await collectionScan(harness.env, { pageLimit: 2 });
  expect(second).toMatchObject({ listed: 1, registered: 1, cycleComplete: true });
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(3);

  // A finished walk restarts from the beginning of the prefix, which is what
  // makes a terminal confirmed late reachable at all (G1-12).
  expect(countOf(harness, "SELECT cycles_completed AS n FROM collection_scan_state")).toBe(1);
  expect(
    (
      harness.db.query("SELECT cursor FROM collection_scan_state").get() as {
        cursor: string | null;
      }
    ).cursor,
  ).toBeNull();
  const third = await collectionScan(harness.env, { pageLimit: 2 });
  expect(third).toMatchObject({ listed: 2, alreadyRegistered: 2, registered: 0 });
});

test("a tick that spends its budget leaves the cursor where it was", async () => {
  const harness = collectionHarness();
  for (const runId of ["run-001", "run-002", "run-003"]) {
    await persistSyntheticRun(harness, { run: { runId } });
  }
  const first = await collectionScan(harness.env, { pageLimit: 3, maxRegistrations: 1 });
  expect(first).toMatchObject({ listed: 3, registered: 1, budgetExhausted: true });
  expect(
    (
      harness.db.query("SELECT cursor FROM collection_scan_state").get() as {
        cursor: string | null;
      }
    ).cursor,
  ).toBeNull();
  // The same page again: the finished run costs a query, the rest progress.
  await collectionScan(harness.env, { pageLimit: 3, maxRegistrations: 1 });
  await collectionScan(harness.env, { pageLimit: 3, maxRegistrations: 1 });
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(3);
});

test("a notification is only believed for this account, this bucket and a terminal key", () => {
  const context = { accountId: ACCOUNT_ID, bucket: DATA_BUCKET };
  expect(parseTerminalNotification(notification(SOURCE, "run-001"), context)).toEqual({
    outcome: "terminal",
    notification: {
      source: SOURCE,
      runId: "run-001",
      key: terminalKey(SOURCE, "run-001"),
    },
  });
  // Another account's message is not a fact about this bucket.
  expect(() =>
    parseTerminalNotification(
      notification(SOURCE, "run-001", { account: "f".repeat(32) }),
      context,
    ),
  ).toThrow("notification_account_mismatch");
  expect(() =>
    parseTerminalNotification(notification(SOURCE, "run-001", { bucket: "other" }), context),
  ).toThrow("notification_bucket_mismatch");
  // Every object of the bucket is notified; only terminals mean anything.
  expect(
    parseTerminalNotification(
      { ...notification(SOURCE, "run-001"), object: { key: "objects/ab/x", size: 1, eTag: "e" } },
      context,
    ),
  ).toEqual({ outcome: "ignored", reason: "not_a_terminal" });
  expect(
    parseTerminalNotification(notification(SOURCE, "run-001", { action: "DeleteObject" }), context),
  ).toEqual({ outcome: "ignored", reason: "not_a_create" });
  expect(() => parseTerminalNotification({ nonsense: true }, context)).toThrow(
    "notification_invalid",
  );
  // A deployment that was never told its account believes nothing.
  expect(() =>
    parseTerminalNotification(notification(SOURCE, "run-001"), { accountId: "", bucket: "x" }),
  ).toThrow("notification_account_unconfigured");
});

test("a partial acquisition is registered as partial, never widened", async () => {
  const harness = collectionHarness();
  await persistSyntheticRun(harness, {
    run: {
      providerOutcome: "partial",
      coverageStatus: "partial",
      safeErrorCode: "page_limit_reached",
      units: [
        {
          unitKey: "unit-a",
          unitKind: "account",
          artifactCount: 1,
          coverageStatus: "partial",
          safeErrorCode: "page_limit_reached",
        },
      ],
    },
    artifacts: [await artifact("a.json", '{"synthetic":"a"}', { unitKey: "unit-a" })],
  });
  expect(
    await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-001" }),
  ).toMatchObject({ outcome: "registered" });
  expect(
    rows<{ normalized_outcome: string }>(
      harness.db,
      "SELECT normalized_outcome FROM fetch_run_reports WHERE fetch_run_id=1",
    ),
  ).toEqual([{ normalized_outcome: "partial" }]);
  expect(
    rows<{ normalized_outcome: string; safe_failure_code: string | null }>(
      harness.db,
      "SELECT normalized_outcome,safe_failure_code FROM fetch_unit_reports",
    ),
  ).toEqual([{ normalized_outcome: "failed", safe_failure_code: "page_limit_reached" }]);
  expect(collectionRuns(harness)[0]).toMatchObject({
    provider_outcome: "partial",
    coverage_status: "partial",
  });
});

test("registration is refused, not blocked, while the Processor has no route", async () => {
  const harness = collectionHarness({ COLLECTION_INGEST_CLIENT: "no-such-client" });
  await persistSyntheticRun(harness);
  const result = await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-001" });
  expect(result).toMatchObject({ outcome: "retryable", code: "inactive_ingest_client" });
  const row = collectionRuns(harness)[0]!;
  // Not blocked: a block is write-once and would outlive the configuration fix.
  expect(row.blocked_code).toBeNull();
  expect(stages(harness, row.id).at(-1)).toMatchObject({
    stage: "registered",
    state: "retryable",
    failure_code: "inactive_ingest_client",
  });
  // Repeating the attempt does not fill the append-only table with one row
  // per tick saying the same thing.
  await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-001" });
  await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-001" });
  expect(stages(harness, row.id).filter((stage) => stage.state === "retryable")).toHaveLength(1);
});

test("collection run and stage rows are append-only", async () => {
  const harness = collectionHarness();
  await persistSyntheticRun(harness);
  await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-001" });
  const row = collectionRuns(harness)[0]!;
  expect(() => harness.db.exec(`DELETE FROM collection_runs WHERE id=${row.id}`)).toThrow(
    "append-only",
  );
  expect(() =>
    harness.db.exec(`DELETE FROM collection_run_stages WHERE collection_run_id=${row.id}`),
  ).toThrow("append-only");
  expect(() =>
    harness.db.exec(
      `UPDATE collection_run_stages SET state='completed' WHERE collection_run_id=${row.id}`,
    ),
  ).toThrow("append-only");
  // The identity of a recorded run never changes, and a registered run is
  // never re-pointed at other CORE rows.
  expect(() =>
    harness.db.exec(`UPDATE collection_runs SET run_id='other' WHERE id=${row.id}`),
  ).toThrow("immutable except its progress");
  expect(() =>
    harness.db.exec(`UPDATE collection_runs SET fetch_run_id=99 WHERE id=${row.id}`),
  ).toThrow("immutable except its progress");
});

test("a failed run with no provider bytes is recorded and never sealed", async () => {
  const harness = collectionHarness();
  // What a collector persists when the provider run failed: its own manifest
  // and nothing from the provider (U09). The terminal is valid and complete.
  await persistSyntheticRun(harness, {
    run: { runId: "run-failed", providerOutcome: "failed", safeErrorCode: "login_failed" },
    artifacts: [
      await artifact("manifest.json", '{"synthetic":"manifest"}', { role: "collector_manifest" }),
    ],
  });
  const result = await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-failed" });
  expect(result).toMatchObject({ outcome: "blocked", code: "provider_run_failed" });
  // Recorded with its outcome, unwidened; no fetch run, so no empty sealed
  // acquisition can ever read as a successful observation.
  const [row] = collectionRuns(harness);
  expect(row).toMatchObject({
    run_id: "run-failed",
    provider_outcome: "failed",
    blocked_code: "provider_run_failed",
    fetch_run_id: null,
  });
  expect(stages(harness, row!.id).map((stage) => `${stage.stage}:${stage.state}`)).toEqual([
    "persisted:completed",
    "registered:blocked",
  ]);
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_runs")).toBe(0);
  expect(countOf(harness, "SELECT count(*) AS n FROM raw_objects")).toBe(0);
  // Delivered again: the same answer, and nothing appended.
  expect(
    await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-failed" }),
  ).toMatchObject({ outcome: "blocked", code: "provider_run_failed" });
  expect(stages(harness, row!.id)).toHaveLength(2);

  // A failed run that did capture provider bytes registers like any other:
  // the run report says `failed`, and nothing is widened.
  await persistSyntheticRun(harness, {
    run: {
      runId: "run-failed-capture",
      providerOutcome: "failed",
      safeErrorCode: "timeout",
      transformations: [
        {
          transformationId: "redact-1",
          stepKind: "redacted",
          transformerId: "synthetic-redactor",
          transformerVersion: "1.0.0",
          inputArtifactKeys: [],
          outputArtifactKey: "page.html",
        },
      ],
    },
    artifacts: [
      await artifact("manifest.json", '{"synthetic":"manifest"}', { role: "collector_manifest" }),
      await artifact("page.html", "<html>synthetic</html>", {
        role: "sanitized_provider_capture",
        mediaType: "text/html",
      }),
    ],
  });
  const captured = await registerCollectionRun(harness.env, {
    source: SOURCE,
    runId: "run-failed-capture",
  });
  expect(captured).toMatchObject({ outcome: "registered", artifacts: 2 });
  expect(
    rows<{ normalized_outcome: string }>(
      harness.db,
      "SELECT normalized_outcome FROM fetch_run_reports WHERE report_kind='terminal'",
    ),
  ).toEqual([{ normalized_outcome: "failed" }]);
});

test("a terminal's source is a collector id, mapped to the CORE source it registers under", async () => {
  const harness = collectionHarness();
  // The route the bootstrap SQL declares for this collector (config/ingest-clients.json).
  harness.db.exec(`
    INSERT INTO producers (id, kind, display_name)
      VALUES ('collector-sbi-shinsei', 'collector', 'Synthetic shared-R2 collector');
    INSERT INTO producer_sources (producer_id, source_id)
      VALUES ('collector-sbi-shinsei', 'sbi-shinsei-bank');
    INSERT INTO ingest_client_producers (ingest_client_id, producer_id)
      VALUES ('processor-shared-r2', 'collector-sbi-shinsei');
    INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id)
      VALUES ('processor-shared-r2', 'collector-sbi-shinsei', 'sbi-shinsei-bank');
  `);
  await persistSyntheticRun(harness, {
    run: { source: "sbi-shinsei", producer: "collector-sbi-shinsei", runId: "run-mapped" },
    artifacts: [await artifact("balance.json", '{"synthetic":true}')],
  });
  const result = await registerCollectionRun(harness.env, {
    source: "sbi-shinsei",
    runId: "run-mapped",
  });
  expect(result.outcome).toBe("registered");
  // The R2 identity keeps the collector's id; the CORE run carries the
  // registry's id, so nothing downstream has to know the collector's name.
  expect(
    collectionRuns(harness).map((row) => (row as unknown as { source: string }).source),
  ).toEqual(["sbi-shinsei"]);
  expect(
    rows<{ source_id: string; producer_id: string }>(
      harness.db,
      "SELECT source_id,producer_id FROM fetch_runs",
    ),
  ).toEqual([{ source_id: "sbi-shinsei-bank", producer_id: "collector-sbi-shinsei" }]);

  // A collector id the Processor does not know is recorded and refused
  // before any registration, with nothing created in the registry tables.
  await persistSyntheticRun(harness, {
    run: { source: "unknown-collector", runId: "run-unknown" },
    artifacts: [await artifact("balance.json", '{"synthetic":true}')],
  });
  expect(
    await registerCollectionRun(harness.env, { source: "unknown-collector", runId: "run-unknown" }),
  ).toMatchObject({ outcome: "blocked", code: "unknown_source" });
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_runs")).toBe(1);
  expect(
    countOf(
      harness,
      "SELECT count(*) AS n FROM collection_runs WHERE blocked_code='unknown_source'",
    ),
  ).toBe(1);
});

test("per-unit runs of one acquisition share its session and stay separate runs", async () => {
  const harness = collectionHarness();
  // One collector visit that produced one run per card (vpass, U09): each
  // run names the visit as its acquisition session ref.
  for (const card of ["001", "002"]) {
    await persistSyntheticRun(harness, {
      run: {
        runId: `visit-1-card-${card}`,
        acquisitionSessionRef: "visit-1",
        attemptId: `attempt-visit-1-card-${card}`,
      },
      artifacts: [await artifact(`card-${card}.json`, `{"synthetic":"${card}"}`)],
    });
    expect(
      (await registerCollectionRun(harness.env, { source: SOURCE, runId: `visit-1-card-${card}` }))
        .outcome,
    ).toBe("registered");
  }
  expect(countOf(harness, "SELECT count(*) AS n FROM acquisition_sessions")).toBe(1);
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_runs")).toBe(2);
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(2);
  const sessions = rows<{ acquisition_session_id: number }>(
    harness.db,
    "SELECT acquisition_session_id FROM collection_runs ORDER BY id",
  );
  expect(sessions).toEqual([{ acquisition_session_id: 1 }, { acquisition_session_id: 1 }]);
});

test("the collectors' artifact vocabulary registers under CORE's fidelity and lineage rules", async () => {
  const harness = collectionHarness();
  // Every role the shared-R2 collectors emit (U09), in the shapes they emit
  // it: a redaction whose input nobody kept, a manifest with no transformation
  // stated, and a derived file whose input is another artifact of the run.
  const response = await artifact("response.json", '{"synthetic":"response"}');
  const exported = await artifact("export.csv", "synthetic,csv", {
    role: "provider_export",
    mediaType: "text/csv",
  });
  const capture = await artifact("capture.html", "<html>redacted</html>", {
    role: "sanitized_provider_capture",
    mediaType: "text/html",
  });
  const manifest = await artifact("manifest.json", '{"synthetic":"manifest"}', {
    role: "collector_manifest",
  });
  const summary = await artifact("summary.json", '{"synthetic":"summary"}', {
    role: "collector_summary",
  });
  const derived = await artifact("derived.json", '{"synthetic":"derived"}', {
    role: "collector_derived",
  });
  await persistSyntheticRun(harness, {
    run: {
      runId: "run-vocabulary",
      transformations: [
        {
          transformationId: "redact-1",
          stepKind: "redacted",
          transformerId: "synthetic-redactor",
          transformerVersion: "1.0.0",
          inputArtifactKeys: [],
          outputArtifactKey: "capture.html",
        },
        {
          transformationId: "derive-1",
          stepKind: "extracted",
          transformerId: "synthetic-deriver",
          transformerVersion: "1.0.0",
          inputArtifactKeys: ["response.json"],
          outputArtifactKey: "derived.json",
        },
      ],
    },
    artifacts: [response, exported, capture, manifest, summary, derived],
  });
  const result = await registerCollectionRun(harness.env, {
    source: SOURCE,
    runId: "run-vocabulary",
  });
  expect(result).toMatchObject({ outcome: "registered", artifacts: 6 });
  expect(
    rows<{
      artifact_key: string;
      artifact_role: string;
      payload_fidelity: string;
      lineage_disposition: string;
    }>(
      harness.db,
      "SELECT artifact_key,artifact_role,payload_fidelity,lineage_disposition FROM fetch_artifacts ORDER BY artifact_key",
    ),
  ).toEqual([
    {
      artifact_key: "capture.html",
      artifact_role: "sanitized_provider_capture",
      payload_fidelity: "transformed",
      lineage_disposition: "source_not_retained_for_security",
    },
    {
      artifact_key: "derived.json",
      artifact_role: "collector_derived",
      payload_fidelity: "transformed",
      lineage_disposition: "linked",
    },
    {
      artifact_key: "export.csv",
      artifact_role: "provider_export",
      payload_fidelity: "exact",
      lineage_disposition: "not_applicable",
    },
    {
      artifact_key: "manifest.json",
      artifact_role: "collector_manifest",
      payload_fidelity: "generated",
      lineage_disposition: "not_applicable",
    },
    {
      artifact_key: "response.json",
      artifact_role: "provider_response",
      payload_fidelity: "exact",
      lineage_disposition: "not_applicable",
    },
    {
      artifact_key: "summary.json",
      artifact_role: "collector_summary",
      payload_fidelity: "generated",
      lineage_disposition: "not_applicable",
    },
  ]);
  expect(countOf(harness, "SELECT count(*) AS n FROM artifact_relations")).toBe(1);
});

test("a manifest CORE would refuse at the seal is blocked with a safe code, before the seal", async () => {
  const harness = collectionHarness();
  // A sanitized capture with no `redacted` step: the derivation refuses it
  // rather than letting the seal trigger abort with a raw database error.
  await persistSyntheticRun(harness, {
    run: { runId: "run-unredacted" },
    artifacts: [
      await artifact("page.html", "<html>synthetic</html>", {
        role: "sanitized_provider_capture",
        mediaType: "text/html",
      }),
    ],
  });
  expect(
    await registerCollectionRun(harness.env, { source: SOURCE, runId: "run-unredacted" }),
  ).toMatchObject({ outcome: "blocked", code: "sanitized_capture_without_redaction" });
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(0);
});

test("a registration that throws does not stop the page or pin the cursor (G1-13)", async () => {
  const harness = collectionHarness();
  for (const runId of ["run-001", "run-002", "run-003"]) {
    await persistSyntheticRun(harness, { run: { runId } });
  }
  // R2 fails for one run's objects: not a verdict about the terminal, so
  // nothing is recorded for it, and the two other runs still register.
  const poisoned = objectKey((await artifact("balance.json", '{"synthetic":true}')).sha256);
  const head = harness.bucket.head.bind(harness.bucket);
  let failures = 0;
  harness.bucket.head = async (key: string) => {
    if (key === poisoned && failures === 0) {
      failures += 1;
      throw new Error("synthetic r2 outage: " + key);
    }
    return head(key);
  };
  const codes: string[] = [];
  const first = await collectionScan(harness.env, { onFailure: (code) => codes.push(code) });
  expect(first).toMatchObject({ listed: 3, registered: 2, failed: 1, cycleComplete: true });
  expect(codes).toEqual(["Error"]);
  expect(
    countOf(harness, "SELECT count(*) AS n FROM collection_runs WHERE registered_at IS NOT NULL"),
  ).toBe(2);
  // The next cycle registers the run the outage hid.
  const second = await collectionScan(harness.env);
  expect(second).toMatchObject({ registered: 1, alreadyRegistered: 2, failed: 0 });
  expect(countOf(harness, "SELECT count(*) AS n FROM fetch_run_seals")).toBe(3);
});

// A12: migration 0034, the report job, and the facts the review asks these to
// keep. Every fixture is synthetic: made-up security codes, made-up prices and
// a made-up account. Nothing is copied from real evidence.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { canonicalJson } from "../../../packages/domain/src/index.ts";
import {
  instrumentRef,
  purgeRestrictedExplanations,
  reportsEnabled,
  runReportJob,
  type ReportJobEnv,
} from "../src/report-job.ts";
import {
  applyMigration,
  layerBMigrations,
  publishParse,
  seedArtifact,
  startPipeline,
} from "./harness.ts";

let mf: Miniflare;
let env: Env;
let jobEnv: ReportJobEnv;
beforeAll(async () => {
  ({ mf, env } = await startPipeline());
  jobEnv = { DB: env.DB, EVIDENCE: env.EVIDENCE, REPORTS_ENABLED: "true" };
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

const NOW = "2026-09-08T00:00:00.000Z";
const CUTOFF = "2026-12-31T00:00:00.000Z";
const options = {
  actor: "report-job",
  now: NOW,
  unitRef: "JPY",
  perimeterRef: "perimeter:test",
  knowledgeCutoff: CUTOFF,
  decimalPolicyRelease: "decimal-v1",
};

/** One synthetic published position with an optional provider-reported value. */
async function seedPosition(
  id: number,
  securityCode: string,
  quantity: string,
  providerValue: string | null,
): Promise<number> {
  await seedArtifact(env, id, "other-test", "positions", `positions-${id}.json`, { synthetic: id });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,'synthetic-positions','1','2026-09-07T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(id)
    .first<{ id: number }>();
  await publishParse(env.DB, parse!.id);
  await env.DB.prepare(
    `INSERT INTO position_observations (parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
     VALUES (?,'synthetic-account',?,?,0,'$','{}')`,
  )
    .bind(parse!.id, securityCode, quantity)
    .run();
  if (providerValue !== null)
    await env.DB.prepare(
      `INSERT INTO valuation_observations (parse_run_id,source_account,subject,metric,amount_text,currency,raw_locator,extra_json)
       VALUES (?,'synthetic-account',?,'acquisition_amount',?,'JPY','$','{}')`,
    )
      .bind(parse!.id, securityCode, providerValue)
      .run();
  return parse!.id;
}

async function seedPrice(
  priceId: string,
  ref: string,
  quoteCoefficient: string,
  baseCoefficient: string,
  recordedAt: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO price_observations
      (id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,quote_unit_ref,
       quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,source_claim_ref,
       market_ref,adjustment_policy_ref,recorded_at)
     VALUES (?,?,?,0,'JPY',?,0,'nav',?,?,NULL,NULL,?)`,
  )
    .bind(
      priceId,
      ref,
      baseCoefficient,
      quoteCoefficient,
      JSON.stringify({
        kind: "local-date",
        value: "2026-09-01",
        zone: "Asia/Tokyo",
        basis: "provider",
      }),
      `claim:${priceId}`,
      recordedAt,
    )
    .run();
}

const FUND = "instrument:other-test:-:SYN-FUND";

test("migration 0034 applies on 0017 through 0035 and seeds the seven retention classes", async () => {
  const migrations = layerBMigrations();
  expect(migrations).toContain("0034_reports.sql");
  // The harness already applied every migration in order, 0034 among them.
  const classes = await env.DB.prepare(
    "SELECT class_id FROM retention_classes ORDER BY class_id",
  ).all<{ class_id: string }>();
  expect(classes.results.map((row) => row.class_id)).toEqual([
    "cache",
    "decision",
    "financial-evidence",
    "log",
    "reference-evidence",
    "report",
    "secret-session",
  ]);
  // Retention says what a class means; it does not decide legal obligations.
  const policy = await env.DB.prepare(
    "SELECT policy_json FROM retention_classes WHERE class_id='financial-evidence'",
  ).first<{ policy_json: string }>();
  expect(JSON.parse(policy!.policy_json)).toMatchObject({ legalObligation: "undecided" });
  // Re-applying the migration on a database that already has it fails loudly
  // rather than silently rewriting the tables.
  await expect(applyMigration(env.DB, "0034_reports.sql")).rejects.toThrow();
});

test("prices, results, report artifacts, events and restrictions are append-only", async () => {
  await seedPrice("price:immutable", "instrument:test:-:X", "100", "1", "2026-09-01T00:00:00.000Z");
  await expect(
    env.DB.prepare(
      "UPDATE price_observations SET quote_amount_coefficient='1' WHERE id='price:immutable'",
    ).run(),
  ).rejects.toThrow("append-only");
  await expect(
    env.DB.prepare("DELETE FROM price_observations WHERE id='price:immutable'").run(),
  ).rejects.toThrow("append-only");
  // A price with a zero or negative base quantity is not a price basis at all.
  await expect(
    seedPrice("price:zero-base", "instrument:test:-:X", "100", "0", "2026-09-01T00:00:00.000Z"),
  ).rejects.toThrow();
  await env.DB.prepare(
    `INSERT INTO calculation_runs(run_id,context_id,policy_refs_json,input_manifest_digest,status,replayability,started_at)
     VALUES ('run-immutable','ctx-immutable','[]',?,'building','replayable',?)`,
  )
    .bind("a".repeat(64), NOW)
    .run();
  await expect(
    env.DB.prepare(
      "UPDATE calculation_runs SET context_id='ctx-other' WHERE run_id='run-immutable'",
    ).run(),
  ).rejects.toThrow("immutable");
  await env.DB.prepare(
    "UPDATE calculation_runs SET status='complete',completed_at=? WHERE run_id='run-immutable'",
  )
    .bind(NOW)
    .run();
  await expect(
    env.DB.prepare(
      "UPDATE calculation_runs SET status='building',completed_at=NULL WHERE run_id='run-immutable'",
    ).run(),
  ).rejects.toThrow("terminal");
  // A completed run takes no more results.
  await expect(
    env.DB.prepare(
      `INSERT INTO calculation_results(run_id,subject_ref,scope_ref,metric,unit_ref,coefficient,scale,value_status,unvalued_reason,rounding_inputs_json)
       VALUES ('run-immutable','s','sc','m','JPY','1',0,'exact',NULL,'{}')`,
    ).run(),
  ).rejects.toThrow("building");
  // A value is exact or unvalued with a reason; there is no third shape.
  await env.DB.prepare(
    `INSERT INTO calculation_runs(run_id,context_id,policy_refs_json,input_manifest_digest,status,replayability,started_at)
     VALUES ('run-shape','ctx-shape','[]',?,'building','replayable',?)`,
  )
    .bind("b".repeat(64), NOW)
    .run();
  await expect(
    env.DB.prepare(
      `INSERT INTO calculation_results(run_id,subject_ref,scope_ref,metric,unit_ref,coefficient,scale,value_status,unvalued_reason,rounding_inputs_json)
       VALUES ('run-shape','s','sc','m','JPY',NULL,NULL,'exact',NULL,'{}')`,
    ).run(),
  ).rejects.toThrow();
  await expect(
    env.DB.prepare(
      `INSERT INTO calculation_results(run_id,subject_ref,scope_ref,metric,unit_ref,coefficient,scale,value_status,unvalued_reason,rounding_inputs_json)
       VALUES ('run-shape','s','sc','m','JPY',NULL,NULL,'unvalued','we-did-not-look','{}')`,
    ).run(),
  ).rejects.toThrow();
});

test("the report job writes nothing while the flag is off", async () => {
  expect(reportsEnabled(undefined)).toBe(false);
  expect(reportsEnabled("false")).toBe(false);
  expect(reportsEnabled("true")).toBe(true);
  const before = await env.DB.prepare("SELECT count(*) AS n FROM report_artifacts").first<{
    n: number;
  }>();
  const result = await runReportJob({ DB: env.DB, EVIDENCE: env.EVIDENCE }, options);
  expect(result).toMatchObject({ generated: 0, skipped: "flag_off", reportId: null });
  const after = await env.DB.prepare("SELECT count(*) AS n FROM report_artifacts").first<{
    n: number;
  }>();
  expect(after!.n).toBe(before!.n);
});

test("AT30 the job stores its own valuation and the provider's cost side by side, and unvalued rows carry a typed reason", async () => {
  await seedPosition(4001, "SYN-FUND", "12500", "9000");
  // A second holding with no price at all: it must stay unvalued, not become 0.
  await seedPosition(4002, "SYN-NOPRICE", "10", null);
  await seedPrice("price:fund:1", FUND, "8000", "10000", "2026-09-01T00:00:00.000Z");

  const result = await runReportJob(jobEnv, options);
  expect(result.generated).toBe(1);
  expect(result.partition).toBe("partial-verified-scope");
  expect(result.unvaluedReasons).toEqual(["missing-price"]);

  const rows = await env.DB.prepare(
    "SELECT subject_ref,metric,coefficient,scale,value_status,unvalued_reason FROM calculation_results WHERE run_id=? ORDER BY subject_ref,metric",
  )
    .bind(result.runId)
    .all<{
      subject_ref: string;
      metric: string;
      coefficient: string | null;
      scale: number | null;
      value_status: string;
      unvalued_reason: string | null;
    }>();
  const byKey = new Map(rows.results.map((row) => [`${row.subject_ref}|${row.metric}`, row]));
  // SYN22: 12,500 units at 8,000 per 10,000 units is 10,000, not 100,000,000.
  expect(byKey.get(`${FUND}|holdings.valuation`)).toMatchObject({
    coefficient: "10000",
    scale: 0,
    value_status: "exact",
  });
  // The provider's own number is kept, and it differs from ours (UC30).
  expect(byKey.get(`${FUND}|provider.acquisition_amount`)).toMatchObject({
    coefficient: "9000",
    value_status: "exact",
  });
  expect(byKey.get("instrument:other-test:-:SYN-NOPRICE|holdings.valuation")).toMatchObject({
    value_status: "unvalued",
    unvalued_reason: "missing-price",
    coefficient: null,
  });

  const run = await env.DB.prepare(
    "SELECT status,replayability FROM calculation_runs WHERE run_id=?",
  )
    .bind(result.runId)
    .first<{ status: string; replayability: string }>();
  expect(run).toEqual({ status: "complete", replayability: "replayable" });

  const events = await env.DB.prepare("SELECT kind,actor FROM report_events WHERE report_id=?")
    .bind(result.reportId)
    .all<{ kind: string; actor: string }>();
  expect(events.results).toEqual([{ kind: "generated", actor: "report-job" }]);

  // The stored bytes are the canonical form the digest was taken over, and the
  // body carries no raw provider bytes or locators.
  const object = await env.EVIDENCE.get(`reports/${result.contentDigest}`);
  const text = await object!.text();
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  expect(digest).toBe(result.contentDigest ?? "");
  expect(text).toBe(canonicalJson(JSON.parse(text)));
  expect(text).not.toContain("raw_locator");
  expect(text).not.toContain("$");
});

test("re-running with unchanged inputs reuses the stored report, even at a later clock", async () => {
  // A five-minute sweep must not mint a new context every time the clock moves:
  // the manifest records the knowledge boundary of the evidence, not the
  // requested instant.
  const first = await runReportJob(jobEnv, options);
  expect(first).toMatchObject({ generated: 0, reused: 1 });
  const later = await runReportJob(jobEnv, {
    ...options,
    now: "2026-09-08T00:05:00.000Z",
    knowledgeCutoff: "2027-01-01T00:00:00.000Z",
  });
  expect(later).toMatchObject({ generated: 0, reused: 1, reportId: first.reportId });
  const count = await env.DB.prepare("SELECT count(*) AS n FROM report_artifacts").first<{
    n: number;
  }>();
  expect(count!.n).toBe(1);
});

test("AT36 and AT60 a corrected price makes a new context; the submitted report keeps its digest", async () => {
  const before = await env.DB.prepare(
    "SELECT report_id,context_id,content_digest FROM report_artifacts ORDER BY created_at LIMIT 1",
  ).first<{ report_id: string; context_id: string; content_digest: string }>();
  await env.DB.prepare(
    "INSERT INTO report_events(report_id,kind,actor,related_report_id,occurred_at) VALUES(?,'submitted','person:synthetic',NULL,?)",
  )
    .bind(before!.report_id, NOW)
    .run();

  // The price source publishes a correction and a classification changes.
  await seedPrice("price:fund:2", FUND, "8100", "10000", "2026-09-09T00:00:00.000Z");
  const second = await runReportJob(jobEnv, { ...options, now: "2026-09-09T00:00:00.000Z" });
  expect(second.generated).toBe(1);
  expect(second.contextId).not.toBe(before!.context_id);
  expect(second.contentDigest).not.toBe(before!.content_digest);

  const after = await env.DB.prepare(
    "SELECT report_id,context_id,content_digest FROM report_artifacts WHERE report_id=?",
  )
    .bind(before!.report_id)
    .first<{ report_id: string; context_id: string; content_digest: string }>();
  expect(after).toEqual(before!);
  // The old body is still byte-identical in the store.
  const stored = await env.EVIDENCE.get(`reports/${before!.content_digest}`);
  expect(stored).not.toBeNull();
  // The revision is related to the original as a correction, never an overwrite.
  await env.DB.prepare(
    "INSERT INTO report_events(report_id,kind,actor,related_report_id,occurred_at) VALUES(?,'corrected','person:synthetic',?,?)",
  )
    .bind(second.reportId, before!.report_id, "2026-09-09T00:00:00.000Z")
    .run();
  const events = await env.DB.prepare(
    "SELECT kind FROM report_events WHERE report_id=? ORDER BY id",
  )
    .bind(before!.report_id)
    .all<{ kind: string }>();
  expect(events.results.map((row) => row.kind)).toEqual(["generated", "submitted"]);
});

test("AT63 evidence recorded after the knowledge cutoff is not part of the context", async () => {
  const late = "2026-09-20T00:00:00.000Z";
  await seedPosition(4003, "SYN-LATE", "1", null);
  await env.DB.prepare("UPDATE fetch_artifacts SET recorded_at_ms=?,fetched_at_ms=? WHERE id=?")
    .bind(Date.parse(late), Date.parse("2026-01-01T00:00:00.000Z"), 4003)
    .run();
  // A cutoff before the import excludes the row even though it was fetched long ago.
  const excluded = await runReportJob(jobEnv, {
    ...options,
    now: late,
    knowledgeCutoff: "2026-09-10T00:00:00.000Z",
  });
  const excludedRows = await env.DB.prepare(
    "SELECT subject_ref FROM calculation_results WHERE run_id=?",
  )
    .bind(excluded.runId)
    .all<{ subject_ref: string }>();
  expect(excludedRows.results.map((row) => row.subject_ref)).not.toContain(
    "instrument:other-test:-:SYN-LATE",
  );
  // With today's knowledge the same evidence is in scope, under a new context.
  const included = await runReportJob(jobEnv, { ...options, now: late, knowledgeCutoff: late });
  expect(included.contextId).not.toBe(excluded.contextId);
  const includedRows = await env.DB.prepare(
    "SELECT subject_ref FROM calculation_results WHERE run_id=?",
  )
    .bind(included.runId)
    .all<{ subject_ref: string }>();
  expect(includedRows.results.map((row) => row.subject_ref)).toContain(
    "instrument:other-test:-:SYN-LATE",
  );
});

test("AT66 a use restriction downgrades the run and purges the cached explanation, keeping the report body", async () => {
  const report = await env.DB.prepare(
    "SELECT report_id,context_id,content_digest,storage_ref FROM report_artifacts ORDER BY created_at LIMIT 1",
  ).first<{
    report_id: string;
    context_id: string;
    content_digest: string;
    storage_ref: string;
  }>();
  expect(await env.EVIDENCE.head(`${report!.storage_ref}.explanation`)).not.toBeNull();
  await env.DB.prepare(
    `INSERT INTO evidence_use_restrictions(evidence_ref,restriction,since,affected_manifests_json,actor,reason)
     VALUES ('claim:price:fund:1','no-reuse',?,?,'operator:synthetic','synthetic exclusion drill')`,
  )
    .bind(NOW, JSON.stringify([report!.context_id]))
    .run();
  await expect(
    env.DB.prepare(
      "DELETE FROM evidence_use_restrictions WHERE evidence_ref='claim:price:fund:1'",
    ).run(),
  ).rejects.toThrow("append-only");

  const purge = await purgeRestrictedExplanations(jobEnv);
  expect(purge.restrictedReports).toContain(report!.report_id);
  expect(purge.purgedExplanations).toBeGreaterThan(0);
  expect(purge.downgradedRuns).toBeGreaterThan(0);
  expect(await env.EVIDENCE.head(`${report!.storage_ref}.explanation`)).toBeNull();
  // The fixed deliverable survives; only the claim about replaying it changes.
  expect(await env.EVIDENCE.head(report!.storage_ref)).not.toBeNull();
  const run = await env.DB.prepare("SELECT replayability FROM calculation_runs WHERE context_id=?")
    .bind(report!.context_id)
    .first<{ replayability: string }>();
  expect(run!.replayability).toBe("restricted");
});

test("instrument references keep the same code in two markets apart", () => {
  expect(instrumentRef({ source_id: "s", market: "TSE", security_code: "1234" })).not.toBe(
    instrumentRef({ source_id: "s", market: "NYSE", security_code: "1234" }),
  );
  expect(instrumentRef({ source_id: "s", market: null, security_code: "1234" })).toBe(
    "instrument:s:-:1234",
  );
});

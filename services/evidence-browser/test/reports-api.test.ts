// A12 read side: re-displaying a fixed report artifact, and refusing to
// explain or export one whose evidence is now restricted (AR03, AR17; SC16,
// UC60/AT60, UC66/AT66). Also the decimal policy selection contract of root
// review 07 section 6. Every row here is synthetic.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/worker";
import { reportsApi } from "../src/reports-api";
import {
  DECIMAL_POLICY_PROJECTIONS,
  decimalPolicySelection,
  decimalProjectionExists,
} from "../src/decimal-policy";
import { canonicalJson, type ReportBody } from "../../../packages/domain/src/index";
import { validInterpretationContext } from "../../../packages/observation-shared/src/api-schema";

const CONTEXT = "ctx-synthetic-1";
const RUN = "run-synthetic-1";
const REPORT = "rpt-synthetic-1";
const NOW = "2026-08-31T15:00:00.000Z";

const body: ReportBody = {
  schemaVersion: "report-holdings-v1",
  purpose: "holdings-view",
  contextId: CONTEXT,
  calculationRunId: RUN,
  policyRefs: ["decimal-v1", "instrument-valuation-v1"],
  unitRef: "JPY",
  partition: "partial-verified-scope",
  subtotal: { coefficient: "10000", scale: 0 },
  rows: [
    {
      subjectRef: "instrument:synthetic:-:FUND",
      scopeRef: "scope:synthetic",
      metric: "holdings.valuation",
      unitRef: "JPY",
      valued: true,
      value: { coefficient: "10000", scale: 0 },
    },
    {
      subjectRef: "instrument:synthetic:-:NOPRICE",
      scopeRef: "scope:synthetic",
      metric: "holdings.valuation",
      unitRef: "JPY",
      valued: false,
      unvaluedReason: "missing-price",
    },
  ],
  coverage: { scopeRef: "perimeter:test", coveredRef: "positions:2", truncated: false },
};

let digest: string;
let storageRef: string;

async function call(path: string) {
  const url = new URL(`https://fixture.test${path}`);
  try {
    const response = await reportsApi(env, url);
    return { status: response?.status ?? 404, json: (await response?.json()) as any };
  } catch (error) {
    return { status: (error as { status?: number }).status ?? 500, json: error as any };
  }
}

beforeAll(async () => {
  const bytes = new TextEncoder().encode(canonicalJson(body));
  digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  storageRef = `reports/${digest}`;
  await env.EVIDENCE.put(storageRef, bytes);
  await env.EVIDENCE.put(
    `${storageRef}.explanation`,
    new TextEncoder().encode(
      canonicalJson({ schemaVersion: "report-explanation-v1", contextId: CONTEXT }),
    ),
  );
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO calculation_runs(run_id,context_id,policy_refs_json,input_manifest_digest,status,replayability,started_at,completed_at)
       VALUES (?,?,?,?,'complete','replayable',?,?)`,
    ).bind(RUN, CONTEXT, JSON.stringify(body.policyRefs), "c".repeat(64), NOW, NOW),
    env.DB.prepare(
      `INSERT INTO report_artifacts(report_id,context_id,purpose,schema_version,content_digest,storage_ref,created_by,created_at)
       VALUES (?,?,'holdings-view',?,?,?,'report-job',?)`,
    ).bind(REPORT, CONTEXT, body.schemaVersion, digest, storageRef, NOW),
    env.DB.prepare(
      "INSERT INTO report_events(report_id,kind,actor,related_report_id,occurred_at) VALUES(?,'generated','report-job',NULL,?)",
    ).bind(REPORT, NOW),
    env.DB.prepare(
      "INSERT INTO report_events(report_id,kind,actor,related_report_id,occurred_at) VALUES(?,'submitted','person:synthetic',NULL,?)",
    ).bind(REPORT, NOW),
  ]);
});

describe("re-displaying a fixed report", () => {
  it("AT60 returns the stored body and its events, and never regenerates", async () => {
    const first = await call(`/api/v2/reports/${REPORT}`);
    expect(first.status).toBe(200);
    expect(first.json.body).toEqual(body);
    expect(first.json.report).toMatchObject({
      reportId: REPORT,
      contextId: CONTEXT,
      contentDigest: digest,
      replayability: "replayable",
    });
    expect(first.json.events.map((event: { kind: string }) => event.kind)).toEqual([
      "generated",
      "submitted",
    ]);
    // Recomputing and sharing a correction are named but not served here.
    expect(Object.keys(first.json.report.operations)).toEqual([
      "re-display",
      "recompute-under-current-rules",
      "share-corrected-version",
    ]);

    // A later rule, price and classification change: new policies, a new price
    // and a new calculation run at a different context.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO calculation_policies(policy_id,kind,version,definition_json,verification,evidence_refs_json,created_at)
         VALUES ('rounding-jpy-v2','rounding','2','{"where":"aggregate"}','unverified','[]',?)`,
      ).bind(NOW),
      env.DB.prepare(
        `INSERT INTO price_observations(id,base_instrument_ref,base_quantity_coefficient,base_quantity_scale,
           quote_unit_ref,quote_amount_coefficient,quote_amount_scale,price_kind,effective_time,source_claim_ref,
           market_ref,adjustment_policy_ref,recorded_at)
         VALUES ('price:later','instrument:synthetic:-:FUND','10000',0,'JPY','9999',0,'nav',
           '{"kind":"unknown","reasonCode":"synthetic"}','claim:later',NULL,NULL,?)`,
      ).bind("2026-09-08T00:00:00.000Z"),
      env.DB.prepare(
        `INSERT INTO calculation_runs(run_id,context_id,policy_refs_json,input_manifest_digest,status,replayability,started_at,completed_at)
         VALUES ('run-synthetic-2','ctx-synthetic-2','["rounding-jpy-v2"]',?,'complete','replayable',?,?)`,
      ).bind("d".repeat(64), "2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.000Z"),
    ]);
    const second = await call(`/api/v2/reports/${REPORT}`);
    expect(second.json.report.contentDigest).toBe(digest);
    expect(second.json.body).toEqual(body);
  });

  it("refuses an unknown report, a bad identifier and an unknown query parameter", async () => {
    expect((await call("/api/v2/reports/does-not-exist")).status).toBe(404);
    expect((await call("/api/v2/reports/has%2Fslash")).status).toBe(400);
    expect((await call(`/api/v2/reports/${REPORT}?limit=10`)).status).toBe(400);
    expect(await reportsApi(env, new URL("https://fixture.test/api/balances"))).toBeNull();
  });

  it("keeps the route behind Access and read-only", async () => {
    const unauthenticated = await worker.fetch(
      new Request(`https://fixture.test/api/v2/reports/${REPORT}`),
      env,
    );
    expect(unauthenticated.status).toBe(401);
    const written = await worker.fetch(
      new Request(`https://fixture.test/api/v2/reports/${REPORT}`, { method: "POST" }),
      env,
    );
    expect(written.status).toBe(401);
  });
});

describe("AT66 restricted evidence", () => {
  it("blocks explanation and export while the stored body stays readable", async () => {
    const beforeExplain = await call(`/api/v2/reports/${REPORT}/explanation`);
    expect(beforeExplain.status).toBe(200);
    expect(beforeExplain.json.replayability).toBe("replayable");
    expect((await call(`/api/v2/reports/${REPORT}/export`)).status).toBe(200);

    await env.DB.prepare(
      `INSERT INTO evidence_use_restrictions(evidence_ref,restriction,since,affected_manifests_json,actor,reason)
       VALUES ('claim:synthetic','no-reuse',?,?,'operator:synthetic','synthetic exclusion drill')`,
    )
      .bind(NOW, JSON.stringify([CONTEXT]))
      .run();

    expect((await call(`/api/v2/reports/${REPORT}/explanation`)).status).toBe(403);
    expect((await call(`/api/v2/reports/${REPORT}/export`)).status).toBe(403);
    // Re-display still works, and it says the calculation is no longer replayable.
    const redisplay = await call(`/api/v2/reports/${REPORT}`);
    expect(redisplay.status).toBe(200);
    expect(redisplay.json.report).toMatchObject({
      replayability: "restricted",
      capabilities: {
        explain: false,
        export: false,
        recompute: false,
        purgeCachedExplanations: true,
      },
    });
    expect(redisplay.json.body).toEqual(body);
  });

  it("does not serve a cached explanation node once the pipeline has purged it", async () => {
    await env.EVIDENCE.delete(`${storageRef}.explanation`);
    // Still 403 rather than 404: the refusal is the authorization decision,
    // not an accident of the cache being empty.
    expect((await call(`/api/v2/reports/${REPORT}/explanation`)).status).toBe(403);
  });
});

describe("decimal policy selection", () => {
  it("defaults to decimal-v1, accepts only names with a projection, and refuses the rest", async () => {
    expect(Object.keys(DECIMAL_POLICY_PROJECTIONS)).toEqual(["decimal-v1"]);
    expect(decimalProjectionExists("decimal-v1")).toBe(true);
    expect(decimalProjectionExists("decimal-v2")).toBe(false);
    expect(decimalPolicySelection(new URL("https://fixture.test/api/v2/reports/x"))).toBe(
      "decimal-v1",
    );
    expect(
      decimalPolicySelection(
        new URL("https://fixture.test/api/v2/reports/x?decimalPolicy=decimal-v1"),
      ),
    ).toBe("decimal-v1");
    // The selection is what the response's interpretation context reports.
    const served = await call(`/api/v2/reports/${REPORT}?decimalPolicy=decimal-v1`);
    expect(validInterpretationContext(served.json.interpretationContext)).toBe(true);
    expect(served.json.interpretationContext).toMatchObject({
      mode: "as-recorded",
      decimalPolicyRelease: "decimal-v1",
    });
    // Well-formed but no projection: unsupported semantics, not a silent fallback.
    const unsupported = await call(`/api/v2/reports/${REPORT}?decimalPolicy=decimal-v2`);
    expect(unsupported.status).toBe(400);
    expect(unsupported.json.code).toBe("unsupported_semantics");
    // Malformed: an invalid query.
    const invalid = await call(`/api/v2/reports/${REPORT}?decimalPolicy=%20not%20a%20release`);
    expect(invalid.status).toBe(400);
    expect(invalid.json.code).toBe("invalid_query");
  });
});

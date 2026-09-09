import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { identityQuery } from "../src/identity-api";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const kinds = ["transaction", "balance", "position", "valuation"] as const;
const samples: Array<{ source: string; parse: number; kind: string; count: number; run: number }> =
  [];
beforeAll(async () => {
  await seedRegistry();
  for (let index = 0; index < 36; index++)
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO instruments VALUES (?,'money','Synthetic','provider-local')",
      ).bind(`perf-instrument-${index}`),
      env.DB.prepare(
        "INSERT INTO instrument_identifiers VALUES (?,'synthetic','fixture',?,'{}')",
      ).bind(`perf-id-${index}`, String(index)),
      env.DB.prepare(
        "INSERT INTO instrument_mappings VALUES (?,?,1,?,'rule','synthetic',1,'2099','Initial','provider-local')",
      ).bind(`perf-map-${index}`, `perf-id-${index}`, `perf-instrument-${index}`),
      env.DB.prepare(
        "INSERT INTO instrument_mappings VALUES (?,?,2,?,'manual','synthetic correction',1,'2099','Updated','identified')",
      ).bind(`perf-manual-${index}`, `perf-id-${index}`, `perf-instrument-${index}`),
    ]);
  for (let index = 0; index < 12; index++) {
    const source = `perf-source-${String(index).padStart(2, "0")}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sources(id,provider,display_name) VALUES (?,'Synthetic','Synthetic')",
      ).bind(source),
      env.DB.prepare(
        "INSERT INTO producer_sources(producer_id,source_id) VALUES ('evidence-test',?)",
      ).bind(source),
      env.DB.prepare(
        "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test',?)",
      ).bind(source),
    ]);
    const run = await seedRun({ source, count: 1 });
    const parse = await env.DB.prepare(
      "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,'fixture','1','2099','ok','[]') RETURNING id",
    )
      .bind(run.artifacts[0]!.id)
      .first<{ id: number }>();
    await publishParse(parse!.id);
    const kind = kinds[index % 4]!;
    const count = index < 8 ? 2917 : 2916;
    const required = {
      transaction: ["", ""],
      balance: [",metric,instrument", ",'synthetic','SYN'"],
      position: [",security_code,quantity_text,quantity_scale", ",'SYN','0',0"],
      valuation: [",subject,metric,currency", ",'SYN','synthetic','SYN'"],
    }[kind]!;
    samples.push({ source, parse: parse!.id, kind, count, run: run.id });
    await env.DB.batch([
      env.DB.prepare(`WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<?)
        INSERT INTO ${kind}_observations(parse_run_id,source_account,raw_locator,extra_json${required[0]}) SELECT ?,?,'row-'||v,'{}'${required[1]} FROM n`).bind(
        count,
        parse!.id,
        source,
      ),
      env.DB.prepare("INSERT INTO source_accounts VALUES (?,?,'evidence-test',?)").bind(
        source,
        source,
        JSON.stringify([source]),
      ),
      env.DB.prepare("INSERT INTO accounts VALUES (?,'Synthetic','cash','provider-local')").bind(
        source,
      ),
      env.DB.prepare(
        "INSERT INTO account_mappings VALUES (?,?,1,?,'rule','synthetic',1,'2099','Synthetic','provider-local')",
      ).bind(source, source, source),
      env.DB.prepare("INSERT INTO identity_runs VALUES (?,?,1,'2099')").bind(source, parse!.id),
      env.DB.prepare(
        `INSERT INTO identity_observations SELECT ?||'-'||id,?,?,id,?,?,'[]' FROM ${kind}_observations WHERE parse_run_id=?`,
      ).bind(source, source, kind, source, source, parse!.id),
      env.DB.prepare(
        "INSERT INTO identity_instrument_uses SELECT id,'unit','perf-id-'||(observation_id%36),'perf-map-'||(observation_id%36) FROM identity_observations WHERE identity_run_id=?",
      ).bind(source),
      env.DB.prepare(
        "INSERT INTO identity_instrument_uses SELECT id,'trade-unit','perf-id-'||(observation_id%36),'perf-map-'||(observation_id%36) FROM identity_observations WHERE identity_run_id=? AND observation_id%3=0",
      ).bind(source),
      env.DB.prepare("INSERT INTO identity_run_seals VALUES (?,?,'2099')").bind(source, count),
    ]);
    if (index === 0)
      await env.DB.batch([
        env.DB.prepare("INSERT INTO identity_runs VALUES (?,?,2,'2099')").bind(
          source + "-v2",
          parse!.id,
        ),
        env.DB.prepare(
          "INSERT INTO identity_observations SELECT id||'-v2',identity_run_id||'-v2',kind,observation_id,source_account_id,account_mapping_id,issues_json FROM identity_observations WHERE identity_run_id=?",
        ).bind(source),
        env.DB.prepare(
          "INSERT INTO identity_instrument_uses SELECT u.identity_observation_id||'-v2',u.role,u.identifier_id,u.instrument_mapping_id FROM identity_instrument_uses u JOIN identity_observations o ON o.id=u.identity_observation_id WHERE o.identity_run_id=?",
        ).bind(source),
        env.DB.prepare("INSERT INTO identity_run_seals VALUES (?,?,'2099')").bind(
          source + "-v2",
          count,
        ),
      ]);
  }
}, 60_000);

it("35,000 observations across 12 sources retain distinct-role counts, current corrections and full pagination", async () => {
  let observed = 0,
    rows = 0;
  const timings: number[] = [];
  for (let offset = 0; offset < 432; offset += 101) {
    const started = performance.now();
    const result = await env.DB.prepare(identityQuery("instruments", false))
      .bind(offset)
      .all<{ observedCount: number; label: string; status: string }>();
    timings.push(Math.round(performance.now() - started));
    rows += result.results.length;
    for (const row of result.results) {
      observed += row.observedCount;
      expect(row.label).toBe("Updated");
      expect(row.status).toBe("identified");
    }
  }
  expect(rows).toBe(432);
  expect(observed).toBe(35_000);
  for (const sample of samples) {
    const result = await env.DB.prepare(identityQuery("instruments", true))
      .bind(sample.source, 0)
      .all<{ observedCount: number; source: string }>();
    expect(result.results).toHaveLength(36);
    expect(result.results.reduce((n, r) => n + r.observedCount, 0)).toBe(sample.count);
    expect(result.results.every((r) => r.source === sample.source)).toBe(true);
  }
  const coverage = await env.DB.prepare(identityQuery("coverage", false))
    .bind(0)
    .all<{ eligible: number; organized: number; providerLocal: number }>();
  expect(coverage.results).toHaveLength(12);
  expect(coverage.results.reduce((n, r) => n + r.eligible, 0)).toBe(35_000);
  expect(
    coverage.results.every((r) => r.eligible === r.organized && r.organized === r.providerLocal),
  ).toBe(true);
  console.log(
    JSON.stringify({ fixtureObservations: 35000, sources: 12, instrumentPagesMs: timings }),
  );
}, 60_000);

it("instrument plan materializes current and role aggregates before identifier metadata", async () => {
  const plan = await env.DB.prepare("EXPLAIN QUERY PLAN " + identityQuery("instruments", false))
    .bind(0)
    .all<{ detail: string }>();
  const details = plan.results.map((r) => r.detail);
  expect(details.filter((d) => d === "MATERIALIZE current")).toHaveLength(1);
  expect(details).toContain("MATERIALIZE counts");
  expect(
    details.some((d) => /^SCAN u\b/.test(d)) ||
      details.some((d) =>
        /SEARCH u USING INDEX sqlite_autoindex_identity_instrument_uses_1/.test(d),
      ),
  ).toBe(true);
  expect(details.some((d) => /SCAN d\b/.test(d))).toBe(false);
  expect(details.some((d) => /MATERIALIZE all_observations/.test(d))).toBe(false);
  console.log(
    JSON.stringify({
      fixtureObservations: 35000,
      sources: 12,
      planSteps: details.length,
      metadataAfterAggregation: true,
    }),
  );
});

it("run exclusions still remove account/instrument rows and coverage denominator", async () => {
  const sample = samples[11]!;
  await env.DB.prepare(
    "INSERT INTO fetch_run_annotations VALUES (?,'exclude_from_financial_views','synthetic-fixture',0)",
  )
    .bind(sample.run)
    .run();
  for (const kind of ["accounts", "instruments", "coverage"] as const) {
    const result = await env.DB.prepare(identityQuery(kind, true)).bind(sample.source, 0).all();
    expect(result.results).toHaveLength(0);
  }
});

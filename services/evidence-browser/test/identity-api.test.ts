import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { identityApi } from "../src/identity-api";
import { seedRegistry, seedRun } from "./fixtures";
import { validIdentityResponse } from "../../../poc/observation-pipeline/shared/identity-contract";
beforeAll(seedRegistry);
async function call(path: string, method = "GET") {
  const request = new Request(`https://fixture.test${path}`, { method });
  return identityApi(request, env, new URL(request.url));
}
async function seed() {
  const run = await seedRun({ count: 1, source: "other-test" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,'identity-fixture','1','2099-01-01','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0].id)
    .first<{ id: number }>();
  const observation = await env.DB.prepare(
    `INSERT INTO transaction_observations (parse_run_id,source_account,currency,raw_locator,extra_json) VALUES (?,'synthetic-ref','JPY','synthetic','{}') RETURNING id`,
  )
    .bind(parse!.id)
    .first<{ id: number }>();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO source_accounts VALUES ('ref','other-test','evidence-test','["synthetic-ref"]')`,
    ),
    env.DB.prepare(`INSERT INTO accounts VALUES ('account','Initial','cash','provider-local')`),
    env.DB.prepare(
      `INSERT INTO account_mappings VALUES ('am1','ref',1,'account','rule','initial',1,'2099','Initial','provider-local')`,
    ),
    env.DB.prepare(
      `INSERT INTO instruments VALUES ('instrument','money','Initial unit','provider-local')`,
    ),
    env.DB.prepare(
      `INSERT INTO instrument_identifiers VALUES ('identifier','iso4217','global','JPY','{}')`,
    ),
    env.DB.prepare(
      `INSERT INTO instrument_mappings VALUES ('im1','identifier',1,'instrument','rule','initial',1,'2099','Initial unit','provider-local')`,
    ),
    env.DB.prepare(`INSERT INTO identity_runs VALUES ('ir',?,1,'2099')`).bind(parse!.id),
    env.DB.prepare(
      `INSERT INTO identity_observations VALUES ('io','ir','transaction',?,'ref','am1','[]')`,
    ).bind(observation!.id),
    env.DB.prepare(`INSERT INTO identity_instrument_uses VALUES ('io','unit','identifier','im1')`),
    env.DB.prepare(`INSERT INTO identity_run_seals VALUES ('ir',1,'2099')`),
    env.DB.prepare(
      `INSERT INTO account_mappings VALUES ('am2','ref',2,'account','manual','confirmed-account',1,'2099','Updated account','identified')`,
    ),
    env.DB.prepare(
      `INSERT INTO instrument_mappings VALUES ('im2','identifier',2,'instrument','manual','confirmed-currency',1,'2099','Updated currency','identified')`,
    ),
  ]);
  return { parseId: parse!.id, observationId: observation!.id };
}
it("reads current revisions instead of pinned targets and returns linked evidence without amounts", async () => {
  const seeded = await seed();
  for (const kind of ["accounts", "instruments", "coverage"]) {
    const path = `/api/identity/${kind}`;
    const response = await call(path);
    const body = await response!.json();
    expect(validIdentityResponse(path, body)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("amount");
    if (kind === "coverage")
      expect(body).toMatchObject({
        rows: [{ eligible: 1, organized: 1, identified: 1, providerLocal: 0 }],
      });
    else
      expect(body).toMatchObject({
        rows: [
          {
            revision: 2,
            status: "identified",
            label: kind === "accounts" ? "Updated account" : "Updated currency",
            observedCount: 1,
            origin: { kind: "transaction", id: seeded.observationId },
          },
        ],
      });
  }
  expect(await (await call("/api/identity/accounts?source=absent"))!.json()).toMatchObject({
    rows: [],
  });
});
it("includes unprocessed eligible observations in the coverage denominator", async () => {
  const run = await seedRun({ count: 1, source: "sony-bank" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,'unprocessed','1','2099','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0].id)
    .first<{ id: number }>();
  await env.DB.prepare(
    `INSERT INTO transaction_observations (parse_run_id,source_account,currency,raw_locator,extra_json) VALUES (?,'unprocessed','JPY','synthetic','{}')`,
  )
    .bind(parse!.id)
    .run();
  expect(await (await call("/api/identity/coverage?source=sony-bank"))!.json()).toMatchObject({
    rows: [{ eligible: 1, organized: 0 }],
  });
});
it("rejects malformed query parameters, methods and unknown routes", async () => {
  for (const suffix of [
    "?offset=-1",
    "?offset=01",
    "?offset=1000001",
    "?source=x&source=y",
    "?q=x",
    "?source=",
  ])
    await expect(call(`/api/identity/accounts${suffix}`)).rejects.toMatchObject({ status: 400 });
  await expect(call("/api/identity/accounts", "POST")).rejects.toMatchObject({ status: 405 });
  await expect(call("/api/identity/missing")).rejects.toMatchObject({ status: 404 });
  expect(await call("/api/overview")).toBe(null);
});
it("filters before paging without dropping the final account", async () => {
  const run = await seedRun({ count: 1, source: "sony-bank" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,'paged-identity','1','2099','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0].id)
    .first<{ id: number }>();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO transaction_observations (parse_run_id,source_account,currency,raw_locator,extra_json)
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<101)
      SELECT ?,printf('page-%03d',x),'JPY','synthetic','{}' FROM n`).bind(parse!.id),
    env.DB.prepare(
      `INSERT INTO source_accounts SELECT source_account,'sony-bank','evidence-test',json_array(source_account) FROM transaction_observations WHERE parse_run_id=?`,
    ).bind(parse!.id),
    env.DB.prepare(
      `INSERT INTO accounts SELECT source_account,source_account,'cash','provider-local' FROM transaction_observations WHERE parse_run_id=?`,
    ).bind(parse!.id),
    env.DB.prepare(
      `INSERT INTO account_mappings SELECT source_account,source_account,1,source_account,'rule','synthetic',1,'2099',source_account,'provider-local' FROM transaction_observations WHERE parse_run_id=?`,
    ).bind(parse!.id),
    env.DB.prepare(`INSERT INTO identity_runs VALUES ('paged-run',?,1,'2099')`).bind(parse!.id),
    env.DB.prepare(
      `INSERT INTO identity_observations SELECT source_account,'paged-run','transaction',id,source_account,source_account,'[]' FROM transaction_observations WHERE parse_run_id=?`,
    ).bind(parse!.id),
    env.DB.prepare(`INSERT INTO identity_run_seals VALUES ('paged-run',101,'2099')`),
  ]);
  const first = (await (await call("/api/identity/accounts?source=sony-bank"))!.json()) as {
    rows: { referenceId: string }[];
    coverage: { nextOffset: number | null };
  };
  const last = (await (await call(
    "/api/identity/accounts?source=sony-bank&offset=100",
  ))!.json()) as typeof first;
  expect(first.rows).toHaveLength(100);
  expect(first.coverage.nextOffset).toBe(100);
  expect(last.rows).toHaveLength(1);
  expect(last.coverage.nextOffset).toBe(null);
  expect(new Set([...first.rows, ...last.rows].map((r) => r.referenceId)).size).toBe(101);
});

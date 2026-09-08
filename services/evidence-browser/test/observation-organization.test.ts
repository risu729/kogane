import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { seedRegistry, seedRun } from "./fixtures";
import {
  observationOrganizations,
  organizeRows,
  ORGANIZATION_QUERY,
} from "../src/observation-organization";
import { observationApi } from "../src/observation-api";
import { validApiResponse } from "../../../poc/observation-pipeline/shared/api-validation";

beforeAll(seedRegistry);
const kinds = ["transaction", "balance", "position", "valuation"] as const;
async function seed() {
  const acquisition = await seedRun({ count: 1, source: "other-test" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,'fixture','1','2099','ok','[]') RETURNING id`,
  )
    .bind(acquisition.artifacts[0]!.id)
    .first<{ id: number }>();
  const prefix = `fixture-${parse!.id}-`;
  const prepare = (sql: string) =>
    env.DB.prepare(
      sql.replace(
        /'(ref|account|am2?|instrument|identifier|im2?|ir|unsealed|new)'/g,
        (_all, name: string) => `'${prefix}${name}'`,
      ),
    );
  const refs = [];
  for (const kind of kinds) {
    const extra = {
      transaction: [",currency,description", ",'JPY','Original merchant'"],
      balance: [",metric,instrument", ",'available','JPY'"],
      position: [
        ",security_code,security_name,quantity_text,quantity_scale",
        ",'SYN','English source name','2',0",
      ],
      valuation: [",subject,metric,currency", ",'SYN','market-value','JPY'"],
    }[kind];
    const row = await env.DB.prepare(
      `INSERT INTO ${kind}_observations(parse_run_id,source_account,raw_locator,extra_json${extra[0]}) VALUES (?,'original-account','row','{}'${extra[1]}) RETURNING id`,
    )
      .bind(parse!.id)
      .first<{ id: number }>();
    refs.push({ kind, id: row!.id });
  }
  await env.DB.batch([
    prepare(
      `INSERT INTO source_accounts VALUES ('ref','other-test','evidence-test','["original-account",${parse!.id}]')`,
    ),
    prepare(`INSERT INTO accounts VALUES ('account','Initial account','cash','provider-local')`),
    prepare(
      `INSERT INTO account_mappings VALUES ('am','ref',1,'account','rule','provider-scope',1,'2099','整理された口座','provider-local')`,
    ),
    prepare(
      `INSERT INTO instruments VALUES ('instrument','security','Initial name','provider-local')`,
    ),
    prepare(
      `INSERT INTO instrument_identifiers VALUES ('identifier','synthetic','${prefix}','SYN','{}')`,
    ),
    prepare(
      `INSERT INTO instrument_mappings VALUES ('im','identifier',1,'instrument','rule','provider-code',1,'2099','整理された銘柄','provider-local')`,
    ),
    prepare(`INSERT INTO identity_runs VALUES ('ir',?,1,'2099')`).bind(parse!.id),
    ...refs.flatMap(({ kind, id }) => [
      prepare(`INSERT INTO identity_observations VALUES (?,'ir',?,?,'ref','am','[]')`).bind(
        prefix + kind,
        kind,
        id,
      ),
      prepare(`INSERT INTO identity_instrument_uses VALUES (?,'security','identifier','im')`).bind(
        prefix + kind,
      ),
    ]),
    prepare(`INSERT INTO identity_run_seals VALUES ('ir',4,'2099')`),
  ]);
  return { refs, parseId: parse!.id, acquisition, prepare };
}

it("organizes all four kinds without replacing stored fields and preserves missing interpretation", async () => {
  const { refs } = await seed();
  const result = await observationOrganizations(env.DB, refs);
  expect(result.size).toBe(4);
  for (const ref of refs)
    expect(result.get(`${ref.kind}:${ref.id}`)).toMatchObject({
      state: "organized",
      lineage: "current",
      account: { label: "整理された口座", revision: 1 },
      instruments: [{ role: "security", label: "整理された銘柄" }],
    });
  const source = {
    id: refs[2]!.id,
    security_name: "English source name",
    source_account: "original-account",
    quantity_text: "2",
  };
  const rows = await organizeRows(env.DB, "position", [source]);
  expect(rows[0]).toMatchObject(source);
  expect(source).not.toHaveProperty("organization");
  expect(
    (await observationOrganizations(env.DB, [{ kind: "position", id: 999999 }])).get(
      "position:999999",
    ),
  ).toEqual({ state: "unavailable", lineage: null, account: null, instruments: [] });
});

it("uses current manual claims but does not publish an unsealed newer identity run", async () => {
  const { refs, parseId, prepare } = await seed();
  await env.DB.batch([
    prepare(
      `INSERT INTO account_mappings VALUES ('am2','ref',2,'account','manual','verified correction',1,'2100','手動口座','identified')`,
    ),
    prepare(
      `INSERT INTO instrument_mappings VALUES ('im2','identifier',2,'instrument','manual','verified correction',1,'2100','手動銘柄','identified')`,
    ),
    prepare(`INSERT INTO identity_runs VALUES ('unsealed',?,2,'2100')`).bind(parseId),
    prepare(
      `INSERT INTO identity_observations VALUES ('new','unsealed','transaction',?,'ref','am2','[]')`,
    ).bind(refs[0]!.id),
  ]);
  const result = (await observationOrganizations(env.DB, refs)).get(`transaction:${refs[0]!.id}`)!;
  expect(result.account).toMatchObject({ label: "手動口座", method: "manual", revision: 2 });
  expect(result.instruments[0]).toMatchObject({ label: "手動銘柄", method: "manual", revision: 2 });
});

it("excludes acquisition evidence revoked from financial visibility", async () => {
  const { refs, acquisition } = await seed();
  await env.DB.prepare(
    `INSERT INTO fetch_run_annotations VALUES (?,'exclude_from_financial_views','fixture',0)`,
  )
    .bind(acquisition.id)
    .run();
  const result = await observationOrganizations(env.DB, refs);
  expect([...result.values()].every((r) => r.state === "unavailable")).toBe(true);
});

it("retains historical names without presenting superseded observations as current", async () => {
  const { refs, parseId, acquisition } = await seed();
  const replacement = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,'fixture','2','2100','ok','[]') RETURNING id`,
  )
    .bind(acquisition.artifacts[0]!.id)
    .first<{ id: number }>();
  await env.DB.prepare(`UPDATE parse_runs SET superseded_by_parse_run_id=? WHERE id=?`)
    .bind(replacement!.id, parseId)
    .run();
  const result = await observationOrganizations(env.DB, refs);
  expect(
    [...result.values()].every((r) => r.state === "organized" && r.lineage === "historical"),
  ).toBe(true);
});

it("accepts the full existing position/valuation fanout and bounds each query to 500 keys", async () => {
  const refs = Array.from({ length: 5501 }, (_, id) => ({
    kind: "valuation" as const,
    id: 900000 + id,
  }));
  const result = await observationOrganizations(env.DB, refs);
  expect(result.size).toBe(5501);
  expect([...result.values()].every((r) => r.state === "unavailable")).toBe(true);
  await expect(
    observationOrganizations(env.DB, [...refs, { kind: "valuation", id: 1000000 }]),
  ).rejects.toThrow("organization_reference_limit");
});

it("detail route returns interpretation separately and retains raw source name", async () => {
  const { refs } = await seed();
  const path = `/api/observations/position/${refs[2]!.id}`;
  const request = new Request(`https://fixture.test${path}`);
  const response = await observationApi(request, env, new URL(request.url));
  const body = await response!.json();
  expect(validApiResponse(path, body)).toBe(true);
  expect(body).toMatchObject({
    row: { security_name: "English source name", source_account: "original-account" },
    organization: { account: { label: "整理された口座" } },
  });
});

it("page lookups begin with wanted observation keys, not acquisition-wide scans", async () => {
  const { refs } = await seed();
  const result = await env.DB.prepare(`EXPLAIN QUERY PLAN ${ORGANIZATION_QUERY}`)
    .bind(JSON.stringify(refs))
    .all<{ detail: string }>();
  expect(result.results.some((r) => r.detail.includes("identity_observation_lookup"))).toBe(true);
  expect(result.results.some((r) => /^SCAN terminal/.test(r.detail))).toBe(false);
});

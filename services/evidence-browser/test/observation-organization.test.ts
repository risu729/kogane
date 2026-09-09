import { env } from "cloudflare:test";
import { beforeAll, expect, it, vi } from "vitest";
import { publishParse, seedRegistry, seedRun, supersedeParse } from "./fixtures";
import {
  observationOrganizations,
  organizeRows,
  ORGANIZATION_QUERY,
} from "../src/observation-organization";
import { observationApi } from "../src/observation-api";
import { validApiResponse } from "../../../poc/observation-pipeline/shared/api-validation";
import { organizedFilterOptions } from "../src/organized-filter-options";

beforeAll(seedRegistry);
const kinds = ["transaction", "balance", "position", "valuation"] as const;
async function seed(
  rawAccount = "original-account",
  product?: { code: string; currency: string; padding?: string; sony?: boolean },
) {
  const source = product?.sony ? "sony-bank" : product ? "sbi-shinsei-bank" : "other-test";
  if (product)
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO producer_sources(producer_id,source_id) VALUES ('evidence-test','sbi-shinsei-bank')",
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test','sbi-shinsei-bank')",
      ),
    ]);
  const acquisition = await seedRun({
    count: 1,
    source,
    dataset: product?.sony
      ? "yen-history-page-0001"
      : product
        ? "top-accounts-balance-and-activity"
        : undefined,
  });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,?,'1','2099','ok','[]') RETURNING id`,
  )
    .bind(
      acquisition.artifacts[0]!.id,
      product?.sony
        ? "sony-bank-history-json"
        : product
          ? "sbi-shinsei-top-balances-and-activity"
          : "fixture",
    )
    .first<{ id: number }>();
  await publishParse(parse!.id);
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
    const productExtra =
      product && (kind === "balance" || kind === "valuation")
        ? {
            accountNo: rawAccount.replace(/^sbi-shinsei:/u, ""),
            productCode: product.code,
            unrelatedProviderBody: product.padding ?? "not-product-evidence",
            currency: product.currency,
            ...(product.sony ? { transaction: { currencyCd: product.currency } } : {}),
            _kogane: {
              sourceView: "top_overview",
              productCode: product.code,
              subjectCurrency: product.currency,
            },
          }
        : {};
    const columns =
      product && kind === "valuation"
        ? [",subject,metric,currency", ",?,'yen_equivalent','JPY'"]
        : product && kind === "balance"
          ? [",metric,instrument", ",'account_balance',?"]
          : extra;
    const row = await env.DB.prepare(
      `INSERT INTO ${kind}_observations(parse_run_id,source_account,raw_locator,extra_json${columns[0]}) VALUES (?,?,?,?${columns[1]}) RETURNING id`,
    )
      .bind(
        parse!.id,
        rawAccount,
        product?.sony
          ? "json:$.transactionHistInfo[0].transactionAftBal"
          : product
            ? `json:$.responseParam.overview.responseParam.savingsDetails[0].${kind === "valuation" ? "yenEqui" : "balance"}`
            : "row",
        JSON.stringify(productExtra),
        ...(product && (kind === "balance" || kind === "valuation") ? [product.currency] : []),
      )
      .first<{ id: number }>();
    refs.push({ kind, id: row!.id });
  }
  await env.DB.batch([
    prepare(`INSERT INTO source_accounts VALUES ('ref','${source}','evidence-test',?)`).bind(
      JSON.stringify([rawAccount, parse!.id]),
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

it("binds official products only to their own snapshot evidence, including native-currency valuations", async () => {
  const { refs, acquisition, prepare } = await seed("sbi-shinsei:synthetic-product", {
    code: "621",
    currency: "USD",
  });
  await prepare(
    `INSERT INTO account_mappings VALUES ('am2','ref',2,'account','manual','nickname',1,'2100','旅行用','identified')`,
  ).run();
  const result = await observationOrganizations(env.DB, refs);
  for (const kind of ["balance", "valuation"] as const) {
    const ref = refs.find((r) => r.kind === kind)!;
    const organization = result.get(`${kind}:${ref.id}`)!;
    expect(organization.account).toMatchObject({ label: "旅行用", method: "manual" });
    expect(organization.product).toMatchObject({ status: "identified", nativeCurrency: "USD" });
  }
  for (const kind of ["transaction", "position"] as const) {
    const ref = refs.find((r) => r.kind === kind)!;
    expect(result.get(`${kind}:${ref.id}`)!.product).toMatchObject({ status: "unresolved" });
  }
  const response = await observationApi(
    new Request(`https://fixture.test/api/observations/valuation/${refs[3]!.id}`),
    env,
    new URL(`https://fixture.test/api/observations/valuation/${refs[3]!.id}`),
  );
  const body = (await response!.json()) as {
    organization: { product: { origin: { id: number } } };
  };
  expect(validApiResponse(`/api/observations/valuation/${refs[3]!.id}`, body)).toBe(true);
  body.organization.product.origin.id += 1;
  expect(validApiResponse(`/api/observations/valuation/${refs[3]!.id}`, body)).toBe(false);
  const projection = await env.DB.prepare(ORGANIZATION_QUERY)
    .bind(JSON.stringify(refs))
    .all<{ product_extra: string }>();
  expect(
    projection.results.every((row) => !row.product_extra.includes("unrelatedProviderBody")),
  ).toBe(true);
  await env.DB.prepare(
    `INSERT INTO fetch_run_annotations VALUES (?,'exclude_from_financial_views','fixture',0)`,
  )
    .bind(acquisition.id)
    .run();
  expect(
    [...(await observationOrganizations(env.DB, refs)).values()].every(
      (r) => r.product === undefined,
    ),
  ).toBe(true);
});

it("bounds product metadata before it leaves D1 and preserves oversized source evidence", async () => {
  const { refs } = await seed("sbi-shinsei:synthetic-large", {
    code: "x".repeat(9000),
    currency: "JPY",
    padding: "x".repeat(9000),
  });
  const result = await observationOrganizations(env.DB, refs);
  for (const ref of refs.filter((row) => row.kind === "balance" || row.kind === "valuation")) {
    expect(result.get(`${ref.kind}:${ref.id}`)!.product).toMatchObject({
      status: "unresolved",
      productId: null,
    });
    expect(result.get(`${ref.kind}:${ref.id}`)!.product!.reason).toContain("読み取り上限");
  }
  const row = await env.DB.prepare("SELECT extra_json FROM balance_observations WHERE id=?")
    .bind(refs[1]!.id)
    .first<{ extra_json: string }>();
  expect(row!.extra_json).toContain("x".repeat(9000));
  const harmless = await seed("sbi-shinsei:synthetic-large-context", {
    code: "601",
    currency: "JPY",
    padding: "x".repeat(9000),
  });
  const projected = await observationOrganizations(env.DB, harmless.refs);
  expect(projected.get(`balance:${harmless.refs[1]!.id}`)!.product!.status).toBe("identified");
  const sony = await seed("sony-bank:deposit:JPY", {
    code: "x".repeat(9000),
    currency: "JPY",
    sony: true,
  });
  const sonyResult = await observationOrganizations(env.DB, sony.refs);
  expect(sonyResult.get(`balance:${sony.refs[1]!.id}`)!.product).toMatchObject({
    status: "unresolved",
    productId: null,
  });
  expect(sonyResult.get(`balance:${sony.refs[1]!.id}`)!.product!.reason).toContain("読み取り上限");
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
  await supersedeParse(parseId, replacement!.id);
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

it("adds current filter labels without changing source filter values or inventing absent labels", async () => {
  const raw = "filter-unique";
  const { prepare } = await seed(raw);
  const options = {
    sources: ["other-test"],
    instruments: ["JPY"],
    metrics: [],
    accounts: [
      { source_id: "other-test", source_account: raw },
      { source_id: "other-test", source_account: "unorganized-filter" },
    ],
  };
  for (const kind of ["transactions", "balances", "positions"]) {
    const result = await organizedFilterOptions(env.DB, kind, options);
    expect(result.accounts[0]).toEqual({
      ...options.accounts[0],
      display_name: "整理された口座",
      organization_ambiguous: false,
    });
    expect(result.accounts[1]).toEqual({
      ...options.accounts[1],
      display_name: null,
      organization_ambiguous: false,
    });
    expect(result.sources).toEqual(options.sources);
    expect(validApiResponse("/api/filter-options", result)).toBe(true);
  }
  expect(options.accounts[0]).not.toHaveProperty("display_name");
  await env.DB.batch([
    prepare(
      `INSERT INTO account_mappings VALUES ('am2','ref',2,'account','manual','correction',1,'2100','手動の絞り込み名','identified')`,
    ),
  ]);
  const updated = await organizedFilterOptions(env.DB, "transactions", options);
  expect(updated.accounts[0]!.display_name).toBe("手動の絞り込み名");
  expect(await organizedFilterOptions(env.DB, "artifacts", options)).toBe(options);
  expect(await organizedFilterOptions(env.DB, "constructor", options)).toBe(options);
});

it("does not choose one account when a raw filter scope has multiple organized targets", async () => {
  const raw = "ambiguous-filter";
  const first = await seed(raw);
  const second = await seed(raw);
  const options = {
    sources: [],
    instruments: [],
    metrics: [],
    accounts: [{ source_id: "other-test", source_account: raw }],
  };
  const result = await organizedFilterOptions(env.DB, "transactions", options);
  expect(result.accounts[0]).toEqual({
    ...options.accounts[0],
    display_name: null,
    organization_ambiguous: true,
  });
  // Excluded acquisition evidence must not leave a stale ambiguity or name behind.
  await env.DB.prepare(
    "INSERT INTO fetch_run_annotations VALUES (?,'exclude_from_financial_views','fixture',0)",
  )
    .bind(second.acquisition.id)
    .run();
  expect((await organizedFilterOptions(env.DB, "transactions", options)).accounts[0]).toEqual({
    ...options.accounts[0],
    display_name: "整理された口座",
    organization_ambiguous: false,
  });
  await env.DB.prepare(
    "INSERT INTO fetch_run_annotations VALUES (?,'exclude_from_financial_views','fixture',0)",
  )
    .bind(first.acquisition.id)
    .run();
  expect(
    (await organizedFilterOptions(env.DB, "transactions", options)).accounts[0]!.display_name,
  ).toBeNull();
});

it("rejects an oversized distinct-reference result even for one raw filter group", async () => {
  const statement = env.DB.prepare("SELECT 1");
  const empty = await statement.all();
  const output = Array.from({ length: 5001 }, (_, i) => ({
    source_id: "other-test",
    producer_id: "evidence-test",
    source_account: "shared-scope",
    reference_id: `reference-${i}`,
    label: "same label",
    target_id: "same-target",
    method: "rule",
  }));
  vi.spyOn(statement, "all").mockResolvedValue({ ...empty, results: output });
  vi.spyOn(env.DB, "prepare").mockReturnValue(statement);
  try {
    await expect(
      organizedFilterOptions(env.DB, "transactions", {
        sources: [],
        instruments: [],
        metrics: [],
        accounts: [{ source_id: "other-test", source_account: "shared-scope" }],
      }),
    ).rejects.toThrow("filter_organization_budget");
  } finally {
    vi.restoreAllMocks();
  }
});

import { env, SELF } from "cloudflare:test";
import { base64url, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun, supersedeParse } from "./fixtures";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { boundedCollections } from "../src/observation-api";
import { CENTRAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema";

const prefix = "/api/evidence/v1";
describe("production observation API", () => {
  it("filters before paging and discovers accounts beyond the global first 500 rows", async () => {
    const run = await seedRun({ count: 1, source: "other-test" });
    const parse = await env.DB.prepare(`INSERT INTO parse_runs
      (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES (?,'large-fixture','1','2026-09-07','ok','[]') RETURNING id`)
      .bind(run.artifacts[0].id)
      .first<{ id: number }>();
    await publishParse(parse!.id);
    await env.DB.prepare(`INSERT INTO transaction_observations
      (parse_run_id,source_account,external_id,as_of,amount_minor,currency,raw_locator,extra_json,description)
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1003)
      SELECT ?, CASE WHEN x<=1001 THEN 'large-account' ELSE 'older-account' END,
        CAST(x AS TEXT), CASE WHEN x<=1001 THEN '2026-09-07' ELSE '2020-01-01' END,
        9007199254740993,'JPY',CAST(x AS TEXT),'{}',
        CASE WHEN x=1002 THEN 'synthetic text longer than fifty characters with literal percent % and underscore _' ELSE NULL END FROM n`)
      .bind(parse!.id)
      .run();
    const options = await (await call("/api/filter-options?kind=transactions")).json();
    expect(validApiResponse("/api/filter-options", options)).toBe(true);
    expect(options).toMatchObject({
      accounts: expect.arrayContaining([
        {
          source_id: "other-test",
          source_account: "older-account",
          display_name: null,
          organization_ambiguous: false,
        },
      ]),
    });
    const small = await (
      await call("/api/transactions?source=other-test&account=older-account")
    ).json();
    expect(small).toMatchObject({
      transactions: [expect.anything(), expect.anything()],
      coverage: { truncated: false, nextOffset: null },
    });
    const ids: number[] = [];
    for (const offset of [0, 500, 1000]) {
      const response = await call(
        `/api/transactions?source=other-test&account=large-account&offset=${offset}`,
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        transactions: { id: number; amount_minor: string }[];
        coverage: { nextOffset: number | null };
      };
      expect(validApiResponse("/api/transactions", page)).toBe(true);
      expect(page.transactions.length).toBe(offset === 1000 ? 1 : 500);
      expect(page.coverage.nextOffset).toBe(offset === 1000 ? null : offset + 500);
      expect(page.transactions.every((row) => row.amount_minor === "9007199254740993")).toBe(true);
      ids.push(...page.transactions.map((row) => row.id));
    }
    expect(new Set(ids).size).toBe(1001);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    for (const query of ["from=2020-01-01&to=2020-01-01", "q=older-account"]) {
      const matching = (await (
        await call(`/api/transactions?source=other-test&${query}`)
      ).json()) as { transactions: unknown[] };
      expect(matching.transactions).toHaveLength(2);
    }
    for (const q of [
      "%",
      "synthetic text longer than fifty characters with literal percent % and underscore _",
    ]) {
      const matching = (await (
        await call(`/api/transactions?source=other-test&q=${encodeURIComponent(q)}`)
      ).json()) as { transactions: { id: number }[] };
      expect(matching.transactions).toHaveLength(1);
      const detailPath = `/api/observations/transaction/${matching.transactions[0].id}`;
      const detail = await (await call(detailPath)).json();
      expect(validApiResponse(detailPath, detail)).toBe(true);
      expect(detail).toMatchObject({ row: { amount_minor: "9007199254740993" } });
    }
    for (const query of [
      "offset=-1",
      "offset=1.2",
      "offset=1000001",
      "source=a&source=b",
      "account=",
      "unexpected=x",
      "from=2026-02-30",
      "from=2026-09-01&to=2020-01-01",
    ])
      expect((await call(`/api/transactions?${query}`)).status).toBe(400);
    expect((await call("/api/filter-options?kind=raw")).status).toBe(400);
    await env.DB.prepare(
      "INSERT INTO fetch_run_annotations VALUES (?, 'exclude_from_financial_views', 'test-finished', 0)",
    )
      .bind(run.id)
      .run();
  });

  it("filters all balance dimensions before independent latest and history paging", async () => {
    const run = await seedRun({ count: 1, source: "other-test" });
    const parse = await env.DB.prepare(`INSERT INTO parse_runs
      (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES (?,'large-balance-fixture','1','2026-09-07','ok','[]') RETURNING id`)
      .bind(run.artifacts[0].id)
      .first<{ id: number }>();
    await publishParse(parse!.id);
    await env.DB.prepare(`INSERT INTO balance_observations
      (parse_run_id,source_account,metric,instrument,amount_minor,as_of,raw_locator,extra_json)
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1003)
      SELECT ?,'large-balance-account',printf('metric-%04d',x),CASE WHEN x<=1001 THEN 'JPY' ELSE 'USD' END,
        9007199254740993,'2026-09-07',CAST(x AS TEXT),'{}' FROM n`)
      .bind(parse!.id)
      .run();
    const base = "/api/balances?source=other-test&account=large-balance-account";
    const first = (await (await call(base)).json()) as {
      latest: { id: number }[];
      history: { id: number }[];
    };
    const second = (await (await call(`${base}&offset=500`)).json()) as typeof first;
    expect(second.latest).toEqual(first.latest);
    expect(new Set([...first.history, ...second.history].map((row) => row.id)).size).toBe(1000);
    const last = (await (
      await call(`${base}&offset=1000&latestOffset=1000`)
    ).json()) as typeof first;
    expect(last.latest).toHaveLength(3);
    expect(last.history).toHaveLength(3);
    const selected = (await (
      await call(`${base}&instrument=USD&metric=metric-1002`)
    ).json()) as typeof first;
    expect(selected.latest).toHaveLength(1);
    expect(selected.history).toHaveLength(1);
    const options = await (await call("/api/filter-options?kind=balances")).json();
    expect(validApiResponse("/api/filter-options", options)).toBe(true);
    expect(options).toMatchObject({
      instruments: expect.arrayContaining(["USD"]),
      metrics: expect.arrayContaining(["metric-1003"]),
    });
    const replacement = await env.DB.prepare(`INSERT INTO parse_runs
      (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES (?,'large-balance-fixture','2','2026-09-08','ok','[]') RETURNING id`)
      .bind(run.artifacts[0].id)
      .first<{ id: number }>();
    await supersedeParse(parse!.id, replacement!.id);
    const historicalOptions = await (await call("/api/filter-options?kind=balances")).json();
    expect(historicalOptions).toMatchObject({
      accounts: expect.arrayContaining([
        {
          source_id: "other-test",
          source_account: "large-balance-account",
          display_name: null,
          organization_ambiguous: false,
        },
      ]),
      instruments: expect.arrayContaining(["USD"]),
      metrics: expect.arrayContaining(["metric-1003"]),
    });
    const historical = (await (
      await call(`${base}&instrument=USD&metric=metric-1002`)
    ).json()) as typeof first;
    expect(historical.latest).toHaveLength(0);
    expect(historical.history).toHaveLength(1);
    expect((await call(`${base}&latestOffset=-1`)).status).toBe(400);
    const artifactPage = (await (await call("/api/artifacts?source=other-test")).json()) as {
      artifacts: { source_id: string }[];
    };
    expect(artifactPage.artifacts.every((row) => row.source_id === "other-test")).toBe(true);
    await env.DB.prepare(
      "INSERT INTO fetch_run_annotations VALUES (?, 'exclude_from_financial_views', 'test-finished', 0)",
    )
      .bind(run.id)
      .run();
  });

  it("pages current positions before fetching valuations even with more than 5000 current rows", async () => {
    const run = await seedRun({ count: 1, source: "other-test" });
    const parse = await env.DB.prepare(`INSERT INTO parse_runs
      (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES (?,'large-position-fixture','1','2026-09-07','ok','[]') RETURNING id`)
      .bind(run.artifacts[0].id)
      .first<{ id: number }>();
    await publishParse(parse!.id);
    await env.DB.prepare(`INSERT INTO position_observations
      (parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5002)
      SELECT ?,CASE WHEN x=5002 THEN 'z-last-account' ELSE 'a-first-account' END,
        CAST(x AS TEXT),'1',0,CAST(x AS TEXT),'{}' FROM n`)
      .bind(parse!.id)
      .run();
    await env.DB.prepare(`INSERT INTO valuation_observations
      (parse_run_id,source_account,subject,metric,amount_minor,currency,raw_locator,extra_json)
      SELECT parse_run_id,source_account,security_code,'value',9007199254740993,'JPY',raw_locator,'{}'
      FROM position_observations WHERE parse_run_id=?`)
      .bind(parse!.id)
      .run();
    const response = await call("/api/positions?source=other-test&account=z-last-account");
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      positions: { position: { id: number }; valuations: { id: number; amount_minor: string }[] }[];
    };
    expect(validApiResponse("/api/positions", page)).toBe(true);
    expect(page.positions).toHaveLength(1);
    expect(page.positions[0].valuations).toHaveLength(1);
    expect(page.positions[0].valuations[0].amount_minor).toBe("9007199254740993");
    const global = await call("/api/positions");
    expect(global.status).toBe(200);
    expect(await global.json()).toMatchObject({ coverage: { nextOffset: 500, truncated: true } });
    for (const [kind, id] of [
      ["position", page.positions[0].position.id],
      ["valuation", page.positions[0].valuations[0].id],
    ]) {
      const detail = await (await call(`/api/observations/${kind}/${id}`)).json();
      expect(validApiResponse(`/api/observations/${kind}/${id}`, detail)).toBe(true);
      if (kind === "valuation")
        expect(detail).toMatchObject({ row: { amount_minor: "9007199254740993" } });
    }
    await env.DB.prepare(
      "INSERT INTO fetch_run_annotations VALUES (?, 'exclude_from_financial_views', 'test-finished', 0)",
    )
      .bind(run.id)
      .run();
  });

  it("reports registered parsing backlog and failures as aggregate health", async () => {
    const run = await seedRun({ count: 1 });
    for (const status of ["pending", "running", "failed", "done"]) {
      await env.DB.prepare(
        "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status) VALUES(?,?,?,?)",
      )
        .bind(run.artifacts[0].id, `fixture-${status}`, "1", status)
        .run();
    }
    const response = await call("/api/meta");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ parsingHealth: { pending: 1, running: 1, failed: 1 } });
    expect(validApiResponse("/api/meta", body)).toBe(true);
    expect(body).toMatchObject({
      source: { kind: "central-store", classification: "financial" },
      capabilities: CENTRAL_STORE_CAPABILITIES,
    });
  });
  it("clears repaired historical failures but keeps newer failures and replacement work visible", async () => {
    const baseline = (
      (await (await call("/api/meta")).json()) as {
        parsingHealth: { pending: number; running: number; failed: number };
      }
    ).parsingHealth;
    const run = await seedRun({ count: 1 });
    const artifactId = run.artifacts[0].id;
    for (const [name, status, version, retired] of [
      ["repaired", "failed", "1", false],
      ["new-failure", "failed", "2", false],
      ["replacement", "pending", "2", false],
      ["retired", "failed", "1", true],
    ] as const) {
      await env.DB.prepare(
        "INSERT INTO observation_parse_jobs(fetch_artifact_id,parser_name,parser_version,status,last_error_code) VALUES(?,?,?,?,?)",
      )
        .bind(artifactId, name, version, status, retired ? "parser_version_retired" : null)
        .run();
    }
    for (const [name, version, status, date] of [
      ["repaired", "1", "error", "2026-09-01"],
      ["repaired", "2", "ok", "2026-09-02"],
      ["new-failure", "1", "ok", "2026-09-01"],
      ["new-failure", "2", "error", "2026-09-02"],
      ["replacement", "1", "ok", "2026-09-01"],
    ]) {
      const inserted = await env.DB.prepare(
        "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,status,parsed_at,warnings_json) VALUES(?,?,?,?,?,'[]') RETURNING id",
      )
        .bind(artifactId, name, version, status, `${date}T00:00:00.000Z`)
        .first<{ id: number }>();
      if (status === "ok") await publishParse(inserted!.id);
    }
    expect(await (await call("/api/meta")).json()).toMatchObject({
      parsingHealth: {
        pending: baseline.pending + 1,
        running: baseline.running,
        failed: baseline.failed + 1,
      },
    });
  });
  it("bounds position matching after excluding historical failed parses", async () => {
    const run = await seedRun({ count: 1 });
    const failed =
      await env.DB.prepare(`INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES (?,'fixture-position','1','2026-09-07T00:00:00Z','error','[]') RETURNING id`)
        .bind(run.artifacts[0].id)
        .first<{ id: number }>();
    await env.DB.prepare(`INSERT INTO position_observations (parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
      WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<5001)
      SELECT ?,'fixture-account',CAST(x AS TEXT),'1',0,'$','{}' FROM n`)
      .bind(failed!.id)
      .run();
    await env.DB.prepare(`INSERT INTO valuation_observations (parse_run_id,source_account,subject,metric,currency,raw_locator,extra_json)
      SELECT parse_run_id,source_account,security_code,'value','JPY','$','{}' FROM position_observations WHERE parse_run_id=?`)
      .bind(failed!.id)
      .run();
    const response = await call("/api/positions");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ positions: [] });
  });
  it("reports truncated collection coverage explicitly", async () => {
    const response = boundedCollections({
      transactions: Array.from({ length: 501 }, (_, id) => ({ id })),
    });
    const result = (await response.json()) as {
      transactions: unknown[];
      coverage: { limit: number; truncated: boolean };
    };
    expect(result.transactions).toHaveLength(500);
    expect(result.coverage).toEqual({ limit: 500, truncated: true });
  });
  it("keeps every new read behind Access and rejects mutation/query input", async () => {
    for (const path of [
      "/api/meta",
      "/api/overview",
      "/api/transactions",
      "/api/balances",
      "/api/positions",
      "/api/artifacts",
      "/api/observations/balance/1",
      `/api/raw/${"a".repeat(64)}`,
    ]) {
      expect((await call(path, { jwt: null })).status).toBe(401);
      expect((await call(path, { jwt: "invalid" })).status).toBe(401);
      expect((await call(path, { method: "POST" })).status).toBe(405);
      expect((await call(`${path}?unsafe=1`)).status).toBe(400);
    }
  });
  it("serves contract-valid production views and hides staged or subsequently excluded observations", async () => {
    // Unique bytes: excluding this run removes the last visible reference to
    // this hash. Shared content remains legitimately readable via other runs.
    const run = await seedRun({
      count: 2,
      body: '{"synthetic":"exclusive-observation-visibility-fixture"}',
    });
    const artifactId = run.artifacts[0].id;
    const parsed =
      await env.DB.prepare(`INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES (?,'fixture-parser','1','2026-09-07T00:00:00Z','ok','[]') RETURNING id`)
        .bind(artifactId)
        .first<{ id: number }>();
    await publishParse(parsed!.id);
    const balance =
      await env.DB.prepare(`INSERT INTO balance_observations (parse_run_id,source_account,metric,instrument,amount_minor,raw_locator,extra_json)
      VALUES (?,'fixture-account','cash','JPY',9007199254740993,'$','{}') RETURNING id`)
        .bind(parsed!.id)
        .first<{ id: number }>();
    for (const path of [
      "/api/meta",
      "/api/overview",
      "/api/transactions",
      "/api/balances",
      "/api/positions",
      "/api/artifacts",
      `/api/artifacts/${artifactId}`,
      `/api/observations/balance/${balance!.id}`,
    ]) {
      const response = await call(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(validApiResponse(path, await response.json()), path).toBe(true);
    }
    const balances = (await (await call("/api/balances")).json()) as {
      latest: { amount_minor: string }[];
    };
    expect(balances.latest.some((row) => row.amount_minor === "9007199254740993")).toBe(true);
    for (const method of ["GET", "HEAD"]) {
      const download = await call(`/api/raw/${run.artifacts[0].sha256}`, { method });
      expect(download.status).toBe(200);
      expect(download.headers.get("content-disposition")).toBe(
        `attachment; filename="synthetic-0.json"; filename*=UTF-8''synthetic-0.json`,
      );
      expect(download.headers.get("content-type")).toBe("application/octet-stream");
      if (method === "HEAD") expect(await download.text()).toBe("");
      else await download.arrayBuffer();
    }
    const staged =
      await env.DB.prepare(`INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
      VALUES (?,'fixture-parser','2','2026-09-07T00:00:00Z','pending','[]') RETURNING id`)
        .bind(artifactId)
        .first<{ id: number }>();
    const stagedBalance =
      await env.DB.prepare(`INSERT INTO balance_observations (parse_run_id,source_account,metric,instrument,amount_minor,raw_locator,extra_json)
      VALUES (?,'fixture-account','cash','JPY',123,'$','{}') RETURNING id`)
        .bind(staged!.id)
        .first<{ id: number }>();
    expect((await call(`/api/observations/balance/${stagedBalance!.id}`)).status).toBe(404);
    const page = (await (await call(`/api/artifacts?cursor=${run.artifacts[1].id}`)).json()) as {
      artifacts: { id: number }[];
    };
    expect(page.artifacts.some((row) => row.id === artifactId)).toBe(true);
    expect(page.artifacts.every((row) => row.id < run.artifacts[1].id)).toBe(true);
    await env.DB.prepare(
      "INSERT INTO fetch_run_annotations VALUES (?, 'exclude_from_financial_views', 'synthetic-fixture', 0)",
    )
      .bind(run.id)
      .run();
    expect((await call(`/api/observations/balance/${balance!.id}`)).status).toBe(404);
    expect((await call(`/api/artifacts/${artifactId}`)).status).toBe(404);
    expect((await call(`/api/raw/${run.artifacts[0].sha256}`)).status).toBe(404);
  });
});
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;
beforeAll(async () => {
  await seedRegistry();
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://evidence-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});
async function token(claims: Record<string, unknown> = {}, signingKey = keys.privateKey) {
  return new SignJWT({ type: "app", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(typeof claims.iss === "string" ? claims.iss : issuer)
    .setAudience(typeof claims.aud === "string" ? claims.aud : "fixture-audience")
    .setSubject(typeof claims.sub === "string" ? claims.sub : "synthetic-user")
    .setIssuedAt()
    .setExpirationTime(claims.exp === undefined ? "5m" : (claims.exp as number))
    .sign(signingKey);
}
async function call(
  path: string,
  options: { jwt?: string | null; method?: string; environment?: Record<string, unknown> } = {},
) {
  const jwt = options.jwt === undefined ? await token() : options.jwt;
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method: options.method ?? "GET",
      headers: jwt ? { "cf-access-jwt-assertion": jwt } : {},
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      ...options.environment,
    } as Env,
  );
}
async function catalogueSnapshot() {
  const tables = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
  ).all<{ name: string }>();
  const contents = [];
  for (const { name } of tables.results) {
    const rows = await env.DB.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
    contents.push([name, rows.results]);
  }
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(contents))),
    ),
  );
}

describe("authenticated read-only evidence", () => {
  it("protects API, raw, navigation, and assets without accepting a decoded or absent token", async () => {
    for (const path of [
      `${prefix}/meta`,
      `${prefix}/runs/r_1/artifacts/a_1/raw`,
      "/",
      "/assets/app.js",
    ]) {
      expect((await call(path, { jwt: null })).status).toBe(401);
      expect((await SELF.fetch(`https://fixture.test${path}`)).status).toBe(401);
    }
    // Deliberately unsigned, generated synthetic input; no credential is stored.
    const unsigned = [
      base64url.encode(JSON.stringify({ alg: "none" })),
      base64url.encode(JSON.stringify({ type: "app" })),
      "",
    ].join(".");
    expect((await call(`${prefix}/meta`, { jwt: unsigned })).status).toBe(401);
  });
  it("verifies signature, issuer, audience, expiration, subject and application token type", async () => {
    const other = await generateKeyPair("RS256");
    const invalid = [
      await token({}, other.privateKey),
      await token({ iss: "https://wrong.cloudflareaccess.com" }),
      await token({ aud: "wrong" }),
      await token({ exp: 1 }),
      await token({ sub: "" }),
      await token({ type: "org" }),
    ];
    for (const jwt of invalid) expect((await call(`${prefix}/meta`, { jwt })).status).toBe(401);
    const missingExpiry = await new SignJWT({ type: "app" })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(issuer)
      .setAudience("fixture-audience")
      .setSubject("fixture")
      .setIssuedAt()
      .sign(keys.privateKey);
    expect((await call(`${prefix}/meta`, { jwt: missingExpiry })).status).toBe(401);
    expect((await call(`${prefix}/meta`)).status).toBe(200);
  });
  it("fails closed on missing configuration and distinguishes key provider outages", async () => {
    expect((await call("/", { environment: { ACCESS_ISSUER: "" } })).status).toBe(503);
    expect((await call("/", { environment: { EVIDENCE_SOURCE_ID: "other-test" } })).status).toBe(
      503,
    );
    issuer = "https://unavailable-fixture.cloudflareaccess.com";
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("private upstream body", { status: 503 }),
    );
    const response = await call(`${prefix}/meta`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "identity_keys_unavailable" });
  });
  it("serves honest metadata and authenticated SPA with security headers", async () => {
    const meta = await call(`${prefix}/meta`);
    expect(await meta.json()).toMatchObject({
      source: { kind: "central-raw-store", classification: "financial" },
      capabilities: { parsedObservations: true, liveCollectors: false },
    });
    const response = await call("/evidence/sources/sony-bank");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("synthetic evidence shell");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await call(`${prefix}/missing`)).status).toBe(404);
    expect((await call(`${prefix}/meta`, { method: "POST" })).status).toBe(405);
  });
  it("classifies malformed identity keys as a provider outage rather than invalid credentials", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response("invalid private upstream JSON", { status: 200 }),
    );
    const response = await call(`${prefix}/meta`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "identity_keys_unavailable" });
  });
  it("preserves failed/partial outcomes, count, and timestamp provenance without exposing unsealed/excluded/other source runs", async () => {
    const partial = await seedRun({ outcome: "partial", count: 1 });
    const failed = await seedRun({ outcome: "failed" });
    const hidden = [
      await seedRun({ sealed: false, count: 1 }),
      await seedRun({ excluded: true, count: 1 }),
      await seedRun({ source: "other-test", count: 1 }),
      await seedRun({ source: "kogane-synthetic" }),
    ];
    const response = await call(`${prefix}/sources/sony-bank/runs`);
    const body = (await response.json()) as any;
    expect(body.items.find((r: any) => r.id === `r_${partial.id}`)).toMatchObject({
      outcome: "partial",
      artifactCount: 1,
      startedAt: null,
      startedAtBasis: null,
      completedAtBasis: "manifest",
    });
    expect(body.items.find((r: any) => r.id === `r_${failed.id}`)).toMatchObject({
      outcome: "failed",
      artifactCount: 0,
    });
    for (const run of hidden) {
      expect(body.items.some((r: any) => r.id === `r_${run.id}`)).toBe(false);
      expect((await call(`${prefix}/runs/r_${run.id}/artifacts`)).status).toBe(404);
      if (run.artifacts[0])
        for (const suffix of ["", "/raw"])
          expect(
            (await call(`${prefix}/runs/r_${run.id}/artifacts/a_${run.artifacts[0].id}${suffix}`))
              .status,
          ).toBe(404);
    }
    expect((await call(`${prefix}/sources/other-test/runs`)).status).toBe(404);
    expect(
      (await call(`${prefix}/runs/r_${failed.id}/artifacts/a_${partial.artifacts[0].id}`)).status,
    ).toBe(404);
  });
  it("keeps keyset pages stable when newer runs arrive and rejects invalid cursors", async () => {
    for (let i = 0; i < 51; i++) await seedRun();
    const first = (await (await call(`${prefix}/sources/sony-bank/runs`)).json()) as any;
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toMatch(/^c_/);
    const newest = await seedRun();
    const next = (await (
      await call(`${prefix}/sources/sony-bank/runs?cursor=${first.nextCursor}`)
    ).json()) as any;
    expect(next.items.some((r: any) => r.id === `r_${newest.id}`)).toBe(false);
    expect(next.items.every((r: any) => !first.items.some((f: any) => f.id === r.id))).toBe(true);
    for (const query of [
      "cursor=c_0",
      "cursor=c_01",
      "cursor=c_9007199254740992",
      "cursor=c_1&cursor=c_2",
      "foo=private",
    ])
      expect((await call(`${prefix}/sources/sony-bank/runs?${query}`)).status).toBe(400);
  });
  it("paginates inventory artifacts and returns their immutable descriptor", async () => {
    const run = await seedRun({ count: 51 });
    const first = (await (await call(`${prefix}/runs/r_${run.id}/artifacts`)).json()) as any;
    expect(first.items).toHaveLength(50);
    const second = (await (
      await call(`${prefix}/runs/r_${run.id}/artifacts?cursor=${first.nextCursor}`)
    ).json()) as any;
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const detail = (await (
      await call(`${prefix}/runs/r_${run.id}/artifacts/${second.items[0].id}`)
    ).json()) as any;
    expect(detail.artifact).toMatchObject({
      containerKind: "single",
      lineageDisposition: "not_applicable",
      formatId: null,
      formatVersion: null,
      declaredMediaType: "application/json",
    });
    expect(detail.artifact.descriptorSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("returns original HTML as an attachment, HEAD without bytes, and no DB writes", async () => {
    const html = "<script>synthetic-private-body</script>";
    const run = await seedRun({ count: 1, body: html });
    const before = await catalogueSnapshot();
    let reads = 0;
    const readOnlyDb = {
      prepare(sql: string) {
        expect(sql.trimStart()).toMatch(/^SELECT\b/);
        reads++;
        return env.DB.prepare(sql);
      },
    };
    const environment = { DB: readOnlyDb };
    const path = `${prefix}/runs/r_${run.id}/artifacts/a_${run.artifacts[0].id}/raw`;
    const response = await call(path, { environment });
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(html);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="synthetic-0.json"; filename*=UTF-8''synthetic-0.json`,
    );
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    const head = await call(path, { method: "HEAD", environment });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-disposition")).toBe(
      response.headers.get("content-disposition"),
    );
    expect(await head.text()).toBe("");
    await call(`${prefix}/sources/sony-bank/runs`, { environment });
    await call(`${prefix}/runs/r_${run.id}/artifacts`, { environment });
    await call(path.slice(0, -4), { environment });
    expect(reads).toBeGreaterThan(0);
    expect(await catalogueSnapshot()).toEqual(before);
  });
  it("refuses missing or altered R2 evidence on GET and HEAD", async () => {
    const run = await seedRun({ count: 1, body: "unique integrity fixture" });
    const item = run.artifacts[0];
    const key = `objects/${item.sha256.slice(0, 2)}/${item.sha256}`;
    const path = `${prefix}/runs/r_${run.id}/artifacts/a_${item.id}/raw`;
    await env.EVIDENCE.put(key, "tampered", {
      customMetadata: { sha256: item.sha256, byteSize: String(item.byte_size) },
    });
    for (const method of ["GET", "HEAD"]) expect((await call(path, { method })).status).toBe(409);
    await env.EVIDENCE.delete(key);
    expect((await call(path)).status).toBe(404);
  });
  it("requires native SHA-256 and matching metadata even when the object size matches", async () => {
    const original = "original";
    const run = await seedRun({ count: 1, body: original });
    const item = run.artifacts[0];
    const key = `objects/${item.sha256.slice(0, 2)}/${item.sha256}`;
    const path = `${prefix}/runs/r_${run.id}/artifacts/a_${item.id}/raw`;
    const metadata = { sha256: item.sha256, byteSize: String(item.byte_size) };
    const altered = new TextEncoder().encode("tampered");
    const alteredHash = await crypto.subtle.digest("SHA-256", altered);
    // A same-size payload with a valid checksum for different bytes cannot be
    // disguised using catalogue-matching, caller-controlled custom metadata.
    await env.EVIDENCE.put(key, altered, { sha256: alteredHash, customMetadata: metadata });
    for (const method of ["GET", "HEAD"]) expect((await call(path, { method })).status).toBe(409);
    // Matching bytes and metadata alone are insufficient without R2's checksum.
    await env.EVIDENCE.put(key, original, { customMetadata: metadata });
    for (const method of ["GET", "HEAD"]) expect((await call(path, { method })).status).toBe(409);
    await env.EVIDENCE.put(key, original, {
      sha256: item.sha256,
      customMetadata: { ...metadata, byteSize: "0" },
    });
    for (const method of ["GET", "HEAD"]) expect((await call(path, { method })).status).toBe(409);
    await env.EVIDENCE.put(key, original, { sha256: item.sha256, customMetadata: metadata });
    const response = await call(path);
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(original);
  });
  it("logs only bounded request summaries and survives a throwing logger", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await call(`${prefix}/sources/sony-bank/runs?private-secret=body-secret`);
    expect(response.status).toBe(400);
    const values = logs.mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(values).toHaveLength(1);
    expect(Object.keys(values[0]).sort()).toEqual([
      "durationMs",
      "errorCode",
      "event",
      "requestId",
      "route",
      "status",
    ]);
    expect(JSON.stringify(values)).not.toMatch(/private-secret|body-secret|sony-bank|eyJ/);
    logs.mockImplementation(() => {
      throw new Error("private logger failure");
    });
    expect((await call(`${prefix}/meta`)).status).toBe(200);
  });
  it("distinguishes catalogue and object transport failures without leaking error contents", async () => {
    const run = await seedRun({ count: 1 });
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const failedDb = {
      prepare() {
        throw new Error("private SQL account data");
      },
    };
    const database = await call(`${prefix}/sources/sony-bank/runs`, {
      environment: { DB: failedDb },
    });
    expect(database.status).toBe(503);
    expect(await database.json()).toMatchObject({ error: "catalogue_read_failed" });
    const failedBucket = {
      get() {
        throw new Error("private R2 object data");
      },
      head() {
        throw new Error("private R2 object data");
      },
    };
    for (const method of ["GET", "HEAD"]) {
      const response = await call(
        `${prefix}/runs/r_${run.id}/artifacts/a_${run.artifacts[0].id}/raw`,
        { method, environment: { EVIDENCE: failedBucket } },
      );
      expect(response.status).toBe(503);
    }
    expect(logs.mock.calls.map(([value]) => JSON.parse(String(value)).errorCode)).toEqual([
      "catalogue_read_failed",
      "raw_read_failed",
      "raw_read_failed",
    ]);
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private|SQL|R2 object|account/);
  });
});

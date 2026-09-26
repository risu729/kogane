// `GET /api/v2/reported-state`: behind Access, served to any signed-in reader,
// GET-only, absent where the store lacks the views it joins, bounded, and
// writing nothing. One synthetic SMBC balance snapshot is seeded through the
// ingest Worker; every value is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { reportedStateAvailable } from "../src/reported-state-api";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const PATH = "/api/v2/reported-state";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;
let today = "";

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources (producer_id,source_id) VALUES ('evidence-test','smbc-bank')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test','smbc-bank')",
    ),
  ]);
  const run = await seedRun({ source: "smbc-bank", count: 1, dataset: "balance-normalized" });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'smbc-direct-balance','1','2026-09-11T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.prepare(
    `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,raw_locator,extra_json)
     VALUES(?,'smbc-bank:ordinary-yen','account_balance',4321,'4321',0,'JPY','json:$.balance','{}')`,
  )
    .bind(parse!.id)
    .run();
  const captured = await env.DB.prepare(
    "SELECT fetched_at FROM observation_fetch_artifacts WHERE id=?",
  )
    .bind(run.artifacts[0]!.id)
    .first<{ fetched_at: string }>();
  today = new Date(Date.parse(captured!.fetched_at) + 9 * 3_600_000).toISOString().slice(0, 10);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://reported-state-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

/** A store before CORE 0044: the statement and settlement views are absent. */
function withoutViews(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.includes("sqlite_master") && sql.includes("card_statement_facts")
              ? "SELECT 2 AS present"
              : sql,
          );
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A store past the row bound: the balance read yields one row more than 5,000. */
function overfull(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.includes("CROSS JOIN balance_observations b")
              ? "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5001) SELECT i AS id FROM n WHERE ?1 IS NOT NULL"
              : sql,
          );
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function call(
  path: string,
  options: { subject?: string | null; method?: string; schema?: boolean; full?: boolean } = {},
) {
  const subject = options.subject === undefined ? "synthetic-reader" : options.subject;
  const token =
    subject === null
      ? null
      : await new SignJWT({ type: "app" })
          .setProtectedHeader({ alg: "RS256", kid: "fixture" })
          .setIssuer(issuer)
          .setAudience("fixture-audience")
          .setSubject(subject)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(keys.privateKey);
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method: options.method ?? "GET",
      headers: token ? { "cf-access-jwt-assertion": token } : {},
    }),
    {
      ...env,
      DB:
        options.schema === false ? withoutViews(env.DB) : options.full ? overfull(env.DB) : env.DB,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      OPERATOR_SUBJECTS: '["synthetic-operator"]',
    } as Env,
  );
}

async function counts() {
  return env.DB.prepare(
    `SELECT (SELECT count(*) FROM parse_runs) AS parses,
      (SELECT count(*) FROM balance_observations) AS balances,
      (SELECT count(*) FROM decision_revisions) AS decisions,
      (SELECT count(*) FROM card_settlement_candidates) AS candidates,
      (SELECT source_revision FROM core_source_revision WHERE id=1) AS source_revision`,
  ).first();
}

describe("reported state on a date", () => {
  it("serves a signed-in reader the validated state and writes nothing", async () => {
    const before = await counts();
    const response = await call(`${PATH}?date=${today}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(validApiResponse(PATH, body)).toBe(true);
    expect(body).toMatchObject({
      apiVersion: 2,
      schemaVersion: "reported-state-v1",
      date: today,
      zone: "Asia/Tokyo",
      accounts: [
        {
          sourceId: "smbc-bank",
          sourceAccount: "smbc-bank:ordinary-yen",
          accountId: null,
          identityStatus: "not-recorded",
          snapshots: [{ sourceId: "smbc-bank", ageDays: 0, freshness: "same-day" }],
          balances: [
            {
              providerMetric: "account_balance",
              metric: { metricId: "deposit.balance", aggregationRule: "sum-disjoint" },
              amount: {
                unitRef: "JPY",
                value: { status: "exact", value: { coefficient: "4321" } },
              },
            },
          ],
        },
      ],
      payables: [],
      coverage: { liabilitiesCoverage: "partial", netAssets: "not-computed" },
    });
    // The day before the capture: nothing held, the container named as missing.
    const earlier = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
      .toISOString()
      .slice(0, 10);
    const empty = (await (await call(`${PATH}?date=${earlier}`)).json()) as {
      accounts: unknown[];
      coverage: { containersWithoutSnapshot: { parserName: string }[] };
    };
    expect(empty.accounts).toEqual([]);
    expect(empty.coverage.containersWithoutSnapshot.map((c) => c.parserName)).toContain(
      "smbc-direct-balance",
    );
    expect(await counts()).toEqual(before);
  });

  it("answers any signed-in subject and refuses an anonymous one", async () => {
    expect((await call(`${PATH}?date=${today}`, { subject: null })).status).toBe(401);
    for (const subject of ["synthetic-operator", "another-reader"])
      expect((await call(`${PATH}?date=${today}`, { subject })).status).toBe(200);
  });

  it("is GET-only", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect((await call(`${PATH}?date=${today}`, { method })).status).toBe(405);
    expect((await call(`${PATH}?date=${today}`, { method: "HEAD" })).status).toBe(200);
  });

  it("validates the date and the filters", async () => {
    for (const query of [
      "",
      "?date=",
      "?date=2026-02-30",
      "?date=20260910",
      "?date=2026-09-10&date=2026-09-11",
      "?date=2999-01-01",
      "?date=2026-09-10&offset=0",
      "?date=2026-09-10&source=SMBC",
      "?date=2026-09-10&account=%20x",
    ])
      expect((await call(PATH + query)).status).toBe(400);
    expect((await call(`${PATH}?date=2999-01-01`)).status).toBe(400);
    const filtered = await call(`${PATH}?date=${today}&source=smbc-bank&account=acct-unknown`);
    expect(filtered.status).toBe(200);
    expect(((await filtered.json()) as { accounts: unknown[] }).accounts).toEqual([]);
  });

  it("refuses a read past the row bound with 413 rather than a cut answer", async () => {
    const response = await call(`${PATH}?date=${today}`, { full: true });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "result_limit_exceeded" });
  });

  it("does not exist, and is not advertised, where the store lacks its views", async () => {
    expect((await call(`${PATH}?date=${today}`, { schema: false })).status).toBe(404);
    expect(await reportedStateAvailable(env as Env)).toBe(true);
    expect(await reportedStateAvailable({ ...env, DB: withoutViews(env.DB) } as Env)).toBe(false);
    const meta = async (schema: boolean) =>
      ((await (await call("/api/meta", { schema })).json()) as { capabilities: unknown })
        .capabilities;
    expect(await meta(true)).toMatchObject({ reportedStateOnDate: true });
    expect(await meta(false)).toMatchObject({ reportedStateOnDate: false });
  });
});

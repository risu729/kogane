// `GET /api/collection-quality` and `GET /api/collection-quality/<sourceId>`:
// behind Access, served to any signed-in reader, GET-only, absent where the
// store lacks the scheduling tables, bounded, and writing nothing. One
// synthetic Sony Bank capture is seeded through the ingest Worker; every value
// is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { collectionQualityApi, collectionQualityAvailable } from "../src/collection-quality-api";
import * as agentApi from "../src/agent-api";
import { queryCollectionQualitySummary } from "../../../packages/application/src/query/collection-quality";
import { d1Executor } from "../../../packages/read-model/src/d1";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const PATH = "/api/collection-quality";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;
let runId = 0;

beforeAll(async () => {
  await seedRegistry();
  const run = await seedRun({ source: "sony-bank", count: 1, dataset: "yen-history-page-0001" });
  runId = run.id;
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'sony-bank-history-json','1','2026-09-11T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://collection-quality-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

/** A store before CORE 0065: the scheduling tables are absent. */
function withoutTables(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.includes("sqlite_master") && sql.includes("collection_schedules")
              ? "SELECT 4 AS present"
              : sql,
          );
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function call(
  path: string,
  options: { subject?: string | null; method?: string; schema?: boolean } = {},
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
      DB: options.schema === false ? withoutTables(env.DB) : env.DB,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      OPERATOR_SUBJECTS: '["synthetic-operator"]',
    } as Env,
  );
}

async function counts() {
  return env.DB.prepare(
    `SELECT (SELECT count(*) FROM parse_runs) AS parses,
      (SELECT count(*) FROM collection_schedule_occurrences) AS occurrences,
      (SELECT count(*) FROM collection_execution_leases) AS leases,
      (SELECT count(*) FROM collection_runs) AS runs,
      (SELECT count(*) FROM observation_parse_jobs) AS jobs`,
  ).first();
}

describe("collection quality", () => {
  it("rejects restricted or incapable authority before any schema, source or Alarm enumeration", async () => {
    const prepare = vi.spyOn(env.DB, "prepare");
    const grant = agentApi.readerGrant("synthetic-reader");
    const reader = vi.spyOn(agentApi, "readerGrant");
    const url = new URL(`https://fixture.test${PATH}`);
    for (const scopes of [
      { sources: ["sony-bank"], accounts: "*" as const },
      { sources: "*" as const, accounts: ["synthetic-account"] },
    ]) {
      reader.mockReturnValue({ ...grant, scopes });
      await expect(
        collectionQualityApi(new Request(url), env, url, "synthetic-reader"),
      ).rejects.toMatchObject({ status: 403 });
      expect(prepare).not.toHaveBeenCalled();
    }
    reader.mockReturnValue({ ...grant, capabilities: ["summary.read"] });
    await expect(
      collectionQualityApi(new Request(url), env, url, "synthetic-reader"),
    ).rejects.toMatchObject({ status: 403 });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("only matching configurations receive observed alarms; failures and invalid replies remain unknown", async () => {
    const summary = await queryCollectionQualitySummary(d1Executor(env.DB));
    const schedules = [
      ...summary.sources.flatMap((source) => source.schedules),
      ...summary.otherSchedules,
    ];
    const alarms = schedules.map((schedule) => ({
      id: schedule.id,
      enabled: schedule.enabled,
      nextNominalAt: schedule.nextNominalAt,
      nextRunAt: schedule.nextRunAt,
      alarm: { status: "observed", actualAt: null },
    }));
    const mismatch = alarms.find((alarm) => alarm.id === "vpass")!;
    mismatch.enabled = !mismatch.enabled;
    let mode: "ok" | "failed" | "invalid" = "ok";
    const relay = vi.fn(async (input: RequestInfo | URL) => {
      const request = new Request(input);
      expect(request.method).toBe("GET");
      expect(request.url).toBe(
        "https://observation-pipeline.internal/internal/collection-quality/alarms",
      );
      expect(request.headers.get("x-kogane-internal-caller")).toBe("kogane-evidence-browser");
      if (mode === "failed") throw new Error("synthetic unavailable");
      return Response.json(mode === "invalid" ? { alarms: [], unexpected: true } : { alarms });
    });
    const pipeline = {
      fetch: relay,
      connect() {
        throw new Error("unexpected synthetic connect");
      },
    } satisfies Fetcher;
    const sourceEnv: Env = { ...env, SCHEDULES_ENABLED: "true", PIPELINE: pipeline };
    const url = new URL(`https://fixture.test${PATH}`);
    const before = await counts();
    const read = async () =>
      (await (await collectionQualityApi(
        new Request(url),
        sourceEnv,
        url,
        "synthetic-reader",
      ))!.json()) as typeof summary;
    const observed = await read();
    expect(
      observed.sources.find((source) => source.sourceId === "sony-bank")!.schedules[0]!.alarm,
    ).toEqual({ status: "observed", actualAt: null });
    expect(
      observed.sources.find((source) => source.sourceId === "vpass")!.schedules[0]!.alarm,
    ).toEqual({ status: "unavailable", actualAt: null });
    for (const failing of ["failed", "invalid"] as const) {
      mode = failing;
      const result = await read();
      expect(
        result.sources
          .flatMap((source) => source.schedules)
          .every((schedule) => schedule.alarm.status === "unavailable"),
      ).toBe(true);
    }
    expect(await counts()).toEqual(before);
    expect(relay).toHaveBeenCalledTimes(3);
  });
  it("serves a signed-in reader the validated summary and writes nothing", async () => {
    const before = await counts();
    const response = await call(PATH);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      sources: { sourceId: string; latestFetchRun: { id: number } | null; reasons: string[] }[];
      otherSchedules: { id: string }[];
    };
    expect(validApiResponse(PATH, body)).toBe(true);
    const sony = body.sources.find((source) => source.sourceId === "sony-bank")!;
    expect(sony.latestFetchRun).toMatchObject({ id: runId });
    expect(sony.reasons).toContain("schedule_never_ran");
    // The test-owned synthetic source is never a financial source.
    expect(body.sources.some((source) => source.sourceId === "kogane-synthetic")).toBe(false);
    expect(await counts()).toEqual(before);
  });

  it("serves one source's cells, paged, and refuses what it does not know", async () => {
    const response = await call(`${PATH}/sony-bank`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(validApiResponse(`${PATH}/sony-bank`, body)).toBe(true);
    expect(body).toMatchObject({
      sourceId: "sony-bank",
      cells: [
        {
          dataset: "yen-history-page-0001",
          parser: "sony-bank-history-json",
          state: "current",
          currentRule: "published-eligible",
          newest: { fetchRunId: runId, artifacts: 1, rawStored: 1 },
        },
      ],
      coverage: { limit: 500, truncated: false, nextOffset: null },
    });
    expect((await call(`${PATH}/sony-bank?offset=500`)).status).toBe(200);
    for (const [path, status, code] of [
      [`${PATH}/no-such-source`, 404, "not_found"],
      [`${PATH}/kogane-synthetic`, 404, "not_found"],
      [`${PATH}/Sony_Bank`, 404, "not_found"],
      [`${PATH}/sony-bank/extra`, 404, "not_found"],
      [`${PATH}?source=sony-bank`, 400, "invalid_query"],
      [`${PATH}/sony-bank?offset=-1`, 400, "invalid_offset"],
      [`${PATH}/sony-bank?offset=01`, 400, "invalid_offset"],
      [`${PATH}/sony-bank?offset=1&offset=2`, 400, "invalid_query"],
      [`${PATH}/sony-bank?limit=5`, 400, "invalid_query"],
    ] as const) {
      const refused = await call(path);
      expect(refused.status, path).toBe(status);
      expect(((await refused.json()) as { error: string }).error).toBe(code);
    }
  });

  it("is behind Access, GET-only, and absent from a store without the scheduling tables", async () => {
    expect((await call(PATH, { subject: null })).status).toBe(401);
    expect((await call(PATH, { method: "POST" })).status).toBe(405);
    expect((await call(`${PATH}/sony-bank`, { method: "DELETE" })).status).toBe(405);
    const head = await call(PATH, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await call(PATH, { schema: false })).status).toBe(404);
    expect(await collectionQualityAvailable(env as Env)).toBe(true);
  });

  // Last: it adds configured jobs to this file's store.
  it("refuses more jobs than the bound with 413, never a cut answer", async () => {
    await env.DB.batch(
      Array.from({ length: 201 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by)
           VALUES(?,NULL,'processor',0,1,'UTC','{"kind":"interval","minutes":60}','2099-01-01T00:00:00.000Z','synthetic')`,
        ).bind(`synthetic-${index}`),
      ),
    );
    const refused = await call(PATH);
    expect(refused.status).toBe(413);
    expect(((await refused.json()) as { error: string }).error).toBe("result_limit_exceeded");
    // One source's cells do not read the jobs and are still served.
    expect((await call(`${PATH}/sony-bank`)).status).toBe(200);
  });
});

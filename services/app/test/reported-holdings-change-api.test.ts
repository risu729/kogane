// `GET /api/v2/reported-holdings-change`: behind Access, served to any
// signed-in reader exactly where `/api/v2/reported-state` is, GET-only,
// bounded, with closed refusals, and writing nothing. Two synthetic captures
// of one SBI position container are seeded through the in-process ingest on
// two days (the clock is faked while each is recorded); every account, code
// and quantity is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { reportedHoldingsChangeAvailable } from "../src/reported-holdings-change-api";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const PATH = "/api/v2/reported-holdings-change";
/** The request clock: 12:00 on 2026-09-10 in Tokyo. */
const NOW = "2026-09-10T03:00:00.000Z";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

/** One capture of the domestic positions container, recorded at `at`. */
async function capture(at: string, positions: [code: string, quantity: string][]) {
  vi.setSystemTime(new Date(at));
  const run = await seedRun({
    source: "sbi-securities",
    count: 1,
    dataset: "domestic-cash-positions",
  });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'sbi-domestic-cash-positions','1','2026-09-01T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.batch(
    positions.map(([code, quantity], index) =>
      env.DB.prepare(
        `INSERT INTO position_observations(parse_run_id,source_account,security_code,security_name,market,quantity_text,quantity_scale,currency,as_of,observed_at,raw_locator,extra_json)
         VALUES(?,'sbi-synthetic',?,NULL,NULL,?,0,'JPY',NULL,NULL,?,'{}')`,
      ).bind(parse!.id, code, quantity, `$.positions[${index}]`),
    ),
  );
}

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources (producer_id,source_id) VALUES ('evidence-test','sbi-securities')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test','sbi-securities')",
    ),
  ]);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // After the fixture run's own start time (2026-09-02T04:38Z), which the seal checks.
    await capture("2026-09-03T03:00:00.000Z", [
      ["1001", "10"],
      ["1002", "3"],
    ]);
    await capture("2026-09-09T03:00:00.000Z", [
      ["1001", "12.5"],
      ["1003", "0.25"],
    ]);
  } finally {
    vi.useRealTimers();
  }
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://holdings-change-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

/** A store past the reported state's row bound: the balance read yields 5,001 rows. */
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
      (SELECT count(*) FROM position_observations) AS positions,
      (SELECT count(*) FROM observation_decimal_values) AS decimals,
      (SELECT count(*) FROM decision_revisions) AS decisions,
      (SELECT source_revision FROM core_source_revision WHERE id=1) AS source_revision`,
  ).first();
}

const RANGE = "?from=2026-09-03&to=2026-09-10";

describe("reported holdings change between two dates", () => {
  it("serves a signed-in reader the validated change per holding and writes nothing", async () => {
    const before = await counts();
    const response = await call(PATH + RANGE);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      holdings: { key: { securityCode: string }; status: string; change: unknown }[];
    } & Record<string, unknown>;
    expect(validApiResponse(PATH, body)).toBe(true);
    expect(body).toMatchObject({
      apiVersion: 2,
      schemaVersion: "reported-holdings-change-v1",
      policy: "holdings-change-v1",
      zone: "Asia/Tokyo",
      from: "2026-09-03",
      to: "2026-09-10",
      filters: { source: null, account: null },
      quantityPolicy: "decimal-v1",
      counts: { compared: 1, listed_at_start_only: 1, listed_at_end_only: 1, not_comparable: 0 },
      coverage: { total: "not-computed", valuation: "not-computed" },
    });
    const byCode = Object.fromEntries(
      body.holdings.map((entry) => [entry.key.securityCode, entry]),
    );
    expect(byCode["1001"]).toMatchObject({
      status: "compared",
      start: { state: "listed", quantityText: "10" },
      end: { state: "listed", quantityText: "12.5" },
      change: {
        unitRef: "instrument:sbi-securities:-:1001",
        value: { status: "exact", value: { coefficient: "25", scale: 1 } },
      },
    });
    // One date only: a status and no figure, never a zero.
    expect(byCode["1002"]).toMatchObject({
      status: "listed_at_start_only",
      end: { state: "not_listed" },
      change: null,
    });
    expect(byCode["1003"]).toMatchObject({
      status: "listed_at_end_only",
      start: { state: "not_listed" },
      change: null,
    });
    // Before the first capture the container has no snapshot: a reason, not an absence.
    const early = (await (await call(`${PATH}?from=2026-09-02&to=2026-09-03`)).json()) as {
      holdings: { status: string; reasons: string[]; change: unknown }[];
    };
    expect(validApiResponse(PATH, early)).toBe(true);
    expect(early.holdings.map((entry) => [entry.status, entry.reasons, entry.change])).toEqual([
      ["not_comparable", ["no_snapshot_at_start"], null],
      ["not_comparable", ["no_snapshot_at_start"], null],
    ]);
    // Narrowed to the source, the answer is the same holdings and still valid.
    const narrowed = await call(`${PATH}${RANGE}&source=sbi-securities`);
    expect(narrowed.status).toBe(200);
    const narrowedBody = (await narrowed.json()) as { holdings: unknown[] };
    expect(validApiResponse(PATH, narrowedBody)).toBe(true);
    expect(narrowedBody.holdings).toHaveLength(3);
    expect(await counts()).toEqual(before);
  });

  it("answers any signed-in subject and refuses an anonymous one", async () => {
    expect((await call(PATH + RANGE, { subject: null })).status).toBe(401);
    for (const subject of ["synthetic-operator", "another-reader"])
      expect((await call(PATH + RANGE, { subject })).status).toBe(200);
  });

  it("is GET-only", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect((await call(PATH + RANGE, { method })).status).toBe(405);
    expect((await call(PATH + RANGE, { method: "HEAD" })).status).toBe(200);
  });

  it("refuses a bad, repeated or unknown parameter, a bad range and a future date with closed codes", async () => {
    const cases: [query: string, status: number, code: string][] = [
      ["", 400, "invalid_date"],
      ["?from=2026-09-03", 400, "invalid_date"],
      ["?to=2026-09-10", 400, "invalid_date"],
      ["?from=2026-02-30&to=2026-09-10", 400, "invalid_date"],
      ["?from=2026-09-03&to=2026-09-31", 400, "invalid_date"],
      ["?from=20260901&to=2026-09-10", 400, "invalid_date"],
      ["?from=&to=2026-09-10", 400, "invalid_query"],
      [`${RANGE}&from=2026-09-04`, 400, "invalid_query"],
      [`${RANGE}&date=2026-09-10`, 400, "invalid_query"],
      [`${RANGE}&offset=0`, 400, "invalid_query"],
      [`${RANGE}&source=SBI`, 400, "invalid_query"],
      [`${RANGE}&account=%20x`, 400, "invalid_query"],
      ["?from=2026-09-10&to=2026-09-10", 400, "invalid_range"],
      ["?from=2026-09-10&to=2026-09-03", 400, "invalid_range"],
      // Tomorrow in Tokyo has no reported state yet.
      ["?from=2026-09-03&to=2026-09-11", 400, "date_in_future"],
      ["?from=2026-09-03&to=2999-01-01", 400, "date_in_future"],
      [`${RANGE}&source=no-such-source`, 404, "unknown_source"],
      [`${RANGE}&account=acct-unknown`, 404, "unknown_account"],
    ];
    for (const [query, status, code] of cases) {
      const response = await call(PATH + query);
      expect([query, response.status]).toEqual([query, status]);
      expect([query, ((await response.json()) as { error: string }).error]).toEqual([query, code]);
    }
  });

  it("refuses a read past the row bound with 413 rather than a cut answer", async () => {
    const response = await call(PATH + RANGE, { full: true });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: "result_limit_exceeded",
      refs: ["dated_state_limit_exceeded"],
    });
  });

  it("does not exist where the store lacks the reported state's views", async () => {
    expect((await call(PATH + RANGE, { schema: false })).status).toBe(404);
    expect(await reportedHoldingsChangeAvailable(env as Env)).toBe(true);
    expect(await reportedHoldingsChangeAvailable({ ...env, DB: withoutViews(env.DB) } as Env)).toBe(
      false,
    );
  });
});

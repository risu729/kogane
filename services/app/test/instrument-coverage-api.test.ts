// Per-source instrument resolution counts over the real Worker, the real CORE
// migrations and the production identity writer: `GET
// /api/identity/instrument-coverage` (ADR 0073). A synthetic SBI Securities
// capture holds one code on a mapped venue and trades it on a venue the SBI
// rule does not map, so its two identifiers wait on one proposed candidate.
// Every value is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import { identifyParse } from "../../processor/src/identity-store";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const PATH = "/api/identity/instrument-coverage";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

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
  const artifactId = (await seedRun({ count: 1, source: "sbi-securities" })).artifacts[0]!.id;
  const parse = await env.DB.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES (?,'coverage-fixture','1','2099-01-01','ok','[]') RETURNING id`)
    .bind(artifactId)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO position_observations
      (parse_run_id,source_account,security_code,security_name,market,currency,quantity_text,quantity_scale,raw_locator,extra_json)
      VALUES (?,'sbi-securities:domestic','SYN7101','Synthetic Seventy','TKY','JPY','1',0,'synthetic','{}')`).bind(
      parse!.id,
    ),
    env.DB.prepare(`INSERT INTO transaction_observations
      (parse_run_id,source_account,currency,raw_locator,extra_json)
      VALUES (?,'sbi-securities:domestic','JPY','synthetic',?)`).bind(
      parse!.id,
      JSON.stringify({
        issueCode: "SYN7101",
        issueName: "Synthetic Seventy",
        marketLabel: "SYNTHETIC-VENUE",
        accountLabel: "synthetic",
      }),
    ),
  ]);
  const verified =
    await env.DB.prepare(`SELECT p.id,a.id artifact_id,a.source_id,r.producer_id,a.fetch_run_id
    FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
    JOIN financial_fetch_runs r ON r.id=a.fetch_run_id WHERE p.id=?`)
      .bind(parse!.id)
      .first<{
        id: number;
        artifact_id: number;
        source_id: string;
        producer_id: string;
        fetch_run_id: number;
      }>();
  while (await identifyParse(env.DB, verified!, resolveIdentity)) {
    // Resume the production writer's bounded pages until the run is sealed.
  }
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://instrument-coverage-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

async function call(query = "", method = "GET", authenticated = true) {
  const token = authenticated
    ? await new SignJWT({ type: "app" })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .setIssuer(issuer)
        .setAudience("fixture-audience")
        .setSubject("synthetic-reader")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey)
    : null;
  return worker.fetch(
    new Request(`https://fixture.test${PATH}${query}`, {
      method,
      headers: token ? { "cf-access-jwt-assertion": token } : {},
    }),
    { ...env, ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: "fixture-audience" } as Env,
  );
}

/** Every table's row count, so "writes nothing" is checkable. */
async function tables() {
  const names = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
  ).all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of names.results)
    counts[name] = (await env.DB.prepare(`SELECT count(*) AS n FROM "${name}"`).first<number>(
      "n",
    ))!;
  return counts;
}

describe("GET /api/identity/instrument-coverage", () => {
  it("counts each source's identifiers by candidate state and writes nothing", async () => {
    const before = await tables();
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(validApiResponse(PATH, body)).toBe(true);
    expect(body).toEqual({
      schemaVersion: "kogane-instrument-coverage-v1",
      policy: "instrument-candidates-v1",
      query: { source: null },
      rows: [
        {
          source: "sbi-securities",
          identifiers: 2,
          states: {
            "unresolved-candidates": 2,
            "resolved-by-decision": 0,
            "shared-without-decision": 0,
            "kept-separate": 0,
            "no-candidate": 0,
          },
        },
      ],
    });
    expect((await call("", "HEAD")).status).toBe(200);
    expect(await tables()).toEqual(before);
  });

  it("filters by source; a source with no identifier in scope has no row", async () => {
    expect(await (await call("?source=sbi-securities")).json()).toMatchObject({
      query: { source: "sbi-securities" },
      rows: [{ source: "sbi-securities", identifiers: 2 }],
    });
    const absent = await (await call("?source=sony-bank")).json();
    expect(absent).toMatchObject({ query: { source: "sony-bank" }, rows: [] });
    expect(validApiResponse(PATH, absent)).toBe(true);
  });

  it("is Access-gated and GET-only, and refuses an unknown, repeated or malformed parameter", async () => {
    expect((await call("", "GET", false)).status).toBe(401);
    expect((await call("", "POST")).status).toBe(405);
    for (const query of [
      "?offset=0",
      "?identityRead=as-recorded",
      "?source=",
      "?source=a&source=b",
      `?source=${"x".repeat(129)}`,
      "?source=a%01",
    ]) {
      const response = await call(query);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_query" });
    }
  });
});

// The production Worker and the hosted synthetic demo run the same
// conformance checks as the local store experiment
// (experiments/observation-pipeline-local/test/api-conformance.test.ts); both
// import the checks from packages/observation-shared/test-support.
// Authentication is exercised by the fixture JWT below and is never a
// capability: the checks only run authenticated.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import snapshot from "../demo-snapshot.json";
import demo from "../src/demo-worker";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import {
  CENTRAL_STORE_CAPABILITIES,
  LIST_REQUEST_SCHEMA,
  LOCAL_STORE_CAPABILITIES,
} from "../../../packages/observation-shared/src/api-schema";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import {
  CONFORMANCE_CHECKS,
  type ConformanceTarget,
} from "../../../packages/observation-shared/test-support/api-conformance";

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
  // One visible observation row and its artifact, so row-level checks are not vacuous.
  const run = await seedRun({ count: 1 });
  const parse = await env.DB.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES (?,'conformance-fixture','1','2026-09-07','ok','[]') RETURNING id`)
    .bind(run.artifacts[0].id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.prepare(`INSERT INTO transaction_observations
    (parse_run_id,source_account,external_id,as_of,amount_minor,currency,raw_locator,extra_json)
    VALUES (?,'conformance-account','1','2026-09-07',1,'JPY','$','{}')`)
    .bind(parse!.id)
    .run();
});
beforeEach(() => {
  issuer = `https://conformance-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

async function token(audience: string) {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("synthetic-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}
const assets = { fetch: async () => new Response("synthetic shell") } as unknown as Env["ASSETS"];

const production: ConformanceTarget = {
  expected: CENTRAL_STORE_CAPABILITIES,
  get: async (path, method = "GET") =>
    worker.fetch(
      new Request(`https://fixture.test${path}`, {
        method,
        headers: { "cf-access-jwt-assertion": await token("fixture-audience") },
      }),
      { ...env, ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: "fixture-audience" } as Env,
    ),
};
const hostedDemo: ConformanceTarget = {
  expected: LOCAL_STORE_CAPABILITIES,
  get: async (path, method = "GET") =>
    demo.fetch(
      new Request(`https://demo.test${path}`, {
        method,
        headers: { "cf-access-jwt-assertion": await token("demo-audience") },
      }),
      { ACCESS_ISSUER: issuer, ACCESS_AUDIENCE: "demo-audience", ASSETS: assets },
    ),
};

describe("observation API conformance: production evidence-browser worker", () => {
  for (const check of CONFORMANCE_CHECKS) it(check.name, () => check.run(production));
  it("rejects every schema parameter without credentials before any capability applies", async () => {
    for (const [path, schema] of Object.entries(LIST_REQUEST_SCHEMA)) {
      for (const name of Object.keys(schema)) {
        const response = await worker.fetch(new Request(`https://fixture.test${path}?${name}=x`), {
          ...env,
          ACCESS_ISSUER: issuer,
          ACCESS_AUDIENCE: "fixture-audience",
        } as Env);
        expect(response.status, path).toBe(401);
      }
    }
  });
});

describe("observation API conformance: hosted synthetic demo", () => {
  for (const check of CONFORMANCE_CHECKS) it(check.name, () => check.run(hostedDemo));
  it("serves the metadata object the export produced, byte for byte", async () => {
    const exported = snapshot.responses["/api/meta"]!;
    const expected = JSON.parse(atob(exported.bodyBase64)) as unknown;
    expect(validApiResponse("/api/meta", expected)).toBe(true);
    expect(expected).toEqual({
      apiVersion: 1,
      source: { kind: "local-store", classification: "synthetic" },
      capabilities: LOCAL_STORE_CAPABILITIES,
    });
    const served = await hostedDemo.get("/api/meta");
    expect(await served.text()).toBe(atob(exported.bodyBase64));
  });
});

describe("shared contract pin", () => {
  it("matches the request schema pinned in the frontend package", () => {
    expect(LIST_REQUEST_SCHEMA).toEqual({
      "/api/transactions": {
        source: "collectionFilters",
        account: "collectionFilters",
        from: "collectionFilters",
        to: "collectionFilters",
        q: "collectionFilters",
        offset: "paginationVersion:offset-v1",
        identityRead: "identityReadModes",
      },
      "/api/balances": {
        source: "collectionFilters",
        account: "collectionFilters",
        instrument: "collectionFilters",
        metric: "collectionFilters",
        view: "measureViews",
        offset: "paginationVersion:offset-v1",
        latestOffset: "paginationVersion:offset-v1",
        identityRead: "identityReadModes",
      },
      "/api/positions": {
        source: "collectionFilters",
        account: "collectionFilters",
        offset: "paginationVersion:offset-v1",
        identityRead: "identityReadModes",
      },
      "/api/artifacts": { source: "collectionFilters", cursor: "paginationVersion:offset-v1" },
      "/api/filter-options": { kind: "collectionFilters", view: "measureViews" },
      "/api/v2/balances/latest": {
        source: "collectionFilters",
        account: "collectionFilters",
        instrument: "collectionFilters",
        metric: "collectionFilters",
        view: "measureViews",
        identityRead: "identityReadModes",
        cursor: "balancesV2",
        limit: "balancesV2",
      },
      "/api/v2/balances/history": {
        source: "collectionFilters",
        account: "collectionFilters",
        instrument: "collectionFilters",
        metric: "collectionFilters",
        view: "measureViews",
        identityRead: "identityReadModes",
        cursor: "balancesV2",
        limit: "balancesV2",
      },
    });
    expect(CENTRAL_STORE_CAPABILITIES).toEqual({
      contractVersion: "observation-api-v1",
      readOnly: true,
      rawEvidence: true,
      liveCollectors: false,
      measureViews: ["balances", "summaries"],
      identityReadModes: ["latest", "as-recorded"],
      paginationVersion: "offset-v1",
      balancesV2: false,
      balancesV2Pagination: "none",
      collectionFilters: true,
      organizedDisplay: true,
      financialProducts: true,
      evidenceHistory: true,
      sharedQuery: true,
      // rewardsV2, commands and eventsV2 are default off here: each
      // deployment's own flag decides, and /api/meta reports what the
      // running Worker actually serves.
      rewardsV2: false,
      commands: false,
      eventsV2: false,
    });
  });
});

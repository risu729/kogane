// The instrument candidate review over the real Worker, the real CORE
// migrations and the production identity writer: `GET
// /api/identity/instrument-candidates` for the browser and
// `kogane.instruments.candidates` for an agent answer one page of one read
// (ADR 0055, amendment 2026-10-09). A synthetic SBI Securities capture holds
// one code on a mapped venue and trades it on a venue the SBI rule does not
// map, so the two identifiers are a proposed candidate. Every value is
// invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { validInstrumentCandidateReview } from "../../../packages/observation-shared/src/instrument-candidates-contract";
import { identifyParse } from "../../processor/src/identity-store";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const PATH = "/api/identity/instrument-candidates";
const AGENT_PATH = "/api/agent/v1/instruments.candidates";
const FULL_GRANT = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read"],
  budget: { maxRows: 500, maxProposalTargets: 5, maxExplainDepth: 3 },
};
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
    VALUES (?,'candidate-fixture','1','2099-01-01','ok','[]') RETURNING id`)
    .bind(artifactId)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO position_observations
      (parse_run_id,source_account,security_code,security_name,market,currency,quantity_text,quantity_scale,raw_locator,extra_json)
      VALUES (?,'sbi-securities:domestic','SYN7001','Synthetic Seven','TKY','JPY','1',0,'synthetic','{}')`).bind(
      parse!.id,
    ),
    env.DB.prepare(`INSERT INTO transaction_observations
      (parse_run_id,source_account,currency,raw_locator,extra_json)
      VALUES (?,'sbi-securities:domestic','JPY','synthetic',?)`).bind(
      parse!.id,
      JSON.stringify({
        issueCode: "SYN7001",
        issueName: "Synthetic Seven",
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
  issuer = `https://instrument-candidates-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

interface CallOptions {
  method?: string;
  body?: unknown;
  subject?: string | null;
  grants?: Record<string, unknown>;
}

async function call(path: string, options: CallOptions = {}) {
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
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: token ? { "cf-access-jwt-assertion": token } : {},
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return worker.fetch(new Request(`https://fixture.test${path}`, init), {
    ...env,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "fixture-audience",
    OPERATOR_SUBJECTS: '["synthetic-operator"]',
    AGENT_GRANTS: '["synthetic-agent"]',
    AGENT_API_GRANTS: JSON.stringify(options.grants ?? { "synthetic-agent": FULL_GRANT }),
  } as Env);
}

async function mcp(message: Record<string, unknown>, options: CallOptions = {}) {
  const response = await call("/mcp", {
    subject: "synthetic-agent",
    ...options,
    body: { jsonrpc: "2.0", id: 1, ...message },
  });
  return (await response.json()) as Record<string, any>;
}

/**
 * Every table's row count, so "writes nothing" is checkable — but for the
 * audit tables: an agent call's own audit record (ADR 0064) is the one write
 * it makes, and `test/audit.test.ts` covers it.
 */
async function tables() {
  const names = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name",
  ).all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of names.results.filter(
    ({ name }) => name !== "audit_records" && name !== "audit_overflow_counters",
  ))
    counts[name] = (await env.DB.prepare(`SELECT count(*) AS n FROM "${name}"`).first<number>(
      "n",
    ))!;
  return counts;
}

describe("GET /api/identity/instrument-candidates", () => {
  it("serves one page of the candidate read to a signed-in reader and writes nothing", async () => {
    const before = await tables();
    const response = await call(PATH);
    expect(response.status).toBe(200);
    const page = (await response.json()) as Record<string, any>;
    expect(page).toMatchObject({
      schemaVersion: "kogane-instrument-candidates-v1",
      query: { view: "open", offset: 0, identifierId: null },
      decisions: "change-lifecycle",
      total: 1,
      nextOffset: null,
      manifest: { policy: "instrument-candidates-v1", bounds: { pageSize: 50 } },
    });
    expect(validInstrumentCandidateReview(page)).toBe(true);
    const [candidate] = page["items"];
    expect(candidate).toMatchObject({
      status: "proposed",
      hold: null,
      evidence: ["security-code-equal"],
      crossSource: false,
    });
    expect(candidate.gaps).toContain("market-unconfirmed");
    expect(candidate.commands.adopt).toMatchObject({
      kind: "identity.assign",
      payload: { subject: "instrument", referenceId: candidate.subjectIdentifierId },
    });
    expect(candidate.commands.keepApart).toMatchObject({
      kind: "relation.reject",
      payload: { relationKind: "listed_as", toRef: `identifier:${candidate.subjectIdentifierId}` },
    });
    expect(page["identifiers"].map((row: { identifierId: string }) => row.identifierId)).toEqual(
      [candidate.anchorIdentifierId, candidate.subjectIdentifierId].sort(),
    );
    expect(await tables()).toEqual(before);
  });

  it("serves the other views and one identifier's pairs", async () => {
    const separated = await call(`${PATH}?view=separated`);
    expect(await separated.json()).toMatchObject({ items: [], total: 0 });
    const open = (await (await call(PATH)).json()) as Record<string, any>;
    const subject = open["items"][0].subjectIdentifierId as string;
    const filtered = (await (
      await call(`${PATH}?identifierId=${subject}&offset=0`)
    ).json()) as Record<string, any>;
    expect(filtered["items"]).toEqual(open["items"]);
  });

  it("refuses an unknown or repeated parameter and a malformed value", async () => {
    for (const [query, code] of [
      ["?source=sbi-securities", "invalid_query"],
      ["?view=open&view=held", "invalid_query"],
      ["?view=all", "invalid_query"],
      ["?offset=-1", "invalid_offset"],
      ["?offset=abc", "invalid_offset"],
      ["?offset=5001", "invalid_query"],
      ["?identifierId=a%20b", "invalid_query"],
    ] as const) {
      const response = await call(`${PATH}${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: code });
    }
  });

  it("is Access-gated, GET-only, and bounded by the reader grant's rows", async () => {
    expect((await call(PATH, { subject: null })).status).toBe(401);
    expect((await call(PATH, { method: "POST", body: {} })).status).toBe(405);
    const deep = await call(`${PATH}?offset=1000`);
    expect(deep.status).toBe(413);
    expect(await deep.json()).toMatchObject({
      code: "budget_exceeded",
      refs: ["budget:maxRows=1000"],
    });
    const unknown = await call(`${PATH}?identifierId=ii_unknown`);
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toMatchObject({
      code: "evidence_restricted",
      refs: ["identifierId"],
    });
  });
});

describe("kogane.instruments.candidates", () => {
  it("is listed and answers the same page over HTTP and MCP", async () => {
    const listed = await mcp({ method: "tools/list" });
    expect(listed["result"].tools.map((tool: { name: string }) => tool.name)).toContain(
      "kogane.instruments.candidates",
    );
    const overRoute = await (await call(PATH)).json();
    const overAgent = await call(AGENT_PATH, { subject: "synthetic-agent", body: {} });
    expect(overAgent.status).toBe(200);
    expect(await overAgent.json()).toEqual(overRoute);
    const overMcp = await mcp({
      method: "tools/call",
      params: { name: "kogane.instruments.candidates", arguments: { view: "open" } },
    });
    expect(overMcp["result"].isError).toBe(false);
    expect(overMcp["result"].structuredContent).toEqual(overRoute);
  });

  it("is graded by the agent's grant: records.read over the whole store", async () => {
    const before = await tables();
    const none = await call(AGENT_PATH, { subject: "synthetic-other", body: {} });
    expect(none.status).toBe(403);
    expect(await none.json()).toMatchObject({ error: "agent_api_not_configured" });
    const summary = await call(AGENT_PATH, {
      subject: "synthetic-agent",
      body: {},
      grants: { "synthetic-agent": { ...FULL_GRANT, capabilities: ["summary.read"] } },
    });
    expect(summary.status).toBe(403);
    expect(await summary.json()).toMatchObject({
      code: "unauthorized",
      refs: ["capability:records.read"],
    });
    const listed = await call(AGENT_PATH, {
      subject: "synthetic-agent",
      body: {},
      grants: {
        "synthetic-agent": {
          ...FULL_GRANT,
          scopes: { sources: ["sbi-securities"], accounts: "*" },
        },
      },
    });
    expect(listed.status).toBe(403);
    expect(await listed.json()).toMatchObject({
      code: "evidence_restricted",
      refs: ["scope:source"],
    });
    const unknownKey = await call(AGENT_PATH, {
      subject: "synthetic-agent",
      body: { source: "x" },
    });
    expect(unknownKey.status).toBe(400);
    expect(await unknownKey.json()).toMatchObject({ code: "unsupported_semantics" });
    expect(await tables()).toEqual(before);
  });
});

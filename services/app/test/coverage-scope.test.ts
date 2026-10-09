// The `coverage` intent's counts stay inside the caller's scope, over the real
// Worker, the real read model and a synthetic store, on both agent transports:
// `/mcp` (an `mcp-client:<sub>` through the MCP Access application) and
// `/api/agent/v1/financial.query` (a browser session's subject).
//
// The intent used to count each in-scope source's runs inside the overview's
// newest-501-runs window, which is taken across every source. A source outside
// the grant that then recorded more than 501 runs pushed the granted source's
// runs out of that window: its `collectionRunCount` fell to 0 under the same
// `contextId` and a `complete` answer, so a denied source's activity was
// readable through an in-scope answer. These checks record a full answer,
// write 520 sealed runs for a source outside the scope, ask again, and require
// the same bytes: contextId, resolvedQuery, result, resultRef and every count.
// Every principal, audience, source and run below is synthetic.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const APP_AUD = "fixture-app-audience";
const MCP_AUD = "fixture-mcp-audience";
const SUBJECT = "00000000-0000-4000-8000-0000000000cc";
const AGENT = `mcp-client:${SUBJECT}`;
const ALLOWED = "sony-bank";
const DENIED = "other-test";
/** More sealed runs than the overview's 501-run window holds. */
const DENIED_RUNS = 520;
const BUDGET = { maxRows: 200, maxProposalTargets: 5, maxExplainDepth: 4 };

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let issuer: string;
let sequence = 0;
let rpcId = 0;

beforeAll(async () => {
  await seedRegistry();
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
  // One sealed run with one artifact for each source.
  for (const source of [ALLOWED, DENIED]) await seedRun({ count: 1, source });
});
beforeEach(() => {
  issuer = `https://coverage-scope-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
  // One evaluation clock for every request of a test, so `now` cannot move a context.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function grantTable(sources: "*" | string[]): Record<string, string> {
  const grant = {
    scopes: { sources, accounts: "*" },
    capabilities: ["summary.read"],
    budget: BUDGET,
  };
  return { AGENT_API_GRANTS: JSON.stringify({ [AGENT]: grant, [SUBJECT]: grant }) };
}

async function assertion(audience: string): Promise<string> {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(SUBJECT)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string>,
  environment: Record<string, string>,
): Promise<Response> {
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: APP_AUD,
      ACCESS_MCP_AUDIENCE: MCP_AUD,
      ...environment,
    } as Env,
  );
}

/** The coverage answer over HTTP, as the exact response text. */
async function overHttp(query: unknown, environment: Record<string, string>): Promise<string> {
  const response = await post(
    "/api/agent/v1/financial.query",
    query,
    { "cf-access-jwt-assertion": await assertion(APP_AUD) },
    environment,
  );
  expect(response.status).toBe(200);
  return response.text();
}

/** The coverage answer over `/mcp` (2025-11-25 transport), as the tool's exact JSON text. */
async function overMcp(query: unknown, environment: Record<string, string>): Promise<string> {
  const response = await post(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name: "kogane.financial.query", arguments: query },
    },
    {
      ...MCP_CLIENT_HEADERS,
      "mcp-protocol-version": "2025-11-25",
      "cf-access-jwt-assertion": await assertion(MCP_AUD),
    },
    environment,
  );
  expect(response.status).toBe(200);
  const message = (await response.json()) as {
    result: { isError: boolean; structuredContent: unknown; content: { text: string }[] };
  };
  expect(message.result.isError).toBe(false);
  expect(message.result.content[0]!.text).toBe(JSON.stringify(message.result.structuredContent));
  return message.result.content[0]!.text;
}

/**
 * `count` sealed runs of `source`, written as the ingest Worker writes one —
 * session, run, inventory, terminal report, seal — with no artifact and no
 * parse, so nothing but the run history changes.
 */
async function sealedRuns(source: string, count: number): Promise<void> {
  const base = await env.DB.prepare(
    `SELECT max((SELECT coalesce(max(id),0) FROM acquisition_sessions),
                (SELECT coalesce(max(id),0) FROM fetch_runs),
                (SELECT coalesce(max(id),0) FROM run_inventories)) AS n`,
  ).first<{ n: number }>();
  const offset = base!.n + 1;
  const numbers = `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?2)`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO acquisition_sessions(id,producer_id,first_recorded_by_client_id,external_id_namespace,external_session_id,first_recorded_at_ms)
       ${numbers} SELECT ?1 + i,'evidence-test','evidence-test','coverage-scope','coverage-scope-' || (?1 + i),1767225600000 + i FROM n`,
    ).bind(offset, count),
    env.DB.prepare(
      `INSERT INTO fetch_runs(id,acquisition_session_id,producer_id,source_id,first_recorded_by_client_id,source_run_key,first_recorded_at_ms)
       ${numbers} SELECT ?1 + i,?1 + i,'evidence-test',?3,'evidence-test','default',1767225600000 + i FROM n`,
    ).bind(offset, count, source),
    env.DB.prepare(
      `INSERT INTO run_inventories(id,fetch_run_id,inventory_sha256,expected_artifact_count,declaration_basis,created_at_ms,created_by_client_id)
       ${numbers} SELECT ?1 + i,?1 + i,printf('%064x',?1 + i),0,'operator',1767225600000 + i,'evidence-test' FROM n`,
    ).bind(offset, count),
    env.DB.prepare(
      `INSERT INTO fetch_run_reports(fetch_run_id,report_key,report_kind,recorded_by_client_id,normalized_outcome,
         started_at_ms,started_at_basis,completed_at_ms,completed_at_basis,recorded_at_ms)
       ${numbers} SELECT ?1 + i,'terminal','terminal','evidence-test','success',
         1767225600000 + i,'manifest',1767225600000 + i,'manifest',1767225600000 + i FROM n`,
    ).bind(offset, count),
    env.DB.prepare(
      `INSERT INTO fetch_run_seals(inventory_id,fetch_run_id,sealed_at_ms,sealed_by_client_id)
       ${numbers} SELECT ?1 + i,?1 + i,1767225600000 + i,'evidence-test' FROM n`,
    ).bind(offset, count),
  ]);
  const visible = await env.DB.prepare(
    "SELECT count(*) AS n FROM observation_fetch_runs WHERE source_id = ?",
  )
    .bind(source)
    .first<{ n: number }>();
  expect(visible!.n).toBeGreaterThan(501);
}

interface QueryResponse {
  contextId: string;
  resultRef: string;
  result: {
    contextId: string;
    resolvedQuery: unknown;
    completeness: string;
    data: {
      scopes: { sourceRef: string; collectionRunCount: number }[];
      collectionRunCount: number;
    };
  };
}

/** Ask both transports, before and after the out-of-scope source's runs. */
async function beforeAndAfter(
  query: Record<string, unknown>,
  environment: Record<string, string>,
): Promise<{ before: string[]; after: string[] }> {
  const before = [await overHttp(query, environment), await overMcp(query, environment)];
  await sealedRuns(DENIED, DENIED_RUNS);
  const after = [await overHttp(query, environment), await overMcp(query, environment)];
  return { before, after };
}

describe("coverage counts stay inside the scope (out-of-scope activity side channel)", () => {
  it("a denied source's runs past the window leave the granted source's coverage answer byte-identical, over HTTP and MCP", async () => {
    const environment = grantTable([ALLOWED]);
    const { before, after } = await beforeAndAfter({ intent: "coverage" }, environment);
    expect(after).toEqual(before);
    for (const text of [...before, ...after]) {
      const answer = JSON.parse(text) as QueryResponse;
      expect(answer.result.completeness).toBe("complete");
      expect(answer.result.contextId).toBe(answer.contextId);
      expect(answer.resultRef).toMatch(/^result:[0-9a-f]{64}$/u);
      expect(answer.result.data.scopes).toEqual([
        expect.objectContaining({ sourceRef: ALLOWED, collectionRunCount: 1 }),
      ]);
      expect(answer.result.data.collectionRunCount).toBe(1);
      // Nothing in the answer names the denied source.
      expect(text).not.toContain(DENIED);
    }
    // One answer on both transports, contexts and refs included.
    expect(before[1]).toBe(before[0]);
  });

  for (const [name, sources] of [
    ["every source", "*"],
    ["a list naming both sources", [ALLOWED, DENIED]],
  ] as const)
    it(`a source filter narrower than a grant of ${name} ignores a busy granted source outside it`, async () => {
      const environment = grantTable(sources === "*" ? "*" : [...sources]);
      const { before, after } = await beforeAndAfter(
        { intent: "coverage", filters: { source: ALLOWED } },
        environment,
      );
      expect(after).toEqual(before);
      for (const text of after) {
        const answer = JSON.parse(text) as QueryResponse;
        expect(answer.result.completeness).toBe("complete");
        expect(answer.result.data.scopes).toEqual([
          expect.objectContaining({ sourceRef: ALLOWED, collectionRunCount: 1 }),
        ]);
        expect(answer.result.data.collectionRunCount).toBe(1);
      }
    });

  it("every granted source's count is exact past the window", async () => {
    const environment = grantTable([ALLOWED, DENIED]);
    await sealedRuns(DENIED, DENIED_RUNS);
    // Earlier checks in this file wrote runs too; the store says how many there are.
    const exact = await env.DB.prepare(
      "SELECT count(*) AS n FROM observation_fetch_runs WHERE source_id = ?",
    )
      .bind(DENIED)
      .first<{ n: number }>();
    expect(exact!.n).toBeGreaterThan(501);
    const answer = JSON.parse(await overHttp({ intent: "coverage" }, environment)) as QueryResponse;
    expect(answer.result.data.scopes).toEqual([
      expect.objectContaining({ sourceRef: DENIED, collectionRunCount: exact!.n }),
      expect.objectContaining({ sourceRef: ALLOWED, collectionRunCount: 1 }),
    ]);
    expect(answer.result.data.collectionRunCount).toBe(exact!.n + 1);
  });
});

// The account correspondence candidate review over the real Worker and the
// real CORE migrations: `GET /api/identity/account-candidates` for the browser
// and `kogane.accounts.candidates` for an agent answer one page of one read
// (ADR 0077). The store holds an unresolved MoneyForward connection review and
// an aggregator source account no review names. Confirmed reviews, their
// candidates and the decisions on them are exercised in
// packages/application/test/account-candidates.test.ts. Every value is
// invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validAccountCandidateReview } from "../../../packages/observation-shared/src/account-candidates-contract";
import worker from "../src/worker";
import { seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const PATH = "/api/identity/account-candidates";
const AGENT_PATH = "/api/agent/v1/accounts.candidates";
const REVIEWED = `moneyforward-account-v2-${"a".repeat(64)}`;
const UNREVIEWED = `moneyforward-account-v2-${"b".repeat(64)}`;
const MCP_AUDIENCE = "fixture-mcp-audience";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources(producer_id,source_id) VALUES('evidence-test','moneyforward-me')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('evidence-test','evidence-test','moneyforward-me')",
    ),
  ]);
  const evidence = await seedRun({
    source: "moneyforward-me",
    count: 1,
    dataset: "account-detail",
    fetchUnitKey: REVIEWED,
  });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO account_connection_reviews(producer_id,connection_key,revision,label,status,
      reason,verifier_version,detail_artifact_id,direct_reference_ids_json,created_at)
      VALUES('evidence-test',?,1,'Synthetic bank (aggregator)','unresolved','synthetic','fixture',?,'[]','2099')`).bind(
      REVIEWED,
      evidence.artifacts[0]!.id,
    ),
    ...[
      ["sa-synthetic-reviewed", REVIEWED],
      ["sa-synthetic-unreviewed", UNREVIEWED],
    ].map(([id, key]) =>
      env.DB.prepare(
        "INSERT INTO source_accounts(id,source_id,producer_id,reference_json) VALUES(?,'moneyforward-me','evidence-test',?)",
      ).bind(id, JSON.stringify([`moneyforward-me:${key}`])),
    ),
  ]);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://account-candidates-${++sequence}.cloudflareaccess.com`;
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
}

async function call(path: string, options: CallOptions = {}) {
  const subject = options.subject === undefined ? "synthetic-reader" : options.subject;
  const token =
    subject === null
      ? null
      : await new SignJWT({ type: "app" })
          .setProtectedHeader({ alg: "RS256", kid: "fixture" })
          .setIssuer(issuer)
          .setAudience(path === "/mcp" ? MCP_AUDIENCE : "fixture-audience")
          .setSubject(subject)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(keys.privateKey);
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(token ? { "cf-access-jwt-assertion": token } : {}),
      ...(path === "/mcp" ? MCP_CLIENT_HEADERS : {}),
    },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return worker.fetch(new Request(`https://fixture.test${path}`, init), {
    ...env,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "fixture-audience",
    ACCESS_MCP_AUDIENCE: MCP_AUDIENCE,
    OPERATOR_SUBJECTS: '["synthetic-operator"]',
    AGENT_GRANTS: '["synthetic-agent"]',
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

/** Every table's row count but the audit tables (an agent call's own record is its one write). */
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

describe("GET /api/identity/account-candidates", () => {
  it("serves each view to a signed-in reader, proposes nothing without a confirmed review and writes nothing", async () => {
    const before = await tables();
    const open = (await (await call(PATH)).json()) as Record<string, any>;
    expect(open).toMatchObject({
      schemaVersion: "kogane-account-candidates-v1",
      query: { view: "open", offset: 0, sourceAccountId: null },
      decisions: "change-lifecycle",
      total: 0,
      items: [],
      nextOffset: null,
      manifest: {
        policy: "account-candidates-v1",
        commands: { relationKind: "connection_contains" },
      },
      summary: {
        connections: { confirmed: 0, unresolved: 1, "evidence-ineligible": 0 },
        candidates: { proposed: 0, accepted: 0, rejected: 0 },
        unreviewedAggregatorAccounts: 1,
        sameAccountProposed: 0,
      },
    });
    expect(validAccountCandidateReview(open)).toBe(true);
    const connections = (await (await call(`${PATH}?view=connections`)).json()) as Record<
      string,
      any
    >;
    expect(validAccountCandidateReview(connections)).toBe(true);
    expect(connections["items"]).toMatchObject([
      {
        connectionRef: `connection:evidence-test/${REVIEWED}`,
        state: "unresolved",
        directSourceAccountIds: [],
        aggregatorSourceAccountIds: ["sa-synthetic-reviewed"],
      },
    ]);
    const unreviewed = (await (
      await call(`${PATH}?view=unreviewed&sourceAccountId=sa-synthetic-unreviewed`)
    ).json()) as Record<string, any>;
    expect(validAccountCandidateReview(unreviewed)).toBe(true);
    expect(unreviewed["items"]).toEqual([
      {
        sourceAccountId: "sa-synthetic-unreviewed",
        producerId: "evidence-test",
        connectionKey: UNREVIEWED,
        reason: "no-connection-review",
      },
    ]);
    expect(unreviewed["sourceAccounts"]).toMatchObject([
      { sourceAccountId: "sa-synthetic-unreviewed", sourceId: "moneyforward-me", accountId: null },
    ]);
    expect(await tables()).toEqual(before);
  });

  it("refuses an unknown or repeated parameter, a malformed value, an unknown account and deep paging", async () => {
    for (const [query, code] of [
      ["?source=moneyforward-me", "invalid_query"],
      ["?view=open&view=held", "invalid_query"],
      ["?view=hints", "invalid_query"],
      ["?offset=-1", "invalid_offset"],
      ["?offset=6401", "invalid_query"],
      ["?sourceAccountId=a%20b", "invalid_query"],
    ] as const) {
      const response = await call(`${PATH}${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: code });
    }
    expect((await call(PATH, { subject: null })).status).toBe(401);
    expect((await call(PATH, { method: "POST", body: {} })).status).toBe(405);
    const deep = await call(`${PATH}?offset=1000`);
    expect(deep.status).toBe(413);
    expect(await deep.json()).toMatchObject({
      code: "budget_exceeded",
      refs: ["budget:maxRows=1000"],
    });
    const unknown = await call(`${PATH}?sourceAccountId=sa-unknown`);
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toMatchObject({
      code: "evidence_restricted",
      refs: ["sourceAccountId"],
    });
  });
});

describe("kogane.accounts.candidates", () => {
  it("answers the same page over HTTP and MCP, and is listed to every MCP client", async () => {
    const listed = await mcp({ method: "tools/list" });
    expect(listed["result"].tools.map((tool: { name: string }) => tool.name)).toContain(
      "kogane.accounts.candidates",
    );
    const overRoute = await (await call(`${PATH}?view=connections`)).json();
    const overAgent = await call(AGENT_PATH, {
      subject: "synthetic-agent",
      body: { view: "connections" },
    });
    expect(overAgent.status).toBe(200);
    expect(await overAgent.json()).toEqual(overRoute);
    const overMcp = await mcp({
      method: "tools/call",
      params: { name: "kogane.accounts.candidates", arguments: { view: "connections" } },
    });
    expect(overMcp["result"].isError).toBe(false);
    expect(overMcp["result"].structuredContent).toEqual(overRoute);
  });

  it("is graded by its strict input, and writes nothing", async () => {
    const before = await tables();
    const unknownKey = await call(AGENT_PATH, {
      subject: "synthetic-agent",
      body: { source: "x" },
    });
    expect(unknownKey.status).toBe(400);
    expect(await tables()).toEqual(before);
  });

  it("records each served agent call as one read of the page's items (ADR 0064)", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    const page = (await (await call(`${PATH}?view=connections`)).json()) as {
      items: unknown[];
      total: number;
    };
    expect(
      (await call(AGENT_PATH, { subject: "synthetic-agent", body: { view: "connections" } }))
        .status,
    ).toBe(200);
    const records = (
      await env.DB.prepare(
        "SELECT path,risk_class,result,diff_json FROM audit_records WHERE operation='accounts.candidates' AND rowid>? ORDER BY rowid",
      )
        .bind(last)
        .all()
    ).results;
    // The browser route is not an agent call and records nothing.
    expect(records).toEqual([
      {
        path: "agent-http",
        risk_class: "R0",
        result: "read",
        diff_json: JSON.stringify({ kind: "read", rows: page.items.length, truncated: false }),
      },
    ]);
  });
});

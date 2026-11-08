// One source account's correction history over the real Worker and the real
// CORE migrations: `GET /api/identity/account-history` for the 口座の対応候補
// page and `kogane.accounts.history` for an agent, over HTTP and MCP, answer
// one read (ADR 0077, amendment 2026-11-08). The store holds a direct source
// account with a rule mapping and a later manual one, and a same_account
// rejection naming it from an aggregator account. Decisions made through the
// change lifecycle are exercised in
// packages/application/test/account-history-read.test.ts. Every value is
// invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import worker from "../src/worker";
import { seedRegistry } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const PATH = "/api/identity/account-history";
const AGENT_PATH = "/api/agent/v1/accounts.history";
const TOOL = "kogane.accounts.history";
const DIRECT = "sa-history-direct";
const AGGREGATOR = "sa-history-aggregator";
const MCP_AUDIENCE = "fixture-mcp-audience";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

beforeAll(async () => {
  await seedRegistry();
  const mapping = (id: string, account: string, revision: number, method: string, at: string) =>
    env.DB.prepare(
      `INSERT INTO account_mappings(id,source_account_id,revision,account_id,method,reason,policy_version,created_at,label,status)
       VALUES(?,?,?,?,?,?,1,?,'Synthetic history account','provider-local')`,
    ).bind(`mapping-${id}-${revision}`, id, revision, account, method, `synthetic ${method}`, at);
  await env.DB.batch([
    ...[DIRECT, AGGREGATOR].map((id) =>
      env.DB.prepare(
        "INSERT INTO source_accounts(id,source_id,producer_id,reference_json) VALUES(?,'moneyforward-me','evidence-test',?)",
      ).bind(id, JSON.stringify([`moneyforward-me:${id}`])),
    ),
    ...["account-history-a", "account-history-b", "account-history-c"].map((id) =>
      env.DB.prepare(
        "INSERT INTO accounts(id,label,role,status) VALUES(?,'Synthetic history account','deposit','provider-local')",
      ).bind(id),
    ),
    mapping(DIRECT, "account-history-a", 1, "rule", "2099-01-01T00:00:00.000Z"),
    mapping(AGGREGATOR, "account-history-c", 1, "rule", "2099-01-01T00:00:00.000Z"),
    mapping(DIRECT, "account-history-b", 2, "manual", "2099-01-03T00:00:00.000Z"),
    env.DB.prepare(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES('dr-history-assign','account_mapping',?,2,'assign','manual','synthetic-operator',NULL,'synthetic correction','[]',NULL,NULL,'2099-01-03T00:00:00.000Z')`,
    ).bind(DIRECT),
    env.DB.prepare(
      `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
       VALUES('dr-history-apart','relation','rel-history-apart',1,'reject','manual','synthetic-operator',NULL,'synthetic keep apart','[]',NULL,NULL,'2099-01-02T00:00:00.000Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO entity_relations(id,kind,from_ref,to_ref,valid_from,valid_to,status,decision_revision_id,evidence_refs_json,created_at)
       VALUES('rel-history-apart','same_account',?,?,NULL,NULL,'rejected','dr-history-apart','[]','2099-01-02T00:00:00.000Z')`,
    ).bind(`source_account:${AGGREGATOR}`, `source_account:${DIRECT}`),
  ]);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://account-history-${++sequence}.cloudflareaccess.com`;
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

async function mcp(message: Record<string, unknown>) {
  const response = await call("/mcp", {
    subject: "synthetic-agent",
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

describe("GET /api/identity/account-history", () => {
  it("serves every entry oldest first to a signed-in reader and writes nothing", async () => {
    const before = await tables();
    const response = await call(`${PATH}?sourceAccountId=${DIRECT}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const value = (await response.json()) as Record<string, any>;
    expect(validApiResponse(PATH, value)).toBe(true);
    expect(value).toMatchObject({
      schemaVersion: "kogane-account-history-v1",
      sourceAccountId: DIRECT,
      total: 4,
    });
    expect(
      (value["entries"] as Record<string, unknown>[]).map((row) => [
        row["entry"],
        row["revision"],
        row["accountId"] ?? row["relationKind"] ?? row["decisionKind"],
      ]),
    ).toEqual([
      ["mapping", 1, "account-history-a"],
      ["relation", 1, "same_account"],
      ["decision", 2, "assign"],
      ["mapping", 2, "account-history-b"],
    ]);
    // A decision without a verified operation is never shown as an operator's.
    expect(value["entries"][1]).toMatchObject({
      decisionOrigin: "unknown",
      relationStatus: "rejected",
      fromRef: `source_account:${AGGREGATOR}`,
      toRef: `source_account:${DIRECT}`,
    });
    expect(JSON.stringify(value)).not.toContain("synthetic-operator");
    expect((await call(`${PATH}?sourceAccountId=${DIRECT}`, { method: "HEAD" })).status).toBe(200);
    expect(await tables()).toEqual(before);
  });

  it("requires Access, refuses non-GET, unknown accounts and malformed or repeated queries", async () => {
    expect((await call(`${PATH}?sourceAccountId=${DIRECT}`, { subject: null })).status).toBe(401);
    expect(
      (await call(`${PATH}?sourceAccountId=${DIRECT}`, { method: "POST", body: {} })).status,
    ).toBe(405);
    const unknown = await call(`${PATH}?sourceAccountId=sa-unknown`);
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toMatchObject({
      code: "evidence_restricted",
      refs: ["sourceAccountId"],
    });
    for (const query of [
      "",
      "?sourceAccountId=",
      "?sourceAccountId=a%20b",
      `?sourceAccountId=${DIRECT}&sourceAccountId=${AGGREGATOR}`,
      `?sourceAccountId=${DIRECT}&extra=1`,
    ])
      expect((await call(`${PATH}${query}`)).status, query).toBe(400);
  });
});

describe("kogane.accounts.history", () => {
  it("answers the route's history over HTTP and MCP, and is listed to every MCP client", async () => {
    const listed = await mcp({ method: "tools/list" });
    const tool = (listed["result"].tools as { name: string; inputSchema: any }[]).find(
      (entry) => entry.name === TOOL,
    );
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      required: ["sourceAccountId"],
      additionalProperties: false,
    });
    const overRoute = await (await call(`${PATH}?sourceAccountId=${AGGREGATOR}`)).json();
    const overAgent = await call(AGENT_PATH, {
      subject: "synthetic-agent",
      body: { sourceAccountId: AGGREGATOR },
    });
    expect(overAgent.status).toBe(200);
    expect(await overAgent.json()).toEqual(overRoute);
    const overMcp = await mcp({
      method: "tools/call",
      params: { name: TOOL, arguments: { sourceAccountId: AGGREGATOR } },
    });
    expect(overMcp["result"].isError).toBe(false);
    expect(overMcp["result"].structuredContent).toEqual(overRoute);
    // The aggregator side sees the same relation row from its own end.
    expect((overRoute as { entries: { entry: string }[] }).entries.map((row) => row.entry)).toEqual(
      ["mapping", "relation"],
    );
  });

  it("is graded by its strict input and the service's refusals, and writes nothing", async () => {
    const before = await tables();
    for (const body of [{}, { sourceAccountId: DIRECT, extra: 1 }, { sourceAccountId: "a b" }]) {
      const response = await call(AGENT_PATH, { subject: "synthetic-agent", body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const unknown = await mcp({
      method: "tools/call",
      params: { name: TOOL, arguments: { sourceAccountId: "sa-unknown" } },
    });
    expect(unknown["result"].isError).toBe(true);
    expect(unknown["result"].structuredContent).toMatchObject({
      code: "evidence_restricted",
      refs: ["sourceAccountId"],
    });
    expect(await tables()).toEqual(before);
  });

  it("records each served agent call as one read of its entries (ADR 0064)", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    const history = (await (await call(`${PATH}?sourceAccountId=${DIRECT}`)).json()) as {
      entries: unknown[];
    };
    expect(
      (
        await call(AGENT_PATH, {
          subject: "synthetic-agent",
          body: { sourceAccountId: DIRECT },
        })
      ).status,
    ).toBe(200);
    const records = (
      await env.DB.prepare(
        "SELECT path,risk_class,result,diff_json FROM audit_records WHERE operation='accounts.history' AND rowid>? ORDER BY rowid",
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
        diff_json: JSON.stringify({ kind: "read", rows: history.entries.length, truncated: false }),
      },
    ]);
  });
});

// What was recorded since a time, over the real Worker and the real CORE
// migrations (ADR 0127): `GET /api/v2/changes`, the agent HTTP route and
// `kogane.changes.since` over MCP answer one read. The store holds one sealed
// and one open run of a source, one published parse with two transaction
// rows; each count against the base tables is exercised in
// packages/application/test/changes-since.test.ts. Every value is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANGES_SINCE_MAX_BYTES } from "../../../packages/domain/src/changes-since";
import { validChangesSince } from "../../../packages/observation-shared/src/changes-since-contract";
import type { Grant } from "../../../packages/application/src/index";
import worker from "../src/worker";
import { callTool, toolContext } from "../src/agent-service";
import { changesSinceFor } from "../src/changes-since-api";
import { readMcpTools } from "../src/read-tools";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const PATH = "/api/v2/changes";
const AGENT_PATH = "/api/agent/v1/changes.since";
const TOOL = "kogane.changes.since";
const WHOLE = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read", "evidence.read"],
  budget: { maxRows: 500, maxProposalTargets: 5, maxExplainDepth: 3 },
};
const MCP_AUDIENCE = "fixture-mcp-audience";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;
let since: string;
let sealedRun: number;
let parsedArtifact: number;

beforeAll(async () => {
  since = new Date(Date.now() - 60 * 60_000).toISOString();
  await seedRegistry();
  const sealed = await seedRun({ source: "sony-bank", count: 2 });
  await seedRun({ source: "sony-bank", count: 1, sealed: false });
  sealedRun = sealed.id;
  parsedArtifact = sealed.artifacts[0]!.id;
  const parse = await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,'synthetic-parser','1',?,'pending','[]') RETURNING id",
  )
    .bind(parsedArtifact, new Date().toISOString())
    .first<number>("id");
  await env.DB.batch([
    ...[0, 1].map((n) =>
      env.DB.prepare(
        "INSERT INTO transaction_observations(parse_run_id,source_account,external_id,raw_locator,extra_json) VALUES(?,'synthetic-account',?,?,'{}')",
      ).bind(parse, `row-${n}`, `json:$.rows[${n}]`),
    ),
    env.DB.prepare("UPDATE parse_runs SET status='ok' WHERE id=?").bind(parse),
  ]);
  await publishParse(parse!);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://changes-since-${++sequence}.cloudflareaccess.com`;
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

/** The answer without its instant, which differs between two reads. */
const timeless = (answer: Record<string, unknown>) => {
  const { asOf: _, ...rest } = answer;
  return rest;
};

const query = (parameters: Record<string, string>) =>
  `${PATH}?${new URLSearchParams(parameters).toString()}`;

describe("GET /api/v2/changes", () => {
  it("serves a signed-in reader the source's new runs, captures, parse and rows, and writes nothing", async () => {
    const before = await tables();
    const response = await call(query({ since }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(new TextEncoder().encode(text).length).toBeLessThan(CHANGES_SINCE_MAX_BYTES);
    const answer = JSON.parse(text) as Record<string, any>;
    expect(validChangesSince(answer)).toBe(true);
    expect(answer["since"]).toBe(since);
    expect(answer["sources"]).toEqual([
      {
        source: "sony-bank",
        cut: [],
        // success and open, in `order.runs`.
        runs: [1, 0, 0, 0, 0, 0, 1],
        captures: 3,
        parses: [1, 0, 0, 0, 0],
        observations: [2, 0, 0, 0],
        newestRunAt: expect.any(String),
        newestSealedRunId: `r_${sealedRun}`,
        newestParsedAt: expect.any(String),
        newestParsedArtifactId: parsedArtifact,
      },
    ]);
    expect(answer["unchanged"]).toContain("other-test");
    expect(answer["unchanged"]).not.toContain("kogane-synthetic");
    expect(answer["events"]).toMatchObject({ state: "counted", complete: true });
    // A time after every run: nothing is new.
    const later = (await (await call(query({ since: new Date().toISOString() }))).json()) as Record<
      string,
      any
    >;
    expect(later["sources"]).toEqual([]);
    expect(await tables()).toEqual(before);
  });

  it("is GET-only, needs a signed-in subject, and refuses any other or repeated parameter", async () => {
    expect((await call(query({ since }), { subject: null })).status).toBe(401);
    expect((await call(query({ since }), { method: "POST", body: {} })).status).toBe(405);
    for (const suffix of [`&since=${since}`, "&kind=x", "&offset=0", "&=x"]) {
      const response = await call(`${query({ since })}${suffix}`);
      expect(response.status, suffix).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_query" });
    }
    for (const [parameters, ref] of [
      [{}, "since:format"],
      [{ since: "2026-01-01" }, "since:format"],
      [{ since: new Date(Date.now() + 60_000).toISOString() }, "since:future"],
      [{ since: new Date(Date.now() - 32 * 86_400_000).toISOString() }, "since:too_old"],
      [{ since, after: "Not A Source" }, "after:format"],
    ] as const) {
      const response = await call(query(parameters));
      expect(response.status, ref).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_query", refs: [ref] });
    }
  });
});

// A narrower grant is given to the shared service directly, which is where it
// is graded (ADR 0084: no table configures one).
const narrow = (grant: Record<string, unknown>) =>
  ({ principal: "mcp-client:synthetic-agent", ...WHOLE, ...grant }) as Grant;
const direct = (body: unknown, grant: Record<string, unknown>) =>
  callTool(TOOL, body, toolContext(env as Env, narrow(grant), "2026-11-07T00:00:00Z"));

describe("kogane.changes.since", () => {
  it("answers the same read over the route, HTTP and MCP, listed to a whole-store records.read grant only", async () => {
    const listed = await mcp({ method: "tools/list" });
    const tool = (listed["result"].tools as { name: string; description: string }[]).find(
      (entry) => entry.name === TOOL,
    );
    expect(tool?.description.length).toBeLessThanOrEqual(2048);
    for (const grant of [
      { capabilities: ["summary.read", "evidence.read"] },
      { scopes: { sources: ["sony-bank"], accounts: "*" } },
    ])
      expect(
        readMcpTools(narrow(grant), { reportedState: true, cardSettlements: true }).map(
          (entry) => entry.name,
        ),
      ).not.toContain(TOOL);
    const overRoute = (await (await call(query({ since }))).json()) as Record<string, unknown>;
    const overAgent = await call(AGENT_PATH, { body: { since } });
    expect(overAgent.status).toBe(200);
    expect(timeless((await overAgent.json()) as Record<string, unknown>)).toEqual(
      timeless(overRoute),
    );
    const overMcp = await mcp({
      method: "tools/call",
      params: { name: TOOL, arguments: { since } },
    });
    expect(overMcp["result"].isError).toBe(false);
    expect(validChangesSince(overMcp["result"].structuredContent)).toBe(true);
    expect(timeless(overMcp["result"].structuredContent)).toEqual(timeless(overRoute));
    // `after` continues past a source, as on the route.
    const after = await mcp({
      method: "tools/call",
      params: { name: TOOL, arguments: { since, after: "sony-bank" } },
    });
    expect(after["result"].structuredContent.sources).toEqual([]);
  });

  it("is graded by the agent's grant before the request, takes a strict input, and writes nothing", async () => {
    const before = await tables();
    const summary = await direct({ since: "not a time" }, { capabilities: ["summary.read"] });
    expect(summary.status).toBe(403);
    expect(summary.body).toMatchObject({ code: "unauthorized", refs: ["capability:records.read"] });
    // Before the body's form is checked and before any read, the probe of
    // what this deployment serves included.
    const prepared: string[] = [];
    const watched = {
      ...env,
      DB: new Proxy(env.DB, {
        get: (target, key) =>
          key === "prepare"
            ? (text: string) => {
                prepared.push(text);
                return target.prepare(text);
              }
            : Reflect.get(target, key, target),
      }),
    } as Env;
    for (const [body, grant] of [
      [{}, { capabilities: ["summary.read"] }],
      [{ since, kind: "x" }, { scopes: { sources: ["sony-bank"], accounts: "*" } }],
    ] as const) {
      const refused = await callTool(
        TOOL,
        body,
        toolContext(watched, narrow(grant), "2026-11-07T00:00:00Z"),
      );
      expect(refused.status).toBe(403);
    }
    // A request the service refuses is refused before the probe too.
    expect((await changesSinceFor(watched, narrow({}), { since: "not a time" })).ok).toBe(false);
    expect(prepared).toEqual([]);
    const narrowed = await direct({ since }, { scopes: { sources: ["sony-bank"], accounts: "*" } });
    expect(narrowed.status).toBe(403);
    expect(narrowed.body).toMatchObject({ code: "evidence_restricted", refs: ["scope:source"] });
    // Without evidence.read, the run sections say so; parses still answer.
    const records = await direct({ since }, { capabilities: ["summary.read", "records.read"] });
    expect(records.status).toBe(200);
    expect(records.body).toMatchObject({
      sections: { runs: "unauthorized", captures: "unauthorized" },
      sources: [{ source: "sony-bank", runs: null, captures: null, parses: [1, 0, 0, 0, 0] }],
    });
    const unknownKey = await call(AGENT_PATH, { body: { since, kind: "x" } });
    expect(unknownKey.status).toBe(400);
    const missing = await call(AGENT_PATH, { body: {} });
    expect(missing.status).toBe(400);
    expect(await tables()).toEqual(before);
  });

  it("records each served agent call as one read of the sources it covers (ADR 0064)", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    const response = await call(AGENT_PATH, { body: { since } });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { sources: unknown[]; unchanged: unknown[] };
    const records = (
      await env.DB.prepare(
        "SELECT path,risk_class,result,diff_json FROM audit_records WHERE operation='changes.since' AND rowid>? ORDER BY rowid",
      )
        .bind(last)
        .all()
    ).results;
    expect(records).toEqual([
      {
        path: "agent-http",
        risk_class: "R0",
        result: "read",
        diff_json: JSON.stringify({
          kind: "read",
          rows: answer.sources.length + answer.unchanged.length,
          truncated: false,
        }),
      },
    ]);
  });
});

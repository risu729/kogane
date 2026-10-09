// `GET /api/v2/reconstructed-state` and the agent tool
// `kogane.reconstructed-state.read` over the real Worker and workerd's SQLite:
// behind Access, served to any signed-in reader, GET-only, absent where the
// store lacks the reported state's views, `unavailable` without CORE 0070,
// every refusal a closed code, a selector bound refused rather than cut, and
// nothing written. The answers for real histories are tested over the same
// service in packages/application/test/reconstructed-state-read.test.ts; here
// one synthetic account without a reported container is enough. Every id is
// invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import { RECONSTRUCTED_STATE_TOOL_NAME } from "../src/agent-service";
import { RECONSTRUCTED_STATE_MCP_TOOLS } from "../src/mcp";
import { reconstructedStateAvailable } from "../src/reconstructed-state-api";
import worker from "../src/worker";

const PATH = "/api/v2/reconstructed-state";
const ACCOUNT = "acct-reconstructed-synthetic";
const RANGE = `account=${ACCOUNT}&from=2026-03-01&to=2026-03-31`;
const TOOL_PATH = "/api/agent/v1/reconstructed-state.read";
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
  await env.DB.prepare(
    "INSERT OR IGNORE INTO accounts(id,label,role,status) VALUES(?,'Synthetic','asset','identified')",
  )
    .bind(ACCOUNT)
    .run();
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://reconstructed-state-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

/** The civil date in Tokyo `days` from today. */
const tokyo = (days: number) =>
  new Date(Date.now() + 9 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);

type Rewrite = (sql: string) => string;
/** The store with some statements answered by others. */
function rewritten(db: D1Database, rewrite: Rewrite): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => target.prepare(rewrite(sql));
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
/** A store before CORE 0044: the statement and settlement views are absent. */
const withoutViews: Rewrite = (sql) =>
  sql.includes("sqlite_master") && sql.includes("card_statement_facts")
    ? "SELECT 2 AS present"
    : sql;
/** A store before CORE 0070. */
const withoutGuard: Rewrite = (sql) =>
  sql.includes("sqlite_master") && sql.includes("economic_commit_log")
    ? "SELECT 0 AS present"
    : sql;
/** An account whose legs touch one event more than the selector's bound of 2,000. */
const overfull: Rewrite = (sql) =>
  sql.includes("CROSS JOIN economic_legs l ON l.subject_ref=s.value")
    ? "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2001) SELECT 'ev-'||i AS event_id FROM n WHERE ?1 IS NOT NULL LIMIT ?2"
    : sql;

async function call(
  path: string,
  options: {
    subject?: string | null;
    method?: string;
    body?: unknown;
    rewrite?: Rewrite;
    environment?: Record<string, unknown>;
  } = {},
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
  const init: RequestInit = {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: token ? { "cf-access-jwt-assertion": token } : {},
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  return worker.fetch(new Request(`https://fixture.test${path}`, init), {
    ...env,
    DB: options.rewrite ? rewritten(env.DB, options.rewrite) : env.DB,
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "fixture-audience",
    OPERATOR_SUBJECTS: '["synthetic-operator"]',
    ...options.environment,
  } as Env);
}

async function counts() {
  return env.DB.prepare(
    `SELECT (SELECT count(*) FROM economic_event_revisions) AS revisions,
      (SELECT count(*) FROM economic_commit_log) AS commits,
      (SELECT count(*) FROM decision_revisions) AS decisions,
      (SELECT count(*) FROM accounts) AS accounts,
      (SELECT source_revision FROM core_source_revision WHERE id=1) AS source_revision`,
  ).first();
}

describe("reconstructed state over HTTP", () => {
  it("serves a signed-in reader a validated answer and writes nothing", async () => {
    const before = await counts();
    const response = await call(`${PATH}?${RANGE}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, any>;
    expect(validApiResponse(PATH, body)).toBe(true);
    // No container lists the account and the log is empty: refused as a
    // status with its reasons, never a figure of zero.
    expect(body).toMatchObject({
      apiVersion: 2,
      schemaVersion: "reconstructed-state-query-v1",
      status: "unavailable",
      account: ACCOUNT,
      range: { from: "2026-03-01", to: "2026-03-31" },
      basis: "cash",
      cutStanding: "provisional",
    });
    expect(body["reasons"]).toEqual(
      expect.arrayContaining(["no_reported_container", "log_empty", "nothing_to_reconstruct"]),
    );
    expect(body["reconstruction"].cells).toEqual([]);
    expect(body["reconstruction"].netWorth).toBe("not-computed");
    expect(body["knowledge"].setVersion).toMatch(/^[0-9a-f]{64}$/u);
    expect(await counts()).toEqual(before);
  });

  it("answers any signed-in subject, refuses an anonymous one, and is GET-only", async () => {
    expect((await call(`${PATH}?${RANGE}`, { subject: null })).status).toBe(401);
    expect((await call(`${PATH}?${RANGE}`, { subject: "synthetic-operator" })).status).toBe(200);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect((await call(`${PATH}?${RANGE}`, { method })).status).toBe(405);
    expect((await call(`${PATH}?${RANGE}`, { method: "HEAD" })).status).toBe(200);
  });

  it("refuses each malformed request with its closed code", async () => {
    const cases: [string, number, string][] = [
      ["", 400, "invalid_account"],
      [`${RANGE}&offset=0`, 400, "invalid_query"],
      [`${RANGE}&basis=`, 400, "invalid_query"],
      [`${RANGE}&instrument=inst-1`, 400, "scope_unsupported"],
      [`${RANGE}&account=acct-other`, 400, "scope_unsupported"],
      [`account=%20x&from=2026-03-01&to=2026-03-31`, 400, "invalid_account"],
      [`account=${ACCOUNT}&from=2026-02-30&to=2026-03-31`, 400, "invalid_date"],
      [`account=${ACCOUNT}&from=2026-03-31&to=2026-03-01`, 400, "invalid_range"],
      [`account=${ACCOUNT}&from=2025-01-01&to=2026-03-31`, 400, "range_too_long"],
      [`account=${ACCOUNT}&from=${tokyo(0)}&to=${tokyo(1)}`, 400, "range_in_future"],
      [`${RANGE}&basis=trade-date`, 400, "basis_unsupported"],
      [`${RANGE}&commitSeq=1`, 400, "invalid_cut"],
      [`${RANGE}&coreEpoch=e&commitSeq=x`, 400, "invalid_cut"],
      [`${RANGE}&coreEpoch=e&commitSeq=0`, 400, "invalid_cut"],
      [`${RANGE}&coreEpoch=e&instant=2999-01-01T00:00:00Z`, 400, "cut_in_future"],
      [`${RANGE}&setVersion=abc`, 400, "invalid_query"],
      [`account=acct-nowhere&from=2026-03-01&to=2026-03-31`, 404, "unknown_account"],
    ];
    for (const [query, status, code] of cases) {
      const response = await call(`${PATH}?${query}`);
      expect([query, response.status]).toEqual([query, status]);
      expect(((await response.json()) as { error: string }).error).toBe(code);
    }
    // A cut of the log: past its end, of another epoch, a stale set version.
    const answer = (await (await call(`${PATH}?${RANGE}`)).json()) as {
      cut: { resolved: { coreEpoch: string } };
    };
    const epoch = answer.cut.resolved.coreEpoch;
    for (const [query, status, code] of [
      [`${RANGE}&coreEpoch=${epoch}&commitSeq=99`, 400, "cut_after_log_end"],
      [`${RANGE}&coreEpoch=another-epoch&commitSeq=1`, 409, "cut_epoch_not_current"],
      [`${RANGE}&setVersion=${"0".repeat(64)}`, 409, "set_version_changed"],
    ] as const) {
      const response = await call(`${PATH}?${query}`);
      expect([query, response.status]).toEqual([query, status]);
      expect(((await response.json()) as { error: string }).error).toBe(code);
    }
  });

  it("says unavailable without CORE 0070, and refuses a bound rather than cutting", async () => {
    const response = await call(`${PATH}?${RANGE}`, { rewrite: withoutGuard });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(validApiResponse(PATH, body)).toBe(true);
    expect(body).toMatchObject({
      status: "unavailable",
      reasons: ["economic_guard_missing"],
      reconstruction: null,
    });
    const full = await call(`${PATH}?${RANGE}`, { rewrite: overfull });
    expect(full.status).toBe(413);
    expect(await full.json()).toMatchObject({ error: "result_limit_exceeded" });
  });

  it("does not exist, and is not advertised, where the store lacks the reported state's views", async () => {
    expect((await call(`${PATH}?${RANGE}`, { rewrite: withoutViews })).status).toBe(404);
    expect(await reconstructedStateAvailable(env as Env)).toBe(true);
    expect(
      await reconstructedStateAvailable({ ...env, DB: rewritten(env.DB, withoutViews) } as Env),
    ).toBe(false);
    const meta = async (rewrite?: Rewrite) =>
      (
        (await (await call("/api/meta", rewrite ? { rewrite } : {})).json()) as {
          capabilities: unknown;
        }
      ).capabilities;
    expect(await meta()).toMatchObject({ reconstructedStateOnDate: true });
    expect(await meta(withoutViews)).toMatchObject({ reconstructedStateOnDate: false });
  });
});

describe("the agent tool", () => {
  const granted = { AGENT_API_GRANTS: JSON.stringify({ "agent-principal": FULL_GRANT }) };
  const body = { account: ACCOUNT, from: "2026-03-01", to: "2026-03-31" };

  it("is listed while the route is served and answers what the route answers", async () => {
    const listed = (await (
      await call("/mcp", {
        subject: "agent-principal",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        environment: granted,
      })
    ).json()) as { result: { tools: { name: string; annotations: unknown }[] } };
    const tool = listed.result.tools.find((entry) => entry.name === RECONSTRUCTED_STATE_TOOL_NAME);
    expect(tool?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(RECONSTRUCTED_STATE_MCP_TOOLS.map((entry) => entry.name)).toEqual([
      RECONSTRUCTED_STATE_TOOL_NAME,
    ]);
    const called = (await (
      await call("/mcp", {
        subject: "agent-principal",
        body: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: RECONSTRUCTED_STATE_TOOL_NAME, arguments: body },
        },
        environment: granted,
      })
    ).json()) as { result: { isError: boolean; structuredContent: Record<string, unknown> } };
    expect(called.result.isError).toBe(false);
    const route = (await (await call(`${PATH}?${RANGE}`)).json()) as Record<string, unknown>;
    // The empty log's default cut is the caller's clock, so the cut, the
    // manifests and the context id differ between two calls; the rest does not.
    const pick = (answer: Record<string, unknown>) => ({
      status: answer["status"],
      reasons: answer["reasons"],
      reported: answer["reported"],
      cells: (answer["reconstruction"] as { cells: unknown }).cells,
      dispositions: (answer["reconstruction"] as { dispositions: unknown }).dispositions,
    });
    expect(pick(called.result.structuredContent)).toEqual(pick(route));
    expect(validApiResponse(PATH, called.result.structuredContent)).toBe(true);
  });

  it("refuses with the route's codes, as the first ref of a financial error", async () => {
    const refused = await call(TOOL_PATH, {
      subject: "agent-principal",
      body: { ...body, from: "2025-01-01" },
      environment: granted,
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      schemaVersion: "financial-error-v1",
      code: "budget_exceeded",
      refs: ["refusal:range_too_long", "maxDays:366"],
    });
    const summaryOnly = await call(TOOL_PATH, {
      subject: "agent-principal",
      body,
      environment: {
        AGENT_API_GRANTS: JSON.stringify({
          "agent-principal": { ...FULL_GRANT, capabilities: ["summary.read"] },
        }),
      },
    });
    expect(summaryOnly.status).toBe(403);
    expect(await summaryOnly.json()).toMatchObject({
      code: "unauthorized",
      refs: ["refusal:capability_missing", "capability:records.read"],
    });
    const narrowed = await call(TOOL_PATH, {
      subject: "agent-principal",
      body,
      environment: {
        AGENT_API_GRANTS: JSON.stringify({
          "agent-principal": { ...FULL_GRANT, scopes: { sources: ["smbc-bank"], accounts: "*" } },
        }),
      },
    });
    expect(narrowed.status).toBe(403);
    expect(await narrowed.json()).toMatchObject({
      code: "evidence_restricted",
      refs: ["refusal:scope_restricted", "scope:source"],
    });
  });

  it("is neither a tool nor a path where the route is absent, and needs a grant", async () => {
    const absent = (await (
      await call("/mcp", {
        subject: "agent-principal",
        body: {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: RECONSTRUCTED_STATE_TOOL_NAME, arguments: body },
        },
        environment: granted,
        rewrite: withoutViews,
      })
    ).json()) as { error: { code: number; message: string } };
    expect(absent.error).toEqual({ code: -32602, message: "unknown_tool" });
    expect(
      (
        await call(TOOL_PATH, {
          subject: "agent-principal",
          body,
          environment: granted,
          rewrite: withoutViews,
        })
      ).status,
    ).toBe(404);
    expect((await call(TOOL_PATH, { subject: "agent-principal", body })).status).toBe(403);
    expect((await call(TOOL_PATH, { body, subject: null, environment: granted })).status).toBe(401);
  });
});

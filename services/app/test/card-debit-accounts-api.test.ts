// Each card's debit account over the real Worker and the real CORE
// migrations: `GET /api/v2/reconciliation/card-debit-accounts` for the
// operator's カード照合 page and `kogane.card-settlements.debit-accounts` for
// an agent answer one read (docs/card-settlements.md, Debit account per card;
// ADR 0114). The store holds two MyJCB statement totals, one exact and one
// the decimal-v1 projection could not read, no reading and no candidate. The
// answers are exercised on the complete schema in
// services/processor/test/card-debit-accounts.test.ts. Every value is
// invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validCardDebitAccountsReview } from "../../../packages/observation-shared/src/card-debit-accounts-contract";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation";
import worker from "../src/worker";
import { callTool, toolContext } from "../src/agent-service";
import { readMcpTools } from "../src/read-tools";
import type { Grant } from "../../../packages/application/src/index";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const PATH = "/api/v2/reconciliation/card-debit-accounts";
const AGENT_PATH = "/api/agent/v1/card-settlements.debit-accounts";
const TOOL = "kogane.card-settlements.debit-accounts";
const FULL_GRANT = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read"],
  budget: { maxRows: 500, maxProposalTargets: 5, maxExplainDepth: 3 },
};
const MCP_AUDIENCE = "fixture-mcp-audience";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources(producer_id,source_id) VALUES('evidence-test','myjcb')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('evidence-test','evidence-test','myjcb')",
    ),
  ]);
  // The second card's total is not a number: decimal-v1 records it `unparsed`.
  await seedStatements([
    ["myjcb:synthetic:root", 4000, "4000", "2099-01-10"],
    ["myjcb:synthetic:unreadable", null, "unreadable", "2099-01-10"],
  ]);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
/**
 * One published MyJCB statement-total parse with a total per card: its
 * source account, minor units, text and `_kogane.paymentDate` (none when
 * undefined).
 */
async function seedStatements(
  cards: readonly (readonly [string, number | null, string, string | undefined])[],
) {
  const run = await seedRun({ source: "myjcb", count: 1 });
  const parse =
    await env.DB.prepare(`INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES(?,'myjcb-credit-statement-total','1','2099-01-12T00:00:00Z','ok','[]') RETURNING id`)
      .bind(run.artifacts[0]!.id)
      .first<{ id: number }>();
  for (const [card, minor, text, paymentDate] of cards)
    await env.DB.prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
    VALUES(?,?,'credit_statement_payment_amount',?,?,0,'JPY','2099-01-01','synthetic-total',?)`)
      .bind(
        parse!.id,
        card,
        minor,
        text,
        JSON.stringify({
          _kogane: {
            period: "2099-01",
            ...(paymentDate === undefined ? {} : { paymentDate }),
            snapshotSemantics: "provider-reported-monthly-payment-amount",
          },
        }),
      )
      .run();
  await publishParse(parse!.id);
}

beforeEach(() => {
  issuer = `https://card-debit-accounts-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  schemaAhead = false;
});

/**
 * A deployment whose code is ahead of its CORE schema: the settlement views'
 * `sqlite_master` check (`cardSettlementsAvailable`) finds nothing, so the
 * カード照合 routes are not served. Every other statement runs as given.
 */
let schemaAhead = false;
function withoutSettlementViews(db: D1Database): D1Database {
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          target.prepare(
            sql.includes("sqlite_master") && sql.includes("card_settlement_reviews")
              ? "SELECT 0 AS present"
              : sql,
          );
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

interface CallOptions {
  method?: string;
  body?: unknown;
  subject?: string | null;
}

async function call(path: string, options: CallOptions = {}) {
  const subject = options.subject === undefined ? "synthetic-operator" : options.subject;
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
    DB: schemaAhead ? withoutSettlementViews(env.DB) : env.DB,
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

describe("GET /api/v2/reconciliation/card-debit-accounts", () => {
  it("serves the operator each card with the evidence its answer rests on, and writes nothing", async () => {
    const before = await tables();
    const response = await call(PATH);
    expect(response.status).toBe(200);
    const page = (await response.json()) as Record<string, any>;
    expect(validCardDebitAccountsReview(page)).toBe(true);
    expect(page).toMatchObject({
      apiVersion: 2,
      schemaVersion: "kogane-card-debit-accounts-v1",
      manifest: {
        rule: "card-debit-account-answer-v1",
        bases: ["provider-stated", "accepted-settlement"],
        cardsMax: 100,
      },
      cardsTruncated: false,
      items: [
        {
          card: { sourceId: "myjcb", sourceAccount: "myjcb:synthetic:root" },
          latestStatement: { period: "2099-01" },
          stated: { status: "absent", reason: "evidence_not_recorded" },
          settled: [],
          proposed: [],
          answer: { basis: "unknown", reason: "no_debit_account_evidence" },
        },
        {
          card: { sourceId: "myjcb", sourceAccount: "myjcb:synthetic:unreadable" },
          // Not exact: its status and reason, never null or zero (INV05).
          latestStatement: {
            period: "2099-01",
            amount: {
              unitRef: "JPY",
              value: { status: "unparsed", reasonCode: "stored:unparsed" },
            },
          },
          answer: { basis: "unknown", reason: "no_debit_account_evidence" },
        },
      ],
    });
    expect(await tables()).toEqual(before);
  });

  it("is operator-only, GET-only, and refuses any parameter", async () => {
    expect((await call(PATH, { subject: "synthetic-reader" })).status).toBe(403);
    expect((await call(PATH, { subject: null })).status).toBe(401);
    expect((await call(PATH, { method: "POST", body: {} })).status).toBe(405);
    for (const query of ["?source=myjcb", "?offset=0", "?=x"]) {
      const response = await call(`${PATH}${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_query" });
    }
  });
});

// No table configures a grant any more (ADR 0084). A narrower grant is given
// to the shared service directly, which is where it is graded.
const narrow = (grant: Record<string, unknown>) =>
  ({ principal: "mcp-client:synthetic-agent", ...FULL_GRANT, ...grant }) as Grant;
const direct = (body: unknown, grant: Record<string, unknown>) =>
  callTool(TOOL, body, toolContext(env as Env, narrow(grant), "2026-11-07T00:00:00Z"));

describe("kogane.card-settlements.debit-accounts", () => {
  it("answers the same read over HTTP and MCP, and is listed to a whole-store records.read grant only", async () => {
    const listed = await mcp({ method: "tools/list" });
    expect(listed["result"].tools.map((tool: { name: string }) => tool.name)).toContain(TOOL);
    const summaryOnly = readMcpTools(narrow({ capabilities: ["summary.read"] }), {
      reportedState: true,
      cardSettlements: true,
    });
    expect(summaryOnly.map((tool) => tool.name)).not.toContain(TOOL);
    const overRoute = await (await call(PATH)).json();
    const overAgent = await call(AGENT_PATH, { subject: "synthetic-agent", body: {} });
    expect(overAgent.status).toBe(200);
    expect(await overAgent.json()).toEqual(overRoute);
    const overMcp = await mcp({
      method: "tools/call",
      params: { name: TOOL, arguments: {} },
    });
    expect(overMcp["result"].isError).toBe(false);
    expect(overMcp["result"].structuredContent).toEqual(overRoute);
  });

  it("is absent, not refused, while the route is not served, on both transports (ADR 0081)", async () => {
    schemaAhead = true;
    expect((await call(PATH)).status).toBe(404);
    const listed = await mcp({ method: "tools/list" });
    expect(listed["result"].tools.map((tool: { name: string }) => tool.name)).not.toContain(TOOL);
    expect(
      readMcpTools(narrow({}), { reportedState: true, cardSettlements: false }).map(
        (tool) => tool.name,
      ),
    ).not.toContain(TOOL);
    expect((await call(AGENT_PATH, { subject: "synthetic-agent", body: {} })).status).toBe(404);
    const overMcp = await mcp({
      method: "tools/call",
      params: { name: TOOL, arguments: {} },
    });
    expect(JSON.stringify(overMcp)).toContain("unknown_tool");
  });

  it("is graded by the agent's grant and its strict input, and writes nothing", async () => {
    const before = await tables();
    const summary = await direct({}, { capabilities: ["summary.read"] });
    expect(summary.status).toBe(403);
    expect(summary.body).toMatchObject({
      code: "unauthorized",
      refs: ["capability:records.read"],
    });
    const narrowed = await direct({}, { scopes: { sources: ["myjcb"], accounts: "*" } });
    expect(narrowed.status).toBe(403);
    expect(narrowed.body).toMatchObject({
      code: "evidence_restricted",
      refs: ["scope:source"],
    });
    const small = await direct({}, { budget: { ...FULL_GRANT.budget, maxRows: 99 } });
    expect(small.status).toBe(413);
    expect(small.body).toMatchObject({
      code: "budget_exceeded",
      refs: ["budget:maxRows=99"],
    });
    const unknownKey = await call(AGENT_PATH, {
      subject: "synthetic-agent",
      body: { source: "x" },
    });
    expect(unknownKey.status).toBe(400);
    expect(await tables()).toEqual(before);
  });

  it("records each served agent call as one read of the cards listed (ADR 0064)", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    expect((await call(AGENT_PATH, { subject: "synthetic-agent", body: {} })).status).toBe(200);
    const records = (
      await env.DB.prepare(
        "SELECT path,risk_class,result,diff_json FROM audit_records WHERE operation='card-settlements.debit-accounts' AND rowid>? ORDER BY rowid",
      )
        .bind(last)
        .all()
    ).results;
    expect(records).toEqual([
      {
        path: "agent-http",
        risk_class: "R0",
        result: "read",
        diff_json: JSON.stringify({ kind: "read", rows: 2, truncated: false }),
      },
    ]);
  });
});

// The 次回の引落 view (ADR 0114's 2026-11-19 amendment): the same route with
// `?view=upcoming` and the same tool with `view: "upcoming"`, one service
// (`reviewUpcomingCardBills`). On this store both cards' statements are due
// after the fixed date and neither has a debit account, so both are bills on
// the unknown-account line; the unreadable total keeps its reason.
describe("the upcoming view (次回の引落)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2098-12-01T03:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("answers the route and the tool alike, in the page's wire shape, and writes nothing", async () => {
    const before = await tables();
    const response = await call(`${PATH}?view=upcoming`);
    expect(response.status).toBe(200);
    const overRoute = (await response.json()) as Record<string, any>;
    expect(validApiResponse(PATH, overRoute)).toBe(true);
    expect(overRoute).toMatchObject({
      apiVersion: 2,
      schemaVersion: "kogane-card-upcoming-bills-v1",
      view: "upcoming",
      date: "2098-12-01",
      cardsTruncated: false,
      bills: [
        {
          card: { source: "myjcb", sourceAccount: "myjcb:synthetic:root" },
          statementPeriod: "2099-01",
          debitDate: "2099-01-10",
          amount: { value: "4000", unit: "JPY", status: "exact" },
          debitAccount: { answer: "unknown", account: null, codes: ["no_debit_account_evidence"] },
        },
        {
          card: { source: "myjcb", sourceAccount: "myjcb:synthetic:unreadable" },
          amount: { unit: "JPY", status: "unparsed", reason: "stored:unparsed" },
        },
      ],
      byDebitAccount: [
        {
          account: null,
          debitDate: "2099-01-10",
          bills: 2,
          cardBills: { unit: "JPY", status: "missing", reason: "bill_not_exact" },
          balance: null,
          covers: "unknown",
          reasons: ["debit_account_unknown", "bill_not_exact"],
          notes: ["other_debits_not_modelled"],
        },
      ],
      notListed: [],
    });
    const overMcp = await mcp({
      method: "tools/call",
      params: { name: TOOL, arguments: { view: "upcoming" } },
    });
    expect(overMcp["result"].isError).toBe(false);
    expect(overMcp["result"].structuredContent).toEqual(overRoute);
    const overAgent = await call(AGENT_PATH, {
      subject: "synthetic-agent",
      body: { view: "upcoming" },
    });
    expect(await overAgent.json()).toEqual(overRoute);
    // A compact answer: well under the 8 KB a client shows.
    expect(JSON.stringify(overRoute).length).toBeLessThan(8 * 1024);
    expect(await tables()).toEqual(before);
  });

  it("refuses any other view or parameter on both transports, and is graded like the default", async () => {
    for (const query of [
      "?view=other",
      "?view=",
      "?view=upcoming&view=upcoming",
      "?view=upcoming&offset=0",
    ]) {
      const response = await call(`${PATH}${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_query" });
    }
    for (const body of [{ view: "other" }, { view: "upcoming", source: "x" }])
      expect((await call(AGENT_PATH, { subject: "synthetic-agent", body })).status).toBe(400);
    const narrowed = await direct(
      { view: "upcoming" },
      { scopes: { sources: ["myjcb"], accounts: "*" } },
    );
    expect(narrowed.status).toBe(403);
    expect(narrowed.body).toMatchObject({ code: "evidence_restricted", refs: ["scope:source"] });
    const summary = await direct({ view: "upcoming" }, { capabilities: ["summary.read"] });
    expect(summary.status).toBe(403);
    schemaAhead = true;
    expect((await call(`${PATH}?view=upcoming`)).status).toBe(404);
  });

  it("records each served agent call as one read of the bills and the cards not listed", async () => {
    const last = (await env.DB.prepare(
      "SELECT coalesce(max(rowid),0) AS n FROM audit_records",
    ).first<number>("n"))!;
    const response = await call(AGENT_PATH, {
      subject: "synthetic-agent",
      body: { view: "upcoming" },
    });
    expect(response.status).toBe(200);
    const records = (
      await env.DB.prepare(
        "SELECT result,diff_json FROM audit_records WHERE operation='card-settlements.debit-accounts' AND rowid>? ORDER BY rowid",
      )
        .bind(last)
        .all()
    ).results;
    expect(records).toEqual([
      { result: "read", diff_json: JSON.stringify({ kind: "read", rows: 2, truncated: false }) },
    ]);
  });
});

// Last, so the cards it adds change no answer above.
describe("a card whose due date is not answered", () => {
  beforeAll(async () => {
    await seedStatements([
      ["myjcb:synthetic:undated", 4000, "4000", undefined],
      ["myjcb:synthetic:misdated", 4000, "4000", "2099-02-30"],
    ]);
  });

  it("says why on the route and through the tool alike, never a bare null (INV05)", async () => {
    const overRoute = (await (await call(PATH)).json()) as Record<string, any>;
    expect(validCardDebitAccountsReview(overRoute)).toBe(true);
    const statements = Object.fromEntries(
      overRoute["items"].map((item: Record<string, any>) => [
        item["card"].sourceAccount,
        item["latestStatement"],
      ]),
    );
    expect(statements["myjcb:synthetic:misdated"]).toMatchObject({
      paymentDate: null,
      paymentDateReason: "payment_date_invalid",
    });
    expect(statements["myjcb:synthetic:undated"]).toMatchObject({
      paymentDate: null,
      paymentDateReason: "payment_date_absent",
    });
    // A dated statement carries no reason.
    expect(statements["myjcb:synthetic:root"]).not.toHaveProperty("paymentDateReason");
    const overMcp = await mcp({ method: "tools/call", params: { name: TOOL, arguments: {} } });
    expect(overMcp["result"].isError).toBe(false);
    expect(overMcp["result"].structuredContent).toEqual(overRoute);
  });
});

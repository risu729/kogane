// The bounded list of allocations (ADR 0074, amendment 2026-11-07) over the
// real Worker and the real CORE migrations: one MyJCB statement whose window
// holds the planner's own bound of 32 SMBC debits, each a third of its total,
// so 4,960 three-debit sums pay it exactly. The operator's route, the agent
// route and `kogane.card-settlements.unmatched` over MCP answer one bounded
// page: the first 50 allocations, their count and the truncation marker,
// accepted by the browser's wire contract. Every value is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validUnmatchedCardStatementsReview } from "../../../packages/observation-shared/src/card-statements-unmatched-contract";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const PATH = "/api/v2/reconciliation/card-statements-unmatched";
const AGENT_PATH = "/api/agent/v1/card-settlements.unmatched";
const TOOL = "kogane.card-settlements.unmatched";
const MCP_AUDIENCE = "fixture-mcp-audience";
const DEBITS = 32;
const BANK_ACCOUNT = "smbc-bank:synthetic-bound";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

async function parseRun(source: string, parser: string): Promise<number> {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources(producer_id,source_id) VALUES('evidence-test',?)",
    ).bind(source),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('evidence-test','evidence-test',?)",
    ).bind(source),
  ]);
  const run = await seedRun({ source, count: 1 });
  const parse =
    await env.DB.prepare(`INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES(?,?,'1','2099-03-12T00:00:00Z','ok','[]') RETURNING id`)
      .bind(run.artifacts[0]!.id, parser)
      .first<{ id: number }>();
  return parse!.id;
}

beforeAll(async () => {
  await seedRegistry();
  const card = await parseRun("myjcb", "myjcb-credit-statement-total");
  await env.DB.prepare(`INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
    VALUES(?,'myjcb:synthetic-bound:root','credit_statement_payment_amount',3000,'3000',0,'JPY','2099-03-01','synthetic-total',?)`)
    .bind(
      card,
      JSON.stringify({
        _kogane: {
          period: "2099-03",
          paymentDate: "2099-03-10",
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        },
      }),
    )
    .run();
  await publishParse(card);
  const bank = await parseRun("smbc-bank", "smbc-direct-transactions");
  const ids: number[] = [];
  for (let index = 0; index < DEBITS; index++) {
    const providerId = `bound-${String(index).padStart(2, "0")}`;
    const row =
      await env.DB.prepare(`INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,counterparty,as_of,raw_locator,extra_json)
      VALUES(?,?,?,'posted',-1000,'-1000',0,'JPY','synthetic','2099-03-10T00:00:00+09:00',?,?) RETURNING id`)
        .bind(
          bank,
          BANK_ACCOUNT,
          providerId,
          "synthetic-" + providerId,
          JSON.stringify({
            id: providerId,
            _kogane: {
              direction: "outflow",
              amountSignSource: "direction",
              identityOrigin: "provider-id",
            },
          }),
        )
        .first<{ id: number }>();
    ids.push(row!.id);
  }
  await publishParse(bank);
  // A resolved account for every debit, so each has an admitted alias class.
  const prefix = "unmatched-bound";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO source_accounts VALUES (?,'smbc-bank','evidence-test',?)").bind(
      `${prefix}-ref`,
      JSON.stringify([BANK_ACCOUNT]),
    ),
    env.DB.prepare(
      "INSERT INTO accounts VALUES (?, 'Synthetic account','cash','provider-local')",
    ).bind(`${prefix}-account`),
    env.DB.prepare(
      "INSERT INTO account_mappings VALUES (?,?,1,?,'rule','provider-scope',1,'2099','Synthetic account','provider-local')",
    ).bind(`${prefix}-mapping`, `${prefix}-ref`, `${prefix}-account`),
    env.DB.prepare("INSERT INTO identity_runs VALUES (?,?,1,'2099')").bind(
      `${prefix}-identity`,
      bank,
    ),
    ...ids.map((id) =>
      env.DB.prepare(
        "INSERT INTO identity_observations VALUES (?,?,'transaction',?,?,?,'[]')",
      ).bind(
        `${prefix}-observation-${id}`,
        `${prefix}-identity`,
        id,
        `${prefix}-ref`,
        `${prefix}-mapping`,
      ),
    ),
    env.DB.prepare("INSERT INTO identity_run_seals VALUES (?,?,'2099')").bind(
      `${prefix}-identity`,
      ids.length,
    ),
  ]);
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://unmatched-bound-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected synthetic test request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

async function call(path: string, options: { body?: unknown; subject?: string } = {}) {
  const token = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(path === "/mcp" ? MCP_AUDIENCE : "fixture-audience")
    .setSubject(options.subject ?? "synthetic-operator")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  const init: RequestInit = {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      "cf-access-jwt-assertion": token,
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

describe("a window of 32 equal debits", () => {
  it("is answered with the first 50 allocations, their count and the marker, the same over every transport", async () => {
    const response = await call(PATH);
    expect(response.status).toBe(200);
    const text = await response.text();
    const page = JSON.parse(text) as Record<string, any>;
    expect(validUnmatchedCardStatementsReview(page)).toBe(true);
    expect(page["manifest"].planner.bounds).toEqual({
      statements: 16,
      debits: 32,
      allocations: 50,
    });
    const [item] = page["items"];
    expect(item).toMatchObject({
      statement: { sourceId: "myjcb", period: "2099-03" },
      code: "no_equal_amount_debit",
      debitsInWindow: DEBITS,
      planner: {
        status: "needs_review",
        codes: ["candidate_not_unique"],
        allocationCount: 4960,
        allocationsTruncated: true,
      },
      acceptable: false,
    });
    expect(item.planner.allocations).toHaveLength(50);
    for (const allocation of item.planner.allocations)
      expect(allocation).toMatchObject({ kind: "multiple-debits" });
    // Uncapped, this one statement's answer listed 4,960 allocations (about 7 MB).
    expect(text.length).toBeLessThan(200_000);

    const overAgent = await call(AGENT_PATH, { subject: "synthetic-agent", body: {} });
    expect(overAgent.status).toBe(200);
    expect(await overAgent.json()).toEqual(page);
    const overMcp = (await (
      await call("/mcp", {
        subject: "synthetic-agent",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: TOOL, arguments: { offset: 0 } },
        },
      })
    ).json()) as Record<string, any>;
    expect(overMcp["result"].isError).toBe(false);
    expect(overMcp["result"].structuredContent).toEqual(page);
  });
});

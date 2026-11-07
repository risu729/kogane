// UI/MCP parity guards (ADR 0081, point 4).
//
// 1. Every catalogue operation on the `ui` path is also on `mcp`, and its tool
//    is published in the MCP tool list, unless it is R4.
// 2. Every API route the web UI reads has an MCP read, through the explicit
//    route-to-tool map below, and every other published read tool is mapped
//    or listed, so a tool that closes a route gap cannot leave it listed.
// 3. No MCP adapter file runs SQL of its own (ADR 0081, point 2).
//
// Each guard has an allow-list of the gaps known when it landed
// (2026-11-07). A gap's fix removes its entry: a listed gap that is no longer
// a gap fails here too, so the lists only shrink. Adding an entry is a
// regression of ADR 0081 and needs the owner's agreement in the PR.
//
// "Published" means published to the widest caller this Worker serves: an
// MCP client whose grant holds every agent capability over the whole store
// and whose delegation holds every delegation capability, on a deployment
// with every flag on. A tool missing from that list exists for nobody.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import {
  OPERATION_CATALOGUE,
  type OperationName,
} from "../../../packages/application/src/operation-path/catalogue.ts";
import { AGENT_CAPABILITIES } from "../../../packages/application/src/grants.ts";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";
import { routeServes, uiApiPatterns, withoutComments } from "./ui-routes";

// ── 1. catalogue operations on `ui` ──────────────────────────────────────

/** Catalogue operations on `ui` with no published MCP tool yet, and why. */
const OPERATION_GAPS: Readonly<Partial<Record<OperationName, string>>> = {
  "schedules.survey.decide":
    "survey proposal accept/reject (POST /api/ops/v1/schedules/proposals/:id); needs a delegated tool over the same writer",
  "schedules.lease.release":
    "stopped-execution lease release (POST /api/ops/v1/schedules/leases/:source); R3, needs a tool that refuses with a recorded refusal (ADR 0081 point 3)",
};

/** Catalogue entries on `ui` that are records, not operations anyone calls. */
const NOT_OPERATIONS: Readonly<Partial<Record<OperationName, string>>> = {
  "audit.overflow": "the Processor's daily aggregate of capped audit records; no tool by design",
};

// ── 2. UI read routes ────────────────────────────────────────────────────

/**
 * UI read routes and the MCP tools that read the same service. A route's
 * `:name` segments are parameters.
 */
const READ_ROUTE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "/api/v2/query": ["kogane.financial.query", "kogane.context.open"],
  "/api/identity/instrument-candidates": ["kogane.instruments.candidates"],
  "/api/identity/account-candidates": ["kogane.accounts.candidates"],
  "/api/identity/instrument-history": ["kogane.instruments.history"],
  "/api/identity/instrument-coverage": ["kogane.instruments.coverage"],
  "/api/v2/card-purchases": ["kogane.purchases.explain"],
  "/api/v2/reported-state": ["kogane.reported-state.read"],
  "/api/v2/reconstructed-state": ["kogane.reconstructed-state.read"],
  "/api/v2/audit": ["kogane.audit.search"],
};

/** UI read routes with no MCP read yet, and what the UI reads there. */
const READ_ROUTE_GAPS: Readonly<Record<string, string>> = {
  // Deployment and page plumbing.
  "/api/meta":
    "parsingHealth and globalPassEmptyMonths; kogane.capabilities carries the same store capabilities (its api field) but not these",
  "/api/overview": "overview counts of the observation store",
  "/api/filter-options": "filter choices of the v1 list pages",
  // v1 observation lists and detail (the evidence browser's record side).
  "/api/transactions": "v1 transaction list",
  "/api/balances": "v1 balance list and history",
  "/api/positions": "v1 positions with valuations",
  "/api/artifacts": "fetch artifact list",
  "/api/artifacts/:id": "one fetch artifact",
  "/api/observations/:kind/:id":
    "one observation; kogane.explain expands the same ref into a graph, not this detail",
  "/api/raw/:sha256": "raw evidence download",
  // The evidence browser.
  "/api/evidence/v1/meta": "evidence browser",
  "/api/evidence/v1/sources/:source/runs": "evidence browser",
  "/api/evidence/v1/runs/:run/artifacts": "evidence browser",
  "/api/evidence/v1/runs/:run/artifacts/:artifact": "evidence browser",
  "/api/evidence/v1/runs/:run/artifacts/:artifact/raw": "evidence browser",
  // Balances and rewards.
  "/api/v2/balances/latest": "latest balances (READ projection)",
  "/api/v2/balances/history": "balance history (READ projection)",
  "/api/v2/rewards/holdings": "reward holdings",
  "/api/v2/rewards/expiry": "reward expiry",
  // Identity pages.
  "/api/identity/connections": "account connections",
  "/api/identity/accounts": "provider-local accounts",
  "/api/identity/instruments": "provider-local instruments",
  "/api/identity/coverage": "identity coverage per source",
  // Reconciliation and reported state.
  "/api/v2/reconciliation/card-settlements":
    "card settlement review; owned by Phase 2 unit 2g, not by this guard's PR",
  "/api/v2/reconciliation/card-settlements/ownership":
    "card ownership review; owned by Phase 2 unit 2g, not by this guard's PR",
  "/api/v2/reported-holdings-change": "reported holdings between two dates (ADR 0075)",
  // Reports, quality, schedules, delegations.
  "/api/v2/reports": "stored report list",
  "/api/v2/reports/:id": "one stored report",
  "/api/v2/reports/:id/explanation": "a report's explanation",
  "/api/v2/reports/:id/export": "a report's export download",
  "/api/collection-quality": "collection quality summary",
  "/api/collection-quality/:source": "collection quality cells of one source",
  "/api/ops/v1/schedules":
    "schedule page snapshot (jobs, leases, survey proposals, maintenance); kogane.schedules.maintenance.read covers maintenance only",
  "/api/v2/delegations": "the operator's delegation status page",
};

/**
 * Published tools that are neither a `ui` operation (guard 1) nor mapped from
 * a UI read route above, and why. A new read tool must be mapped or listed
 * here, so a tool that closes a gap above cannot leave the gap listed.
 */
const TOOLS_WITHOUT_UI_ROUTE: Readonly<Record<string, string>> = {
  "kogane.capabilities":
    "the grant and the store capabilities; /api/meta carries more (a gap above)",
  "kogane.explain": "an evidence graph of one ref, not the observation detail (a gap above)",
  "kogane.reconcile.propose": "an agent's relation proposal; no screen offers it",
  "kogane.economic-readiness.read": "economic row readiness; no screen reads it",
  "kogane.audit.get":
    "one audit record by id (readAuditRecordForGrant); the audit page reads pages only (readAuditPage, kogane.audit.search)",
  "kogane.schedules.maintenance.read":
    "the maintenance part of /api/ops/v1/schedules (a gap above)",
};

/** Paths the UI names that are not read routes. */
const NOT_READ_ROUTES: Readonly<Record<string, string>> = {
  "/api/command/v1": "the change lifecycle's path prefix constant",
  "/api/command/v1/:operation": "POST only: the catalogue's command.* operations (guard 1)",
  "/api/evidence/v1": "the evidence browser's path prefix constant",
};

// ── 3. SQL in MCP adapters ───────────────────────────────────────────────

/** MCP adapter files that still run SQL of their own: statements per file. */
const SQL_GAPS: Readonly<Record<string, { count: number; what: string }>> = {
  "services/app/src/agent-service.ts": {
    count: 1,
    what: "scopedParseRuns, the parse-run window a source-scoped grant opens a context with (context.open, financial.query, explain, reconcile.propose)",
  },
  "services/app/src/delegated-maintenance-tools.ts": {
    count: 1,
    what: "the 24-hour delegated write count",
  },
  "services/app/src/delegated-schedule-tools.ts": {
    count: 1,
    what: "the 24-hour delegated write count",
  },
  "services/app/src/ops-tools.ts": {
    count: 1,
    what: "the ops_requests source lookup of kogane.ops.operation.get",
  },
};

/** The files that define or serve MCP tools. */
const ADAPTER_FILE =
  /^services\/app\/src\/(?:mcp|agent-api|agent-service|read-tools|schedule-tools|ops-tools|delegated-[a-z-]+-tools)\.ts$/u;
const APP_SOURCES = import.meta.glob("../src/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
// Upper case only, as this repository writes SQL: with `i`, a `select`
// identifier and a later `import … from` would count as a statement.
const SQL_STATEMENT =
  /\b(?:SELECT\s[\s\S]*?\sFROM|(?:INSERT|REPLACE)(?:\s+OR\s+[A-Z]+)?\s+INTO|UPDATE(?:\s+OR\s+[A-Z]+)?\s+\w+\s+SET|DELETE\s+FROM)\b/gu;

// ── the widest published tool list ───────────────────────────────────────

const OWNER = "owner-parity-synthetic";
const PRINCIPAL = `mcp-client:${OWNER}`;
const APP_AUD = "fixture-browser-audience";
const MCP_AUD = "fixture-mcp-audience";
const ISSUER = "https://parity-test.cloudflareaccess.com";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${ISSUER}/cdn-cgi/access/certs`) return new Response(JSON.stringify(jwks));
      throw new Error("unexpected external request");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function widestConfiguration(): Record<string, unknown> {
  const all = { sources: "*", accounts: "*", scheduleSources: "*" };
  return {
    ACCESS_ISSUER: ISSUER,
    ACCESS_AUDIENCE: APP_AUD,
    ACCESS_MCP_AUDIENCE: MCP_AUD,
    OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
    AGENT_API_GRANTS: JSON.stringify({
      [PRINCIPAL]: {
        scopes: all,
        capabilities: AGENT_CAPABILITIES,
        budget: { maxRows: 1000, maxProposalTargets: 5, maxExplainDepth: 6 },
      },
    }),
    MCP_DELEGATIONS: JSON.stringify({
      [PRINCIPAL]: {
        delegatedBy: OWNER,
        role: "operator-delegate",
        scopes: all,
        issuedAt: new Date(Date.now() - 60_000).toISOString(),
        notAfter: new Date(Date.now() + 3_600_000).toISOString(),
        budget: { writesPerDay: 30 },
      },
    }),
    COMMANDS_ENABLED: "true",
    OPS_API_ENABLED: "true",
    SCHEDULES_ENABLED: "true",
    // Listing a tool calls no Processor; a call would fail loudly here.
    PIPELINE: {
      fetch: vi.fn(async () => {
        throw new Error("unexpected Processor call");
      }),
    },
  };
}

async function publishedTools(): Promise<Set<string>> {
  const assertion = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(ISSUER)
    .setAudience(MCP_AUD)
    .setSubject(OWNER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  const response = await worker.fetch(
    new Request("https://fixture.test/mcp", {
      method: "POST",
      headers: {
        ...MCP_CLIENT_HEADERS,
        "mcp-protocol-version": "2025-11-25",
        "cf-access-jwt-assertion": assertion,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    { ...env, ...widestConfiguration() } as Env,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { result: { tools: { name: string }[] } };
  return new Set(body.result.tools.map((tool) => tool.name));
}

// ── the guards ───────────────────────────────────────────────────────────

describe("catalogue operations on ui are published on mcp (ADR 0081, point 4)", () => {
  const onUi = (Object.keys(OPERATION_CATALOGUE) as OperationName[]).filter((name) => {
    const entry = OPERATION_CATALOGUE[name];
    return (
      (entry.paths as readonly string[]).includes("ui") &&
      !(entry.risk as readonly string[]).every((risk) => risk === "R4") &&
      !Object.hasOwn(NOT_OPERATIONS, name)
    );
  });

  it("lists only ui entries as records", () => {
    for (const name of Object.keys(NOT_OPERATIONS) as OperationName[])
      expect(OPERATION_CATALOGUE[name].paths).toContain("ui");
  });

  it("the widest tool list is the one the guards compare against", async () => {
    // A sanity floor: a misconfigured fixture that publishes only the six
    // base tools would make every guard below vacuous or wrong.
    const tools = await publishedTools();
    for (const name of [
      "kogane.command.plan",
      "kogane.command.approve",
      "kogane.ops.collection.request",
      "kogane.schedules.job.update",
      "kogane.schedules.maintenance.update",
      "kogane.purchases.explain",
      "kogane.reconstructed-state.read",
      "kogane.audit.search",
    ])
      expect(tools).toContain(name);
  });

  it("every ui operation lists mcp and has a published tool, except the known gaps", async () => {
    const tools = await publishedTools();
    const missing = onUi.filter(
      (name) =>
        !(OPERATION_CATALOGUE[name].paths as readonly string[]).includes("mcp") ||
        !tools.has(`kogane.${name}`),
    );
    expect(missing.filter((name) => !Object.hasOwn(OPERATION_GAPS, name))).toEqual([]);
    // A fixed gap leaves the list in the same PR.
    expect(Object.keys(OPERATION_GAPS).sort()).toEqual([...missing].sort());
  });
});

describe("UI read routes have an MCP read (ADR 0081, point 4)", () => {
  const routes = [
    ...Object.keys(READ_ROUTE_TOOLS),
    ...Object.keys(READ_ROUTE_GAPS),
    ...Object.keys(NOT_READ_ROUTES),
  ];

  it("lists each route once", () => {
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("every API path the UI names is a listed route", () => {
    const unlisted = [...uiApiPatterns()]
      .filter(([pattern]) => !routes.some((route) => routeServes(route, pattern)))
      .map(([pattern, files]) => `${pattern} (${files.join(", ")})`);
    expect(unlisted).toEqual([]);
  });

  it("every listed route is one the UI names", () => {
    const patterns = [...uiApiPatterns().keys()];
    expect(routes.filter((route) => !patterns.some((p) => routeServes(route, p)))).toEqual([]);
  });

  it("every other published tool is mapped from a UI route or listed", async () => {
    const tools = await publishedTools();
    const mapped = new Set(Object.values(READ_ROUTE_TOOLS).flat());
    const uiOperation = (tool: string) => {
      const name = tool.slice("kogane.".length);
      return (
        Object.hasOwn(OPERATION_CATALOGUE, name) &&
        (OPERATION_CATALOGUE[name as OperationName].paths as readonly string[]).includes("ui")
      );
    };
    expect([...tools].filter((tool) => !mapped.has(tool) && !uiOperation(tool)).sort()).toEqual(
      Object.keys(TOOLS_WITHOUT_UI_ROUTE).sort(),
    );
  });

  it("every mapped tool is published", async () => {
    const tools = await publishedTools();
    const unpublished = Object.entries(READ_ROUTE_TOOLS).flatMap(([route, names]) =>
      names.filter((name) => !tools.has(name)).map((name) => `${route} -> ${name}`),
    );
    expect(unpublished).toEqual([]);
  });
});

describe("MCP adapters run no SQL of their own (ADR 0081, point 2)", () => {
  const adapters = Object.entries(APP_SOURCES)
    .map(([file, text]) => [file.replace(/^\.\.\//u, "services/app/"), text] as const)
    .filter(([file]) => ADAPTER_FILE.test(file));

  it("scans every file that names an MCP tool", () => {
    // A tool name in code, not in a comment: a new tool file the pattern
    // misses fails here instead of escaping the scan.
    const naming = Object.entries(APP_SOURCES)
      .filter(([, text]) => /["'`]kogane\.[a-z]/u.test(withoutComments(text)))
      .map(([file]) => file.replace(/^\.\.\//u, "services/app/"))
      .sort();
    expect(adapters.map(([file]) => file).sort()).toEqual(naming);
    expect(naming).toContain("services/app/src/mcp.ts");
  });

  it("only the known files run SQL, each its known number of statements", () => {
    const found = Object.fromEntries(
      adapters
        .map(
          ([file, text]) =>
            [file, withoutComments(text).match(SQL_STATEMENT)?.length ?? 0] as const,
        )
        .filter(([, count]) => count > 0),
    );
    expect(found).toEqual(
      Object.fromEntries(Object.entries(SQL_GAPS).map(([file, gap]) => [file, gap.count])),
    );
  });
});

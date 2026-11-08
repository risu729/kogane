// UI/MCP parity guards (ADR 0081, point 4).
//
// 1. Every catalogue operation on the `ui` path is also on `mcp`, and its tool
//    is published in the MCP tool list, unless it is R4.
// 2. Every API route the web UI reads has an MCP read, through the explicit
//    route-to-tool map below, and every other published read tool is mapped
//    or listed, so a tool that closes a route gap cannot leave it listed.
// 3. Every change kind the lifecycle plans (the confirmation page's
//    `command.*` operations: card settlement accept, withdraw and reject, the
//    ownership review, identity) is one `kogane.command.plan` accepts and one
//    `kogane.command.approve` and `.commit` decide, so guard 1's `command.*`
//    entries cover every kind a screen can decide. It runs the gates
//    themselves (the App's decision capability, the delegated envelope, the
//    Processor's command route and the writer's family check), never a list
//    beside them, so a family one gate accepts and another refuses fails.
//
// ADR 0081 point 2 (no SQL in MCP adapters) is guarded by
// `tests/mcp-tools-no-sql.test.ts`.
//
// Each guard has an allow-list of the gaps known when it landed
// (2026-11-07). A gap's fix removes its entry: a listed gap that is no longer
// a gap fails here too, so the lists only shrink. Adding an entry is a
// regression of ADR 0081 and needs the owner's agreement in the PR.
//
// "Published" means published to an MCP client, which since ADR 0084 holds
// every agent capability and every operation over the whole store, on a
// deployment with every flag on. A tool missing from that list exists for
// nobody.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import {
  OPERATION_CATALOGUE,
  type OperationName,
} from "../../../packages/application/src/operation-path/catalogue.ts";
import {
  CHANGE_KINDS,
  delegatedCan,
  delegatedCommandFamilyAllowed,
  ECONOMIC_EVENT_PLANNERS,
  executionFor,
  isCardReviewKind,
  isEconomicEventKind,
  processorCall,
  resolveDelegation,
  REVIEW_PLANNERS,
} from "../../../packages/application/src/index";
import {
  delegatedDecisionAllowed,
  delegatedPlanAllowed,
} from "../../processor/src/change-commands";
import { DELEGATED_COMMAND_TOOLS } from "../src/delegated-command-tools";
import {
  decisionCapabilityFor,
  EXECUTABLE_DECISION_CAPABILITIES,
} from "../src/delegated-decision-tools";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";
import { routeServes, uiApiPatterns } from "./ui-routes";

// ── 1. catalogue operations on `ui` ──────────────────────────────────────

/** Catalogue operations on `ui` with no published MCP tool yet, and why. */
const OPERATION_GAPS: Readonly<Partial<Record<OperationName, string>>> = {};

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
  "/api/v2/reconciliation/card-statements-unmatched": ["kogane.card-settlements.unmatched"],
  "/api/v2/reconciliation/card-settlements": ["kogane.card-settlements.read"],
  "/api/v2/reconciliation/card-settlements/ownership": ["kogane.card-settlements.ownership"],
  "/api/v2/reconciliation/card-settlements/statements": ["kogane.card-settlements.statements"],
  // UI read pages (src/page-read-tools.ts): each the route's own reader.
  "/api/identity/connections": ["kogane.identity.read"],
  "/api/identity/accounts": ["kogane.identity.read"],
  "/api/identity/instruments": ["kogane.identity.read"],
  "/api/identity/coverage": ["kogane.identity.read"],
  "/api/meta": ["kogane.store.read"],
  "/api/overview": ["kogane.store.read"],
  "/api/filter-options": ["kogane.store.read"],
  "/api/transactions": ["kogane.observations.list"],
  "/api/balances": ["kogane.observations.list"],
  "/api/positions": ["kogane.observations.list"],
  "/api/artifacts": ["kogane.observations.list"],
  "/api/artifacts/:id": ["kogane.observations.get"],
  "/api/observations/:kind/:id": ["kogane.observations.get"],
  "/api/v2/balances/latest": ["kogane.balances.read"],
  "/api/v2/balances/history": ["kogane.balances.read"],
  "/api/v2/rewards/holdings": ["kogane.rewards.read"],
  "/api/v2/rewards/expiry": ["kogane.rewards.read"],
  "/api/v2/reported-holdings-change": ["kogane.reported-holdings-change.read"],
  "/api/v2/reports": ["kogane.reports.read"],
  "/api/v2/reports/:id": ["kogane.reports.read"],
  "/api/v2/reports/:id/explanation": ["kogane.reports.read"],
  "/api/collection-quality": ["kogane.collection-quality.read"],
  "/api/collection-quality/:source": ["kogane.collection-quality.read"],
  "/api/collection-quality/:source/accounts": ["kogane.collection-quality.read"],
  "/api/evidence/v1/meta": ["kogane.evidence.read"],
  "/api/evidence/v1/sources/:source/runs": ["kogane.evidence.read"],
  "/api/evidence/v1/runs/:run/artifacts": ["kogane.evidence.read"],
  "/api/evidence/v1/runs/:run/artifacts/:artifact": ["kogane.evidence.read"],
  // The jobs and leases, the maintenance window and the re-survey section.
  "/api/ops/v1/schedules": [
    "kogane.schedules.read",
    "kogane.schedules.maintenance.read",
    "kogane.schedules.survey.read",
  ],
  "/api/raw/:sha256": ["kogane.evidence.raw.read"],
  "/api/evidence/v1/runs/:run/artifacts/:artifact/raw": ["kogane.evidence.raw.read"],
  // The 依頼の経過 page: one operation's receipt, `execution` block included,
  // from `readOperation`, whichever principal requested it (ADR 0086).
  "/api/ops/v1/operations/:id": ["kogane.ops.operation.get"],
};

/** UI read routes with no MCP read yet, and what the UI reads there. */
const READ_ROUTE_GAPS: Readonly<Record<string, string>> = {
  // Report export.
  "/api/v2/reports/:id/export":
    "a report's export download; not served over MCP (ADR 0072 amendment 2026-11-07: kogane.reports.read returns the report itself)",
};

/**
 * Published tools that are neither a `ui` operation (guard 1) nor mapped from
 * a UI read route above, and why. A new read tool must be mapped or listed
 * here, so a tool that closes a gap above cannot leave the gap listed.
 */
const TOOLS_WITHOUT_UI_ROUTE: Readonly<Record<string, string>> = {
  "kogane.capabilities": "the grant and the store capabilities; /api/meta is kogane.store.read",
  "kogane.explain":
    "an evidence graph of one ref; the observation detail is kogane.observations.get",
  "kogane.reconcile.propose": "an agent's relation proposal; no screen offers it",
  "kogane.economic-readiness.read": "economic row readiness; no screen reads it",
  "kogane.events.read":
    "GET /api/v2/activity and /api/v2/obligations, which no screen reads (ADR 0072); plan D19",
  "kogane.audit.get":
    "one audit record by id (readAuditRecordForGrant); the audit page reads pages only (readAuditPage, kogane.audit.search)",
};

/** Paths the UI names that are not read routes. */
const NOT_READ_ROUTES: Readonly<Record<string, string>> = {
  "/api/command/v1": "the change lifecycle's path prefix constant",
  "/api/command/v1/:operation": "POST only: the catalogue's command.* operations (guard 1)",
  "/api/ops/v1/collections":
    "POST only: ops.collection.request (guard 1), the schedules page's 収集を依頼",
  "/api/evidence/v1": "the evidence browser's path prefix constant",
};

// ── the widest published tool list ───────────────────────────────────────

const OWNER = "owner-parity-synthetic";
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
  // Since ADR 0084 every MCP client holds every agent capability and every
  // operation over the whole store; nothing configures it.
  return {
    ACCESS_ISSUER: ISSUER,
    ACCESS_AUDIENCE: APP_AUD,
    ACCESS_MCP_AUDIENCE: MCP_AUD,
    OPERATOR_SUBJECTS: JSON.stringify([OWNER]),
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

describe("change kinds the lifecycle plans are decided over MCP (ADR 0081, point 1)", () => {
  // A kind is plannable once its planner exists; the card purchase review and
  // economic-event kinds are refused `unsupported_semantics` to every caller
  // until theirs is registered, so they are not screen operations yet.
  const plannable = CHANGE_KINDS.filter((kind) =>
    isCardReviewKind(kind)
      ? REVIEW_PLANNERS[kind] !== undefined
      : isEconomicEventKind(kind)
        ? ECONOMIC_EVENT_PLANNERS[kind] !== undefined
        : true,
  );

  it("includes the card settlement decisions", () => {
    expect(plannable).toEqual(
      expect.arrayContaining([
        "card-settlement.accept",
        "card-settlement.withdraw",
        "card-settlement.reject",
        "relation.accept",
        "relation.reject",
      ]),
    );
  });

  it("kogane.command.plan publishes every plannable kind and the Processor plans it", () => {
    const plan = DELEGATED_COMMAND_TOOLS.find((tool) => tool.name === "kogane.command.plan")!;
    const kind = (plan.inputSchema as { properties: { kind: { enum: string[] } } }).properties.kind;
    expect(kind.enum).toEqual(expect.arrayContaining([...plannable]));
    // The command route refuses a delegated plan of a kind outside the
    // decidable families `unsupported_semantics`.
    expect(plannable.filter((k) => !delegatedPlanAllowed(k))).toEqual([]);
  });

  it("kogane.command.approve and .commit decide every plannable kind, at every gate", async () => {
    const resolution = await resolveDelegation({
      caller: { kind: "mcp-client", principal: "mcp-client:parity-guard" },
      now: new Date().toISOString(),
    });
    if (!resolution.ok) throw new Error(resolution.code);
    const principal = resolution.principal;
    const execution = executionFor(principal);
    const refused: string[] = [];
    for (const kind of plannable)
      for (const tool of ["approve", "commit"] as const) {
        const at = (gate: string) => refused.push(`${tool} ${kind}: ${gate}`);
        // App: the tool requires this capability of the plan's kind
        // (`operation_not_delegable` otherwise), the MCP authority must
        // hold it, and the tools are listed only to a holder of one of
        // EXECUTABLE_DECISION_CAPABILITIES.
        let capability: string | null = null;
        try {
          const required = decisionCapabilityFor(kind);
          delegatedCan(principal, required);
          capability = required;
        } catch {
          at("app capability");
        }
        if (
          capability !== null &&
          !(EXECUTABLE_DECISION_CAPABILITIES as readonly string[]).includes(capability)
        )
          at("app tool listing");
        // Processor: the command route's family check on the envelope the App sends.
        if (!delegatedDecisionAllowed(kind, execution.commandFamilies)) at("processor route");
        // Writer: approve()/commit()'s family attenuation on the confirmed call.
        const call = processorCall(
          {
            path: "mcp",
            correlationId: crypto.randomUUID(),
            delegatedExecution: {
              ...execution,
              idempotencyKey: "parity-guard",
              payloadDigest: "0".repeat(64),
              confirmsAuditId: `aud_${crypto.randomUUID()}`,
              confirmationDigest: `cfm_${"0".repeat(64)}`,
            },
          },
          `command.${tool}`,
          principal.id,
          "delegated",
        );
        if (!delegatedCommandFamilyAllowed(call, kind)) at("writer family");
      }
    expect(refused).toEqual([]);
  });
});

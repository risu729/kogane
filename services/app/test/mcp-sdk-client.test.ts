// The official MCP TypeScript SDK client (`@modelcontextprotocol/client`)
// against this Worker's `/mcp`, in both protocol eras (ADR 0047, matrix 9).
// Nothing here is hand-rolled on the client side: the SDK opens the
// connection, negotiates the revision and calls the tools. The fetch it is
// given forwards to the Worker and adds the one header Cloudflare Access adds
// at the edge after Managed OAuth: a signed assertion for the MCP Access
// application. Every key, audience and principal is synthetic.
import { env } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import {
  AGENT_TOOL_NAMES,
  PURCHASES_TOOL_NAME,
  RECONSTRUCTED_STATE_TOOL_NAME,
} from "../src/agent-service";
import {
  LEASE_RELEASE_TOOL,
  SCHEDULE_READ_TOOL,
  SCHEDULE_UPDATE_TOOL,
  SURVEY_READ_TOOL,
} from "../src/schedule-tools";
import { QUERY_GRANT_CAPABILITIES } from "../../../packages/application/src/index";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const APP_AUD = "fixture-app-audience";
const MCP_AUD = "fixture-mcp-audience";
const OWNER = "00000000-0000-4000-8000-0000000000cc";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let issuer: string;
let sequence = 0;

beforeAll(async () => {
  await seedRegistry();
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
  const run = await seedRun({ count: 1, source: "sony-bank" });
  const parse = await env.DB.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES (?,'sdk-fixture','1','2026-09-07','ok','[]') RETURNING id`)
    .bind(run.artifacts[0].id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
});
beforeEach(() => {
  issuer = `https://mcp-sdk-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

/** What Access forwards for a Managed OAuth token issued by the MCP application. */
async function edgeAssertion(subject: string, audience = MCP_AUD): Promise<string> {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

/** A transport whose requests reach the Worker the way Access would deliver them. */
function transport(environment: Record<string, unknown>, audience = MCP_AUD) {
  return new StreamableHTTPClientTransport(new URL("https://fixture.test/mcp"), {
    fetch: async (input: string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set("cf-access-jwt-assertion", await edgeAssertion(OWNER, audience));
      return worker.fetch(new Request(request, { headers }), {
        ...env,
        ACCESS_ISSUER: issuer,
        ACCESS_AUDIENCE: APP_AUD,
        ACCESS_MCP_AUDIENCE: MCP_AUD,
        ...environment,
      } as Env);
    },
  });
}

/** Nothing configures an MCP client (ADR 0084). */
const GRANTED = {};

/**
 * Every flag that publishes more tools. The Processor is never reached:
 * listing calls no tool.
 */
const EVERY_FEATURE = {
  SCHEDULES_ENABLED: "true",
  OPS_API_ENABLED: "true",
  COMMANDS_ENABLED: "true",
  PIPELINE: {
    fetch: async () => {
      throw new Error("Unexpected Processor request in a tools/list test");
    },
  },
};
/** Tools only a flag above publishes; their presence proves the flags took effect. */
const EVERY_FEATURE_TOOLS = [
  SCHEDULE_READ_TOOL,
  SURVEY_READ_TOOL,
  SCHEDULE_UPDATE_TOOL,
  LEASE_RELEASE_TOOL,
  "kogane.schedules.survey.decide",
  "kogane.schedules.job.update",
  "kogane.command.plan",
  "kogane.command.approve",
  "kogane.ops.collection.request",
];

describe("the official SDK client against /mcp", () => {
  for (const mode of ["legacy", "auto"] as const) {
    it(`initializes, lists and calls the tools (${mode} negotiation)`, async () => {
      const client = new Client(
        { name: "synthetic-sdk-client", version: "0" },
        { versionNegotiation: { mode } },
      );
      await client.connect(transport(GRANTED));
      try {
        // `legacy` speaks the initialize-based revision; `auto` probes and
        // takes the stateless 2026-07-28 revision this server also serves.
        expect(client.getProtocolEra()).toBe(mode === "legacy" ? "legacy" : "modern");
        expect(client.getNegotiatedProtocolVersion()).toBe(
          mode === "legacy" ? "2025-11-25" : "2026-07-28",
        );
        const listed = await client.listTools();
        // The agent tools, every read tool the whole-store grant answers, the
        // purchase explanation (CORE 0047 is applied; the retired reader name
        // is not read) and the reconstructed state's read.
        expect(listed.tools.map((tool) => tool.name)).toEqual([
          ...AGENT_TOOL_NAMES,
          "kogane.instruments.history",
          "kogane.reported-state.read",
          "kogane.instruments.coverage",
          "kogane.accounts.candidates",
          "kogane.card-settlements.unmatched",
          "kogane.economic-readiness.read",
          "kogane.card-settlements.read",
          "kogane.card-settlements.ownership",
          "kogane.audit.search",
          "kogane.audit.get",
          "kogane.identity.read",
          "kogane.store.read",
          "kogane.observations.list",
          "kogane.observations.get",
          "kogane.balances.read",
          "kogane.rewards.read",
          "kogane.reported-holdings-change.read",
          "kogane.events.read",
          "kogane.reports.read",
          "kogane.collection-quality.read",
          PURCHASES_TOOL_NAME,
          RECONSTRUCTED_STATE_TOOL_NAME,
        ]);
        const capabilities = await client.callTool({ name: "kogane.capabilities", arguments: {} });
        expect(capabilities.isError).toBe(false);
        expect(capabilities.structuredContent).toMatchObject({
          principal: `mcp-client:${OWNER}`,
          capabilities: [...QUERY_GRANT_CAPABILITIES],
        });
        const coverage = await client.callTool({
          name: "kogane.financial.query",
          arguments: { intent: "coverage" },
        });
        expect(coverage.isError, JSON.stringify(coverage.structuredContent)).toBe(false);
        expect(coverage.structuredContent).toMatchObject({
          schemaVersion: "kogane-query-response-v1",
        });
        // A refusal is a tool error the model can read.
        const unknown = await client.callTool({
          name: "kogane.financial.query",
          arguments: { intent: "net-worth" },
        });
        expect(unknown.isError).toBe(true);
        expect(unknown.structuredContent).toMatchObject({ code: "unsupported_semantics" });
      } finally {
        await client.close();
      }
    });
  }

  // Every feature that adds tools is on, so the catalogue is the largest this
  // Worker publishes. The SDK client validates each descriptor of `tools/list`
  // (an `inputSchema` must be `type: "object"` at its root): one invalid
  // descriptor fails the whole list, as it did for Cloudflare's MCP Portal.
  for (const mode of ["legacy", "auto"] as const) {
    it(`lists the whole catalogue with every feature on (${mode} negotiation)`, async () => {
      const client = new Client(
        { name: "synthetic-sdk-client", version: "0" },
        { versionNegotiation: { mode } },
      );
      await client.connect(transport(EVERY_FEATURE));
      try {
        const listed = await client.listTools();
        const names = listed.tools.map((tool) => tool.name);
        expect(names).toEqual(expect.arrayContaining(EVERY_FEATURE_TOOLS));
        expect(new Set(names).size).toBe(names.length);
        for (const tool of listed.tools) {
          expect(tool.inputSchema.type, tool.name).toBe("object");
          // Clients that hand a tool to a model refuse a root combinator.
          for (const key of ["oneOf", "anyOf", "allOf", "not"])
            expect(Object.keys(tool.inputSchema), tool.name).not.toContain(key);
          // ChatGPT refuses a Unicode property escape in a pattern.
          expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/\\\\[pP]\{/u);
        }
      } finally {
        await client.close();
      }
    });
  }

  it("cannot connect with a token minted for the browser application", async () => {
    for (const [environment, audience] of [[GRANTED, APP_AUD]] as const) {
      const client = new Client({ name: "synthetic-sdk-client", version: "0" });
      await expect(client.connect(transport(environment, audience))).rejects.toThrow();
      await client.close();
    }
  });
});

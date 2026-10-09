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
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const APP_AUD = "fixture-app-audience";
const MCP_AUD = "fixture-mcp-audience";
const OWNER = "00000000-0000-4000-8000-0000000000cc";
const GRANT = {
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read"],
  budget: { maxRows: 200, maxProposalTargets: 3, maxExplainDepth: 3 },
};

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

const GRANTED = { AGENT_API_GRANTS: JSON.stringify({ [`mcp-client:${OWNER}`]: GRANT }) };

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
        // The agent tools, the purchase explanation (CORE 0047 is applied; the
        // retired reader name is not read) and the reconstructed state's read.
        expect(listed.tools.map((tool) => tool.name)).toEqual([
          ...AGENT_TOOL_NAMES,
          PURCHASES_TOOL_NAME,
          RECONSTRUCTED_STATE_TOOL_NAME,
        ]);
        const capabilities = await client.callTool({ name: "kogane.capabilities", arguments: {} });
        expect(capabilities.isError).toBe(false);
        expect(capabilities.structuredContent).toMatchObject({
          principal: `mcp-client:${OWNER}`,
          capabilities: ["summary.read"],
        });
        const coverage = await client.callTool({
          name: "kogane.financial.query",
          arguments: { intent: "coverage" },
        });
        expect(coverage.isError, JSON.stringify(coverage.structuredContent)).toBe(false);
        expect(coverage.structuredContent).toMatchObject({
          schemaVersion: "kogane-query-response-v1",
        });
        // A capability the grant lacks is a tool error the model can read.
        const activity = await client.callTool({
          name: "kogane.financial.query",
          arguments: { intent: "activity" },
        });
        expect(activity.isError).toBe(true);
        expect(activity.structuredContent).toMatchObject({ code: "unauthorized" });
      } finally {
        await client.close();
      }
    });
  }

  it("cannot connect without a grant, or with a token minted for the browser application", async () => {
    for (const [environment, audience] of [
      [{ AGENT_API_GRANTS: "" }, MCP_AUD],
      [GRANTED, APP_AUD],
    ] as const) {
      const client = new Client({ name: "synthetic-sdk-client", version: "0" });
      await expect(client.connect(transport(environment, audience))).rejects.toThrow();
      await client.close();
    }
  });
});

// An unknown argument key is refused `unsupported_semantics` and named in the
// refusal's refs, so a caller can see which key it sent that no tool reads.
// The key is the caller's own text: a refusal names at most ten such keys,
// each cut to its first 64 UTF-16 code units, on every tool that names them,
// over both `/api/agent/v1/<tool>` and `/mcp`. Synthetic keys only.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const APP_AUDIENCE = "fixture-audience";
const MCP_AUDIENCE = "fixture-mcp-audience";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let issuer: string;
let sequence = 0;

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://unknown-key-refs-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

async function post(path: string, body: unknown): Promise<Response> {
  const jwt = await new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(path === "/mcp" ? MCP_AUDIENCE : APP_AUDIENCE)
    .setSubject("synthetic-agent")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": jwt,
        ...(path === "/mcp" ? MCP_CLIENT_HEADERS : {}),
      },
      body: JSON.stringify(body),
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: APP_AUDIENCE,
      ACCESS_MCP_AUDIENCE: MCP_AUDIENCE,
    } as Env,
  );
}

/** Twelve distinct unknown keys of 4,000 characters each: about 48 KB, inside the body bound. */
const LONG_KEYS = Array.from({ length: 12 }, (_, index) =>
  `${String.fromCharCode(97 + index)}`.repeat(4_000),
);
const withLongKeys = (known: Record<string, unknown>) => ({
  ...known,
  ...Object.fromEntries(LONG_KEYS.map((key) => [key, 1])),
});

/** Each tool that names an unknown key in its refs, with arguments that are otherwise valid. */
const TOOLS: [tool: string, args: Record<string, unknown>][] = [
  ["financial.query", { intent: "coverage" }],
  ["context.open", {}],
  ["explain", { ref: "observation:transaction:1" }],
  [
    "reconcile.propose",
    {
      kind: "same_account",
      from: "source_account:synthetic-a",
      to: "source_account:synthetic-b",
      evidenceRefs: ["fetch_artifact:1"],
      reason: "synthetic proposal",
      method: "ai",
    },
  ],
];

function expectBoundedRefs(refusal: unknown, label: string): void {
  expect(refusal, label).toMatchObject({ code: "unsupported_semantics" });
  const refs = (refusal as { refs: string[] }).refs;
  expect(refs, label).toEqual(LONG_KEYS.slice(0, 10).map((key) => key.slice(0, 64)));
}

describe("an unknown key is named by a bounded prefix, never echoed whole", () => {
  for (const [tool, args] of TOOLS) {
    it(`/api/agent/v1/${tool}`, async () => {
      const response = await post(`/api/agent/v1/${tool}`, withLongKeys(args));
      expect(response.status).toBe(400);
      const text = await response.text();
      expectBoundedRefs(JSON.parse(text), tool);
      // Ten 64-character prefixes and the fixed envelope; the 48 KB the caller sent stays out.
      expect(text.length).toBeLessThan(2_048);
    });

    it(`/mcp tools/call kogane.${tool}`, async () => {
      const response = await post("/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: `kogane.${tool}`, arguments: withLongKeys(args) },
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const message = JSON.parse(text) as {
        result: { isError: boolean; structuredContent: unknown };
      };
      expect(message.result.isError).toBe(true);
      expectBoundedRefs(message.result.structuredContent, tool);
      // The refusal twice (structured and as text), never the keys the caller sent.
      expect(text.length).toBeLessThan(4_096);
    });
  }

  it("names a key nested in a query by the same bound (context.open)", async () => {
    const response = await post("/api/agent/v1/context.open", {
      query: withLongKeys({ intent: "coverage" }),
    });
    expect(response.status).toBe(400);
    expectBoundedRefs(await response.json(), "context.open query");
  });

  it("never splits a surrogate pair, so neither body carries a lone surrogate escape", async () => {
    // U+1F600 at code units 64 and 65: a plain cut would leave `\ud83d`.
    const key = `${"x".repeat(63)}\u{1F600}tail`;
    const route = await post("/api/agent/v1/financial.query", { intent: "coverage", [key]: 1 });
    expect(route.status).toBe(400);
    const text = await route.text();
    expect(text).not.toMatch(/\\ud[89ab]/iu);
    expect(JSON.parse(text)).toMatchObject({ refs: ["x".repeat(63)] });
    const tool = await post("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "kogane.financial.query", arguments: { intent: "coverage", [key]: 1 } },
    });
    const toolText = await tool.text();
    expect(toolText).not.toMatch(/\\+ud[89ab]/iu);
    expect(
      (JSON.parse(toolText) as { result: { structuredContent: unknown } }).result.structuredContent,
    ).toMatchObject({ refs: ["x".repeat(63)] });
  });

  it("keeps a short unknown key whole, as before", async () => {
    const response = await post("/api/agent/v1/financial.query", {
      intent: "coverage",
      sql: "SELECT 1",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "unsupported_semantics",
      refs: ["sql"],
    });
  });
});

// The method contract of every route family of this Worker, over the real
// Worker and the real migrations. Nothing here is a real account, credential,
// amount or token.
//
// What these checks pin:
//   * every `405 method_not_allowed` carries an `Allow` header naming exactly
//     the methods its route serves (RFC 9110 §15.5.6): `GET, HEAD` for a read,
//     `POST` for a write, and the security headers every answer carries;
//   * HEAD is the GET without its body on every route that serves GET: the
//     same status and the same headers — the health route, the operations
//     reads and the schedules page included, which answered HEAD with 405;
//   * who the caller is is still decided before the method: an unproved
//     caller gets the same 401 for a method the route does not serve.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { AUDIT_PATH } from "../src/audit-api";
import { MCP_PATH, SHARED_QUERY_PATH } from "../src/agent-api";
import { CARD_PURCHASES_PATH } from "../src/card-purchases-api";
import { CARD_OWNERSHIP_PATH, CARD_SETTLEMENT_PATH } from "../src/card-settlements-api";
import { ECONOMIC_READINESS_PATH } from "../src/economic-readiness-api";
import { HEALTH_PATH } from "../src/health";
import { OPS_PREFIX } from "../src/ops-api";
import { RECONSTRUCTED_STATE_PATH } from "../src/reconstructed-state-api";
import { REPORTED_STATE_PATH } from "../src/reported-state-api";
import { SCHEDULES_PATH } from "../src/schedules-api";
import { seedRegistry } from "./fixtures";
import { MCP_CLIENT_HEADERS } from "./mcp-headers";

const SHA = "b".repeat(40);
const OPERATOR = "method-operator";
const PROBE_TOKEN = "method-probe.access";
const DEPLOY_TOKEN = "method-deploy.access";
const AUDIENCE = "method-audience";
const MCP_AUDIENCE = "method-mcp-audience";
const READ = "GET, HEAD";
const WRITE = "POST";

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
});
beforeEach(() => {
  issuer = `https://method-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

/** Who sends the request: the operator's browser session, an MCP client, or a service token. */
type Caller = "operator" | "mcp" | "probe" | "deploy" | "anonymous";

async function assertion(caller: Caller): Promise<string | null> {
  if (caller === "anonymous") return null;
  const service = caller === "probe" ? PROBE_TOKEN : caller === "deploy" ? DEPLOY_TOKEN : null;
  return new SignJWT({ type: "app", ...(service ? { common_name: service } : {}) })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience(caller === "mcp" ? MCP_AUDIENCE : AUDIENCE)
    .setSubject(service ? "" : OPERATOR)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

/** A Processor that answers its health and the schedules snapshot, as the binding would. */
const PIPELINE = {
  fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/internal/health")
      return Response.json({ ok: true, worker: "kogane-observation-pipeline", releaseSha: SHA });
    if (path === "/internal/schedules" && request.method === "GET")
      return Response.json({ schedules: [], maintenance: [], leases: [], survey: [] });
    return Response.json({ error: "not_found" }, { status: 404 });
  },
};

/** Every flag on, so each family answers as its own route, not as the GET-only boundary. */
const SERVED = {
  COMMANDS_ENABLED: "true",
  OPS_API_ENABLED: "true",
  SCHEDULES_ENABLED: "true",
};

async function call(
  path: string,
  method: string,
  options: { caller?: Caller; environment?: Record<string, unknown> } = {},
) {
  const caller = options.caller ?? (path === MCP_PATH ? "mcp" : "operator");
  const jwt = await assertion(caller);
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method,
      headers: {
        ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}),
        ...(path === MCP_PATH ? MCP_CLIENT_HEADERS : {}),
      },
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: AUDIENCE,
      ACCESS_MCP_AUDIENCE: MCP_AUDIENCE,
      OPERATOR_SUBJECTS: JSON.stringify([OPERATOR]),
      AGENT_GRANTS: JSON.stringify([]),
      HEALTH_PROBE_TOKENS: JSON.stringify([PROBE_TOKEN]),
      DEPLOYMENT_SCHEDULE_TOKENS: JSON.stringify([DEPLOY_TOKEN]),
      RELEASE_SHA: SHA,
      PIPELINE,
      ...SERVED,
      ...options.environment,
    } as Env,
  );
}

/** A response's headers, without the one that differs on every request. */
function headersOf(response: Response): [string, string][] {
  return [...response.headers].filter(([name]) => name !== "x-request-id").sort();
}

interface Refusal {
  readonly family: string;
  readonly path: string;
  readonly methods: readonly string[];
  readonly allow: string;
  readonly caller?: Caller;
  readonly environment?: Record<string, unknown>;
}

// One row per route family; each refuses at least one method it does not
// serve. The read routes are answered by the Worker's GET-only boundary, the
// writes by their own routes.
const REFUSALS: readonly Refusal[] = [
  {
    family: "evidence browser",
    path: "/api/evidence/v1/meta",
    methods: ["POST", "PUT"],
    allow: READ,
  },
  { family: "observation reads", path: "/api/meta", methods: ["POST", "DELETE"], allow: READ },
  { family: "the shell's assets", path: "/", methods: ["POST"], allow: READ },
  { family: "an unrouted API path", path: "/api/nothing-here", methods: ["POST"], allow: READ },
  {
    family: "shared query",
    path: `${SHARED_QUERY_PATH}?intent=coverage`,
    methods: ["POST"],
    allow: READ,
  },
  { family: "audit log", path: AUDIT_PATH, methods: ["PATCH"], allow: READ },
  { family: "card settlements", path: CARD_SETTLEMENT_PATH, methods: ["POST"], allow: READ },
  { family: "card ownership", path: CARD_OWNERSHIP_PATH, methods: ["PUT"], allow: READ },
  { family: "card purchases", path: CARD_PURCHASES_PATH, methods: ["POST"], allow: READ },
  { family: "reported state", path: REPORTED_STATE_PATH, methods: ["POST"], allow: READ },
  { family: "reconstructed state", path: RECONSTRUCTED_STATE_PATH, methods: ["POST"], allow: READ },
  { family: "economic readiness", path: ECONOMIC_READINESS_PATH, methods: ["POST"], allow: READ },
  {
    family: "pending decisions",
    path: "/api/v2/decisions/pending",
    methods: ["POST"],
    allow: READ,
  },
  { family: "changes since", path: "/api/v2/changes", methods: ["POST"], allow: READ },
  { family: "collection quality", path: "/api/collection-quality", methods: ["POST"], allow: READ },
  { family: "identity", path: "/api/identity/accounts", methods: ["POST"], allow: READ },
  { family: "reports", path: "/api/v2/reports", methods: ["POST"], allow: READ },
  { family: "rewards", path: "/api/v2/rewards", methods: ["POST"], allow: READ },
  { family: "events", path: "/api/v2/activity", methods: ["POST"], allow: READ },
  { family: "health", path: HEALTH_PATH, methods: ["POST", "DELETE"], allow: READ },
  { family: "health (probe)", path: HEALTH_PATH, methods: ["POST"], allow: READ, caller: "probe" },
  {
    family: "change lifecycle",
    path: "/api/command/v1/plan",
    methods: ["GET", "HEAD", "PUT"],
    allow: WRITE,
  },
  {
    family: "agent HTTP",
    path: "/api/agent/v1/capabilities",
    methods: ["GET", "HEAD", "DELETE"],
    allow: WRITE,
  },
  { family: "MCP", path: MCP_PATH, methods: ["GET", "HEAD", "DELETE"], allow: WRITE },
  {
    family: "operations accept",
    path: `${OPS_PREFIX}/collections`,
    methods: ["PUT"],
    allow: WRITE,
  },
  {
    family: "operations session refresh",
    path: `${OPS_PREFIX}/sessions/sony-bank/refresh`,
    methods: ["DELETE"],
    allow: WRITE,
  },
  { family: "operations list", path: `${OPS_PREFIX}/operations`, methods: ["PUT"], allow: READ },
  {
    family: "operations read",
    path: `${OPS_PREFIX}/operations/op_${"0".repeat(64)}`,
    methods: ["DELETE"],
    allow: READ,
  },
  {
    family: "an unrouted operations path",
    path: `${OPS_PREFIX}/purge`,
    methods: ["PUT"],
    allow: "GET, HEAD, POST",
  },
  {
    family: "operations with the flag off",
    path: `${OPS_PREFIX}/collections`,
    methods: ["POST"],
    allow: READ,
    environment: { OPS_API_ENABLED: "" },
  },
  { family: "schedules page", path: SCHEDULES_PATH, methods: ["PUT"], allow: READ },
  {
    family: "schedules job",
    path: `${SCHEDULES_PATH}/sony-bank`,
    methods: ["GET", "HEAD"],
    allow: WRITE,
  },
  {
    family: "schedules maintenance",
    path: `${SCHEDULES_PATH}/maintenance`,
    methods: ["GET"],
    allow: WRITE,
  },
  {
    family: "schedules bootstrap",
    path: `${SCHEDULES_PATH}/bootstrap`,
    methods: ["GET", "HEAD"],
    allow: WRITE,
    caller: "deploy",
  },
];

describe("every 405 names what its route serves (RFC 9110 §15.5.6)", () => {
  for (const row of REFUSALS)
    it(`${row.family}: ${row.methods.join(", ")} → 405 with Allow: ${row.allow}`, async () => {
      for (const method of row.methods) {
        const response = await call(row.path, method, {
          ...(row.caller ? { caller: row.caller } : {}),
          ...(row.environment ? { environment: row.environment } : {}),
        });
        expect(response.status, method).toBe(405);
        expect(response.headers.get("allow"), method).toBe(row.allow);
        // The header joins the answer; it replaces none of the others.
        expect(response.headers.get("cache-control"), method).toBe("no-store");
        expect(response.headers.get("x-content-type-options"), method).toBe("nosniff");
        expect(response.headers.get("cross-origin-resource-policy"), method).toBe("same-origin");
        expect(response.headers.get("x-request-id"), method).toMatch(/^[0-9a-f-]{36}$/u);
        if (method === "HEAD") expect(await response.text(), method).toBe("");
        else expect(await response.json(), method).toMatchObject({ error: "method_not_allowed" });
      }
    });

  it("is the only answer that carries Allow", async () => {
    for (const [path, method] of [
      ["/api/meta", "GET"],
      ["/api/nothing-here", "GET"],
      [`${OPS_PREFIX}/purge`, "POST"],
    ] as const) {
      const response = await call(path, method);
      expect(response.status, path).not.toBe(405);
      expect(response.headers.get("allow"), path).toBeNull();
    }
  });

  it("still decides who the caller is before the method", async () => {
    for (const path of [
      HEALTH_PATH,
      "/api/command/v1/plan",
      "/api/agent/v1/capabilities",
      MCP_PATH,
    ]) {
      const response = await call(path, "PUT", { caller: "anonymous" });
      expect(response.status, path).toBe(401);
      expect(response.headers.get("allow"), path).toBeNull();
    }
  });
});

interface Read {
  readonly family: string;
  readonly path: string;
  readonly caller?: Caller;
}

// One read per family, its answer whatever the empty store makes it: a 200, a
// 404 where the store lacks the read's tables, a 400 for a refused query. HEAD
// must give the same in every case.
const READS: readonly Read[] = [
  { family: "evidence browser", path: "/api/evidence/v1/meta" },
  { family: "observation reads", path: "/api/meta" },
  { family: "an unrouted API path", path: "/api/nothing-here" },
  { family: "shared query", path: `${SHARED_QUERY_PATH}?intent=coverage` },
  { family: "shared query refused", path: SHARED_QUERY_PATH },
  { family: "audit log", path: AUDIT_PATH },
  { family: "card settlements", path: CARD_SETTLEMENT_PATH },
  { family: "card purchases", path: CARD_PURCHASES_PATH },
  { family: "reported state", path: `${REPORTED_STATE_PATH}?date=2026-01-01` },
  { family: "reported state refused query", path: REPORTED_STATE_PATH },
  { family: "economic readiness refused query", path: ECONOMIC_READINESS_PATH },
  { family: "pending decisions", path: "/api/v2/decisions/pending" },
  {
    family: "changes since",
    path: `/api/v2/changes?since=${new Date(Date.now() - 3_600_000).toISOString().replace(/\.\d{3}Z$/u, "Z")}`,
  },
  { family: "collection quality", path: "/api/collection-quality" },
  { family: "identity", path: "/api/identity/accounts" },
  { family: "health", path: HEALTH_PATH },
  { family: "health (probe)", path: HEALTH_PATH, caller: "probe" },
  { family: "health refused query", path: `${HEALTH_PATH}?verbose=1` },
  { family: "operations list", path: `${OPS_PREFIX}/operations` },
  { family: "operations read", path: `${OPS_PREFIX}/operations/op_${"0".repeat(64)}` },
  { family: "an operations accept path", path: `${OPS_PREFIX}/collections` },
  { family: "schedules page", path: SCHEDULES_PATH },
  { family: "schedules page in full", path: `${SCHEDULES_PATH}?detail=full` },
  { family: "schedules page refused query", path: `${SCHEDULES_PATH}?detail=everything` },
];

describe("HEAD is GET without its body", () => {
  for (const row of READS)
    it(`${row.family}: HEAD ${row.path}`, async () => {
      const options = row.caller ? { caller: row.caller } : {};
      const get = await call(row.path, "GET", options);
      const head = await call(row.path, "HEAD", options);
      expect(head.status).toBe(get.status);
      expect(headersOf(head)).toEqual(headersOf(get));
      expect(await head.text()).toBe("");
      expect(get.headers.get("allow")).toBeNull();
    });

  it("answers the reads HEAD used to refuse", async () => {
    // The health route, the operations reads and the schedules page each
    // served GET and refused HEAD with 405; their GETs succeed here.
    for (const path of [HEALTH_PATH, `${OPS_PREFIX}/operations`, SCHEDULES_PATH]) {
      const head = await call(path, "HEAD");
      expect(head.status, path).toBe(200);
    }
  });
});

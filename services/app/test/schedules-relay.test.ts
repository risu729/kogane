// What the schedules routes serve when they relay a Processor answer: its
// status and its body bytes, under this Worker's own JSON type, and none of the
// Processor's headers. A relayed body never chooses how this origin serves it,
// so a Processor that answered HTML (it answers only JSON today) would not have
// that HTML served as a page here. Every value is invented.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";

const PATH = "/api/ops/v1/schedules";
const SHA = "b".repeat(40);
const OPERATOR = "relay-operator";
const TOKEN = "relay-deploy.access";
const HTML = "<!doctype html><title>synthetic</title><script>parent.x=1</script>";
/** Headers a Processor answer must never carry into this Worker's answer. */
const UPSTREAM_ONLY = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src *; script-src 'unsafe-inline'",
  "set-cookie": "synthetic=1; Path=/",
  "x-synthetic-upstream": "1",
};
/** The App's own content security policy, which no relayed answer replaces. */
const OWN_CSP = "default-src 'self'";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: { keys: unknown[] };
let issuer: string;
let sequence = 0;
beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256", use: "sig" }],
  };
});
beforeEach(() => {
  issuer = `https://schedules-relay-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("unexpected_external_request");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

/** The Processor's answer to the relayed request: a body, a status and headers. */
interface Upstream {
  body: string;
  status: number;
  headers: Record<string, string>;
}

async function call(
  upstream: Upstream,
  request: { suffix?: string; method?: string; body?: string; serviceToken?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "cf-access-jwt-assertion": await new SignJWT({
      type: "app",
      ...(request.serviceToken ? { common_name: request.serviceToken } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer)
      .setAudience("test")
      .setSubject(request.serviceToken ? "" : OPERATOR)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey),
  };
  if (request.body !== undefined) {
    headers["content-type"] = "application/json";
    headers["origin"] = "https://fixture.test";
    headers["x-kogane-settings"] = "1";
  }
  return worker.fetch(
    new Request(`https://fixture.test${PATH}${request.suffix ?? ""}`, {
      method: request.method ?? "GET",
      headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    }),
    {
      ...env,
      SCHEDULES_ENABLED: "true",
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "test",
      OPERATOR_SUBJECTS: JSON.stringify([OPERATOR]),
      DEPLOYMENT_SCHEDULE_TOKENS: JSON.stringify([TOKEN]),
      RELEASE_SHA: SHA,
      PIPELINE: {
        fetch: async (relayedRequest: Request) => {
          // The bootstrap's release check reads the Processor's health first.
          if (new URL(relayedRequest.url).pathname === "/internal/health")
            return Response.json({ releaseSha: SHA });
          return new Response(upstream.body, {
            status: upstream.status,
            headers: upstream.headers,
          });
        },
      },
    } as unknown as Env,
  );
}

/** Each route that relays a Processor answer, and the request that reaches it. */
const RELAYS = [
  { name: "the full snapshot", request: { suffix: "?detail=full" } },
  { name: "a job edit", request: { suffix: "/sony-bank", method: "POST", body: '{"revision":1}' } },
  {
    name: "the deployment bootstrap",
    request: { suffix: "/bootstrap", method: "POST", serviceToken: TOKEN },
  },
] as const;

/** The headers of this Worker's answer that would say how a browser treats it. */
function served(response: Response) {
  return {
    type: response.headers.get("content-type"),
    csp: response.headers.get("content-security-policy"),
    cookie: response.headers.get("set-cookie"),
    upstream: response.headers.get("x-synthetic-upstream"),
  };
}

describe("a relayed schedules answer is served under this Worker's own JSON type", () => {
  it("never serves an HTML body the Processor labelled text/html as text/html", async () => {
    const cases = [
      // The summary relays a Processor refusal; its 200 is parsed, never relayed.
      { name: "a summary refusal", request: {}, status: 503 },
      ...RELAYS.flatMap((relay) => [
        { ...relay, name: `${relay.name} refused`, status: 409 },
        // The bootstrap parses its 200 and refuses what is not its answer
        // (the next test), so only its refusal is relayed.
        ...(relay.name === "the deployment bootstrap" ? [] : [{ ...relay, status: 200 }]),
      ]),
    ];
    for (const { name, request, status } of cases) {
      const response = await call({ body: HTML, status, headers: UPSTREAM_ONLY }, request);
      expect(response.status, name).toBe(status);
      const headers = served(response);
      expect(headers.type, name).toBe("application/json");
      expect(headers.csp, name).toContain(OWN_CSP);
      expect(headers.cookie, name).toBeNull();
      expect(headers.upstream, name).toBeNull();
      // The bytes cross as they are; only the type that frames them is the App's.
      expect(await response.text(), name).toBe(HTML);
    }
  });

  it("refuses an HTML bootstrap answer with its closed code, as before", async () => {
    const response = await call(
      { body: HTML, status: 200, headers: UPSTREAM_ONLY },
      { suffix: "/bootstrap", method: "POST", serviceToken: TOKEN },
    );
    expect(response.status).toBe(503);
    expect(served(response).type).toBe("application/json");
    expect(await response.json()).toMatchObject({ error: "scheduling_unavailable" });
  });

  it("relays a valid JSON answer with its status and exact bytes", async () => {
    // Spacing, key order and a trailing newline the App's own serializer
    // would not produce: the bytes are relayed, never re-serialized.
    const snapshot =
      '{ "schedules" : [ ], "maintenance": [], "leases":[] ,"survey" : null, "z": 1.10 }\n';
    const refusal = '{"error" : "version_conflict" }';
    for (const { name, request } of RELAYS)
      for (const [body, status] of [
        [snapshot, 200],
        [refusal, 409],
      ] as const) {
        if (name === "the deployment bootstrap" && status === 200) continue;
        const response = await call(
          { body, status, headers: { "content-type": "application/json" } },
          request,
        );
        expect(response.status, `${name} ${status}`).toBe(status);
        expect(served(response).type, `${name} ${status}`).toBe("application/json");
        expect(await response.text(), `${name} ${status}`).toBe(body);
      }
    const summaryRefusal = await call(
      { body: refusal, status: 503, headers: { "content-type": "application/json" } },
      {},
    );
    expect(summaryRefusal.status).toBe(503);
    expect(await summaryRefusal.text()).toBe(refusal);
  });
});

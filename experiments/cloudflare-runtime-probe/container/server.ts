import { createHash } from "node:crypto";
import { Impit } from "impit";

const TLS_PROBE_URL = "https://tls.peet.ws/api/all";
const TEST_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

type UnknownRecord = Record<string, unknown>;

interface JsonResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(value: unknown, ...path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" ? current : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sanitizeFingerprint(route: string, response: JsonResponseLike) {
  if (!response.ok) {
    throw new Error(`${route} fingerprint endpoint returned ${response.status}`);
  }
  const value: unknown = await response.json();
  const ip = stringAt(value, "ip");
  if (!ip) throw new Error(`${route} fingerprint response has no IP`);
  return {
    route,
    status: response.status,
    ipHash: sha256(ip),
    httpVersion: stringAt(value, "http_version"),
    userAgent: stringAt(value, "user_agent"),
    ja3Hash: stringAt(value, "tls", "ja3_hash"),
    ja4: stringAt(value, "tls", "ja4"),
    akamaiFingerprint: stringAt(value, "http2", "akamai_fingerprint"),
    akamaiFingerprintHash: stringAt(value, "http2", "akamai_fingerprint_hash"),
  };
}

async function nodeFingerprint(): Promise<Response> {
  const response = await fetch(TLS_PROBE_URL, {
    headers: {
      "cache-control": "no-store",
      "user-agent": TEST_USER_AGENT,
    },
  });
  return Response.json(await sanitizeFingerprint("container-node", response));
}

async function impitFingerprint(): Promise<Response> {
  const response = await new Impit({
    browser: "chrome142",
    headers: { "user-agent": TEST_USER_AGENT },
  }).fetch(TLS_PROBE_URL, {
    headers: { "cache-control": "no-store" },
  });
  return Response.json(await sanitizeFingerprint("container-impit", response));
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: "container-probe-error", error: message }));
  return Response.json({ error: message }, { status: 502 });
}

Bun.serve({
  port: 8080,
  async fetch(request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === "/health") return Response.json({ ok: true });
      if (path === "/probe/container-node") return await nodeFingerprint();
      if (path === "/probe/container-impit") return await impitFingerprint();
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
      return errorResponse(error);
    }
  },
});

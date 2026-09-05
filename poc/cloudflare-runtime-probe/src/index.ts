import { Container, getContainer } from "@cloudflare/containers";

const TLS_PROBE_URL = "https://tls.peet.ws/api/all";
const TEST_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const MAX_TCP_RESPONSE_BYTES = 16 * 1024;

type UnknownRecord = Record<string, unknown>;

interface FingerprintProbe {
  route: string;
  status: number;
  ipHash: string;
  httpVersion: string | null;
  userAgent: string | null;
  ja3Hash: string | null;
  ja4: string | null;
  akamaiFingerprint: string | null;
  akamaiFingerprintHash: string | null;
}

export class RuntimeProbeContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "2m";

  override onStart(): void {
    console.log(JSON.stringify({ event: "container-start" }));
  }

  override onStop(): void {
    console.log(JSON.stringify({ event: "container-stop" }));
  }

  override onError(error: unknown): void {
    console.error(
      JSON.stringify({
        event: "container-error",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
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

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sanitizeFingerprint(route: string, response: Response): Promise<FingerprintProbe> {
  if (!response.ok) {
    throw new Error(`${route} fingerprint endpoint returned ${response.status}`);
  }
  const value: unknown = await response.json();
  const ip = stringAt(value, "ip");
  if (!ip) throw new Error(`${route} fingerprint response has no IP`);
  return {
    route,
    status: response.status,
    ipHash: await sha256(ip),
    httpVersion: stringAt(value, "http_version"),
    userAgent: stringAt(value, "user_agent"),
    ja3Hash: stringAt(value, "tls", "ja3_hash"),
    ja4: stringAt(value, "tls", "ja4"),
    akamaiFingerprint: stringAt(value, "http2", "akamai_fingerprint"),
    akamaiFingerprintHash: stringAt(value, "http2", "akamai_fingerprint_hash"),
  };
}

async function workerFingerprint(): Promise<Response> {
  const response = await fetch(TLS_PROBE_URL, {
    headers: {
      "cache-control": "no-store",
      "user-agent": TEST_USER_AGENT,
    },
  });
  return Response.json(await sanitizeFingerprint("worker-fetch", response));
}

async function readBounded(
  readable: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("response exceeded byte limit");
        throw new Error("TCP response exceeded byte limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function tamiaConnectIp(env: Env): Promise<Response> {
  const socket = await env.TAMIA.connect("api.ipify.org:80");
  const writer = socket.writable.getWriter();
  await writer.write(
    new TextEncoder().encode(
      "GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n",
    ),
  );
  writer.releaseLock();
  const bytes = await readBounded(socket.readable, MAX_TCP_RESPONSE_BYTES);
  await socket.close();
  const wire = new TextDecoder().decode(bytes);
  const separator = wire.indexOf("\r\n\r\n");
  if (separator < 0) {
    throw new Error(
      `Malformed HTTP response over TAMIA.connect (bytes=${bytes.byteLength}, httpPrefix=${wire.startsWith("HTTP/")})`,
    );
  }
  const body: unknown = JSON.parse(wire.slice(separator + 4));
  const ip = stringAt(body, "ip");
  if (!ip) throw new Error("TAMIA.connect response has no IP");
  return Response.json({
    route: "tamia-connect",
    status: 200,
    ipHash: await sha256(ip),
  });
}

async function tamiaFetchFingerprint(env: Env): Promise<Response> {
  const response = await env.TAMIA.fetch(TLS_PROBE_URL, {
    headers: {
      "cache-control": "no-store",
      "user-agent": TEST_USER_AGENT,
    },
  });
  return Response.json(await sanitizeFingerprint("tamia-fetch", response));
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const path = new URL(request.url).pathname;
  if (path === "/") {
    return Response.json({
      endpoints: [
        "/probe/worker",
        "/probe/container-node",
        "/probe/container-impit",
        "/probe/tamia-fetch",
        "/probe/tamia-connect",
      ],
      storesSecrets: false,
    });
  }
  if (path === "/probe/worker") return workerFingerprint();
  if (path === "/probe/tamia-fetch") return tamiaFetchFingerprint(env);
  if (path === "/probe/tamia-connect") return tamiaConnectIp(env);
  if (path === "/probe/container-node" || path === "/probe/container-impit") {
    const container = getContainer(env.PROBE_CONTAINER, "singleton-network-probe");
    return container.fetch(new Request(`http://container${path}`));
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({
          event: "probe-error",
          path: new URL(request.url).pathname,
          error: message,
        }),
      );
      return Response.json({ error: message }, { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;

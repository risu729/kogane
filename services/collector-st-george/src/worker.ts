import { Container, getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import type { R2BucketLike } from "../../../packages/collection/src/index";
import { persistSharedRun } from "./shared-collection";
import { startTcpRelay } from "./tcp-relay";
import {
  authorized,
  CollectionCoordinator,
  parseCollectionOutput,
  parseCredential,
  type CollectionOutput,
  type StateStorage,
} from "./worker-policy";

const RELAY_HOSTS = new Set([
  "ibanking.stgeorge.com.au",
  "www.stgeorge.com.au",
  "webapps.stgeorge.com.au",
  "digital-api.stgeorge.com.au",
]);
export class StGeorgeCollectorContainer extends Container<Env> {
  override defaultPort = 8080;
  override requiredPorts = [8080];
  override sleepAfter = "30s";
  override enableInternet = true;
  override envVars = { TZ: "Australia/Sydney" };
}

/** One named object serializes every trigger and persists uncertainty across eviction. */
export class StGeorgeCollectionState extends DurableObject<Env> {
  private readonly coordinator: CollectionCoordinator;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.coordinator = new CollectionCoordinator(
      ctx.storage as unknown as StateStorage,
      () => collect(env),
      (run) => persistSharedRun(env.DATA as unknown as R2BucketLike, run),
    );
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/trigger", "/resume"].includes(path))
      return Response.json({ error: "not-found" }, { status: 404 });
    try {
      const result =
        path === "/resume" ? await this.coordinator.resume() : await this.coordinator.trigger();
      return Response.json(result, {
        status:
          result.status === "busy" || result.status === "blocked"
            ? 409
            : result.status === "failed"
              ? 503
              : 200,
      });
    } catch {
      // Never forward provider text, exception details, or credentials to the caller.
      return Response.json({ status: "failed", reason: "state-unavailable" }, { status: 503 });
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return Response.json({
        ok: true,
        source: "st-george",
        schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
      });
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket" && url.pathname === "/tcp") {
      return relayTcp(request, env, ctx, url);
    }
    if (request.method !== "POST" || !["/trigger", "/resume"].includes(url.pathname))
      return Response.json({ error: "not-found" }, { status: 404 });
    if (!authorized(request, env.ADMIN_TRIGGER_TOKEN))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (url.searchParams.size !== 0 || request.body !== null)
      return Response.json({ error: "no-parameters-accepted" }, { status: 400 });
    const state = env.SESSION_STATE.get(env.SESSION_STATE.idFromName("st-george"));
    return state.fetch(new Request(`https://state${url.pathname}`, { method: "POST" }));
  },
  async scheduled(_controller, env): Promise<void> {
    const state = env.SESSION_STATE.get(env.SESSION_STATE.idFromName("st-george"));
    const response = await state.fetch(new Request("https://state/trigger", { method: "POST" }));
    if (!response.ok) throw new Error("st-george-collection-not-completed");
  },
} satisfies ExportedHandler<Env>;

async function collect(env: Env): Promise<CollectionOutput> {
  const credential = parseCredential(env.ST_GEORGE_CREDENTIAL_JSON);
  const egress: string = env.EGRESS_MODE;
  if (egress !== "direct" && egress !== "tamia") throw new Error("invalid-configuration");
  let relay: { relayUrl: string; relayToken: string } | undefined;
  if (egress === "tamia") {
    let url: URL;
    try {
      url = new URL(env.RELAY_PUBLIC_URL);
    } catch {
      throw new Error("invalid-configuration");
    }
    if (
      url.protocol !== "wss:" ||
      url.hostname !== "kogane-st-george-collector.takuanimal.workers.dev" ||
      url.pathname !== "/tcp" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !env.RELAY_TOKEN ||
      env.RELAY_TOKEN.length < 32
    )
      throw new Error("invalid-configuration");
    relay = { relayUrl: url.href, relayToken: env.RELAY_TOKEN };
  }
  const container = getContainer(env.COLLECTOR_CONTAINER, `run-${crypto.randomUUID()}`);
  try {
    await container.startAndWaitForPorts();
    const response = await container.fetch(
      new Request("http://container/collect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential, egress, ...relay }),
      }),
    );
    const output = parseCollectionOutput(await readBoundedJson(response));
    if (!response.ok && output.status === "success") throw new Error("container-failed");
    return output;
  } finally {
    // The process owns the credentials and ephemeral browser; tear it down on every path.
    try {
      await container.destroy();
    } catch {
      console.warn(JSON.stringify({ event: "st-george-container-destroy-failed" }));
    }
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const maximumBytes = 2 * 1024 * 1024 + 1024;
  if (!response.body) throw new Error("invalid-snapshot");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new Error("invalid-snapshot");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

interface VpcNetworkBinding extends Fetcher {
  connect(address: SocketAddress | string, options?: SocketOptions): Socket;
}
function relayTcp(request: Request, env: Env, ctx: ExecutionContext, url: URL): Response {
  if (!authorized(request, env.RELAY_TOKEN))
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const hostname = url.searchParams.get("host") ?? "";
  const port = url.searchParams.get("port");
  if (!RELAY_HOSTS.has(hostname) || port !== "443")
    return Response.json({ error: "target-denied" }, { status: 403 });
  const pair = new WebSocketPair();
  pair[1].accept();
  startTcpRelay({
    connect: () => (env.TAMIA as VpcNetworkBinding).connect({ hostname, port: 443 }),
    server: pair[1],
    waitUntil: (promise) => ctx.waitUntil(promise),
  });
  return new Response(null, { status: 101, webSocket: pair[0] });
}

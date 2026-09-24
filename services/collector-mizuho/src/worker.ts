import { timingSafeEqual } from "node:crypto";
import {
  collectMizuho,
  parseSession,
  safeMizuhoErrorCode,
  MizuhoClientError,
  type MizuhoCollection,
  type MizuhoSession,
} from "./client";
import { loginMizuho } from "./login";
import { persistMizuhoRun } from "./storage";

const MAX_REQUEST_BYTES = 96 * 1024;
type Dependencies = {
  login: typeof loginMizuho;
  collect: typeof collectMizuho;
  persist: typeof persistMizuhoRun;
};

function authorized(request: Request, token: string): boolean {
  const provided = request.headers.get("authorization")?.match(/^Bearer ([^\r\n]+)$/u)?.[1];
  if (!provided || !token) return false;
  const a = new TextEncoder().encode(provided),
    b = new TextEncoder().encode(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function requestSession(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new Error("invalid-request");
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES || !request.body)
    throw new Error("invalid-request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) throw new Error("invalid-request");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  // Only the exact empty object selects configured credentials. Malformed
  // session requests cannot accidentally trigger a password submission.
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
    return undefined;
  return parseSession(text);
}

/** Passwords and sessions stay inside one invocation and never enter DATA or the response. */
export function createHandler(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    login: loginMizuho,
    collect: collectMizuho,
    persist: persistMizuhoRun,
    ...overrides,
  };
  async function execute(env: Env, suppliedSession?: MizuhoSession) {
    const runId = crypto.randomUUID(),
      startedAt = new Date().toISOString();
    let collection: MizuhoCollection | undefined;
    let errorCode: string | undefined;
    try {
      let session = suppliedSession;
      if (session === undefined) {
        if (!env.MIZUHO_CUSTOMER_NUMBER || !env.MIZUHO_LOGIN_PASSWORD)
          throw new MizuhoClientError("mizuho-credentials-missing");
        session = await deps.login({
          customerNumber: env.MIZUHO_CUSTOMER_NUMBER,
          password: env.MIZUHO_LOGIN_PASSWORD,
        });
      }
      collection = await deps.collect({ session });
    } catch (error) {
      errorCode = safeMizuhoErrorCode(error);
    }
    const status = collection === undefined ? "failed" : collection.partial ? "partial" : "success";
    const artifactCount = collection?.artifacts.length ?? 0;
    try {
      const persisted = await deps.persist(env.DATA, {
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        version: env.COLLECTOR_SCHEMA_VERSION,
        artifacts: collection?.artifacts ?? [],
        failedUnits: collection?.failedUnits ?? ["account-list"],
        failed: collection === undefined,
        partial: collection?.partial ?? false,
      });
      const complete =
        persisted.outcome === "persisted" || persisted.outcome === "already_persisted";
      return {
        httpStatus: !complete || status === "failed" ? 502 : status === "partial" ? 207 : 200,
        body: {
          runId,
          status,
          persistence: persisted.outcome,
          artifactCount,
          ...(errorCode ? { error: errorCode } : {}),
        },
      };
    } catch {
      return {
        httpStatus: 502,
        body: { runId, status, artifactCount, persistence: "failed", error: "persistence-failed" },
      };
    }
  }
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health")
        return Response.json({
          ok: true,
          source: "mizuho-bank",
          schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
        });
      if (!authorized(request, env.ADMIN_TRIGGER_TOKEN))
        return Response.json({ error: "unauthorized" }, { status: 401 });
      if (request.method !== "POST" || url.pathname !== "/trigger" || url.search)
        return Response.json({ error: "not-found" }, { status: 404 });
      let session;
      try {
        session = await requestSession(request);
      } catch {
        return Response.json({ error: "invalid-session-request" }, { status: 400 });
      }
      const result = await execute(env, session);
      return Response.json(result.body, { status: result.httpStatus });
    },
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
      // A failed daily invocation must not submit the password again through
      // a platform retry; the next configured daily event is independent.
      controller.noRetry();
      const result = await execute(env);
      // Keep scheduler observability independent of provider error text and
      // financial/session fields, including when login or persistence fails.
      console.log(
        JSON.stringify({
          event: "mizuho-scheduled-collection",
          runId: result.body.runId,
          status: result.body.status,
          artifactCount: result.body.artifactCount,
          persistence: result.body.persistence,
        }),
      );
      if (result.httpStatus === 502) throw new Error("mizuho-scheduled-collection-failed");
    },
  } satisfies ExportedHandler<Env>;
}

export default createHandler();

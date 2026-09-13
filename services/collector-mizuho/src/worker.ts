import { timingSafeEqual } from "node:crypto";
import { collectMizuho, parseSession, safeMizuhoErrorCode, type MizuhoCollection } from "./client";
import { persistMizuhoRun } from "./storage";

const MAX_REQUEST_BYTES = 96 * 1024;
type Dependencies = { collect: typeof collectMizuho; persist: typeof persistMizuhoRun };

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
  return parseSession(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Each trigger supplies a fresh session. Session material never enters DATA or the response. */
export function createHandler(
  deps: Dependencies = { collect: collectMizuho, persist: persistMizuhoRun },
) {
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
      const runId = crypto.randomUUID(),
        startedAt = new Date().toISOString();
      let collection: MizuhoCollection | undefined;
      let errorCode: string | undefined;
      try {
        collection = await deps.collect({ session });
      } catch (error) {
        errorCode = safeMizuhoErrorCode(error);
      }
      const status =
        collection === undefined ? "failed" : collection.partial ? "partial" : "success";
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
        return Response.json(
          {
            runId,
            status,
            persistence: persisted.outcome,
            artifactCount: collection?.artifacts.length ?? 0,
            ...(errorCode ? { error: errorCode } : {}),
          },
          { status: !complete || status === "failed" ? 502 : status === "partial" ? 207 : 200 },
        );
      } catch {
        return Response.json({ runId, status, error: "persistence-failed" }, { status: 502 });
      }
    },
  } satisfies ExportedHandler<Env>;
}

export default createHandler();

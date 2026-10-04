import { timingSafeEqual } from "node:crypto";
import { withCollectionLease } from "../../../packages/collection/src/schedule-lease";
import {
  scheduledResult,
  type ScheduledResult,
} from "../../../packages/collection/src/schedule-result";
import { collectPrestiaBank, safePrestiaBankError, type PrestiaBankCollection } from "./client";
import { persistPrestiaBankRun } from "./storage";
type Dependencies = { collect: typeof collectPrestiaBank; persist: typeof persistPrestiaBankRun };
function authorized(request: Request, expected: string): boolean {
  const provided = request.headers.get("authorization")?.match(/^Bearer ([^\r\n]+)$/u)?.[1];
  if (!provided || !expected || provided.length > 4096) return false;
  const a = new TextEncoder().encode(provided),
    b = new TextEncoder().encode(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function emptyTrigger(request: Request): Promise<boolean> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json" ||
    !request.body ||
    Number(request.headers.get("content-length")) > 1024
  )
    return false;
  const reader = request.body.getReader();
  let text = "",
    size = 0;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024) return false;
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    );
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function createHandler(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    collect: collectPrestiaBank,
    persist: persistPrestiaBankRun,
    ...overrides,
  };
  async function execute(env: Env) {
    return withCollectionLease(env, "prestia-bank", async () => {
      const runId = crypto.randomUUID(),
        startedAt = new Date().toISOString();
      let collection: PrestiaBankCollection | undefined, errorCode: string | undefined;
      try {
        collection = await deps.collect({
          userId: env.PRESTIA_BANK_USER_ID,
          password: env.PRESTIA_BANK_PASSWORD,
          userAgent: env.PRESTIA_BANK_USER_AGENT,
        });
      } catch (error) {
        errorCode = safePrestiaBankError(error);
      }
      const status = collection ? "success" : "failed",
        artifactCount = collection ? 1 : 0;
      try {
        const persisted = await deps.persist(env.DATA, {
          runId,
          startedAt,
          completedAt: new Date().toISOString(),
          version: env.COLLECTOR_SCHEMA_VERSION,
          ...(collection ? { body: collection.body } : {}),
        });
        const complete = ["persisted", "already_persisted"].includes(persisted.outcome);
        return {
          httpStatus: !complete || !collection ? 502 : 200,
          body: {
            runId,
            status,
            persistence: persisted.outcome,
            artifactCount,
            ...(collection
              ? {
                  accountCount: collection.accountCount,
                  foreignCurrencyCount: collection.foreignCurrencyCount,
                  aggregateCount: collection.aggregateCount,
                  monthlyAverageCount: collection.monthlyAverageCount,
                  signoffFailed: collection.signoffFailed,
                }
              : {}),
            ...(errorCode ? { error: errorCode } : {}),
          },
        };
      } catch {
        return {
          httpStatus: 502,
          body: {
            runId,
            status,
            artifactCount,
            persistence: "failed",
            error: "persistence-failed",
          },
        };
      }
    });
  }
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health" && !url.search)
        return Response.json({
          ok: true,
          source: "prestia-bank",
          schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
          releaseSha: env.RELEASE_SHA,
        });
      if (!authorized(request, env.ADMIN_TRIGGER_TOKEN))
        return Response.json({ error: "unauthorized" }, { status: 401 });
      if (request.method !== "POST" || url.pathname !== "/trigger" || url.search)
        return Response.json({ error: "not-found" }, { status: 404 });
      if (!(await emptyTrigger(request)))
        return Response.json({ error: "invalid-request" }, { status: 400 });
      try {
        const result = await execute(env);
        return Response.json(result.body, { status: result.httpStatus });
      } catch {
        return Response.json({ error: "collection-unavailable" }, { status: 503 });
      }
    },
    async alarmCollection(env: Env): Promise<ScheduledResult> {
      const result = await execute(env);
      return scheduledResult(result.body);
    },
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
      controller.noRetry();
      const result = await execute(env);
      console.log(JSON.stringify({ event: "prestia-bank-scheduled-collection", ...result.body }));
      if (result.httpStatus !== 200) throw new Error("prestia-bank-scheduled-collection-failed");
    },
  } satisfies ExportedHandler<Env> & { alarmCollection(env: Env): Promise<ScheduledResult> };
}
export default createHandler();
export async function alarmCollection(
  env: Env,
  _cron: string,
  _scheduledTime: number,
): Promise<ScheduledResult> {
  try {
    return await createHandler().alarmCollection(env);
  } catch {
    return { status: "failed", runIds: [], failureCode: "collection_failed" };
  }
}

import { withCollectionLease } from "../../../packages/collection/src/schedule-lease";
import {
  scheduledFailure,
  scheduledResult,
  type ScheduledResult,
} from "../../../packages/collection/src/schedule-result";
import { collectPrestiaBank, safePrestiaBankError, type PrestiaBankCollection } from "./client";
import { persistPrestiaBankRun } from "./storage";
type Dependencies = { collect: typeof collectPrestiaBank; persist: typeof persistPrestiaBankRun };
/** Module-only executor factory, shared by scheduled/RPC collection and synthetic tests. */
export function createCollection(overrides: Partial<Dependencies> = {}) {
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
  return execute;
}
export function createHandler(overrides: Partial<Dependencies> = {}) {
  const execute = createCollection(overrides);
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
      return Response.json({ error: "Not found" }, { status: 404 });
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
  } catch (error) {
    return scheduledFailure(error);
  }
}

import { withCollectionLease } from "../../../packages/collection/src/schedule-lease";
import {
  scheduledFailure,
  scheduledResult,
  type ScheduledResult,
} from "../../../packages/collection/src/schedule-result";
import {
  collectMizuho,
  safeMizuhoErrorCode,
  MizuhoClientError,
  type MizuhoCollection,
} from "./client";
import { loginMizuho } from "./login";
import {
  logMizuhoPhase,
  logMizuhoRecord,
  mizuhoCoverageDiagnostic,
  type MizuhoPhase,
} from "./diagnostics";
import { persistMizuhoRun } from "./storage";

type Dependencies = {
  login: typeof loginMizuho;
  collect: typeof collectMizuho;
  persist: typeof persistMizuhoRun;
};

/** Module-only executor factory; passwords/sessions never enter DATA or operational results. */
export function createCollection(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    login: loginMizuho,
    collect: collectMizuho,
    persist: persistMizuhoRun,
    ...overrides,
  };
  async function execute(env: Env) {
    return withCollectionLease(env, "mizuho-bank", async () => {
      const runId = crypto.randomUUID(),
        startedAt = new Date().toISOString();
      let collection: MizuhoCollection | undefined;
      let errorCode: string | undefined;
      let phase: MizuhoPhase = "configuration";
      let failurePhase: MizuhoPhase | undefined;
      logMizuhoPhase(runId, phase);
      try {
        if (!env.MIZUHO_CUSTOMER_NUMBER || !env.MIZUHO_LOGIN_PASSWORD)
          throw new MizuhoClientError("mizuho-credentials-missing");
        phase = "login";
        logMizuhoPhase(runId, phase);
        const session = await deps.login({
          customerNumber: env.MIZUHO_CUSTOMER_NUMBER,
          password: env.MIZUHO_LOGIN_PASSWORD,
        });
        phase = "collection";
        logMizuhoPhase(runId, phase);
        collection = await deps.collect({ session });
      } catch (error) {
        errorCode = safeMizuhoErrorCode(error);
        failurePhase = phase;
      }
      const status =
        collection === undefined ? "failed" : collection.partial ? "partial" : "success";
      const artifactCount = collection?.artifacts.length ?? 0;
      const diagnostic = {
        event: "mizuho-collection-result",
        runId,
        status,
        artifactCount,
        ...mizuhoCoverageDiagnostic(collection),
        ...(errorCode ? { errorCode, failurePhase } : {}),
      };
      logMizuhoPhase(runId, "persistence");
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
        logMizuhoRecord({
          ...diagnostic,
          persistence: persisted.outcome,
          ...(!complete ? { persistenceErrorCode: "persistence-incomplete" } : {}),
        });
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
        logMizuhoRecord({
          ...diagnostic,
          persistence: "failed",
          persistenceErrorCode: "persistence-failed",
        });
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
      if (request.method === "GET" && url.pathname === "/health")
        return Response.json({
          ok: true,
          source: "mizuho-bank",
          schemaVersion: env.COLLECTOR_SCHEMA_VERSION,
        });
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    async alarmCollection(env: Env): Promise<ScheduledResult> {
      const result = await execute(env);
      return scheduledResult(result.body);
    },
    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
      // A failed daily invocation must not submit the password again through
      // a platform retry; the next configured daily event is independent.
      controller.noRetry();
      const result = await execute(env);
      // execute logs safe phases and one result for every entrypoint,
      // including the service-binding alarm path used by production.
      if (result.httpStatus === 502) throw new Error("mizuho-scheduled-collection-failed");
    },
  } satisfies ExportedHandler<Env> & { alarmCollection(env: Env): Promise<ScheduledResult> };
}

export default createHandler();

/** Private service-binding collection; public HTTP cannot invoke collection. */
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

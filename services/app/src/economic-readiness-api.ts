// Browser read parity for the existing S0 service (ADR 0067). No financial mutation.
import { ERROR_STATUS } from "../../../packages/application/src/index";
import { readEconomicRowReadinessForGrant } from "../../../packages/application/src/query/economic-row-readiness-read.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import { readerGrant } from "./agent-api";
import { auditContext, auditedRoute } from "./audit";
import { HttpError, json } from "./http";

export const ECONOMIC_READINESS_PATH = "/api/v2/economic-readiness";

/** Invalid parameters remain invalid input to the common, authority-first service. */
export function economicReadinessRequest(params: URLSearchParams): unknown {
  const keys = ["family", "observationId", "parseRunId"];
  if (
    [...params].some(([key]) => !keys.includes(key)) ||
    keys.some((key) => params.getAll(key).length !== 1)
  )
    return null;
  const id = (key: string): number | null => {
    const value = params.get(key)!;
    return /^[1-9][0-9]{0,15}$/u.test(value) && Number.isSafeInteger(Number(value))
      ? Number(value)
      : null;
  };
  return {
    schema: "economic-row-readiness-v1",
    family: params.get("family"),
    knowledge: "current",
    rows: [{ observationId: id("observationId"), parseRunId: id("parseRunId") }],
  };
}

export async function economicReadinessApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== ECONOMIC_READINESS_PATH) return null;
  return auditedRoute(
    auditContext(request, env, "ui", subject),
    "economic-readiness.read",
    async () => {
      if (request.method !== "GET" && request.method !== "HEAD")
        throw new HttpError(405, "method_not_allowed");
      const outcome = await readEconomicRowReadinessForGrant({
        grant: readerGrant(subject),
        sql: d1Executor(env.DB),
        request: economicReadinessRequest(url.searchParams),
      });
      if (outcome.status === "refused")
        return {
          response: json(outcome.error, ERROR_STATUS[outcome.error.code]),
          outcome: { result: "refused", code: outcome.error.code },
        };
      if (outcome.status === "unavailable")
        return {
          response: json(outcome, 503),
          outcome: { result: "failed", code: outcome.reason },
        };
      return {
        response: json(outcome),
        outcome: { result: "read", rows: outcome.manifest.rows.length, truncated: false },
      };
    },
  );
}

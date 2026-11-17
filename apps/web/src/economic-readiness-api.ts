import { useQuery } from "@tanstack/react-query";
import { ApiError, getJson } from "./api.ts";
import type { EconomicRowReadinessRequest } from "../../../packages/domain/src/economic-row-readiness.ts";
import {
  ECONOMIC_READINESS_PATH,
  economicReadinessMatches,
  type EconomicReadinessResult,
} from "../../../packages/observation-shared/src/economic-readiness-contract.ts";

export function useEconomicReadiness(request: EconomicRowReadinessRequest, enabled: boolean) {
  const row = request.rows[0]!;
  return useQuery({
    queryKey: ["economic-readiness", request.family, row.observationId, row.parseRunId],
    enabled,
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await getJson<EconomicReadinessResult>(
        `${ECONOMIC_READINESS_PATH}?${new URLSearchParams({
          family: request.family,
          observationId: String(row.observationId),
          parseRunId: String(row.parseRunId),
        })}`,
        signal,
      );
      if (!economicReadinessMatches(result, request))
        throw new ApiError(200, "別の記録の応答を受信しました。この記録の判定は表示できません。");
      return result;
    },
  });
}

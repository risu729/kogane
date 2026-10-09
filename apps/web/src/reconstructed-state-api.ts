import { useQuery } from "@tanstack/react-query";
import { getJson, useFeatures } from "./api.ts";
import type { ReconstructedStateResult } from "../../../packages/application/src/query/reconstructed-state.ts";

export type { ReconstructedStateResult } from "../../../packages/application/src/query/reconstructed-state.ts";
export type {
  ReconstructedCell,
  ReconstructionStart,
  LegDispositionRecord,
} from "../../../packages/domain/src/reconstruction.ts";

const RECONSTRUCTED_STATE_PATH = "/api/v2/reconstructed-state";

/** What the page asks: the route's own parameters, nothing computed here. */
export interface ReconstructedStateQuery {
  account: string;
  from: string;
  to: string;
  cut:
    | { kind: "latest" }
    | { kind: "sequence"; coreEpoch: string; commitSeq: string }
    | { kind: "instant"; coreEpoch: string; instant: string };
}

/** The route's query string for a request. */
export function reconstructedStateSearch(query: ReconstructedStateQuery): URLSearchParams {
  const params = new URLSearchParams({ account: query.account, from: query.from, to: query.to });
  if (query.cut.kind === "sequence") {
    params.set("coreEpoch", query.cut.coreEpoch);
    params.set("commitSeq", query.cut.commitSeq);
  } else if (query.cut.kind === "instant") {
    params.set("coreEpoch", query.cut.coreEpoch);
    params.set("instant", query.cut.instant);
  }
  return params;
}

/** The reconstructed state for a request, once the server advertises it. */
export function useReconstructedState(query: ReconstructedStateQuery | null) {
  const features = useFeatures();
  const search = query === null ? null : reconstructedStateSearch(query).toString();
  return useQuery({
    queryKey: ["reconstructed-state", search],
    enabled: features.known && features.reconstructedStateOnDate && search !== null,
    queryFn: ({ signal }) =>
      getJson<ReconstructedStateResult & { apiVersion: 2 }>(
        `${RECONSTRUCTED_STATE_PATH}?${search}`,
        signal,
      ),
    retry: false,
  });
}

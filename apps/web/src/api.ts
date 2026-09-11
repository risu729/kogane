// Shared HTTP contracts keep the UI independent of the local store implementation.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import {
  listRequestSearch,
  type ListPath,
  type MeasureView,
} from "../../../packages/observation-shared/src/api-schema.ts";
import { useLocation } from "./router.tsx";
import {
  capabilityState,
  clientFeatures,
  NO_FEATURES,
  type CapabilityState,
  type ClientFeatures,
} from "./capabilities.ts";
import type {
  CoverageSummaryData,
  ObservationKind,
  Overview,
  SharedQueryResponse,
  TransactionRow,
  BalanceRow,
  BalanceHistoryRow,
  BalanceHistoryPage,
  LatestBalancePage,
  PositionWithValuations,
  ArtifactRow,
  ArtifactDetail,
  ObservationDetail,
  ApiMetadata,
} from "../../../packages/observation-shared/src/api-contract.ts";
export type {
  BalanceAdoption,
  BalanceAdoptionState,
  BalanceEvidenceMember,
  BalanceHistoryItem,
  BalanceHistoryPage,
  CoverageSummaryData,
  KnownAssetsSubtotals,
  LatestBalanceItem,
  LatestBalancePage,
  SharedQueryResponse,
  ObservationKind,
  Warnings,
  Overview,
  TransactionRow,
  BalanceRow,
  BalanceHistoryRow,
  PositionRow,
  ValuationRow,
  PositionWithValuations,
  ArtifactRow,
  ObservationRef,
  ParseRunDetail,
  ArtifactDetail,
  Provenance,
  ObservationDetail,
  ApiMetadata,
} from "../../../packages/observation-shared/src/api-contract.ts";

// ── transport ────────────────────────────────────────────────────────

/** The path to an artifact's bytes. Linked to, never fetched and rendered. */
export function rawUrl(sha256: string): string {
  return `/api/raw/${sha256}`;
}

/** UI-safe errors contain fixed messages, never a response body or status text. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
  const controller = new AbortController();
  let cancel!: () => void;
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => {
      reject(new DOMException("Request aborted", "AbortError"));
      controller.abort();
    };
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      reject(
        new ApiError(408, "応答に時間がかかっています。接続状態を確認して、再試行してください。"),
      );
      controller.abort();
    }, 30_000);
  });
  try {
    // The deadline covers both headers and body, even if a transport stalls
    // without honoring cancellation. Unmount cancellation remains AbortError.
    return await Promise.race([readJson<T>(path, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

async function readJson<T>(path: string, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      signal,
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
    throw new ApiError(
      0,
      "接続できませんでした。接続先の起動状態やネットワークを確認して、再試行してください。",
    );
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new ApiError(
      401,
      "認証または接続先の確認が必要です。ログイン状態を確認して、再読み込みしてください。",
    );
  }
  if (!response.ok) {
    const message =
      response.status === 401
        ? "認証が必要です。接続先でログインし直してから、再読み込みしてください。"
        : response.status === 403
          ? "このデータを表示する権限がありません。接続先のアクセス権を確認してください。"
          : response.status === 413
            ? "保存記録が表示上限を超えています。この画面では一部の数字を完全な結果として表示できません。取得履歴から原本を確認してください。"
            : response.status === 404
              ? "指定されたデータが見つかりません。一覧を更新して確認してください。"
              : response.status === 429
                ? "リクエストが集中しています。少し待ってから再試行してください。"
                : "データを取得できませんでした。時間をおいて再試行してください。";
    throw new ApiError(response.status, message);
  }
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new ApiError(
      response.status,
      "データではなく別の応答が返されました。接続先やログイン状態を確認してください。",
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
    throw new ApiError(
      response.status,
      "受信したデータを読み取れませんでした。再読み込みしてください。",
    );
  }
  if (!validApiResponse(path.split("?", 1)[0]!, value)) {
    throw new ApiError(
      response.status,
      "受信したデータの形式が対応していません。接続先を確認してください。",
    );
  }
  return value as T;
}

// ── hooks ────────────────────────────────────────────────────────────
//
// Every view is a fresh read. Nothing is written to localStorage, nothing is
// persisted across a reload, and no figure on a page outlives the response it
// came from.

export function useMetadata(): UseQueryResult<ApiMetadata, Error> {
  return useQuery({
    queryKey: ["metadata"],
    queryFn: ({ signal }) => getJson<ApiMetadata>("/api/meta", signal),
  });
}

/** Loading and known capabilities are distinct; nothing guesses while loading. */
export function useCapabilities(): CapabilityState {
  return capabilityState(useMetadata().data);
}

export function useFeatures(): ClientFeatures & { known: boolean } {
  const state = useCapabilities();
  return state.known
    ? { ...clientFeatures(state.capabilities), known: true }
    : { ...NO_FEATURES, known: false };
}

export function useOverview(): UseQueryResult<Overview, Error> {
  return useQuery({
    queryKey: ["overview"],
    queryFn: ({ signal }) => getJson<Overview>("/api/overview", signal),
  });
}

/**
 * The coverage summary, from the same service an agent calls. Disabled until
 * capabilities are known and on stores that do not serve the shared route, so
 * a page never guesses which path produced its figures.
 */
export function useCoverageSummary(): UseQueryResult<
  SharedQueryResponse<CoverageSummaryData>,
  Error
> {
  const features = useFeatures();
  return useQuery({
    queryKey: ["shared-query", "coverage"],
    enabled: features.known && features.sharedQuery,
    queryFn: ({ signal }) =>
      getJson<SharedQueryResponse<CoverageSummaryData>>("/api/v2/query?intent=coverage", signal),
  });
}

export function useTransactions(): UseQueryResult<{ transactions: TransactionRow[] }, Error> {
  const request = useListRequest("/api/transactions");
  return useQuery({
    queryKey: ["transactions", request.suffix],
    enabled: request.enabled,
    queryFn: ({ signal }) =>
      getJson<{ transactions: TransactionRow[] }>(`/api/transactions${request.suffix}`, signal),
  });
}

export function useBalances(
  view?: MeasureView,
): UseQueryResult<{ latest: BalanceRow[]; history: BalanceHistoryRow[] }, Error> {
  // The view parameter is sent only when the server advertises that view;
  // the schema builder drops it otherwise, and the page filters client-side.
  const request = useListRequest("/api/balances", view ? { view } : {});
  return useQuery({
    queryKey: ["balances", request.suffix],
    enabled: request.enabled,
    queryFn: ({ signal }) =>
      getJson<{ latest: BalanceRow[]; history: BalanceHistoryRow[] }>(
        `/api/balances${request.suffix}`,
        signal,
      ),
  });
}

/**
 * The v2 latest-balance page: one fixed snapshot, keyset paged. `cursor` is
 * opaque and comes from the previous page; passing null starts again at the
 * newest snapshot, which is what the "refresh" action does. Disabled unless
 * the server advertises the capability, so nothing here guesses.
 */
export function useLatestBalances(
  view?: MeasureView,
  cursor?: string | null,
): UseQueryResult<LatestBalancePage, Error> {
  const features = useFeatures();
  const request = useListRequest("/api/v2/balances/latest", {
    ...(view ? { view } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const enabled = request.enabled && features.balanceReadModel;
  return useQuery({
    queryKey: ["balances-latest", request.suffix],
    enabled,
    queryFn: ({ signal }) =>
      getJson<LatestBalancePage>(`/api/v2/balances/latest${request.suffix}`, signal),
  });
}

/** The v2 balance history page: the same fixed context, its own budget. */
export function useBalanceHistory(
  view?: MeasureView,
  cursor?: string | null,
): UseQueryResult<BalanceHistoryPage, Error> {
  const features = useFeatures();
  const request = useListRequest("/api/v2/balances/history", {
    ...(view ? { view } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const enabled = request.enabled && features.balanceReadModel;
  return useQuery({
    queryKey: ["balances-history", request.suffix],
    enabled,
    queryFn: ({ signal }) =>
      getJson<BalanceHistoryPage>(`/api/v2/balances/history${request.suffix}`, signal),
  });
}

export function usePositions(): UseQueryResult<{ positions: PositionWithValuations[] }, Error> {
  const request = useListRequest("/api/positions");
  return useQuery({
    queryKey: ["positions", request.suffix],
    enabled: request.enabled,
    queryFn: ({ signal }) =>
      getJson<{ positions: PositionWithValuations[] }>(`/api/positions${request.suffix}`, signal),
  });
}

export function useArtifacts(): UseQueryResult<{ artifacts: ArtifactRow[] }, Error> {
  const request = useListRequest("/api/artifacts");
  const path = `/api/artifacts${request.suffix}`;
  return useQuery({
    queryKey: ["artifacts", request.suffix],
    enabled: request.enabled,
    queryFn: ({ signal }) => getJson<{ artifacts: ArtifactRow[] }>(path, signal),
  });
}

/**
 * Builds a list request from the page URL and explicit arguments using the
 * shared schema: only parameters the advertised capabilities allow are sent.
 * Disabled until capabilities are known, so no request carries a guess.
 */
export function useListRequest(
  path: ListPath,
  extra: Record<string, string> = {},
): { enabled: boolean; suffix: string } {
  const location = useLocation();
  const state = useCapabilities();
  if (!state.known) return { enabled: false, suffix: "" };
  const params = new URLSearchParams(location.split("?")[1]);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return { enabled: true, suffix: listRequestSearch(path, state.capabilities, params) };
}

export function useArtifact(id: number): UseQueryResult<ArtifactDetail, Error> {
  return useQuery({
    queryKey: ["artifact", id],
    queryFn: ({ signal }) => getJson<ArtifactDetail>(`/api/artifacts/${String(id)}`, signal),
  });
}

export function useObservation(
  kind: ObservationKind,
  id: number,
): UseQueryResult<ObservationDetail, Error> {
  return useQuery({
    queryKey: ["observation", kind, id],
    queryFn: ({ signal }) =>
      getJson<ObservationDetail>(`/api/observations/${kind}/${String(id)}`, signal),
  });
}

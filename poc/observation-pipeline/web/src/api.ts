// Shared HTTP contracts keep the UI independent of the local store implementation.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { validApiResponse } from "../../shared/api-validation.ts";
import type {
  ObservationKind,
  Overview,
  TransactionRow,
  BalanceRow,
  BalanceHistoryRow,
  PositionWithValuations,
  ArtifactRow,
  ArtifactDetail,
  ObservationDetail,
  ApiMetadata,
} from "../../shared/api-contract.ts";
export type {
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
} from "../../shared/api-contract.ts";

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

export async function getJson<T>(
  path: string,
  signal: AbortSignal,
): Promise<T> {
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
  if (
    response.type === "opaqueredirect" ||
    (response.status >= 300 && response.status < 400)
  ) {
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
          : response.status === 404
            ? "指定されたデータが見つかりません。一覧を更新して確認してください。"
            : response.status === 429
              ? "リクエストが集中しています。少し待ってから再試行してください。"
              : "データを取得できませんでした。時間をおいて再試行してください。";
    throw new ApiError(response.status, message);
  }
  if (
    response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
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
  if (!validApiResponse(path, value)) {
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

export function useOverview(): UseQueryResult<Overview, Error> {
  return useQuery({
    queryKey: ["overview"],
    queryFn: ({ signal }) => getJson<Overview>("/api/overview", signal),
  });
}

export function useTransactions(): UseQueryResult<
  { transactions: TransactionRow[] },
  Error
> {
  return useQuery({
    queryKey: ["transactions"],
    queryFn: ({ signal }) =>
      getJson<{ transactions: TransactionRow[] }>("/api/transactions", signal),
  });
}

export function useBalances(): UseQueryResult<
  { latest: BalanceRow[]; history: BalanceHistoryRow[] },
  Error
> {
  return useQuery({
    queryKey: ["balances"],
    queryFn: ({ signal }) =>
      getJson<{ latest: BalanceRow[]; history: BalanceHistoryRow[] }>(
        "/api/balances",
        signal,
      ),
  });
}

export function usePositions(): UseQueryResult<
  { positions: PositionWithValuations[] },
  Error
> {
  return useQuery({
    queryKey: ["positions"],
    queryFn: ({ signal }) =>
      getJson<{ positions: PositionWithValuations[] }>(
        "/api/positions",
        signal,
      ),
  });
}

export function useArtifacts(): UseQueryResult<
  { artifacts: ArtifactRow[] },
  Error
> {
  return useQuery({
    queryKey: ["artifacts"],
    queryFn: ({ signal }) =>
      getJson<{ artifacts: ArtifactRow[] }>("/api/artifacts", signal),
  });
}

export function useArtifact(id: number): UseQueryResult<ArtifactDetail, Error> {
  return useQuery({
    queryKey: ["artifact", id],
    queryFn: ({ signal }) =>
      getJson<ArtifactDetail>(`/api/artifacts/${String(id)}`, signal),
  });
}

export function useObservation(
  kind: ObservationKind,
  id: number,
): UseQueryResult<ObservationDetail, Error> {
  return useQuery({
    queryKey: ["observation", kind, id],
    queryFn: ({ signal }) =>
      getJson<ObservationDetail>(
        `/api/observations/${kind}/${String(id)}`,
        signal,
      ),
  });
}

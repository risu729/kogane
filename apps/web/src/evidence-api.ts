import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { ApiError } from "./api.ts";
import {
  evidenceRequest,
  isEvidenceArtifactId,
  isEvidenceCursor,
  isEvidenceRunId,
  isEvidenceSourceId,
  validEvidenceResponse,
} from "../../shared/evidence-validation.ts";
import type {
  EvidenceArtifactDetail,
  EvidenceArtifactList,
  EvidenceMeta,
  EvidenceRunList,
} from "../../shared/evidence-contract.ts";
export type * from "../../shared/evidence-contract.ts";

const BASE = "/api/evidence/v1";
const invalidRequest = (): ApiError =>
  new ApiError(400, "指定された記録やページの識別子が正しくありません。");
function pagePath(path: string, cursor?: string | null): string {
  if (cursor == null) return path;
  if (!isEvidenceCursor(cursor)) throw invalidRequest();
  return `${path}?cursor=${encodeURIComponent(cursor)}`;
}
export function evidenceRawUrl(runId: string, artifactId: string): string {
  if (!isEvidenceRunId(runId) || !isEvidenceArtifactId(artifactId)) throw invalidRequest();
  return `${BASE}/runs/${runId}/artifacts/${artifactId}/raw`;
}

/** Financial JSON stays in the query cache only. Errors never retain response bodies or causes. */
export async function getEvidenceJson<T>(path: string, signal: AbortSignal): Promise<T> {
  if (!evidenceRequest(path)) throw invalidRequest();
  signal.throwIfAborted();
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
      "原本ストアに接続できませんでした。接続先の起動状態やネットワークを確認してください。",
    );
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400))
    throw new ApiError(
      401,
      "認証が必要です。接続先でログインし直してから、再読み込みしてください。",
    );
  if (!response.ok) {
    const message =
      response.status === 401
        ? "認証が必要です。接続先でログインし直してから、再読み込みしてください。"
        : response.status === 403
          ? "この原本を表示する権限がありません。接続先のアクセス権を確認してください。"
          : response.status === 404
            ? "指定された記録が見つかりません。履歴を更新して確認してください。"
            : response.status === 429
              ? "リクエストが集中しています。少し待ってから再試行してください。"
              : "原本ストアからデータを取得できませんでした。時間をおいて再試行してください。";
    throw new ApiError(response.status, message);
  }
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw new ApiError(
      response.status,
      "記録ではなく別の応答が返されました。接続先やログイン状態を確認してください。",
    );
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
    throw new ApiError(
      response.status,
      "受信した記録を読み取れませんでした。再読み込みしてください。",
    );
  }
  signal.throwIfAborted();
  if (!validEvidenceResponse(path, value))
    throw new ApiError(
      response.status,
      "受信した記録の形式または識別子が一致しません。接続先を確認してください。",
    );
  return value as T;
}

export function useEvidenceMeta(): UseQueryResult<EvidenceMeta, Error> {
  return useQuery({
    queryKey: ["evidence-v1", "meta"],
    queryFn: ({ signal }) => getEvidenceJson<EvidenceMeta>(`${BASE}/meta`, signal),
  });
}
export function useEvidenceRuns(
  sourceId: string,
  cursor?: string | null,
): UseQueryResult<EvidenceRunList, Error> {
  return useQuery({
    queryKey: ["evidence-v1", "runs", sourceId, cursor ?? null],
    queryFn: ({ signal }) => {
      if (!isEvidenceSourceId(sourceId)) throw invalidRequest();
      return getEvidenceJson<EvidenceRunList>(
        pagePath(`${BASE}/sources/${sourceId}/runs`, cursor),
        signal,
      );
    },
  });
}
export function useEvidenceArtifacts(
  runId: string,
  cursor?: string | null,
): UseQueryResult<EvidenceArtifactList, Error> {
  return useQuery({
    queryKey: ["evidence-v1", "artifacts", runId, cursor ?? null],
    queryFn: ({ signal }) => {
      if (!isEvidenceRunId(runId)) throw invalidRequest();
      return getEvidenceJson<EvidenceArtifactList>(
        pagePath(`${BASE}/runs/${runId}/artifacts`, cursor),
        signal,
      );
    },
  });
}
export function useEvidenceArtifact(
  runId: string,
  artifactId: string,
): UseQueryResult<EvidenceArtifactDetail, Error> {
  return useQuery({
    queryKey: ["evidence-v1", "artifact", runId, artifactId],
    queryFn: ({ signal }) => {
      if (!isEvidenceRunId(runId) || !isEvidenceArtifactId(artifactId)) throw invalidRequest();
      return getEvidenceJson<EvidenceArtifactDetail>(
        `${BASE}/runs/${runId}/artifacts/${artifactId}`,
        signal,
      );
    },
  });
}

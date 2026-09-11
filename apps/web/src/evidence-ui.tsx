import { useState, type ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { EvidenceOutcome, EvidenceTimeBasis } from "../../../packages/observation-shared/src/evidence-contract.ts";
import { Badge, Nullable, QueryBoundary } from "./ui.tsx";

/** An expired authorization must not leave cached evidence on screen. */
export function EvidenceBoundary<T>({
  query,
  label,
  children,
}: {
  query: UseQueryResult<T, Error>;
  label: string;
  children: (data: T) => ReactNode;
}): ReactNode {
  return (
    <QueryBoundary query={query} label={label}>
      {children}
    </QueryBoundary>
  );
}

const OUTCOMES: Record<EvidenceOutcome, string> = {
  success: "収集成功",
  partial: "一部取得",
  failed: "収集失敗",
  human_required: "操作が必要",
  cancelled: "収集中止",
  unknown: "収集結果不明",
};
export function Outcome({ value }: { value: EvidenceOutcome }): ReactNode {
  return (
    <Badge
      tone={
        value === "success"
          ? "ok"
          : value === "failed"
            ? "bad"
            : value === "partial" || value === "human_required"
              ? "warn"
              : "neutral"
      }
    >
      {OUTCOMES[value]}
    </Badge>
  );
}

const BASES: Record<EvidenceTimeBasis, string> = {
  source: "取得元データ",
  manifest: "収集記録",
  schedule: "予定日時",
  file_metadata: "ファイル情報",
  email: "メール情報",
  operator: "手動記録",
  unknown: "根拠不明",
};
export function RecordedTime({
  value,
  basis,
}: {
  value: string | null;
  basis: EvidenceTimeBasis | null;
}): ReactNode {
  return (
    <>
      <Nullable value={value} />
      <div className="dim">日時の根拠：{basis === null ? "未記録" : BASES[basis]}</div>
    </>
  );
}

export function useCursorPage() {
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  return {
    cursor: cursors[cursors.length - 1] ?? null,
    page: cursors.length,
    previous: () => setCursors((values) => (values.length > 1 ? values.slice(0, -1) : values)),
    next: (cursor: string) => setCursors((values) => [...values, cursor]),
  };
}
export function EvidencePager({
  paging,
  nextCursor,
  count,
  fetching,
}: {
  paging: ReturnType<typeof useCursorPage>;
  nextCursor: string | null;
  count: number;
  fetching: boolean;
}): ReactNode {
  return (
    <div className="pagination" aria-label="記録のページ">
      <span role="status">
        {paging.page}ページ目 · このページ{count}件
      </span>
      <button className="button" disabled={fetching || paging.page === 1} onClick={paging.previous}>
        前のページ
      </button>
      <button
        className="button"
        disabled={fetching || nextCursor === null}
        onClick={() => {
          if (nextCursor !== null) paging.next(nextCursor);
        }}
      >
        次のページ
      </button>
    </div>
  );
}

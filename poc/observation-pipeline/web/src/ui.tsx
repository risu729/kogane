// Shared display primitives.
//
// Two rules are enforced here rather than in each page:
//
//   * An amount is only ever rendered by <Amount>, which delegates to
//     formatAmount/amountSign from src/money.ts. No component multiplies,
//     divides, sums or parses an amount, and Intl.NumberFormat appears
//     nowhere in this client — it takes a Number, so every figure would
//     round-trip through a double on its way to the screen.
//   * Timestamps are printed exactly as stored. `as_of` and `observed_at`
//     mean different things and reformatting either would be a claim the
//     store does not make.
//
// React escapes every string it renders, and dangerouslySetInnerHTML is used
// nowhere in this client, which is what makes provider-authored text —
// descriptions, counterparty names, security names, extra_json — safe to put
// on the page.

import type { Warnings } from "./api.ts";
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { amountSign, formatAmount } from "./money.ts";
import { Link, type ObservationKind } from "./router.tsx";
import { ApiError, rawUrl } from "./api.ts";
import { displayLabel } from "./labels.ts";

// ── values ───────────────────────────────────────────────────────────

/**
 * An amount, as integer minor units plus the provider's verbatim text. Colour
 * carries the sign and nothing else; the sign itself comes from amountSign,
 * which compares BigInts and never does arithmetic.
 */
export function Amount({
  minor,
  unit,
  text,
}: {
  // A decimal string: the API sends amounts as text so that an integer past
  // 2^53 is not rounded by JSON on its way here.
  minor: string | null;
  unit: string | null;
  text: string | null;
}): ReactNode {
  const formatted = formatAmount(minor, unit, text);
  if (formatted === "") return <span className="null">金額未記録</span>;
  return <span className={`amount amount-${amountSign(minor)}`}>{formatted}</span>;
}

/** A nullable column. An absent value is shown as absent, never as blank. */
export function Nullable({
  value,
  placeholder = "未記録",
}: {
  value: string | number | null | undefined;
  placeholder?: string;
}): ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="null">{placeholder}</span>;
  }
  return <>{String(value)}</>;
}

/** An arbitrary stored cell, for pages that render whatever columns exist. */
export function CellValue({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined) return <span className="null">未記録</span>;
  if (typeof value === "string") {
    return value === "" ? <span className="null">空文字</span> : <>{value}</>;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return <>{String(value)}</>;
  }
  return <>{JSON.stringify(value)}</>;
}

export function Sha({ value, full = false }: { value: string; full?: boolean }): ReactNode {
  return (
    <span className="hash" title={value}>
      {full ? value : `${value.slice(0, 12)}…`}
    </span>
  );
}

// ── badges ───────────────────────────────────────────────────────────

export type Tone = "neutral" | "ok" | "warn" | "bad" | "superseded";

export function Badge({
  tone = "neutral",
  children,
  title,
  className = "",
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  className?: string;
}): ReactNode {
  const toneClass = tone === "neutral" ? "" : ` badge-${tone}`;
  const extra = className === "" ? "" : ` ${className}`;
  return (
    <span className={`badge${toneClass}${extra}`} title={title}>
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }): ReactNode {
  const labels: Record<string, string> = {
    ok: "成功",
    success: "成功",
    partial: "一部取得",
    failed: "失敗",
    error: "エラー",
    pending: "待機中",
    running: "実行中",
  };
  const tone: Tone =
    status === "ok" || status === "success"
      ? "ok"
      : status === "failed" || status === "error"
        ? "bad"
        : status === "partial"
          ? "warn"
          : "neutral";
  return (
    <Badge tone={tone} title={status}>
      {displayLabel(labels, status)}
    </Badge>
  );
}

const KIND_LABELS: Record<ObservationKind, string> = {
  transaction: "取引",
  balance: "残高",
  position: "保有資産",
  valuation: "評価額",
};

export function KindBadge({ kind }: { kind: ObservationKind }): ReactNode {
  return (
    <Badge className="badge-kind" title={`${KIND_LABELS[kind]}の観測記録`}>
      {KIND_LABELS[kind]}
    </Badge>
  );
}

/**
 * Supersession is the one lineage fact that must never be inferred from
 * absence, so it gets its own explicit marker in both directions.
 */
export function LineageBadge({ supersededBy }: { supersededBy: number | null }): ReactNode {
  if (supersededBy === null) return <Badge tone="neutral">現行の解析</Badge>;
  return (
    <Badge tone="superseded" title="同じ原本を再解析した記録に置き換えられています。">
      旧解析 · 解析 #{supersededBy} に置換済み
    </Badge>
  );
}

export function WarningBadge({ count }: { count: number }): ReactNode {
  if (count === 0) return <span className="dim">0</span>;
  return <Badge tone="warn">注意 {count} 件</Badge>;
}

export function WarningList({ warnings }: { warnings: Warnings }): ReactNode {
  // A warnings value the store could not parse is shown as such. Warnings are
  // the parser's record of what it could not read, so rendering "none" for an
  // unreadable one would hide the very thing worth seeing.
  if (!warnings.parsed) {
    return (
      <p className="warn-unreadable">
        注意事項を読み取れません。保存された内容：<code>{warnings.raw}</code>
      </p>
    );
  }
  const list = warnings.list;
  if (list.length === 0) return null;
  return (
    <ul className="warning-list">
      {list.map((warning, index) => (
        <li key={`${String(index)}:${warning}`}>{warning}</li>
      ))}
    </ul>
  );
}

// ── links ────────────────────────────────────────────────────────────

export function ObservationLink({
  kind,
  id,
  children,
}: {
  kind: ObservationKind;
  id: number;
  children?: ReactNode;
}): ReactNode {
  return (
    <Link
      to={`/observations/${kind}/${String(id)}`}
      title={`${KIND_LABELS[kind]}の観測記録 ${String(id)}`}
    >
      {children ?? `#${String(id)}`}
    </Link>
  );
}

export function ArtifactLink({ id }: { id: number }): ReactNode {
  return <Link to={`/artifacts/${String(id)}`}>原本 #{id}</Link>;
}

/**
 * A link to the stored bytes, never a fetch of them. The API serves that route
 * with `Content-Security-Policy: sandbox`, which only holds if the browser is
 * the thing that navigates to it.
 */
export function RawLink({ sha256, children }: { sha256: string; children?: ReactNode }): ReactNode {
  return (
    <a href={rawUrl(sha256)} target="_blank" rel="noreferrer noopener">
      {children ?? "原本を開く ↗"}
    </a>
  );
}

// ── key/value grid ───────────────────────────────────────────────────

export function Kv({ children }: { children: ReactNode }): ReactNode {
  return <dl className="kv">{children}</dl>;
}

export function KvRow({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

// ── panels ───────────────────────────────────────────────────────────

export function Panel({
  title,
  count,
  note,
  children,
  id,
}: {
  title: ReactNode;
  count?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
  id?: string;
}): ReactNode {
  return (
    <section className="panel" aria-labelledby={id}>
      <div className="panel-head">
        <h2 id={id}>{title}</h2>
        {count === undefined ? null : <span className="count">{count}</span>}
      </div>
      {note === undefined ? null : <div className="panel-note">{note}</div>}
      {children}
    </section>
  );
}

// ── loading / error / empty ──────────────────────────────────────────

export function Loading({ label }: { label: string }): ReactNode {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="state-title">{label}を読み込んでいます…</span>
      <div className="skeleton-bar" style={{ width: "38%" }} />
      <div className="skeleton-bar" style={{ width: "72%" }} />
      <div className="skeleton-bar" style={{ width: "55%" }} />
    </div>
  );
}

export function ErrorState({
  error,
  label,
  onRetry,
  retrying = false,
}: {
  error: Error;
  label: string;
  onRetry?: () => void;
  retrying?: boolean;
}): ReactNode {
  const status =
    error instanceof ApiError && error.status >= 400 ? ` (HTTP ${String(error.status)})` : "";
  return (
    <div className="state state-error" role="alert">
      <span className="state-title">
        {label}を読み込めませんでした{status}
      </span>
      <p>
        {error instanceof ApiError
          ? error.message
          : "接続先の API が利用できるか確認し、もう一度お試しください。"}
      </p>
      {onRetry ? (
        <button className="button" onClick={onRetry} disabled={retrying}>
          {retrying ? "再試行中…" : "再試行"}
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="state state-empty">
      <span className="empty-symbol" aria-hidden="true">
        —
      </span>
      <div>{children}</div>
    </div>
  );
}

/**
 * Loading, error and empty for every route, in one place. `isEmpty` is what
 * lets a page say "no rows" rather than render an empty table with no
 * explanation.
 */
export function QueryBoundary<T>({
  query,
  label,
  isEmpty,
  empty,
  children,
}: {
  query: UseQueryResult<T, Error>;
  label: string;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}): ReactNode {
  const retry = (): void => {
    void query.refetch();
  };
  // Refetch errors must not hide already loaded evidence. A successful empty
  // response, by contrast, is an actual empty state and replaces old rows.
  if (query.data === undefined) {
    if (query.isError)
      return (
        <ErrorState error={query.error} label={label} onRetry={retry} retrying={query.isFetching} />
      );
    return <Loading label={label} />;
  }
  const data = query.data;
  return (
    <>
      {query.isError ? (
        <div className="query-notice query-warning" role="alert">
          <span>更新できませんでした。前回読み込んだ{label}を表示しています。</span>
          <button className="button" onClick={retry} disabled={query.isFetching}>
            {query.isFetching ? "再試行中…" : "再試行"}
          </button>
        </div>
      ) : null}
      {query.isFetching ? (
        <div className="query-notice" role="status">
          <span className="refresh-symbol is-refreshing" aria-hidden="true">
            ↻
          </span>
          {label}を更新中…
        </div>
      ) : null}
      {isEmpty !== undefined && isEmpty(data) ? (
        <EmptyState>{empty ?? `${label}はまだ保存されていません。`}</EmptyState>
      ) : (
        children(data)
      )}
    </>
  );
}

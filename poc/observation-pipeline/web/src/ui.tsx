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

import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { amountSign, formatAmount } from "./money.ts";
import { Link, type ObservationKind } from "./router.tsx";
import { ApiError, rawUrl } from "./api.ts";

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
  minor: number | null;
  unit: string | null;
  text: string | null;
}): ReactNode {
  const formatted = formatAmount(minor, unit, text);
  if (formatted === "") return <span className="null">no amount</span>;
  return <span className={`amount amount-${amountSign(minor)}`}>{formatted}</span>;
}

/** A nullable column. An absent value is shown as absent, never as blank. */
export function Nullable({
  value,
  placeholder = "null",
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
  if (value === null || value === undefined) return <span className="null">null</span>;
  if (typeof value === "string") {
    return value === "" ? <span className="null">empty string</span> : <>{value}</>;
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
  const tone: Tone = status === "ok" || status === "success" ? "ok" : "bad";
  return <Badge tone={tone}>{status}</Badge>;
}

export function KindBadge({ kind }: { kind: ObservationKind }): ReactNode {
  return (
    <Badge className="badge-kind" title={`${kind} observation`}>
      {kind}
    </Badge>
  );
}

/**
 * Supersession is the one lineage fact that must never be inferred from
 * absence, so it gets its own explicit marker in both directions.
 */
export function LineageBadge({ supersededBy }: { supersededBy: number | null }): ReactNode {
  if (supersededBy === null) return <Badge tone="neutral">current</Badge>;
  return (
    <Badge tone="superseded" title="This parse run was replaced by a later one over the same bytes.">
      superseded by #{supersededBy}
    </Badge>
  );
}

export function WarningBadge({ count }: { count: number }): ReactNode {
  if (count === 0) return <span className="dim">0</span>;
  return (
    <Badge tone="warn">
      {count} warning{count === 1 ? "" : "s"}
    </Badge>
  );
}

export function WarningList({ warnings }: { warnings: string[] }): ReactNode {
  if (warnings.length === 0) return null;
  return (
    <ul className="warning-list">
      {warnings.map((warning, index) => (
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
    <Link to={`/observations/${kind}/${String(id)}`} title={`${kind} observation ${String(id)}`}>
      {children ?? `#${String(id)}`}
    </Link>
  );
}

export function ArtifactLink({ id }: { id: number }): ReactNode {
  return <Link to={`/artifacts/${String(id)}`}>artifact #{id}</Link>;
}

/**
 * A link to the stored bytes, never a fetch of them. The API serves that route
 * with `Content-Security-Policy: sandbox`, which only holds if the browser is
 * the thing that navigates to it.
 */
export function RawLink({
  sha256,
  children,
}: {
  sha256: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <a href={rawUrl(sha256)} target="_blank" rel="noreferrer noopener">
      {children ?? "raw bytes ↗"}
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
      <span className="state-title">Loading {label}…</span>
      <div className="skeleton-bar" style={{ width: "38%" }} />
      <div className="skeleton-bar" style={{ width: "72%" }} />
      <div className="skeleton-bar" style={{ width: "55%" }} />
    </div>
  );
}

export function ErrorState({ error, label }: { error: Error; label: string }): ReactNode {
  const status = error instanceof ApiError ? ` (HTTP ${String(error.status)})` : "";
  return (
    <div className="state state-error" role="alert">
      <span className="state-title">Could not load {label}{status}</span>
      {error.message}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }): ReactNode {
  return <div className="state">{children}</div>;
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
  if (query.isPending) return <Loading label={label} />;
  if (query.isError) return <ErrorState error={query.error} label={label} />;
  const data = query.data;
  if (isEmpty !== undefined && isEmpty(data)) {
    return <EmptyState>{empty ?? `No ${label} in the store.`}</EmptyState>;
  }
  return <>{children(data)}</>;
}

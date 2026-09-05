import type { ReactNode } from "react";
import {
  accountOptions,
  sourceOptions,
  type SourceAccount,
  type RecordFilters,
} from "../filters.ts";

function savedAccountLabel(value: string): string {
  try {
    const parts: unknown = JSON.parse(value);
    if (
      Array.isArray(parts) &&
      parts.length === 2 &&
      typeof parts[0] === "string" &&
      typeof parts[1] === "string"
    ) {
      return `${parts[1] || "口座名未記録"} · ${parts[0]}`;
    }
  } catch {
    // A future state source must not make the selected control unreadable.
  }
  return "選択中の口座";
}

export function RecordControls({
  rows,
  filters,
  onChange,
  dates = false,
}: {
  rows: SourceAccount[];
  filters: RecordFilters;
  onChange: (value: RecordFilters) => void;
  dates?: boolean;
}): ReactNode {
  const sources = sourceOptions(rows);
  const accounts = accountOptions(rows, filters.source);
  const missingSource = filters.source !== "" && !sources.includes(filters.source);
  const missingAccount =
    filters.account !== "" && !accounts.some((account) => account.value === filters.account);
  return (
    <div className="filter-grid">
      <label className="filter-field">
        取得元
        <select
          aria-label="取得元"
          value={filters.source}
          onChange={(event) => onChange({ ...filters, source: event.target.value, account: "" })}
        >
          <option value="">すべての取得元</option>
          {missingSource ? (
            <option value={filters.source}>{filters.source}（今回の記録に含まれません）</option>
          ) : null}
          {sources.map((source) => (
            <option key={source}>{source}</option>
          ))}
        </select>
      </label>
      <label className="filter-field">
        口座
        <select
          aria-label="口座"
          value={filters.account}
          onChange={(event) => onChange({ ...filters, account: event.target.value })}
        >
          <option value="">すべての口座</option>
          {missingAccount ? (
            <option value={filters.account}>
              {savedAccountLabel(filters.account)}（今回の記録に含まれません）
            </option>
          ) : null}
          {accounts.map((account) => (
            <option key={account.value} value={account.value}>
              {account.label}
            </option>
          ))}
        </select>
      </label>
      {dates ? (
        <>
          <label className="filter-field">
            開始日
            <input
              type="date"
              aria-label="開始日"
              value={filters.from}
              onChange={(event) => onChange({ ...filters, from: event.target.value })}
            />
          </label>
          <label className="filter-field">
            終了日
            <input
              type="date"
              aria-label="終了日"
              value={filters.to}
              onChange={(event) => onChange({ ...filters, to: event.target.value })}
            />
          </label>
        </>
      ) : null}
    </div>
  );
}
export function Pager({
  page,
  pages,
  total,
  start,
  end,
  onChange,
}: {
  page: number;
  pages: number;
  total: number;
  start: number;
  end: number;
  onChange: (page: number) => void;
}): ReactNode {
  return (
    <div className="pagination" aria-label="表示ページ">
      <span role="status" aria-live="polite">
        {total}件中 {start}–{end}件
      </span>
      <button
        className="button"
        type="button"
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
      >
        前へ
      </button>
      <span>
        {page + 1} / {pages}
      </span>
      <button
        className="button"
        type="button"
        disabled={page + 1 >= pages}
        onClick={() => onChange(page + 1)}
      >
        次へ
      </button>
    </div>
  );
}
export const KIND_LABELS = {
  transaction: "取引",
  balance: "残高",
  position: "保有資産",
  valuation: "評価額",
};

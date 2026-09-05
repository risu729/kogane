import type { ReactNode } from "react";
import {
  accountOptions,
  sourceOptions,
  type SourceAccount,
  type RecordFilters,
} from "../filters.ts";
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
  return (
    <div className="filter-grid">
      <label className="filter-field">
        取得元
        <select
          aria-label="取得元"
          value={filters.source}
          onChange={(event) =>
            onChange({ ...filters, source: event.target.value, account: "" })
          }
        >
          <option value="">すべての取得元</option>
          {sourceOptions(rows).map((source) => (
            <option key={source}>{source}</option>
          ))}
        </select>
      </label>
      <label className="filter-field">
        口座
        <select
          aria-label="口座"
          value={filters.account}
          onChange={(event) =>
            onChange({ ...filters, account: event.target.value })
          }
        >
          <option value="">すべての口座</option>
          {accountOptions(rows, filters.source).map((account) => (
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
              onChange={(event) =>
                onChange({ ...filters, from: event.target.value })
              }
            />
          </label>
          <label className="filter-field">
            終了日
            <input
              type="date"
              aria-label="終了日"
              value={filters.to}
              onChange={(event) =>
                onChange({ ...filters, to: event.target.value })
              }
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

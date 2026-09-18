// The one pagination row. Offset pagers and cursor pagers differ only in what
// the status line says and in how the buttons decide to be disabled, so both
// render through this component; the markup, roles and classes stay identical.

import type { ReactNode } from "react";

type PageButton = {
  label: string;
  disabled: boolean;
  onClick: () => void;
};

export function Pagination({
  label,
  status,
  previous,
  next,
  position,
  actions,
}: {
  /** Accessible name of the row, e.g. 表示ページ. */
  label: string;
  /** Announced count text: "60件中 1–50件", "2ページ目 · このページ20件". */
  status: ReactNode;
  previous: PageButton;
  next: PageButton;
  /** Text between the two buttons, e.g. "1 / 3" for an offset pager. */
  position?: ReactNode;
  /** Further actions that belong to the row, such as a refresh button. */
  actions?: ReactNode;
}): ReactNode {
  return (
    <div className="pagination" aria-label={label}>
      <span role="status" aria-live="polite">
        {status}
      </span>
      <button
        className="button"
        type="button"
        disabled={previous.disabled}
        onClick={previous.onClick}
      >
        {previous.label}
      </button>
      {position === undefined ? null : <span>{position}</span>}
      <button className="button" type="button" disabled={next.disabled} onClick={next.onClick}>
        {next.label}
      </button>
      {actions}
    </div>
  );
}

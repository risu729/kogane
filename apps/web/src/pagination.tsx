// The one pagination row. Offset pagers and cursor pagers differ only in what
// the status line says and in how the buttons decide to be disabled, so both
// render through this component; the markup, roles and classes stay identical.

import type { ReactNode } from "react";
import { BusyButton } from "./busy-button.tsx";

type PageButton = {
  label: string;
  disabled: boolean;
  onClick: () => void;
  /**
   * A read is in flight: the button is announced as disabled and ignores
   * clicks, but stays focusable, so a keyboard user who pressed it (or sits on
   * it during a background read) keeps their place.
   */
  busy?: boolean;
};

/** One pager button; `busy` waits without taking focus away (`BusyButton`). */
function PagerButton({ label, disabled, onClick, busy = false }: PageButton): ReactNode {
  return (
    <BusyButton busy={busy} disabled={disabled} onClick={onClick}>
      {label}
    </BusyButton>
  );
}

export function Pagination({
  label,
  status,
  previous,
  next,
  position,
  actions,
  bare = false,
}: {
  /** Accessible name of the row, e.g. 表示ページ; also spoken before the count. */
  label: string;
  /** Announced count text: "60件中 1–50件", "2ページ目 · このページ20件". */
  status: ReactNode;
  previous: PageButton;
  next: PageButton;
  /** Text between the two buttons, e.g. "1 / 3" for an offset pager. */
  position?: ReactNode;
  /** Further actions that belong to the row, such as a refresh button. */
  actions?: ReactNode;
  /** In page flow after a list of cards or panels, without the panel inset and rule. */
  bare?: boolean;
}): ReactNode {
  return (
    <div
      className={bare ? "pagination pagination-bare" : "pagination"}
      role="group"
      aria-label={label}
    >
      {/* The label is spoken with the count, so two pagers on one page never
       * announce the same message. */}
      <span role="status" aria-live="polite">
        <span className="visually-hidden">{label}：</span>
        {status}
      </span>
      <PagerButton {...previous} />
      {position === undefined ? null : <span>{position}</span>}
      <PagerButton {...next} />
      {actions}
    </div>
  );
}

/**
 * The one cursor pager. A cursor list has no total, so its buttons say
 * 前のページ / 次のページ, its status says whether more follows unless the page
 * says more, and every button waits while a read is in flight: a click during
 * a read would page from an answer about to be replaced. Waiting is
 * aria-disabled rather than disabled, so the focused button keeps focus.
 */
export function CursorPager({
  label,
  status,
  fetching,
  canGoBack,
  hasMore,
  onPrevious,
  onNext,
  restart,
}: {
  /** Accessible name of the row; one per pager on a page. */
  label: string;
  /** The announced count; by default whether the list continues. */
  status?: ReactNode;
  /** A read of this list is in flight. */
  fetching: boolean;
  canGoBack: boolean;
  hasMore: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** Reads the list again from its newest first page. */
  restart?: { label: string; onClick: () => void };
}): ReactNode {
  return (
    <Pagination
      label={label}
      status={status ?? (hasMore ? "続きがあります" : "最後のページです")}
      previous={{ label: "前のページ", disabled: !canGoBack, busy: fetching, onClick: onPrevious }}
      next={{ label: "次のページ", disabled: !hasMore, busy: fetching, onClick: onNext }}
      actions={
        restart === undefined ? undefined : (
          <PagerButton {...restart} disabled={false} busy={fetching} />
        )
      }
    />
  );
}

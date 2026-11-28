// The one button that waits for its own request or read. While it is in
// flight it is announced as disabled (`aria-disabled`) and ignores activation,
// but it is not `disabled`: a focused element that becomes disabled loses
// focus to the document body, so a keyboard user who pressed it would be
// thrown back to the top of the page when the answer, a refusal included,
// arrives (docs/ui-guidelines.md). The review pages' plan buttons, the pager
// buttons (`pagination.tsx`) and the retry buttons of a failed read
// (`ErrorState` and `QueryBoundary`'s 前回読み込んだ warning in `ui.tsx`) render
// through it, as do the confirmation, operation and schedules pages' in-flight
// buttons and the 最近の変化 panel's 続きを読み込む (docs/ui-guidelines.md
// lists them). The shell's 表示を更新 follows the same rule with its own markup.
import type { ReactNode } from "react";

export function BusyButton({
  busy,
  disabled = false,
  onClick,
  "aria-label": ariaLabel,
  children,
}: {
  /** The button's request is in flight: activation is ignored, focus stays. */
  busy: boolean;
  /** The action is not available at all (missing input, capability, blocker, no page). */
  disabled?: boolean;
  onClick: () => void;
  /** A name that says more than the text shown, such as the read a retry repeats. */
  "aria-label"?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      className="button"
      type="button"
      disabled={disabled}
      aria-disabled={!disabled && busy ? true : undefined}
      aria-label={ariaLabel}
      onClick={() => {
        if (!busy) onClick();
      }}
    >
      {children}
    </button>
  );
}

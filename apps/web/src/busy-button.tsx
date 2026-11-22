// A button that sends a request. While its request is in flight it is
// announced as disabled (`aria-disabled`) and ignores activation, but it is
// not `disabled`: a focused element that becomes disabled loses focus to the
// document body, so a keyboard user who pressed it would be thrown back to the
// top of the page when the answer, a refusal included, arrives
// (docs/ui-guidelines.md). The same rule as the shell's 表示を更新.
import type { ReactNode } from "react";

export function BusyButton({
  busy,
  disabled,
  onClick,
  children,
}: {
  /** The button's request is in flight: activation is ignored, focus stays. */
  busy: boolean;
  /** The action is not available at all (missing input, capability, blocker). */
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      className="button"
      type="button"
      disabled={disabled}
      aria-disabled={!disabled && busy ? true : undefined}
      onClick={() => {
        if (!busy) onClick();
      }}
    >
      {children}
    </button>
  );
}

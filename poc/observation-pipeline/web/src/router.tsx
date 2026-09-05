// A client-side router in about forty lines, so the client carries no routing
// dependency. It holds one piece of state — the current pathname — and reads
// it from `window.location` rather than mirroring it, so `history.pushState`,
// the back button, and a full page load are all the same code path.
//
// The URLs mirror the API's: /transactions is backed by /api/transactions,
// /observations/:kind/:id by /api/observations/:kind/:id. The server falls
// back to index.html for unknown paths, so every route deep-links.

import {
  useCallback,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  window.addEventListener("popstate", onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener("popstate", onStoreChange);
  };
}

function readPath(): string {
  return window.location.pathname;
}

export function navigate(to: string): void {
  if (to === readPath()) return;
  window.history.pushState(null, "", to);
  window.scrollTo(0, 0);
  emit();
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, readPath, readPath);
}

/** A left click with no modifier is ours; everything else is the browser's. */
function isPlainLeftClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function Link({
  to,
  children,
  className,
  title,
  current = false,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  title?: string;
  /** Marks this link as the view currently on screen, for assistive tech. */
  current?: boolean;
}): ReactNode {
  const onClick = useCallback(
    (event: ReactMouseEvent<HTMLAnchorElement>) => {
      if (!isPlainLeftClick(event)) return;
      event.preventDefault();
      navigate(to);
    },
    [to],
  );
  // A real href, so middle-click, "open in new tab", and copy-link all work,
  // and so the link is keyboard-focusable without any extra attributes.
  return (
    <a
      href={to}
      onClick={onClick}
      className={className}
      title={title}
      aria-current={current ? "page" : undefined}
    >
      {children}
    </a>
  );
}

// ── route table ──────────────────────────────────────────────────────

export const OBSERVATION_KINDS = ["transaction", "balance", "position", "valuation"] as const;

export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export function isObservationKind(value: string): value is ObservationKind {
  return (OBSERVATION_KINDS as readonly string[]).includes(value);
}

export type Route =
  | { name: "overview" }
  | { name: "transactions" }
  | { name: "balances" }
  | { name: "positions" }
  | { name: "artifacts" }
  | { name: "artifact"; id: number }
  | { name: "observation"; kind: ObservationKind; id: number }
  | { name: "notFound"; path: string };

/** Only plain non-negative integers, matching the API's own id rule. */
function parseId(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function matchRoute(path: string): Route {
  const segments = path.split("/").filter((segment) => segment !== "");
  const [first, second, third] = segments;

  if (first === undefined) return { name: "overview" };

  if (segments.length === 1) {
    if (first === "transactions") return { name: "transactions" };
    if (first === "balances") return { name: "balances" };
    if (first === "positions") return { name: "positions" };
    if (first === "artifacts") return { name: "artifacts" };
  }

  if (first === "artifacts" && segments.length === 2) {
    const id = parseId(second);
    if (id !== undefined) return { name: "artifact", id };
  }

  if (first === "observations" && segments.length === 3) {
    const id = parseId(third);
    if (second !== undefined && isObservationKind(second) && id !== undefined) {
      return { name: "observation", kind: second, id };
    }
  }

  return { name: "notFound", path };
}

export function useRoute(): Route {
  return matchRoute(usePath());
}

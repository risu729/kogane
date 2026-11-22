// A review page reads again what it shows when a plan is refused because the
// reviewed item changed since the page read it (`planRefusedAsStale`), so the
// stale item does not stay on screen until a refocus or a remount
// (docs/frontend.md, "Plan refusals").
//
// The refusal stays visible: in the item's own alert (`PlanRefusal`) while the
// item read again still shows it, and otherwise (the item left the list, its
// form was mounted again for a new revision, or it sits in a closed
// disclosure) in the page's `PlanRefreshNotice`. Focus stays where it is, on
// the pressed button while it is still there (`BusyButton`); only when the
// page read again took the focused element away does focus move, to wherever
// the refusal is shown.
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  partialMatchKey,
  useIsFetching,
  useQueryClient,
  type Query,
  type QueryKey,
} from "@tanstack/react-query";
import { planRefusedAsStale } from "./command-api.ts";

interface PlanRefreshActions {
  /** A plan was sent: an earlier refusal no longer applies. */
  started: () => void;
  /** A plan was refused; a stale refusal reads the scope's queries again. */
  refused: (error: Error) => void;
  /** Where an item shows one refusal (`PlanRefusal`). */
  shown: (error: Error, element: HTMLElement) => void;
}

interface PlanRefreshContextValue {
  actions: PlanRefreshActions;
  /** A stale refusal the page read again no longer shows in its item. */
  orphan: Error | null;
  notice: RefObject<HTMLDivElement | null>;
}

const PlanRefreshContext = createContext<PlanRefreshContextValue | null>(null);

function visible(element: Element): boolean {
  return element.isConnected && element.checkVisibility();
}

function focusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !visible(active);
}

/**
 * A page whose plans this scope watches. `queryKeys` are the prefixes of
 * exactly the reads that show the reviewed items: a stale refusal invalidates
 * them (the ones on screen are fetched again) and nothing else.
 */
export function PlanRefreshScope({
  queryKeys,
  children,
}: {
  queryKeys: readonly QueryKey[];
  children: ReactNode;
}): ReactNode {
  const client = useQueryClient();
  const keys = useRef(queryKeys);
  keys.current = queryKeys;
  const matches = (query: Query) =>
    keys.current.some((prefix) => partialMatchKey(query.queryKey, prefix));
  const fetching = useIsFetching({ predicate: matches });
  const latest = useRef<Error | null>(null);
  const alerts = useRef(new WeakMap<Error, HTMLElement>());
  // The refusal whose reads have been answered, until it is looked at once
  // those answers are on screen.
  const [settled, setSettled] = useState<Error | null>(null);
  const [orphan, setOrphan] = useState<{ error: Error; focus: boolean } | null>(null);
  const notice = useRef<HTMLDivElement>(null);
  const [actions] = useState<PlanRefreshActions>(() => ({
    started: () => {
      latest.current = null;
      setSettled(null);
      setOrphan(null);
    },
    refused: (error) => {
      if (!planRefusedAsStale(error)) return;
      latest.current = error;
      setOrphan(null);
      void client
        .invalidateQueries({ predicate: matches })
        .then(() => setSettled((current) => (latest.current === error ? error : current)));
    },
    shown: (error, element) => {
      alerts.current.set(error, element);
    },
  }));

  useEffect(() => {
    // An answer and the end of its fetch reach the page in one render, so no
    // matching read in flight means the page shows what it read again.
    if (settled === null || fetching > 0) return;
    setSettled(null);
    if (settled !== latest.current) return;
    const alert = alerts.current.get(settled);
    const lost = focusLost();
    if (alert !== undefined && visible(alert)) {
      if (lost) alert.focus();
      return;
    }
    setOrphan({ error: settled, focus: lost });
  }, [settled, fetching]);

  useEffect(() => {
    if (orphan?.focus) notice.current?.focus();
  }, [orphan]);

  const value = useMemo(
    () => ({ actions, orphan: orphan?.error ?? null, notice }),
    [actions, orphan],
  );
  return <PlanRefreshContext.Provider value={value}>{children}</PlanRefreshContext.Provider>;
}

function useScope(): PlanRefreshContextValue {
  const scope = useContext(PlanRefreshContext);
  if (scope === null) throw new Error("a plan refusal needs an enclosing PlanRefreshScope");
  return scope;
}

/**
 * The options a review's plan mutation spreads in: a stale refusal reads the
 * enclosing `PlanRefreshScope` again; any other refusal reads nothing.
 */
export function usePlanRefresh(): {
  onMutate: () => void;
  onError: (error: Error) => void;
} {
  const { actions } = useScope();
  return { onMutate: actions.started, onError: actions.refused };
}

/** A plan's refusal in the item that asked for it; nothing without one. */
export function PlanRefusal({ error }: { error: Error | null }): ReactNode {
  const { actions } = useScope();
  if (error === null) return null;
  return (
    <div
      ref={(element) => {
        if (element !== null) actions.shown(error, element);
      }}
      className="notice notice-bad"
      role="alert"
      tabIndex={-1}
    >
      {error.message}
    </div>
  );
}

/**
 * Where the page shows a stale refusal that the item read again no longer
 * shows, until the next plan is sent.
 */
export function PlanRefreshNotice(): ReactNode {
  const { orphan, notice } = useScope();
  if (orphan === null) return null;
  return (
    <div ref={notice} className="panel-note panel-note-bad" role="alert" tabIndex={-1}>
      {orphan.message}
      読み直した表示には、判断しようとした欄がないか、別の場所に移っています。
    </div>
  );
}

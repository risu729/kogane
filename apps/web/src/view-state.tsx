import {
  createContext,
  useCallback,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { SortingState } from "@tanstack/react-table";
import { EMPTY_FILTERS, type RecordFilters } from "./filters.ts";
import type { ReconstructedStateQuery } from "./reconstructed-state-api.ts";
import { useLocation } from "./router.tsx";

/**
 * An in-memory page of one server response. `window` is the query string that
 * requested that response, so another server window (the next 500 rows, a
 * changed server filter) starts at its own first page.
 */
interface ListPage {
  window: string;
  page: number;
}

interface ViewState {
  "transactions.filters": RecordFilters;
  "transactions.search": string;
  "transactions.page": ListPage;
  "transactions.sorting": SortingState;
  "balances.filters": RecordFilters;
  "balances.instrument": string;
  "balances.metric": string;
  "balances.hideZero": boolean;
  "positions.filters": RecordFilters;
  "positions.page": ListPage;
  "identity.source": string;
  "identity.draft": string;
  "identity.tab": "accounts" | "instruments";
  "identity.offset": number;
  "identity.coverageOffset": number;
  "purchases.period": string;
  "purchases.draft": string;
  "purchases.offset": number;
  "reportedState.date": string;
  "reportedState.changeFrom": string;
  "reconstructedState.query": ReconstructedStateQuery | null;
  "reports.offset": number;
}
const Context = createContext<{
  state: ViewState;
  setState: Dispatch<SetStateAction<ViewState>>;
} | null>(null);

/** Keep list controls while visiting a record. Nothing enters URLs or storage. */
export function ViewStateProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, setState] = useState<ViewState>(() => ({
    "transactions.filters": { ...EMPTY_FILTERS },
    "transactions.search": "",
    "transactions.page": { window: "", page: 0 },
    "transactions.sorting": [],
    "balances.filters": { ...EMPTY_FILTERS },
    "balances.instrument": "",
    "balances.metric": "",
    "balances.hideZero": false,
    "positions.filters": { ...EMPTY_FILTERS },
    "positions.page": { window: "", page: 0 },
    "identity.source": "",
    "identity.draft": "",
    "identity.tab": "accounts",
    "identity.offset": 0,
    "identity.coverageOffset": 0,
    "purchases.period": "",
    "purchases.draft": "",
    "purchases.offset": 0,
    "reportedState.date": "",
    "reportedState.changeFrom": "",
    "reconstructedState.query": null,
    "reports.offset": 0,
  }));
  return <Context.Provider value={{ state, setState }}>{children}</Context.Provider>;
}

export function useViewState<K extends keyof ViewState>(
  key: K,
): [ViewState[K], Dispatch<SetStateAction<ViewState[K]>>] {
  const context = useContext(Context);
  if (context === null) throw new Error("ViewStateProvider is required");
  const { state, setState } = context;
  const update = useCallback<Dispatch<SetStateAction<ViewState[K]>>>(
    (next) => {
      setState((previous) => ({
        ...previous,
        [key]:
          typeof next === "function"
            ? (next as (previous: ViewState[K]) => ViewState[K])(previous[key])
            : next,
      }));
    },
    [key, setState],
  );
  return [state[key], update];
}

/**
 * The in-memory page of a list whose rows are the URL's server window. The
 * page survives a visit to a record and back (the same window) and starts at
 * the first page when the window changes (the next 500 rows, a server filter).
 */
export function useListPage(
  key: "transactions.page" | "positions.page",
): [number, (page: number) => void] {
  const serverWindow = useLocation().split("?")[1] ?? "";
  const [stored, setStored] = useViewState(key);
  const setPage = useCallback(
    (page: number) => setStored({ window: serverWindow, page }),
    [setStored, serverWindow],
  );
  return [stored.window === serverWindow ? stored.page : 0, setPage];
}

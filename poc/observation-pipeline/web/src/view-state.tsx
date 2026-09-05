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

interface ViewState {
  "transactions.filters": RecordFilters;
  "transactions.search": string;
  "transactions.page": number;
  "transactions.sorting": SortingState;
  "balances.filters": RecordFilters;
}
const Context = createContext<{
  state: ViewState;
  setState: Dispatch<SetStateAction<ViewState>>;
} | null>(null);

/** Keep list controls while visiting a record. Nothing enters URLs or storage. */
export function ViewStateProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [state, setState] = useState<ViewState>(() => ({
    "transactions.filters": { ...EMPTY_FILTERS },
    "transactions.search": "",
    "transactions.page": 0,
    "transactions.sorting": [],
    "balances.filters": { ...EMPTY_FILTERS },
  }));
  return (
    <Context.Provider value={{ state, setState }}>{children}</Context.Provider>
  );
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

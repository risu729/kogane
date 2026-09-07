// Entry point.
//
// One in-memory QueryClient. Views refetch on mount/focus, while cached data
// remains visible with a notice during refresh or after a refresh failure.
// No financial figure is written to localStorage or sessionStorage.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./api.ts";
import { App } from "./app.tsx";
import { EvidenceApp } from "./evidence-app.tsx";
import { ViewStateProvider } from "./view-state.tsx";
import "./styles.css";

declare const __EVIDENCE_BROWSER__: boolean;

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError(error, query) {
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        // A subsequent network failure or route remount must not resurrect
        // records whose authorization was rejected. Refetch to restore them.
        query.setState({ data: undefined, dataUpdatedAt: 0 });
      }
    },
  }),
  defaultOptions: {
    queries: {
      // Immediately eligible for refresh; this does not imply that the
      // underlying collector or observation itself is current.
      staleTime: 0,
      refetchOnWindowFocus: true,
      // A 404 from this API means the row does not exist, which retrying
      // cannot change. Only a transport or server failure is worth a retry.
      retry: (failureCount: number, error: Error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 1;
      },
    },
  },
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html is missing its #root container");
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ViewStateProvider>{__EVIDENCE_BROWSER__ ? <EvidenceApp /> : <App />}</ViewStateProvider>
    </QueryClientProvider>
  </StrictMode>,
);

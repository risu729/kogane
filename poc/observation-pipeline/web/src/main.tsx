// Entry point.
//
// One QueryClient, configured so that nothing this client shows outlives the
// response it came from: every view refetches on mount, nothing is written to
// localStorage or sessionStorage, and no financial figure is persisted
// anywhere in the browser. React Query's cache is an in-memory read cache for
// the life of the tab and nothing more.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "./api.ts";
import { App } from "./app.tsx";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Always stale: an operator checking a parser against the bytes should
      // never be shown a figure the store may have moved past.
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
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

// The failure a pressed retry repeats, shared by `QueryBoundary` and the ホーム
// 判断待ち panel. React Query clears the error of a query that holds no answer
// as soon as a refetch starts, which would swap the alert, and the retry
// button the owner pressed, for the loading state and drop the focus to the
// document body. Until that read settles the alert stays, its button waiting
// (再試行中…): the remembered failure stands only while the query has no
// data, is fetching, and has not recorded a newer error since the press.
import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";

export function useRepeatedFailure<T>(query: UseQueryResult<T, Error>): {
  /** The query's error, or the one a pressed retry repeats while it is in flight. */
  failure: Error | null;
  /** Reads again, unless a read is in flight; remembers the failure it repeats. */
  retry: () => void;
  /** A read of the query is in flight: the retry button waits. */
  retrying: boolean;
} {
  const [repeating, setRepeating] = useState<{ error: Error; at: number } | null>(null);
  const retry = (): void => {
    if (query.isFetching) return;
    if (query.error !== null) setRepeating({ error: query.error, at: query.errorUpdatedAt });
    void query.refetch();
  };
  const failure =
    query.error ??
    (repeating !== null &&
    query.data === undefined &&
    query.fetchStatus === "fetching" &&
    query.errorUpdatedAt === repeating.at
      ? repeating.error
      : null);
  return { failure, retry, retrying: query.isFetching };
}

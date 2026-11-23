// The paging refusal family (ADR 0128) as this Worker answers it: on a route
// an `HttpError` (the Worker adds `requestId`), from a tool a `ToolResult`
// with the same body without it. The codes, statuses and hints are the shared
// contract's (`packages/observation-shared/src/paging-contract.ts`), so a
// route and a tool cannot answer one refusal two ways.
import type { PagingRefusal } from "../../../packages/observation-shared/src/paging-contract.ts";
import type { ToolResult } from "./agent-service";
import { HttpError } from "./http";

/** The refusal as a route's `HttpError`; `retryWith` is not a route hint yet (slice S2). */
export function pagingHttpError(refusal: PagingRefusal): HttpError {
  return new HttpError(
    refusal.status,
    refusal.error,
    [],
    refusal.mustMatch === undefined ? {} : { mustMatch: refusal.mustMatch },
  );
}

/** The refusal as a tool's result: `{ error, mustMatch?, retryWith? }`. */
export function pagingRefusal(refusal: PagingRefusal): ToolResult {
  return {
    status: refusal.status,
    body: {
      error: refusal.error,
      ...(refusal.mustMatch === undefined ? {} : { mustMatch: [...refusal.mustMatch] }),
      ...(refusal.retryWith === undefined ? {} : { retryWith: refusal.retryWith }),
    },
  };
}

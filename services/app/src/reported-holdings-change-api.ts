// `GET /api/v2/reported-holdings-change?from=YYYY-MM-DD&to=YYYY-MM-DD`
// `[&source=…][&account=…]`: the reported holdings of two dates side by side
// per provider holding key, with the exact change where both dates list a
// holding (packages/application/src/query/holdings-change.ts, ADR 0075 and its
// 2026-11-06 amendment, docs/reported-state.md). Exposed exactly as
// `/api/v2/reported-state` is: read-only, GET-only, served under the reader
// authority every signed-in subject already has over the other GET routes,
// and absent where the store lacks the views the two dated reads join. It
// adds no holdings up, values nothing and carries no review action.
//
// `detail=summary` (the default) answers one page of the changed lines only
// (`summarizeHoldingsChange`, ADR 0075 amendment 2026-11-19); `detail=full`
// answers the comparison as it was, unpaged. Both are built from one
// comparison, which every page computes again; a cursor is bound to it.
import {
  HOLDINGS_CHANGE_SUMMARY_DEFAULT_LIMIT,
  summarizeHoldingsChange,
  type HoldingsChangeCursorRefusal,
} from "../../../packages/domain/src/holdings-change-summary.ts";
import {
  HoldingsChangeError,
  queryHoldingsChange,
  type HoldingsChangeRefusal,
} from "../../../packages/application/src/query/holdings-change.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import {
  holdingsChangeQueryRefusal,
  REPORTED_HOLDINGS_CHANGE_PATH,
} from "../../../packages/observation-shared/src/reported-holdings-change-contract.ts";
import { readerGrant } from "./agent-api";
import { assertMethod, HttpError, json, READ_METHODS } from "./http";
import { reportedStateAvailable } from "./reported-state-api";

export { REPORTED_HOLDINGS_CHANGE_PATH };

/** The HTTP answer of each refusal of the query; every one is a closed code. */
const REFUSALS: Record<HoldingsChangeRefusal, { status: number; code: string }> = {
  invalid_request: { status: 400, code: "invalid_query" },
  invalid_range: { status: 400, code: "invalid_range" },
  date_in_future: { status: 400, code: "date_in_future" },
  unknown_source: { status: 404, code: "unknown_source" },
  unknown_account: { status: 404, code: "unknown_account" },
  // More holdings or rows than the bound are refused, never cut into a partial answer.
  holding_limit_exceeded: { status: 413, code: "result_limit_exceeded" },
  dated_state_limit_exceeded: { status: 413, code: "result_limit_exceeded" },
};

/** A refused summary cursor: malformed, of another request, or of a comparison that has moved. */
const CURSOR_REFUSALS: Record<HoldingsChangeCursorRefusal, number> = {
  invalid_cursor: 400,
  cursor_mismatch: 400,
  // The comparison's inputs moved (a capture, mapping, parse or reported
  // context): its pages are gone, never answered from the new comparison.
  context_expired: 410,
};

/**
 * The argument names a summary cursor is bound to besides its comparison: a
 * `cursor_mismatch` names them as `mustMatch` (ADR 0123), names only.
 */
const HOLDINGS_CHANGE_CURSOR_INPUTS = ["from", "to", "source", "account"] as const;

/** Served exactly where `/api/v2/reported-state` is: both dated reads need its views. */
export async function reportedHoldingsChangeAvailable(env: Env): Promise<boolean> {
  return reportedStateAvailable(env);
}

/** Today's civil date in Asia/Tokyo: a later date has no reported state yet. */
function tokyoToday(now: number): string {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

export async function reportedHoldingsChangeApi(
  request: Request,
  env: Env,
  url: URL,
  subject: string,
): Promise<Response | null> {
  if (url.pathname !== REPORTED_HOLDINGS_CHANGE_PATH) return null;
  assertMethod(request, READ_METHODS);
  if (!(await reportedHoldingsChangeAvailable(env))) throw new HttpError(404, "not_found");
  // The reader authority: every source and account, summaries and records.
  if (!readerGrant(subject).capabilities.includes("summary.read"))
    throw new HttpError(403, "forbidden");
  return json(await readHoldingsChange(env, url.searchParams));
}

/**
 * The two dated reported states side by side for these query parameters: the
 * answer of the route and of `kogane.reported-holdings-change.read`
 * (ADR 0081), once the caller's authority and the store's views are known:
 * one page of the summary, or the full comparison with `detail=full`. Its
 * refusals are `HttpError`s with the route's closed codes.
 */
export async function readHoldingsChange(
  env: Env,
  params: URLSearchParams,
): Promise<Record<string, unknown>> {
  // The wire contract's shape rules, which the page applies before it asks.
  const refusal = holdingsChangeQueryRefusal(params);
  if (refusal !== null) throw new HttpError(400, refusal);
  const from = params.get("from")!;
  const to = params.get("to")!;
  const source = params.get("source");
  const account = params.get("account");
  let change;
  try {
    change = await queryHoldingsChange(d1Executor(env.DB), {
      from,
      to,
      today: tokyoToday(Date.now()),
      ...(source === null ? {} : { source }),
      ...(account === null ? {} : { account }),
    });
  } catch (error) {
    if (error instanceof HoldingsChangeError) {
      const refusal = REFUSALS[error.code];
      throw new HttpError(
        refusal.status,
        refusal.code,
        refusal.code === error.code ? [] : [error.code],
      );
    }
    throw error;
  }
  if (params.get("detail") === "full") return { apiVersion: 2, ...change };
  const limit = params.get("limit");
  const page = await summarizeHoldingsChange(change, {
    limit: limit === null ? HOLDINGS_CHANGE_SUMMARY_DEFAULT_LIMIT : Number(limit),
    cursor: params.get("cursor"),
  });
  if (!page.ok)
    throw new HttpError(
      CURSOR_REFUSALS[page.code],
      page.code,
      [],
      page.code === "cursor_mismatch" ? { mustMatch: HOLDINGS_CHANGE_CURSOR_INPUTS } : {},
    );
  return { apiVersion: 2, ...page.summary };
}

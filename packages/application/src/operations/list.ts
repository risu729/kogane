// The operator's own operations requests, newest first (ADR 0086).
//
// `readOperation` answers for one id; this answers "which ids do I hold". It
// is a read of `ops_requests` scoped to the verified principal, in one stable
// total order — `created_at` descending, then `operation_id` descending — and
// paged by keyset: the cursor is the operation id of the last row of the
// previous page, resolved to its position with the same principal filter.
//
// Every page uses an index of migration 0040 and reads at most what its page
// needs (ADR 0086, "Decision"):
//
//   * no filter: one range on `ops_requests_principal (principal, created_at)`;
//   * a kind, a status or both: one arm per (status, kind) pair the filters
//     allow, each a range on `ops_requests_open (status, kind, created_at)`
//     limited to the page, merged newest first. The principal is checked on
//     the rows each arm reads (`+principal` keeps the planner on that index).
//
// A summary carries identifiers, closed codes, counts and timestamps only. The
// stored request (`request_json`) is never read here: a rebuild's `reason` is
// free text, and the list is not where a payload is shown.
import type { CommandStore, Principal } from "../command/contract.ts";
import { commandError, type CommandResult } from "../command/errors.ts";
import {
  type DispatchState,
  OPERATION_KINDS,
  OPERATION_STATUSES,
  type OperationKind,
  type OperationStatus,
} from "./requests.ts";

/** Rows on a page when the caller names no limit. */
export const OPERATION_LIST_DEFAULT_LIMIT = 20;
/** The most rows one page returns. */
export const OPERATION_LIST_MAX_LIMIT = 50;

export interface OperationListQuery {
  kind: OperationKind | null;
  status: OperationStatus | null;
  /** The operation id of the last row of the previous page, or null for the first page. */
  cursor: string | null;
  /** 1 to `OPERATION_LIST_MAX_LIMIT`; the adapter validates it. */
  limit: number;
}

/** One request as the list shows it: what `readOperation` shows, without stages or execution. */
export interface OperationSummary {
  operationId: string;
  kind: OperationKind;
  status: OperationStatus;
  source: string | null;
  dispatch: { state: DispatchState; attempts: number };
  failureCode: string | null;
  acceptedAt: string;
  updatedAt: string;
}

export interface OperationListPage {
  schemaVersion: "kogane-operation-list-v1";
  operations: OperationSummary[];
  /** The cursor of the next page, or null when this page is the last. */
  nextCursor: string | null;
}

interface ListRow {
  operation_id: string;
  kind: string;
  status: string;
  source_id: string | null;
  dispatch_state: string;
  dispatch_attempts: number;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

const LIST_COLUMNS = `operation_id,kind,status,source_id,dispatch_state,dispatch_attempts,
 failure_code,created_at,updated_at`;
const NEWEST_FIRST = "ORDER BY created_at DESC,operation_id DESC";
const CURSOR_POSITION =
  "SELECT created_at FROM ops_requests WHERE operation_id=?1 AND principal=?2";

/** The (status, kind) pairs a filter allows, or null for no filter. */
export function operationListArms(
  query: Pick<OperationListQuery, "kind" | "status">,
): (readonly [OperationStatus, OperationKind])[] | null {
  if (query.kind === null && query.status === null) return null;
  const statuses = query.status === null ? OPERATION_STATUSES : [query.status];
  const kinds = query.kind === null ? OPERATION_KINDS : [query.kind];
  return statuses.flatMap((status) => kinds.map((kind) => [status, kind] as const));
}

/**
 * The page's SQL. `?1` is the principal and `?2` the page size plus one; the
 * (status, kind) pairs follow, then, after a cursor, its `created_at` and
 * operation id. Only placeholders vary with the input: every value is bound.
 */
export function operationListSql(arms: number | null, afterCursor: boolean): string {
  const at = (arms ?? 0) * 2 + 3;
  const after = afterCursor
    ? ` AND created_at<=?${at} AND (created_at<?${at} OR operation_id<?${at + 1})`
    : "";
  if (arms === null)
    return `SELECT ${LIST_COLUMNS} FROM ops_requests WHERE principal=?1${after}
 ${NEWEST_FIRST} LIMIT ?2`;
  const parts: string[] = [];
  for (let arm = 0; arm < arms; arm++)
    parts.push(`SELECT * FROM (SELECT ${LIST_COLUMNS} FROM ops_requests
 WHERE status=?${arm * 2 + 3} AND kind=?${arm * 2 + 4} AND +principal=?1${after}
 ${NEWEST_FIRST} LIMIT ?2)`);
  return `${compound(parts)}\n${NEWEST_FIRST} LIMIT ?2`;
}

/** D1 refuses a compound SELECT of more terms than this ("too many terms in compound SELECT"). */
const D1_COMPOUND_TERMS = 5;

/**
 * `UNION ALL` of the arms, nested so that no compound has more terms than D1
 * accepts: the six statuses of a kind filter are two subqueries of three.
 */
function compound(parts: readonly string[]): string {
  if (parts.length <= D1_COMPOUND_TERMS) return parts.join("\nUNION ALL\n");
  const groups = Math.ceil(parts.length / D1_COMPOUND_TERMS);
  const size = Math.ceil(parts.length / groups);
  const nested: string[] = [];
  for (let start = 0; start < parts.length; start += size)
    nested.push(`SELECT * FROM (${compound(parts.slice(start, start + size))})`);
  return compound(nested);
}

function summaryOf(row: ListRow): OperationSummary {
  return {
    operationId: row.operation_id,
    kind: row.kind as OperationKind,
    status: row.status as OperationStatus,
    source: row.source_id,
    dispatch: { state: row.dispatch_state as DispatchState, attempts: row.dispatch_attempts },
    failureCode: row.failure_code,
    acceptedAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * `GET /api/ops/v1/operations`: one page of the principal's own requests.
 * A cursor that names no operation of this principal answers
 * `receipt_not_found`, exactly as one that does not exist: the list never
 * confirms an id it will not show.
 */
export async function listOperations(input: {
  store: CommandStore;
  principal: Principal;
  query: OperationListQuery;
}): Promise<CommandResult<{ page: OperationListPage }>> {
  const { store, principal, query } = input;
  const binds: unknown[] = [principal.id, query.limit + 1];
  const arms = operationListArms(query);
  for (const [status, kind] of arms ?? []) binds.push(status, kind);
  if (query.cursor !== null) {
    const position = await store.first<{ created_at: string }>(CURSOR_POSITION, [
      query.cursor,
      principal.id,
    ]);
    if (!position) return commandError("receipt_not_found", ["cursor"]);
    binds.push(position.created_at, query.cursor);
  }
  const rows = await store.all<ListRow>(
    operationListSql(arms?.length ?? null, query.cursor !== null),
    binds,
  );
  const page = rows.slice(0, query.limit).map(summaryOf);
  return {
    ok: true,
    page: {
      schemaVersion: "kogane-operation-list-v1",
      operations: page,
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.operationId : null,
    },
  };
}

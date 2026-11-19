// The account list (`GET /api/identity/account-list`, `kogane.identity.read`
// with `collection: "account-list"`; ADR 0077 amendment 2026-11-19): one line
// per account entity that current published identity observations reach,
// with the label the shared organization step gives its rows, its kind, the
// sources of its references, its mapping status, its connection state and
// the newest capture time of those observations. The page and the tool read
// this one function (ADR 0081); it reads, and nothing else.
import {
  ACCOUNT_LIST_BYTE_BUDGET,
  ACCOUNT_LIST_PAGE_SIZE,
  type AccountListConnection,
  type AccountListPage,
  type AccountListRow,
  type IdentityStatus,
} from "../../../observation-shared/src/identity-contract.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import { decoratedAccountLabel, readAccountLabelDecorations } from "./account-connections.ts";

/**
 * The source references one read may hold before it is refused whole
 * (`identity_account_list_limit`, a store failure on the route and the tool).
 */
const ACCOUNT_LIST_REFERENCE_BOUND = 5_000;

/**
 * Every source reference current published identity observations use, with
 * its current mapping, its entity's kind and the newest capture time of those
 * observations. The walk over `current_identity_observations` is the one the
 * `accounts` collection makes (docs/identity-query-performance.md); it is
 * reduced to distinct (reference, parse run) pairs before each parse run and
 * its artifact are read by primary key, and every other table is read by key.
 * One row past the bound is read, so a larger store is refused, never cut.
 */
export const ACCOUNT_LIST_SQL = `WITH current AS MATERIALIZED (
 SELECT o.source_account_id,o.parse_run_id FROM current_identity_observations o
), runs AS MATERIALIZED (
 SELECT DISTINCT source_account_id,parse_run_id FROM current
), seen AS MATERIALIZED (
 SELECT r.source_account_id,max(coalesce(a.fetched_at_ms,a.recorded_at_ms)) lastMs
 FROM runs r JOIN parse_runs p ON p.id=r.parse_run_id JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
 GROUP BY r.source_account_id
) SELECT s.id referenceId,s.source_id source,s.producer_id producer,
 json_extract(s.reference_json,'$[0]') sourceAccount,m.account_id targetId,m.label,m.status,m.method,
 m.created_at createdAt,a.role kind,seen.lastMs
FROM seen JOIN source_accounts s ON s.id=seen.source_account_id
JOIN account_mappings m ON m.source_account_id=s.id
 AND m.revision=(SELECT max(n.revision) FROM account_mappings n WHERE n.source_account_id=s.id)
JOIN accounts a ON a.id=m.account_id
ORDER BY m.account_id,s.id LIMIT ${String(ACCOUNT_LIST_REFERENCE_BOUND + 1)}`;

interface AccountListReference {
  referenceId: string;
  source: string;
  producer: string;
  sourceAccount: string;
  targetId: string;
  label: string;
  status: IdentityStatus;
  method: "rule" | "manual";
  createdAt: string;
  kind: string;
  lastMs: number | null;
}

/** The query of the account list, already checked by its route. */
export interface AccountListQuery {
  /** Only entities with a reference of this source; null for every entity. */
  source: string | null;
  /** Only entities of this kind (the entity's role); null for every kind. */
  kind: string | null;
  offset: number;
}

/** The source whose references a connection review can label. */
const AGGREGATOR_SOURCE = "moneyforward-me";

/** A capture time to the second, as the other identity answers state times. */
function isoSeconds(ms: number | null): string | null {
  if (ms === null) return null;
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 19)}Z`;
}

/** Newest mapping first, then by reference id, so the choice is stable. */
function newestFirst(a: AccountListReference, b: AccountListReference): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.referenceId < b.referenceId ? -1 : 1;
}

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const jsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** One entity's line, from its current references (one or more). */
function entityRow(
  account: string,
  members: readonly AccountListReference[],
  decorations: Awaited<ReturnType<typeof readAccountLabelDecorations>>,
): AccountListRow {
  // A person's manual label wins; else the newest automatic mapping speaks
  // for the entity, decorated by the shared label step (its entity's
  // connection label first).
  const manual = members.filter((ref) => ref.method === "manual").sort(newestFirst);
  const primary = manual[0] ?? [...members].sort(newestFirst)[0]!;
  const shown = members.map((ref) =>
    decoratedAccountLabel(ref.label, ref.method, ref.source, decorations.get(ref.referenceId)),
  );
  const sources = [...new Set(members.map((ref) => ref.source))].sort(order);
  const statuses = [...new Set(members.map((ref) => ref.status))];
  const states = [
    ...new Set(shown.flatMap((label) => (label.connection ? [label.connection.status] : []))),
  ];
  const connection: AccountListConnection | null =
    states.length === 1
      ? states[0]!
      : states.length > 1
        ? "mixed"
        : sources.includes(AGGREGATOR_SOURCE)
          ? "not-reviewed"
          : null;
  let last: number | null = null;
  for (const ref of members)
    if (ref.lastMs !== null && (last === null || ref.lastMs > last)) last = ref.lastMs;
  return {
    account,
    label: shown[members.indexOf(primary)]!.label,
    kind: primary.kind,
    sources,
    mapping: statuses.length === 1 ? statuses[0]! : "mixed",
    connection,
    lastObservedAt: isoSeconds(last),
  };
}

/**
 * One page of the account list: one row per entity, filtered by `source`
 * (any of its references) and `kind`, sorted by first source, label and id,
 * at most `ACCOUNT_LIST_PAGE_SIZE` rows, closed early so the whole answer
 * stays within `ACCOUNT_LIST_BYTE_BUDGET` bytes of JSON. Latest mappings only.
 */
export async function readAccountList(
  sql: SqlExecutor,
  { source, kind, offset }: AccountListQuery,
): Promise<AccountListPage> {
  const refs = await sql.all<AccountListReference>(ACCOUNT_LIST_SQL, []);
  if (refs.length > ACCOUNT_LIST_REFERENCE_BOUND) throw new Error("identity_account_list_limit");
  const decorations = await readAccountLabelDecorations(sql, refs);
  const entities = new Map<string, AccountListReference[]>();
  for (const ref of refs) {
    const members = entities.get(ref.targetId) ?? [];
    members.push(ref);
    entities.set(ref.targetId, members);
  }
  const selected = [...entities]
    .map(([account, members]) => entityRow(account, members, decorations))
    .filter(
      (row) =>
        (source === null || row.sources.includes(source)) && (kind === null || row.kind === kind),
    )
    .sort(
      (a, b) =>
        order(a.sources[0]!, b.sources[0]!) ||
        order(a.label, b.label) ||
        order(a.account, b.account),
    );
  const page: AccountListPage = {
    rows: [],
    coverage: {
      limit: ACCOUNT_LIST_PAGE_SIZE,
      total: selected.length,
      nextOffset: null,
      truncated: false,
    },
  };
  // Each row is admitted against the longest continuation the page could
  // carry, so closing the page never pushes it past the budget.
  const longest = { ...page.coverage, nextOffset: Number.MAX_SAFE_INTEGER, truncated: true };
  for (const row of selected.slice(offset, offset + ACCOUNT_LIST_PAGE_SIZE)) {
    if (jsonBytes({ rows: [...page.rows, row], coverage: longest }) > ACCOUNT_LIST_BYTE_BUDGET)
      break;
    page.rows.push(row);
  }
  const following = offset + page.rows.length;
  if (following < selected.length) {
    // A row too large for a page of its own is refused, never skipped.
    if (page.rows.length === 0) throw new Error("identity_account_list_row_budget");
    page.coverage.nextOffset = following;
    page.coverage.truncated = true;
  }
  return page;
}

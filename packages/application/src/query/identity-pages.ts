// The identity pages (`GET /api/identity/<collection>`, docs/identity-operations.md):
// the account and instrument mappings each source's current published
// identity observations use, and the per-source coverage counts. The page and
// `kogane.identity.read` (ADR 0081) read one function here; the route keeps
// only its query-parameter checks. Moved here from
// `services/app/src/identity-api.ts` (ADR 0081 point 2), so no adapter holds
// this SQL.
import type {
  IdentityAccountListRow,
  IdentityOrigin,
} from "../../../observation-shared/src/identity-contract.ts";
import {
  IDENTITY_PAGE_LIMIT,
  nextIdentityOffset,
} from "../../../observation-shared/src/identity-contract.ts";
import {
  type IdentityReadMode,
  identityReleaseFor,
  interpretationContext,
} from "../../../read-model/src/index.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
import {
  connectionAccountLabel,
  listAccountConnections,
  readAccountConnections,
} from "./account-connections.ts";
import { displayAccountLabel, entityAccountLabels } from "./account-labels.ts";
import { preferredInstrumentNames } from "./preferred-instrument-names.ts";

const LIMIT = IDENTITY_PAGE_LIMIT;
/**
 * The references `account-list` groups in one read. Production holds a few
 * dozen; more than this is refused (`identity_account_list_limit`), never cut,
 * since a cut would split an account's references across an unseen page.
 */
export const ACCOUNT_LIST_REFERENCE_LIMIT = 2000;
// Evaluate the canonical eligibility view once, before joining instrument roles.
// Source-account provenance is enforced on every immutable identity observation.
const CURRENT = `current AS MATERIALIZED (
 SELECT o.id,o.kind,o.observation_id,o.parse_run_id,o.identity_run_id,o.source_account_id,o.account_mapping_id,s.source_id
 FROM current_identity_observations o JOIN source_accounts s ON s.id=o.source_account_id
 WHERE FILTER
)`;
// Only coverage needs the B denominator (including observations without C).
// Eligibility is the publication projection (docs/publication-gate.md), the
// same gate current_identity_observations reads since migration 0026.
const ELIGIBLE = `all_observations AS (
 SELECT 'transaction' kind,id,parse_run_id FROM transaction_observations UNION ALL
 SELECT 'balance',id,parse_run_id FROM balance_observations UNION ALL
 SELECT 'position',id,parse_run_id FROM position_observations UNION ALL
 SELECT 'valuation',id,parse_run_id FROM valuation_observations
), eligible AS MATERIALIZED (
 SELECT b.*,a.source_id FROM all_observations b
 JOIN published_parse_runs pub ON pub.parse_run_id=b.parse_run_id
 JOIN parse_runs p ON p.id=pub.parse_run_id
 JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN observation_fetch_runs f ON f.id=a.fetch_run_id
 WHERE f.status='success' AND f.failure_count=0
)`;

/**
 * `latest` reports each reference's current mapping revision. `as-recorded`
 * reports the highest mapping revision the currently eligible sealed runs
 * pinned for it, together with the release of the run that pinned it, so a
 * later correction changes `latest` and not `as-recorded`.
 */
export function identityQuery(
  collection: "accounts" | "account-list" | "instruments" | "coverage",
  filtered: boolean,
  mode: IdentityReadMode = "latest",
): string {
  const current = CURRENT.replace("FILTER", filtered ? "s.source_id=?1" : "1");
  const offset = filtered ? "?2" : "?1";
  const recorded = mode === "as-recorded";
  // `account-list` reads every reference (bounded) and groups them by account
  // in `readIdentityAccountList`; it adds the entity's own row and when each
  // reference's newest capture was recorded.
  const list = collection === "account-list";
  if (collection === "accounts" || list)
    return `WITH ${current}, counts AS MATERIALIZED (
    SELECT source_account_id,source_id,count(*) observedCount,min(kind||':'||observation_id) originKey
    FROM current GROUP BY source_account_id,source_id
  )${
    list
      ? `, runs AS MATERIALIZED (
    SELECT DISTINCT source_account_id,parse_run_id FROM current
  ), seen AS MATERIALIZED (
    SELECT r.source_account_id,max(f.first_recorded_at_ms) lastFetchedAtMs
    FROM runs r JOIN parse_runs p ON p.id=r.parse_run_id JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
    JOIN fetch_runs f ON f.id=a.fetch_run_id GROUP BY r.source_account_id
  )`
      : ""
  }${
    recorded
      ? `, pinned AS MATERIALIZED (
    SELECT c.source_account_id,c.source_id,c.account_mapping_id,c.identity_run_id,
    row_number() OVER(PARTITION BY c.source_account_id,c.source_id ORDER BY am.revision DESC,c.id) rank
    FROM current c JOIN account_mappings am ON am.id=c.account_mapping_id
  )`
      : ""
  } SELECT s.id referenceId,m.account_id targetId,m.label,a.role,m.status,c.source_id source,
    s.reference_json reference,s.producer_id producer,json_extract(s.reference_json,'$[0]') sourceAccount,m.method,m.reason,m.revision,c.observedCount,c.originKey${
      recorded ? ",ctx.policy_release identityRelease" : ""
    }${list ? ",a.label accountLabel,a.status accountStatus,seen.lastFetchedAtMs" : ""}
    FROM counts c JOIN source_accounts s ON s.id=c.source_account_id${
      list ? " LEFT JOIN seen ON seen.source_account_id=c.source_account_id" : ""
    }
    ${
      recorded
        ? `JOIN pinned p ON p.source_account_id=c.source_account_id AND p.source_id=c.source_id AND p.rank=1
    JOIN account_mappings m ON m.id=p.account_mapping_id JOIN accounts a ON a.id=m.account_id
    JOIN identity_run_contexts ctx ON ctx.identity_run_id=p.identity_run_id`
        : "JOIN current_account_mappings m ON m.source_account_id=s.id JOIN accounts a ON a.id=m.account_id"
    }
    ORDER BY c.source_id,s.id LIMIT ${list ? ACCOUNT_LIST_REFERENCE_LIMIT + 1 : 101} OFFSET ${offset}`;
  if (collection === "instruments")
    return `WITH ${current}, counts AS MATERIALIZED (
    SELECT u.identifier_id,o.source_id,count(DISTINCT o.id) observedCount,min(o.kind||':'||o.observation_id) originKey
    FROM current o JOIN identity_instrument_uses u ON u.identity_observation_id=o.id
    GROUP BY u.identifier_id,o.source_id
  )${
    recorded
      ? `, pinned AS MATERIALIZED (
    SELECT u.identifier_id,o.source_id,u.instrument_mapping_id,o.identity_run_id,
    row_number() OVER(PARTITION BY u.identifier_id,o.source_id ORDER BY im.revision DESC,o.id) rank
    FROM current o JOIN identity_instrument_uses u ON u.identity_observation_id=o.id
    JOIN instrument_mappings im ON im.id=u.instrument_mapping_id
  )`
      : ""
  } SELECT d.id referenceId,m.instrument_id targetId,m.label,i.kind,m.status,c.source_id source,
    d.namespace,d.scope,d.value,m.reason,m.revision,c.observedCount,c.originKey${
      recorded ? ",ctx.policy_release identityRelease" : ""
    }
    FROM counts c JOIN instrument_identifiers d ON d.id=c.identifier_id
    ${
      recorded
        ? `JOIN pinned p ON p.identifier_id=c.identifier_id AND p.source_id=c.source_id AND p.rank=1
    JOIN instrument_mappings m ON m.id=p.instrument_mapping_id JOIN instruments i ON i.id=m.instrument_id
    JOIN identity_run_contexts ctx ON ctx.identity_run_id=p.identity_run_id`
        : "JOIN current_instrument_mappings m ON m.identifier_id=d.id JOIN instruments i ON i.id=m.instrument_id"
    }
    ORDER BY c.source_id,d.id LIMIT 101 OFFSET ${offset}`;
  return `WITH ${ELIGIBLE}, ${current}
    SELECT o.source_id source,count(*) eligible,count(c.id) organized,
    sum(CASE WHEN m.status='identified' THEN 1 ELSE 0 END) identified,
    sum(CASE WHEN m.status='provider-local' THEN 1 ELSE 0 END) providerLocal,
    sum(CASE WHEN m.status='aggregate' THEN 1 ELSE 0 END) aggregate,
    sum(CASE WHEN m.status='unresolved' THEN 1 ELSE 0 END) unresolved
    FROM eligible o LEFT JOIN current c ON c.kind=o.kind AND c.observation_id=o.id AND c.parse_run_id=o.parse_run_id
    ${
      recorded
        ? "LEFT JOIN account_mappings m ON m.id=c.account_mapping_id"
        : "LEFT JOIN current_account_mappings m ON m.source_account_id=c.source_account_id"
    }
    WHERE ${filtered ? "o.source_id=?1" : "1"} GROUP BY o.source_id ORDER BY o.source_id LIMIT 101 OFFSET ${offset}`;
}
/** Distinct releases of the sealed runs behind a source's current identity observations. */
const RECORDED_RELEASES = `SELECT DISTINCT ctx.policy_release FROM current_identity_observations o
 JOIN identity_run_contexts ctx ON ctx.identity_run_id=o.identity_run_id
 JOIN source_accounts s ON s.id=o.source_account_id WHERE (?1 IS NULL OR s.source_id=?1) LIMIT 101`;
function page<T>(rows: T[], offset: number) {
  return {
    rows: rows.slice(0, LIMIT),
    coverage: {
      limit: LIMIT,
      truncated: rows.length > LIMIT,
      nextOffset: nextIdentityOffset(offset, rows.length > LIMIT),
    },
  };
}
function origin(row: Record<string, unknown>): Record<string, unknown> {
  const { originKey, ...rest } = row;
  const [kind, id] = String(originKey).split(":");
  return { ...rest, origin: { kind, id: Number(id) } as IdentityOrigin };
}
/** The identity pages, each `GET /api/identity/<collection>`. */
export const IDENTITY_COLLECTIONS = [
  "connections",
  "accounts",
  "account-list",
  "instruments",
  "coverage",
] as const;
export type IdentityCollection = (typeof IDENTITY_COLLECTIONS)[number];

/** The query of one non-connection page, already checked by its route. */
export interface IdentityPageQuery {
  source: string | null;
  offset: number;
  mode: IdentityReadMode;
}

/** The connection inventory page. */
export async function readIdentityConnections(sql: SqlExecutor) {
  return { connections: await listAccountConnections(sql) };
}

/** One page of accounts, account-list, instruments or coverage, with its interpretation context. */
export async function readIdentityPage(
  sql: SqlExecutor,
  collection: Exclude<IdentityCollection, "connections">,
  query: IdentityPageQuery,
): Promise<Record<string, unknown>> {
  if (collection === "account-list") return readIdentityAccountList(sql, query);
  const { source, offset, mode } = query;
  const bindings = source === null ? [offset] : [source, offset];
  const results = await sql.all<Record<string, unknown>>(
    identityQuery(collection, source !== null, mode),
    bindings,
  );
  if (collection === "instruments") {
    const names = await preferredInstrumentNames(
      sql,
      results.map((row) => String(row.referenceId)),
    );
    for (const row of results) row.label = names.get(String(row.referenceId))?.label ?? row.label;
  }
  if (collection === "accounts") {
    const connections = await readAccountConnections(
      sql,
      results.map((row) => ({
        referenceId: String(row.referenceId),
        source: String(row.source),
        producer: String(row.producer),
        sourceAccount: String(row.sourceAccount),
      })),
    );
    const entities = await entityAccountLabels(
      sql,
      results.slice(0, LIMIT).map((row) => String(row.targetId)),
    );
    for (const row of results) {
      const connection = connections.get(String(row.referenceId));
      if (connection) {
        row.connection = connection;
        row.label = connectionAccountLabel(
          String(row.label),
          row.method as "rule" | "manual",
          String(row.source),
          connection,
        );
      }
      row.label = displayAccountLabel(
        String(row.label),
        row.method as "rule" | "manual",
        entities.get(String(row.targetId)),
      );
      delete row.producer;
      delete row.sourceAccount;
      delete row.method;
    }
  }
  const releases =
    mode === "as-recorded" && collection === "coverage"
      ? (await sql.all<{ policy_release: string }>(RECORDED_RELEASES, [source])).map(
          (row) => row.policy_release,
        )
      : results.slice(0, LIMIT).map((row) => row.identityRelease as string | undefined);
  return {
    ...page(collection === "coverage" ? results : results.map(origin), offset),
    interpretationContext: interpretationContext(mode, identityReleaseFor(mode, releases)),
  };
}

interface AccountListReference {
  referenceId: string;
  targetId: string;
  label: string;
  role: string;
  source: string;
  producer: string;
  sourceAccount: string;
  method: "rule" | "manual";
  observedCount: number;
  identityRelease?: string;
  accountLabel: string;
  accountStatus: IdentityAccountListRow["status"];
  lastFetchedAtMs: number | null;
}

const one = <T>(values: Iterable<T>): T | undefined => {
  const set = new Set(values);
  return set.size === 1 ? [...set][0] : undefined;
};

/**
 * `GET /api/identity/account-list` (ADR 0120): one line per account entity
 * that current identity observations reach, with the entity's readable label,
 * where the per-reference `accounts` page has one line per source reference.
 * Every reference is read (refused past `ACCOUNT_LIST_REFERENCE_LIMIT`) and
 * grouped here, so an entity is never split across pages; the entities are
 * then paged by `offset`, 100 a page. `source` keeps the references of that
 * source only; the label is still the entity's.
 */
export async function readIdentityAccountList(
  sql: SqlExecutor,
  { source, offset, mode }: IdentityPageQuery,
): Promise<Record<string, unknown>> {
  const references = await sql.all<AccountListReference>(
    identityQuery("account-list", source !== null, mode),
    source === null ? [0] : [source, 0],
  );
  if (references.length > ACCOUNT_LIST_REFERENCE_LIMIT)
    throw new Error("identity_account_list_limit");
  const byAccount = new Map<string, AccountListReference[]>();
  for (const reference of references) {
    const group = byAccount.get(reference.targetId) ?? [];
    group.push(reference);
    byAccount.set(reference.targetId, group);
  }
  // References arrive ordered by source then reference id: an account is
  // placed where its first reference is, so the order is stable across reads.
  const accounts = [...byAccount.keys()];
  const shown = accounts.slice(offset, offset + LIMIT);
  const shownReferences = shown.flatMap((account) => byAccount.get(account)!);
  const [entities, connections] = await Promise.all([
    entityAccountLabels(sql, shown),
    readAccountConnections(sql, shownReferences),
  ]);
  const rows: IdentityAccountListRow[] = shown.map((account) => {
    const group = byAccount.get(account)!;
    const manual = one(group.filter((r) => r.method === "manual").map((r) => r.label));
    const entity = entities.get(account);
    const [label, labelOrigin]: [string, IdentityAccountListRow["labelOrigin"]] =
      manual !== undefined
        ? [manual, "manual"]
        : entity
          ? [entity.label, entity.origin]
          : [one(group.map((r) => r.label)) ?? group[0]!.accountLabel, "mapping"];
    const statuses = group.flatMap((r) => {
      const connection = connections.get(r.referenceId);
      return connection ? [connection.status] : [];
    });
    const fetched = group.flatMap((r) => (r.lastFetchedAtMs === null ? [] : [r.lastFetchedAtMs]));
    return {
      account,
      label,
      labelOrigin,
      role: group[0]!.role,
      status: group[0]!.accountStatus,
      sources: [...new Set(group.map((r) => r.source))].sort(),
      references: group.length,
      observedCount: group.reduce((sum, r) => sum + r.observedCount, 0),
      connection: statuses.length ? (one(statuses) ?? "unresolved") : null,
      lastFetchedAt: fetched.length ? new Date(Math.max(...fetched)).toISOString() : null,
    };
  });
  const more = accounts.length > offset + LIMIT;
  return {
    rows,
    coverage: { limit: LIMIT, truncated: more, nextOffset: nextIdentityOffset(offset, more) },
    interpretationContext: interpretationContext(
      mode,
      identityReleaseFor(
        mode,
        shownReferences.map((r) => r.identityRelease),
      ),
    ),
  };
}

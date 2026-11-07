// Display labels of the filter options' accounts. Moved here from
// `services/app/src/organized-filter-options.ts` (ADR 0081 point 2) so
// `/api/filter-options` and `kogane.store.read` share it.
import type { FilterOptions } from "../../../observation-shared/src/api-contract";
import { connectionAccountLabel, readAccountConnections } from "./account-connections.ts";
import type { SqlExecutor } from "../../../read-model/src/reader.ts";
const KINDS = { transactions: "transaction", balances: "balance", positions: "position" } as const;

/** Display-only metadata. Query values and source-account filter membership do not change. */
export async function organizedFilterOptions(
  reads: SqlExecutor,
  kind: string,
  options: FilterOptions,
): Promise<FilterOptions> {
  const observationKind = Object.hasOwn(KINDS, kind)
    ? KINDS[kind as keyof typeof KINDS]
    : undefined;
  if (!observationKind || !options.accounts.length) return options;
  if (options.accounts.length > 5000) throw new Error("filter_organization_budget");
  const rows = await reads.all<{
    source_id: string;
    producer_id: string;
    source_account: string;
    reference_id: string;
    label: string;
    target_id: string;
    method: "rule" | "manual";
  }>(
    `WITH current AS MATERIALIZED (
    SELECT o.*,s.source_id,s.producer_id FROM current_identity_observations o
    JOIN source_accounts s ON s.id=o.source_account_id WHERE o.kind='${observationKind}'
  ), names AS (
    SELECT DISTINCT c.source_id,c.producer_id,b.source_account,c.source_account_id reference_id,
    m.label,m.account_id target_id,m.method
    FROM current c JOIN ${observationKind}_observations b ON b.id=c.observation_id AND b.parse_run_id=c.parse_run_id
    JOIN current_account_mappings m ON m.source_account_id=c.source_account_id
  ) SELECT * FROM names LIMIT 5001`,
    [],
  );
  // Also bound distinct mapping references, not just raw filter groups. A raw
  // scope may span multiple producers/targets; never label a truncated subset.
  if (rows.length > 5000) throw new Error("filter_organization_budget");
  const connections = await readAccountConnections(
    reads,
    rows.map((row) => ({
      referenceId: row.reference_id,
      source: row.source_id,
      producer: row.producer_id,
      sourceAccount: row.source_account,
    })),
  );
  const names = new Map<string, { labels: Set<string>; targets: Set<string> }>();
  for (const row of rows) {
    const key = JSON.stringify([row.source_id, row.source_account]);
    const group = names.get(key) ?? { labels: new Set<string>(), targets: new Set<string>() };
    group.labels.add(
      connectionAccountLabel(
        row.label,
        row.method,
        row.source_id,
        connections.get(row.reference_id),
      ),
    );
    group.targets.add(row.target_id);
    names.set(key, group);
  }
  return {
    ...options,
    accounts: options.accounts.map((row) => {
      const name = names.get(JSON.stringify([row.source_id, row.source_account]));
      const ambiguous = name !== undefined && (name.labels.size > 1 || name.targets.size > 1);
      return {
        ...row,
        display_name: name && !ambiguous ? ([...name.labels][0] ?? null) : null,
        organization_ambiguous: ambiguous,
      };
    }),
  };
}

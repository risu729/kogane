import type { FilterOptions } from "../../../poc/observation-pipeline/shared/api-contract";
const KINDS = { transactions: "transaction", balances: "balance", positions: "position" } as const;

/** Display-only metadata. Query values and source-account filter membership do not change. */
export async function organizedFilterOptions(
  db: D1Database,
  kind: string,
  options: FilterOptions,
): Promise<FilterOptions> {
  const observationKind = Object.hasOwn(KINDS, kind)
    ? KINDS[kind as keyof typeof KINDS]
    : undefined;
  if (!observationKind || !options.accounts.length) return options;
  if (options.accounts.length > 5000) throw new Error("filter_organization_budget");
  const rows = await db
    .prepare(`WITH current AS MATERIALIZED (
    SELECT o.*,s.source_id FROM current_identity_observations o
    JOIN source_accounts s ON s.id=o.source_account_id WHERE o.kind='${observationKind}'
  ), names AS (
    SELECT c.source_id,b.source_account,min(m.label) label,count(DISTINCT m.label) labels,
    count(DISTINCT m.account_id) targets
    FROM current c JOIN ${observationKind}_observations b ON b.id=c.observation_id AND b.parse_run_id=c.parse_run_id
    JOIN current_account_mappings m ON m.source_account_id=c.source_account_id
    GROUP BY c.source_id,b.source_account
  ) SELECT source_id,source_account,label,labels,targets FROM names LIMIT 5001`)
    .all<{
      source_id: string;
      source_account: string;
      label: string;
      labels: number;
      targets: number;
    }>();
  if (rows.results.length > 5000) throw new Error("filter_organization_budget");
  const names = new Map(
    rows.results.map((row) => [JSON.stringify([row.source_id, row.source_account]), row]),
  );
  return {
    ...options,
    accounts: options.accounts.map((row) => {
      const name = names.get(JSON.stringify([row.source_id, row.source_account]));
      const ambiguous = name !== undefined && (name.labels > 1 || name.targets > 1);
      return {
        ...row,
        display_name: name && !ambiguous ? name.label : null,
        organization_ambiguous: ambiguous,
      };
    }),
  };
}

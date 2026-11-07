// Which optional reads a store can serve, decided by the tables and views it
// holds. A route and its capability flag (`/api/meta`, `kogane.capabilities`)
// ask the same question here, so a capability is never advertised for a read
// the store cannot answer, and no adapter holds a `sqlite_master` query of
// its own (ADR 0081 point 2).
import type { SqlExecutor } from "../../../read-model/src/reader.ts";

/** Each read, with every table and view it joins that an older store lacks. */
export const STORE_FEATURES = {
  /** `/api/v2/card-purchases` (CORE 0047). */
  cardPurchases: {
    tables: ["card_purchase_recognitions"],
    views: ["current_card_purchase_recognitions", "current_card_purchase_keys"],
  },
  /** Card settlement reconciliation and the ownership review. */
  cardSettlements: {
    tables: [],
    views: ["card_settlement_reviews", "card_settlement_readiness"],
  },
  /** `/api/v2/events`. */
  economicEvents: { tables: ["economic_event_revisions"], views: [] },
  /** The report artifact catalogue (CORE 0034). */
  reportArtifacts: { tables: ["report_artifacts"], views: [] },
  /** `queryDatedState`: snapshot policies, statements and settlement reviews (CORE 0044). */
  datedState: {
    tables: ["dataset_snapshot_policies"],
    views: ["card_statement_facts", "card_settlement_reviews"],
  },
} as const satisfies Record<string, { tables: readonly string[]; views: readonly string[] }>;

export type StoreFeature = keyof typeof STORE_FEATURES;

/** True only when the store holds every table and view the feature names. */
export async function storeHasFeature(sql: SqlExecutor, feature: StoreFeature): Promise<boolean> {
  const { tables, views } = STORE_FEATURES[feature];
  const marks = (names: readonly string[]) => names.map(() => "?").join(",");
  const clauses = [
    ...(tables.length ? [`(type='table' AND name IN (${marks(tables)}))`] : []),
    ...(views.length ? [`(type='view' AND name IN (${marks(views)}))`] : []),
  ];
  const row = await sql.first<{ present: number }>(
    `SELECT count(*) AS present FROM sqlite_master WHERE ${clauses.join(" OR ")}`,
    [...tables, ...views],
  );
  return row?.present === tables.length + views.length;
}

// The pass over current card usage that `queryCardPurchases` shipped before
// it classified unrecognised rows (src/query/card-purchases.ts, before the
// ADR 0004 amendment of 2026-11-06), frozen as text: the page's current keys
// and the unrecognised count. `CARD_PURCHASE_CURRENT_SQL` must return the same
// keys and the same count (card-purchase-current.test.ts). `?1`/`?2` are the
// current usage query's cursor and page size, `?3` the page's keys.
import { CURRENT_CARD_USAGE_SQL } from "../../read-model/src/card-usage.ts";

export const LEGACY_CARD_PURCHASE_CURRENT_SQL = `WITH usage AS MATERIALIZED (
  SELECT recognition_key FROM (${CURRENT_CARD_USAGE_SQL})
 )
 SELECT recognition_key AS current_key,NULL AS unrecognized FROM usage
  WHERE recognition_key IN (SELECT value FROM json_each(?3))
 UNION ALL
 SELECT NULL,count(*) FROM usage u
  WHERE u.recognition_key IS NULL
   OR NOT EXISTS(SELECT 1 FROM current_card_purchase_keys k WHERE k.recognition_key=u.recognition_key)`;

// What the debit-account candidate read must return, built from the shipped
// text (card-debit-account-candidates-legacy-sql.ts) and the acceptance
// guard's own month term, for the differential tests on random and scaled
// stores. Never import it outside tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cardSettlementReadinessCtes } from "../../read-model/src/card-settlement-readiness.ts";
import { LEGACY_CARD_DEBIT_ACCOUNT_CANDIDATES_SQL } from "./card-debit-account-candidates-legacy-sql.ts";

/**
 * The guard's month term, as migration 0044 writes it inside
 * `card_settlement_readiness.allocation_available`, with `used` an accepted
 * candidate and `c` the one judged.
 */
const GUARD_MONTH_TERM = `(json_extract(used.facts_json,'$.statement.sourceId')=json_extract(c.facts_json,'$.statement.sourceId')
    AND json_extract(used.facts_json,'$.statement.accountId')=json_extract(c.facts_json,'$.statement.accountId')
    AND json_extract(used.facts_json,'$.statement.period')=json_extract(c.facts_json,'$.statement.period'))`;
// Copied, not written: the migration's view and the keyed readiness CTEs the
// acceptance command plans with (`ready_candidate` for `c`) carry the term
// byte for byte.
if (
  !readFileSync(
    join(import.meta.dir, "../../storage-d1/migrations/core/0044_card_statement_settlements.sql"),
    "utf8",
  ).includes(GUARD_MONTH_TERM)
)
  throw new Error("the guard's month term is not migration 0044's");
if (
  !cardSettlementReadinessCtes().includes(
    GUARD_MONTH_TERM.replaceAll("c.facts_json", "ready_candidate.facts_json"),
  )
)
  throw new Error("the guard's month term is not the readiness CTEs'");

/**
 * The proposed candidates an accepted one reserves by card month, though no
 * accepted one has their statement key: the only ones the shipped text lists
 * and the new read does not.
 */
export const RESERVED_BY_MONTH_SQL = `SELECT c.id FROM card_settlement_reviews c WHERE c.status='proposed'
 AND c.statement_key NOT IN (SELECT statement_key FROM card_settlement_reviews WHERE status='accepted')
 AND EXISTS(SELECT 1 FROM card_settlement_reviews used WHERE used.status='accepted' AND used.id<>c.id
  AND ${GUARD_MONTH_TERM}) ORDER BY c.id`;

/**
 * The shipped text over the reviews less every proposed candidate the
 * guard's month term reserves: the rows the new read must return.
 */
export const EXPECTED_CARD_DEBIT_ACCOUNT_CANDIDATES_SQL =
  LEGACY_CARD_DEBIT_ACCOUNT_CANDIDATES_SQL.replace(
    "FROM card_settlement_reviews r WHERE",
    `FROM (SELECT * FROM card_settlement_reviews c WHERE NOT (c.status='proposed' AND EXISTS(
  SELECT 1 FROM card_settlement_reviews used WHERE used.status='accepted' AND used.id<>c.id
  AND ${GUARD_MONTH_TERM}))) r WHERE`,
  );
if (EXPECTED_CARD_DEBIT_ACCOUNT_CANDIDATES_SQL === LEGACY_CARD_DEBIT_ACCOUNT_CANDIDATES_SQL)
  throw new Error("the expected read did not replace the reviews");

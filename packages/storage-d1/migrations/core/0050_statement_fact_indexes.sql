-- The settlement reviews of one statement key: (source, resolved account,
-- period) as the candidate's facts state it, the key an acceptance reserves
-- (0044 `card_settlement_readiness`) and the one the card purchases page joins
-- a statement's review by (packages/application/src/query/card-purchases.ts
-- SETTLEMENT_SQL). Without it, D1's unanalyzed planner read every candidate's
-- facts three times for every statement asked for, and candidates accrue with
-- every recapture of a statement (docs/card-settlements.md, Cost). Additive:
-- no row, view or trigger changes; the expressions must match the queries'.
CREATE INDEX card_settlement_candidates_statement_period ON card_settlement_candidates(
 json_extract(facts_json,'$.statement.sourceId'),
 json_extract(facts_json,'$.statement.accountId'),
 json_extract(facts_json,'$.statement.period'));

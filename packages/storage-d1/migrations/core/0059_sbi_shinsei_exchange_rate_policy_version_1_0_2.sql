-- The SBI Shinsei exchange-rate board's snapshot policy pins the parser
-- version whose complete boards are adopted, and `required_parser_version` is
-- an exact match in the snapshot selection
-- (packages/parsers/src/snapshot-query.ts). 0056 moved it to 1.0.1, but 1.0.1
-- matched a two-digit `transactionTime` suffix no stored board carries; the
-- stored boards end in two letters, which `sbi-shinsei-exchange-rate` 1.0.2
-- accepts (ADR 0028, amended 2026-09-27). Without this row change no 1.0.2
-- board could ever become the current board.
--
-- Nothing else changes: no table, view or trigger is created or altered, and
-- no other row is touched. The UPDATE names the value 0056 wrote, so it is a
-- no-op wherever an operator has already moved the row. `updated_at_ms` is the
-- day this migration was written (2026-09-27T00:00:00Z). The 0038 trigger
-- bumps the source revision, as for any policy change.
UPDATE dataset_snapshot_policies
SET required_parser_version = '1.0.2', updated_at_ms = 1790467200000
WHERE parser_name = 'sbi-shinsei-exchange-rate' AND dataset = 'exchange-rate'
  AND required_parser_version = '1.0.1';

-- The SBI Shinsei exchange-rate board's snapshot policy names the parser
-- version whose complete boards are adopted (0053 inserted it at 1.0.0), and
-- `required_parser_version` is an exact match in the snapshot selection
-- (packages/parsers/src/snapshot-query.ts). `sbi-shinsei-exchange-rate` 1.0.1
-- accepts the stored boards' observed shape (ADR 0028), so without this row
-- change no 1.0.1 board could ever become the current board.
--
-- Nothing else changes: no table, view or trigger is created or altered, and
-- no other row is touched. The UPDATE names the value 0053 wrote, so it is a
-- no-op wherever an operator has already moved the row. `updated_at_ms` is the
-- day this migration was written (2026-09-27T00:00:00Z). The 0038 trigger
-- bumps the source revision, as for any policy change.
UPDATE dataset_snapshot_policies
SET required_parser_version = '1.0.1', updated_at_ms = 1790467200000
WHERE parser_name = 'sbi-shinsei-exchange-rate' AND dataset = 'exchange-rate'
  AND required_parser_version = '1.0.0';

-- The SBI income and realised-gains snapshot policies pin the parser version
-- whose complete parses are adopted, and `required_parser_version` is an exact
-- match in the snapshot selection (packages/parsers/src/snapshot-query.ts).
-- 0093 pinned 0.1.2. `sbi-income-payments` and `sbi-realised-gains` share one
-- version, and 0.1.3 accepts a US dividend summary whose yen gross and tax
-- totals are null (docs/sources/sbi-securities.md, 2026-11-19). Without this
-- row change no 0.1.3 parse could ever become current.
--
-- Nothing else changes: no table, view or trigger is created or altered, and
-- no other row or field is touched. The UPDATE names the value 0093 wrote, so
-- it is a no-op wherever an operator has already moved the row.
-- `updated_at_ms` is the day this migration was written (2026-11-20T00:00:00Z).
-- The 0038 trigger bumps the source revision, as for any policy change.
UPDATE dataset_snapshot_policies
SET required_parser_version = '0.1.3', updated_at_ms = 1795132800000
WHERE source_id = 'sbi-securities' AND required_parser_version = '0.1.2'
  AND (parser_name, dataset) IN (
    ('sbi-income-payments', 'income-payments'),
    ('sbi-realised-gains', 'realised-gains')
  );

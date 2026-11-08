-- The shared CSV helper releases every parser, including three whose dataset
-- policy requires an exact version. Admit the new equivalent snapshot readers
-- after the CSV recovery release; leave operator-selected alternatives alone.
-- Only operational policy rows change. Raw evidence, parse runs, observations,
-- publication history and coverage claims are untouched. The 0038 trigger
-- bumps the shared read revision as for any policy change.
UPDATE dataset_snapshot_policies
SET required_parser_version = '0.3.1', updated_at_ms = 1794096000000
WHERE parser_name = 'sbi-foreign-cash-positions' AND dataset = 'foreign-cash-positions'
  AND required_parser_version = '0.3.0';

UPDATE dataset_snapshot_policies
SET required_parser_version = '1.0.3', updated_at_ms = 1794096000000
WHERE parser_name = 'sbi-shinsei-exchange-rate' AND dataset = 'exchange-rate'
  AND required_parser_version = '1.0.2';

UPDATE dataset_snapshot_policies
SET required_parser_version = '1.0.1', updated_at_ms = 1794096000000
WHERE parser_name = 'prestia-bank-balances' AND dataset = 'prestia-bank-balance-html'
  AND required_parser_version = '1.0.0';

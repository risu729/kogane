-- A failed unfiltered cash-flow capture must not suppress a complete classic
-- account unit. Advance only the exact shipped snapshot defaults; preserve
-- nondefault operator policy, version, empty-replacement, selection and time.
-- An explicit operator choice identical to every shipped default has no
-- separate provenance and cannot be distinguished from the default itself.
UPDATE dataset_snapshot_policies SET unit_scope='unit'
WHERE source_id='sbi-vc-trade'
  AND (parser_name,dataset) IN (
    ('sbi-vc-cash-balances','cash-balances'),
    ('sbi-vc-account-margin','account-margin'),
    ('sbi-vc-position-summary','position-summary')
  )
  AND policy_id='legacy-warning-compat-v1'
  AND policy_version=1
  AND required_parser_version IS NULL
  AND replaces_previous_on_complete_empty=1
  AND unit_scope='run' AND snapshot_selection=1 AND updated_at_ms=0;

-- Exactly the existing collector's one recent execution page and its two
-- historical page chains, each capped at 100. These 201 rows enable unit
-- eligibility only; they never enroll transactions in snapshot selection.
WITH RECURSIVE pages(n) AS (
  SELECT 1 UNION ALL SELECT n+1 FROM pages WHERE n<100
), classic(dataset,parser_name) AS (
  SELECT 'executions-recent-page-0001','sbi-vc-executions'
  UNION ALL SELECT printf('executions-historical-page-%04d',n),'sbi-vc-executions' FROM pages
  UNION ALL SELECT printf('cashflows-historical-page-%04d',n),'sbi-vc-cashflows' FROM pages
)
INSERT OR IGNORE INTO dataset_snapshot_policies (
  source_id,dataset,parser_name,policy_id,required_parser_version,
  replaces_previous_on_complete_empty,unit_scope,snapshot_selection
)
SELECT 'sbi-vc-trade',dataset,parser_name,'legacy-warning-compat-v1',NULL,0,'unit',0
FROM classic;

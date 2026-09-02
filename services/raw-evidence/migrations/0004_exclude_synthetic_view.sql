-- Dedicated production-verification runs are operational evidence, not
-- financial-source runs. 0003 already excludes older synthetic sessions that
-- were recorded under a financial source; this migration also excludes the
-- dedicated synthetic source itself.
DROP VIEW financial_fetch_runs;

CREATE VIEW financial_fetch_runs AS
SELECT run.* FROM fetch_runs AS run
WHERE run.source_id <> 'kogane-synthetic'
  AND NOT EXISTS (
    SELECT 1 FROM fetch_run_annotations AS annotation
    WHERE annotation.fetch_run_id = run.id
      AND annotation.annotation_kind = 'exclude_from_financial_views'
  );

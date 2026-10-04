-- Snapshot-only PRESTIA bank evidence; no history or inferred empty replacement.
INSERT INTO dataset_snapshot_policies(source_id,dataset,parser_name,policy_id,required_parser_version,replaces_previous_on_complete_empty,unit_scope)
VALUES('prestia','prestia-bank-balance-html','prestia-bank-balances','coverage-v1','1.0.0',0,'run');

-- Processor-managed alarm stays disabled until first production verification.
INSERT INTO collection_schedules(id,source,kind,enabled,supported,timezone,pattern_json,updated_at,updated_by)
VALUES('prestia-bank','prestia-bank','collection',0,1,'Asia/Tokyo','{"kind":"daily","time":"06:30","weekdays":[0,1,2,3,4,5,6]}','2026-10-05T00:00:00.000Z','migration:0066');
INSERT INTO collection_schedule_revisions(schedule_id,revision,enabled,timezone,pattern_json,actor,created_at)
SELECT id,revision,enabled,timezone,pattern_json,updated_by,updated_at FROM collection_schedules WHERE id='prestia-bank';
-- No maintenance provenance is invented; an absent reference remains unknown.

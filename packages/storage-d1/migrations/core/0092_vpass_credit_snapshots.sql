-- Independent card snapshot runs; exact debt precision beyond reported authori units remains unsupported.
INSERT INTO dataset_snapshot_policies
 (source_id,dataset,parser_name,policy_id,policy_version,required_parser_version,
  replaces_previous_on_complete_empty,unit_scope,updated_at_ms,snapshot_selection)
VALUES ('vpass','credit-snapshot','vpass-credit-snapshot','coverage-v1',1,'1.0.1',0,'unit',1794268800000,1);

-- New independently sealed statement units. This adds parse eligibility only:
-- retained month pages are event evidence, not one replaceable snapshot.
-- Existing credit/J-POINT policies, publications and adopted state stay intact.
INSERT INTO dataset_snapshot_policies
 (source_id,dataset,parser_name,policy_id,policy_version,required_parser_version,
  replaces_previous_on_complete_empty,unit_scope,updated_at_ms,snapshot_selection)
VALUES
 ('myjcb','debit-detail','myjcb-debit-ledger','legacy-warning-compat-v1',1,NULL,1,'unit',1794268800000,0),
 ('myjcb','debit-other-detail','myjcb-debit-other-statement','legacy-warning-compat-v1',1,NULL,1,'unit',1794268800000,0);

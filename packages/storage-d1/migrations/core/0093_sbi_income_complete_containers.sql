-- Fixed since-2021-08 full-retention containers, not a union of payment identities.
-- Corrected/removed rows retire from current membership; evidence stays append-only.
-- Also used by additive local bootstrap; existing operator choices survive.
INSERT OR IGNORE INTO dataset_snapshot_policies
 (source_id,dataset,parser_name,policy_id,policy_version,required_parser_version,
  replaces_previous_on_complete_empty,unit_scope,updated_at_ms,snapshot_selection)
VALUES
 ('sbi-securities','income-payments','sbi-income-payments','coverage-v1',1,'0.1.2',1,'run',1794268800000,1),
 ('sbi-securities','realised-gains','sbi-realised-gains','coverage-v1',1,'0.1.2',1,'run',1794268800000,1);

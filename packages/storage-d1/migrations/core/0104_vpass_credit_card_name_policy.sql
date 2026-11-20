-- ADR 0120: reader 1.1.0 keeps the card's product name (`extra._kogane.cardName`)
-- beside the same observations 1.0.2 writes, for the read-time account label.
-- Membership pins the reader version exactly, so the shipped default advances
-- with it; every operator choice is retained, as in 0102.
UPDATE dataset_snapshot_policies
SET required_parser_version='1.1.0', updated_at_ms=1795132800000
WHERE source_id='vpass' AND dataset='credit-snapshot'
  AND parser_name='vpass-credit-snapshot' AND policy_id='coverage-v1'
  AND policy_version=1 AND required_parser_version='1.0.2'
  AND replaces_previous_on_complete_empty=0 AND unit_scope='unit'
  AND snapshot_selection=1 AND updated_at_ms=1794441600000;

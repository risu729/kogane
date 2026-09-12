-- The App and Processor must already run the READ-only projection release.
-- These are derived caches, not canonical facts or captured projection inputs.
DROP TABLE balance_snapshot_pointer;
DROP TABLE current_balance_projection;
DROP TABLE scope_relations;
DROP TABLE balance_read_snapshots;
DROP TABLE expiry_estimates;
DROP TABLE conversion_simulations;

-- Preserve historical foreign keys while revoking the retired HTTP importer clients.
UPDATE ingest_clients SET active=0 WHERE id IN (
  'collector-r2-global-pass',
  'collector-r2-mobile-suica',
  'collector-r2-moneyforward',
  'collector-r2-myjcb',
  'collector-r2-sbi',
  'collector-r2-sbi-shinsei',
  'collector-r2-sbi-vc',
  'collector-r2-smbc-direct',
  'collector-r2-sony-bank',
  'collector-r2-v-point',
  'collector-r2-v-point-pay-email',
  'collector-r2-vpass'
);

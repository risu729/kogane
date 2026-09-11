-- Initial source registry derived from docs/sources. A source being active only
-- means that evidence may be catalogued; it does not claim that unattended
-- collection is implemented.
INSERT INTO sources (id, provider, display_name) VALUES
  ('airwallet', 'Recruit', 'Airwallet'),
  ('amazon', 'Amazon', 'Amazon'),
  ('ana', 'ANA', 'ANA'),
  ('au-pay', 'KDDI', 'au PAY'),
  ('bank-of-kyoto', 'Bank of Kyoto', 'Bank of Kyoto'),
  ('epos', 'EPOS', 'EPOS Card'),
  ('global-pass', 'SMBC Trust Bank', 'GLOBAL PASS'),
  ('j-coin-pay', 'Mizuho Bank', 'J-Coin Pay'),
  ('jal', 'JAL', 'JAL'),
  ('jp-bank-card', 'Japan Post Bank', 'JP BANK Card'),
  ('mercari-family', 'Mercari', 'Mercari family'),
  ('minna-bank', 'Minna Bank', 'Minna Bank'),
  ('mizuho-bank', 'Mizuho Bank', 'Mizuho Bank'),
  ('mobile-suica', 'JR East', 'Mobile Suica'),
  ('mufg-bank', 'MUFG Bank', 'MUFG Bank'),
  ('mufg-card', 'Mitsubishi UFJ NICOS', 'MUFG Card'),
  ('myjcb', 'JCB', 'MyJCB'),
  ('opal', 'Transport for NSW', 'Opal'),
  ('paypay', 'PayPay', 'PayPay'),
  ('prestia', 'SMBC Trust Bank', 'PRESTIA'),
  ('rakuten', 'Rakuten', 'Rakuten'),
  ('sbi-securities', 'SBI Securities', 'SBI Securities'),
  ('sbi-shinsei-bank', 'SBI Shinsei Bank', 'SBI Shinsei Bank'),
  ('sbi-vc-trade', 'SBI VC Trade', 'SBI VC Trade'),
  ('smart-ex', 'JR Central', 'Smart EX'),
  ('smbc-bank', 'SMBC', 'SMBC Direct'),
  ('sony-bank', 'Sony Bank', 'Sony Bank'),
  ('st-george', 'St.George Bank', 'St.George Bank'),
  ('sumishin-sbi-bank', 'Sumishin SBI Net Bank', 'Sumishin SBI Net Bank'),
  ('v-point', 'CCCMK Holdings', 'V Point'),
  ('v-point-pay', 'SMBC Card', 'V Point Pay'),
  ('vpass', 'SMBC Card', 'Vpass'),
  ('wester', 'JR West', 'WESTER'),
  ('westpac', 'Westpac', 'Westpac'),
  ('wise', 'Wise', 'Wise'),
  ('yucho-bank', 'Japan Post Bank', 'Yucho Direct');

-- These describe acquisition mechanisms, not financial providers. Keeping
-- them separate allows one capture session to contain several sources and
-- preserves how bytes reached the central store.
INSERT INTO producers (id, kind, display_name) VALUES
  ('collector-r2-importer', 'importer', 'Collector R2 importer'),
  ('kuebiko-importer', 'importer', 'Kuebiko capture importer'),
  ('local-file-importer', 'importer', 'Local file importer');

INSERT INTO producer_sources (producer_id, source_id)
SELECT producer.id, source.id
FROM producers AS producer CROSS JOIN sources AS source
WHERE producer.id IN (
  'collector-r2-importer', 'kuebiko-importer', 'local-file-importer'
);

INSERT INTO ingest_clients (id, display_name)
VALUES ('local-backfill', 'Local backfill client');

INSERT INTO ingest_client_producers (ingest_client_id, producer_id)
SELECT 'local-backfill', id FROM producers
WHERE id IN ('collector-r2-importer', 'kuebiko-importer', 'local-file-importer');

INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id)
SELECT 'local-backfill', producer_id, source_id
FROM producer_sources
WHERE producer_id IN (
  'collector-r2-importer', 'kuebiko-importer', 'local-file-importer'
);

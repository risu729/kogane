import { expect } from "bun:test";

// Independently pinned ADR 0109 delta (and its 2026-11-19 SBI Shinsei amendment). Native SBI snapshot compatibility tests
// prove its legacy/successor semantics; historical SQL oracles use this exact
// clause only to recover their original text and keep every other byte frozen.
const SBI_LEGACY_SNAPSHOT_PARTITION = `CASE
    WHEN source_id = 'sbi-securities' AND fetch_unit_key = 'domestic'
      AND parser_name = 'sbi-income-payments' AND dataset = 'income-payments'
      THEN 'income-history-income'
    WHEN source_id = 'sbi-securities' AND fetch_unit_key = 'domestic'
      AND parser_name = 'sbi-realised-gains' AND dataset = 'realised-gains'
      THEN 'income-history-gains'
    WHEN source_id = 'sbi-shinsei-bank' AND fetch_unit_key = 'primary'
      AND ((parser_name = 'sbi-shinsei-top-balances-and-activity'
            AND dataset = 'top-accounts-balance-and-activity')
        OR (parser_name = 'sbi-shinsei-yen-deposit-account' AND dataset = 'yen-deposit-account')
        OR (parser_name = 'sbi-shinsei-exchange-rate' AND dataset = 'exchange-rate'))
      THEN NULL
    ELSE fetch_unit_key END`;

export function withoutSbiLegacySnapshotPartition(sql: string, expectedOccurrences = 1): string {
  expect(sql.split(SBI_LEGACY_SNAPSHOT_PARTITION)).toHaveLength(expectedOccurrences + 1);
  return sql.replaceAll(SBI_LEGACY_SNAPSHOT_PARTITION, "fetch_unit_key");
}

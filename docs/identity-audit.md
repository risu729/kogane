# Production identity audit

Run `node --experimental-strip-types services/observation-pipeline/scripts/audit-identity-store.ts` from the repository root with the existing authenticated Wrangler diagnostic environment. This uses the existing remote D1 binding and performs only SELECT queries in one batch; it does not trigger collection, interpretation, deployment, or revision.

Output contains aggregate counts grouped by source and observation form, current account and instrument status, allowlisted issue categories, integrity checks, and current/historical pending parse counts. Unknown issue text becomes `other` inside SQL. No account identifiers, instrument identifiers, names, monetary values, or raw payloads are selected for output. Errors use fixed safe codes. The report remains in the terminal; the script does not save it to the repository.

Coverage counts eligible, successful, unsuperseded Layer B observations and completed current Layer C interpretations. The four forms are transactions, balances, positions, and valuations. Instrument status counts represent instrument uses, not distinct securities. Status claims come from current mappings, including manual revisions. Pending parse counts include successful historical parses separately, including empty parses.

While backfill is running, pending counts and incomplete coverage are progress indicators. Re-run after the operator confirms catch-up completion before deciding whether work is outstanding. Integrity counters should be zero; a nonzero counter requires investigation. The report does not establish asset completeness, deduplication, global instrument equivalence, or portfolio totals.

## Recorded SBI checkpoint

The live read-only D1 snapshot at `2026-09-08T01:09:45.787Z`, after the SBI catch-up command reached `processedRuns=0`, showed 12,027 eligible SBI observations and 12,027 current interpretations: 1,102 balances, 1,226 positions, 1,377 transactions, and 8,322 valuations. All 382 eligible current parses and 22 eligible historical parses were complete. The seven integrity counters in that snapshot were zero; the later eighth check additionally compares seal counts with Layer B evidence counts. Other sources were still being processed, so this checkpoint does not claim completion across all sources. The snapshot is historical evidence and must not substitute for the final live audit.

# PRESTIA bank Worker integration

- Status: implementation in progress; production deployment/verification pending
- Date: 2026-10-05
- Decision: [ADR 0040](../adr/0040-prestia-bank-worker.md)

## Implemented scope

The separate bank source registers a sanitized, structurally recognized account
summary as snapshot evidence. Native available amounts and term principal retain
their currencies; bank yen equivalents remain group aggregates. Three provider
monthly averages retain qualification/period metadata and calculation notes,
without guessing an unstated calendar range or treating them as income.
All these metrics remain non-additive. Provider yen totals and monthly averages
are accessible through artifact parse-run references and valuation observation
details, not silently added to the native balance screen or invented positions.

The shared-R2 route, explicit snapshot policy, source identity/authority,
deployment ordering and Processor RPC binding are integrated. The 06:30 JST
alarm is disabled and no Worker Cron is configured. The portable client has local
authenticated balance-page evidence, not deployed-runtime proof.

## Remaining gates

1. Finish synthetic/Worker tests, generated ledgers, full repository checks and
   fresh independent review.
2. Merge the new integration PR; the historical app-research PoC PR is separate.
3. Apply additive migration and ingest bootstrap, deploy the exact release and
   verify version allocation/health.
4. Verify one authorized production collection plus registration, complete parse
   coverage and published read-model counts/shapes, without copying financial
   values into repository material.
5. Only after that evidence, separately enable the Processor-managed alarm and
   verify its schedule reservation. Until then the seeded schedule stays disabled.

## Limits

No transaction history, automatic OTP submission, row-level FX allocation,
net-asset summation or qualification-income inference is included. Missing or
partial evidence is a reason, never zero. Maintenance provenance is not yet
reviewed; absent metadata is not a claim that maintenance does not exist.

# Identity catalogue query performance

The original instrument query joined the eligible Layer B union back onto
`current_identity_observations`, although that view already applies the same
eligibility rules. Full-schema SQLite EXPLAIN exposed an outer identifier scan
followed by an artifact scan before matching instrument uses. A production
read-only request hit the D1 CPU limit after 33.7 seconds; it was not retried.

The query now materializes canonical current identity observations once, then
materializes per-account or per-identifier/source counts before joining current
mapping metadata. Source-account source IDs are safe here because immutable
identity-observation provenance requires them to match the parse artifact.
Instrument counts remain distinct per observation, even when the same identifier
appears in multiple roles. Mapping revisions are resolved after aggregation, not
replaced by the old pinned revision. Sorting and source filtering still precede
the public 100-row page boundary (101 rows are queried to detect continuation).

Coverage alone retains the Layer B union denominator, including unprocessed
records, and joins it to one materialized current projection. Canonical seals,
parse supersession, source/run exclusions and trusted Vpass binding eligibility
remain owned by the existing views. PR #131 added no indexes or migrations: the
revised plan no longer needs an identifier-led index to rescue its join order.

The local full-migration D1 regression fixture has 35,000 observations across
12 sources and all four kinds, repeated roles, a newer policy projection and
manual mapping corrections. All five instrument pages completed in 67–78 ms
in one local run; these are local measurements, not a production latency claim.
Tests verify 432 identifier/source groups count exactly 35,000 observations,
source-specific pagination, coverage totals, exclusions, and the materialization
plan shape. Production latency must be measured separately after review.

## Many-run regression and production acceptance

That first fixture had only 12 parse runs. After the full historical catchup,
the production account query still exceeded D1's CPU limit after 35,029 ms.
The core current-identity view alone selected terminal reports followed by all
successful parses; API metadata joins were not necessary to trigger the bad plan.

PR #133 / migration `0022_identity_current_run_plan.sql` materializes eligible,
sealed candidates once per current parse, selects the latest numeric policy,
then expands observations. Keyed join order prevents acquisition reports from
multiplying all successful parses. The writer's `eligible_identity_runs` view
remains flattenable for keyed checkpoints. No identity rows, raw evidence,
manual mappings, indexes or provenance guards are changed.

The additional guarded fixture has 6,000 parses, 35,000 observations, 2,692
policy-2 pins, 96 sidecars and six card tokens. An independent run measured
core 103 ms, accounts 127 ms, instruments 191 ms and coverage 287 ms. Tests also
cover unsealed newer policy, revoked-sidecar fallback, supersession and exclusion.
The integration test containing ten provenance scenarios now has an explicit
30-second budget; the previous five-second CI timeout terminated its shared
Miniflare instance and caused cascading connection failures.

After applying 0022 to production on 2026-09-08, the actual read-only API handler
against the existing remote D1 binding returned valid HTTP 200 responses for
accounts (67 rows, 1,171 ms), instruments (first 100 rows, 772 ms), and coverage
(12 sources, 844 ms). These wall times include proxy/network overhead and are
not D1 CPU measurements. The deployed protected UI subsequently rendered both
account and instrument lists. Full audit results and scope limits are recorded
in [identity-rollout.md](identity-rollout.md).

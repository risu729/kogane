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
remain owned by the existing views. No indexes or migrations were added: the
revised plan no longer needs an identifier-led index to rescue its join order.

The local full-migration D1 regression fixture has 35,000 observations across
12 sources and all four kinds, repeated roles, a newer policy projection and
manual mapping corrections. All five instrument pages completed in 67–78 ms
in one local run; these are local measurements, not a production latency claim.
Tests verify 432 identifier/source groups count exactly 35,000 observations,
source-specific pagination, coverage totals, exclusions, and the materialization
plan shape. Production latency must be measured separately after review.

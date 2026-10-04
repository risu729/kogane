# ADR 0033: Avoid repeated historical reads in processor maintenance

- Status: proposed until this PR merges; accepted upon merge
- Date: 2026-10-04

## Context

Every balance projection invocation captured three historical candidate sets
before discovering that the published content was unchanged. CORE already has
transactional source and visibility revision triggers, but the writer used
them only to bracket a capture. Parser job retirement also let SQLite drive
its replacement join from completed jobs, repeatedly visiting historical
parses even when almost no job could be retired.

## Options considered

1. Reduce cron frequency or disable lanes: this delays new evidence and was
   rejected.
2. Cache by maximum parse ID or elapsed time: this misses decisions,
   restrictions and replacements and was rejected.
3. Reuse the existing revision contract and make retirement candidate-driven.

## Decision

Before a new balance capture, after prioritizing any unfinished build, read
CORE's source revision, visibility revision and epoch. A complete published
READ snapshot may return unchanged only when its pointer matches that exact
tuple, both pointer and snapshot belong to the current READ instance, the
output digests agree, and the build digest, input contract, identity release
and decimal policy release match. Read the CORE tuple again before returning;
a concurrent write falls back to the existing stable-capture protocol.

Use the pointer's context watermark, which can advance after a no-content
change, rather than requiring equality with the immutable snapshot's original
source revision, visibility revision or epoch. The optimization does not update either database or skip an
unfinished build. The existing capture test hook continues to request a full
capture explicitly.

For job retirement, materialize eligible candidate keys and enforce a keyed
replacement lookup after those candidates. Artifact-specific calls use a
direct artifact predicate. Keep the registry, semver validation, terminal
parse evidence, lease conditions and update unchanged. No migration is needed.

## Consequences

Quiet projection ticks read a constant number of metadata rows instead of
historical observations. A source revision change still pays for a full
capture even when it eventually yields the same content. The revision ledger
remains a correctness dependency; new projection inputs must be represented
there, and code/release changes must advance the existing build identity.

Retirement still examines pending/failed/expired candidates during a global
maintenance pass, including retained failed jobs, but no longer starts from
every completed job. This change does not optimize identity sweeps,
reconciliation, or card-settlement scans. Historical billing is unaffected;
production savings depend on the amount of new input and must be measured
after deployment.

## Verification

- Production-schema projection integration tests prove that an unchanged
  tick prepares only the two CORE revision reads, while new evidence, changed
  build identity, and a concurrent CORE write still capture.
- Existing tests cover restrictions, decisions, retries, leases, resumed
  builds, retired snapshots, outbox completion and READ database replacement.
- Frozen pre-change retirement SQL is compared against the new statements on
  scaled deterministic random stores, with the production schema and indexes.
  All job columns and immutable parse evidence are compared.
- EXPLAIN QUERY PLAN tests run without ANALYZE and require candidate
  materialization, full replacement key lookup, keyed parse evidence, and an
  artifact-key lookup for artifact-specific calls.
- With 2,000 completed synthetic jobs and one new retirement candidate, the
  D1 test reads 10,070 rows with the old statement, 39 with the new global
  statement, and 12 with the artifact-specific statement. These are synthetic
  workload measurements, not a forecast of production billing.

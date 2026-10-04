# ADR 0035: Bound identity view expansion and skip unchanged reward capture

- Status: proposed until this PR merges; accepted upon merge
- Date: 2026-10-04

## Context

Identity candidate selection joined successful parse history through acquisition
views before excluding already completed identities. Reward READ captured its
claims, rules, memberships and offers before discovering that the current
published snapshot still represented the same inputs and evaluation day.

## Options considered

1. Reduce lane frequency: delays newly available evidence and was rejected.
2. Skip by highest parse ID or elapsed time: misses late publication, trusted
   bindings and policy upgrades and was rejected.
3. Keep eligibility semantics, reorder candidate work, and reuse the existing
   CORE revision contract for reward READ, as balance READ does in ADR 0033.

## Decision

Join each raw artifact through one acquisition eligibility view, removing
redundant view joins that restate the same run. Read the highest sealed identity
policy for each parse. A policy at or above the highest version the current
build can require is already complete, without consulting trusted Vpass
binding evidence again. Lower sealed versions still compare against the
source's current required policy. Parses without a sealed identity remain eligible.

Retain every acquisition eligibility check, published-first priority, source
filter and page limit. Materialize the bounded page, then check its four
observation kinds for emptiness. Source-scoped sweeps use a direct predicate.
There is no new cursor, queue, migration, or evidence mutation.

For reward READ, unfinished builds retain priority. Before fresh capture, reuse
only a complete published snapshot whose pointer matches CORE source revision,
visibility revision and epoch; whose pointer and snapshot belong to this READ
instance; whose output digest matches the pointer; and whose build, contract,
calendar, claim promotion release, policy release and UTC evaluation day match.
Compare CORE revisions again, and check the UTC day again, before returning.
A race or mismatch falls back to the existing stable capture protocol. The
capture test hook continues to explicitly request capture.

Use the pointer context watermark instead of the immutable snapshot's original
revision tuple: a capture producing identical content can advance the pointer
context without changing the stored snapshot. No lease, seal or pointer-write
rules change.

## Consequences

Identity selection still examines parse history, including identities requiring
new policy evidence, but sealed current-policy history avoids trusted-binding
lookups and eligible candidates avoid redundant acquisition-view expansion. This is a query cost reduction, not a claim of constant-time sweeps.

Quiet reward ticks read only metadata in CORE. A new UTC day, input revision,
release, build or READ instance requires capture. The source revision ledger
remains a correctness dependency for all reward inputs. Historical billing is
unaffected; production savings depend on workload and require later measurement.
Card settlement and reconciliation algorithms are outside this change.

## Verification

- Frozen pre-change SQL is compared field-for-field and in order on full
  production schema stores with 50, 300 and 2,000 synthetic rows, deterministic
  random variation, source filters and several page limits.
- Fixtures include successful and failed parses/acquisitions, unsealed and
  excluded runs, publication priority, empty and nonempty parses, completed
  identities and Mizuho policy upgrades. Existing integration tests retain
  trusted Vpass late-binding and bounded identity processing coverage. Frozen
  SQL is also compared before and after a late trusted binding; after sealing
  policy 2, that synthetic candidate lookup falls from 56 D1 rows read to 7.
- Query plans without ANALYZE require a materialized page and keyed
  identity/observation lookups. A full-schema D1 test compares results and
  measured rows read against the frozen SQL. With 500 mixed synthetic parses,
  global reads fall from 2,102 to 1,965 and Vpass-scoped reads from 1,282 to
  1,175; Mizuho-scoped reads rise slightly from 1,302 to 1,307. Tests bound that
  scoped overhead to one page rather than claiming every workload improves.
- Reward tests prove same-day capture avoidance, next-day and concurrent-write
  fallback, UTC midnight rollover, context/release mismatch refusal, refreshed
  pointer reuse, and unfinished-build priority.

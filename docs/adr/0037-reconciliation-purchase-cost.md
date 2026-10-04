# ADR 0037: Admit reconciliation pages by evidence and reuse clean purchase retirement checks

- Status: proposed until this PR merges; accepted upon merge
- Date: 2026-10-04

## Context

The deployed reconciliation slices run stage A only, but their parsers emit
collector fingerprints. Every tick selected a page of those rows before
finding that no row could pair. Disabling the source would also disable
historical, custom or future provider-issued identifiers.

The purchase retirement pass materialized the whole current card usage set
on every tick, even after proving that no live key was stale. Recognition
and candidates still need their bounded page every tick: unfinished work,
late publication and rows below the cursor must continue to progress.

## Options considered

1. Disable reconciliation for Vpass/MyJCB or trust today's parser capability:
   rejected because stored and future provider-id evidence is still admitted.
2. Filter the stage-A page without an index: still walks fingerprint history
   on an empty page, so it does not solve the fruitless scan.
3. Skip retirement by time, maximum id or row count: rejected because adopted
   low-id pointers, mapping decisions and restrictions can change with the
   same maximum and counts; unfinished retirements need another attempt.
4. Reuse CORE source revision alone: its ledger intentionally excludes several
   current-usage dependencies and recognition output. Broadening that ledger
   would also change the balance projection contract and add rebuilds.
5. Index actual stage-A admission and keep a narrow operational clean proof,
   listening to the existing CORE revision and the remaining read dependencies.

## Decision

Migration 0064 adds a partial index on transaction observation ids under the
exact existing provider-origin predicate: non-null external id and a bounded
text `identityOrigin` containing neither `fingerprint` nor `occurrence`.
Stage-A-only pages start in that index. Stage B retains the shipped page SQL.
A touched group's count and complete row read are unchanged, so fingerprint
members still count toward the group bound. The cursor still wraps and retries
existing proposals with the same digest, budgets and matching rules.

The same migration adds `card_purchase_retirement_check`, an operational
singleton holding a revision, the last checking revision, and a clean revision
with its contract release. A clean proof lets only the retirement pass skip its
unchanged shipped stale-key query. Recognition and candidates always run.
A dirty pass arms `checking_revision` before reading. Only an empty stale-key
result may record `clean_revision`, conditional on the revision still matching.
A full, partial, failed, conflicting or deferred page never records clean.
The code release must change when retirement selection semantics change.

Input mutations invalidate the proof in the same transaction. Publication,
identity, decimal, decision and restriction changes, and CORE epoch updates,
reuse the existing `core_source_revision` through one update listener. Direct
triggers cover the remaining dependencies identified by the stale query's
SQLite bytecode, including recognition keys, sidecars and live event revisions.
They conservatively cover mutations from other sources too. Once a clean or
checking revision has been invalidated, later mutations in that dirty interval
make no further singleton writes until another check arms a new revision.
This latch prevents a new counter write for every observation of a capture.
No evidence or adopted state is rewritten; the original retirement write
guards still apply.

## Consequences

A globally empty provider-origin index reads no observation page. A source
with no eligible provider ids can still walk provider-origin index entries
from other sources or unsupported statuses before returning its empty page;
this index is ordered by observation id, not partitioned by source. The
`scanned` result counts returned fact rows, not SQLite/D1 rows read. Provider-id
history, custom sources and future capability transitions continue automatically.
Per-tick page composition and scanned counts change; a complete cycle's
proposals and stored history remain the same. Group bounds remain conservative.

An unchanged clean purchase tick uses one singleton primary-key read for its
retirement check. Changed ticks add the marker reads/writes and execute the
same stale query. Recognition still recomputes its current page; this does not
claim that the whole purchase lane is constant-cost. Conservative unrelated
CORE mutations can force another retirement read. A mutation overlapping the
read leaves the proof dirty, and overlapping checks cannot certify an old
revision after that mutation. Losing the marker's proof is safe: clear
`clean_revision` to recompute. New read dependencies must be covered by the
invalidation closure; a test enforces this from the complete schema's bytecode.

## Verification

- `reconciliation-page-legacy-sql.ts` freezes the shipped page from c7c36d66.
  Random full-schema stores compare admitted pages with that text filtered by
  the existing fact origin, and compare full-cycle stored proposals under
  bounded pages, group reads and a one-proposal write budget. Malformed,
  missing, non-text, overlong and collector origins, duplicate provider ids,
  an over-limit mixed-origin group, provider-origin rows from another source,
  and unsupported statuses participate. Stage B retains the exact shipped SQL.
- Full-schema scaled stores use every CORE migration, foreign keys and no
  `ANALYZE`. Plans assert the provider-id partial index and the retirement
  singleton primary-key lookup. The index predicate is compared to the code.
- On the synthetic CI-scale store of 3,407 observations, ten stage-A page
  reads took 106.4 ms for the shipped page (10,000 rows returned) and 7.3 ms
  for the indexed page (zero admitted rows). Ten empty stale-key reads took
  333.6 ms; ten clean marker reads took 0.033 ms. These are local SQLite
  measurements, not production D1 billing or a whole-tick benchmark.
  A separate mixed-index measurement added 4,000 provider-origin bank rows
  and 200 Vpass rows with unsupported statuses: ten empty Vpass pages took
  13.4 ms, versus 100.3 ms for ten shipped pages on the same base store. This
  exercises remaining index-entry work and does not claim it is constant.
- Retirement tests derive all base read dependencies from `EXPLAIN` root
  pages and assert trigger coverage via direct invalidation or the existing
  source revision ledger. They exercise low-id publication updates, epoch
  and contract changes, overlapping readers plus mutation, dirty-write
  latching, deferred pages, failed batches and continued recognition.
- Existing purchase tests retain late low-id publication, bounded deferral,
  repeated failure, merged-key retirement and guarded overlapping writes.

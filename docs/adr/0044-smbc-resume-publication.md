# ADR 0044: SMBC backfill continuation publication

Status: accepted (merged 2026-10-09 in #562)
Date: 2026-10-09

## Context

SMBC backfills can need a new human-approved authentication session before all
month chunks finish. The collector keeps one cumulative staging run, but publishes
an immutable terminal when a session ends partial. Reusing that terminal identity
after resuming conflicts with the earlier digest; the UI previously showed bank
acquisition success even when shared publication failed.

CORE parses clean successful runs by default. A partial SMBC run also reports its
single account unit partial or failed, so even unit-scoped eligibility cannot
parse its captured chunks. Publishing only later chunks on final success would
therefore omit the earlier months from observations.

## Options considered

- Overwrite the partial terminal: violates append-only evidence.
- Exclude every artifact already catalogued: loses chunks from earlier partial
  runs that CORE never parsed.
- Keep partial terminals and publish a complete success snapshot, excluding only
  earlier successful evidence: preserves history and exposes the full acquisition.

## Decision

Keep the cumulative backfill ID and staging progress. The initial publication
retains that ID. Subsequent publications read the initial terminal and a bounded
list of its continuations. Partial continuations publish newly captured evidence.
The final successful continuation includes artifacts from earlier partial
terminals, because their runs and account units are not parseable. Only artifacts
already catalogued in clean successful complete runs are excluded from success.
No parser policy or adopted financial state changes.

Previously published normalized artifacts must remain present with unchanged
hashes. A raw-only chunk may supply the raw input of a later normalization again.
Continuation and attempt IDs derive from the exact cumulative manifest digest.
Successful publication validates complete normalized monthly coverage of its
declared range.

Partial segments refer to the current approved session generation; the cumulative
success snapshot retains the original backfill session generation because it
contains evidence acquired across sessions. Its prior-terminal references retain
the segment lineage. Each continuation attaches a segment manifest and the exact
cumulative collector manifest as separate non-unit artifacts.

A changed failure snapshot with no new provider bytes gets a manifest-only failed
continuation; an exact snapshot retry is a no-op. The processor records such
attempts with `provider_run_failed` and does not seal or parse them, preserving
failure evidence without claiming an empty account.

An Access-protected, same-origin empty-body action retries publication from saved
staging data. It does not log in, generate a QR or fetch the bank. The UI
distinguishes bank acquisition, shared publication and pending central analysis.

## Consequences

Partial terminals remain immutable and ineligible for observation jobs. Their
content-addressed raw objects are reused in the later successful inventory.
There is one eligible normalized artifact per captured month, despite earlier
partial catalog entries. Corrupt prior terminals, lost or changed normalization,
missing raw parents, incomplete successful coverage or excess continuation
inventory refuse publication rather than rewriting history.

A staging manifest remains operational progress; content-addressed snapshots
attached to terminals preserve each published revision.

## Verification

Workers-runtime R2 tests cover a legacy partial followed by multiple approved
sessions, preservation of the initial terminal, full successful scope, session
provenance, verified objects, parser dataset eligibility, all months present once
in eligible successful inventories, idempotence, normalization drift, raw-only
recovery and changed failure snapshots. The existing CORE run/unit eligibility
predicate and unit-report derivation establish why partial SMBC catalogs are
ineligible, without introducing a policy exception. A processor integration test
uses migrated CORE/READ databases and R2 to register the partial and full runs,
parse both earlier and later months plus balance with account context, and prove
that publication and registration retries create no duplicate parses or rows.

## Amendment 2026-11-08: closed JST days and frozen resume windows

Status: proposed
Owner decision: 2026-11-08 13:26 UTC, [issue 1178](https://github.com/risu729/kogane/issues/1178).

Fresh backfills end on the last finished JST day at approval. Resumes keep the
stored window and completed chunks regardless of the new approval date or the
current default start. Extending the window in place could change the final
month chunk's range and invalidate already published normalized evidence; the
next fresh backfill advances the end instead.

Pre-change progress is resumed without rewriting its window. If the last chunk
still ends on an open day, its alarm waits for JST midnight before requesting
that chunk. Request-start timestamps on transaction artifacts establish that
their declared days had closed before acquisition. Legacy artifacts use the
run start as a conservative lower bound. An old success that read an open day
publishes partial coverage with `coverage_day_not_finished`; waiting longer or
retrying publication cannot upgrade that acquisition. Existing terminals and
provider bytes remain immutable. A fresh complete backfill recovers coverage.

Fixed-clock tests cover 10:00 JST approval, the next day's fresh window, later
approval of modern and legacy stopped runs, midnight deferral, and publication
of old open-day successes. The unchanged R2 continuation tests continue to
verify immutable history and parser eligibility using chronologically valid
synthetic acquisition times.

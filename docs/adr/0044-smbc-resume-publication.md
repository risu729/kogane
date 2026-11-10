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

## Amendment 2026-11-08: logout after complete collection

Status: accepted (merged 2026-11-08 in [#1185](https://github.com/risu729/kogane/pull/1185))
Owner decision: 2026-11-08 13:26 UTC

A provider logout or sign-off failure after all planned units were acquired and
stored is cleanup metadata, never a coverage gap. Complete SMBC backfills remain
successful and their account units remain eligible for parsing. The existing
`logoutSucceeded` state is retained across publication retries; the failure
cleanup path before completion keeps its existing outcome and failure codes.
Independent coverage refusals still apply: a legacy open-day success retains
`coverage_day_not_finished` even when the same terminal flags a failed logout.

The uniform collector policy and complete collector audit live in
[collection](../collection.md#logout-audit-2026-11-08). Reuse the existing
`terminal-v1` auxiliary run report rather than add a manifest version or attach a
failure code to a successful run/unit: `reportRef: logout`, `reportKind: logout`,
`scope: run`, `outcome: failed`, `safeErrorCode: logout_failed`. The failed report
describes sign-off only. PRESTIA bank and GLOBAL PASS publish the same closed
report. No provider text or authentication material enters it.

Alternatives considered were leaving the flag only in logs (not durable with
the run), a new optional terminal field (unnecessary contract expansion), and
retaining a partial outcome (loses parse eligibility for complete acquisitions).
Existing terminals stay immutable. An old partial terminal remains partial;
this decision does not rewrite history or relax parser eligibility. CORE still
derives only the terminal run/unit reports, so the auxiliary flag is available
from the stored terminal but is not yet rendered by collection quality screens.

Synthetic collector tests cover completed acquisition plus failed sign-off,
terminal persistence and unchanged earlier collection failures. Processor
pipeline tests establish that successful flagged SMBC, PRESTIA bank and GLOBAL
PASS evidence still registers and publishes parsed observations. The GLOBAL
PASS plan test also preserves successful registration and dataset eligibility
for every page of its complete account unit.

## Amendment 2026-11-08: closed JST days and frozen resume windows

Status: accepted (merged 2026-11-08 in [#1183](https://github.com/risu729/kogane/pull/1183))
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
publishes partial coverage with `coverage_day_not_finished` on its account
unit, not on the run, which the terminal contract refuses on a success; waiting
longer or retrying publication cannot upgrade that acquisition. Existing terminals and
provider bytes remain immutable. A fresh complete backfill recovers coverage.

Fixed-clock tests cover 10:00 JST approval, the next day's fresh window, later
approval of modern and legacy stopped runs, midnight deferral, and publication
of old open-day successes. The unchanged R2 continuation tests continue to
verify immutable history and parser eligibility using chronologically valid
synthetic acquisition times.

## Amendment 2026-11-10: independent AUD retention evidence

Status: proposed.

The approved manual session now reads the observed AUD foreign ordinary
balance and its retained history as separate `foreign-ordinary-aud-balance`
and `foreign-ordinary-aud-history` units, alongside the existing yen `account`.
Only an explicit-empty history response has been observed. Nonempty rows,
their IDs and applied rates remain unsupported; this amendment does not close
[issue 1245](https://github.com/risu729/kogane/issues/1245).

The alternative of sharing the yen account's unit would attribute AUD's
four-month retention to the longer yen backfill. Making every yen refresh
depend on the unreviewed AUD row layout would also stop valid new yen data
when a foreign movement first appears. The existing unit-independent policy
provides the narrower boundary without admitting arbitrary partial runs.

The run reports partial if any unit fails. Its yen unit reports complete only
when the balance and every requested closed month are present, chunk counts
match, and all failures belong to the AUD units. The AUD balance is captured
first and can publish even if either history acquisition or yen balance fails.
AUD history completes only with every requested closed month present. No
partial or failed unit can replace a complete snapshot.

Migration 0096 names all four SMBC datasets under `unit-independent-v1`,
preserving operator overrides. Only the two balance datasets form snapshots;
transaction/history windows carry eligibility policies without snapshot
selection. AUD uses the standard `dataset_snapshot_policies` and
`SNAPSHOT_DATASETS` membership, with coverage-v1 and parser 0.1.2. Its parser
requires the named dataset; the legacy NULL-dataset boundary is unchanged.

AUD HTML contains session fields, so only reviewed financial fields and the
validated explicit-empty result enter sanitized JSON artifacts. A redaction
step records that the original HTML was discarded for security. The current
reference FX quote remains balance metadata; no transaction rate is inferred.
The latest complete dataset/unit container selects one AUD balance. A resume
keeps the captured AUD bytes and its frozen retention window, and cumulative
success includes earlier partial evidence under the existing terminal rules.
Partial continuations include a newly completed unit's previously ineligible
chunks and omit an independently completed unit already published earlier.

Synthetic transport tests check native Shift_JIS forms, empty named selectors
and account/currency binding. End-to-end R2/CORE tests check new yen publication
through AUD history failure, new AUD publication through yen failure,
failed-unit refusal, snapshot selection and idempotent registration/resumes.
Migration tests preserve customized policy rows. Generic unit-policy tests use
independent stores and seeds, including when a case is run on its own.

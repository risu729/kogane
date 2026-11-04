# Collector coverage and diagnostic audit

Status: local implementation; independent review and production verification pending.

This source-only audit used main `f761630d`. No provider request, login,
credential operation, remote database write, deploy or financial adoption was
performed. Synthetic checks do not establish present authenticated collection.

| Collector   | Existing run coverage                                                                               | Unit contract and remaining limit                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mizuho      | `unknown` after a fully acquired first page without visible continuation; `partial` when incomplete | Account-list/page units are complete if their observed shape is whole. No all-history/date boundary is proven; visible pagination is not followed.                                       |
| MyJCB       | `partial` on every successful run                                                                   | A connection is complete only if its enumerated statement months are read; unread or stopped months keep it partial. Schedule pages are separate evidence, not statement-month coverage. |
| GLOBAL PASS | `partial` on every successful run                                                                   | Complete account unit requires all selected months to pass the existing page/row-total proof. The selected rolling window is not all history.                                            |
| Vpass       | `partial` on every successful card run                                                              | Complete card unit requires each captured month's row count to match its stated total. Missing or mismatched totals remain explicit.                                                     |

References: [ADR 0026](../../docs/adr/0026-collector-unit-coverage.md),
[Mizuho retained evidence and coverage](README.md#retained-evidence-and-coverage),
and each collector's `src/shared-collection.ts` (Mizuho: `src/storage.ts`).
Run coverage alone cannot establish a collector defect or present unit health.
The parent investigation's live aggregate results must be checked separately;
this audit did not read private artifacts and does not infer unit outcomes from
successful object counts.

## Corrected diagnostic gaps

Mizuho previously emitted only a coarse legacy scheduled log; its production
alarm path emitted no collector phase/result record. Returned client issue
codes were dropped at the Worker boundary, and login failures could only be
classified from the HTTP result, not the alarm log. All entrypoints now emit
bounded phases and a redacted result, preserving the original coverage and
provider/persistence outcomes. Existing generic terminal failure codes are
unchanged; correlation uses the run ID and the new safe result.

MyJCB persistence logs now expose run coverage reason plus counts of whole and
incomplete connections. GLOBAL PASS exposes run and unit coverage alongside
its existing page-count/pagination diagnostic. Vpass exposes run coverage reason
alongside its existing complete/unverified/mismatch card-coverage code, plus
counts of complete, unverified, short and excess months (no month labels or
transaction fields).
`rolling-window` describes the run scope, not proof that every unit succeeded;
read it together with connection counts, unit coverage or the card code.

No unknown/partial claim was promoted to complete. No unobserved pagination,
empty-state layout, authentication retry or provider semantics were invented.

## Parent investigation's aggregate readback

The parent reported the latest scheduled-run unit reports: Mizuho 2 successes,
MyJCB 1 success, GLOBAL PASS 1 success; none carried a safe failure code. Vpass
had 9 successes and 5 partial reports across 7 runs, and the matching existing
persist logs reported card coverage `complete` twice and `stated_total_mismatch`
five times. Thus Vpass has a real unit-completeness issue beyond rolling-window
run coverage. The present code preserves this refusal; the direction and
page-shape cause require further aggregate evidence. Do not present the new
diagnostics as a repaired Vpass acquisition or a production verification.

## Local verification

Each collector's native `mise run //services/collector-<name>:ci` passed,
including generated binding types, TypeScript and cf configuration checks:
Mizuho 37 Bun + 39 Workers-runtime tests; MyJCB 128 Bun tests; GLOBAL PASS
112 Bun + 2 Workers-runtime + 4 Node tests; Vpass 49 Bun tests. New synthetic regressions exercise
the production Mizuho alarm entrypoint for success, visible pagination,
partial account acquisition, login refusal and persistence failure; unknown
issue text is redacted. Vpass regression distinguishes short/excess/unverified
month counts without emitting labels or row fields. Changed-file formatting,
lint and diff whitespace checks passed. No authenticated hosted run was made.

## Independent-review correction

Review of local snapshot `16dfd987` found that the new Mizuho result log could
throw inside the persistence try block, turning a successfully stored run into
a reported failure; an earlier phase log could prevent collection entirely.
All Mizuho phase/result logs now use a nonthrowing sink wrapper. MyJCB's shared
persist log and Vpass's shared/daily-completion logs receive the same protection.
GLOBAL PASS already uses a nonthrowing `logEvent` wrapper.

Regressions make each Mizuho phase/result sink and every sink throw, on success
and original acquisition/storage failures, and check unchanged result, terminal
state and one attempt per operation. Legacy scheduled failure/no-retry behavior
is also pinned. MyJCB and Vpass success/failure tests prove throwing sinks do
not change persisted outcomes; the Vpass success alarm uses six mocked requests
and exactly one terminal, with no real keys or provider access. GLOBAL PASS
pins both successful capture and original failure with throwing sinks and one
teardown. The corrected snapshot still requires a fresh independent review.

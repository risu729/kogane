# ADR 0096: Walk SBI's retained execution history in every normal collection

- Status: proposed
- Date: 2026-11-09
- Issue: [#1225](https://github.com/risu729/kogane/issues/1225)

## Context

Both execution collectors requested only the latest 90 days. The historical
backfill already published 72 domestic and seven US executions before daily
collection began, but later runs did not refresh that retained history.
[The source observations](../sources/sbi-securities.md#2026-11-09-two-year-execution-windows)
record the current read routes, retention boundary and quarter counts.

The owner's accepted plan requires the normal scheduled run to walk all
retained history, without a window parameter or persisted progress unless
the walk cannot finish within the existing 13-minute holder limit.

## Options considered

1. Add a backfill operation or a cursor. Rejected: the observed two-year
   interval takes nine windows of at most 90 days per scope; no state is
   needed to plan them.
2. Derive both cutoffs from the current clock. Rejected: the foreign UI
   rejects a start date older than two years before its next business date.
3. Walk disjoint windows using the observed boundaries on every run. Chosen.

## Decision

- Domestic execution history starts two calendar years before the captured
  JST date. Foreign history starts two calendar years before the observed
  web init response's `nextBusinessDate`; the end is today, capped below that
  next business date. The existing GraphQL operation and input fields are
  unchanged. The web metadata corroborates the boundary; it is not a fresh
  observation of the mobile protocol.
- Windows are newest first, without overlap. The ordinary last-90-days
  request and its artifact key stay first. Older execution artifacts add
  their requested dates to the key. Each window's requested range is recorded
  in the terminal and copied into its artifact descriptor.
- `terminal-registration-v4` maps those dated SBI keys and the matching
  artifact ranges. Versions 1–3 keep their prior dataset tables and descriptor
  meaning; unaffected old terminals carry over without re-parsing.
- Per-window failures retain successful windows and mark the scope incomplete
  with a closed code. Foreign retention discovery failure retains the old
  90-day request as partial evidence, never a two-year completeness claim.
  A missing pagination flag, the 20-page foreign bound and the unwalked
  200-row domestic cap fail closed. An empty domestic response needs the
  observed fixed empty-result message as well as its search form.
- Position, valuation and cash requests remain once per scope. Parser bodies,
  versions and external-ID calculations are unchanged; no new provider fields,
  operation parameters, secrets, resources or persisted collection state are
  introduced. The data-type catalogue continues to call executions collected.

## Consequences

New windows have separate registered evidence even when empty response bodies
share content-addressed bytes. Registration may need several ordinary bounded
invocations because it now records more ranges and descriptors.

This change does not claim a completed production walk. A scheduled run must
prove every window registered and published, the distinct count matches the
provider, freshness holds and the walk finishes within its limit. The foreign
parser precision issue is independently tracked by
[#1220](https://github.com/risu729/kogane/issues/1220); domestic history does not
depend on its correction.

## Verification

Synthetic tests cover calendar and leap-day boundaries, exact non-overlapping
coverage, unchanged newest-window shape, pagination and cap refusals,
partial-window retention, stable domestic IDs, unique manifest keys and
per-artifact ranges through the migrated registration contract. The v4 guard
checks the earlier mappings remain reproducible and refuses range mismatches.

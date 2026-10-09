# ADR 0065: Collect native coverage by runtime, without a fabricated repository total

- Status: proposed
- Date: 2026-10-09
- Review basis: fixed-version Pro design consultation; Bun 1.4.2 microfixture and Workers pool trials.

## Context

The repository intentionally uses Bun-host tests, Workers-pool Vitest, separate
Node tests and Chromium checks. Processor CI has two native file shards while
local verification keeps the full serial entry. Test success does not establish
which runtime or source denominator a coverage rate describes.

## Options considered

1. Migrate every test to Vitest or update the Cloudflare plugin for V8 coverage:
   unnecessary runner/plugin changes, with different isolation and discovery.
2. Merge Bun shard LCOV and advertise one total: Bun 1.4.2 omits function
   identities and branch data, so this cannot preserve function identity or a
   complete source denominator.
3. Reuse native providers, preserving individual runtime/workspace reports and
   collecting a separate full serial Processor baseline.

## Decision

Choose option 3. Bun 1.4.2 supplies text plus LCOV. The existing 13 Workers suites
use Vitest and coverage-istanbul 4.1.11 with the unchanged Cloudflare plugin.
Workers instrument their own src tree, including unloaded sources. A thin
invocation wrapper only appends provider flags and records lifecycle/identity;
it never instruments, merges counters or computes a global rate.

CI publishes distinct native artifacts and a summary for each validation runner.
Expected suites, actual checkout SHA, requested head/base, run/attempt, versions,
runtime, shard, exit status, duration and absent owned sources remain visible.
Failure/cancellation/missing or stale output cannot become a successful
collection. The existing partition union/discovery and required CI gate stay.

The formal Processor baseline is the existing full serial Bun entry with native
coverage, exposed as a separate mise task and manual workflow. No thresholds,
forced imports, external coverage service or production behavior changes.

## Consequences

Bun excludes unloaded source from its denominator. Branch/statement data are N/A;
its text All files is an unweighted file mean. Cross-workspace imports and test
helpers can appear in native reports and are identified outside owned scope.
Two shard reports are diagnostics, never a formal merged baseline.
Workers scopes overlap conceptually with Bun but must not be added together.
Other processes and browsers remain unmeasured. Absence is not a zero line count.

Native reports can add runtime, memory and artifact cost. The first rollout
records observations rather than promising stable overhead or enforcing a
numerical floor. Collection validity is required independently of test success.

## Verification

The microfixture fixes Bun's LCOV-only threshold exit, absent function identity/
branch data and unloaded-file behavior. Collection tests cover manifest drift,
failure, interruption, missing, stale and truncated reports. Workers trials
check original TypeScript paths/maps, unloaded owned sources and native report
scope; full serial Processor trials record fixed-checkout timing separately.
See docs/coverage.md for commands, scopes and evidence limitations.

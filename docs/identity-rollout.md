# Account and instrument identity rollout

## 2026-09-08 implementation and initial deployment

- #114: append-only account/instrument mappings, pinned decisions and sealed projections.
- #115: SBI Securities account scopes and instrument references.
- #116: remaining collector rules, with explicit provider-local and aggregate classifications.
- #118: bounded scheduled projection, resumable historical processing and private corrections.
- #119: Vpass durable-card binding artifacts without duplicating financial artifacts.
- #120: protected React identity inspection page and read-only APIs.
- #121: private-operation input bounds and non-disclosure regression tests.

Applied migrations `0018_identity.sql` and `0019_identity_seal_provenance.sql`
to the existing production D1 database. No replacement database or public
diagnostic endpoint was created. The pre-migration Time Travel bookmark was
`000000c7-00000000-000050e0-5672c6438836d598c169786087d6e6f1`.
This is an audit reference, not permission to restore and discard later collector writes.

Initial deployed versions:

- Observation pipeline: `e2718b8a-a616-4cab-b482-2676b6da23dd`.
- Protected evidence browser: `cf45ba1e-9aac-40df-8d9a-bc1e28c0e53c`.
- Production frontend entry: `index-B9HyGQUd.js` (includes the separately merged
  evidence highlighting and UI layout changes).

Local verification on the combined tree: 18 identity storage/private-operation
tests, 35 evidence-browser service tests, and six identity frontend/contract
tests passed. Browser fixtures covered widths 390 and 1280, returning from
evidence details, pagination, and clearing cached data after authorization loss.
Existing Access issuer/audience and private pipeline routing were retained.

The SBI-first historical command stopped after 23 successful bounded sweeps with
HTTP 500 at the local service proxy. The cause was not captured and must not be
called a confirmed provider or D1 failure. A diagnostic tail was attached; a
single resumed sweep succeeded, then the next catchup completed with
`processedRuns: 0`, exit 0, without further captured Worker errors. Durable
checkpoints were reused; existing evidence was not deleted or re-imported.

This initial deployment record is not full rollout acceptance. Final acceptance
requires per-source current coverage, historical pending counts, Vpass trusted
binding consumption, and the final protected UI/access check. Provider-local
identification does not assert a verified global security-master crosswalk;
aggregate account rows are not independently owned assets to sum.

## Production query corrections

Migration `0020_vpass_identity_binding.sql` introduced trusted card evidence pins.
Afterward, a catchup request failed with `D1 DB exceeded its CPU time limit and
was reset`. This later error was captured in the Worker tail; it is distinct
from the earlier unclassified SBI HTTP 500 above.

PR #129 / migration `0021_vpass_binding_lookup_plan.sql` preserves the sidecar
ownership, visibility, uniqueness and terminal-success guards while removing a
redundant window calculation. In correlated eligibility queries, the old plan
materialized source-wide candidates; the corrected plan seeks the financial
artifact primary key. A literal lookup alone did not demonstrate the regression,
so the checked-in plan regression also covers correlated and current-view queries.
The change does not delete or rewrite any evidence or identity rows.

The backend deployment containing this correction and the proven-empty-run batch
optimization (#127) is `95453deb-15f8-488f-bb2a-df4c43df148a`.
A bounded production read returned 40 rows in 21.47 ms. That narrow check did
**not** establish that every UI query was fast: a subsequent one-shot test found
the all-source instrument page still exceeded the D1 CPU limit after 33.7 seconds.
Its plan multiplied instrument identifiers by artifact scans. The API correction
materializes eligible current identities and observation-driven counts before
joining identifier metadata; see `docs/identity-query-performance.md`.

A simultaneous catchup request also received a reset while inserting an identity
run. Symbolication and full-schema query plans showed that particular insert and
its only trigger used unique-index lookups without table scans. A shared-reset
effect from the expensive read is plausible, but the available timing does not
prove causation. No write retry was added to hide the error. With heavy diagnostics
stopped, a bounded canary succeeded and checkpointed catchup was resumed.

PR #128 adds a 30-second frontend deadline covering headers and body, preserves
unmount cancellation, and explains paused/offline queries. It does not replace
the SQL correction. That frontend is deployed as
`df0986ea-1f6d-4dab-aeef-9a204e1a7692`, entry `index-C1AtkJ8j.js`.
Final all-source acceptance must use the corrected API and completed backfill,
not the earlier successful bounded lookup alone.

## Final acceptance: 2026-09-08

The final checkpointed all-source catchup ended with `processedRuns: 0`,
`identifiedRuns: 0`, `identifiedObservations: 0` and exit 0 at sweep 122.
Migration 0022 (#133) subsequently fixed the core current-view join order,
without changing stored decisions. See the [query investigation](identity-query-performance.md)
for the failed intermediate checks, realistic local fixture, and final timings.

The aggregate-only, read-only D1 audit at **2026-09-08T03:25:33.099Z** passed:

| Source           | Eligible current observations |  Organized |
| ---------------- | ----------------------------: | ---------: |
| GLOBAL PASS      |                           372 |        372 |
| Mobile Suica     |                           737 |        737 |
| MoneyForward     |                         6,880 |      6,880 |
| MyJCB            |                           224 |        224 |
| SBI Securities   |                        12,027 |     12,027 |
| SBI Shinsei Bank |                           442 |        442 |
| SBI VC Trade     |                         6,239 |      6,239 |
| SMBC             |                         1,070 |      1,070 |
| Sony Bank        |                           757 |        757 |
| V Point          |                         2,464 |      2,464 |
| V Point Pay      |                            86 |         86 |
| Vpass            |                         3,537 |      3,537 |
| **Total**        |                    **34,835** | **34,835** |

- Equality also holds separately for each of the four observation kinds, not
  merely each source total. All 4,570 eligible current parses and 612 historical
  parses are complete, including successful empty parses.
- All eight integrity counters are zero: duplicate/current eligibility, missing
  seals, orphan evidence, orphan account/instrument mappings, seal count mismatch,
  and seal-versus-Layer-B count mismatch.
- No current account or instrument use has unresolved status. Account statuses
  remain provider-local or aggregate; this is not a global identity assertion.
- The only reported issue is 356 SBI observation occurrences of
  `security-without-global-crosswalk`. Provider security references are preserved;
  no global ISIN mapping was invented. This is not a count of distinct securities.
- PayPay CSV has synthetic implementation coverage but no production input.
  Other inventory-only sources likewise do not become implemented collectors
  merely because their zero-count rows appear in the audit.

### Vpass evidence acceptance

All 2,644 trusted eligible current parses have valid sealed policy-2 pins;
the remaining eligible Vpass parses are not claimed as trusted-bound parses.
All 3,537 trusted current observations use valid pins. The audit found zero
revoked pins, invalid current pin exposures, or durable-card accounts without
their required pin. The 3,028 trusted eligible artifacts include artifacts
without successful parses, so that count is not the parse denominator.

The importer previously saved 96 binding sidecars covering six stable card
tokens without duplicating financial artifacts. Five distinct tokens are used
by current nonempty observations; empty parses do not contribute a currently
used token. These denominators are deliberately kept separate.

### Runtime, UI and protection

- Migrations through 0022 are installed in the existing production D1 database.
  #133 is merged as `89f13dcc67de51811f0f67443f9a400f92043a9f`.
- The pipeline runtime remains `95453deb-15f8-488f-bb2a-df4c43df148a`;
  0022 is a view-only correction and requires no Worker redeployment.
- The final account/instrument/coverage handler probes all returned valid 200
  responses, with 67 account rows, 100 first-page instrument rows and 12 sources.
  These private handler probes do not alone verify the deployed authentication gate.
- The protected deployed browser separately rendered all 12 source coverage rows,
  the account list and the instrument list without the former CPU-limit stall.
  An unauthenticated request from the existing off-WARP `bots` host to the
  deployed account endpoint returned 403. No Access policy was weakened.
- The concurrent UI task's #134 is already deployed as
  `7cfd2491-7888-4e20-83cc-dee26a332949` (2026-09-08T03:25:43Z).
  Its identity API, shared contract and service configuration match the verified
  #131 code; its JSON-preview changes were preserved, not overwritten.

The pre-existing 568 Layer B parse failures remain visible in the UI. This
acceptance covers successfully parsed, eligible observations, not recovery of
rejected payloads. It does not claim transaction deduplication, cross-provider
account equivalence, portfolio totals or a global security master.
No temporary public Worker, database, bucket or new financial login was created.

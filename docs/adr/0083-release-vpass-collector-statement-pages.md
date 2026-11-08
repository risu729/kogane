# ADR 0083: Release the Vpass collector's statement pages under `terminal-registration-v3`; only a successful card run is parsed

- Status: accepted (merged 2026-11-07 in [#1025](https://github.com/risu729/kogane/pull/1025))
- Date: 2026-11-07
- Issue: part of [#445](https://github.com/risu729/kogane/issues/445) (Phase 2
  of the [roadmap](../roadmap.md#phase-2--card-usage--statement--bank-debit))
- Decided by: the owner, 2026-11-07 04:16 UTC, choosing "release now, limited
  to successful runs" over "hold until every card is `complete`"
- Carried by: `packages/application/src/collection/descriptors.ts`
  (`ARTIFACT_DATASETS.vpass`, `REGISTRATION_CONTRACT_VERSION`,
  `DATASETS_BY_VERSION`, `WITHHELD_ARTIFACT_DATASETS`),
  `scripts/artifact-datasets.test.ts`,
  `services/processor/test/registration-datasets.test.ts`,
  `services/processor/test/vpass-collector-binding.test.ts`
- Amends: [ADR 0022](0022-registration-artifact-datasets.md) (the Vpass
  withholding) and [ADR 0023](0023-vpass-collector-card-binding.md) (its
  release condition)

## Context

ADR 0022 kept the rule for the Vpass collector's statement pages
(`months/<yyyymm>/<top|answer>-NNN.json`, `sanitized_provider_capture`, JSON →
`statement-page`) in `WITHHELD_ARTIFACT_DATASETS`, so every collector-vpass
card run registered with its pages at `dataset = NULL` and no parser ran on
them. ADR 0023's amendment set the release condition: (a) the collector's
card tokens are the importer's and (b) the persist diagnostics show the
collector's card units reaching `complete` (option 8: every walked month's
captured rows equal the provider's stated total). ADR 0029 replaced the keyed
token with an unkeyed one, and migration 0063 rewrote the importer's tokens of
the cards the owner staged.

Production, read-only and counts only, 2026-11-07 04:00–04:30 UTC (CORE D1):

- (a) holds for 6 of the 7 collector tokens: they are among the importer's
  (rewritten) `vpass-card-v2-` unit keys. The seventh card has no importer
  token.
- (b) does not hold. Of 93 collector card runs with a terminal unit report
  (2026-09-26 to 2026-10-12), the `card-NNN` unit is `success` in 19 and
  `partial` in 74. Two cards reached `complete` at least once (one of them the
  card with no importer token); the five others never did, and every card's
  newest run is `partial`.
- Vpass collection stopped after 2026-10-12: the execution lease of that day's
  run stayed held and every later occurrence failed `collection_busy`. The
  lease was released on 2026-11-07 (another thread); that is outside this
  decision.

What a released page would do, read from the code:

- **Only a successful run is parsed.** `statement-page` has no unit-scope
  policy row in `dataset_snapshot_policies`, so it has run-scope eligibility:
  `unitParseable` (`packages/read-model/src/concepts.ts`, used by the
  Worker's job creation in `services/processor/src/worker.ts` and by the
  readers' `ACTIVE` predicate) admits an artifact only when its fetch run's
  status is `success` with no failure. A collector run whose card unit is
  `partial` (option 8) is `partial` in `observation_fetch_runs`, so its pages
  get no parse job and are never an eligible snapshot. The importer's three
  `partial` runs are excluded the same way today.
- **A successful run with a binding binds.** When the collector derived a
  token, the run's binding unit and card unit both succeeded, so
  `trusted_vpass_card_bindings` admits its pages, identity policy 2 resolves
  its rows to the token, and the token's account entity is the importer-era
  one for a rewritten card
  ([ADR 0023's amendment](0023-vpass-collector-card-binding.md#amendment-option-3-implemented)).
  The binding is not part of run success: when the derivation fails closed
  (`binding_tuple_absent`, `binding_selection_mismatch`, ...) the run holds
  only its card unit, can still be `success`, and its pages are parsed with
  run-scoped, unresolved rows (`services/processor/test/vpass-collector-binding.test.ts`,
  "without the collector's binding").
- **Registered pages keep their descriptors.** Fetch artifacts are
  append-only, so a run already registered under `terminal-registration-v2`
  keeps its pages without a dataset unless it registers again.

## Options considered

1. **Hold until every card reaches `complete`** (ADR 0023's condition (b) as
   written). Nothing is parsed until the cause of `stated_total_mismatch` on
   five cards is found and fixed; the importer-era data (captured until
   2026-09-10) stays the only Vpass card data. Rejected by the owner.
2. **Release, and let only successful card runs become current** (chosen).
   The condition (b) protected against a parsed capture that cannot bind
   retiring the importer-era purchases with nothing to replace them. The
   run-scope eligibility above already gives that protection per run: a
   `partial` run is never parsed. So the release needs no new read-model
   predicate. A card switches to collector data month by month as its runs
   succeed, and a card whose runs stay `partial` keeps its importer-era
   snapshots.
3. **Change v2 in place** (as ADR 0022's two SBI Shinsei amendments did).
   Cheaper: no re-walk, and only terminals registered after the deploy get the
   dataset. Rejected: the 19 successful runs already registered would never
   be parsed, and a v2 row would read differently from what v2 derives, which
   the version exists to prevent.
4. **A new read-model guard on the producer** (`f.tool <> 'collector-vpass' OR
   f.status = 'success'`). Proposed to the owner before the run-scope
   eligibility was read; it adds nothing, since `ACTIVE` already requires a
   successful run for this dataset, and it would change readers that the
   plan suites pin. Not done.

## Decision

- **The rule moves into `ARTIFACT_DATASETS` unchanged** (key, role
  `sanitized_provider_capture`, JSON → `statement-page`), and
  `WITHHELD_ARTIFACT_DATASETS` is empty. The importer's role for the same key
  (`provider_response`) stays unmapped.
- **`REGISTRATION_CONTRACT_VERSION` becomes `terminal-registration-v3`.**
  `DATASETS_BY_VERSION` keeps v1 (St George only) and v2 (the table without
  Vpass) reproducible; v3 is the full table. v3 changes a descriptor only for
  collector-vpass statement pages, which no parser read under v2
  (`scripts/artifact-datasets.test.ts` proves it per artifact shape).
- **Carry-over is unchanged** (`carryOver` in `register-terminal.ts`, ADR
  0022): every terminal gets a v3 row as the scan reaches it; one whose v3
  descriptors equal its registered run's is linked to that run; a
  collector-vpass card run with statement pages registers again as a second
  fetch run in the same acquisition session over the same objects, and its
  pages carry the dataset. Blocked, retryable and unfinished v2 rows get one
  fresh attempt under v3, as under v2.
- **Only a successful card run is parsed**, by the existing run-scope
  eligibility; no unit-scope policy is added for `statement-page`. Adding one
  later would let a `partial` card's pages be parsed and is a decision of its
  own.

## Consequences

- **Purchases.** For each card-month a successful collector run captured, the
  collector's capture becomes the current statement snapshot (it is newer
  than the importer's), the importer-era purchase event is retired and the
  collector's is recognised once on the same account entity (recognition keys
  carry the producer, so each such card-month changes key once). Nothing is
  counted twice; the retired revisions stay readable. From the counts above,
  that is one importer-era card today. Card-months no successful run captured
  keep the importer's snapshot.
- **A successful run without a binding** (the derivation failed closed)
  still becomes the current snapshot of its card-month and retires the
  importer-era purchase event of that card-month; its own rows are skipped
  as `account_not_resolved`, so the month has no live purchase until a later
  bound run captures it. Nothing is counted twice. Every collector token seen
  on 2026-11-07 was derived, so no such run is known, but run-scope
  eligibility does not prevent one.
- **Card ordinals match.** The current snapshot of a
  card-month is chosen per (source, card unit key `card-NNN`, month)
  (`VPASS_STATEMENT_SNAPSHOT_CTES`); only the purchase ranking after it is
  per resolved account. A collector card whose ordinal is one the importer
  used for another card would make that other card's importer-era month no
  longer current (its event retires with nothing to replace it), while the
  card's own importer-era month under its old ordinal is outranked per
  account, not counted twice. Checked read-only on 2026-11-07 (counts only):
  each of the 6 matched tokens has the same `card-NNN` under both producers,
  and the seventh card's ordinal is none the importer used, so no card-month
  is displaced this way today. A later change of the provider's card order
  could break it; nothing guards against that.
- **The seventh card** (no importer token) becomes a new account entity with
  no owner and no label, and the months its successful runs captured appear as
  new purchases on it. Its ownership is the owner's decision.
- **Stale data where runs stay `partial`.** A card whose newer runs are
  `partial` shows its newest successful capture, which can be weeks old, and
  five cards show only importer-era data. Nothing marks a snapshot as older
  than the card's last collection; the collection-quality read shows the
  `partial` coverage per run. Fixing `stated_total_mismatch` is separate work
  (the counts-only shape diagnostic of ADR 0023's 2026-10-10 amendment gives
  its evidence once runs resume).
- **Settlements.** A collector statement observation is a different statement
  key (it carries the producer) for the same account and period. Once it has
  an owner, a settlement candidate built on the importer's statement for that
  period is no longer current (`statement_changed`, the readiness check's
  newer-statement rule). Production had no settlement decision and no
  ownership record on 2026-11-06, so nothing accepted goes stale now.
- **Collection quality.** `dataset_withheld` is no longer reported for any
  source; the code stays in the closed reason list.
- **Drain** (an estimate from the constants and the 2026-11-07 counts, not a
  measurement). CORE holds about 790 `terminal-registration-v2` rows: 466
  registered (84 of them collector-vpass card runs), 177 blocked and 147
  neither. The scan starts at most five registrations per five-minute tick
  inside the 500-operation budget; carried-over terminals do not count against
  the five. The 84 Vpass card runs register again (about 20 operations per
  page, so a long card continues over two invocations, as ADR 0010 measured)
  and the 324 blocked or unfinished rows get one attempt each. That is on the
  order of 80–170 ticks, **about 7–14 hours** of cron time, during which the
  health route's `unregistered` count, which counts current-version rows, is
  higher than usual. New terminals register directly under v3.
- The `coverage` agent intent counts each re-registered Vpass capture once per
  fetch run, as ADR 0022 recorded for its re-registrations.

## Verification

- `scripts/artifact-datasets.test.ts`: the withheld list is empty; the
  versions are v1, v2, v3 and v3 is current; every collector-vpass artifact has
  no dataset under v1 and v2, and under v3 exactly the two page shapes map to
  `statement-page`; the importer's role for a page stays unmapped; v3 changes a
  descriptor only for those pages, from NULL, which no parser reads; v2 still
  changes a descriptor only where v1 left one no parser read.
- `services/processor/test/registration-datasets.test.ts` (every real
  migration, Miniflare, the collector's real card-run plan): a `complete` and a
  short (`partial`) card run registered under v2 have pages without a dataset
  and no job; under v3 each registers again as a second fetch run in its own
  session with the page's dataset; the sweep parses only the successful run's
  page, which is the one current snapshot of its card-month; the trusted view
  admits both fetch runs of the successful run (one token each) and identity
  policy 2 pins and seals the parsed page to the v3 run's binding; a
  redelivery and a second sweep add nothing. A page under the importer's
  role gets no dataset under any version and is carried over.
- `services/processor/test/vpass-collector-binding.test.ts`: the collector's
  registered run carries the dataset on its page and its binding, the view,
  identity policy 2 and the purchase-lane card world (the importer-era event
  retired and recognised once on the same entity; under another token a new
  entity and nothing counted twice) pass on v3.
- Not verified: the production drain time and which card-months switch,
  which the first scans after deployment show (counts only, as above).

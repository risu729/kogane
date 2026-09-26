# ADR 0015: Source authority v2 names CORE source ids

- Status: proposed
- Date: 2026-09-26
- Carried by:
  [balance read model](../balance-read-model.md#how-a-row-gets-its-state),
  `packages/read-model/src/authority.ts`,
  `packages/read-model/test/authority.test.ts`

## Context

`packages/read-model/src/authority.ts` is the read policy that hands
`selectAdoptedSet` an `authorityRank` per source: direct 0, aggregator 1,
unreviewed 2. It matches ranks by CORE `sources.id`, and any id it does not
list is `unreviewed`, silently. Under `source-authority-v1`:

- `AGGREGATOR_SOURCES` named `moneyforward`. CORE has no such source: the
  CORE migrations seed `moneyforward-me` (0003), the collector map
  `COLLECTOR_SOURCE_IDS` maps `moneyforward-me` to `moneyforward-me`, and the
  ingest route in `config/ingest-clients.json` uses it. MoneyForward therefore
  ranked `unreviewed` (2), not `aggregator` (1).
- `DIRECT_SOURCES` did not list `mizuho-bank` or `st-george`. Both are CORE
  sources (seeded in 0002), both have their own collectors and ingest routes
  (#216, #214, #254), and both report the bank's own accounts. They ranked
  `unreviewed` too.
- Every other listed id (`global-pass`, `mobile-suica`, `myjcb`,
  `sbi-securities`, `sbi-shinsei-bank`, `sbi-vc-trade`, `smbc-bank`,
  `sony-bank`, `v-point`, `v-point-pay`, `vpass`) is a CORE source id.

There is no closed list of CORE source ids in code. The ids are rows the CORE
migrations insert (0002, 0003) and delete (0043 removes `kogane-synthetic`);
`COLLECTOR_SOURCE_IDS` covers only sources with a collector and still names
`kogane-synthetic`, which CORE no longer holds: it is the verification source
the test harnesses seed themselves, and `scripts/config-bootstrap.test.ts`
already exempts it from the production routes.

The release id enters the snapshot identity twice: as
`authorityPolicyRelease` in the input manifest (`projectionInputManifest`,
stored with the captured input) and in `projectionBuildDigest`, which with the
input digest forms the snapshot's content key. The manifest is also copied
into the READ snapshot row (`balance_read_snapshots.input_manifest_json`),
where the App reads only `publishedHighWaterParseRunId`. No SQL, READ pointer
or selection compares the release string.

## Options considered

1. Correct the ids and keep `source-authority-v1`. Rejected: two different
   rank tables would carry one release id, so a stored manifest could no
   longer say which policy decided its rows. The snapshot id would still move
   (each captured candidate carries its `authorityRank`), but only by
   accident of the input content.
2. Correct the ids and bump to `source-authority-v2`. Chosen.
3. Match sources by a pattern or by provider instead of by id. Rejected: the
   policy must be reviewable per source, and an unknown source must stay
   `unreviewed` rather than be guessed.

## Decision

- `source-authority-v2`: `moneyforward-me` is the aggregator; `mizuho-bank`
  and `st-george` join the direct sources. The full table is in the
  [balance read model](../balance-read-model.md#how-a-row-gets-its-state).
- The canonical set of CORE source ids is what the CORE migrations leave in
  `sources`. `test/authority.test.ts` migrates an in-memory database from
  scratch and refuses any policy id outside that set, and any CORE source a
  collector registers under (`COLLECTOR_SOURCE_IDS`) that ranks
  `unreviewed`. A renamed or new collected source now fails the read-model
  suite instead of falling to `unreviewed`.
- No migration and no forced rebuild. After deploy, the next projection tick
  (flag on) computes a content key that no sealed snapshot has, builds a new
  snapshot and publishes it when it is sealed. A v1 snapshot is never
  rewritten: it stays as built, with the v1 manifest naming the policy that
  decided it, until the usual retention (two complete snapshots) retires it
  ([rebuild and invalidation](../balance-read-model.md#rebuild-and-invalidation)).

## Consequences

- MoneyForward (2 → 1). Its balance rows resolve to no registered metric, so
  each is targeted per provider metric and never shares a target with a
  direct source. Within its own targets every candidate has the same rank
  before and after, so no MoneyForward row changes state. The rank takes
  effect only when a MoneyForward metric is registered into a shared target;
  then a direct source wins an unproven overlap with it, where v1 left both
  unresolved.
- St.George (2 → 0). Same as MoneyForward: no registered metric, its own
  targets only, no row changes state.
- Mizuho (2 → 0). `mizuho-account-list` `account_balance` resolves to
  `deposit.balance`, the target SBI Shinsei Bank and SMBC also feed. The
  identity policies in `packages/identity` map no account as `identified`,
  so unless a recorded decision made both sides identified, no cross-source
  pair in that target is policy-disjoint, and an unproven overlap is decided
  by rank.
  Under v1 Mizuho lost every such overlap to the other banks. Under v2 the
  two sides have equal rank and both stay unresolved (`overlap_unknown`), as
  for any two direct sources. A row changes state only if the target holds
  Mizuho plus direct candidates of exactly one other source that no accepted
  relation links to it: that source's rows move from `adopted` to
  `unresolved`. If candidates of two other sources are present with no
  accepted relation between them, all were already unresolved and nothing
  changes. `deposit.available-balance` is Mizuho-only and unchanged.
- The adoption algorithm, reason codes and READ schema are unchanged.

## Verification

Synthetic data only: `test/authority.test.ts` (policy ids against the migrated
CORE `sources`, collector sources reviewed, v2 ranks; it fails on the v1
table), and a balance-projection test that builds the Mizuho/SMBC overlap
under the v1 and v2 ranks.

# ADR 0052: Reconstructed state is a pure fold over a provisional adopted-event input, compared with reported snapshots

- Status: proposed until this PR merges; accepted upon merge
- Date: 2026-10-08
- Issue: #550 (指定日状態: 採用イベントから残高・保有数量を再構成する), first PR (engine only)
- Carried by: [reconstructed state](../reconstructed-state.md),
  `packages/domain/src/reconstruction.ts`,
  `packages/domain/test/reconstruction.test.ts`

## Context

Phase 11 asks what adopted events imply from a starting snapshot, beside what
the provider reported ([roadmap](../roadmap.md#phases-8--11--dated-reported-and-reconstructed-state)).
The reported side exists: [reported state on a date](../reported-state.md)
([ADR 0019](0019-dated-reported-state.md)) lists, per account, the latest
complete capture before the end of a date, with each balance's registry metric
(measurement kind, sign meaning) and its decimal-v1 value or its absence.

The event side is thin and not uniform:

- Only two writers put rows into `economic_event_revisions`
  ([economic events](../economic-events.md)): card purchase recognition (0047;
  `purchase`/`refund` on the `purchase-recognition` basis, one leg on the card
  account) and the card settlement review (`card_settlement`, state
  `debited`, a `cash-movement` decrease on the bank account and an
  `unresolved` `obligation-change` leg without a value on the card account;
  a withdrawal is a later revision in state `unknown` without legs).
- They name the leg subject differently: card purchases write
  `account:<accounts.id>` (`packages/domain/src/card-purchase.ts`, the 0047
  insert guard), card settlements write the bare account id
  (`services/processor/src/card-settlement-commands.ts`). Settlement evidence
  is a JSON array of id strings, not `SourceFactRef` objects.
- Revisions carry one `effective_time_json` and a writer-set `created_at`;
  there is no history cursor, so when a revision became adopted knowledge is
  not recorded.
- No parser emits a transaction-history coverage claim (`window` or
  `event-feed`): every family's history coverage is `unknown` today.

So no real account can produce a complete reconstruction yet. Bank accounts
have start snapshots but their only events are reviewed card settlements;
card accounts have purchase events but no reported container (Vpass and
MyJCB are not snapshot containers). This ADR says so instead of waiting for
it to change.

The hand-off contract between the writers and the readers of adopted events
(#549 and the common guard, ADR 0054 in preparation) will fix which revisions
are adopted at a knowledge cut, the claim keys and the subject form. External
design advice relayed by the owner on 2026-10-08 (advice, not a decision;
reviewed against the code and recorded below) and the common-contract design
review shaped the provisional input this PR uses.

## Options considered

1. **Wait for the hand-off contract.** Rejected: the fold, the start/end
   rules, the Tokyo boundary, the closed codes and the manifest do not depend
   on it, and without them the contract has no consumer to be checked against.
2. **Fold straight over the 0032/0047 tables.** Rejected: it would bake today's
   two subject forms, `created_at` as knowledge time and the settlement
   evidence form into the fold, and every correction of the contract would be
   a fold change. The read side's `reconciliationSignals`
   (`packages/read-model/src/events.ts`) shows the cost: it binds one subject
   string to both `economic_legs.subject_ref` and
   `balance_observations.source_account`, a provider-local label, and takes
   the newest balance by id without a start or a completeness rule.
3. **A pure fold over an explicitly provisional input** that an adapter fills
   from the stored rows. Chosen. The input is tagged
   `provisional-adopted-events-v1`, every field the fold reads is declared,
   and the hand-off contract replaces it.

## Decision

1. **Inputs.** `ProvisionalAdoptedEventSet` (revisions with `commitRef`,
   typed legs, typed times, `(book, key)` claims, adapter flags, family and
   history coverage, pins), a start and an end reported side (`StartSnapshot`,
   `EndReported`, each pinned by its reported-state `contextId`), a
   `ReconstructionRequest` (accounts, start and end date, basis
   `cash | trade-date | settlement-date`, `knowledgeAt` and the
   `knowledgeCut { coreEpoch, commitSeq }` the adapter resolved it to) and the
   `FoldPolicy` `reconstruction-fold-v1`, passed explicitly; no parameter has a
   default, and any other content under that id is refused.
2. **Knowledge.** `{ coreEpoch, commitSeq }` is a history cursor the common guard supplies
   (ADR 0054, in preparation). It is not a D1 bookmark, and `created_at` is
   never evidence of adoption: `recordedAt` is carried for information only.
   `selectKnowledge(set, cut)` first selects the revisions committed at or
   before the cut, then resolves every event's active revision over the whole
   chains (cross-event supersession included): active means committed by the
   cut with no successor committed by it. Only then does the fold filter by
   range, account, instrument, kind or leg, so a correction of a date, an
   account or an instrument and a dateless withdrawal always take part.
   Holders of a claim at the cut come only from those active revisions. A
   successor committed before its predecessor, a pointer to a revision the
   input lacks, a cycle, or two active revisions of one event make the chain
   `revision_chain_inconsistent`; a revision without a commit, or with a
   commit of another epoch (a restored backup starts a new history), is
   `knowledge_unlogged`, and so is every revision of its event. The exported
   provisional names (`ProvisionalCommitRef`, `ProvisionalKnowledgeCut`,
   `PROVISIONAL_CLAIM_BOOKS`, `PROVISIONAL_LEG_EFFECTS`, …) are prefixed so
   that the common contract's own names can be exported beside them. An input the adapter already resolved
   (`resolved-at-cut`) is only checked for one revision per event.
3. **Leg effects.** A `movement` (`increase` or `decrease`) is what moved and
   is applied once; a `breakdown` (principal 100 and fee 1 of a 101 debit)
   and a `correspondence` (the obligation a payment reduces, the settlement of
   a trade) refer to a movement by `ofLegIndex` and are never added. Basis
   selects one leg basis and one time role with no fallback: cash →
   `cash-movement`/`posting`, trade-date → `trade-date`/`trade`,
   settlement-date → `settlement-date`/`settlement`. Kind/state → effect:
   `captured`/`debited`/`credited`/`confirmed` applied;
   `authorized`/`requested`/`in-transit`/`proposed` shown apart;
   `canceled`/`returned`/`unknown` no effect; anything else unknown.
4. **Placement.** Capture instants are projected to Asia/Tokyo before
   `compareTemporal`. The window runs from the start capture to the end
   capture of the cell (a stale capture moves the window, it does not drop
   events); without a start it starts after the start date, without an end it
   ends with the end date. An event on a capture's Tokyo day is a boundary
   candidate, counted apart and never adopted; an unknown time, a missing
   time of the basis's role or two of them is `event_time_unknown`.
5. **Fold and output.** Per (account, unit) and (account, instrument): the
   start (one stock balance with `asset-positive` or `liability-positive`
   sign, negated when liability-positive; or one identified position), the
   reconstructed figure in exact decimals, applied / pending / boundary counts
   and totals kept apart, ignored counts by disposition, unknown references,
   closed gap codes, the partition (`complete`, `partial-verified-scope`,
   `not-computable`) and `needsReview`. The figure is absent with a reason
   whenever the start, a movement's value, its effect, its time, the chain,
   the knowledge, an adapter flag, a duplicate claim or an own transfer
   blocks it; it is never zero by default. Two active events holding one
   `(book, key)` are both marked and never resolved. An active revision's
   adapter flag reaches every requested cell its chain touched (its own legs
   and those of every revision it superseded), so a flagged withdrawal
   without legs still blocks the cell of the movement it withdrew. A revision with
   movements on two own accounts is held (`own_transfer_held`). Nothing is
   totalled across accounts; `netWorth` is `"not-computed"`.
6. **Explanation.** Against the end figure in the same orientation: the
   remainder `reported − reconstructed` (exact whenever both are, never
   absorbed or written), late-recorded movements as `explainLate(baseline,
now)`, a pure diff of two selections of one scope (the baseline is the cut
   the adapter resolves for the end capture), pending shown apart and
   same-day boundary candidates. Statuses: `reconciled` only for a zero
   remainder with no gap and no boundary candidate;
   `consistent_with_boundary_exclusion` / `_inclusion` as candidates;
   `difference_unexplained`; `not_comparable` (`reported_end_missing`,
   `reported_end_not_exact`, `reconstruction_incomplete`,
   `snapshot_basis_unknown`, the last also for every basis but cash, since no
   container says which basis its figure reflects, ADR 0004);
   `unavailable` (`no_reported_container`). Coverage that is not complete is
   never reconciled, even at a zero remainder.
7. **Reproducibility and bounds.** The manifest pins schema, engine release,
   input contract, resolution, policies, zone, basis, range, accounts,
   `knowledgeAt`, the cut and the baseline cut, both reported context ids, the
   event-set version and adapter release, the writers and the adapter's
   identity, evidence-alias and coverage releases, the coverage rows in
   canonical order, FX reference and policy
   references. `canonicalReconstructionManifest` returns its canonical text
   synchronously; the caller digests it with `canonicalDigest`. An input over
   5,000 revisions or 20,000 legs is refused (`event_budget_exceeded`), never
   cut.
8. **What the engine can and cannot verify.** The engine never verifies
   `setVersion` against the content it is handed: the version is the
   adapter's word, pinned as given. Re-running the selector on a selection
   catches edits of derived fields (statuses, supersession, holders) but not
   an edited input row, which re-selects consistently. A full-chains baseline
   must carry the same `setVersion` as the selection (one set read at two
   cuts); sets resolved by the adapter at each cut may carry their own.

## Consequences

- Cost, a limit to fix before a Worker calls this: legs are indexed by
  (account, unit) once and each selection is checked once, but checking a
  selection re-runs the selector and compares canonical text. At the budget
  (5,000 revisions, 20,000 legs) on `bun` locally, a selection takes about
  60–90 ms and the fold about 0.45 s for 100 to 1,000 cells and 0.7 s for
  20,000 cells, 0.8 s with a baseline (most of it the two selection checks).
  Branding the selector's output (a module-private `WeakSet`) instead of
  re-checking it is left to the PR that moves the selector; nothing was
  measured on workerd.
- No migration, no read path, no route, no UI: the adapter over the stored
  rows, `GET /api/v2/reconstructed-state` and the panel beside `/state` are
  later PRs. Nothing in production computes a reconstructed state yet.
- The subject tolerance (`account:<id>` from card purchases, the bare id from
  card settlements) is an adapter rule, not a decision about the canonical
  form; the fold sees only a resolved `accountId` or null.
- The reported side reads identity as it is today (ADR 0019); identity as of
  the date and identity-meaning changes are adapter flags
  (`identity_changed`) that the fold maps to needs-review, never applied.
- Own transfers stay held although the advice names same-owner, same-currency
  cash transfers as the common guard's first family: whether the fold may
  apply them once that guard adopts them is held below.
- `economic-events.md` and `packages/read-model/src/events.ts`
  (`reconciliationSignals`) are unchanged.

### External advice: adopted / changed / deferred

| Advice                                                                              | Here                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Select decisions at the knowledge cut, resolve active revisions, then filter        | Adopted: `selectKnowledge` is a separate pure step whose output is the fold's input                                                                                                                                                                                                                                                                                                                          |
| Separate the movement, its fee breakdown, trade/settlement correspondence, boundary | Adopted: leg `effect` `movement`/`breakdown`/`correspondence` with `ofLegIndex`; boundary candidates are their own component, never adopted                                                                                                                                                                                                                                                                  |
| Past holders from the cut's selected claims, not from a current-live guard          | Adopted: active-at-cut from `commitSeq`; duplicate `(book, key)` holders from active revisions only                                                                                                                                                                                                                                                                                                          |
| Never infer adoption from creation time; a history cursor distinct from bookmarks   | Adopted: `commitRef { coreEpoch, commitSeq }` from the common guard (ADR 0054, in preparation); `recordedAt` informational; a late part is a diff of two selections                                                                                                                                                                                                                                          |
| Manifest pins identity, evidence alias, coverage, snapshot, FX, policy, engine      | Adopted, exactly: the engine release, the fold policy id, both reported-state context ids (which pin the snapshots), the adapter's identity, evidence-alias and coverage release names (names only: their content is the adapter's word), the family and history coverage rows themselves in canonical order, and the FX reference and policy references as fields the adapter fills (no FX is applied here) |
| Exclusivity by book × consumption key for every writer                              | Changed for the fold: claims are `(book, key)` and duplicates are detected on them, not on evidence ids; the common guard itself is deferred to the #549 contract PR                                                                                                                                                                                                                                         |
| An adapter over the real writers, joining the common guard                          | Deferred to the #549 contract PR and #550's adapter PR                                                                                                                                                                                                                                                                                                                                                       |
| Identity-meaning change → needs-review / indeterminate                              | Noted as adapter responsibility: the adapter sets `identity_changed` (and `alias_conflict`, `claim_conflict`, `writer_unsupported`); the fold never applies through                                                                                                                                                                                                                                          |
| Residual zero with incomplete coverage is never promoted; unknown stays unknown     | Adopted: `reconciled` requires complete coverage; absent stays absent                                                                                                                                                                                                                                                                                                                                        |

### Held for the hand-off contract

1. What is handed over: active revisions at a cut (derivable) or an explicit
   published event-set version; who mints the version id, a digest or a
   stored row (a migration of #549, not of #550); whether the lot engine
   (#556) reads the same version.
2. Where trade, settlement, posting and usage dates live (0032 stores one
   `effective_time_json` per revision) and how the adapter maps today's
   `effective` per writer (purchases → `usage`, settlements → `posting` is
   this PR's assumption); no fallback between roles.
3. The state → effect table for transfer and payout families, especially
   `in-transit`, `requested`, `returned` and a retired `unknown` (no effect or
   effect unknown); v1's table is provisional.
4. The canonical subject form (`account:<id>` or bare); whether existing
   settlement legs are tolerated or re-revised; how a unit or subject names an
   instrument holding.
5. How legacy `fee` and `unresolved` legs map: a breakdown or correspondence
   of which movement, and whether a fee can ever be an additional movement of
   its subject. The sign convention: the fold reads a movement's direction
   from its role and its value as a non-negative magnitude, and refuses a
   negative movement or breakdown as `leg_sign_unknown` rather than negating
   it twice; 0032 allows signed coefficients, so the contract must say
   whether a stored negative value can occur and what it means.
6. Own transfers: adoption, withdrawal and re-allocation, in-transit across a
   snapshot boundary, and one live holder per `(book, key)` across every
   writer, so a bank debit row is never both a settlement movement and a
   transfer or expense movement; and whether the fold may then apply them.
7. Who produces family and history coverage per account, family and window,
   and whether it is part of the set version.
8. The commit sequence: assigned by the common guard (ADR 0054), its scope,
   same-cut ordering and how an instant cut is resolved to a sequence; how the
   existing rows without one are back-filled or stay `knowledge_unlogged`.
9. Evidence form: settlement `evidence_support_json` strings against
   `SourceFactRef`; normalisation; matching one evidence id across
   re-captures.
10. Identity pinning: legs fix the account at write time while the start
    snapshot uses today's mappings.
11. Which basis each provider container's balance or position reflects
    (posted cash, trade, settlement) needs the owner's confirmation before a
    trade or settlement comparison is supported (ADR 0004).

## Verification

`packages/domain/test/reconstruction.test.ts`, synthetic inputs only
(invented ids such as `account:test:a` and `instrument:test:alpha`, round
amounts, invented dates and commit sequences): exact fractional and
eight-place folds, units never mixed, missing start absent with the flow
listed, inexact movement, empty set with unknown and with complete coverage,
history recomputed when filled, correction before and after the cut with the
late part, account and date corrections that never revive the old revision,
dateless withdrawal, settlement accept then withdraw at revisions 2 and 3,
cross-event merge and split, retirement, authorised and canceled purchases,
two live revisions and a cycle, commit order over `recordedAt`, unlogged
knowledge, adapter flags, duplicate `(book, key)` and the non-duplicates,
the Tokyo boundary of a `16:00Z` capture, unknown and other-role times, the
101 = 100 + 1 movement and breakdown, the same between two own accounts held,
trade and settlement never both applied, liability-positive start, refused
starts, boundary statuses, unavailable and not-comparable ends, permutation
giving the same output and context id, the budget refusal, and refusals of
unknown keys, another policy and a tampered selection.
`mise run //packages/domain:ci` and `mise run ci:root` locally. No production
data, D1 or Workers were involved.

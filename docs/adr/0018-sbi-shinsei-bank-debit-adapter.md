# ADR 0018: SBI Shinsei as the second bank debit adapter of card settlement review

- Status: proposed (accepted when the PR that carries it merges)
- Date: 2026-09-26
- Implemented by: P1-5 of the [next-milestone plan](../plans/2026-09-next-milestone.md),
  branch `claude/sbi-shinsei-settlement-adapter-wr8pj4`
- Carried by: [card settlements](../card-settlements.md#bank-adapters),
  `packages/storage-d1/migrations/core/0052_sbi_shinsei_bank_debits.sql`,
  `packages/read-model/src/card-settlement-readiness.ts`,
  `services/processor/src/card-settlement-job.ts`

## Context

Card settlement review pairs a provider statement total (Vpass, MyJCB) with an
observed bank debit of the same amount within three days of the due date, and
only an operator's decision, with explicit shared ownership, accepts a pair
([card settlements](../card-settlements.md)). Migration 0044's
`card_bank_debit_facts` admitted SMBC rows only (`source_id='smbc-bank'`), and
the sweep read the bank date with an SMBC-only regex
(`YYYY-MM-DDT00:00:00+09:00`). A card paid from another bank could never be
reviewed.

An adapter needs three things the evidence must state, not Kogane: a provider
row id (so re-observing a row is not a second payment, INV06), the provider's
own debit direction (so a credit or an unsigned movement is never a payment),
and the provider's civil date.

## Options considered

1. **SBI Shinsei** (`sbi-shinsei-bank`, parser
   `sbi-shinsei-top-balances-and-activity`). Its activity rows carry the
   provider's `txnReferenceNo`, a separate `debit` or `credit` column (the
   parser records which in `_kogane.amountSignSource` and signs a non-zero
   debit negative), and a `postingDate` the parser stores as `YYYY-MM-DD`. The
   parser sets no status. Chosen.
2. **Mizuho.** Its history ids are fingerprints of provider fields and an
   occurrence number (`mizuho:<fingerprint>:<occurrence>`,
   `identityOrigin: provider-fields-and-occurrence`,
   [ADR 0012](0012-mizuho-identity-policy-v2.md)). Two identical rows on one day
   differ only by position, so a re-observation after the page changes can
   carry another id: the ranking would count one payment twice. Rejected for
   this adapter class.
3. **Sony Bank.** Its ids are fingerprints too
   (`sony-bank-history:<date+signed amount+after-balance+currency>:<n>`).
   Rejected for the same reason.
4. **Generalise to every bank with a debit direction.** Rejected: each bank's
   id, sign and date semantics are separate evidence; a union of named
   branches keeps each predicate reviewable (ADR 0004: unobserved provider
   semantics stay unsupported).

## Decision

- Migration 0052 drops and recreates `card_bank_debit_facts` as a `UNION ALL`
  of two branches, each ranked on its own provider key
  `(source, producer, namespace, source account, external id)`, newest capture
  first, exactly as 0044 ranked SMBC. Both output every 0044 column plus
  `debit_date` and `adapter`.
- **SMBC branch:** the 0044 predicate, unchanged. `debit_date` is the date of
  an `as_of` of the form `YYYY-MM-DDT00:00:00+09:00` (the only form the
  sweep's regex matched) and NULL otherwise. D1 refuses a `GLOB` pattern
  longer than 50 bytes (`LIKE or GLOB pattern too complex`), so the view
  globs the date part only and compares the whole `as_of` with that date and
  the fixed time as text (`length()` and `substr()` stop at an embedded NUL,
  so a length check alone would admit a value the regex refuses); the
  Miniflare-backed processor test caught the longer pattern, which
  `bun:sqlite` accepts. `packages/read-model/test/card-bank-debit-facts.test.ts`
  checks the stored expression against the regex over every one-character
  edit of the valid shape.
- **SBI Shinsei branch**, each predicate with its evidence in the parser
  (`packages/parsers/src/parsers/sbi-shinsei-top-balances-and-activity.ts`)
  and the synthetic fixture
  (`tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/top-accounts-balance-and-activity.json`):
  - before ranking: `source_id='sbi-shinsei-bank'`, parser
    `sbi-shinsei-top-balances-and-activity` (the only SBI Shinsei parser that
    writes transactions), and a non-empty `external_id` (the parser requires
    `txnReferenceNo`);
  - on the newest capture of the id: `status IS NULL` (the parser sets none),
    `currency='JPY'` (the statement totals are yen; an activity block of a
    foreign-currency account carries that currency),
    `_kogane.amountSignSource='debit'` (the provider's own debit column) and
    `coefficient LIKE '-%'` (a zero debit is stored unsigned, `0`, so it is
    excluded, as is every credit);
  - `debit_date` is `as_of` when it is exactly `YYYY-MM-DD` (ten bytes), which
    the parser always writes, and NULL otherwise.

  No predicate the plan listed had to change. Currency, status and sign are
  judged after ranking, as SMBC's are, so a newer capture that fails them
  withdraws the row rather than letting an older one stand.

- The sweep selects debits by `debit_date` within three days of the due date
  and uses it as the debit's date, instead of the SMBC regex. The pairs it
  proposes are the same for SMBC; what differs is that an SMBC row of any other
  `as_of` shape inside the window (a date-only or a timed `as_of`) is no longer
  read and then skipped, so it no longer takes one of the bank read's 1,000
  rows per due date and no longer counts in the sweep's `scanned`.
- `card_settlement_readiness` keeps its 0044 text: it reads the view by id and
  keys reservations by `bank_key`, whose shape is the same for both adapters.
  Its keyed form (`cardSettlementReadinessCtes`, #256) restates the view's
  select, so its `ready_debits` becomes the same two-branch union over the
  candidates' partitions.
- Candidates still come only from an equal amount within ±3 days, and still
  need explicit ownership and a human decision.

## Consequences

- A card statement paid from SBI Shinsei becomes reviewable; nothing is
  accepted automatically, and no card is assigned to a bank by configuration.
- A debit posted more than three days from the due date (a long holiday run,
  or a bank that posts late) produces no candidate. This is a stated limit.
- Production at the time of writing holds no published SBI Shinsei
  transaction observation: every capture of the activity dataset was rejected
  by the parser (closed code `parser_rejected`), so the adapter admits nothing
  until the parser accepts the stored captures. The check the plan asked for
  counted zero SBI Shinsei debits and zero equal-amount statement matches.
- Mizuho and Sony remain a later, separate adapter class that would need a
  stable row identity first.
- The union adds one branch to every read of the view; the sweep's bank read
  and the readiness CTEs still rank whole partitions per request, as before.

## Verification

- `packages/read-model/test/card-bank-debit-facts.test.ts`: the SMBC branch
  returns exactly the frozen 0044 view's rows on random stores and on the scaled
  store; one row per provider key across both adapters; `debit_date` as stated.
- `packages/read-model/test/card-settlement-readiness.test.ts`: the keyed CTEs
  equal the view on random stores that now draw SBI Shinsei rows (credits, zero
  debits, foreign currencies, statuses, other sign sources, timed dates,
  re-observed ids), and five SBI Shinsei mutations of the CTEs are caught.
- `services/processor/test/card-settlement-sbi-shinsei.test.ts`, through the
  deployed parser on the fixture and variants of it: an equal-amount statement
  produces a candidate; credit, zero and foreign-currency rows are excluded;
  re-observing a `txnReferenceNo` is one payment; unknown ownership cannot be
  accepted; an accepted SBI Shinsei debit reserves the statement against an
  SMBC one; an allocation of the provider id blocks its review.
- The scaled store debits MyJCB bills from SBI Shinsei, re-observed over a
  three-day window, and every scale and differential test of the sweep, the
  readiness readers and the commit guard compares with the shipped text.
  `services/processor/test/card-settlement.test.ts` (SMBC) passes unchanged.
  Synthetic data only.

## 2026-10-09: release 0.1.3 records the provider-id origin

- Status: proposed (accepted when the PR that carries it merges)
- Carried by: `packages/parsers/src/parsers/sbi-shinsei-top-balances-and-activity.ts`
  (0.1.3), `packages/domain/src/event-families.ts`
  (`transaction-family-registry-v3`)
- Deployed: by the CD release of the commit that merges this PR (`deploy.yml`
  releases every green CI run on main); the owner's merge is the deploy
  decision, and with it the repair-lane re-parse. Rows of 0.1.2 runs stay refused; once the repair lane has re-parsed a capture under 0.1.3, its 0.1.3 rows are admissible instead.

### Context

Since ADR 0054 G1b a human-adopted writer refuses an id whose row records no
origin (rule 2, `identity_origin_unrecorded`). Parser 0.1.2 writes the
provider's `txnReferenceNo` as the row's external id exactly as received, with
no synthesis, but records no `_kogane.identityOrigin`, so every SBI Shinsei
debit acceptance is refused, although the registry already declares its
provider identity function (`sbi-shinsei-txn-reference-no-v1`, unique within
one resolved account).

On 2026-10-09 the owner confirmed, from read-only aggregate queries of the
stored activity captures, that in the captured range every reference was
re-observed across many captures, none was missing, the stored external id
always equalled the reference, no reference appeared twice within one
capture, and no reference carried different provider fields in different
captures. That is evidence about the captured range only: **nothing shows
that the provider never reuses a reference later**, and the declared scope
stays "unique within one account", unverified beyond what was captured (ADR
0054, Not verified).

### Options considered

1. **A parser release that records the origin** (chosen by the owner): the
   row itself states where its id comes from, as SMBC's rows do, and the
   already-declared function admits it.
2. **An owner-approved exception to rule 2** treating this ADR's reviewed
   adapter evidence as the declared origin. Not taken: stored rows would be
   admitted while their own evidence states no origin.
3. **Leave SBI Shinsei debits refused.** Not chosen by the owner.

### Decision

- `sbi-shinsei-top-balances-and-activity` 0.1.3: every activity row records
  `_kogane.identityOrigin: "provider-id"`, right after `amountSignSource`,
  the key and value `smbc-direct-transactions` records. Nothing else changes:
  the external id, the source account `sbi-shinsei:<accountNo>`, the sign,
  the accepted shapes and every other field are 0.1.2's (the frozen 0.1.2
  coverage-contract outputs plus that key equal the 0.1.3 output byte for
  byte). The shared `sbi-shinsei-common.ts` is untouched, so the other SBI
  Shinsei parsers keep their versions and digests; only this parser's digest
  moves, under the new version (migration 0028 refuses a changed digest under
  an old version).
- Transaction-family registry v3: the entry records its origin under
  `identityOrigin` (stage A reads `provider`), its card settlement membership
  is `supported` again, and `identity_origin_unrecorded` leaves its
  bank-movement and fx-exchange memberships (still unsupported for their other
  reasons). The provider identity function is unchanged.
- The admission still reads each stored row (`rowOriginBasis`): a row a 0.1.2
  run stored is refused with `identity_origin_unrecorded`, whatever the
  registry says about the parser.
- No migration. The activity dataset's snapshot policy row pins no parser
  version (0025), and no CORE view, read-model query or readiness CTE pins
  this parser's version: migration 0052, `card-settlement-readiness.ts`,
  `sql.ts`, `snapshot-query.ts` and the observation-shared semantics pin it by
  name, so 0.1.2 and 0.1.3 observations are read alike.

### What deploying it does

Production was not read for this change; the following is what the code and
the synthetic tests show.

- **Deploying is the re-parse.** After deploy the repair lane's cyclic scan
  creates a 0.1.3 job for every stored activity capture without an operator
  step ([observations](../observations.md#sbi-shinsei-activity-rows-record-the-provider-id-origin-activity-parser-013)).
  The lanes take the parsers from the deployed registry; a release pointer
  naming 0.1.2 falls back to 0.1.3 (`laneParsers`, which skips a pointer
  naming a version the build does not carry), so the outcome does not depend
  on it. So the owner's merge, which deploys, is also the decision to
  re-parse.
- **Gradual.** The repair scan reads 100 artifacts per sweep
  (`REPAIR_SCAN_PAGE`) in artifact-id order and runs jobs at the lane's
  budget; new captures are parsed under 0.1.3 at once by the incremental
  lane. Until a reference's newest capture has been re-parsed or re-captured,
  its adapter row stays a 0.1.2 row, and its debit stays refused.
- **Append-only evidence (the only update is the existing supersession
  marker).** Each job registers release 0.1.3 in `parser_releases`
  beside 0.1.2's row, and writes a new `parse_runs` row with new
  `transaction_observations`, `balance_observations` and
  `valuation_observations` rows (their `observation_decimal_values` by
  trigger) and its `parse_coverage_claims` row; the identity sweep then
  identifies the new run like any other. The publication pointer
  `published_parse_runs` moves to the 0.1.3 run through an appended
  `publication_events` row; the 0.1.2 run is marked superseded (the
  publish batch updates `parse_runs.superseded_by_parse_run_id`, as for every
  release) and its observation rows stay stored, unchanged. Each capture's
  balances and valuations are republished under new observation ids with
  identical values.
- **Which rows become admissible.** Only rows a 0.1.3 run stored: every SBI
  Shinsei activity transaction row of those runs records the origin, and of
  them the debit adapter still admits only the provider's own non-zero JPY
  debits. Rows of 0.1.2 runs stay refused. Admission means rule 2 no longer
  refuses; it adopts nothing.
- **Card settlement readiness.** `card_bank_debit_facts` keeps the newest
  capture of each reference, newest row first, so the 0.1.3 row of a reference
  replaces its 0.1.2 row as the adapter row. Candidates already proposed cite
  0.1.2 rows: their `bank_current` becomes 0 and they stay stored, so every
  existing proposed SBI Shinsei candidate stays in the review list with the
  blocker `bank_debit_changed` beside its 0.1.3 twin. The sweep
  (its cursor wraps) proposes new candidates citing the 0.1.3 rows under the
  same `bank_key` (the 5-tuple has no parse run) and the same alias class. On
  the new candidates `bank_current` is 1 and the other flags read the holders
  as before.
- **Settlements accepted before G1b** are unchanged: their decisions, events
  and allocations are not touched and nothing withdraws them. They hold their
  `bank_key` as legacy holders, so a new candidate of the same reference reads
  `allocation_available` 0 and `claim_available` 0 and its plan is refused
  with `stale_context`. Their own readiness reads `bank_current` 0 because
  their cited row is no longer the newest capture; that is not a withdrawal.
  A G1b withdrawal releases them, after which a human may accept the 0.1.3
  candidate under its alias class.
- **No adoption by itself.** The sweep only proposes; an acceptance still
  needs explicit ownership, a plan, a human approval and a commit, and agents
  never approve. Stage A reconciliation: the 0.1.3 rows enter the provider-id
  partial index `reconciliation_provider_ids` (0064), but SBI Shinsei is in no
  reconciliation slice, so nothing is proposed from them; the Vpass and MyJCB
  stage A pages walk past them in that index.
- **Risk: a reused reference.** If the provider ever reuses a reference for a
  different payment in the same account, both payments share one `bank_key`
  and one alias class. The adapter then keeps only the newer capture (the
  older payment drops out of `card_bank_debit_facts`; the 0052 ranking already
  did this), and a candidate of the reused reference is reserved by a holder
  of the earlier one: the plan answers `stale_context` on the 0044
  reservation, with `claim_available` 0 behind it (`economic_claim_held` when
  that is the only failing flag), and a commit planned before the holder
  existed is refused by the 0070 triggers, which raise `alias_conflict` when
  both the key and the class are held (the trigger order on workerd and
  bun:sqlite, ADR 0054). Rule 3's `duplicate_unresolved` is decided by
  planners against stored holders (G3) and no settlement code raises it today.
  Either way nothing is counted twice; the later payment cannot be accepted
  under that reference until a person resolves it.

### Verification (synthetic data only)

- `packages/parsers/test/sbi-shinsei-parsers.test.ts`: the release is 0.1.3;
  the two contract fixtures parse to the frozen 0.1.2 output plus the origin
  on each of their 12 transaction rows (key order checked, every other row
  byte for byte); credits, zero debits and foreign-currency rows record it,
  balances and valuations do not; the 0.1.3 debit is admitted
  (`rowOriginBasis` `provider-id`, alias class
  `sbi-shinsei-txn-reference-no-v1`) and the frozen 0.1.2 debit refused
  (`identity_origin_unrecorded`), with one alias class for both; the declared
  function is unchanged.
- `packages/parsers/test/coverage-contract.test.ts`: the frozen files keep
  their bytes; the declared 0.1.3 delta is applied before the byte
  comparison. `git diff` of `digests.ts`: one source digest and one release
  changed; `parser-digests.test.ts` passes. `event-families.test.ts` (parsers and domain): the registry v3
  entry matches the fixture rows; the economic-events family table follows it.
- `packages/application/test/card-settlement-plan.test.ts`: a 0.1.3-shaped
  SBI Shinsei bank row is planned; the 0.1.2-shaped one is refused.
- `services/processor/test/card-settlement-sbi-shinsei-origin.test.ts`: a
  capture stored by a 0.1.2 run, its refused acceptance, a pre-G1b acceptance,
  the repair lane's 0.1.3 re-parse beside it (0.1.2 rows unchanged, run
  superseded, pointer moved by an appended event, nothing adopted), the new
  candidate under the same `bank_key` reserved by the pre-G1b holder, the
  acceptance after its withdrawal claiming the debit under the declared alias
  class, and a reused reference refused against that holder.
  `card-settlement-sbi-shinsei.test.ts`: the deployed parser's debit is
  admitted.

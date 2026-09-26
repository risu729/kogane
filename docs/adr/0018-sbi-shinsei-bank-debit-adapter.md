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
  globs the date part only and compares the time part as text; the
  Miniflare-backed processor test caught the longer pattern, which
  `bun:sqlite` accepts.
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
    foreign-currency account carries that currency), `_kogane.amountSignSource
='debit'` (the provider's own debit column) and `coefficient LIKE '-%'`
    (a zero debit is stored unsigned, `0`, so it is excluded, as is every
    credit);
  - `debit_date` is `as_of` when it is `YYYY-MM-DD`, which the parser always
    writes, and NULL otherwise.
    No predicate the plan listed had to change. Currency, status and sign are
    judged after ranking, as SMBC's are, so a newer capture that fails them
    withdraws the row rather than letting an older one stand.
- The sweep selects debits by `debit_date` within three days of the due date
  and uses it as the debit's date, instead of the SMBC regex.
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

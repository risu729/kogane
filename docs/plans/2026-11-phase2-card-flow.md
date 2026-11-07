# Plan: Phase 2 — card usage → statement → bank debit

- Status: **accepted** by the owner on 2026-11-07 (03:58 UTC): "all units as recommended; the fine order does not matter". Each unit is its own pull request; design changes inside a unit still get an ADR.
- Written: 2026-11-06 23:40 UTC against main `54e2d7b`, revised after an independent subagent review (23:55 UTC).
- Roadmap: [Phase 2](../roadmap.md#phase-2--card-usage--statement--bank-debit-current-milestone). Issues [#543](https://github.com/risu729/kogane/issues/543), [#547](https://github.com/risu729/kogane/issues/547), [#548](https://github.com/risu729/kogane/issues/548); sources [#445 Vpass](https://github.com/risu729/kogane/issues/445), [#444 MyJCB](https://github.com/risu729/kogane/issues/444).

## 1. Where production was (read-only counts, 2026-11-06 ~23:30 UTC)

CORE D1 `kogane-raw-evidence`, aggregate queries only.

Current statement totals (`card_statement_facts`):

| source | producer              | statements | accounts | periods            |
| ------ | --------------------- | ---------- | -------- | ------------------ |
| myjcb  | collector-myjcb       | 5          | 1        | 2025-11 .. 2026-11 |
| myjcb  | collector-r2-importer | 3          | 1        | 2025-11 .. 2026-09 |
| vpass  | collector-r2-importer | 27         | 5        | 2025-06 .. 2026-09 |

No collector-era Vpass statement is parsed (ADR 0022 withholds the dataset), so Vpass data stops at the importer's last run (2026-09-10).

Settlement candidates (`card_settlement_candidates` + `card_settlement_readiness`):

| statement | bank             | candidates | statements | with statement and bank both current |
| --------- | ---------------- | ---------- | ---------- | ------------------------------------ |
| myjcb     | smbc-bank        | 267        | 6          | 21 candidates / 6 statements         |
| vpass     | smbc-bank        | 133        | 21         | 77 candidates / 21 statements        |
| vpass     | sbi-shinsei-bank | 26         | 1          | 3 candidates / 1 statement           |

- No candidate has ever been decided (0 accepted, 0 rejected, 0 withdrawn).
- `ownership_current` is 0 for every candidate: `card_settlement_fact_ownership` has 0 rows with an owner (18,141 balance and 63,370 transaction rows, all without owner). Ownership is the only blocker left on the current candidates; `allocation_available` is 1 everywhere.
- MyJCB debit-account evidence: 120 rows `supports`, 150 `not_proposed`, 0 `names_other_account`. The review page does not show it.
- Latest `card_settlement_sweep` tick: scanned 211, unmatched `statement_not_comparable` 5, `no_debit_in_window` 2, `no_equal_amount_debit` 1.
- Vpass tokens: importer 6 distinct `vpass-card-v2-` tokens (the one-time rewrite applied), collector 7; 6 of the collector's 7 equal an importer token. The 7th is a card only the collector has seen.
- SBI Shinsei candidates: 22 cite parser 0.1.2 rows (none current; acceptance refused `identity_origin_unrecorded`), 4 cite 0.1.3 rows, 3 of them current. So a Vpass → SBI Shinsei acceptance is possible without a re-parse.
- Purchase side: per economic-events.md (counts of 2026-09-24, to be recounted in 2a) no installment, revolving or bonus wording was seen; 230 Vpass web rows have an empty payment type and are `payment_type_unsupported`. Such rows are skipped as `payment_type_unsupported`, but /purchases shows only one total `unrecognizedCurrentRows` and a static list of unsupported shapes.

So the done-when's representative cases already exist as candidates: a Vpass card with an SBI Shinsei debit, Vpass cards with SMBC debits, and the MyJCB root with SMBC debits. What is missing is mostly (a) the owner's ownership records and decisions, which agents may not make, (b) evidence and reasons the review UI does not show, and (c) Vpass freshness.

## 2. Units (one PR each)

### 2a Baseline record (docs only)

Record the counts above and the chosen representative cases (by source/bank/period shape, never amounts) in docs/card-settlements.md and the Phase 2 section of the roadmap. Recount the payment-type shapes (counts only) so the 2026-09-24 numbers are current. Update [#543](https://github.com/risu729/kogane/issues/543) with a progress comment.

### 2b Show the provider-stated debit account on the review page (code)

Add the latest `card_settlement_debit_account_evidence` outcome (`supports` / `names_other_account` / `not_proposed` + closed reason) to the review contract (`packages/observation-shared/src/card-settlement-contract.ts`), the API and the `カード照合` page. Read-only evidence; it changes no eligibility (INV07). This is the main evidence the owner will look at before accepting a MyJCB candidate. Listed as a limit in card-settlements.md today.

### 2c One current candidate per statement on the review list (code)

267 candidates for 6 MyJCB statements and 133 for 21 Vpass statements. The candidate digest covers the facts, including both parse runs, the account and the owner (services/processor/src/card-settlement-job.ts:224-292), so every new capture, re-parse or ownership record makes a new candidate; recording ownership in 2g will add another for every statement. The review list shows every candidate newest first with no grouping (packages/application/src/query/card-settlements.ts:96-99). Group by statement and show the ready one first, the stale ones collapsed under it. No candidate is deleted (append-only). The query change gets the cost and plan checks of card-settlements.md#cost; no migration expected.

### 2d Closed reasons for unrecognised card rows on /purchases (code, [#547](https://github.com/risu729/kogane/issues/547))

Replace the single `unrecognizedCurrentRows` count with counts per closed skip code (`payment_type_unsupported`, `installment_amount_differs`, `payment_split_unknown`, `refund_shape_unverified`, ...) per source, using the 12 codes of `CARD_USAGE_EXCLUSIONS` (packages/domain/src/card-purchase.ts:106-119). The classifier runs in TypeScript in the lane and stores no per-row reason, so this either runs the classifier over the current usage rows at read time (bounded, with a cost check) or stores per-row reasons (a migration; the owner allowed one if it is the better design). Installment, revolving and bonus stay unsupported (ADR 0004 forbids guessing). No recognition change.

### 2e Statements without a candidate, with their reason (code, [#548](https://github.com/risu729/kogane/issues/548), [ADR 0074](../adr/0074-card-statement-allocation-planner.md))

Today unmatched statements are only tick counts. Show each statement that has no candidate on the review page with its closed reason, and, for `no_equal_amount_debit`, the ADR 0074 planner's read-only answer (`multiple-debits` proposal listed but not acceptable, `in_window_debits_below_total`, `debit_above_total`, `candidate_not_unique`). Needs policy values from the owner (see question 3) and a call path: the planner runs at read time over the same bank reads the sweep makes (no lane, no table, no migration), with the cost checks. Refund and zero statement totals get their own closed code (`statement_total_refund_or_zero`) instead of `statement_not_comparable`, so refund allocation is visibly unsupported. Accepting a multi-debit allocation stays out of scope: the acceptance writer claims one debit, and how a provider shows a partial or split payment is unobserved. Refund or zero statement totals are listed as `statement_not_comparable`.

### 2f Release the Vpass collector's statement pages (code + ADR, [#445](https://github.com/risu729/kogane/issues/445); approved 2026-11-07)

The real release condition is in ADR 0023's amendment, updated by ADR 0029: (a) the collector's tokens equal the importer's, which migration 0063 made true for 6 of the 7 cards; and (b) the persist diagnostics show the collector's card units reaching `complete`. (b) is not checked yet; I check it read-only first. The "binding key" wording in descriptors.ts:390-404 is stale and is corrected in this PR.

Mechanism: moving the rule into `ARTIFACT_DATASETS` changes the frozen `terminal-registration-v2` table. Fetch artifacts are append-only, so the collector-vpass terminals already registered keep dataset NULL; parsing them needs a `terminal-registration-v3` bump with carry-over, which re-walks every source's terminals (a cost and blocked-run analysis like ADR 0022's, and a change to the `scripts/artifact-datasets.test.ts` pin). Effects to verify on synthetic data and then with counts:

- a card-month read by both producers retires the importer-era purchase event and recognises the collector's on the same (rewritten) entity, so the total is not doubled; recognition keys carry the producer, so every re-captured card-month changes key once;
- the 7th card becomes a new account (owned by default, section 4), and all its months appear as new purchases;
- re-captured Vpass statements change producer, so a Vpass settlement accepted before 2f would go stale (`statement_changed`).
  Hard to undo and touches every source's registration, so it gets its own ADR (the owner approved the release on 2026-11-07, 03:58 UTC).

### 2g Settlement decisions by an agent, and verification (code + ADRs)

Superseded on 2026-11-07 by the owner's decisions in [section 4](#4-owner-decisions-2026-11-07): the owner does no operator step.

1. **Ownership default** (its own ADR): an account with no recorded ownership claim is treated as the owner's, sole personal, through a closed, versioned evidence reference (`ownership-default:owner-v1`). A recorded claim, a rejected or dated claim, or a `contradicts` relation on the account takes precedence, and the default is never applied to it. The MyJCB root (`card-statement-aggregate`) and the importer- and collector-era identities are each an account under this rule; nothing merges them.
2. **Settlement accept / withdraw / reject through MCP**: catalogue operations over the same application commands the `カード照合` page uses (plan, simulate, approve, commit), under a delegation in `MCP_DELEGATIONS`, with an audit record. This follows the MCP-first and UI-parity decisions recorded by the roadmap thread's ADR; MCP never writes the database directly.
3. **Verification** (counts only): one Vpass candidate (SBI Shinsei 0.1.3 or SMBC debit) and one MyJCB candidate (`collector-myjcb` statement, SMBC debit) accepted by the agent; one withdrawn, and a fresh candidate accepted or a wrong one rejected (a withdrawn candidate cannot be accepted again: acceptance requires `proposed`); /purchases figures unchanged (`settlementAddsPurchaseExpense` false) with the 利用 → 請求 → 引落 chain; `/api/v2/activity?basis=cash-movement` shows the accepted debit once and the withdrawal releases its claim. Recorded in card-settlements.md and the roadmap; this closes the done-when.

Order: 2a, 2b, 2c, 2d in parallel threads now; 2e after question 3; 2f after approval. 2g's verification after 2b and 2c. The MyJCB part can run before 2f; the Vpass part waits for 2f, or uses an importer-era month the collector does not re-capture, so the acceptance does not go stale.

## 3. Questions for the owner (answered 2026-11-07 03:58 UTC)

1. Order and scope: accepted as recommended; the fine order does not matter.
2. 2f: go ahead with releasing the Vpass collector's statement pages.
3. 2e: the planner's read-only display uses a window of ±3 days around the due date and at most 3 debits per allocation.
4. 2g: replaced by section 4.
5. 2d: use a migration if it is the better design.

## 4. Owner decisions (2026-11-07)

- 03:59 UTC: an account whose owner is not recorded may be assumed to be the owner's.
- 03:59 UTC: settlement decisions are delegated to agents (changing the invariant that agents never approve, and adding an MCP delegation), rather than the owner recording ownership and an automatic lane accepting.
- 03:59 UTC: everything the screens can do, an agent must be able to do through MCP.
- 04:00 UTC: MCP does not touch the database directly; MCP and the screens use one common API.

The last two are project-wide and are recorded in the MCP-first ADR the roadmap work carries; AGENTS.md's invariants change with it. Until those ADRs merge, AGENTS.md as written still applies.

# ADR 0087: An account without recorded ownership is the owner's by default, for card settlement

- Status: proposed
- Date: 2026-11-07
- Issue: part of [#543](https://github.com/risu729/kogane/issues/543), unit 2g.1 of the
  [Phase 2 plan](../plans/2026-11-phase2-card-flow.md#2g-settlement-decisions-by-an-agent-and-verification-code--adrs)
- Decided by: the owner, 2026-11-07 03:59 UTC: "an account whose owner is not
  recorded may be assumed to be the owner's"
  ([plan, section 4](../plans/2026-11-phase2-card-flow.md#4-owner-decisions-2026-11-07))
- Carried by: `packages/domain/src/ownership-default.ts`,
  `packages/read-model/src/card-settlement-ownership.ts` (`ownerDefault`),
  `packages/read-model/src/card-settlement-readiness.ts`,
  `packages/read-model/src/card-settlement-bank-debits.ts`,
  `services/processor/src/card-settlement-job.ts`,
  `packages/application/src/query/card-statements-unmatched.ts`,
  `apps/web/src/reconciliation-display.tsx`
- Amends: [ADR 0034](0034-card-settlement-automation-prerequisites.md) (its
  stance that no ownership is inferred, and the self-declaration amendment's
  exclusion of aggregate accounts, for this default only)

## Context

A card settlement candidate can be accepted only when the card account's
`liable_party` and the bank account's `beneficial_owner` name the same party
(`ownership_current` in `card_settlement_readiness`, re-checked inside the
commit's receipt guard). Owners come from `card_settlement_fact_ownership`
(migration 0044): one current, accepted, timeless relation from the account.

On 2026-11-06 production had no ownership relation on any account
(`card_settlement_fact_ownership`: 18,141 balance and 63,370 transaction rows,
none with an owner), so every one of the 426 candidates was blocked on
ownership alone ([plan, section 1](../plans/2026-11-phase2-card-flow.md#1-where-production-was-read-only-counts-2026-11-06-2330-utc)).
The only way to clear it was the `カード照合` ownership review, one candidate
side at a time, by the operator. This is a single-user system and the owner
decided at 03:59 UTC on 2026-11-07 that an account whose owner is not recorded
may be assumed to be the owner's, and that the owner does no operator step for
it.

## Options considered

1. **Record a self-declaration for every account by a lane or a script.**
   Writes thousands of decisions nobody reviewed, and each new account needs
   another one; a later correction must supersede a decision that was never a
   judgement. Rejected.
2. **Treat a missing owner as the owner's in the reads, with a closed,
   versioned evidence reference, and never over anything recorded.** Nothing
   is written; a recorded claim (of any status), a contradiction or an
   unresolved mapping takes precedence, and recording one is the existing
   review. Chosen.
3. **Drop the ownership condition from acceptance.** Loses the check that a
   card and a bank account recorded as different parties' are not settled
   against each other. Rejected.

## Decision

1. **The default.** In the card settlement reads (the sweep's statement and
   bank reads, the read of statements without a candidate, which shares the
   bank read, and the keyed readiness CTEs that the review list, the review,
   the settlement plan, the ownership review, the shadow count and the commit
   guard use), a statement or debit row whose account the ownership view
   resolves (one current mapping to one account) and whose owner it leaves
   null gets the party `party:owner` and cites `ownership-default:owner-v1`
   with its account mapping (`[account_mapping:<id>, ownership-default:owner-v1]`),
   unless one of these holds for any identity of the row:
   - a `liable_party` or `beneficial_owner` relation from the account
     (`<id>` or `account:<id>`), of any status, dated or not, the other role
     included;
   - a `contradicts` relation naming the account (either spelling) or the
     identity's source account (`source_account:<id>`), at either end;
   - an `unresolved` current mapping, or an `unresolved` account.
     These are the self-declaration fallback's history and contradiction checks
     (ADR 0034 amendment) without its single-account scope: the owner decided
     that a MyJCB root (`card-statement-aggregate`) and the importer- and
     collector-era identities are each an account under this rule. Nothing
     merges two accounts, and the default never crosses `same_account` or
     parent/child links.
2. **One party.** `party:owner` is an ordinary party reference: the
   ownership review's operator label `owner` names the same party, as the same
   identifier always does. A side the operator recorded as another party is
   `different` from a defaulted side, and the candidate stays blocked.
3. **Precedence and staleness.** A candidate cites the evidence its owners had
   when it was proposed. Recording any of the blockers above changes the
   current owner's evidence, so a candidate citing the default is no longer
   `ownership_current` and its planned acceptance is refused inside the
   receipt guard; the next sweep proposes a new candidate with the recorded
   owner, or with no owner. Nothing is rewritten (append-only).
4. **Still a proposal.** The default does not accept anything. A candidate it
   makes acceptable still needs an accept command through the change
   lifecycle (plan, simulate, approve, commit) by a principal allowed to
   approve, and the decision cites `ownership-default:owner-v1` among its
   evidence. Who may approve is unchanged by this ADR
   ([ADR 0084](0084-mcp-operator-authority-without-delegation.md)).
5. **Where it is not applied.** The purchase, dated-state and economic-row
   readiness reads use the same ownership CTEs without the default: the first
   two read only the account, and economic-row readiness still reports
   `ownership_unresolved` for every row. The migration 0044 views
   `card_settlement_fact_ownership` and `card_settlement_readiness` are
   unchanged (changing a view is a migration); no shipped read uses them, and
   the App only checks that they exist.

## Consequences

- Every candidate proposed before this ships has `ownerRef` null on both sides
  and stays blocked (`owner_not_established`). The sweep's cursor wraps, and
  each statement it reaches again is proposed anew with the default
  (a new digest, so a new candidate), as a recorded ownership claim would
  have done: one more candidate per equal-amount debit in the statement's
  window, which the review list groups under its statement.
- The `カード照合` review shows the default's reference among the ownership
  evidence and, when it is cited, says that an account without a recorded
  owner is treated as the owner's, that the name is not verified, and that
  recording an owner makes the candidate need a fresh review.
- The ownership review page (`口座の保有者と根拠を確認`) still lists only
  recorded claims; it does not say whether the default applies to a side.
  A limit.
- The operation catalogue has no settlement operation, so an MCP client
  cannot accept a candidate yet (plan 2g.2).

## Verification

- `packages/read-model/test/card-settlement-owner-default.test.ts`: on the
  random settlement stores, the CTEs with the default equal those without it
  on every row except the rows an independent oracle (over the views) says the
  default applies to, which get exactly the default party and evidence; then,
  for each blocker (a rejected claim of the other role, a dated claim from the
  prefixed account, a contradiction at the source account's far end or from the
  prefixed account, an unresolved remapping, a remapping to an unresolved
  account, a timeless accepted claim), the row loses the default. The plan
  reads only the named observations without table statistics.
  `card-settlement-readiness.test.ts` still proves the readiness CTEs without
  the default are the frozen text plus `claim_available`, and compares the
  shipped CTEs with the view on the random stores (whose candidates cite no
  default).
- `services/processor/test/card-settlement-owner-default.test.ts`: the sweep
  proposes a defaulted candidate, which is accepted and withdrawn through the
  commands with the default among the decision's evidence; a contradiction
  recorded after planning makes the commit refuse with no receipt, and the
  next candidate has unknown ownership and is refused at plan.
- `card-settlement.test.ts` and `card-settlement-sbi-shinsei.test.ts`: a
  recorded claim makes the defaulted candidate stale and the next candidate
  cites the claim; `ownership-review.test.ts`: claims recorded through the
  ownership review give a new candidate beside the defaulted one;
  `card-debit-account.test.ts`: the provider-stated debit account still adds
  no ownership evidence, the default does.
- `card-settlement-bank-cache-schema.test.ts`: the sweep's bank read is the
  frozen pre-cache text with only the ownership CTEs swapped for the default's.
- `apps/web/test/card-settlement.browser.test.ts`: the review explains a
  defaulted ownership and not a recorded one.

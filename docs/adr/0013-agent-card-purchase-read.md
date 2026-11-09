# ADR 0013: Give agents card purchases through a separate read-only tool

- Status: accepted
- Date: 2026-09-25
- Implemented by: #245
- Carried by: [agent API](../agent-api.md#card-purchase-explanation),
  `packages/application/src/query/purchases-explain.ts`,
  `validAgentCardPurchasePage` in
  `packages/observation-shared/src/card-purchase-contract.ts`

## Context

The operator's purchases page explains what a card charge became, which
statement and bank debit settled it, and which pending-to-posted candidates
are open ([ADR 0002](0002-card-purchase-recognition.md)). Agents needed the
same answer without gaining the ability to decide links, which are
human-approved changes.

## Options considered

No repository document records this comparison; option 1's reason is
inferred for this record from what
[agent API](../agent-api.md#card-purchase-explanation) states about scoped
grants: "The page cannot yet be recomputed inside a narrower perimeter — its
events and statements are keyed by resolved account rather than by the source
accounts a scope lists, the settlement it shows cites a bank debit of another
source, and its unrecognised-row count spans every card source — so a listed
grant gets no page rather than a page computed outside it (SC18)."

1. A new `kogane.financial.query` intent. Rejected (inferred): intents answer
   inside a grant's source and account perimeter, which the purchases page
   cannot yet be recomputed inside.
2. A separate tool over the operator page's own query. Chosen.

## Decision

- `kogane.purchases.explain` (`POST /api/agent/v1/purchases.explain` and the
  MCP tool) calls `queryCardPurchases` and returns the operator page's
  `CardPurchasePage`, with `decisions: "operator-only"`.
- It requires `records.read` and a whole-store grant (`sources` and
  `accounts` both `"*"`); a listed grant is refused with
  `403 evidence_restricted` before anything is read. The grant's `maxRows`
  bounds paging.
- Review affordances are stripped: each candidate keeps its facts and
  blockers but loses `actions` and `relation`, and the contract refuses a
  candidate that carries either.
- Decisions stay with the operator: no agent grant can hold
  `interpretation.accept`, and the change lifecycle refuses an agent's
  approval and commit of a link review.
- The tool is listed and served only while `cardPurchaseRecognition` is.

## Consequences

- An agent reports a link worth reviewing by its `proposalId`; it is never
  handed a payload to plan with.
- A scoped grant gets no purchases at all until the page can be computed
  inside a scope.

## Verification

Application, observation-shared and App tests on synthetic data, including
that refusals read no store row and that the tool is absent with the flag off.

## Amendment: a delegated principal may receive the review affordances (2026-10-09, ADR 0063)

Status: accepted (ADR 0063 merged 2026-10-09 in #601).
Not implemented: `kogane.purchases.explain` still strips `actions` and
`relation` for every caller (`packages/application/src/query/purchases-explain.ts`),
so this ADR's decision holds for every caller.

[ADR 0063](0063-delegated-ai-operation-path.md) lets the owner delegate
decisions to their own MCP principal (`mcp-client:<sub>`) through
`MCP_DELEGATIONS`. For a caller holding the delegated capability
`commands.decide.relation`, `kogane.purchases.explain` keeps each candidate's
`actions` and `relation`, because that caller may plan and decide the link
through the common command layer (plan, approve with the plan digest, commit;
risk class R2). For every other caller — every agent without that delegation —
the decision above is unchanged: the two fields are stripped and the answer
says `decisions: "operator-only"`. The whole-store grant requirement is
unchanged.

## Amendment: no next page the grant cannot read (2026-11-08)

Status: accepted (merged 2026-11-08 in [#1173](https://github.com/risu729/kogane/pull/1173)).

**Context.** The decision above lets the grant's `maxRows` bound paging:
`offset + 50` above it is `413 budget_exceeded`. The answer still carried
the operator page's `data.nextOffset`, so a page could name a next offset
the same caller is refused (with `maxRows` 100, the page at offset 50 named
offset 100). The candidate reviews of `packages/application`
(`reviewInstrumentCandidates`, `reviewAccountCandidates`) already offer no
next page past `maxRows`.

**Options considered.** (1) Keep the offset and let the request fail:
rejected, an answer should not advertise a request it refuses. (2) Null the
offset silently, as the candidate reviews do: rejected for this read alone,
because a null offset then means two things (the last page, or the bound).
(3) Null the offset and say why in a closed code: chosen.

**Decision.** `kogane.purchases.explain` answers `nextPage`: `offered`
(`data.nextOffset` names the next page), `none` (no event follows, or one
`eventId` was read) or `budget_exceeded` (events follow, but the next
page's offset plus 50 would exceed the grant's `maxRows`; `data.nextOffset`
is then `null`). Everything else in `data` is the operator page's.

**Consequences.** With the whole-store grant every MCP client holds
(`maxRows` 1000) the deepest page offered starts at 950; a deeper filter is
read by statement `period`. The operator route is unchanged. The card
settlement reads and the unmatched statements still offer a page past
`maxRows`, an open limit recorded in the [agent API](../agent-api.md#card-purchase-explanation).

**Verification.** `packages/application/test/purchases-explain.test.ts`
("a next page the same grant would be refused is not offered, and says why"),
on 101 synthetic events.

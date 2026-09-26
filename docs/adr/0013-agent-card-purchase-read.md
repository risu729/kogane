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

1. A new `kogane.financial.query` intent. Rejected: intents answer inside a
   grant's source and account perimeter and re-check each row against it,
   while the purchases page cannot yet be recomputed inside a narrower
   perimeter (its events and statements are keyed by resolved account, its
   settlement cites a bank debit of another source, and its unrecognised-row
   count spans every card source).
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

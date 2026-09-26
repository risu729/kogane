# Agent instructions

Standing rules for any agent working in this repository. Each rule points to
the document that carries the detail; when this file and that document
disagree, the document is right and this file is corrected.

## Decisions live in the repository

- A pull request that decides or changes a design records it in the same PR:
  a new ADR in [`docs/adr/`](docs/adr/), in the format of
  [ADR 0001](docs/adr/0001-domain-axes.md) (status, date, context, options
  considered, decision, consequences, verification; `proposed` until the PR
  merges, then `accepted`), or an amendment to the ADR it changes.
- Plans live in [`docs/plans/`](docs/plans/) with a status header, like
  [the next-milestone plan](docs/plans/2026-09-next-milestone.md).
- A decision made in a conversation and not yet in the repository is not a
  decision.

## Every PR gets an independent review

A fresh reviewer that did not write the change (a separate agent) verifies
its claims by reading the code and running the tests, and fixes what it finds
before merge. The PR body states what the review checked.

## Invariants that do not bend

- Evidence is never rewritten: raw objects, fetch history and observations
  are append-only, and corrections are new revisions
  ([design: mutation policy](docs/design.md#mutation-policy)). Only tables
  classified `operational-mutable` (jobs, cursors, lane state) are mutable by
  design ([infra ledgers](docs/infra-ledgers.md#reading-the-classification)).
- Heuristics only propose; nothing changes adopted state until a decision
  accepts it (INV07, [ADR 0001](docs/adr/0001-domain-axes.md);
  [economic events](docs/economic-events.md#what-is-automatic-and-what-is-proposal-only)).
- Agents never approve or commit a change
  ([change lifecycle](docs/change-lifecycle.md#grants),
  [agent API](docs/agent-api.md#card-purchase-explanation)).
- Amounts are exact decimals added in `packages/domain` (`sumQuantities` and
  friends refuse mixed units and inexact values, INV03), not summed in SQL
  ([domain contracts](docs/domain-contracts.md)).
- Nothing is counted twice (INV06): one live holder per recognition key
  ([ADR 0002](docs/adr/0002-card-purchase-recognition.md)).
- Missing, unconfirmed or partial values are reasons, never zero (INV05).
- Logs and stored operational records carry counts and closed codes only,
  never provider text or amounts
  ([processor §6.1](docs/processor.md#61-tick-records),
  [observation lanes](docs/observation-lanes.md)).
- Provider semantics nobody has observed and the owner has not confirmed stay
  unsupported, never guessed
  ([ADR 0004](docs/adr/0004-payment-type-shapes-from-evidence.md)).
- Docs state what the code does today, never what it is meant to do; open
  limits are written down as limits ([roadmap](docs/roadmap.md#current-position)).

## Production data

Read production only with read-only aggregate queries (counts, shapes,
timestamps). Never copy an amount, merchant, account label or date into code,
tests, docs or PR text. Tests use synthetic inputs that mirror the observed
shapes ([ci](docs/ci.md); examples in
[economic events](docs/economic-events.md#single-payment-per-source) and
[ADR 0003](docs/adr/0003-relative-period-labels.md)).

## Toolchain

- mise is the task runner ([tooling](docs/tooling.md), [ci](docs/ci.md)):
  `mise run //<workspace>:ci`, `mise run ci:root`, `mise run fix`,
  `mise run ledger:schema`, `mise run //packages/parsers:digests`. Bun is the
  version mise pins.
- Migrations are additive and take the next free number; regenerate the
  schema ledger, classify every new table and update the migration pin in
  `services/processor/test/lanes.test.ts`
  ([infra ledgers](docs/infra-ledgers.md)).
- A query rewrite is proven equal to the shipped text: frozen legacy SQL,
  differential tests on scaled and random stores, and plan checks without
  table statistics ([read model: cost](docs/read-model.md#cost),
  [card settlements: cost](docs/card-settlements.md#cost); #239, #251).

## Where to look first

[README](README.md), [roadmap](docs/roadmap.md), [ADRs](docs/adr/),
[plans](docs/plans/), [observations](docs/observations.md),
[economic events](docs/economic-events.md).

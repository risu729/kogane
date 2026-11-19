# ADR 0124: Label a Vpass card with its product name at read time, from its newest bound credit observation

- Status: proposed
- Date: 2026-11-19
- Carried by:
  `packages/parsers/src/parsers/vpass-credit.ts` (`vpass-credit-snapshot`
  1.1.0, `extra._kogane.cardName`),
  `packages/domain/src/vpass-card-name.ts` (`vpassCardName`,
  `vpassCardLabel`),
  `packages/application/src/query/vpass-card-labels.ts`
  (`VPASS_CARD_LABELS_SQL`, `vpassCardLabels`, `vpassCardAccountLabel`),
  `packages/application/src/query/observation-organization.ts`,
  `packages/application/src/query/identity-pages.ts`,
  `packages/application/src/query/organized-filter-options.ts`,
  `packages/storage-d1/migrations/core/0103_vpass_credit_card_name_policy.sql`,
  [identity](../identity.md#display-only-labels),
  [Vpass source notes](../sources/vpass.md#2026-11-19-card-product-names-as-read-time-labels)
- Follows: [ADR 0105](0105-vpass-reported-credit-snapshots.md) (the credit
  snapshots and their reader), [ADR 0023](0023-vpass-collector-card-binding.md)
  and [ADR 0029](0029-data-classification-and-unkeyed-identity.md) (the
  durable card binding; names are consistency checks, never identity)
- Related: [ADR 0081](0081-ui-parity-through-mcp.md) (a screen and its MCP
  read answer through one service), [ADR 0004](0004-payment-type-shapes-from-evidence.md)
  (unobserved semantics stay unsupported),
  [#1357](https://github.com/risu729/kogane/issues/1357)

## Context

Every Vpass card account reads `Vpassカード明細`: the identity rule's fixed
label (`LABELS` in `packages/identity/src/other.ts`). With seven cards, a
balance list, the identity page and their MCP reads show seven rows with one
name, and only the `card-NNN` ordinal in the raw source account tells them
apart ([#1357](https://github.com/risu729/kogane/issues/1357)).

The stored `credit/authori.json` (`authoriShokaiVo.cardName`) and
`credit/revo.json` (`CustomizedRevoShokaiAnsPcDisplayServiceBean.cardName`) of
every daily credit run carry the card's product name. A counts-only production
read on 2026-11-19 found it in both files of all seven cards, the two files
agreeing on every card, seven distinct names, none with a digit or a masked
number. Revo also carries `userName`, the holder's name. Nothing parsed
`cardName` before this change.

## Options considered

1. **A new identity rule label** (`LABELS` or a per-card rule label). The
   label would be a mapping claim: a new identity policy version,
   re-identification of every Vpass parse, and a name frozen into the
   revision that first saw it. A product rename would need another
   revision. The name is not identity evidence (ADR 0029), so putting it in
   the mapping mixes a display claim into identity. Rejected.
2. **An owner-entered manual label per card.** Already possible through the
   change lifecycle and still wins below, but it asks the owner to type what
   the provider already states, and drifts when the provider renames a card.
   Kept as the override, not the default.
3. **A read-time display label from the newest credit observation**, the way
   `connectionAccountLabel` names a MoneyForward connection and
   `preferredInstrumentNames` names an instrument: current in every identity
   read mode, carrying its own evidence, never changing which account a row
   belongs to. Chosen.

For the parser, the choice was where the name comes from and what happens to
a name that could be sensitive:

- Authori only: a card whose Authori groups are all hidden gives no
  observation, so it would have no name. Revo always gives two rows.
- Refusing the artifact when the name looks like a card number would lose a
  valid financial snapshot over a display field. Omitting only the name keeps
  the snapshot.

## Decision

- `vpass-credit-snapshot` 1.1.0 copies the response's own `cardName` into
  `extra._kogane.cardName` of every row it emits: Authori rows from Authori,
  Revo rows from Revo. `vpassCardName` keeps a name only when it is a string
  of 1–64 characters after trimming, with no control or format character
  (`\p{Cc}`, `\p{Cf}`: a zero-width character could hide a digit run, a
  bidirectional override could reorder the label) and no run of four or more
  decimal digits in any script (masked card numbers included).
  Anything else is left out, never thrown: the snapshot is kept. A non-string
  `cardName` is still a shape change and fails as before. `userName` is never
  read.
- Migration 0103 advances only the complete 0102 default policy pin from
  1.0.2 to 1.1.0, as 0102 did, preserving every operator choice.
- `vpassCardLabels` resolves, for a bound Vpass card reference
  (`["vpass:card", <durable token>]`), the newest credit observation whose
  current sealed identity organizes it under that reference: newest credit
  fetch run first, then Authori before Revo, then the lowest observation id.
  Its name and its row's own ordinal give `<cardName>（card-NNN）`, checked
  again with `vpassCardName`. When that newest observation carries no kept
  name (a 1.0.x parse, an omitted name), the stored label stays; an older
  name is never reused. A run-scoped (unbound) ordinal reference is not
  labelled.
- `vpassCardAccountLabel` applies it only to a rule-mapped `vpass` reference;
  a manual label wins. The organization step (every organized row:
  `balances.read`, observation lists and details), the identity accounts
  page (`identity.read` `accounts`) and the filter options
  (`store.read` `filter-options`) apply it. A row it relabels carries
  `labelEvidence: { reason: "provider-card-name", origin: { kind: "balance", id } }`.
- Identity rules, `LABELS`, policy versions and stored mappings are unchanged.

## Consequences

- The published answers of `kogane.balances.read`, `kogane.identity.read`,
  `kogane.observations.list`/`get` and `kogane.store.read`, and their routes,
  change: a Vpass card's `label` becomes `<cardName>（card-NNN）` and the
  account gains the optional `labelEvidence`. This is a published tool
  answer change and needs the owner's approval before merge (decision D3 of
  the 2026-11-19 MCP proposal).
- The label is provider text and reaches an agent only under `data`, like
  every other label. Logs and operational records are unchanged: the parser
  emits no new log line, and nothing records the name outside the
  observation's `extra`.
- After deploy the incremental lane parses each new daily credit run at
  1.1.0, and the repair lane's cyclic scan re-parses the stored credit
  artifacts at 1.1.0
  ([observation lanes](../observation-lanes.md#repair-budget-and-drain-rate)).
  Until one of them gives a card a complete 1.1.0 credit run, that card
  shows `Vpassカード明細`. Because the 0103 pin is matched exactly
  ([parser coverage: snapshot policies](../parser-coverage.md#snapshot-policies)),
  the card also has no selected credit snapshot in that window (a temporary
  INV05 gap): its reported limit, outstanding and availability rows are not
  listed by `balances.read` or the reported state, and are never shown as
  zero (they are non-additive and enter no subtotal, ADR 0105). The reported
  state names the gap only per dataset: `coverage.containersWithoutSnapshot`
  carries `vpass-credit-snapshot` with `no_complete_snapshot_before_cutoff`
  while no card has a 1.1.0 snapshot, and once one card has one, a card still
  waiting is absent with no per-card reason. That per-card silence is an open
  limit shared by every exact parser pin (0059, 0084, 0102). The window
  closes for a card at its next successful daily credit run at the latest;
  the repair backlog (two credit artifacts per card per day since the
  snapshots began, ADR 0105) is far below the 28 jobs a tick the repair lane
  executes, but when the scan reaches them depends on where its cyclic cursor
  stands.
- Each organized page reads, through index `identity_observation_account`,
  every identity observation of each requested Vpass card reference (every
  kind, parse run and identity policy version: the card's statement rows
  included), keeps the balance rows of published `vpass-credit-snapshot`
  parses, and ranks them. No catalogue scan is added, but the rows read grow
  with each card's whole identity history, not only its credit rows; a
  composite index or a narrower access path is a follow-up if that read
  shows in the read budget.
- Units that list cards (the planned `upcoming` debit view and the
  `account-list` identity collection) reuse `vpassCardLabels` and show the
  same label.

## Verification

- `packages/parsers/test/vpass-credit.test.ts`: Authori rows carry Authori's
  name; Revo rows carry Revo's (a card with no visible Authori row is still
  named); names with four or more digits (ASCII, full-width, masked), empty,
  control-character, format-character (a zero-width space between digits, a
  bidirectional override) and over-long names are omitted with the snapshot kept;
  `userName` never appears in the output.
- `packages/parsers/test/coverage-contract.test.ts`: the frozen 1.0.x output
  plus exactly `_kogane.cardName` (`vpass-credit-snapshot@1.1.0` delta).
- `packages/storage-d1/test/vpass-credit-card-name-policy.test.ts`: only the
  complete 0102 default advances; operator fields survive; idempotent.
- `services/app/test/vpass-card-labels.test.ts` (real parser output over
  synthetic responses, trusted importer bindings): newest run and Authori
  first; Revo when Authori has no row; a newest run without a kept name
  falls back to the stored label; no credit observation keeps the stored
  label; a manual label wins; an unbound reference is not labelled; the
  identity and balance routes answer the same as their MCP reads and carry
  no holder name; the filter option is named; the query plan searches by
  index and scans none of the observation, parse or identity tables.

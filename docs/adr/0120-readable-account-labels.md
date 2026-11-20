# ADR 0120: One readable label per account, and a per-account identity list

- Status: proposed
- Date: 2026-11-20
- Tracking: [issue 1357](https://github.com/risu729/kogane/issues/1357),
  [issue 1414](https://github.com/risu729/kogane/issues/1414)
- Related: [ADR 0081](0081-ui-parity-through-mcp.md) (UI/MCP parity),
  [ADR 0105](0105-vpass-reported-credit-snapshots.md) (Vpass credit
  snapshots), [ADR 0114](0114-card-debit-account-answer.md) (card debit
  accounts), [account connections](../account-connections.md)

## Context

An agent asked "which account is this" could not tell from the reads
(2026-11-19, production, `kogane.identity.read` `accounts`):

- **Money Forward.** Each linked institution's reference that the connection
  review names shows `<institution>（MoneyForward連携）（個別口座未確定）`. The
  same account also has a reference of a second producer, moved onto it by a
  later `identity-value-rewrite` mapping revision, and that reference still
  shows the rule label `MoneyForward連携口座`. The review names only its own
  producer's references (`readAccountConnections` matches `producer_id`), so
  four accounts showed the plain label on most of their rows, including in
  `kogane.balances.read`.
- **Vpass.** Every card account is labelled `Vpassカード明細`
  (`packages/identity/src/other.ts`), so seven cards read the same. The
  provider's card product name (`cardName`) is in every stored
  `credit/authori.json` and `credit/revo.json` of the daily credit run (both
  agree on seven of seven cards; no digits, no masked number), and nothing
  parsed it.
- **No per-account list.** `accounts` has one line per source reference; an
  account with an importer and a collector reference is two lines, and nothing
  lists the accounts themselves.

The owner approved the proposal for this (units D and F of
`card-bills-status`, 2026-11-19 03:29 UTC).

## Options considered

1. **Label at read time, per account entity, in the shared organization step
   (chosen).** A display overlay like the connection label and the preferred
   instrument name: it never changes a mapping, an attribution or identity.
2. **Write the names into identity** (a new mapping revision with the card
   name, or `LABELS` per card). A mapping revision is evidence of how a
   reference is attributed; a label that comes from a later capture would make
   every name change a new revision and a re-identification. Rejected.
3. **Label per reference only** (extend the connection review to the second
   producer's references). The review proves which references belong to a
   connection for one producer; widening that proof is a separate decision.
   The account entity already joins the references, so naming the entity
   needs no new proof. Rejected for this purpose.
4. **Name Vpass cards from the statement pages.** Their header also carries
   `cardName`, but no Vpass statement has been parsed since 2026-09-10 (the
   count rule fixed separately), and statements are monthly. Rejected; the
   daily credit capture is the current source.

## Decision

### The label rule (`packages/application/src/query/account-labels.ts`)

`entityAccountLabels(sql, accountIds)` reads every current reference of each
account and returns, where one exists:

1. **Connection label.** If any reference of the account has a connection
   label through `connectionAccountLabel`, and every reference that has one
   agrees, the account shows it, suffix included: a connection is never a leaf
   account. Origin `connection`.
2. **Vpass card name.** Otherwise, for each Vpass reference, the newest bound
   credit capture: the highest fetch artifact whose published
   `vpass-credit-snapshot` parse has observations a sealed identity run
   attributed to the reference. Its observations' `extra._kogane.cardName`,
   when there is exactly one name and one card in that capture, gives
   `<card name>（card-00N）` with the collector's card unit key. When the
   references agree, the account shows it. Origin `card-name`.

An account with neither, or whose references disagree, keeps its mapping
label: a disagreement is never resolved by a pick. Captures are ordered by
fetch artifact, not by observation id, so a later re-parse of an old capture
never stands in for the newest one.

`displayAccountLabel` applies it to a row: a `manual` mapping keeps the
owner's label; any other row shows the account's label when there is one,
else its own. The observation and balance organization
(`observationOrganizations`), the identity `accounts` page and the filter
options (`organizedFilterOptions`) all use it, so `kogane.balances.read`,
`kogane.observations.*`, `kogane.identity.read` and the screens show one name
for one account. The per-reference `connection` object is unchanged: a
reference the review does not name gets the account's label but not the
review.

### The card name (`vpass-credit-snapshot` 1.1.0)

The parser keeps `cardName` of `authoriShokaiVo` (Authori) or of the revolving
bean (revo) as `extra._kogane.cardName` on each observation of that file. A
name that is empty, over 64 characters, has a control character or a run of
four or more digits (ASCII or full-width) is left out, never thrown, so a
snapshot is never lost over a label; the read checks the same shape again.
`userName` is never copied. The financial observations are unchanged.

Migration `0103_vpass_credit_card_name_policy.sql` advances the shipped
credit-snapshot policy's `required_parser_version` from `1.0.2` to `1.1.0`, as
0102 did, retaining every operator choice. Membership pins the version
exactly, so between the deploy and the first 1.1.0 parse of a card's newest
capture the card has no current credit snapshot. The incremental lane parses
the next daily capture (21:00 UTC) under 1.1.0, and the repair lane re-parses
the stored ones.

### `kogane.identity.read` `collection: account-list`

`GET /api/identity/account-list` and the same collection of
`kogane.identity.read`: one line per account that current identity
observations reach.

```json
{
  "account": "account_…",
  "label": "<institution>（MoneyForward連携）（個別口座未確定）",
  "labelOrigin": "connection",
  "role": "aggregator-mirror",
  "status": "provider-local",
  "sources": ["moneyforward-me"],
  "references": 2,
  "observedCount": 12401,
  "connection": "unresolved",
  "lastFetchedAt": "2026-11-18T21:15:04.000Z"
}
```

- `labelOrigin` is `manual` (all manual mappings of the account agree),
  `connection`, `card-name` or `mapping` (the mapping label, or the account's
  own when the mappings disagree).
- `connection` is the review status of the account's references that a review
  names (`unresolved` when they differ), or `null`.
- `lastFetchedAt` is when the newest fetch run behind the account's current
  observations was first recorded.
- Filters `source` (that source's references only; the label is still the
  account's), `offset` (100 a page) and `identityRead`, as the other identity
  collections. Every reference is read at once and grouped, so an account is
  never split across pages; more than 2,000 references is refused
  (`identity_account_list_limit`), never cut.
- The identity page shows it as the `口座一覧` table.

## Consequences

- No identity, mapping or attribution changes; rollback is a code rollback.
  Migration 0103 is not reverted by a rollback: a rolled-back 1.0.2 reader
  would not meet the 1.1.0 pin, so a rollback of the parser also needs the
  policy row set back (as 0102's would).
- Each organized page reads the current references of its accounts, and,
  when it holds Vpass rows, the credit captures of those references (bounded by
  the references' identity observations, through the `source_account_id`
  index). No new index.
- The published `kogane.identity.read` schema gains `account-list`; the MCP
  Portal needs its capabilities synced after the deploy.
- The label is provider text: it reaches an agent only under `data`, as every
  other label.

## Verification

- `services/app/test/account-labels.test.ts`: a second producer's reference
  moved onto a reviewed account shows the connection label in the
  organization, the filter options, `accounts` and `account-list` (one line,
  two references), without the review itself; the card name comes from the
  newest capture with its card unit key; a re-parse of an older capture does
  not win; no name when the newest capture has none, two, or one with digits;
  a manual mapping keeps its label.
- `packages/parsers/test/vpass-credit.test.ts`: both files keep the name; the
  rejected shapes are left out with the snapshot intact.
- `packages/storage-d1/test/vpass-credit-card-name-policy.test.ts`: only the
  shipped policy advances; every operator choice survives.
- `services/app/test/page-read-identity.test.ts` and
  `services/app/test/ui-mcp-parity.test.ts`: the tool answers the new route as
  the route does.
- `apps/web/test/identities.browser.test.ts`: the `口座一覧` table.
- After deploy: `kogane.identity.read` `account-list` shows the four Money
  Forward accounts with their connection labels on every reference, and, after
  the next Vpass credit run, the seven cards by name.

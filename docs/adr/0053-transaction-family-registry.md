# ADR 0053: A closed transaction-family registry states which families have an event writer and why the others do not

- Status: proposed until this PR merges; accepted upon merge
- Date: 2026-10-08
- Issue: #549 (first, pure slice)
- Related: ADR 0001 (INV05, INV06, INV07), ADR 0002, ADR 0004, ADR 0006,
  [economic events](../economic-events.md#non-card-families-unsupported-today)

## Context

Phases 6–7 of the [roadmap](../roadmap.md#phases-67--reconciliation-and-economic-event-generation)
ask for events generated continuously from adopted observations for bank
transfers, FX, remittances, securities, reward exchanges and stored-value
funding. Today only two writers exist: card purchase recognition (Vpass and
MyJCB usage rows, ADR 0002) and card settlement review acceptance (a Vpass or
MyJCB statement total against an SMBC or SBI Shinsei bank debit). No other
transaction family has a writer.

The 0032 schema already holds much of what the other families need: `transfer`
events with their own state family, `fee` events, legs on the cash-movement,
trade-date and settlement-date bases, legs whose value is missing, unparsed or
in conflict with a reason (never zero, INV05), and fill and transfer
allocations. What it does not have is an event kind for a trade, an exchange,
income or a redemption; the one-live-holder sidecar of 0047 (INV06) is
card-only; and the `allocations` live unique index is per source, target and
role, so one bank row can be allocated to two targets.

Reading every parser that emits transaction or position rows also showed that
the row identities the next writers would key on are uneven, and that the
documentation described them inaccurately:

- SBI Shinsei (`txnReferenceNo`), the SBI Securities yen detail history (the
  provider `did`), SBI VC Trade cash flows (`cashflowID`) and executions
  (`CExecutionId` + `CExecutionIdSubNo`) and PayPay (`transactionNumber`) carry
  provider row ids, but their parsers record no `_kogane.identityOrigin`, so
  stage A reads the origin as unknown. The economic-events table grouped
  "SBI Securities histories" with collector fingerprints and named only SBI
  Shinsei and PayPay as unrecorded.
- The SBI Securities domestic trade parser records its origin under
  `_kogane.externalIdOrigin` (`collector-fingerprint`), which stage A does not
  read; the id is the collector's fingerprint of the table cells plus an
  occurrence.
- The V Point Pay id is the SHA-256 of the stored notification message,
  recorded as `normalized-event-id`; the documentation listed it as a provider
  row id.
- V Point history rows carry no external id at all.

Which provider fields could feed legs (a value date, a settlement amount in
another unit, a stated commission, a conversion rate, an execution
sub-number) also differs per parser and was written down nowhere.

## Options considered

1. **Describe the families in prose only.** Cheapest, but nothing would notice
   when a parser starts recording an origin, a new parser emits transaction
   rows, or the prose drifts from the parsers again — which is what happened to
   the provider-id table.
2. **Write events for one family now** (for example SBI VC executions, the only
   trade source with provider ids and a mapped direction). Every such writer
   needs a holder for its source rows across families (INV06), a rule for what
   adopts it (INV07; agents never approve), and an answer to which view of a
   duplicated movement is the event's evidence. Those are the writer/guard
   contract shared with the reconstruction (#550) and cost-basis (#556) work,
   which is under design review. Writing one family first would fix that
   contract by accident.
3. **A closed registry that states support and reasons (chosen).** A pure
   module in `packages/domain` with closed codes, checked against the parser
   registry and the parsers' own output on synthetic fixtures. It changes no
   stored or displayed state and gives the later writers and the contract ADR
   one reviewed statement of the starting point.

## Decision

Add `packages/domain/src/event-families.ts`, exported from the package index:

- `TRANSACTION_FAMILIES`, closed: `bank-movement`, `fx-exchange`,
  `overseas-remittance`, `securities-order`, `securities-execution`,
  `securities-settlement-cash`, `crypto-execution`, `crypto-fiat-remittance`,
  `reward-exchange`, `prepaid-funding`, `prepaid-notification`,
  `card-purchase`, `card-settlement`. `bank-movement` covers deposit and
  stored-value balances alike.
- `FAMILY_UNSUPPORTED_REASONS`, closed: `no_event_writer`,
  `identity_fingerprint_only`, `identity_origin_unrecorded`, `identity_absent`,
  `direction_code_unmapped`, `cash_amount_not_stated`, `counterpart_not_stated`,
  `not_collected`, `semantics_unobserved`, `snapshot_only`,
  `writer_guard_pending`.
- `PROVIDER_LINK_CODES`, closed: `execution_sub_number`, `value_date`,
  `settlement_amount`, `commission_stated`, `exchange_rate_stated`, `none`
  (exclusive).
- `TRANSACTION_FAMILY_REGISTRY`: one entry per (source id, parser name) of the
  parser registry whose rows are transactions or positions — 23 today — with
  the observation kinds, the external id basis (`provider_id`,
  `provider_id_tuple`, `evidence_digest`, `fingerprint_occurrence`,
  `collector_fingerprint`, `none`), the `_kogane` key the origin is recorded
  under (`identityOrigin`, `externalIdOrigin` or none) and the class the stage A
  rule gives its text (`provider`, `fingerprint`), the status vocabulary
  (absent, a closed set, or provider text verbatim), the provider link fields,
  and one or more family memberships. A membership is `supported` only for the
  card-purchase rows of Vpass and MyJCB and the card-settlement debits of SMBC
  and SBI Shinsei; every other membership is `unsupported` with the reasons
  that hold for it, always including `no_event_writer` and the family-level
  reasons of `FAMILY_SUPPORT`.
- Pure lookups: `transactionFamilyEntry(sourceId, parserName)`,
  `transactionFamilyEntries(family)`, `familyUnsupportedReasons(family)`; and
  `validTransactionFamilyEntry`, which rejects unknown keys and codes.

Every value was read off the parser source; the registry holds codes only — no
provider value, amount, account identifier or merchant text.

Correct the documentation to match the parsers: the provider-id table and the
stage A paragraph of [economic events](../economic-events.md#which-sources-supply-a-provider-link-id),
a new "Non-card families: unsupported today" section there, a limit line in the
roadmap's phases 6–7, and a [domain contracts](../domain-contracts.md) entry.

## Consequences

- The registry is not adoption. Nothing reads it to write, gate or display
  anything; `supported` names a writer that exists, not an event that was
  written. Changing an entry changes no stored or visible state.
- A parser that starts or stops emitting transaction or position rows, or that
  changes what it records as a row's identity origin, status or link fields,
  fails `packages/parsers/test/event-families.test.ts` until the registry is
  updated in the same change. A new family or reason is a reviewed contract
  change.
- The writer/guard contract shared with #550 and #556 — where own-transfer
  candidates live, what adopts a transfer, the cross-family holder (INV06),
  release and withdrawal, and which view of a duplicated movement is the
  evidence — is a separate ADR to come. Until it is accepted every non-card
  family carries `writer_guard_pending` or a more basic reason, and no lane,
  endpoint, migration or log is added for them.
- Recording `_kogane.identityOrigin` in the provider-id parsers (SBI Shinsei,
  yen detail, SBI VC cash flows and executions, PayPay) is a parser release with
  regenerated digests and is not done here; nor is the domestic trade parser's
  `externalIdOrigin` key renamed. Both need the owner's confirmation first.
- No migration, no Worker change, no production read.

## Verification

Locally with synthetic data only:

- `packages/domain/test/event-families.test.ts`: the closed lists, codes-only
  content, entry validity and order, membership reasons against the
  family-level reasons, which memberships have writers, the recorded identity
  facts per entry, validator rejections, the three lookups, and that every
  family maps onto display kinds `classifyActivity` knows and every transaction
  entry's classified kind fits each of its families.
- `packages/parsers/test/event-families.test.ts`: the registry names exactly the
  PARSERS entries whose rows are transactions or positions (19 parsers
  whose rows are balances, valuations, scheduled payments or none are listed as
  outside, and those with
  coverage-contract cases shown to emit no such row); every registry parser run
  on the shared synthetic fixtures records the entry's observation kinds, origin
  key and stage A class (never the text or an id), external-id presence, status
  vocabulary and every listed provider link field.
- `mise run //packages/domain:ci`, `mise run //packages/parsers:ci` (parser
  digests unchanged), `mise run ci:root`, and oxlint, oxfmt and typos on the
  changed files.

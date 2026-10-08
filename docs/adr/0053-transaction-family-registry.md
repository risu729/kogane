# ADR 0053: A closed transaction-family registry states which families have an event writer and why the others do not

- Status: accepted (merged 2026-10-08 in #577)
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
- The V Point Pay id is the SHA-256 of the stored notification message (the
  outer message hash for a direct delivery, not for a forwarded one, so two
  deliveries of one notice can carry two ids), recorded as
  `normalized-event-id`, which stage A reads as provider-issued (no effect
  today: V Point Pay is in no reconciliation slice; only Vpass and MyJCB are);
  the
  documentation listed it as a provider row id.
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

Within option 3, where the deposit/stored-value boundary falls:

- **One movement family for deposit and stored-value balances.** Fewer codes,
  and Suica, PayPay and bank rows are all "money in an account went up or
  down". But own-transfer pairing (two own accounts, one decrease and one
  increase) must never pair a stored-value row: a Suica charge is a card
  purchase or a bank debit on the other side, a fare is spending, and a PayPay
  card payment does not move the PayPay balance. One family would make every
  reader filter by source, and a closed list is a contract once something reads
  it, so splitting later would change what readers already rely on.
- **A separate `stored-value-movement` family (chosen).** `bank-movement` is
  deposit accounts only and is what own-transfer pairing reads; Mobile Suica SF,
  PayPay and V Point Pay balance rows are `stored-value-movement`, with fares
  and payments as spending from the balance and charges also `prepaid-funding`.

## Decision

Add `packages/domain/src/event-families.ts`, exported from the package index:

- `TRANSACTION_FAMILIES`, closed: `bank-movement`, `stored-value-movement`,
  `fx-exchange`, `overseas-remittance`, `securities-order`,
  `securities-execution`, `securities-settlement-cash`, `crypto-execution`,
  `crypto-fiat-remittance`, `reward-exchange`, `prepaid-funding`,
  `prepaid-notification`, `card-purchase`, `card-settlement`.
  `bank-movement` is deposit accounts only; stored-value balances are
  `stored-value-movement`.
- `FAMILY_UNSUPPORTED_REASONS`, closed: `no_event_writer`,
  `identity_fingerprint_only`, `identity_evidence_digest`,
  `identity_origin_unrecorded`, `identity_absent`,
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
  under (`identityOrigin`, `externalIdOrigin` or none) and how stage A reads it
  (`provider`, `fingerprint`, or `unknown` when there is no
  `identityOrigin`), the status vocabulary
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
- `packages/parsers/test/event-families.test.ts` fails when, on the shared
  synthetic fixtures (and the few synthetic variants built from them in the
  test), a registry parser emits a row kind, records an origin key, is read by
  stage A, carries an external id or a status value, or carries a link-like
  field that its entry does not state, or when a declared status value or link
  field is never seen with a value; and when a parser outside the registry
  emits a transaction or position row on its fixtures, or a parser name is
  added to or removed from PARSERS without a registry decision. It proves what
  the fixtures exercise, not every shape a provider can send: a link field
  whose key does not look like one (a name outside the test's pattern), a
  value inside an array (the scan walks object keys only, so the SBI domestic
  trade `rawCells` and the GLOBAL PASS `sourceViews` cell arrays are never
  checked), or a row shape no fixture carries is not caught. A new family or reason is a
  reviewed contract change.
- The writer/guard contract shared with #550 and #556 — where own-transfer
  candidates live, what adopts a transfer, the cross-family holder (INV06),
  release and withdrawal, and which view of a duplicated movement is the
  evidence — is a separate ADR to come. Until it is accepted every non-card
  family carries `writer_guard_pending` or a more basic reason, and no lane,
  endpoint, migration or log is added for them.
- Recording `_kogane.identityOrigin` in the provider-id parsers (SBI Shinsei,
  yen detail, SBI VC cash flows and executions, PayPay) is a parser release with
  regenerated digests and is not done here; nor is the domestic trade parser's
  `externalIdOrigin` key renamed, nor is V Point Pay's origin text changed so
  that stage A stops reading its message digest as provider-issued (a limit the
  `identity_evidence_digest` reason states). These need the owner's
  confirmation first.
- No migration, no Worker change, no production read.

## Verification

Locally with synthetic data only:

- `packages/domain/test/event-families.test.ts`: the closed lists, codes-only
  content, entry validity and order, membership reasons against the
  family-level reasons, which memberships have writers, the recorded identity
  facts per entry, validator rejections, the three lookups, and that every
  family maps onto display kinds `classifyActivity` knows and every transaction
  entry's classified kind fits each of its families.
- `packages/parsers/test/event-families.test.ts`:
  - the registry names exactly the PARSERS entries whose rows are
    transactions or positions; the other 19 are listed by name, and each of
    them is run on at least one synthetic fixture (its own tests' fixtures, or
    its coverage-contract cases) and emits no transaction or position row;
  - every registry parser is run on the shared synthetic fixtures (plus
    synthetic variants for a Sony foreign-currency CSV, a Sony WALLET fee and
    a pending WALLET row), and every row records the entry's observation
    kinds, origin key and stage A reading (never the text or an id), external
    id presence and a status of the entry's vocabulary;
  - every declared closed status value is seen on a fixture row;
  - every declared link field is seen with a non-empty value on at least one
    row, and no row carries a link-like key (fee, rate, value or settlement
    date, settlement or local amount, execution sub-number, by key-name
    pattern) that is neither a declared link of its entry nor listed as not a
    link with its reason.
- `mise run //packages/domain:ci`, `mise run //packages/parsers:ci` (parser
  digests unchanged), `mise run ci:root`, and oxlint, oxfmt and typos on the
  changed files.

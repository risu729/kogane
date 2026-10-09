# ADR 0059: A C adapter maps selected revisions to lot inputs, and answers unsupported until a securities writer exists

- Status: proposed (accepted when its pull request merges)
- Date: 2026-10-09
- Issue: #556 (ロット・取得原価・処分配分), the C adapter slice; the issue stays open
- Builds on: [ADR 0051](0051-provisional-lot-engine.md) (the engine; dated note
  there), [ADR 0058](0058-knowledge-selector-and-reconstruction-adapter.md) (the
  knowledge selector and the B adapter, the pattern mirrored here)
- Implements: [ADR 0054](0054-economic-consumption-guard.md), "Typed movement",
  "Manifest pins", and acceptance tests B7–B11 and the C side of B3, B12 and
  B13
- Carried by: `packages/domain/src/lot-adapter.ts`,
  `packages/application/src/query/lots-on-selection.ts`

## Context

[ADR 0051](0051-provisional-lot-engine.md) built `computeLots(inputs, policy)`
over a provisional input (`provisional-lot-input-v0`) and left the mapping
from economic events to that input to a later, decided adapter.
[ADR 0058](0058-knowledge-selector-and-reconstruction-adapter.md) built the
knowledge selector: what was adopted as known at one commit of the 0070 log,
every touched event's revision in force resolved before any filter, with its
legs, typed effects, role-typed times, claims, seal and commit, and the
dispositions it cannot place (`knowledge_unlogged`, `chain_inconsistent`,
`identity_changed`, key and alias conflicts, unsupported shapes). ADR 0054
named this ADR as the owner of the C side.

What exists today, read from the code:

- No writer adopts a security-quantity movement. CORE 0070 refuses a claim in
  the `security-quantity` book (`economic_claim_book_unsupported`), and the
  selector reports any such claim as `book_unsupported`. No event kind for a
  trade or an FX conversion exists: the 0032 kind CHECK admits `purchase`,
  `charge`, `refund`, `transfer`, `card_settlement`, `fee`, `platform_payout`
  and `unknown`, and the selector reads any other kind as unreadable (kind
  `unknown`). Widening the kind CHECK and the securities writer are ADR 0054's
  "Later" items.
- A seal pins identity revisions as `{subject: revision}`; the selector reads
  `instrument_mapping:<identifier id>` pins and compares them with the
  current mapping revision. The selection carries no mapped instrument, no
  mapping status and no instrument class: those are in `instrument_mappings`
  and `instruments` (CORE 0018), whose status is `identified`,
  `provider-local`, `aggregate` or `unresolved`
  ([identity](../identity.md), [ADR 0055](0055-instrument-candidates.md)).
  An instrument's kind (`security`, `crypto`, …) does not say whether a
  security is a listed share or a fund unit.
- Broker trade rows carry a date without a time, one settlement amount whose
  fee inclusion is not confirmed, and foreign rows without fee or FX fields;
  provider position costs are claims, never lot cost
  ([calculation and reports §3](../calculation-and-reports.md#3-rounding-and-pl-attribution-are-versioned-inputs);
  ADR 0051, Context). No own-account security transfer and no corporate-action
  dataset has been observed.

## Options considered

1. **Wait for the securities writer and the kind widening.** Nothing to get
   wrong now, but the mapping rules, their refusals and the outer manifest
   would be reviewed in the same change as the writer and the migration, and
   the selector-to-engine path would stay untested end to end.
2. **Map broker observations directly**, bypassing adoption. Rejected for the
   reasons ADR 0051 rejected an engine over raw tables: it would decide which
   row is a fee or a consideration, and read fee and FX semantics nobody has
   confirmed ([ADR 0004](0004-payment-type-shapes-from-evidence.md)); it would
   also bypass the consumption guard (INV06) and the knowledge cut.
3. **Read instrument identity from the selection alone.** Not possible: the
   selection carries only the pin's revision, not what it maps to.
4. **An adapter over the selection, with reserved kinds and a caller-read
   identity mapping checked against the seal's pin, refusing everything it
   cannot place; today every real selection answers `unsupported`.** Chosen.

## Decision

### What the adapter reads (`lot-adapter.ts`, `adaptSelectionToLots`)

A selected revision is read when it carries a `security-quantity` claim, a
leg whose unit is one of the request's instrument identifiers, or a reserved
kind; every other revision is counted (`otherRevisions`) and not read.

- **Kinds** (a closed list, `LOT_ADAPTER_KINDS`): `trade` is mapped;
  `transfer` (the 0032 kind) is held as `transfer_contract_pending`;
  `corporate_action` is held as `corporate_action_unsupported`; any other kind
  is `writer_unsupported`. `trade` and `corporate_action` are reserved names
  the kind widening may change (a rename changes `LOT_ADAPTER_RELEASE`). An FX
  conversion moves no security quantity and is not read. A `trade` maps only
  in a state of `LOT_TRADE_STATES` (`executed`, `settled`; reserved names, no
  state family exists); in state `unknown` with no legs and no claims it is a
  withdrawal (`no_movement`, or held for a selector disposition alone); any
  other state is `writer_unsupported`.
- **The security side.** Exactly one movement leg (a `movement` effect row, or
  a legacy increase or decrease) in an instrument unit; increase is an
  acquisition, decrease a disposal. A second movement or any non-movement leg
  in an instrument unit (a fee taken in kind) is `writer_unsupported`; a
  zero or negative exact quantity likewise; a revision with no
  `security-quantity` claim is `writer_unsupported` (a movement no claim
  holds); a claim with no leg in a mapped unit is `instrument_unresolved`.
- **The cash side** (ADR 0054, "Typed movement"):
  - one cash movement in the consideration's direction (out for an
    acquisition, in for a disposal), whose `breakdown` legs with the fee role
    and the movement's unit are its fees. The movement is what crossed the
    cash account: for an acquisition the fees are inside it, so the
    consideration is the movement minus the fees (101 out = 100 + 1 fee); for
    a disposal they were deducted from it, so the consideration (gross) is
    the movement plus the fees (100 in = 101 gross − 1 fee). Each fee is
    handed over once, as a fee, never as a consideration or a second input;
  - or, without a cash movement, one `correspondence` of the security
    movement in the consideration's direction states the consideration, and
    `correspondence` legs with the fee role state the fees, as given;
  - any other cash leg (a second movement, a legacy fee or unresolved leg, a
    breakdown of another role or unit, a direction mismatch, a negative
    result) is `writer_unsupported`;
  - no cash leg at all: consideration and fees are not stated
    (`consideration_missing`, `fee_unknown`; the fee is handed over as an
    absent value, never as an empty list, which would say "none").
    This reading of breakdowns by direction is the adapter's; the securities
    writer's ADR confirms it or amends this one.
- **Times.** The input's `trade` and `settlement` times are the revision's
  `economic_event_times` rows of those roles. A missing role is
  `{kind: "unknown", reasonCode: "time_role_missing"}` on that basis, never
  the other role, `posting`, `value` or the 0032 effective time. Two rows of
  one role are `writer_unsupported`.
- **The book** (ADR 0051): holder `account:<resolved account>` of the
  security leg; the wrapper key the request gives for that account (opaque);
  the instrument the request's mapping names for the leg's unit. A leg on an
  account the request names no wrapper for, or on no account, is
  `holder_unresolved`. A mapping that is `unresolved` or `aggregate`, states
  no class, or whose revision is not the one the revision's seal pins as
  `instrument_mapping:<unit>` (or is not pinned) is `instrument_unresolved`;
  `identified` and `provider-local` place a book. The input's quantity is
  restated in the instrument's unit, so two identifiers of one instrument
  share its book. Two classes for one instrument hold its book
  (`instrument_unresolved`), which the engine would otherwise refuse as a
  whole run.
- **FX.** No rate is in evidence, so `fx` is always null. Under
  `convert-at-input-rate`, a consideration or fee outside the cost unit is
  noted `fx_rate_missing` and the engine keeps it unknown.
- **What is never produced.** No snapshot (provider holdings and costs are
  claims), no split (no corporate-action kind exists; the engine's split path
  is covered by its own tests), no transfer input, no gain, no tax.
- **Specific identification.** A person's choices are given per disposal ref
  (`lotSelections`) and attached as given; a choice for a ref no fed disposal
  has is reported (`unusedLotSelections`), never moved to another disposal or
  lot.

### Dispositions and books

- From the selector: `knowledge_unlogged` (a revision the log does not place)
  holds its book `indeterminate`; `identity_changed`, `claim_conflict`,
  `alias_conflict`, `chain_inconsistent` (`revision_chain_inconsistent`) and a
  shape it reported unsupported (`writer_unsupported`) hold it
  `needs_review`; its `book_unsupported` report is
  `security_quantity_writer_missing`. The adapter also finds key and alias
  conflicts among the selected security claims itself, so one row claimed by
  two events never yields two inputs (B3, C side) whether or not a selection
  flags it.
- Codes (`LOT_ADAPTER_CODES`, closed) fall in four groups: no writer or
  contract (`security_quantity_writer_missing`, `transfer_contract_pending`,
  `corporate_action_unsupported`: the book is `unsupported`); not placed by
  the log (`knowledge_unlogged`: `indeterminate`); review
  (`identity_changed`, `claim_conflict`, `alias_conflict`,
  `revision_chain_inconsistent`, `writer_unsupported`,
  `instrument_unresolved`, `holder_unresolved`: `needs_review`); notes on a
  mapped input (`time_role_missing`, `consideration_missing`, `fee_unknown`,
  `fx_rate_missing`), which never hold anything: the engine keeps the value
  unknown.
- Each read revision is an entry: `mapped`, `held` with its codes, or
  `no_movement`, with the books its instrument legs place it in. A book is
  fed to the engine only when every revision touching it was mapped: one held
  revision holds the whole book, because a missing input would change every
  later allocation. A held revision placed in no book leaves the run
  `needs_review` while other books are still fed.

### Composition and the outer manifest (`lotsOnSelection`)

`computeLots` runs on the fed inputs under the request's policy, with no
input at all when nothing is fed, so its gates and manifest are exercised on
every call. The status says what the answer is before what it computed, every
applicable reason listed (`LOTS_ON_SELECTION_REASONS`, closed, covering the
adapter's codes, the engine's refusal and reason codes and the selector's
coverage reasons):

1. `unsupported`: no `security-quantity` claim in the selection
   (`security_quantity_writer_missing`), a transfer, a corporate action, or an
   engine book refused `unsupported_instrument`;
2. `refused`: the engine refused the run (`policy_missing`,
   `tax_rules_unverified`, …);
3. `indeterminate`: the selection's coverage (`log_empty`,
   `cut_before_log_start`, `cut_epoch_not_current`, `knowledge_unlogged`) or
   any engine book stop (`order_tie`, `unknown_time`, `negative_holding`,
   `unknown_lot`, `lot_selection_missing`, …), so B7 and B10 flow through
   from the engine;
4. `needs_review`: a review code, or a choice no disposal took
   (`lot_selection_unused`);
5. `limited`: a note, a limited disposal or a remaining lot of unknown cost;
6. else `complete`.

The outer manifest pins (ADR 0054, "Manifest pins"): its schema
(`lots-on-selection-manifest-v1`), the selector and adapter releases, the
input contract and engine version, the requested and resolved cut and its
`known_at`, the set version, the current identity epoch and every pin of the
selected seals, the alias rule versions, the coverage producer
(`coverage-producer-none-v1`), the snapshot contexts (none: no snapshot input
is produced), the holders and wrapper keys, the instrument mappings read, the
specific-identification choices, the policy ref, the FX policy ref with its
rate refs (none), and the `canonicalDigest` of the engine's manifest (null
when the engine refused). `contextId` is the manifest's digest. Equal
selections and requests in any order give one manifest (B13); history filled
later is a new cut, set version and digest, and the earlier cut's stays
(B12).

### The query (`lots-on-selection.ts`, `queryLotsOnSelection`)

One account (the holder) with its wrapper key, 1–16 instrument identifier ids,
a cut (default: the latest commit of the current core epoch, or the caller's
`now` for an empty log), the caller's policy and choices. Without every 0070
object it answers `unavailable` (`economic_guard_missing`). Otherwise it loads
the selector rows for the account (ADR 0058), selects with the identifiers as
the instrument scope, reads each identifier's current mapping and its
instrument by key (`LOT_INSTRUMENT_MAPPINGS_SQL`: an instrument of kind
`crypto` is a crypto asset; any other kind states no class), and runs
`lotsOnSelection`. Its manifest adds the query schema, the account and the
asked identifiers around the outer manifest. Malformed input is
`invalid_query`, an instant cut after `now` is `cut_in_future`, and the
selector's refusals propagate. No route, page or service calls it.

## Consequences

- Today's answer for every account is `unsupported`
  (`security_quantity_writer_missing`) with the manifest produced, because no
  store can hold a security-quantity claim. A revision that moves an
  instrument unit without one is held `writer_unsupported`. The mapped path,
  B7–B11 and the C side of B3 run on hand-built selections only.
- The adapter and the query read; nothing is written, adopted or approved. No
  migration: the mapping read uses the 0018 key `UNIQUE(identifier_id,
revision)` and the `instruments` primary key.
- The manifest holds amounts (the choices' quantities, and through the
  engine's manifest digest the inputs): like the engine's, it is a calculation
  input that a future writer stores only as a report body, never in a log,
  tick record or lane state.
- `computeLots`, the selector and the B adapter are unchanged; the adapter
  imports `COVERAGE_PRODUCER_NONE` from the B adapter. The new module is not
  re-exported from `packages/domain/src/index.ts` in this change; callers
  import it by path.

### Limits

- **No securities writer.** CORE 0070 refuses the `security-quantity` book
  and no event kind for a trade exists; the reserved names `trade`,
  `corporate_action`, `executed` and `settled` are this adapter's
  placeholders, decided by the kind-widening migration and the writer's ADR,
  which also confirm or amend the breakdown reading above.
- **No FX evidence.** No input carries a rate; under `convert-at-input-rate`
  every amount outside the cost unit stays unknown (`fx_rate_missing`).
- **No corporate-action dataset.** Splits are refused
  (`corporate_action_unsupported`), so split lineage is never produced from
  evidence.
- **Transfers pending.** A transfer moving a security quantity holds its
  book (`transfer_contract_pending`); lineage across holders (`fragmentOf`)
  stays null.
- **Wrapper key source undecided** (#545, #546): the caller supplies one
  opaque key per account; nothing recorded says which wrapper (特定, 一般,
  NISA) a holding is in, and one account holding two wrappers cannot be
  split.
- **Instrument class.** Nothing recorded tells a listed share from a fund
  unit, so the query states no class for a `security` instrument and every
  such book is `instrument_unresolved`; only `crypto` instruments state one.
- **Identity.** A revision whose seal does not pin its instrument mapping is
  `instrument_unresolved`; only the current mapping is read, so a mapping
  moved since the seal is refused, not read at the pinned revision.
- **Unplaced revisions.** A held revision that no instrument leg places in a
  book (an unmapped unit, an unknown holder) makes the run `needs_review` but
  does not hold the books that are fed.
- **The owner's open items from ADR 0051, restated, not decided:** whether
  the broker's settlement amount includes fees, and which row a securities
  writer adopts as the consideration and the fee; the FX rate source for
  foreign trades; the wrapper key (above); the transfer contract (partial
  transfers, an unmatched transfer-in, fees, crossing wrappers, one live
  holder); whether a person may set an opening cost for a holding known only
  from a snapshot; corporate-action evidence; crypto spot against margin;
  and how date-only trade rows of one day are ordered (today an
  `order_tie`), and whether a position row on a trade day includes that
  day's trade.
- **Cost.** Not measured; the adapter is linear in the selected revisions and
  the selector's bounds apply.

## Verification

Synthetic data only; no production data, D1 or Workers.

- `packages/domain/test/lot-adapter.test.ts` (35 tests), on hand-built
  selections (`packages/domain/test/lot-selection-fixture.ts`, set versions
  from the selector's `adoptedSetVersion`) and on today's selector through
  `selector-fixture.ts`: no security claim is `unsupported` with the manifest
  produced; today's selector's `book_unsupported` and unreadable `trade` kind;
  the closed kind list; B3 C side (101 = 100 + 1 as one acquisition, 100 in
  with a 1 fee as one disposal of gross 101 under both disposal-fee modes,
  stated correspondences, one row claimed by two events with and without the
  selector's flag, one alias class under two events); no time-role fallback
  on either basis; B7 (a same-date buy and sale under FIFO is `order_tie`, a
  missing trade role is `unknown_time`); B8 (4 of 10 takes 400 of 1000 on
  both bases, the remaining lot keeps 600 and its acquisition time); B9 (a
  corporate-action revision and a security transfer refused, their books
  held); B10 (a withdrawn acquisition: the sale is `negative_holding`, no
  allocation); B11 (a choice naming a corrected acquisition's old revision is
  `unknown_lot`; a choice for a disposal no longer in force is unused and the
  disposal `lot_selection_missing`); B12 and B13 (hand-built and through
  today's selector); every adapter code with its shapes; dispositions
  holding only the touched book; the engine's refusals; the manifest pins;
  invalid requests; the closed reason list covering every code.
- `packages/application/test/lots-on-selection-query.test.ts` (11 tests) on a
  CORE store migrated through every migration with an economic history
  written through 0070's triggers: without 0070 `unavailable`; an empty log
  `unsupported` with `log_empty`, the manifest and the mappings read; 0070
  refusing a security-quantity claim with nothing written; an instrument leg
  no writer claims held `writer_unsupported`; a cash event outside the
  instrument scope; B12 (a later commit, the earlier cut's context unchanged);
  B13; refused queries and cuts; a null policy; the mapping read's plan on the
  complete CORE schema without table statistics (keyed, no scan).
- By hand, not in CI: subtracting instead of adding a disposal's fees,
  falling back to the settlement time, dropping the adapter's own conflict
  check, feeding books with a held revision, and skipping the pin check each
  failed tests.
- `mise run //packages/domain:ci`, `//packages/read-model:ci`,
  `//packages/application:ci`, `//packages/parsers:test`, `mise run ci:root`,
  the format, lint and typo checks, and `mise run ledger:schema` (no change).

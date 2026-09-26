# ADR 0014: A shared-R2 collector's producer is `collector-<collector id>`

- Status: proposed
- Date: 2026-09-26
- Carried by: the producer constants of every `services/collector-*`
  terminal module, `tests/collector-producers.test.ts`,
  `scripts/config-bootstrap.test.ts`,
  [processor §3.1](../processor.md#31-collector-ids-core-source-ids-and-producers),
  [collection](../collection.md#terminal-source-ids-and-core-source-ids)

## Context

Since the Processor began registering shared-R2 terminals on 2026-09-12
(U09, #184), it registers them through the routes declared in
`config/ingest-clients.json`: one route per collector id in
`COLLECTOR_SOURCE_IDS`, each with the producer `collector-<collector id>`,
where the collector id is the terminal's own `source`. The registration
checks the route for the terminal's `producer` and the mapped CORE source
(`packages/application/src/ingest/access.ts`) and answers a missing one with
`inactive_ingest_route`, which is retryable rather than blocked
(`register-terminal.ts`).

Seven terminal writers named a producer of their own instead:

| Collector workspace        | Terminal `source`    | Producer named until this ADR | Route's producer               |
| -------------------------- | -------------------- | ----------------------------- | ------------------------------ |
| `collector-vpass`          | `vpass`              | `vpass-json`                  | `collector-vpass`              |
| `collector-myjcb`          | `myjcb`              | `myjcb-worker`                | `collector-myjcb`              |
| `collector-sony-bank`      | `sony-bank`          | `sony-bank-worker`            | `collector-sony-bank`          |
| `collector-moneyforward`   | `moneyforward-me`    | `moneyforward-worker`         | `collector-moneyforward-me`    |
| `collector-vpoint`         | `v-point`            | `collector-vpoint`            | `collector-v-point`            |
| `collector-vpoint` (Email) | `v-point-pay-email`  | `collector-vpoint`            | `collector-v-point-pay-email`  |
| `collector-vpoint-pay`     | `v-point-pay`        | `collector-vpoint-pay`        | `collector-v-point-pay`        |
| `collector-globalpass`     | `prestia-globalpass` | `collector-globalpass`        | `collector-prestia-globalpass` |

The other seven collectors (mizuho, mobile-suica, sbi-securities,
sbi-shinsei, sbi-vc-trade, smbc-direct, st-george) already followed the rule.
Every terminal of a mismatched source whose run got as far as the route
check was refused, so none of their runs reached `fetch_runs` after
2026-09-12, while the collectors kept persisting to R2. Each collector's own
test pinned the string its code wrote, so nothing failed.

None of the mismatched strings ever reached CORE: all earlier evidence of
these sources was registered by the retired importer under the producer
`collector-r2-importer`.

## Options considered

1. **Change the collectors to the rule.** The config, the bootstrap SQL
   (`infra/bootstrap/ingest-clients.sql`) and CORE stay as they are; no
   migration. Chosen.
2. **Declare routes for the strings the collectors write.** Rejected: it
   adds eight producers to CORE that name a Worker or a file format rather
   than the collector id, breaks the one rule `config-bootstrap.test.ts`
   checks (routes are exactly the mapping table, one
   `collector-<collector id>` each), and still leaves two sources on one
   producer for the V Point Worker. It would also let the stranded terminals
   register under producers that exist for no other reason.
3. **Both: fix the collectors and add temporary routes for the old strings
   so the stranded terminals register.** Rejected here: those runs would
   register under a third producer for each source (importer, stranded
   string, collector), so every consequence below would happen twice. Whether
   the stranded runs are worth registering is a separate decision (below).

## Decision

- Every terminal a shared-R2 collector writes names the producer
  `collector-<collector id>`, where the collector id is that terminal's own
  `source`. A Worker that writes terminals for two sources names two
  producers (`collector-v-point` and `collector-v-point-pay-email`).
- The source and producer each writer uses are exported constants of the
  module that builds the terminal fields. `tests/collector-producers.test.ts`
  (run by `mise run ci:root`) imports them and fails when a producer is not
  `collector-` + its source, when the pair is not an active route of
  `processor-shared-r2` in `config/ingest-clients.json`, when a
  `services/collector-*` workspace is not listed, or when any `producer:`
  property under a collector's `src/` is anything but a listed constant
  written directly after its listed source constant.
  `scripts/config-bootstrap.test.ts` keeps checking the other half: the
  declared routes are exactly `COLLECTOR_SOURCE_IDS`.
- The Sony Bank redaction step keeps its transformer id `sony-bank-worker`;
  only the producer changes.

## Consequences

Read from the code and checked on synthetic data where a test is named.

**Registration after deploy.** Only terminals written after the collectors
are deployed name the routed producers. A terminal already in R2 is
immutable and keeps the producer it was written with, so the runs that are
`retryable` today stay refused with `inactive_ingest_route` after this
change: this decision does not register the backlog. How a retryable run is
retried at all:

- the Queue consumer calls `message.retry()` for a `retryable` outcome, so a
  terminal's notification is redelivered until `max_retries` and then goes
  to the DLQ;
- the `collection_scan` cron lane (every five minutes) lists one page of 25
  terminals from its stored cursor and attempts at most five registrations
  per tick. A `blocked` or `retryable` answer, or a registration that
  throws, counts against those five, and
  the cursor advances only when the whole page was dealt with. A page that
  holds more than five terminals that never register is therefore listed
  again on every tick and the walk never passes it. CORE's scan state shows
  that pattern: the cursor is still at the start, and because a cursor that
  stays empty is counted as a finished walk (`advanceCollectionScan`), every
  tick is counted as a completed cycle. The scan lane therefore does not revisit these runs.
  That walk defect is the Processor's, not this decision's, and a separate
  PR fixes it. [ADR 0024](0024-collection-scan-judged-terminals.md)
  does: a terminal already judged no longer spends one of the five, a
  retryable run is retried at most once a day when the walk reaches it, and
  the counters count finished pages and walks.

New terminals pass the route check and reach the rest of registration
through the R2 notification as they are written, within the
`RegistrationBudget` of 500 operations per invocation (#250). Passing the
route check is not registering: for three of the eight sources the real run
plans stop at a later check (see _Merge safety_ below).

**Stranded runs.** The runs these sources persisted between 2026-09-12 and
the deploy stay in R2 without a fetch run. For the snapshot-shaped sources
(Vpass and MyJCB statement windows, Money Forward, Sony Bank's date window,
V Point, V Point Pay's month range) the next capture shows the provider's
state again; what is lost is the intermediate history of those days. The
V Point Pay notification emails of that period are individual messages
nobody captures again; they are recoverable only by registering those runs.
Whether and how to register them (a re-persist under the new producer, or a
reviewed temporary route) is left to a later decision.

**Card usage currentness.** The consequences in this and the next two
paragraphs follow once a collector capture of Vpass or MyJCB is registered,
catalogued with its parser dataset and parsed; _Merge safety_ below says why
this decision alone does not get there. `current_vpass_snapshots` ranks by
(source, card unit, statement month) and `ranked_myjcb_snapshots` by
(source, connection, statement state, statement slot); neither partitions by
producer (`packages/read-model/src/sql.ts`). The first collector capture of a
card-month or ledger slot therefore makes the importer's capture of it
non-current.

**Purchase recognition.** The recognition key is
`json_array(source_id, producer_id, external_id_namespace, source_account,
external_id)`, so a collector capture's rows have keys no live event holds.
The lane's retire pass runs first and retires every live event none of whose
keys is current; recognition waits while the retire pass fills whole pages,
so the old event is retired before its replacement is recognised and nothing
is counted twice at any point.

- _MyJCB_: each importer-era event is retired and the same row is recognised
  again under the collector's key, as a new event with a new id, once per
  row: a one-time full churn of the source's live events in bounded ticks
  (at most 100 retired and 200 recognition writes per tick). The captured
  total is unchanged; the retired revisions stay readable
  (`services/processor/test/card-purchase-producer-switch.test.ts`, MyJCB).
- _Vpass_: a Vpass row is recognised only when its identity run used the
  trusted card binding (`VPASS_STABLE_IDENTITY_FAMILY`), and the trusted
  binding view (migrations 0020/0021) accepts only financial runs of the
  producer `collector-r2-importer`, whose sidecar only the retired importer
  wrote. A collector-vpass capture resolves through the default policy, its
  rows are excluded (`account_not_resolved`, or `card_identity_unstable` for
  a provider-local account), and the importer's events for every card-month
  the collector re-captures are retired without replacement. After the first
  parsed collector run, the Vpass purchases that are live today leave the
  captured and authorized totals until a binding for collector runs exists
  (same test file, Vpass). This is the largest consequence of the switch, and
  it was deferred, not avoided: any parsed collector-vpass run would have had
  the same effect under any producer name.
  [ADR 0023](0023-vpass-collector-card-binding.md) decided not to admit
  collector runs to the trusted binding, because no collector run carries
  the evidence the binding rests on, and to hold collector-vpass captures
  unparsed until the collector writes a binding of its own (_Merge safety_).
- Decisions taken on importer-era events stay on those events. A pending to
  posted link review or a merge names event ids, and a retired event keeps
  its decisions; the replacement events start without them, and the
  candidate pass proposes their pairs again for review.

**Card settlements.** `statement_key` and `bank_key` include the producer,
and the readiness views rank statement totals per (source, producer,
namespace, source account, period). A collector statement total is a new
candidate with a new key. `statement_current` compares a statement only with
newer statements owned by the same account, and the collector's rows resolve
to a new account (below), so an importer-era candidate does not become
non-current through the switch. An accepted importer-era settlement keeps
its SMBC debit occupied (`bank_key` is unchanged), so the same debit cannot be
accepted a second time for the collector's candidate. No settlement had been
accepted when this was written.

**Identity.** A source-account reference is `identityKey("sa", [source,
producer, account key])` (`packages/storage-d1/src/core/identity-store.ts`),
and [identity](../identity.md) treats the producer as a credential-slot
boundary: a new producer is a new epoch. The collector's runs therefore get
new source-account references and, through the automatic policy, new
provider-local accounts. Account mappings, labels and manual decisions made
on the importer-era references stay on those references and do not carry
over; linking the new reference to an existing account is an explicit
account-mapping decision. The same switch was expected on 2026-09-12 for the
collectors that already followed the rule, but nothing about it is recorded
in `docs/` or the history, and it has not happened in practice for most of
them: of those sources only Mizuho and Mobile Suica have registered collector
runs, and no source account under a collector producer exists for Mobile
Suica yet.

### Merge safety

`main` deploys automatically, so what this decision changes in production on
its own was checked against the code at the time of writing, by passing the
collectors' real run plans (`vpassCardRunPlan`, `myJcbRunPlan`,
`vPointRunPlan`, `vPointPayEmailRunPlan`, synthetic inputs) through
`persistRun` and `registerCollectionRun` on the real CORE schema in
Miniflare, then running the parse sweep:

- **Vpass**: the route check passes, the fetch run and its artifacts are
  catalogued, and the seal is refused by CORE's
  `fetch_run_seal_requires_complete_inventory` trigger
  (`run_inventory_incomplete`), because a statement page is a
  `provider_response` with a `redacted` step, which the trigger allows only
  as `decrypted` or `extracted`. Registration throws on every attempt; the
  run is neither sealed nor blocked.
- **MyJCB** and **V Point**: blocked `artifact_lineage_unstated`, because
  their JSON artifacts are `collector_derived` with no stated lineage
  (`descriptors.ts`). A block is write-once: those runs stay blocked after
  the lineage is fixed, and the next capture after that fix is the first to
  register.
- **V Point Pay email**: registers and seals.
- Sony Bank, Money Forward ME, V Point Pay and GLOBAL PASS were not run
  through registration.

Whatever the registration outcome, nothing is parsed: `artifactRequest`
(`descriptors.ts`) gives a collector artifact a `dataset` only for
St.George's `account-snapshot.json`, so every other artifact is catalogued
with `dataset = NULL`, and the parsers of all eight sources accept only
their named datasets (only the Mizuho parsers accept a NULL dataset). With no
published parse, a capture is never current: `eligible_vpass_snapshots`
requires an active `vpass-statement-page` parse of every
`dataset = 'statement-page'` artifact of the card-month,
`ranked_myjcb_snapshots` an active `myjcb-credit-ledger` parse of a
`credit-ledger` artifact, and `eligible_snapshots` in
`packages/parsers/src/snapshot-query.ts` joins the snapshot policies on
`fa.dataset` and needs a published parse under the policy's parser. The
importer's captures therefore stay current, `staleCardPurchaseKeysSql`
reports no new stale key, and no live Vpass or MyJCB purchase event is
retired by this decision alone. No identity run or source-account reference
is created either, since those follow a parse.

What changes on its own: collection runs of these sources are recorded
(registered, blocked, or unsealed fetch runs for Vpass), and V Point Pay
emails from the deploy on are sealed with `dataset = NULL`. `fetch_artifacts`
is append-only, so those emails are not parsed when the dataset is fixed
unless that change also covers runs already registered without one.

The Vpass retirement would happen only once all of these are deployed, in
any order: the seal accepts the statement pages' lineage, the Processor
gives Vpass artifacts their datasets, and the Vpass parser publishes a parse
of a collector capture. [ADR 0023](0023-vpass-collector-card-binding.md)
holds the second of them: the registration dataset change withholds the
Vpass dataset until a change that makes the collector write its own card
binding releases it, so the order in which this decision and that change
merge does not matter for Vpass. The MyJCB churn needs the lineage and
dataset fixes for MyJCB; it double counts nothing, but it moves the
source's live events to new provider-local accounts.

## Verification

- `tests/collector-producers.test.ts`: fails with the old Vpass constant
  (`vpass-json`) and with a literal producer in a terminal writer (both tried
  on this branch before the fix was kept).
- The collectors' own terminal tests assert the new producer in the written
  manifest (Vpass, MyJCB, Sony Bank, Money Forward, V Point and its Email
  route, V Point Pay, GLOBAL PASS).
- `services/processor/test/card-purchase-producer-switch.test.ts`: the MyJCB
  churn and the Vpass retirement without replacement, on the real CORE schema
  in Miniflare.
- Merge safety: the four real run plans above were registered in a
  reviewer's scratch test on the real CORE schema (not kept in the tree),
  with the outcomes stated there and no parse run created.
- Not verified: registration of a real collector terminal in production after
  the deploy, the registration outcome of the Sony Bank, Money Forward ME,
  V Point Pay and GLOBAL PASS run plans, and the counts of the churn, which
  depend on what the collectors capture next.

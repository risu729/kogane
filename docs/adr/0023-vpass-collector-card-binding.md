# ADR 0023: Do not trust a card binding for collector-vpass runs until the collector writes one

- Status: proposed; amended to implement option 3 (see
  [Amendment](#amendment-option-3-implemented)), accepted when the amending PR
  merges
- Date: 2026-09-26
- Carried by:
  [identity operations](../identity-operations.md#collector-vpass-runs-bind-in-their-own-run),
  [collection: Vpass](../collection.md#vpass-servicescollector-vpass-kogane-vpass-collector-poc),
  [observations: Vpass](../observations.md#vpass-json-statement-observations),
  `services/collector-vpass/test/shared-collection.test.ts`

## Context

A Vpass row is recognised as a card purchase only when its identity run used
the trusted card binding (`VPASS_STABLE_IDENTITY_FAMILY`, identity policy 2,
[identity operations](../identity-operations.md#policy-2-trusted-vpass-sidecar-upgrades)).
The Vpass collector is switching its terminal producer from `vpass-json`,
which never registered, to `collector-vpass` (#259, ADR 0014 on that branch).
Every Vpass run in CORE so far was registered by the retired importer under
`collector-r2-importer`. #259 shows on synthetic data that a collector-vpass
capture of a card-month makes the importer's capture non-current, the purchase
lane retires the importer-era events, and the collector's rows are skipped as
`account_not_resolved`, so nothing replaces them. The question here is whether
collector-vpass runs can bind under the same trust rule.

What the binding requires, read from the code:

- **Where the rule lives.** The view `trusted_vpass_card_bindings`
  (migration 0020, recreated without the window count by 0021) is the only
  place the producer is pinned. `vpassPolicy` in
  `packages/storage-d1/src/core/identity-policies/vpass.ts` reads that view in
  `evidenceSql` and `loadEvidence`; `requiredIdentityPolicySql` takes the
  policy's `evidenceSql`, and the triggers on `identity_vpass_bindings` and
  `identity_run_seals` and the view `eligible_identity_runs` all join the
  same view. No code names a producer.
- **What the view accepts.** A financial run of source `vpass` and producer
  `collector-r2-importer` whose acquisition session has the namespace
  `vpass-worker-card-v1`, a card unit `card-NNN`, and a sibling fetch run in
  the **same session, source and producer** whose run key is
  `card-NNN-vpass-card-binding-v1`, holding exactly one card unit keyed
  `vpass-card-v1-<64 hex>` and exactly one `collector_derived` artifact
  `card-identity-binding.json` (dataset `card-identity-binding`, format
  `vpass-card-identity-binding-json` version `1`), both runs successful and
  the unit's terminal report a success.
- **Where the token came from.** The importer
  (`services/collector-r2-importer/src/vpass-identity.ts`, removed in #203)
  read the raw snapshot the legacy collector kept in its own bucket, took
  `externalId`, `globalid` and `cardCode` from the card-selection response's
  `header.vpSessionBean`, checked them against the discovery response and the
  card inventory, and stored only
  `vpass-card-v1-` + HMAC-SHA-256 of
  `["vpass-card-binding-v1", externalId, globalid, cardCode]` under the
  fingerprint key version `collector-r2-v1`
  ([Vpass card binding](../vpass-card-identity.md)).

What `services/collector-vpass` writes today in its shared-R2 run
(`src/shared-collection.ts`):

- No binding at all: a card run holds the three sanitized envelopes, the
  statement pages and `manifest.json`; there is no `collector_derived`
  artifact and no second run.
- No way to derive one later: the sanitizer replaces every key naming a
  session, so `vpSessionBean` and the tuple inside it are redacted before
  anything is stored, and the Worker has no fingerprint secret
  (`wrangler.jsonc`, `Env` in `src/worker.ts`). The raw responses exist only
  in the Worker's memory during a run.
- A different run shape: the Processor registers a shared-R2 terminal with
  the session namespace `shared-r2` and the run key
  `<runId>:terminal-registration-v1`
  (`packages/application/src/collection/descriptors.ts`), so neither the
  view's namespace condition nor its sibling-run join could match a collector
  run even if a binding run existed.

And what account a collector row resolves to. The source-account reference is
`identityKey("sa", [source, producer, account key])` and the account entity is
derived from that reference (`packages/storage-d1/src/core/identity-store.ts`).
Without a binding, a collector row gets the run-scoped key
`["vpass:card-NNN", "fetch-run", <run id>]`, an `unresolved` account per run.
With a trusted token it would get `["vpass:card", <token>]` under the producer
`collector-vpass`: a different source account and a different account entity
from the importer-era rows even for the same token, so their mappings and
manual decisions would not carry over either.

## Options considered

1. **Admit `collector-vpass` in the view (a new migration).** Rejected: no
   collector run can meet the rest of the rule, so the view would return the
   same rows as today. Making it match would mean dropping the sidecar or the
   session and run-key joins, which is binding on weaker evidence.
2. **Carry the importer's binding to a collector run of the same card
   ordinal.** Rejected: an ordinal is a position in the provider's card list,
   not identity ([Vpass card binding](../vpass-card-identity.md)), and the
   importer's binding proves only that the importer's own session saw that
   card at that position.
3. **Have the collector write an equivalent binding, then admit it.** The
   Worker holds the raw selection and discovery responses before it
   sanitizes them, so it could apply the importer's checks and HMAC in
   memory and store only the token. Deferred, not rejected: it needs the
   owner to provision the fingerprint secret on the collector Worker (the
   token equals the importer's only if the key is the same `collector-r2-v1`
   key, which cannot be checked from this repository), a binding artifact in
   the collector's terminal with a registered dataset, a new branch of the
   view for the shared-R2 run shape (a migration), a check that the current
   client's responses still carry the tuple, and an identity decision on
   whether a token under a new producer maps to the importer-era account
   entity (today it does not, see above). Each of these is a design change
   of its own.
4. **Record the gap and hold the switch.** Chosen for now.
5. **Map each collector account to the importer-era account by an explicit
   identity decision.** The identity operations already let an operator
   revise a source reference's mapping to an existing account
   ([identity operations](../identity-operations.md)), and a row whose
   mapping names a resolved account is not skipped as `account_not_resolved`.
   Rejected: without a binding every collector run gets its own run-scoped
   source reference, so the decisions would be one per card per run, forever
   (the collector runs daily); and the collector stores nothing that could
   support the claim, because the sanitizer replaces the card names and the
   session bean, so each decision would rest on the card's ordinal and the
   operator's memory. That is option 2 made by hand: the decision log would
   record an assertion no stored evidence can audit. An explicit decision
   stays the right tool for the one step option 3 leaves open, mapping a
   collector token's durable source account to the importer-era account once
   per card, where the evidence (the same HMAC token under the same key) is
   stored and checkable.

## Decision

The decision below was the state until the amendment; the
[amendment](#amendment-option-3-implemented) implements option 3 and replaces
its first two points and the hold's release condition.

- Nothing about the trust rule changes: `trusted_vpass_card_bindings` keeps
  accepting only the importer's runs, and no migration is added.
- collector-vpass runs have no trusted binding. Their rows resolve to
  run-scoped `unresolved` accounts under the producer `collector-vpass`, and
  card purchase recognition skips them as `account_not_resolved`.
- Collector-vpass captures must not become parseable in production (#259
  together with the registration dataset change) until option 3 is decided
  and implemented, unless the owner accepts that the importer-era Vpass
  purchases of every re-captured card-month leave the captured and authorized
  totals.
- The hold is enforced, not only ordered: the registration dataset change
  (ADR 0022) withholds the parser dataset from the Vpass collector's
  artifacts, so they register with no dataset and are never parsed, whatever
  order #259 and that change merge in. Only the change that implements
  option 3 releases the Vpass dataset, and it amends this ADR when it does.
  On `main` today the collector's artifacts carry no dataset either, and its
  producer `vpass-json` has no ingest route.
- `services/collector-vpass/test/shared-collection.test.ts` pins the facts
  this decision rests on, so a change to them fails a test and reopens it.

## Consequences

- Once a collector-vpass capture of a card-month is parsed, card usage for
  that card-month switches to the collector's rows (the currentness ranking
  ignores the producer), those rows show an unresolved account, and the
  purchase lane retires the importer-era events of that card-month without
  replacement. The retired revisions stay readable and nothing is counted
  twice. The captured and authorized totals drop by those events, and the
  retired events are counted as unresolved in the summary (#259's test), so
  the drop shows as unresolved rows rather than as less spending with no
  reason.
- Holding the switch leaves Vpass on the importer-era evidence, which no
  longer grows: new Vpass statement months are not observed until option 3
  lands or the owner accepts the loss above.
- Existing bindings, identity runs, mappings and decisions are untouched.
- If option 3 is implemented, the same card-month still churns once (the
  recognition key carries the producer), and account continuity for the
  importer-era mappings needs either the identity decision named in option 3
  or one explicit account-mapping decision per card by an operator.

## Verification

- `services/collector-vpass/test/shared-collection.test.ts` ("ADR 0023"): a
  card run whose selection and discovery headers carry a synthetic session
  bean stores no `card-identity-binding.json` and no `collector_derived`
  artifact, no stored byte holds the external id, global id, card code or a
  `vpass-card-v1-` token.
- Read from the code on main at `bd3f1a5`, not tested here: the view,
  trigger and policy references (migrations 0020/0021,
  `identity-policies/vpass.ts`, `identity-store.ts`,
  `packages/identity/src/other.ts`) and the registration namespace and run
  key (`createRunRequest` in `packages/application/src/collection/descriptors.ts`).
- The retirement without replacement is #259's
  `services/processor/test/card-purchase-producer-switch.test.ts` (Vpass).
  That test records the collector capture under the importer's session
  namespace; registration would record `shared-r2`, which does not change
  its result.
- The enforcement of the hold is ADR 0022's, and is verified by that
  change's tests, not here.
- Not verified: whether the collector's current responses still carry the
  session bean, and whether the owner still holds the `collector-r2-v1` key.

## Amendment: option 3 implemented

- Status: proposed; accepted when the amending PR merges
- Date: 2026-09-26
- Carried by:
  [identity operations](../identity-operations.md#collector-vpass-runs-bind-in-their-own-run),
  [collection: Vpass](../collection.md#vpass-servicescollector-vpass-kogane-vpass-collector-poc),
  [Vpass card binding](../vpass-card-identity.md#the-collectors-binding-adr-0023),
  `services/collector-vpass/src/card-binding.ts`,
  `packages/storage-d1/migrations/core/0055_vpass_collector_card_binding.sql`,
  `packages/storage-d1/src/core/identity-store.ts` (`accountEntityId`),
  `services/processor/test/vpass-collector-binding.test.ts`,
  `services/processor/test/vpass-binding-view.test.ts`

### Context

Option 3 named five open parts: the fingerprint secret on the collector, a
binding artifact with a registered dataset, a view branch for the shared-R2
run shape, whether the current responses still carry the tuple, and whether a
token under a new producer maps to the importer-era account entity. Building
it found a sixth. The collector's card unit declared `coverageStatus:
partial` on every successful run. Registration maps a unit's coverage to its
terminal report (`unitReportRequest` in
`packages/application/src/collection/descriptors.ts`: `complete` is
`success`, `partial` is `partial`), and `observation_fetch_runs` reports a run
`partial` when any unit report is not a success. The trusted view requires a
successful financial run, and `current_identity_observations` and the card
usage identity lookup read only successful runs, so a registered collector
card run would never bind and its rows would never have a current identity,
binding or not. The importer reported its card units as `success`.

### Options considered

For where the binding lives:

1. **A sibling run, as the importer wrote it.** Rejected: a shared-R2 terminal
   is one run, so a sibling would be a second terminal per card, registered on
   its own and possibly on another tick, and the view would have to join two
   registered runs by a registration run key. The card's own run is written
   terminal-last, so the binding and the capture it binds are one atomic,
   sealed record.
2. **A second unit of the card's own run.** Chosen. The token stays a unit key,
   which is where the view and the pin triggers read it.

For the view:

- **0021's select byte for byte, `UNION ALL` the collector's select.**
  Rejected as the shipped text, kept as the specification: `eligible_identity_runs`
  joins the view, SQLite does not flatten a compound view into a join, and the
  planner then materializes every row of the view behind an automatic index
  on each current identity read.
- **One select whose binding-run join finds the sibling run for the importer
  and the financial run itself for the collector.** Chosen, proven equal to
  the union on random stores, with 0021's plans.

For account continuity (the source-account reference includes the producer):

3. **Derive the entity from the token alone, for every producer.** Rejected:
   it changes the entity id of every importer-era token, so continuity would
   need a new mapping revision for every importer-era source account, and the
   entity ids already recorded in decisions and purchase events would name an
   entity no current mapping points at.
4. **Derive a trusted token's entity from the importer's reference for that
   token.** Chosen. The importer-era entity ids are unchanged, and a
   collector's source account for the same token maps to the same entity by
   rule. The token is the evidence in both cases; the producer only says who
   derived it.
5. **An explicit operator decision per card** (the original option 5's
   remaining use). Kept for the cases option 4 cannot cover (below), not as
   the default: the evidence is stored and mechanical.

For the card unit's coverage:

6. **Keep `partial` and change registration.** Rejected here: the mapping
   decides what every registered run of every source means, and changing it
   is a registration contract change (its version, re-registration) with its
   own decision.
7. **Declare the card unit `complete`.** Chosen. The unit collected every
   statement month the provider listed for the card (any failure fails the
   run), which is what the importer reported. The gap that is real, the
   rolling window of months, stays on the run's `coverageStatus: partial` and
   on the `statement-months` declared-coverage range.

### Decision

- **Collector.** `services/collector-vpass/src/card-binding.ts` derives the
  token in memory before sanitizing, with the importer's tuple, checks, HMAC
  construction and key version `collector-r2-v1`, keyed by the optional Worker
  secret `VPASS_CARD_BINDING_KEY`. It fails closed: no secret, a malformed
  secret, no tuple, a malformed tuple, an ambiguous inventory or a
  selection that disagrees with discovery stores the run without a binding and
  logs one closed code. It never stores or logs a tuple value. With a token,
  the run holds a second `card` unit keyed by the token (`complete`, one
  artifact) and `card-identity-binding.json` (`collector_derived`, one
  `extracted` step `vpass-card-binding` v1 with no input artifact, so its
  lineage registers as `source_bytes_not_available`). The card unit is
  `complete`, the run stays `partial`.
- **Registration.** `VPASS_CARD_BINDING_DESCRIPTOR` names the dataset
  `card-identity-binding` and format `vpass-card-identity-binding-json`
  version `1` for exactly that source, key, role and media type. It is not a
  parser dataset and is kept apart from ADR 0022's parser-dataset table.
- **View.** The specification is migration 0021's select, unchanged, `UNION
ALL` a shared-R2 select with the same requirements: a visible artifact of a
  successful, sealed Vpass run; the
  financial unit `card-NNN` of kind `card`; one binding unit of kind `card`
  keyed `vpass-card-v1-<64 lowercase hex>` with a successful terminal report
  and no other report; the binding artifact with the exact key, role,
  dataset, format and version. Where the importer's branch finds the binding
  in a sibling run by the key `card-NNN-vpass-card-binding-v1` in the same
  session, source and producer and requires that run to be the only one with
  that key and to hold one unit and one binding artifact, the new branch
  requires producer `collector-vpass`, namespace `shared-r2`, a run key naming
  the same ordinal (`*-card-NNN:terminal-registration-v<N>`), no unit in the
  run other than the two, and no second binding artifact in it. Migration
  0055 ships that specification as one select, not as the union: a compound
  view is not flattened into the join inside `eligible_identity_runs`, and
  SQLite then materializes the whole view behind an automatic index on every
  current identity read (the read model's keyed readiness plan test caught
  it). In the one select the collector's "binding run" is the financial run
  itself, reached by its own session, source, producer and run key, which
  `fetch_runs` holds unique; the specification is kept frozen in
  `services/processor/test/vpass-binding-legacy-sql.ts` and the shipped view
  is proven to return exactly its rows. Policy 2's evidence and loader,
  `requiredIdentityPolicySql`, the pin and seal triggers and
  `eligible_identity_runs` read the view by name and are unchanged.
- **Accounts.** `accountEntityId` derives the entity of a trusted Vpass token
  (`["vpass:card", token]` with the store-verified binding) from
  `identityKey("sa", ["vpass", "collector-r2-importer", key])`; every other
  entity is derived from its own reference as before. The resolver gives
  collector bindings the reason `verified-collector-durable-card-binding`.
- **The hold.** This change does not release the Vpass parser dataset; the
  collector's statement pages still register without one. The earlier
  decision that "only the change that implements option 3 releases the Vpass
  dataset" is narrowed: releasing it is a later change, made only after this
  change is deployed, the owner has set the secret, and the token check in
  [identity operations](../identity-operations.md#collector-vpass-runs-bind-in-their-own-run)
  shows the collector's tokens are the importer's.
- **The owner's one action** is to set `VPASS_CARD_BINDING_KEY` on
  `kogane-vpass-collector-poc` to the retired importer's
  `ORIGIN_FINGERPRINT_KEY`.

### Consequences

- With the secret and the tuple, a collector card run binds, identity policy 2
  resolves its rows to the token, and they map to the importer-era account
  entity. Once the pages are parsed, each re-captured card-month churns once:
  the importer's purchase event is retired and the collector's is recognised
  on the same account; nothing is counted twice and the retired revisions stay
  readable.
- What carries over is what is keyed by the entity: its label, role and
  status, ownership links on `account:<entity>`, and the `account_id` of
  purchases and settlements. What does not: the importer's source account
  keeps its own mapping revisions and manual decisions, and the collector's
  source account starts at its own rule revision. An operator's re-mapping of
  the importer's source account to another entity is not followed; the
  collector's source account needs the same decision again. Run-scoped manual
  decisions stay on their run. Recognition keys carry the producer, so no
  purchase event is carried over; each is recognised again.
- A secret that is not the importer's key derives other tokens: those cards
  become new entities with nothing carried over (still nothing counted twice).
  The bindings it registered stay (evidence is append-only); the token check
  before the release exists to catch it.
- Without the secret, or if the provider no longer sends the tuple, nothing
  binds and the earlier consequences hold.
- Collector card runs register as `success` instead of `partial` from this
  release on; terminals written before keep `partial` and stay unreadable to
  identity. None of them has been parsed.
- The same unit-coverage mechanism applies to other collectors. MyJCB's
  collector declares every connection unit `partial` on success, so its runs
  register as `partial` and its rows have no current identity; that is not
  changed here.

### Verification

- `services/collector-vpass/test/shared-collection.test.ts` ("ADR 0023"): the
  token equals the importer's construction written out independently; the
  run's units, the artifact's role, unit and step, and its payload; no tuple
  value in any stored byte and the token only in the terminal and the binding
  object; the token is the same across sessions and ordinals and differs by
  key and tuple; each fail-closed code, with no binding stored.
- `services/processor/test/vpass-collector-binding.test.ts`: the collector's
  real plan, persisted and registered on every CORE migration plus the
  operator bootstrap, seals as a successful run whose binding has the
  dataset, format and lineage above; the view admits its four financial
  artifacts with that token; a statement page parsed by the deployed parser
  is identified under policy 2 through the pin and seal triggers and appears in
  `current_identity_observations` on `["vpass:card", token]`. Without the
  secret the view is empty and the rows are run-scoped and unresolved. In the
  card world: the view's guards (importer producer, namespace, run key, a
  third unit, a second binding, a non-success binding report, a malformed
  token, no binding); the importer-era event of a card-month retired and
  recognised once under the collector's producer on the same account entity,
  both source accounts mapped to it, totals unchanged and every prior row
  kept; without a binding, `account_not_resolved`; under another key, a new
  entity and nothing counted twice.
- `services/processor/test/vpass-binding-view.test.ts`: on 60 random stores
  (both binding shapes, and wrong producers, namespaces, run keys, unit kinds
  and keys, token shapes, reports, artifact fields, extra units, extra
  bindings, failed and hidden runs and artifacts) the shipped view returns
  exactly the specification's rows, and its importer rows are exactly
  migration 0021's; eight mutations of the shipped select are each caught.
- `services/processor/test/binding-query-plan.test.ts`: after 0055 the lookup
  by artifact, the correlated lookup, the policy loader's lookup and the two
  identity views take 0021's plan steps, except that the identity views reach
  the binding run by its unique key instead of its row id; no scan, automatic
  index or co-routine is added, without table statistics. The read-model and
  application plan suites (keyed card settlement readiness) pass on it; they
  failed on the union form.
- `packages/identity/test/identity-other.test.ts`: the collector's token keys
  the same account reference as the importer's.
- Not verified: whether the provider's current responses still carry the
  session bean (no provider was contacted), and whether the owner's key is the
  importer's (the token check after deploy answers it). The MyJCB statement is
  read from its collector's plan output and the registration code, not from a
  registered MyJCB run.

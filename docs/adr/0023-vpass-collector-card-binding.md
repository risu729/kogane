# ADR 0023: Do not trust a card binding for collector-vpass runs until the collector writes one

- Status: proposed
- Date: 2026-09-26
- Carried by:
  [identity operations](../identity-operations.md#collector-vpass-runs-have-no-trusted-binding),
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

1. **Admit `collector-vpass` in the view (migration 0055).** Rejected: no
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

## Decision

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
- Not verified: whether the collector's current responses still carry the
  session bean, and whether the owner still holds the `collector-r2-v1` key.

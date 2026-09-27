# ADR 0027: The MoneyForward collector derives the account identity the parser requires

- Status: proposed; amended by [ADR 0029](0029-data-classification-and-unkeyed-identity.md)
  (the identity is derived without a key; see
  [Amendment: ADR 0029](#amendment-adr-0029-the-identity-needs-no-key))
- Date: 2026-09-27
- Carried by:
  `services/collector-moneyforward/src/account-identity.ts`,
  `services/collector-moneyforward/src/shared-collection.ts`,
  `packages/storage-d1/src/core/identity-store.ts` (`accountEntityId`),
  [collection: Money Forward ME](../collection.md#money-forward-me-servicescollector-moneyforward-kogane-moneyforward-collector-poc),
  [identity operations](../identity-operations.md#moneyforward-collector-runs-carry-the-account-identity),
  [MoneyForward source record](../sources/moneyforward.md),
  `services/collector-moneyforward/test/account-identity.test.ts`,
  `services/processor/test/moneyforward-shared-r2.test.ts`,
  `services/processor/test/moneyforward-producer-switch.test.ts`,
  `services/processor/test/collector-plans.test.ts`
- Related: [ADR 0023](0023-vpass-collector-card-binding.md) (the same move for
  Vpass, option 3), [ADR 0021](0021-collector-registration-contract.md) and
  [ADR 0022](0022-registration-artifact-datasets.md) (registration and the
  parser datasets it gives), [ADR 0026](0026-collector-unit-coverage.md) (the
  unit coverage that makes a successful run parseable)

## Context

The first MoneyForward run the collector wrote to the shared bucket
registered on 2026-09-26 under the producer `collector-moneyforward-me`, and
every page of it that names an account failed to parse: 48
`moneyforward-monthly-transactions` artifacts and 4
`moneyforward-canonical-evidence-boundary` artifacts (the account-detail
pages) are `parser_rejected` (production counts, read by the owner's agent;
nothing else was read).

The cause is in the code. Both parsers
(`packages/parsers/src/parsers/moneyforward.ts`, `requireAccountIdentity`)
require the artifact's unit key to match `^moneyforward-account-v1-[0-9a-f]{64}$`.
That is the identity the retired importer derived
(`services/collector-r2-importer/src/moneyforward-account-identity.ts`,
removed in #206): for each account-detail page, the values of its one
`<input name="account[id_hash]">` and one `<input name="service[id]">`, each
1-4096 characters of `[A-Za-z0-9_-]`, turned into
`moneyforward-account-v1-` + HMAC-SHA-256 of
`JSON.stringify(["moneyforward-account-v1", account[id_hash], service[id]])`
under the fingerprint key `ORIGIN_FINGERPRINT_KEY`, key version
`collector-r2-v1`. The importer also refused a run in which two details shared
an ordinal or an identity, a detail's `account[id_hash]` was not the `NN`th of
the index's sorted distinct `/accounts/show/<id>` links, or a successful run
had fewer identities than details. The collector
(`services/collector-moneyforward/src/shared-collection.ts`) keyed its units
positionally, `account-NN`, from its own filenames. A position in the
accounts index is not identity: linking or unlinking a service moves every
later account ([identity sources](../identity-sources.md): "MoneyForward HMAC
identity is stable across ordinal changes").

The accounts index is not rejected: it names no account, and the evidence
parser does not ask it for an identity.

Unlike Vpass (ADR 0023), nothing is redacted before storage: the collector
stores the account-detail pages as the provider returned them, as the importer
did, so the two inputs are in the Worker's memory and in the stored page
bytes. What was missing is only the key and the derivation.

## Options considered

1. **Let the parser accept the positional key.** Rejected: `account-NN` is a
   position, not identity. Two runs on either side of a linked service being
   added would give one account's months to another, and the current snapshot
   of an account-month (`current_moneyforward_snapshots`, partitioned by unit
   key and month) would then replace one account's rows with another's.
2. **Derive the importer's identity in the collector.** Chosen. The tuple, the
   checks and the HMAC construction are the importer's; only where it runs
   changes. Under the importer's key the identity of an account is the one the
   importer registered.
3. **A new identity scheme** (other inputs, another construction, a version
   `v2`). Rejected: nobody has observed that the importer's inputs stopped
   being stable, and a new scheme would make every account a new entity with
   no evidence that one was needed (ADR 0004: unobserved semantics stay
   unsupported).

For the account entity (the source-account reference includes the producer,
so the importer's and the collector's references for one identity differ):

4. **Leave each producer's reference its own entity.** Rejected in review:
   one provider account would be two entities, and what is keyed by the
   entity (its label, role and status, ownership links, operator decisions on
   `account:<entity>`) would not follow the account across the producer
   switch, although the evidence that they are the same account is stored
   and mechanical.
5. **Derive the entity of an identity from the importer's reference for that
   identity, whichever producer read it.** Chosen, as ADR 0023 did for a
   trusted Vpass token. An identity is an HMAC of the provider's own account
   tuple under a secret key, so two equal identities are the same key and the
   same account; nothing about it is a heuristic. The importer-era entity ids
   are unchanged.
6. **Keep the collector's captures of the months the importer captured out of
   the current snapshot until a decision.** Rejected: under the importer's
   key the snapshot ranking already reads each account-month once (below), so
   there is nothing to hold; under another key the read could not tell an
   account the importer knew under another identity from an account linked
   since, without guessing.

## Decision

- **Collector.** `services/collector-moneyforward/src/account-identity.ts`
  derives, for every account-detail page of a run, the importer's identity:
  parse5 (8.0.1, the importer's parser) reads every `<input>` named
  `account[id_hash]` or `service[id]`, template content included; each must
  occur once and match `^[A-Za-z0-9_-]{1,4096}$`; the ordinal is the page's
  `account-detail-NN.html` (1-64); no ordinal or identity may repeat; when the
  run holds `accounts.html`, the `NN`th of its sorted distinct
  `/accounts/show/<id>` links must be the page's `account[id_hash]`. The HMAC
  is keyed by the optional Worker secret `MONEYFORWARD_ACCOUNT_IDENTITY_KEY`
  (64 lowercase hex). The pages are read as the run stores them (their UTF-8
  bytes, decoded strictly).
- **Units.** With an identity for every account, `moneyForwardRunPlan` keys
  each account's unit, its `requestedScope.unitKeys` entry and its
  `months-<unit>` range by the identity; each unit's `artifactCount` is the
  artifacts naming it (its detail and its months). The artifact keys stay
  positional (`account-detail-NN.html`, `account-NN-month-YYYY-MM.html`); the
  parser reads the ordinal and month from them as before. The format passes
  registration (`IDENT` in `packages/collection/src/manifest.ts` allows 200
  characters; the identity is 88).
- **Fail closed, for the whole run.** No secret, a secret that is not 64
  lowercase hex, a detail without one of the inputs, a repeated or malformed
  input, a repeated ordinal or identity, a detail that disagrees with the
  index, or an account (a detail or month filename, or a successful run's
  `accountDetailCount`) without an identity: the run is stored with positional
  units, as before this change, and the parser keeps rejecting its account
  pages. That rejection is the intended outcome, not something to loosen.
- **What is logged.** The persist diagnostic (`moneyforward-shared-collection`)
  carries `identity`: `derived`, or one of `identity_key_absent`,
  `identity_key_invalid`, `identity_tuple_absent`, `identity_tuple_invalid`,
  `identity_duplicate`, `identity_index_mismatch`, `identity_incomplete`. No
  identifier, identity or key is logged, and the terminal and the collector's
  `manifest.json` carry no identifier or key (the page bytes carry the
  identifiers, as the importer's did).
- **Key version.** The identity carries no key version. It equals the
  importer's for the same account only under the importer's key
  (`collector-r2-v1`). Nothing here, and no other code, maps an identity
  derived under another key to the importer's.
- **Accounts.** `accountEntityId` in
  `packages/storage-d1/src/core/identity-store.ts` derives the entity of a
  MoneyForward identity (`["moneyforward-me:moneyforward-account-v1-<64 hex>"]`)
  from `identityKey("sa", ["moneyforward-me", "collector-r2-importer", key])`,
  for every producer. For the importer's own references this is the entity
  they already had; a collector's reference for the same identity maps to that
  entity by rule; an identity the importer never registered gets an entity no
  importer reference names. Every other entity is derived from its own
  reference as before. The mapping's status and reason
  (`provider-local`, `verified-hmac-account-service-tuple-not-direct-account-alias`)
  are unchanged, and no identity policy version changes: no collector
  MoneyForward row has been identified before this change (every one was
  `parser_rejected`), so no existing mapping moves.
- **Nothing else changes.** No parser, parser version, identity pattern
  (`packages/identity/src/other.ts`), registration rule, dataset or migration
  changes. MoneyForward's parser datasets are not withheld (ADR 0022), so a
  run that carries identities is parsed as soon as it registers.
- **The owner's one action** is to set the secret on
  `kogane-moneyforward-collector-poc`
  (`wrangler secret put MONEYFORWARD_ACCOUNT_IDENTITY_KEY --name kogane-moneyforward-collector-poc`,
  entering 64 lowercase hex characters at the prompt): the retired importer's
  `ORIGIN_FINGERPRINT_KEY` if the owner still holds it, then the read-only
  identity check in
  [identity operations](../identity-operations.md#moneyforward-collector-runs-carry-the-account-identity)
  after the next collection.

## Consequences

- **Under the importer's key**, each account's identity is the importer's.
  The collector's capture of an account-month becomes that account-month's
  current snapshot (the ranking partitions by unit key and month and ignores
  the producer), so it replaces the importer's snapshot of the same month
  rather than adding to it; months only the importer captured stay current.
  Nothing is counted twice and the importer's parses stay readable (INV06).
  That read is the only one MoneyForward rows reach: MoneyForward emits
  transactions only (no balance, position or valuation), and card usage,
  purchase recognition, reconciliation and settlement read only named
  card and bank sources (`vpass`, `myjcb`, `smbc-bank`, `sbi-shinsei-bank`),
  never `moneyforward-me`. The identity reads count observations per source
  reference, as they already counted every importer re-capture, not provider
  rows. The collector's rows get their own source account
  (`moneyforward-me:<identity>` under `collector-moneyforward-me`), which maps
  to the importer-era account entity (option 5), so what is keyed by the
  entity carries over. What does not: the collector's source account starts
  at its own rule revision, with none of the importer's source account's
  mapping revisions or manual decisions; an operator's re-mapping of the
  importer's source account to another entity is not followed and needs the
  same decision again; and account connection reviews
  (`account_connection_reviews`) are keyed by producer and connection key, so
  the importer-era ones do not cover the collector's reference.
- **Under a new key** (a limit, not a design choice), every identity differs:
  each account becomes a new unit, source account and entity, with nothing
  carried over, and no mapping to the importer-era accounts is added (agents
  never decide identity). The importer-era accounts stay as historical
  evidence under their own identities. Their latest snapshot of each month
  stays current, because a collector capture of the same month has a
  different unit key, so for the months both captured the MoneyForward
  transactions read lists the same provider rows under two source accounts
  (no total is computed over them, but the list shows them twice). Nothing
  merges or hides them; that needs its own decision. The identity check
  after the first run with the secret shows it (`known_to_importer` zero);
  removing the secret stops new identities, and those registered stay
  (evidence is append-only).
- **Without the secret**, or when a check fails, runs keep registering with
  positional units and their account pages are `parser_rejected`, as the first
  shared run's were. The registered 2026-09-26 run keeps its positional units
  (terminals are immutable); it is not re-derived.
- The collector's Worker bundle now includes parse5.

## Verification

- `services/collector-moneyforward/test/account-identity.test.ts`: the
  identity of two synthetic accounts equals a known answer computed by the
  retired importer's own `moneyForwardAccountKeys` (from git history, at
  `49d5d65^`) and checked with `openssl dgst -sha256 -mac HMAC`, and equals a
  second HMAC implementation (`node:crypto`); the plan's artifact units,
  `requestedScope.unitKeys`, units and ranges; the terminal holds the identity
  but no identifier or key, the diagnostic holds `identity: derived` and no
  identity, identifier or key, and the stored `manifest.json` holds no
  identity or key; the identity survives an ordinal move and differs by
  service, by tuple boundary (`["ab","c"]` against `["a","bc"]`) and by key;
  inputs inside `<template>` and unquoted attributes read as parse5 reads
  them; each fail-closed code (14 cases) leaves positional units and puts only
  its code in the diagnostic; the Worker passes the secret (absent, invalid,
  set) and never logs it.
- `services/processor/test/moneyforward-shared-r2.test.ts`: the collector's
  real plan with a synthetic key, persisted and registered on every CORE
  migration plus the operator bootstrap, seals as a `success` run whose one
  unit is the identity with 3 declared and 3 catalogued artifacts; the sweep
  parses the two monthly fragments under `moneyforward-monthly-transactions`
  2.0.2 and the index and detail under
  `moneyforward-canonical-evidence-boundary` 1.0.1, with 0 errors; the month's
  two rows carry `moneyforward-me:<identity>`; identity resolves them to one
  `aggregator-mirror`, `provider-local` account on the collector's source
  account; the identity check query runs. Without the key the same plan
  registers with the unit `account-01`, the index parses, and the detail and
  both fragments are `parser_rejected` with no observation.
- `services/processor/test/collector-plans.test.ts`: a MoneyForward plan with
  the key registers and seals with its unit keyed by the identity and a
  catalogued count equal to the declared one; the plan without it still
  registers as before.
- `services/processor/test/moneyforward-producer-switch.test.ts`: an
  importer-era run (producer `collector-r2-importer`, the identity as unit
  key, January and February) and the collector's later run under the same key
  (February), both registered and parsed on every CORE migration: the shipped
  transactions read (`transactionsSql`) lists January's rows from the
  importer and February's once, from the collector; the importer's February
  observations are still stored; the two producers' source accounts map to
  the one account entity the importer's already had, and one `accounts` row
  exists. Under another key the read lists February under both source
  accounts and the two map to different entities (the stated limit). With the
  rule removed the first test fails on the entity.
- Read from the code, not changed or tested here: the parsers' identity check,
  the identity pattern in `packages/identity/src/other.ts` and
  `docs/identity-sources.md` (unchanged), the snapshot ranking in
  `packages/read-model/src/sql.ts`, and the source filters of card usage,
  purchase recognition, reconciliation (`RECONCILIATION_SLICES`) and
  settlement readiness, none of which names `moneyforward-me`.
- Not verified: whether the owner still holds the importer's key (the check
  after deploy answers it), and whether the provider's current account-detail
  pages still carry both inputs (the diagnostic's code answers it on the first
  run; the production failure says the pages registered, not what they hold).

## Amendment (ADR 0029): the identity needs no key

2026-09-27. [ADR 0029](0029-data-classification-and-unkeyed-identity.md)
classifies `account[id_hash]` and `service[id]` as provider-local opaque
identifiers that central storage may hold, so the HMAC above is no longer
needed, and the importer's key is lost. The collector now derives
`moneyforward-account-v2-` + SHA-256 of
`JSON(["moneyforward-account-v2", account[id_hash], service[id]])` with the
same checks and closed codes, minus `identity_key_absent` and
`identity_key_invalid`, which can no longer occur; every run derives.
`MONEYFORWARD_ACCOUNT_IDENTITY_KEY` and the owner action above are removed.
The parsers (`moneyforward-monthly-transactions` 2.0.3,
`moneyforward-canonical-evidence-boundary` 1.0.2), the identity rule and the
transactions read accept both `moneyforward-account-v1-` and
`moneyforward-account-v2-` unit keys. An account's v1 and v2 identities are
different values and so different account entities, and the months both
producers captured are listed under both until a separate, reviewed crosswalk
joins them. The text above is left as it was decided.

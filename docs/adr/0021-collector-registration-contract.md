# ADR 0021: Collectors state the registration contract; the Processor's refusals stay

- Status: proposed
- Date: 2026-09-26
- Carried by:
  [collection: the registration contract](../collection.md#shared-data-bucket-per-source-u09),
  [processor §3](../processor.md#3-idempotency-and-what-blocks),
  `services/processor/test/collector-plans.test.ts`
- Related: ADR 0014 and #259 (producer ids, blocker 1 below), the Processor PR for
  registered artifacts without a `dataset` and its ADR 0022 (blocker 4)

## Context

Since U09 (#184, 2026-09-12) every shared-R2 collector writes a `terminal-v1`
manifest and the Processor derives CORE descriptors from it
(`packages/application/src/collection/descriptors.ts`). A read-only
investigation on 2026-09-26 (aggregate counts only) found that every source
but Mizuho either failed registration or registered artifacts no parser
selects. Four independent blockers:

1. **Producer ids.** Eight terminal sources name a producer other than the
   one their ingest route declares (`collector-<terminal source>`), so the
   route is inactive and the run stays retryable. Fixed by the producer-id
   PR (#259, ADR 0014), not here.
2. **`artifact_lineage_unstated`.** The derivation refuses a
   `collector_derived` artifact that no transformation names as its output,
   and CORE's CHECK (`0001_initial.sql`) forbids a derived artifact with
   lineage `not_applicable`. sbi-securities (all seven datasets), sbi-shinsei
   (its `manifest.json`, declared `collector_derived`), MyJCB
   (`discovery.json`, `credit-ledger-NN.json`), V Point and V Point Pay stated
   none. Registration opens the fetch run and then derives every descriptor,
   so the first refused artifact blocks the whole run, financial captures
   included. sbi-securities and sbi-shinsei were blocked on all 14 of their
   runs each.
3. **`run_inventory_incomplete`.** sbi-vc-trade and GLOBAL PASS put the
   run's `manifest.json` on the `account` unit but left it out of the unit's
   `artifactCount`. CORE's seal trigger requires a unit's `direct` count to
   equal the artifacts that name it, and raises `run_inventory_incomplete`.
   That is not a derivation refusal, so registration rethrows it, records no
   stage row, and retries every tick with the artifacts catalogued and
   unsealed: 14 sbi-vc-trade fetch runs, none visible.
4. **`dataset` NULL** on registered artifacts, so no parser selects them.
   Fixed by a Processor PR and its ADR 0022, not here.

Nothing caught 2 or 3 before production. Each collector's suite read its own
terminal, and the Processor's suite registered a synthetic vocabulary
(`collection.test.ts`), so each side was correct against itself.

Writing the test that pushes each collector's real `*RunPlan` output through
registration (below) found three more shapes of the same kind, none of them
in production yet: SMBC Direct has blocker 3 (it is human-triggered, and the
investigation did not see a finished backfill); Vpass declares its statement
pages `provider_response` with a `redacted` step, and the seal trigger accepts
only `decrypted` or `extracted` steps on a provider role
(`run_inventory_incomplete`); V Point Pay states its month range as `yyyyMM`,
which the ingest range contract refuses (`invalid_start_value`).

## Options considered

1. **Relax the Processor.** Treat a stepless `collector_derived` artifact as
   `source_bytes_not_available`, ignore a unit's count, or derive units
   itself. Rejected: `descriptors.ts` exists so that "nothing is invented"; a
   lineage or a count the collector did not state would be the Processor
   inventing it, and CORE's CHECK constraints and seal trigger enforce the same rules
   underneath, so the Processor would have to disagree with its own schema.
2. **Change the roles only** (declare derived datasets as provider roles).
   Rejected for re-encoded bytes: `Response.text()` re-encoded, or a
   collector's own envelope, is not the provider's bytes, and a provider role
   with no step claims `exact` fidelity.
3. **The collectors state what they do, and one test proves every collector
   registers.** Chosen.

## Decision

The registration contract a collector states in its terminal:

- **Lineage.** Every `collector_derived` artifact is the output of at least
  one transformation: `extracted` (the collector read fields out of provider
  responses) or `reencoded` (the response text decoded and encoded again),
  by the collector — `transformerId` `collector-<collector id>` or its own
  named transformer — at the producer version. `inputArtifactKeys` names the
  artifacts of the same run it was derived from; when the input was never
  stored the list is empty, which the Processor records as
  `source_bytes_not_available`, never as an invented parent.
  - sbi-securities: one `extracted` step per dataset, no input.
  - MyJCB: `credit-ledger-NN.json` is `extracted` with input
    `<connection>/credit-detail-NN.html` when the run holds it (the page is
    parsed before redaction; the relation names the redacted capture of that
    page, the only form of it kept), no input otherwise; `discovery.json` is
    `extracted` with no input.
  - V Point, V Point Pay: one `reencoded` step per stored response, no input.
- **Roles.** A sanitizer's output is `sanitized_provider_capture` with a
  `redacted` step (Vpass statement pages move there). A provider role carries
  the provider's bytes with no step. A collector's own run manifest is
  `collector_manifest`, never `collector_derived` (sbi-shinsei).
- **Units.** A run manifest names no unit, and a unit's `artifactCount` is
  exactly the number of artifacts whose `unitKey` is that unit. This is the
  convention MyJCB, Money Forward ME and St.George already followed and the
  one migration 0037 describes ("a run-level manifest has no unit"); counting
  the manifest in the unit instead would attribute a run-level record to one
  unit. sbi-vc-trade, GLOBAL PASS and SMBC Direct drop the manifest's
  `unitKey`; Sony Bank and Vpass, which named the unit and counted it, move to
  the same convention so there is one rule.
- **Ranges.** A `month` range states `YYYY-MM` (V Point Pay).
- **The test.** `services/processor/test/collector-plans.test.ts` calls every
  collector's real `*RunPlan` function with synthetic inputs, persists the
  plan with the collection writer, and registers it through the in-process
  port against every CORE migration plus `infra/bootstrap/ingest-clients.sql`.
  A case passes only when the run is registered and sealed with every
  artifact catalogued, no stage is blocked or retryable, every
  `collector_derived` artifact has a step and a `linked` or
  `source_bytes_not_available` lineage, no `collector_manifest` has a unit,
  and every unit's declared count equals its artifacts. It lives in
  `services/processor` because that workspace already runs the full CORE
  schema and typechecks cross-workspace sources cleanly.
- **Producers are not changed here.** They were fixed by #259
  ([ADR 0014](0014-collector-producer-ids.md)); the test asserts that every
  plan names its route's producer and stubs nothing.

The Processor's refusals, `descriptors.ts` and the registration contract
version (`terminal-registration-v1`) are unchanged: every terminal that
registered before registers to the same descriptors.

## Consequences

- A run written by a redeployed collector registers and seals; the test fails
  on any collector that breaks the contract again, whichever side changes.
- Terminals are immutable, and the ones written before each redeploy keep the
  old shapes. The 14 sbi-securities and 14 sbi-shinsei runs blocked since U09
  stay blocked: a block is write-once. Re-registering them under a bumped
  `REGISTRATION_CONTRACT_VERSION` (the Processor PR's change) gives them a new
  identity, but the same derivation would refuse the same terminals again;
  whether and how they become registrable (a derivation that accepts a named
  legacy shape, or corrected terminals as new revisions) is ADR 0022's
  decision, not this one's.
- The 14 sbi-vc-trade runs keep catalogued, unsealed artifacts and are
  tried again on every scan cycle, because a seal-trigger refusal is rethrown rather
  than recorded. Classifying it as a block is a Processor change left open.
- Sony Bank's and Vpass's terminals change shape (the manifest names no unit,
  a Vpass card's `artifactCount` drops by one, Vpass pages change role). None
  of their runs has registered yet (blocker 1), so no registered run is
  reinterpreted.
- V Point Pay's app collector is stopped; its fix applies when it is
  re-enabled.

## Verification

- `services/processor/test/collector-plans.test.ts`: 15 cases — Mizuho,
  Mobile Suica, St.George, SMBC Direct, sbi-securities, sbi-shinsei,
  sbi-vc-trade, GLOBAL PASS, MyJCB, V Point, V Point Pay, V Point Pay email,
  Money Forward ME, Sony Bank and Vpass. Run against the collector sources of
  the base commit (bd3f1a5, with the producer stubbed to the route's for the
  eight sources #259 later fixed), 10 fail: `artifact_lineage_unstated`
  (sbi-securities, sbi-shinsei, MyJCB, V Point), `run_inventory_incomplete`
  (SMBC Direct, sbi-vc-trade, GLOBAL PASS, Vpass), `invalid_start_value`
  (V Point Pay) and the manifest-unit rule (Sony Bank, which registered);
  Mizuho, Mobile Suica, St.George, V Point Pay email and Money Forward ME
  pass. With the collector changes all 15 pass.
- Each changed collector's own suite asserts its new shape: the steps
  (sbi-securities, MyJCB, V Point, V Point Pay), the manifest role
  (sbi-shinsei), the manifest without a unit and the unit counts (sbi-vc-trade,
  GLOBAL PASS, SMBC Direct, Sony Bank, Vpass), the Vpass page role and the
  V Point Pay month range.

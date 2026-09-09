# Economic events, allocations, obligations and reconciliation

Architecture addendum A10 (findings AR07 and AR08; addendum 07; root review 09
§2–§4). This change adds the first Layer C vertical slice: a rule that proposes
matches between observations, a decision that adopts one, and an event model
with typed legs, allocations, obligations and settlements that the read side can
explain down to the raw bytes.

Nothing here rewrites Layer A or Layer B. No observation is updated or deleted,
no parser version changes, and the existing visible result set is unchanged
while both flags are off.

## What is automatic and what is proposal-only

| Step                                                      | Who does it                                               |
| --------------------------------------------------------- | --------------------------------------------------------- |
| Producing candidates from published observations          | The rule job, whenever `RECONCILIATION_ENABLED` is on     |
| Accepting a candidate                                     | A decision in the decision log, through a guarded command |
| Accepting a candidate the provider itself linked          | The rule, **still** as a recorded `accept` decision       |
| Anything from amount + date closeness, a heuristic, or AI | Proposal only. Never accepted without a decision (INV07)  |

A confidence number is not produced anywhere. A candidate carries rationale
codes and rejection conditions, which is what a reviewer needs; a score is at
most an ordering aid and never evidence or authority (addendum 07 §3).

## Tables (migration `0032_economic_events.sql`)

Additive only. Every table has the `*_no_delete` / `*_no_replace` triggers of
0018 and 0029, and no column that carries a fact is ever updated. Exactly two
one-shot pointers may be written after insert, each guarded by a trigger:

- `superseded_by` on `economic_event_revisions`, `obligation_revisions`,
  `allocations` and `settlement_relations`;
- `(status, decision_revision_id)` on `reconciliation_proposals`, which records
  which decision resolved a candidate.

| Table                      | Role                                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reconciliation_proposals` | One candidate: `kind`, `stage` (A/B/C), typed `target_refs_json` (`SourceFactRef`s), `method` (`rule`/`manual`/`ai`), `policy_release`, `rationale_codes_json`, `rejection_conditions_json`, `evidence_refs_json`, `status`, `proposal_digest`. |
| `economic_event_revisions` | One adopted event revision: `kind`, `state` (checked against its own kind family), `unknown_reason`, `effective_time_json` (a `TemporalValue`), `basis`, `evidence_support_json`, `decision_revision_id`, `superseded_by`.                      |
| `economic_legs`            | The legs of one event revision: `subject_ref`, `unit_ref`, decimal-v1 `value_status`/`coefficient`/`scale`, `role` (`increase`/`decrease`/`fee`/`unresolved`), `basis`.                                                                         |
| `allocations`              | How much of one source component is attributed to one effect: `source_component_ref`, `target_effect_ref`, `role`, `unit_ref`, `coefficient`, `scale`.                                                                                          |
| `obligation_revisions`     | Principal, `fee_components_json`, `schedule_json`, `state` with `state_evidence_refs_json`, creditor and debtor.                                                                                                                                |
| `settlement_relations`     | N-to-M settlement: allocated amount, `occurred_json`, and the `unresolved_*` difference kept beside it.                                                                                                                                         |

Views `current_economic_events`, `current_obligations`, `current_allocations`
and `current_settlement_relations` are the live revisions (`superseded_by IS
NULL`). A superseded revision is retained, so a report that cited
`event:<id>@<revision>` keeps resolving to the same numbers.

`allocations` has a partial unique index on
`(source_component_ref, target_effect_ref, role) WHERE superseded_by IS NULL`.
Citing an observation twice as supporting evidence stays possible; allocating
its amount twice into the same live set does not (INV06).

### Where the decisions live

Judgements are recorded in `decision_revisions` (migration 0029). Its
`subject_kind` CHECK admits only `account_mapping`, `instrument_mapping` and
`relation`, and 0029 cannot be edited, so every A10 judgement uses
`subject_kind='relation'` with a prefixed `subject_ref`: `proposal:`, `event:`,
`obligation:`, `allocation:` or `settlement:`. The prefixes keep those subject
namespaces disjoint from the `entity_relations` ids, which use the bare form.

`RELATION_STATUSES` in `packages/domain` diverged from the stored
`entity_relations.status` CHECK (`proposed|accepted|rejected|released`). The
domain type is now the union of both wordings and `RELATION_STATUS_STORAGE` maps
a domain value to the stored one (`adopted → accepted`, `superseded →
released`). The DB CHECK is unchanged.

## Domain contracts (`packages/domain`)

- `src/events.ts` — `SourceFactRef`, `EconomicEventRevision`, `EconomicLeg`,
  `ObligationRevision`, `SettlementRelation`, the per-kind state families and
  `eventTransition`, plus the pure checks:
  - `conservationCheck` — `source decrease = destination increase + explicit fee
    - unresolved difference`, **per unit**. Legs in more than one unit are
returned side by side with `cross_unit_requires_fx_model`; signed amounts in
      different units are never added and never forced to zero (SC05: 1,005 AUD
      against 95,000 JPY). A single-unit event must balance, and any gap is
      reported rather than absorbed into a fee.
  - `splitFillCheck` — `sum(fills) ≤ executed quantity`.
  - `settlementCheck` — `sum(allocations) ≤ eligible outstanding`, and the
    resulting obligation state comes from what was actually allocated.
  - `refundAllocation` — refunds with an unknown counterpart stay unallocated
    and visible; an over-refund is reported as an `over_refund` exception with
    the excess, never absorbed into the purchase (SC03, UC17).
  - `effectiveRate` and `referenceQuoteDifference` — the second returns
    `kind: "estimate"`, deliberately not a fee (UC21).
  - `legTotal` — a total for one basis and unit; two bases are never summed.
- `src/reconcile.ts` — the stage A/B/C candidate matcher. It returns proposals
  with rationale codes only, always `status: "proposed"`, and
  `autoAcceptable: true` only when the provider itself linked the pair inside
  one verified namespace (source + credential epoch + account namespace).

## Matching stages

- **Stage A — the same provider row observed twice.** Provider-identifier
  equality inside one identifier namespace. A collector fingerprint is not a
  provider identifier: such a pair is proposed and reviewed.
- **Stage B — a revision or a second display inside one provider.** Pending
  against posted. Amount and date closeness alone yields a candidate, never an
  acceptance: two purchases of the same amount on the same day must not be
  collapsed (UC13, UC23, SC03). More than one heuristic candidate for one
  pending row marks all of them `multiple_candidates` / `candidate_not_unique`.
- **Stage C — a correspondence across sources.** Equal opposite amounts on
  nearby days never establish ownership; without an established owner on both
  sides the candidate carries `owner_not_established`, and cross-source
  correspondences are reviewed at this stage whatever else agrees.

`RECONCILIATION_KINDS` is a strict subset of the `entity_relations` kinds of
0029, so an accepted proposal can always be written as a relation without
widening that closed list. Settlement is not one of them: it is a first-class
`settlement_relations` row with its own allocated amount, not a bare edge.

## The vertical slice that runs

`services/observation-pipeline/src/reconciliation-job.ts` runs stage A and
stage B over **one** source pair: **pending against posted inside the Vpass
statement page**. That parser emits two provider displays of the same card and
statement month — the `customized` family with provider status `unconfirmed`
(a pending authorisation) and the `web` family with `posted` — under one
`vpass:<card>` source account. It is the only pair in the deployed parser set
where both sides of a pending/posted revision exist in one identifier
namespace, so no cross-source ownership has to be established first. MyJCB's
credit ledger has the same shape (`unconfirmed` / `confirmed` for one connection
and period) and is the documented next entry in `RECONCILIATION_SLICES`.

Stage C is not run yet: it needs an established owner on both sides and a second
source in the slice.

### Which sources supply a provider link id

Auto-acceptance needs an identifier the provider issued **for the pair**,
surfaced by a parser as `extra_json.$._kogane.providerLinkId`. Surveying the
deployed parsers and `docs/sources/*.md`:

| Source                                                                                                                                        | What it exposes                                                               | Effect                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| SBI Shinsei (`txnReferenceNo`), SMBC Direct, SBI VC Trade (`cashflowId`, `executionId`), PayPay (`transactionNumber`), V Point Pay (event id) | A provider row id                                                             | Identifies one row (stage A). Does not link pending to posted. |
| MyJCB                                                                                                                                         | A third-party column survey mentions an approval number on the debit sections | Not read by the deployed ledger parser.                        |
| Vpass, Sony Bank, MoneyForward, Mobile Suica, Global Pass, SBI Securities histories                                                           | External ids derived from a collector fingerprint                             | Not a provider identifier at all.                              |

So **no source currently supplies a pending-to-posted link id**, and every
proposal this job writes stays `proposed`. The automatic path exists, is
guarded, and is covered by a test with a synthetic source that does report one.

### Acceptance

`services/observation-pipeline/src/reconciliation-commands.ts` exposes
`decideProposal` / `acceptProposal`, guarded exactly like `identity-commands.ts`:
a caller-chosen `operationId` makes a resend idempotent, the actor is the
principal the server verified, and `expectedStatus` is the state the caller saw.
All writes of one command are one D1 batch guarded on the ledger row, so a
failed guard writes nothing. An acceptance appends two decision revisions (one
for the proposal, one for the relation it creates), inserts the
`entity_relations` row, and resolves the proposal. A09 will expose this as an
authenticated command route; there is no public write route today.

Undoing an acceptance is never a DELETE: a later decision appends a new revision
and the old one stays readable.

## Read side

`packages/read-model/src/events.ts` provides `createEventsReader(sql)`:

- `activity({ basis, offset })` — current event revisions with at least one leg
  on the requested basis, their legs, their live allocations, one total per
  (basis, unit), and `explanationRefs` running event → legs → allocations →
  source facts → raw locators.
- `obligations({ offset })` — principal, live settlements, `settled`,
  `outstanding` (`principal − settled`, exact arithmetic), confirmed and
  projected fee totals kept apart, and the unresolved differences the
  settlements declared. When either side is not exact, `outstanding` is `null`
  with an `outstandingReasonCode`; it is never zero-filled (INV05).
- `reconciliationSignals({ subjectRefs })` — the latest published
  provider-reported balance beside the amount the adopted events imply, and
  their `difference` with reason codes (`snapshot_boundary_unknown`,
  `events_incomplete`, `timing_difference`, `fees_not_modelled`). It is a
  `difference` observation, never an adjustment entry, and nothing is written to
  make the two agree (root review 09 §4).

All arithmetic is done in `@kogane/domain` with exact decimals. No sum is
computed by casting a coefficient to a SQLite INTEGER.

### HTTP

`services/evidence-browser/src/events-api.ts` serves, behind the existing Access
gate and the GET-only boundary:

- `GET /api/v2/activity?basis=cash-movement|purchase-recognition&offset=N`
- `GET /api/v2/obligations?offset=N`

Both return the `Page<T>` envelope (`items`, `nextCursor`, `dataCoverage`) plus
`apiVersion: 2`, and activity also echoes the `basis` it was read on. Values are
`Quantity`-shaped (`unitRef` plus a decimal-v1 value state).

The routes are served only when the `eventsV2` capability is true, which needs
**both** `EVENTS_V2_ENABLED=1` and the `economic_event_revisions` table present
in the store the Worker reads. Otherwise the paths 404 like any unknown route
and `/api/meta` reports `eventsV2: false`. `eventsV2` was added to
`ApiCapabilities`; both stored capability constants default it to `false` and
the server replaces it with what it can actually serve.

## Flags

| Flag                     | Where                                | Default | Effect when on                                                        |
| ------------------------ | ------------------------------------ | ------- | --------------------------------------------------------------------- |
| `RECONCILIATION_ENABLED` | `services/observation-pipeline` vars | `"0"`   | The scheduled `reconciliation_sweep` lane runs and writes candidates. |
| `EVENTS_V2_ENABLED`      | `services/evidence-browser` vars     | `"0"`   | `/api/v2/*` is served if the projection exists.                       |

With both off, the scheduled worker logs no new event, writes nothing, and the
browser serves no new route.

## Deploy order and rollback

1. Apply migration `0032_economic_events.sql` (schema; additive, writes no rows).
2. Deploy `services/observation-pipeline` with `RECONCILIATION_ENABLED="0"`;
   turn it on when the candidates should start being produced.
3. Deploy `services/evidence-browser` with `EVENTS_V2_ENABLED="0"`; turn it on
   to expose the read routes.

Rollback: set the flags back to `"0"`. The lane stops and the routes disappear;
the tables stay. A build that predates this change never reads or writes the new
tables, so it rolls back cleanly with the schema in place. Rows are never
deleted to undo a decision — a new revision is appended instead.

## Bounds

One sweep reads at most 1,000 published rows per slice, pairs inside groups of
at most 200 facts (larger groups are counted and skipped), and writes at most
500 proposals. Its log line carries counts only: no amount, account label or
provider text. One API page is 200 rows.

## Verified locally (synthetic data only)

Every fixture publishes its successful parse runs through the projection the way
the writer does, because an unadopted `ok` run is current for no reader since
migration 0026.

- `packages/domain`: `test/events.test.ts` (SC02 net 97,000 and purchase cost
  3,000 with five observations; SC03 1,234 captured, 834 net, unknown-parent
  refund unallocated, over-refund exception, vanished pending inferring nothing;
  SC04 8,000 remaining with fee 100 confirmed against 200 planned; SC05
  cross-unit legs never zero-forced, effective rate 95, explicit fee 5 AUD,
  2,000 JPY reference difference as an estimate, unconfirmed arrival not a
  credited transfer; SC10 10,000 / 300 / 9,700 with payout and bank credit as
  two evidences of one settlement; conservation, fills and state machines) and
  `test/reconcile.test.ts` (stage A/B/C, UC23 candidate-only, ambiguity,
  namespace scoping, the auto-acceptance invariant).
- `packages/read-model`: `test/events.test.ts` (both bases, explanation chain to
  the raw locator, outstanding 8,000 from settlements, non-exact principal left
  unknown, provider-against-derived difference with reasons, a wrong merge
  undone by a new revision with the old revision retained, double allocation
  rejected, append-only triggers).
- `services/observation-pipeline`: `test/reconciliation.test.ts` (the Vpass
  slice, idempotent re-runs, unpublished parses producing nothing, two
  same-amount candidates never merged, acceptance and rejection through the
  decision log with resend and conflicts, the provider-link auto-acceptance path
  on a synthetic source, the scheduled lane off by default, and migration 0032
  on 0017–0035 with seeded rows including its closed enums and append-only
  triggers).
- `services/evidence-browser`: `test/events-api.test.ts` (capability gate, Access
  gate, GET-only, both routes, query validation) plus the pre-existing suites.

Not verified: production data, and the behaviour of concurrent acceptances from
several Workers (the operation ledger and the proposal-resolution trigger are the
arbiter; see the tests).

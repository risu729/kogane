# ADR 0057: Own-transfer proposals under an explicit policy, and planners that stay unregistered behind the production gate

- Status: proposed (accepted when its pull request merges)
- Date: 2026-10-09
- Issue: #549 (own-account transfers), stage G3-a of [ADR 0054](0054-economic-consumption-guard.md#staged-plan)
- Related: [ADR 0053](0053-transaction-family-registry.md) (families),
  [ADR 0054](0054-economic-consumption-guard.md) (claims, seals, commit log, the
  eight identity rules, the G2 command vocabulary, the production gate),
  [ADR 0058](0058-knowledge-selector-and-reconstruction-adapter.md) (the
  selector that reads stored holders), [ADR 0034](0034-card-settlement-automation-prerequisites.md)
  (a rule needs an owner-authorised, versioned policy),
  [ADR 0051](0051-provisional-lot-engine.md) and [ADR 0059](0059-lot-adapter-from-selected-revisions.md)
  (lots; transfers with carried cost are not decided here)
- Carried by: `packages/domain/src/own-transfer-proposals.ts`,
  `packages/storage-d1/migrations/core/0072_own_transfer_proposals.sql`,
  `packages/storage-d1/src/atomic/own-transfer-proposals.ts`,
  `packages/application/src/operations/own-transfer-plan.ts`,
  [economic events](../economic-events.md#own-transfer-proposals-migration-0072)

## Context

ADR 0054's staged plan names G3 as "its own ADR and migration 0072,
own-transfer proposals (proposal-only) and their planners, behind the
production gate". What the code holds before this ADR:

- `bank-movement` is the one family own-transfer pairing reads (ADR 0053); its
  family-level writer status is `unsupported` (`no_event_writer`,
  `writer_guard_pending`), and every bank parser's rows are also
  `counterpart_not_stated`: no provider id links a debit to the credit on the
  other own account.
- The guard (CORE 0070) holds one live holder per (book, key) and per (book,
  alias class); both card writers write claims, seals and commit rows (G1b).
- The G2 vocabulary (CORE 0071) names `economic-event.adopt|correct|withdraw|move`
  with exact payloads; `ECONOMIC_EVENT_PLANNERS` is empty, so the lifecycle
  refuses every command of them (`unsupported_semantics`) at plan, simulate,
  approve and commit, and the processor's writer slot answers null.
- Human-adopted identity is `humanAdoptedRowIdentity` (`row-identity.ts`): an
  SMBC row whose parser records `_kogane.identityOrigin: provider-id` is
  admitted with its alias class; an SBI Shinsei row is refused
  `identity_origin_unrecorded` (rule 2), because its parser records no origin.
- The domain already has a stage C matcher (`stageCProposals`,
  `reconcile.ts`): equal opposite amounts on nearby days across two sources,
  under a built-in `DEFAULT_MATCH_OPTIONS` window, with no identity admission,
  no ownership input, no fee rule and the same-source case skipped.
- ADR 0054's acceptance tests W5 for `move` and W6's re-adoption were deferred
  to G3 because they need an own-transfer writer.
- ADR 0054's production gate is not met: remote D1 conformance (that a trigger
  `RAISE` inside `batch()` rolls the batch back, and the triggers' CPU and
  statement limits) has not been run on an isolated synthetic remote database,
  and the check that `unlogged_economic_revisions` has no row after the log
  start, read together with the deployed build versions, has not been done.

## Options considered

1. **Extend `stageCProposals`.** Rejected as the engine: it carries a default
   window (no policy may have defaults here), skips two accounts of one source
   (two SMBC accounts are the plainest own transfer), admits rows without the
   identity rules and has nowhere to state ownership or a fee rule. Its
   pending/posted callers would change if it did. Its building blocks are
   reused instead: the exact decimal helpers of `values.ts`, the civil-day
   arithmetic of `time.ts`, `humanAdoptedRowIdentity`, the registry lookups
   and `canonicalDigest`.
2. **Store proposals in `reconciliation_proposals`.** Rejected: its kinds are
   a subset of the `entity_relations` kinds (`funded_by` is the nearest),
   its status is resolved by a decision on `proposal:<id>`, and it has no
   column for the pinned policy, engine release, identity epoch, key or
   alias class a planner must re-check. Widening it is a rebuild of a table
   other lanes write.
3. **No table in this slice; plan from the engine's output directly.**
   Rejected: `economic-event.adopt` names a `proposalId`, and "a proposal
   that is not in force" is a refusal ADR 0054 asks the planner to make; that
   needs a stored proposal and its retirement.
4. **A pure engine, an append-only proposal table (0072) and four planners
   that are written and tested but not registered.** Chosen.

## Decision

### The engine (`proposeOwnTransfers`, `own-transfer-proposals.ts`)

Pure and deterministic (the same input in any order gives the same output);
no storage, no clock. Inputs are explicit:

- **Rows**: per row the observation id and parse run, its 5-tuple key, parser
  name, `extra` (for the identity origin and the provider id), the stored
  signed exact decimal amount text, currency and posting day. At most 500 rows
  (`input_bound_exceeded`, never cut).
- **Ownership** (#545): an `AccountOwnershipSource` with a version and
  `ownershipOf(sourceId, sourceAccount)` answering `self` with the account id,
  `other`, or `unresolved`. `unresolved` is `ownership_unresolved` and `other`
  is `owner_not_self`; nothing is guessed.
- **Policy**: `OwnTransferPolicy` with `policyVersion`, `family:
"bank-movement"`, `currencyRule: "same-currency"`, `window: {
minDaysAfterDebit, maxDaysAfterDebit }` (inclusive, within ±31 days) and
  `difference`: `{ rule: "exact" }` or `{ rule: "fee-within", maxByCurrency }`
  (the debit's magnitude may exceed the credit by at most the stated amount of
  the pair's currency; a credit larger than the debit is never a fee). No field
  has a default and the module has no default policy: a missing policy is
  `policy_missing`, anything not exactly this shape (an unversioned one
  included) is `policy_unsupported`. Nothing in the repository supplies a
  policy, so no code path can produce a proposal outside tests.
- **Identity epoch** the rows were read under, and the **held** cash-movement
  keys and alias classes (from the guard's tables).

Per row, in order: shape (`row_invalid`), family (`family_unsupported`
unless the registry files the parser's rows under `bank-movement`), ownership,
identity (`humanAdoptedRowIdentity` with the owner's account: the five codes
of ADR 0054 unchanged), then `amount_not_exact`, `amount_zero`,
`currency_invalid`, `posting_date_missing`. Rule 3: admitted rows of one alias
class that agree on key and values are one fact captured again (the lowest
observation is kept, the others `same_fact_recaptured`); any disagreement
(another key, as from another producer, or another value) refuses all of them
`duplicate_unresolved`. A held alias class is `alias_conflict` and a held key
`economic_claim_held`.

Every debit (negative) is checked against every credit, first failure wins:
`same_account`, `currency_differs` (cross-currency is not supported),
`date_outside_window`, `amount_outside_policy` (exact decimals, INV03). A
pair that passes is a candidate with `both_accounts_self`, `same_currency`,
`date_within_window` and `amount_equal` or `difference_within_policy`. A row
in more than one candidate is never assigned: every candidate it is in is
`needs_review` with `candidate_not_unique` (ties, one debit and two credits,
two debits and one credit). Heuristics only propose (INV07).

A proposal names its rows (observation, parse run, `SourceFactRef`, key,
alias class, account) and never an amount. `proposalId` is `otp_` +
SHA-256 of the engine release, policy version, identity epoch and both alias
classes, so a recapture of the same rows keeps the id; `proposalDigest` covers
everything else. The run's manifest pins the engine release
(`own-transfer-proposals-v1`), policy version and digest, identity epoch, the
alias rule versions of the admitted rows, the registry version, the ownership
version, the arithmetic version and the contract version.

### The table (CORE 0072)

`own_transfer_proposals`: one row per proposal, append-only (`*_no_update`,
`*_no_delete`, `*_no_replace` in 0070's style). Status is
`proposed|needs_review`; `codes_json` is a set of the closed codes; a guard
trigger refuses an unknown or repeated code, a status that disagrees with
`candidate_not_unique`, and a proposal under an identity epoch that is not the
current one (`own_transfer_proposal_invalid`). CHECKs refuse one account, key
or alias class on both sides. Each row pins `policy_version`,
`engine_release`, `identity_epoch` (a foreign key to
`economic_identity_epochs`) and the run's `manifest_json`. No amount, provider
text or merchant is stored.

`own_transfer_proposal_retirements`: once per proposal, append-only, reason
`engine_superseded`, `evidence_changed` or `identity_epoch_changed`. A retired
proposal is never in force again; the same pair under another policy, engine
release or epoch is another proposal id.

Rows are cited without foreign keys to `transaction_observations` or
`parse_runs`, so a later rebuild of those tables need not carry these tables as
children; the planner re-derives each key from the cited row and CORE 0070's
claim trigger does again at commit. The 0072 objects read only their own
tables and `economic_identity_epochs`: they read no command table and add no
row to ADR 0054's "Rebuilding a table 0070 reads". Both tables are classified
`core-keep` (`scripts/core-schema-ledger.ts`).

`ownTransferProposalWrite` and `ownTransferProposalRetirementWrite`
(`packages/storage-d1/src/atomic/own-transfer-proposals.ts`) are the
statement builders. No lane calls them.

### The planners (`own-transfer-plan.ts`)

One `EconomicEventPlanner` per kind (the existing contract of `targets.ts`:
store, kind, payload), in `OWN_TRANSFER_PLANNERS`. They take the plan-time
context the lifecycle already passes; the principal, operation id, receipt and
payload digest reach a writer through the existing `MutationInput` at commit.
No parallel context type is added. They read by key (never the UNION views):
the proposal and its retirement, each cited row (re-deriving its 5-tuple as
0070 does and its alias class through `humanAdoptedRowIdentity`), the live
holders of each key (`economic_claims` and accepted card settlements) and alias
class in book `cash-movement`, the event head with its seal and commit, and
the current identity epoch. A resolved plan pins every event head as
`economic-event:<id>` (0 for an adoption), which the commit's first statement
re-verifies; the simulation carries counts and source ids only.

Refusals, each with the closed code as the second ref
(`OWN_TRANSFER_PLAN_REFUSALS`):

| Kind       | Refused when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every kind | the family is not `bank-movement` (`unsupported_semantics`, `family_unsupported`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `adopt`    | the proposal is missing (`target_missing`, `proposal_missing`), retired (`stale_context`, `proposal_not_in_force`), made under another identity epoch (`stale_context`, `identity_epoch_changed`) or ambiguous (`needs_scope_resolution`, `proposal_needs_review`); its event exists (`proposal_adopted`) or was withdrawn (W6: `withdrawn_readoption`); a cited row moved (`evidence_changed`), fails an identity rule (its code) or computes another alias class (`identity_rekeyed`); a key or class has a live holder (`economic_claim_held`, `alias_conflict`) |
| `withdraw` | the event is missing, not sealed by the own-transfer writer release (`event_not_own_transfer`), sealed but not logged (`knowledge_unlogged`); the named revision is not the live head (`revision_not_head`) or is already withdrawn (W6: `already_withdrawn`); the named decision did not adopt it (`decision_epoch_mismatch`); a released key has another live holder (`economic_claim_conflict_unresolved`)                                                                                                                                                       |
| `correct`  | the head checks above; a withdrawn head (`withdrawn_readoption`); a head sealed under an older identity epoch (`needs_scope_resolution`, `identity_epoch_changed`: routed to review, the holder kept); `releasedClaims` not exactly the dropped claims (`released_claims_mismatch`); a restatement that is not a cash-movement `transfer` (`restatement_unsupported`), a claim no leg cites (`claim_without_leg`), a cited row that moved or fails identity, a new claim held elsewhere; a released key held elsewhere                                              |
| `move`     | the head checks for both members (W5: both heads are pinned, and the writer's batch is one two-member commit); the claim not held by `from` or already by `to` (`move_claim_not_held`); a restatement that changes any other claim (`move_restates_other_claims`); the restatement checks of `correct` for each member                                                                                                                                                                                                                                              |

A withdrawal of a head sealed under an older epoch stays plannable: it
restates nothing, and ADR 0054 makes the reviewed withdrawal the explicit
review.

### Registration stays off, because the production gate is not met

`ECONOMIC_EVENT_PLANNERS` stays empty and the processor's writer slot
(`economicEventMutation`) still answers null. After this ADR every
economic-event plan, simulation, approval and commit is refused in production
exactly as before it. The only reason is ADR 0054's production gate, which
this ADR does not change and does not pass: remote D1 conformance has not been
run and the unlogged-revision check has not been done. It is not a rule about
who may act. When the gate is met, registering the planners and a writer
(G3-b) admits whoever the lifecycle's grants admit then; this ADR neither
widens nor narrows those grants, and adds no check on the kind of principal.
Today the lifecycle lets a principal holding `interpretation.propose` plan and
simulate and requires a human principal holding `interpretation.accept` to
approve and commit; that is the lifecycle's own rule, unchanged here.

In this slice nothing adopts, corrects, withdraws or moves an own transfer:
no rule, no model and no principal can, because no planner is registered and
no writer exists. A proposal is evidence-backed and refusable, and no
proposal changes adopted state (INV07).

### Rollback

Nothing is switched on, so there is nothing to switch off. If a later change
registers the planners, rollback is removing the registration (ADR 0054,
Rollback). 0072 stays; an older build never reads or writes its tables.

## Consequences

- Production behaviour does not change: no lane writes proposals, no planner
  is registered, the writer slot answers null, and no route or screen offers
  the four kinds. CORE gains two empty tables.
- G3-b (the own-transfer writer) has its contract fixed: the event id is
  `own-transfer-<proposalId>` (`ownTransferEventId`), the writer release is
  `own-transfer-v1:economic-guard-v1` (`OWN_TRANSFER_WRITER_RELEASE`), its
  claims are book `cash-movement` with the alias class the planner recomputed,
  and its batch is entered on the receipt (`receiptEntry`) and finalized by
  `economicFinalizationWrites`.
- A proposal lane needs a policy the owner decides; until then the engine
  refuses with `policy_missing`.
- The registry keeps `bank-movement` at `unsupported` (no writer exists);
  proposals are not writers.

### Limits

- The planners check the proposal's account ids only through the alias class
  they recompute; they do not re-read the account mapping or ownership (#545
  supplies no stored ownership read yet). A remapped source account shows as
  `identity_rekeyed` only when the class changes.
- Whether a cited row is still published or current is not checked; the
  planner checks that the row exists under its parse run with the same key.
- A retired proposal id never returns; the same pair under the same policy,
  engine and epoch cannot be proposed again after `evidence_changed`.
- The engine reads one bounded set of rows; which rows a lane would hand it
  (by account, by window) is not built.
- No conservation check runs at plan time on a restatement (the legs' values
  are the cited rows'); the engine's pairing rule is the only amount check.
- Remote D1: the 0072 triggers and the planners' reads are not measured there.

### Open items (restated, not decided)

- **Policy values** (window, fee tolerance per currency) and whether any
  difference rule beyond `exact` is wanted: owner.
- **Families beyond `bank-movement`** (broker and exchange cash, stored value):
  owner.
- **The SBI Shinsei origin route.** Rule 2 is unchanged and SBI-Shinsei-shaped
  rows without a recorded origin are refused here (`identity_origin_unrecorded`).
  The owner reports (2026-10-09), from read-only production aggregates, that
  the parser uses `txnReferenceNo` as it is and that it was stable across
  re-observations in the captured range, and that a parser release recording
  `identityOrigin: provider-id` is being prepared on a separate branch. A parser
  release that records the origin admits the rows; this ADR does not assume it
  is deployed.
- **The `economic-event.resolve-identity` exemption** stays closed (ADR 0054,
  G2 amendment): owner question, unchanged.
- **Enabling the planners and a writer in production**: after ADR 0054's
  production gate, by the owner.
- **Cost carried by a transfer into lots** (ADR 0051, ADR 0059): not decided;
  a cash own transfer moves no lot.
- **Audit context.** The lifecycle's types carry the principal, operation id,
  plan id, payload digest and receipt; they have no place for a channel
  (UI, MCP, API), a correlation id or an idempotency key distinct from the
  operation id. This ADR designs none: the shared audit contract for human and
  delegated operations (another session; ADR numbers 0063 and 0064 are
  reserved for it) will supply them.

## External advice: adopted / adopted with change / deferred

The advice relayed with ADR 0054 (2026-10-08) and the owner's G3-a brief and
update (2026-10-09), compared with the code:

| Advice                                                                                         | Verdict                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same-owner, same-currency cash transfer first; securities transfers separate (ADR 0054 item 9) | Adopted: `bank-movement` only, `same-currency` the only currency rule, ownership an input                                                                                                                            |
| Complex cross-currency, many-to-many, short (ADR 0054: deferred)                               | Still deferred: cross-currency is `currency_differs`; any row in two candidates is `needs_review`; nothing splits a row                                                                                              |
| Pin the policy fully; manifests pin identity, aliases, policy and engine                       | Adopted: per-proposal policy version, engine release and identity epoch; the run manifest adds alias rule, registry, ownership, arithmetic and contract versions                                                     |
| No default policy values; a missing or unversioned policy refuses                              | Adopted: `policy_missing`, `policy_unsupported`                                                                                                                                                                      |
| Unresolved ownership is a refusal, never a guess                                               | Adopted: `ownership_unresolved`, `owner_not_self`                                                                                                                                                                    |
| Ambiguous pairings are never auto-chosen                                                       | Adopted: `needs_review` with `candidate_not_unique`                                                                                                                                                                  |
| Exact decimals; big.js / decimal.js / fast-check                                               | Adopted the domain's exact decimals (INV03); the libraries stay rejected for now; a mutation-style oracle comparison covers the pairing rule instead of a property-testing library                                   |
| Heuristics and AI only propose                                                                 | Adopted (INV07)                                                                                                                                                                                                      |
| "No rule, AI or agent adopts own transfers" as a design rule (ADR 0054 Decision, Authority)    | Adopted with change (owner update, 2026-10-09): nothing adopts in this slice because the gate is not met; no new principal-kind check is added, and the lifecycle's existing grants are neither widened nor narrowed |
| Planners take the existing command context; no parallel context type                           | Adopted; channel, correlation id and idempotency key are left to the shared audit contract (open items)                                                                                                              |
| Generic ledger / event bus                                                                     | Deferred, as in ADR 0054                                                                                                                                                                                             |

## Verification

Synthetic data only; nothing read from production.

- `packages/domain/test/own-transfer-proposals.test.ts` (19 tests): no policy
  and every malformed or unversioned policy refused; the bound, epoch and
  ownership-version refusals; an SMBC-shaped row with `identityOrigin:
provider-id` admitted with its alias class; an SBI-Shinsei-shaped row
  without an origin refused `identity_origin_unrecorded` (and an SMBC row
  without one too); fingerprints, other families, unresolved and foreign
  accounts, missing dates, inexact, zero and currency-less amounts; a held
  alias class (also under another producer's key) `alias_conflict`, a held key
  `economic_claim_held`; rule 3 (two producers' keys for one provider row
  refused, a recapture kept once, a recapture whose value moved refused); the
  codes and pins of a proposal and no amount in the output; `1000` equals
  `1000.00`; a fee difference refused under `exact` and proposed under
  `fee-within`, a difference past the bound and an unlisted currency refused, the
  policy giving another id; a larger credit and a partial amount never a fee;
  cross-currency and same-account refusals; inclusive, directional window
  bounds; ties in both directions `needs_review` and two disjoint pairs
  proposed; permutation determinism and a recapture keeping the id; and a
  mutation-style comparison of 600 perturbations of amount, day and fee bound
  against an independent integer oracle.
- `packages/storage-d1/test/own-transfer-proposals.test.ts` (7 tests): 0072
  leaves every earlier object's `sqlite_master` row unchanged and its objects
  name no table but their own and `economic_identity_epochs`; a proposal
  written once, a replay writing nothing, no amount stored; no update, delete
  or `INSERT OR REPLACE`; closed codes, each once, `needs_review` exactly with
  `candidate_not_unique`; the current epoch only; one account, key or class on
  both sides refused; the builders' contract; retirements once, closed,
  append-only, and only of an existing proposal.
- `packages/application/test/own-transfer-plan.test.ts` (21 tests), on the
  migrated CORE schema with an engine run over stored synthetic rows and a
  synthetic writer standing in for G3-b: nothing registered, and the lifecycle
  refusing an in-force proposal's adoption with nothing written; each kind's
  resolved plan and pinned heads; each refusal code of the table above at
  least once, the
  SBI-Shinsei-shaped row refused by the planner as well; a settlement-shaped
  holder of the same provider row under another producer `alias_conflict` and
  a legacy-shaped key holder `economic_claim_held`; W6 (adopted, then
  withdrawn, never re-adopted, nor corrected back; a withdrawal planned before
  another committed is stale through the pinned head; withdrawing twice
  refused); a stale epoch routing a correction to review while a withdrawal
  stays plannable; a planted double holder refused at withdraw; W5 for `move`
  (the two-member batch fails whole at every statement and on the second
  member's own seal, and commits whole with nothing released and the moved
  claim held once; a third holder of it is refused).
- `packages/storage-d1/test/economic-command-kinds-migration.test.ts` compares
  a store stopped at 0071 (not the newest migration) with one stopped at 0070.
- `services/processor/test/lanes.test.ts`: the migration pin ends at 0072.
- `infra/schema/core-ledger.{json,md}` regenerated; both tables `core-keep`.

Not tested: remote D1; the processor's Miniflare harness (no processor code
changed; every planner scenario runs on bun:sqlite); a writer (none exists).

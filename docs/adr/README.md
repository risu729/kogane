# Architecture decision records

ADRs preserve the context, options, decision and consequences at adoption time.
Their original status/date and wording remain history; they are not current
release instructions. A changed choice needs an amendment or superseding ADR
and an update to the maintained reference. Conditional "accepted upon merge"
status means acceptance follows that record's merge, not that all later
verification/open risks are complete.

Use [current status](../current-status.md), [design](../design.md),
[rollout controls](../rollout.md) and the [documentation index](../README.md)
for current behavior.

- [ADR 0001: Keep A/B/C/D as provenance, add independent domain axes](0001-domain-axes.md)
- [ADR 0002: Recognise card purchases per provider row, one live holder per key](0002-card-purchase-recognition.md)
- [ADR 0003: Relative period labels are evidence; the month is derived afterwards](0003-relative-period-labels.md)
- [ADR 0004: Accept only the payment-type shapes production evidence shows](0004-payment-type-shapes-from-evidence.md)
- [ADR 0005: Decide the MyJCB statement state from the page, not export links](0005-myjcb-statement-state-from-page.md)
- [ADR 0006: Keep the reconciliation lane to provider identifiers and the matching window](0006-reconciliation-lane-scope.md)
- [ADR 0007: Key MyJCB confirmed statements by the payment month the page names](0007-myjcb-statement-identity.md)
- [ADR 0008: Run 28 repair jobs and 40 identity runs a tick, with the D1 call risk documented](0008-repair-lane-throughput.md)
- [ADR 0009: Lane tick records are bounded operational state](0009-lane-tick-records.md)
- [ADR 0010: Bound terminal registration by a per-invocation operation budget](0010-terminal-registration-budget.md)
- [ADR 0011: Resolve settlement ownership through keyed CTEs, keep the 0044 views as the contract](0011-keyed-ownership-ctes.md)
- [ADR 0012: Map Mizuho ordinary deposits under identity policy version 2](0012-mizuho-identity-policy-v2.md)
- [ADR 0013: Give agents card purchases through a separate read-only tool](0013-agent-card-purchase-read.md)
- [ADR 0014: A shared-R2 collector's producer is `collector-<collector id>`](0014-collector-producer-ids.md)
- [ADR 0015: Source authority v2 names CORE source ids](0015-source-authority-v2.md)
- [ADR 0016: Key MyJCB pending statements by payment month, current while their position shows them](0016-myjcb-pending-statement-slots.md)
- [ADR 0017: Add card purchase review command kinds with one rebuild, not relation markers](0017-card-purchase-review-commands.md)
- [ADR 0018: SBI Shinsei as the second bank debit adapter of card settlement review](0018-sbi-shinsei-bank-debit-adapter.md)
- [ADR 0019: Reported state on a date from the latest complete capture before it](0019-dated-reported-state.md)
- [ADR 0020: Prices are provider observations promoted by a closed rule list](0020-price-promotion-by-rule.md)
- [ADR 0021: Collectors state the registration contract; the Processor's refusals stay](0021-collector-registration-contract.md)
- [ADR 0022: Give registered shared-R2 artifacts their parser dataset](0022-registration-artifact-datasets.md)
- [ADR 0023: Do not trust a card binding for collector-vpass runs until the collector writes one](0023-vpass-collector-card-binding.md)
- [ADR 0024: The collection scan does not spend registrations on terminals already judged](0024-collection-scan-judged-terminals.md)
- [ADR 0025: The MyJCB metadata extractor reads both manifest shapes](0025-myjcb-shared-manifest-metadata.md)
- [ADR 0026: A collector's unit coverage is a claim about what the run set out to collect](0026-collector-unit-coverage.md)
- [ADR 0027: The MoneyForward collector derives the account identity the parser requires](0027-moneyforward-collector-account-identity.md)
- [ADR 0028: The SBI Shinsei parsers accept the shapes the stored captures carry, with the unknowns kept as reasons](0028-sbi-shinsei-observed-capture-shapes.md)
- [ADR 0029: Data classification for central storage; Vpass and MoneyForward identities derived without a secret](0029-data-classification-and-unkeyed-identity.md)
- [ADR 0030: A one-time identity-value rewrite from importer-era to collector-era account identities (first decided as a crosswalk)](0030-identity-crosswalk.md)
- [ADR 0031: The owner's SBI Shinsei stage category, as the same run states it, selects the FX board tier](0031-sbi-shinsei-stage-category-fx-tier.md)
- [ADR 0032: The card provider's stated debit account is settlement evidence, proposed and never accepted by rule](0032-provider-stated-debit-accounts.md)
- [ADR 0033: Avoid repeated historical reads in processor maintenance](0033-processor-unchanged-read-cost.md)
- [ADR 0034: Account evidence before automatic card settlement](0034-card-settlement-automation-prerequisites.md)
- [ADR 0035: Bound identity view expansion and skip unchanged reward capture](0035-identity-reward-read-cost.md)
- [ADR 0036: Observe covered D1 costs and failures per Processor lane](0036-lane-cost-observability.md)
- [ADR 0037: Admit reconciliation pages by evidence and reuse clean purchase retirement checks](0037-reconciliation-purchase-cost.md)
- [ADR 0038: Isolate complete hosted verification while sharing preparation](0038-shared-verification-preparation.md)
- [ADR 0039: Alarm scheduling and public maintenance rules](0039-alarm-schedule-management.md)
- [ADR 0040: Deploy compatible Workers through prebuilt cf versions](0040-compatible-cf-version-deployment.md)
- [ADR 0041: Separate maintained documentation from historical records](0041-documentation-scope.md)
- [ADR 0042: PRESTIA bank snapshots and non-additive provider measures](0042-prestia-bank-worker.md) — proposed; production verification pending
- [ADR 0048: Run an accepted collection or session refresh once through the named collector RPC](0048-operation-collector-dispatch.md) — proposed; production dispatch unverified

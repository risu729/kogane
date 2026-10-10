# Plan: publish the integrated MCP execution and maintenance path

- Status: in progress; owner authorized integration, publication, review,
  required CI, merge and deployment on 2026-10-10. The former local-only
  publication gate is superseded by that approval.
- Current integration baseline: main `f6fb5bdd` (recheck before publication).
- Earlier local candidate: tree `46d19ada3b2a05c954f4a9d82c44fed34c7006fb`,
  based on `f761630d` and the frozen S3/R2/jobs integration `dc7be256`.

## Ownership and PR composition

#564 merged the native maintenance writer and CORE 0078. ADR 0046's proposed
status and ADR 0050's open-PR reference are corrected. #643's prewrite release
guard and #652's temporal journal/refusal remain intact.

Draft #638 supplies S3/R1 and shared readers; Draft #641 supplies R2 command
and provider confirmation; the reviewed frozen jobs/origin corrections and
maintenance follow-up build on those slices. One main-based integration PR
supersedes those runtime drafts and documentation Draft #650. Their historical
heads remain inspectable. Collection-quality #639, collector changes, #436
and deployment implementation have separate owners and are not duplicated.

The coordinator controls merge order. The sole deployment owner handles the
resulting release; this implementation does not dispatch or manually deploy.
The source configuration still contains no MCP delegation and adds no grant.
Real-client write activation is a separate decision.

## Implementation and evidence

The candidate reserves an R1 effect audit id and binds R2 confirmation to its
prepared audit id. Current capability and source scope precede receipt lookup.
The native write, applied/accepted-effect budget, native 30/day cap and audit
append share one batch. Exact retries neither write nor reconcile again.
Preparation validates without a domain write and reports the smaller budget.

The maintenance adapter preserves the seven-day direct and 31-day confirmed
envelopes. Newly caused, moved or extended over-bound unions are refused;
pre-existing longer operator windows may remain unchanged or shorten.
Independent review found and verified guards for concurrent different-rule
window changes and same-millisecond losing provenance updates. The source
revision count uses the existing covering index and scales with that source's
append-only history. No migration or second writer is introduced.

Synthetic tests cover signed MCP entry, revocation and scope-before-replay,
prepare/effect linkage, shared budgets, rollback, native idempotency and writer
races. Saved state is distinct from completed/pending alarm reconciliation;
reservation state is read separately. Prior local full App/Web/root suites
and independent focused tests passed. Processor startup timeouts from the
earlier candidate must be diagnosed and verified under the unchanged test
deadlines before publication is presented as ready. No timing failure is
treated as success and local evidence is not hosted or production proof.

## Completion gates

1. Integrate the then-current main without losing concurrent safeguards.
2. Resolve test initialization problems with an evidence-backed minimal
   repair; rerun affected suites, typechecks and static checks.
3. Obtain a fresh independent review of the exact candidate, create a signed
   PR and verify required CI/CodeQL on its actual head. Supersede the old
   drafts explicitly rather than leaving competing integration proposals.
4. Coordinate merge order with the root owner, preserving the repository's
   checks and signing requirements. Hand the exact merged source to the sole
   deployment owner; do not duplicate workflow dispatches or manual deploys.
5. Keep S6 survey acceptance unavailable until the owner decides its adoption
   conditions. No heuristic proposal adopts a rule. No grant/delegation
   expansion, credential/Access/authentication change or financial adoption
   is authorized by this implementation approval.

Production migration application, actual MCP delegated writes and final
deployment success require separate direct evidence. Publishing or merging
this code does not itself prove any of those outcomes.

# Plan: resume MCP maintenance integration after #564

- Status: in progress; implementation remains local and unpublished.
- Date: 2026-10-10.
- Baseline examined: main `f761630da082d879b331402127d898948792daf1`.
- Remote publication scope: this plan and merged-status corrections only.

## Verified baseline and ownership

#564 merged the native maintenance writer, CORE 0078 and maintenance reads.
ADR 0046's proposed status and ADR 0050's open-PR reference are stale.
#643's prewrite release guard is already merged and is retained.
Draft #638 owns S3/R1 and read adapters; stacked Draft #641 owns R2 and
provider confirmation. Draft #639's collection-quality work is separate.
Deployment and #436 have separate owners. This follow-up does not duplicate
their PRs or perform their operations.

The remaining implementation is the maintenance adapter through the single
native writer: R1 within seven days and R2 prepare/confirm within 31 days,
audit linkage, actual delegated budget, and exact replay under current
capability and scope. A local checkout based on the baseline reuses the frozen
S3/R2/jobs integration. Its source is not included in this documentation PR.
The original frozen checkouts remain unchanged.

## Local implementation and verification

The candidate reserves an R1 effect id and binds R2 confirmation to its
prepared audit id. It validates current scope before receipt lookup and
performs the domain write, common applied/accepted-effect audit budget guard, native 30/day
guard and effect append in one batch. Validation-only preparation reports the
smaller remaining budget. Exact retries neither write nor reconcile again.

Independent review identified two writer concurrency gaps: overlapping edits
to different rules could exceed the joined-window bound, and a losing
same-millisecond write could replace provenance. The candidate guards the
source's append-only revision count and requires the preceding INSERT to
have succeeded before its provenance update. The source count uses an existing
covering index and grows with source history. No new migration is introduced.

Synthetic tests cover signed MCP entry and revocation, current scope before
replay, R1/R2 bounds, preparation/effect references, shared budget across
operations, failed-audit rollback, exact retries and both writer races.
The result distinguishes a saved revision from completed/pending alarm
reconciliation; callers read reservation state separately. Synthetic local
evidence is not production or hosted proof. Final test and review evidence
belongs in the implementation handoff before any runtime publication.

## Resume gates

1. Finish local tests, typechecks and an independent review of the exact
   candidate; preserve a patch and its base/tree identities.
2. Obtain the owner's explicit permission before pushing runtime code,
   updating runtime PR branches, creating a runtime PR or merging anything.
   Reuse #638/#641 with their owners rather than opening competing work.
3. Revalidate against the then-current main and the exact PR heads. Do not
   reuse hosted evidence across a changed HEAD or migration set.
4. Keep S6 delegated survey acceptance unavailable until the owner decides
   its acceptance conditions. No heuristic proposal adopts a rule.
5. Treat real-client activation as separate work requiring concrete grants,
   delegation, authentication and rollout decisions. This follow-up changes
   none of them. `MCP_DELEGATIONS` remains empty; the existing financial MCP
   reader receives no schedule authority. Production migration state is
   unverified here.

No production reads, remote experiments, secrets, Access changes, deployment
or merge are part of this follow-up. Publishing this document approves none
of the resume gates.

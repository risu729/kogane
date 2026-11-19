# ADR 0082: An account with no recorded owner is the owner's, recorded per account as an owner-default ownership decision

- Status: accepted
- Date: 2026-11-07
- Issue: part of [#543](https://github.com/risu729/kogane/issues/543) (Phase 2,
  [plan](../plans/2026-11-phase2-card-flow.md#4-owner-decisions-2026-11-07))
- Carried by: `packages/domain/src/ownership-declaration.ts`
  (`OWNER_DEFAULT_PARTY`, the `owner-default-v1` marker),
  `packages/read-model/src/ownership-declaration.ts`
  (`declarationAccountScope`), `packages/application/src/operations/ownership-review.ts`,
  `packages/application/src/query/card-ownership.ts` (`ownerDefaultBlockers`),
  `packages/observation-shared/src/card-ownership-contract.ts`,
  `apps/web/src/pages/Confirm.tsx`, `apps/web/src/card-ownership-display.tsx`
- Related: [ADR 0063](0063-delegated-ai-operation-path.md) (delegated
  operations), [ADR 0084](0084-mcp-operator-authority-without-delegation.md)
  (MCP clients act with the UI's authority), [card settlements: ownership](../card-settlements.md#candidate-and-decision-lifecycle),
  [change lifecycle](../change-lifecycle.md)

## Context

A card settlement is accepted only when the card account's `liable_party` and
the bank account's `beneficial_owner` name the same party through current
accepted decisions. On 2026-11-06 (read-only counts) no account in production
had either relation: every one of the current settlement candidates was blocked by
ownership alone, and no candidate had ever been decided.

The existing ways to record ownership are an explicit evidence review and the
`ownership-declaration:sole-personal-v1` self-declaration. Both need a person
to pick a party name for each account, and the self-declaration refuses a
MyJCB connection root (`card-statement-aggregate`), which is the account every
MyJCB statement resolves to.

The owner decided on 2026-11-07 (03:59 UTC): "所有者は不明なら私と仮定していい"
(an account whose owner is unknown may be assumed to be the owner's). In the
same minutes they chose to delegate settlement decisions to agents through
MCP, and decided that MCP uses the same API as the screens, never the database
directly ([ADR 0081](0081-ui-parity-through-mcp.md)).

## Options considered

1. **A read-time default.** Change `card_settlement_fact_ownership` (and its
   keyed CTE copies) to answer `party:owner` with a synthetic evidence
   reference when no relation exists. No row is written; a migration replaces
   the view; every reader and the commit guard change at once. The default
   would apply to every account silently, with no decision row, no audit
   record and no way to withdraw it for one account except by recording a
   contrary claim.
2. **A recorded decision per account (chosen).** Apply the default through the
   existing ownership review command (`relation.accept`), one account and
   role at a time, under a new closed marker. Each application is a plan,
   an approval and a commit, with its decision row and audit record, and is
   withdrawn by `relation.reject` like any claim. An agent applies it through
   MCP's `kogane.command.*` tools, the same command the page uses.

Option 1 changes adopted state without a decision (INV07) and is invisible
in the history; option 2 needs one plan per account, a few in practice.

## Decision

1. **The marker.** `ownership-declaration:owner-default-v1:<role>:<date>`,
   read by `readOwnershipDeclaration` as scope `owner-default` beside the
   existing `sole-personal`. `<date>` is the day it was applied, not the start
   of ownership. One marker per relation; two markers, another version or
   another scope is `invalid`.
2. **One party.** An owner-default relation must name `party:owner`
   (`OWNER_DEFAULT_PARTY`), so a card account and its debit account defaulted
   separately name the same owner and the settlement's ownership check holds.
   Another party name with this marker is `invalid_command`.
3. **What it may name.** The same refusals as the self-declaration hold:
   any recorded ownership claim on the account in either role (accepted,
   rejected or dated) and any recorded `contradicts` relation touching the
   account or its evidence block it (`ownership_claims_require_review`,
   `contrary_evidence_recorded`); a recorded judgement always wins. The
   account scope differs: a `liable_party` default admits a `card-statement`
   account and a `card-statement-aggregate` connection root (status
   `aggregate`); a `beneficial_owner` default admits a `deposit` account. An
   `unresolved` placeholder or any other role is never admitted
   (`single_account_scope_unconfirmed`). The commit repeats these checks in
   its receipt guard, as for the self-declaration.
4. **Who applies it.** Whoever may plan and approve a `relation.accept`: the
   operator through the command API, or any MCP client through the
   `kogane.command.*` tools, which act with the UI's authority
   ([ADR 0084](0084-mcp-operator-authority-without-delegation.md)). This ADR
   adds no authority of its own. The confirmation page shows and
   approves an owner-default plan; the card-ownership page does not yet offer
   to plan one (it plans only the sole-personal self-declaration). Replaced
   by the [amendment of 2026-11-18](#amendment-2026-11-18-the-card-ownership-page-plans-the-owner-default):
   the page plans it too.
5. **What it is not.** Not provider-name verification, KYC or a statement of
   when ownership began; joint, family-card and third-party liability are not
   inferred and are not excluded by it either: the owner decided that an
   unknown owner is theirs. The page shows it as 所有者の既定 with its date.

The read model answers `ownerDefaultBlockers` beside `selfDeclarationBlockers`
on each side of the ownership review, so the page and an agent
(`kogane.card-settlements.ownership`) can tell before planning whether the
default applies.

## Consequences

- One plan per account and role; after the next settlement sweep each
  statement gets a fresh candidate with `ownership: established-same`, which
  is then accepted or rejected as before. Acceptance is unchanged.
- An account defaulted by mistake is corrected by `relation.reject` and an
  explicit claim, appended; the earlier decision stays in history.
- `party:owner` is a label, not a registry entry; an explicit claim that names
  the owner differently (`party:本人`) would not match a defaulted side, and
  the settlement stays blocked until the two agree.

## Verification

Synthetic tests only:
`packages/domain/test/ownership-declaration.test.ts` (the marker, its scope
and its refusals), `packages/read-model/test/ownership-declaration.test.ts`
(a card root admitted by the default and refused by the self-declaration, a
placeholder refused by both, a recorded claim winning), and
`services/processor/test/ownership-review.test.ts` (both sides defaulted on a
MyJCB root and an SMBC account, the simulation's provenance, another party
refused, an unresolved root refused, the next sweep proposing the match
with `established-same`, and a claim or contradiction arriving inside the
commit refusing an approved default on a MyJCB root atomically). No production decision is made by this change.

## Amendment 2026-11-18: the card-ownership page plans the owner default

- Status: proposed
- Date: 2026-11-18
- Replaces: decision point 4's "the card-ownership page does not yet offer to
  plan one (it plans only the sole-personal self-declaration)"
- Carried by: `apps/web/src/pages/CardOwnership.tsx`

### Context

Point 4 left the owner default to the command API: the confirmation page
shows and approves an owner-default plan, but on `口座の保有者を確認` the
operator could plan only an explicit evidence review or the sole-personal
self-declaration. An MCP client planned the default through
`kogane.command.plan`; the operator, on the screen, had to type a party name
and declare it as their own. That records a different marker, is refused on
a MyJCB connection root (`card-statement-aggregate`), which the default
admits, and leaves the settlement's ownership check unsatisfied when the
other side was defaulted to `party:owner`. The read already answers
`ownerDefaultBlockers` per side.

### Options considered

1. **Keep the command API as the only path.** Rejected: the screen is the
   operator's path, and the owner's decision of 2026-11-07 would stay
   applicable by an agent but not from the screen the decision lifecycle is
   built around.
2. **A separate button per side that plans the default at once.** Rejected:
   it would skip the evidence confirmation and the reason every other basis
   asks for.
3. **A third basis in the existing form's 根拠の種類 (chosen).**

### Decision

The form's 根拠の種類 offers 所有者の既定（記録のない口座は本人のもの）
beside the evidence review and the self-declaration. With it:

- no party name is typed: the plan names `party:owner`
  (`OWNER_DEFAULT_PARTY`), the same party for every account;
- the marker is `ownership-declaration:owner-default-v1:<role>:<date>`, dated
  on the day the plan is made on the owner's calendar (Asia/Tokyo), not on a
  date the operator picks: the date is when the default was applied;
- planning needs the role-specific confirmation checkbox and a reason, as
  every other basis does, and is disabled while the side's
  `ownerDefaultBlockers` is non-empty; the page lists each blocker's reason
  in Japanese (an account scope the default does not admit, a recorded
  claim, a recorded contradiction, or the side's own mapping blocker), and
  the server refuses the same plan with `needs_scope_resolution`, so the
  page is not the only guard;
- it plans only `relation.accept`: the reject button stays disabled, since a
  default is withdrawn by an explicit review (point 3's refusals are
  unchanged).

The page posts the same `relation.accept` payload an MCP client sends to
`kogane.command.plan`; the plan, approval and commit are the existing change
lifecycle, unchanged. The basis defaults to the evidence review, so no owner
is preselected.

### Consequences

- No route, tool, contract, capability, migration or command change: the
  operation is the existing `command.plan` on both paths, so the parity
  mapping is unchanged (the `command.*` entries of
  `services/app/test/ui-mcp-parity.test.ts`).
- Recording the default still accepts no settlement; the next sweep proposes
  a fresh candidate, which is accepted or rejected as before.
- Limit: the date is the plan day, not the commit day. The command reads the
  marker's date only as a valid calendar date and compares it with neither
  day, so a plan made late on one Tokyo day and committed the next is still
  committed, with the plan's date. The page always sends the plan day; an MCP
  client chooses the date it sends, and the server does not check it.

### Verification

`apps/web/test/card-ownership.browser.test.ts`: the default's payload (party,
marker and its Tokyo date, no typed name, the reject button disabled), the
confirmation page's 所有者の既定 notice and its 適用日 wording, each blocker
(and two together) listed with its reason and disabling the default without
disabling an explicit review, and the accessibility audit of the default's
form with a blocker shown.
`services/app/test/card-settlement-decisions-parity.test.ts`: the page's
owner-default payload planned over `/api/command/v1/plan` and over
`kogane.command.plan` gives the same kind, expected revisions and simulation
(with its `owner-default` declaration) on both sides, and writes no decision;
once a claim is recorded, the same payload is refused alike on both paths
(`needs_scope_resolution`) and writes no plan.

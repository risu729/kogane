# ADR 0012: Map Mizuho ordinary deposits under identity policy version 2

- Status: accepted (implementation in flight)
- Date: 2026-09-26
- Implemented by: #254 (open at the time of writing, branch
  `claude/mizuho-identity-mapping-wr8pj4`)
- Carried by (in that PR): `docs/identity-operations.md` ("Policy 2: Mizuho
  rule re-identification"), `packages/identity/src/other.ts`,
  `packages/storage-d1/src/core/identity-policies/mizuho.ts`

## Context

The shared identity resolver had no `mizuho-bank` rule when the Mizuho
collector started (#216, #221), so every sealed policy-1 run mapped Mizuho
accounts as `unresolved` / `unrecognized-source-account`. A new identity run
for one parse needs a new numeric version: 0018 keeps
`UNIQUE(parse_run_id, policy_version)`, and older runs are never replaced.

## Options considered

1. Raise the default policy version for every source. Rejected: every other
   source's rules are unchanged, and it would re-identify the whole store.
2. Rewrite the policy-1 mappings. Rejected: identity runs and mappings are
   append-only, and older workers must not be able to replace a newer sealed
   decision.
3. A per-source policy module that requires version 2 for Mizuho parses only.
   Chosen.

## Decision

- Per-source policy modules (`identity-policies/`, beside `vpass.ts`) set the
  version each source requires. The `mizuho-bank` module requires version 2
  for every Mizuho parse; it needs no evidence, so the family stays
  `identity-default`, the release is `identity-default-v2` and the dependency
  set is empty.
- The rule maps exactly the parser's reference
  `mizuho-bank:ordinary:{3-digit branch}:{7-digit account}` as a
  provider-local `deposit` (`provider-branch-and-account`); every other Mizuho
  shape stays unresolved.
- Re-identification is append-only: the bounded sweep appends a policy-2 run
  and a mapping revision per source account, and the current views select the
  newer sealed run. Policy-1 runs, their rows and the evidence stay as
  recorded, and a manual decision on a Mizuho reference is not replaced.

## Consequences

- The source account and account entity references are unchanged, so
  balances and transactions are not counted twice.
- An account entity first written under policy 1 keeps its `source-account`
  role; the `deposit` label and `provider-local` status live on the policy-2
  mapping revision, which projections read.
- Mizuho still cannot supply canonical bank debits: its history ids are
  fingerprints ([next milestone plan](../plans/2026-09-next-milestone.md)).

## Verification

In the PR, on synthetic data: identity, processor and balance-projection
tests, including that the move from unresolved to provider-local leaves
adoption and overlap outcomes unchanged.

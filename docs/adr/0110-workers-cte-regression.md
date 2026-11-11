# ADR 0110: Keep the coherent Workers stack while the upstream CTE expansion regression is unresolved

- Status: proposed
- Date: 2026-11-11
- Related: [D1 compatibility investigation](https://github.com/risu729/kogane/issues/1294), [Workers dependency update](https://github.com/risu729/kogane/pull/1213)

## Context

The proposed dependency update fails while applying immutable CORE migrations.
At the time of this investigation, the dependency pull request's current head
was [71e7e5b](https://github.com/risu729/kogane/commit/71e7e5b1158c53e663f89ea512031e7841a0e1de),
with Wrangler 4.160.0 and the Vitest plugin 1.7.0; the original issue described
an earlier Wrangler 4.159.0 head.

The failure is not explained by a lower limit on actual view nesting alone.
The upstream [CTE expansion regression](https://github.com/cloudflare/workers-sdk/issues/16786)
describes a cumulative cursor-count check when resolving CTE references.
Our independent local reproduction accepts a flat list of 90, 98 or 99 references
to `WITH q AS (SELECT 1 x)` and rejects 100 and 110 references on the affected
runtime. The flat query has no growing nesting depth. Replacing view boundaries
with CTEs, including `MATERIALIZED` CTEs, does not remove the failing condition.

### Reproduced versions

These are local workerd results, not production D1 version claims. Every chain
uses the unchanged repository migration files, beginning with `0001_initial.sql`.

| Wrangler | Bundled Miniflare | workerd      | CORE chain                                             |
| -------- | ----------------- | ------------ | ------------------------------------------------------ |
| 4.158.0  | 5.20261104.0-beta | 1.20261104.1 | Passes through `0098_sbi_shinsei_savings_activity.sql` |
| 4.159.0  | 5.20261109.0-beta | 1.20261109.1 | Fails at 0045, statement 13                            |
| 4.160.0  | 5.20261110.0-beta | 1.20261110.1 | Fails at 0045, statement 13                            |
| 4.160.1  | 5.20261110.1-beta | 1.20261110.1 | Fails at 0045, statement 13                            |

The exact first failure is in
`packages/storage-d1/migrations/core/0045_expand_card_settlement_commands.sql`:

```sql
ALTER TABLE change_plans_expanded RENAME TO change_plans;
```

It reports `error in view card_settlement_readiness: VIEWs and/or subqueries
nested too deep`. Migration 0044 succeeds, and a direct read of its readiness
view already fails before migrations 0050 and 0052 have run. The rename exposes
the invalidated view during schema validation; those later migrations are not
the original trigger.

A disposable diagnostic rewrite that removes the readiness failure allows the
chain to advance, but statement 8 of
`0062_identity_value_rewrite_staging.sql` (`INSERT INTO identity_value_rewrites`
with the `shared_rows` CTE) then fails independently with the same CTE error. On a separate empty latest-schema
fixture, both current application statements `CARD_SETTLEMENT_REVIEW_SQL` and
`CARD_SETTLEMENT_PAGE_SQL` also fail under Wrangler 4.159.0. Both pass on the
4.158.0 runtime. A migration-only rewrite therefore cannot establish
compatibility of the new stack.

### Production observation

At 2026-11-11 14:51:51 UTC, the read-only Cloudflare D1 query API successfully
executed this against production CORE:

```sql
SELECT 1 AS view_readable FROM card_settlement_readiness LIMIT 1;
```

It returned one row, `changed_db=false`, zero changes and zero rows written.
This was the D1 query API, not the Wrangler CLI. It proves that this view read
worked on that database at that instant. It does not prove that another D1
engine build, the next migration or a new deployment is safe. No financial
values were read into the investigation.

## Options considered

1. Rewrite the readiness view in an additive migration and replay that repair
   early during fresh initialization. This cannot fix the independent 0062 and
   current application-query failures. A normally ordered new migration also
   runs after the first failing historical statement.
2. Rewrite historical migrations and affected application CTEs. This changes
   immutable migration history and creates a broad semantic and performance
   rewrite to work around an upstream regression.
3. Override only workerd beneath newer Wrangler and Vitest packages. This
   creates a runtime combination those packages do not declare, with additional
   protocol and feature compatibility to prove.
4. Retain the currently pinned coherent stack, record a local reproduction and
   exclude only the already observed affected dependency releases while future
   candidates remain eligible for normal CI.

## Decision

Choose option 4. Keep Wrangler 4.158.0 and the Vitest plugin 1.6.0 as currently
pinned. Add no D1 migration, runtime override, migration reordering or relaxed
SQL limit. Existing migration files and application SQL remain unchanged.

The installed manifests pin the whole runtime path with exact versions:
the Vitest plugin 1.6.0 requires Wrangler 4.158.0 and Miniflare
5.20261104.0-beta; Wrangler requires that same Miniflare and workerd
1.20261104.1; Miniflare also requires exactly workerd 1.20261104.1.
These are not semver ranges. Lockfile maintenance cannot select a newer
workerd on this path while those package versions remain pinned.

The Renovate rules exclude only the known affected Wrangler releases 4.159.0,
4.160.0 and 4.160.1 and the coupled Vitest plugin releases 1.6.1, 1.7.0 and
1.8.0. They use the documented
[negated allowedVersions syntax](https://docs.renovatebot.com/configuration-options/#packageRules.allowedVersions).
Future releases remain eligible: this is neither an indefinite upper version
bound nor a disabled dependency group. Normal CI remains the acceptance gate.

## Consequences

The original issue remains open. The requested new-toolchain hosted CI success
and compatibility on later releases are unresolved; this decision does not
claim to satisfy those acceptance criteria. No fixed workerd release was
published when the npm registry was checked on 2026-11-11: latest workerd was
1.20261110.1, also used by Wrangler 4.160.1 and the Vitest plugin 1.8.0.

An upstream release can become a normal candidate immediately. Before claiming
it fixes this issue, run the probe below, all touched workspace checks and the
complete required local and hosted checks on the exact candidate head. Keep the
packages version-coupled. Remove the temporary exclusions once their reason is
obsolete, with evidence in that pull request.

## Verification

`mise run //experiments/d1-conformance:runtime-compatibility` uses the installed
Wrangler package's own Miniflare and workerd. It creates only an ephemeral local
D1 database, reports actual package versions, exercises the flat-reference
boundary, applies the entire unchanged CORE chain, identifies the first failing
migration and one-based statement, and prepares the readiness view and current
settlement reads after a complete migration. An incomplete schema is reported
explicitly and those reads are skipped. No remote binding or credentials are
accepted, and the task downloads nothing.

To compare an already installed isolated candidate without altering the checked
in dependency pins:

```sh
mise run //experiments/d1-conformance:runtime-compatibility -- \
  --toolchain-package /absolute/path/to/candidate/package.json
```

The candidate directory must already contain Wrangler and its declared
runtime dependencies. A successful empty-store probe proves runtime parsing
and migration compatibility, not financial correctness or production readiness;
the existing populated settlement, purchases and Worker tests remain required.

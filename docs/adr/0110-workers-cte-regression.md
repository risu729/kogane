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
| 4.161.0  | 5.20261110.2-beta | 1.20261110.1 | Fails at 0045, statement 13                            |

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
4.160.0, 4.160.1 and 4.161.0 and the coupled Vitest plugin releases 1.6.1,
1.7.0, 1.8.0 and 1.8.1. They use the documented
[negated allowedVersions syntax](https://docs.renovatebot.com/configuration-options/#packageRules.allowedVersions).
Future releases remain eligible: this is neither an indefinite upper version
bound nor a disabled dependency group. Normal CI remains the acceptance gate.

## Consequences

The original issue remains open. The requested new-toolchain hosted CI success
and compatibility on later releases are unresolved; this decision does not
claim to satisfy those acceptance criteria. No fixed workerd release was
published when the npm registry was checked on 2026-11-11: latest workerd was
1.20261110.1, also used by Wrangler 4.160.1 and the Vitest plugin 1.8.0.

A coherent upstream package release can become a normal candidate immediately.
The fixed engine and explicit local probe recorded below do not establish such
a release. Before claiming the upgrade fixes this issue, run the probe, all
touched workspace checks and the complete required local and hosted checks on
the exact candidate head. Keep the packages version-coupled. Remove the
temporary exclusions once their reason is obsolete, with evidence in that pull
request.

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

### Released fix and explicit engine probe, 2026-11-12

[Upstream workerd PR 8347](https://github.com/cloudflare/workerd/pull/8347)
merged the [SQLite CTE backout](https://github.com/cloudflare/workerd/commit/0d01fe9f6850d038d80e6debb54c683a51a9ac65)
at 2026-11-10 22:04:10 UTC. It removes the cursor-count substitution for nesting
depth while retaining the actual nesting check. The
[v1.20261111.1 release notes](https://github.com/cloudflare/workerd/releases/tag/v1.20261111.1)
include the fix; the distributed
[v1.20261112.1 engine](https://github.com/cloudflare/workerd/releases/tag/v1.20261112.1)
retains its [SQLite patch](https://github.com/cloudflare/workerd/blob/v1.20261112.1/patches/sqlite/0006-cte-nesting-depth.patch).

Registry checks at 2026-11-12 01:39–01:41 UTC found Wrangler 4.160.1, the Vitest
plugin 1.8.0 and cf 1.0.0-beta.30 still coupled to Miniflare
5.20261110.1-beta and workerd 1.20261110.1. Miniflare's relevant `beta` tag
remained 5.20261110.1-beta. A fixed engine is now published, but a coherent
released wrapper upgrade and its required hosted CI remain unverified.

An explicit, ephemeral local engine probe ran once at 2026-11-12
02:06:49–02:06:55 UTC, after the separate full local check graph ended. It used
the existing Wrangler 4.160.1/Miniflare 5.20261110.1-beta candidate with
`MINIFLARE_WORKERD_PATH` selecting the official
[@cloudflare/workerd-linux-64 1.20261112.1 tarball](https://registry.npmjs.org/@cloudflare%2fworkerd-linux-64/1.20261112.1).
Its registry SHA-512 integrity was verified before extraction. No package,
lockfile or installed dependency was changed. This selection follows the
[Miniflare release documentation](https://github.com/cloudflare/workers-sdk/blob/wrangler@4.160.1/packages/miniflare/README.md#local-workerd).

The unchanged probe from [the prior implementation head](https://github.com/risu729/kogane/commit/90f73fed33b36d2fe5f81e510d631c031fc80a34)
ran in an isolated validation checkout. All 94 raw CORE migration files from
`0001_initial.sql` through `0102_vpass_authori_transition_policy.sql`, the
migration helper and the keyed-read/readiness SQL sources were byte-identical
to [published source 6232be0a](https://github.com/risu729/kogane/commit/6232be0a0ed6b7a7018a8f6ca052d832019746b2).
All five flat-reference cases (90, 98, 99, 100 and 110), all 94 migration files,
and the readiness, settlement-review and settlement-page reads passed; exit
status was zero with no timeout.

The effective executable reported `workerd 2026-11-12`. Its realpath and
device/inode matched the observed workerd child process. The probe's legacy
`workerd` field still reports the **packaged** version 1.20261110.1; it does not
identify the selected executable. Separate preflight/completion records preserve
that distinction. SHA-256 identities of the retained local evidence are:

| Item                                             | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Effective executable                             | `2fe2593698b848b472575833ecb1432d793c82639910c3e2f499a4d65a4a75c0` |
| Unchanged probe script                           | `d7e2d928491b202a12a8c48aeb38e5a4526e71595e7e70a1c321f2c58392c53f` |
| `explicit-engine-probe-core0102-20261112.jsonl`  | `c14fb530097f2651f4adbda2cc09e55d87b221c7c9914640211e923411b823ab` |
| `effective-runtime-preflight-20261112.json`      | `51e01f925284291a0da2cbf3f429e0ea873e352d8c34a402e7fb5a162c95e393` |
| `explicit-engine-probe-completion-20261112.json` | `4f079a9bfd1c2e2ac4a85cc572f95ea65e8f2a0d4f5b942c6ee0f67495f7483a` |

This establishes local parsing/migration compatibility for that explicit engine
selection and source. It is not a declared wrapper combination, populated-store
financial equivalence, new-stack hosted CI, deployment evidence or a new
production D1 observation. The known-bad exact-version exclusions remain in
place, and the issue remains open.

### Wrangler 4.161.0, 2026-11-13

Wrangler 4.161.0 and the Vitest plugin 1.8.1 (published 2026-11-12) still
require Miniflare 5.20261110.2-beta and workerd 1.20261110.1. The unchanged
`runtime-compatibility` probe, run once locally on 2026-11-13 against an
isolated Wrangler 4.161.0 install, failed the flat 100 and 110 reference cases
and stopped at `0045_expand_card_settlement_commands.sql`, statement 13, with
the same error; the reads were skipped. The pinned 4.158.0 stack passed the
same probe on the same checkout. Both releases are added to the exclusions so
the dependency pull request does not keep proposing a known-failing runtime.

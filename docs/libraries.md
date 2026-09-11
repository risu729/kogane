# Library decisions

Unified plan **U12** (chapter 09, `inventories/library_decisions.csv`).

This is the ledger of which third-party libraries this repository uses, at
which version, under which licence, and — the part a `package.json` cannot
record — **what each one is trusted to do and what it is deliberately not
used for**. A dependency is a standing claim about correctness: whatever it
decides, we have decided. The columns below exist so that claim is written
down once instead of being re-derived from call sites.

Two rules govern changes to this file:

1. **One adoption at a time.** A library arrives in its own PR, with the
   conformance evidence its row names — never alongside a directory move or a
   second library (09 §5).
2. **A version is chosen here, not "latest".** Each row records the exact
   version that was verified, so the pin in the manifest and the reason for it
   are in the same place.

## Adopted

| Library                                | Version            | Licence           | Declared in                                | Used for                                                                                            | Deliberately **not** used for                                                                                                 |
| -------------------------------------- | ------------------ | ----------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `drizzle-orm`                          | 0.45.2 (exact)     | Apache-2.0        | `packages/storage-d1`                      | Single-table reads with filters, ordering and paging, through the first-party D1 driver (U12 pilot) | Guarded batches, seals, publication, decision commits, lease fences, views, CTEs, `json_each`; schema generation or migration |
| `hono`                                 | 4.13.7             | MIT               | `services/app`                             | The `/api/ops/v1` router mounted inside the existing `fetch` (U06)                                  | Replacing the Worker's default export, or justifying a second Worker                                                          |
| `zod`                                  | 4.6.2              | MIT               | `services/app`                             | The runtime contract of `/api/ops/v1` and the MCP tools, as **strict** objects                      | Coercion of any kind — no `z.coerce` for amounts, dates or flags; no unknown-key passthrough                                  |
| `jose`                                 | 6.2.11             | MIT               | `services/app`                             | JWT/JWS verification in `src/auth.ts`                                                               | Hand-rolled crypto anywhere else                                                                                              |
| `parse5`                               | 8.0.1              | MIT               | `packages/parsers`, two services, two PoCs | HTML parsing inside parsers                                                                         | Anything that would enter a parser digest without a release (see G4-14 below)                                                 |
| `jsonc-parser`                         | 3.3.1              | MIT               | `poc/observation-pipeline`                 | Reading configuration that carries comments                                                         | Parsing provider payloads                                                                                                     |
| `react` / `vite`                       | 19.2.8 / 8.2.2     | MIT               | `poc/observation-pipeline`                 | The existing UI and its build                                                                       | A framework migration; the UI is never the second source of a financial figure                                                |
| `@tanstack/react-query`                | 5.102.8            | MIT               | `poc/observation-pipeline`                 | UI data fetching and cache                                                                          | Computing amounts or coverage in the browser                                                                                  |
| `@tanstack/react-table`                | 9.2.3              | MIT               | `poc/observation-pipeline`                 | UI table state                                                                                      | Deciding which rows are publishable                                                                                           |
| `vitest` + `@cloudflare/vitest-plugin` | 4.1.11 / 1.1.3     | MIT               | the Workers workspaces                     | Integration tests on the real Workers runtime with real D1/R2                                       | Standing in for a pure-domain test; vitest is **not** bumped to 5 while the plugin peers `^4.1.0`                             |
| `miniflare`                            | 5.20260831.0-alpha | MIT               | `services/processor` (direct)              | The pipeline test harness                                                                           | Being treated as production evidence of Cloudflare behaviour                                                                  |
| `wrangler`                             | 4.128.0            | MIT OR Apache-2.0 | every Worker workspace, and the root       | Types, dry runs, deploys and **all** D1 migration history                                           | A second migrator; `drizzle-kit push` is not installed and will not be                                                        |
| `typescript`                           | 5.9.3 / 7.0.2      | Apache-2.0        | every workspace (services on 7.0.2)        | Type checking                                                                                       | —                                                                                                                             |
| Bun test                               | bun 1.4.0          | MIT               | the pure packages                          | Pure domain, codec and parser tests                                                                 | Substituting for a runtime test of Workers-specific behaviour                                                                 |
| Playwright                             | 1.62.1             | Apache-2.0        | `poc/observation-pipeline`                 | UI end-to-end tests on synthetic data                                                               | Traces that could carry secrets                                                                                               |

`@hono/zod-validator` is **not** installed: `services/app/src/ops-api.ts`
validates with `z` directly, so there is one fewer package between the wire and
the schema. Add it only if a route needs the middleware form.

## Considered and not adopted

| Library                         | Decision                            | Why                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `drizzle-orm@1.x`               | Not used: RC only                   | The highest 1.x tag is a release candidate. D11 requires a stable release, and Drizzle's own D1 documentation recommending `@rc` is not a reason to ship one                                                                                                                                                                                                                                                                   |
| `drizzle-kit`                   | Not installed                       | `drizzle-orm/d1` compiles and runs without it; kit only generates, pushes, introspects. Two migrators would be two answers to "what is the schema"                                                                                                                                                                                                                                                                             |
| Kysely (+ `kysely-d1`)          | Alternative, not co-installed       | Kysely itself is healthy, but its D1 dialect is third-party, ~17 months without a release, and exposes no `batch`. Drizzle's D1 driver is first-party                                                                                                                                                                                                                                                                          |
| Prisma                          | Not selected                        | The migration cost against this schema's guarded batches and hand-written DDL is the reason, not a claim about D1 support                                                                                                                                                                                                                                                                                                      |
| `@modelcontextprotocol/sdk`     | Deferred (deviates from the ledger) | The plan's ledger says `PREFER_FOR_PROTOCOL`, conditional on fitting the existing transport. Measured: it works on Workers (`webStandardStreamableHttp`, no `node:` imports), but a minimal server bundles to ~396 KB against today's 231-line, zero-dependency adapter with closed schemas. Adopting it is deferred until sessions, resumability or resources are needed; the deviation is recorded here rather than silently |
| `@risu729/tsconfigs`            | Not yet installed                   | `ADOPT_AFTER_TUPLE_CHECK` in the ledger: the shared preset is adopted once its TypeScript 7 peer is checked against the packages still on 5.9.3. Belongs to the tooling work items, not this PR                                                                                                                                                                                                                                |
| Nx / Turborepo / pnpm / Next.js | Out of scope                        | Replacing working infrastructure is not part of tidying it                                                                                                                                                                                                                                                                                                                                                                     |

`dependency-cruiser`, `knip` and `betterleaks` are decided (ADOPT) in
`inventories/library_decisions.csv` and belong to the tooling work items, not
to this PR; they are not installed yet. When they land, their rows move up. The
same holds for `risu729/wrangler-deploy-action` (REUSE_WITH_CONFORMANCE, U14)
and `risu729/renovate-config` (REUSE_WITH_OVERRIDES, U13): both are pinned to a
commit when the workflow that uses them lands.

## G4-14: a dependency change that moves a parser digest is a new release

A parser's identity is not its version string. `parser_releases.code_digest`
(migration 0028) is the digest of the parser module **and every local module it
imports**, and the release id is derived from the whole transform manifest —
code digest, input and output contract versions, metadata extractor release and
the per-source dependency digests (`services/processor/src/releases.ts`).

So the rule is enforced in three places, and none of them can be satisfied by
editing a number:

| Where                                                       | What it refuses                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/parsers/test/parser-digests.test.ts`              | A source change that was not re-digested; the same parser name and version carrying a different code digest (G4-14) |
| Migration 0028, `parser_releases_stable_code_digest`        | The same insert, at the database                                                                                    |
| The golden parser tests (`packages/parsers/test/*.test.ts`) | An upstream change (a `parse5` bump, say) that alters what a parser extracts from a fixture                         |

Two consequences worth stating plainly:

- **Updating a dependency may require a parser version bump.** If the update
  changes a digested source, the digests are regenerated and the parser gets a
  new version — a _new release_, recorded as such. Re-registering the new code
  under the old digest is what the trigger exists to prevent.
- **A dependency that is not a digested source is covered by the golden tests,
  not by the digest.** `parse5` is an npm package, so a bump does not move
  `code_digest`; what would catch a behavioural change is the fixture
  comparison. A dependency update PR therefore runs the parser suite, and a
  changed golden output is a release decision, never a fixture edit.

This PR adds one dependency (`drizzle-orm`, in `packages/storage-d1`) and
touches no parser source, so every recorded digest is unchanged —
`mise run ci:parsers` passes untouched.

## Where the versions live

One `bun.lock` at the repository root resolves everything; `bunfig.toml`
selects Bun's isolated linker, so each workspace sees exactly what it declares.
`infra/dependency-resolution.md` is the generated ledger of how each package
resolved (`mise run ledger:deps`). Renovate groups updates and, per 09 §6,
parser dependencies, amount handling, authorization and `compatibility_date`
changes require the golden and contract tests before a merge.

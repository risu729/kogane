# Unused-code report (advisory)

Unified plan 07 §6 asks for a check on unused candidates. This is it, and it is
**advisory only**: acceptance test **G4-13** says that an unused judgement with no
visible runtime entry point is not a deletion decision, and **G0-12** says that
"nothing imports it" is never on its own a reason to remove a collector. The
tool reports; a human decides against `infra/resources.md`.

```sh
mise run root:knip     # knip --no-exit-code, also part of `mise run ci:root`
```

`--no-exit-code` is deliberate: the task reports and exits 0, so CI never turns
a finding into a red build. The configuration lives in `knip.jsonc` with a
comment on every ignore.

## Why this repository is a hard case for a static analyser

Almost everything that runs here is started by something knip cannot read:

- a Worker's `main` comes from a wrangler config (the plugin reads those,
  including the non-default names — `wrangler.demo.jsonc`, `wrangler.test.jsonc`,
  the importer's thirteen `wrangler.audit-*.jsonc`, and the bootstrap configs);
- a container's entry point comes from a `Dockerfile` `CMD`, which no plugin
  reads at all;
- a cron trigger, a Queue consumer, an Email route and a Durable Object are
  started by the platform, not by an import;
- every development and CI entry point is a mise task (decision D4) rather than
  a package script, and `knip` reads package scripts.

So a name on this page means "no static import reaches it", never "dead".

## Current findings

Generated 2026-09-11 against this commit's tree.

### Unused files (30) — all of them explained

| what                                                                                                                                                                                                                              | why knip cannot see it                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `experiments/cloudflare-runtime-probe/container/server.ts`, `poc/globalpass-worker/container/{server,connect-relay}.mjs`, `poc/sbi-shinsei-worker/container/{server,connect-relay,child-lifecycle,relay-lifecycle.node-test}.mjs` | Container image entry points. Each is named by its `Dockerfile` (`CMD ["node", "server.mjs"]`) and copied into the image. |
| `poc/globalpass-worker/scripts/*.mjs`, `poc/mobile-suica-worker/scripts/*.mjs`, `poc/globalpass-worker/test/connect-relay.node.mjs`                                                                                               | Operator probes and passkey-sync scripts a human runs by hand; the `.node-test.mjs` files run under `node --test`.        |
| `poc/observation-pipeline/src/{demo,serve}.ts`                                                                                                                                                                                    | Local entry points started by their mise tasks.                                                                           |
| `poc/sbi-shinsei-worker/src/local/*`, `poc/sbi-vc-trade-client/src/cli.ts`, `poc/vpass-json/src/{cli,mobile-cli,live-smoke,mobile-auth-probe,fingerprint,mobile-vpass-client}.ts`                                                 | Local diagnostic CLIs. These are the files U04's remaining rows classify; none is deleted here on knip's say-so.          |

### Unused dependencies (5)

| dependency                                                | verdict                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `impit` in `experiments/cloudflare-runtime-probe`         | **False positive.** Imported by `container/server.ts`, which the `Dockerfile` starts.             |
| `ws` in `poc/globalpass-worker`, `poc/sbi-shinsei-worker` | **False positive.** Imported by the container relays and the node-test files.                     |
| `parse5` in `poc/observation-pipeline`                    | Not checked; belongs to that workspace's own U04 row.                                             |
| `@clack/prompts` in `poc/vpass-json`                      | Used by `src/cli.ts`, which is itself only reachable by hand — decide both together, not by tool. |

`wrangler`, `vitest` and `cloudflare` are in `ignoreDependencies`: the first two
are locked binaries called from `tasks.toml` rather than a package script, and
`cloudflare:workers` / `cloudflare:test` are workerd built-ins with no package
behind them.

### One genuine defect

`poc/observation-pipeline/scripts/freeze-coverage-contract.ts:12` imports
`../test/coverage-contract-cases.ts`, which no longer exists there: the contract
cases moved to `packages/parsers/test/coverage-contract-cases.ts` when the
parsers were promoted. The script cannot run today. It is listed under
"Unresolved imports", not under anything about unused code, and fixing it
belongs to that workspace's own work item — this report only records it.

### Unused exports (149) and exported types (118)

Highest first; the long tail is one or two per workspace.

| workspace                         | exports | types |
| --------------------------------- | ------: | ----: |
| `services/observation-pipeline`   |      38 |    16 |
| `services/collector-r2-importer`  |      31 |    29 |
| `services/evidence-browser`       |      19 |    19 |
| `packages/parsers`                |      18 |     2 |
| `poc/observation-pipeline`        |      10 |    18 |
| `packages/application`            |       8 |     3 |
| `poc/vpass-json`                  |       4 |     4 |
| `poc/sbi-shinsei-worker`          |       4 |     2 |
| `poc/vpoint-pay-worker`           |       4 |     0 |
| `poc/vpoint-worker`               |       0 |     4 |
| `poc/smbc-direct-backfill-worker` |       1 |     4 |
| `packages/observation-shared`     |       2 |     7 |
| everything else                   |      10 |    13 |

Most of these are contract vocabularies that exist to be read rather than
imported (`PRINCIPAL_KINDS`, `PLAN_STATUSES`, row and manifest types describing
a stored shape), plus test fixtures exported for a sibling suite. A few are
genuinely exported for no reason and could become module-private. None of that
is urgent, and none of it changes behaviour, so this is a list to work through
during other edits — not a cleanup PR of its own.

### Configuration hints (18)

Knip suggests removing ignores it never needed and refining entry patterns that
match nothing in some workspaces (`scripts/*.ts` where a workspace has no
`scripts/`, `src/index.ts` where a package has no barrel). They are harmless: a
pattern that matches nothing costs nothing, and one shared `packages/*` block is
easier to reason about than a block per package. Revisit them the next time the
config changes.

## When this report may be used to delete something

All four must hold:

1. `infra/resources.md` shows no live Worker, bucket, cron, Queue, Email route
   or Durable Object behind it;
2. no `Dockerfile`, `tasks.toml`, workflow, wrangler config or document names
   the file;
3. the plan's disposition for its directory says retire or delete, and the
   result is recorded under `docs/research/`;
4. a human agreed. Knip's output is evidence in that argument, never the
   argument.

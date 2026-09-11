# Continuous integration

Kogane follows the CI structure used by
[kuebiko](https://github.com/risu729/kuebiko/blob/main/.github/workflows/ci.yml)
and [mikoto](https://github.com/risu729/mikoto/blob/main/.github/workflows/ci.yml):
mise provides pinned tools, hk runs shared lint presets, and one `CI Check`
guard collects the results required for merging.

**mise is the only task runner.** No `package.json` in this repository carries a
`scripts` field, and nothing invokes a package script through `bun run`,
`npm run` or `pnpm run`. Every development, build, test and dry-run entry point
is a mise task, declared in a `tasks.toml` next to the code it runs.

## One Bun workspace

The repository root holds the only `package.json` with `workspaces`
(`apps/*`, `services/*`, `packages/*`, `experiments/*`, `poc/*`) and the only
`bun.lock`. `bunfig.toml` selects Bun's **isolated** linker, so every workspace
gets its own `node_modules` containing exactly the versions it pins: the
services that pin TypeScript 7.0.2 and Wrangler 4.128.0 keep them while the
PoC workers keep 5.9.3 and their own Wrangler versions. Nothing is hoisted, so
each workspace must declare every module it imports directly.

Tasks therefore call `./node_modules/.bin/<binary>` from their `dir` rather than
a bare name: that is the binary the workspace pinned. The root
`node_modules/.bin` (on `PATH` through `[env] _.path` in `mise.toml`) carries
only the root-level tooling, which is also what
`risu729/wrangler-deploy-action` falls back to when a working directory does
not pin Wrangler itself. No task downloads a tool on demand; there is no `npx`
or `bunx` fallback, and a checkout without dependencies fails loudly instead of
installing a different version.

`infra/dependency-resolution.md` records how the single lockfile resolved
compared with the per-package lockfiles it replaced.

## Local commands

```sh
mise trust
mise install          # pinned tools
mise run install      # frozen Bun install for every workspace
mise run check --lint # hk: never edits files
mise run verify       # every workspace's CI checks, then the Worker dry runs
mise run ci:app       # one workspace
mise run hooks:install
```

`mise run check` applies available formatting and lint fixes; `--lint` never
intentionally edits source files. The hk pre-commit hook uses the same checks
on staged files. Tools are pinned in `mise.toml` and resolved for Linux x64 and
Windows x64 in `mise.lock`.

Dependencies are installed by the `bun` deps provider in `mise.toml`
(`bun install --frozen-lockfile`). It is declared `auto = true`, so any
`mise run` installs first when the root manifest, `bun.lock`, `bunfig.toml` or
any workspace manifest changed. `mise deps --explain bun` shows that decision;
`mise deps --force bun` repairs a broken `node_modules` without falling back to
the network for a different version.

The full workspace suite runs on Linux in CI. Shell tests require GNU tools and
Bash; the frontend suite requires a built client and Chromium. Locally,
`CHROMIUM_PATH` selects an installed Chrome executable; in CI the hidden
`web:browser` task installs the workspace's own locked Playwright Chromium.

## Task names

Each workspace owns a `tasks.toml` that the root `mise.toml` lists under
`[task_config] includes`. Task names are `<short>:<verb>`:

| verb        | meaning                                                         |
| ----------- | --------------------------------------------------------------- |
| `types`     | `wrangler types` for a Worker                                   |
| `typecheck` | `tsc --noEmit` (depends on `types`)                             |
| `test`      | the workspace's tests                                           |
| `build`     | a build or bundle check                                         |
| `dry-run`   | `wrangler deploy --dry-run` for every config the workspace owns |
| `dev`       | a local development server                                      |

`<short>` is the workspace's short name: `app` (`services/evidence-browser`),
`processor` (`services/observation-pipeline`), `ingest`
(`services/raw-evidence`), `importer` (`services/collector-r2-importer`), `web`
(`poc/observation-pipeline`), the package name for `packages/*`, and the
directory name for the remaining PoC workers.

Every workspace also declares one aggregate `ci:<short>` task — the exact set
of checks CI runs for it. `ci:root` holds the repository-wide guards that
belong to no workspace. Root tasks: `install`, `check`, `hooks:install`,
`dry-run` (every Worker config), `load-fixture` and `verify`.

Operational entry points — bank logins, credential synchronization, R2 audits,
backfills, production deployments — are deliberately **not** mise tasks. mise is
the entry point for development, build and test. Those scripts are run by path
from the workspace directory (`bash scripts/audit-v-point-r2.sh`,
`bun scripts/live-smoke.ts`), which is also what their documentation shows.

## Adding a workspace

1. Create `<dir>/package.json` (no `scripts`) under one of the root
   `workspaces` globs, declaring every module it imports directly — the
   isolated linker hoists nothing.
2. Run `mise run install` so the root `bun.lock` records it.
3. Add `<dir>/tasks.toml` with `dir = "<dir>"` on every task (task `dir` is
   resolved against the repository root, not the task file), and one aggregate
   `ci:<short>`.
4. List `<dir>/tasks.toml` in `[task_config] includes` of `mise.toml`.
5. If it deploys a Worker, add each of its Wrangler configs to
   `infra/workers-ci.json` and give it a `<short>:dry-run` task listing the same
   configs. A config that serves built assets also names the task that produces
   them in the entry's `prepare` field; without it the job only installs.

Nothing else is needed: the CI matrices are generated from the task list and
the ledger. `tasks/_lib/check-manifests.ts` fails if a workspace directory has
no `ci:` task, if the dry-run tasks and `infra/workers-ci.json` disagree, if a
manifest grows a `scripts` field, or if any tracked file calls a package script.

## Checks and coverage

- Oxlint checks JavaScript and TypeScript correctness and suspicious constructs.
  React uses the automatic JSX runtime. Control-character rejection and
  deliberate redaction of sensitive exception causes remain intact.
- Oxfmt formats source code and documentation. Tombi checks and formats TOML;
  yamllint and yamlfmt cover YAML.
- Actionlint, ShellCheck, ghalint, pinact, and zizmor validate workflow syntax,
  shell code, permissions, action pins, and unsafe workflow patterns.
- Ruff checks and formats Python probes without executing them. Typos and hk
  hygiene checks cover spelling, whitespace, merge markers, and file integrity.
- `ci:root` runs the guards under `tasks/_lib/` and `scripts/`: the manifest
  and task-runner guard, the auto-merge and risk-gate decisions of
  [CI/CD automation](ci-cd.md), the publication-gate predicate allow-list, and
  the import boundaries of
  [package layout](package-layout.md) (no deployed or shared module may import
  `poc/`; the PoC web UI may not import a service internal or read-model SQL).
  It also runs the [infrastructure ledgers](infra-ledgers.md) (a wrangler
  config or a CORE migration that changes without its committed ledger fails
  here) and the two PoC tests that belong to no workspace.
- The workspace matrix runs each `ci:<short>`: type generation, `tsc --noEmit`,
  the tests, and the build steps the workspace needs. The two container
  packages use frozen npm installs without install scripts; the OCI probe
  receives syntax checks only.
- The Worker matrix runs `risu729/wrangler-deploy-action` in `dry-run` mode once
  per Wrangler configuration listed in `infra/workers-ci.json`. Dry-run mode
  passes no Cloudflare account id and no API token, so CI never reaches the
  Cloudflare API.

Evidence under `data/`, parser fixture directories, stored patches, and
generated Worker declarations are excluded from hk. Their exact bytes must
not be changed by a formatter. Provider names and literal upstream fields
have explicit spelling exceptions. TypeScript versions remain workspace-local.

CI does not run collectors, login flows, credential synchronization, historical
backfills, or deployments. It receives no production credentials. Workspace
tests use synthetic inputs and local emulators. The runner disables Wrangler
telemetry; installation still downloads pinned dependencies and tools.

## Jobs and the required merge guard

| job                         | what it does                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Lint`                      | `mise run check --lint`, then `mise run ci:root`                                                                                                                          |
| `Plan`                      | emits the workspace matrix from `mise tasks ls --json` (every name starting with `ci:`) and the Worker matrix from `infra/workers-ci.json`; fails if either list is empty |
| `Workspace (<short>)`       | `mise run "ci:<short>"`                                                                                                                                                   |
| `Worker (<name>)`           | the entry's `prepare` task (frozen `install` by default), then the shared Wrangler action in `dry-run` mode                                                               |
| `CI Check`                  | `if: always()`, fails unless every needed result is exactly `success`                                                                                                     |
| `Generate Actions Timeline` | run summary                                                                                                                                                               |

The workflow runs for every pull request and every push to `main`, including
documentation-only changes. **It has no path filters**: a workflow skipped by a
path filter leaves a required check pending forever instead of reporting a
result.

`CI Check` reads `toJson(needs)` and requires `result == "success"` for `lint`,
`plan`, `workspaces` and `workers`. `failure`, `cancelled` and `skipped` all
fail it, and a matrix that never expanded fails it too, so an unexpectedly
absent job can never be read as a pass.

The existing repository rule continues to require `CI Check`; no bypass or
replacement status is part of this setup.

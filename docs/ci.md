# Continuous integration

Kogane follows the CI structure used by
[kuebiko](https://github.com/risu729/kuebiko/blob/main/.github/workflows/ci.yml)
and [mikoto](https://github.com/risu729/mikoto/blob/main/.github/workflows/ci.yml):
mise provides pinned tools, hk runs shared lint presets, and one `CI Check`
guard collects the results required for merging.

## Local commands

```sh
mise trust
mise install
mise run check --lint
mise run ci:standalone
mise run ci:package poc/observation-pipeline
mise run hooks:install
```

`mise run check` applies available formatting and lint fixes; `--lint` never
intentionally edits source files. The hk pre-commit hook uses the same checks
on staged files. Tools are pinned in `mise.toml` and resolved for Linux x64 and
Windows x64 in `mise.lock`. Package dependencies retain their separate Bun or
npm lockfiles; no root dependency installation rewrites them.

The full package suite runs on Linux in CI. Shell tests require GNU tools and
Bash; the frontend suite requires a built client and Chromium. Locally,
`CHROMIUM_PATH` can select an installed Chrome executable. CI installs the
package's locked Playwright Chromium and fails if browser tests cannot run.

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
- The package matrix runs the reviewed tests, type checks, and deployment dry
  runs for all 19 Bun packages. Standalone diagnostics and CI-coverage tests
  also run. The two container packages use frozen npm installs without install
  scripts; the OCI probe receives syntax checks only.

Evidence under `data/`, parser fixture directories, stored patches, and
generated Worker declarations are excluded from hk. Their exact bytes must
not be changed by a formatter. Provider names and literal upstream fields
have explicit spelling exceptions. TypeScript versions remain package-local.

`scripts/ci-packages.ts` lists the reviewed offline commands. The runner rejects
unknown package paths, changed selected script bodies, and unexpected lifecycle
hooks before execution. Tests compare that list against all tracked package
manifests and the workflow matrix, so new packages cannot silently miss CI.
When intentionally changing a package script, update and review the matching
policy entry as part of the same change.

CI does not run collectors, login flows, credential synchronization, historical
backfills, or deployments. It receives no production credentials. Package
tests use synthetic inputs and local emulators. The runner disables Wrangler
telemetry; installation still downloads pinned dependencies and tools.

## Required merge guard

The workflow runs for every pull request and every push to `main`, including
documentation-only changes. There are no workflow-level path filters that
could leave the required check permanently absent.

The `CI Check` job uses the same failure-only guard as the reference projects:

```yaml
if: ${{ !cancelled() && (contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')) }}
```

It depends on lint, the complete package matrix, and standalone checks. If a
dependency fails or is cancelled while the workflow remains active, the guard
runs and exits unsuccessfully. When all dependencies succeed, the guard is
skipped, which GitHub accepts for the required status check. Cancellation of
the whole run must not be treated as evidence that its tests passed. An Actions
Timeline job summarizes the run after the guard finishes.

The existing repository rule continues to require `CI Check`; no bypass or
replacement status is part of this setup.

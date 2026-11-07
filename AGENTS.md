# Agent instructions

## Language

Use English consistently for repository documentation and other prose, code comments,
commit messages, pull request titles and descriptions, and new issues and issue
comments. Preserve intentional localizations, locale-specific fixtures, quoted
source text, and data whose exact wording is required for correctness. Existing
Japanese issues stay as they are.

Standing rules for any agent working in this repository. Each rule points to
the document that carries the detail; when this file and that document
disagree, the document is right and this file is corrected.

## Continuing the work

- [The roadmap](docs/roadmap.md#work-order) is the work order. A merged PR is not a
  stopping point: continue with the next unit of the current phase until its
  done-when holds, then the next phase.
- Issues track individual items; the roadmap names which issues belong to which
  phase. Update the issue with progress and the roadmap when a phase's scope or
  order changes. Do not keep a second roadmap in an issue.
- A thread that researches something lands its findings in a docs PR, including
  the roadmap lines they change.
- Past decisions, ADRs and earlier owner instructions are not authoritative by
  themselves; judge them on merit against the code and evidence, and propose a
  better design to the owner when one exists.
- While a design is under discussion with the owner, write no ADR, code or PR for
  it until the owner approves. A plan or design proposal gets an independent
  subagent review (facts against the code, security and permission impact)
  before it goes to the owner.

## Decisions live in the repository

- A pull request that decides or changes a design records it in the same PR:
  a new ADR in [`docs/adr/`](docs/adr/), in the format of
  [ADR 0001](docs/adr/0001-domain-axes.md) (status, date, context, options
  considered, decision, consequences, verification; `proposed` until the PR
  merges, then `accepted`), or an amendment to the ADR it changes.
  Smaller owner decisions go into the owning `docs/` page with the date and
  time in UTC.
- Before taking an ADR number, check open PRs for the same number.
- Plans live in [`docs/plans/`](docs/plans/) with a status header, like
  [the next-milestone plan](docs/plans/2026-09-next-milestone.md).
- A decision made in a conversation and not yet in the repository is not a
  decision.

## Checks before pushing

- Run `mise run //<workspace>:ci` for every workspace the change touches and
  `mise run ci:root` ([ci](docs/ci.md#local-commands)). The complete local check
  is `mise exec -- hk check --all --no-fail-fast`; run it when a change touches
  more than one workspace's contracts, the task graph or tooling.
- Run `mise run fix` before committing lint or format changes; `hk check` does not
  rewrite files.
- State in the PR body which commands ran and their result, and say what was not
  run.
- Container image checks need a Docker daemon
  ([ADR 0043](docs/adr/0043-cf-container-deployment.md)): the container
  collectors' `cf-build` tasks (which run `cf-container-release.mjs validate`)
  and the Docker-building `dry-run` tasks, including
  `//experiments/cloudflare-runtime-probe:dry-run`, so also `mise run dry-run`
  and `hk check --all`. Without a daemon, list those as not run locally and rely
  on hosted CI on the PR's exact head.

## CI

- `CI Check` is the required status. It passes only when `Checks` and both
  `Processor` shards succeed ([ci](docs/ci.md#jobs-and-the-required-merge-guard)).
  The ruleset also blocks merges on CodeQL security alerts of high severity or
  above and on CodeQL alerts of error level.
- CI has no path filters, retries or test selection. Do not add any.
- Never skip, disable, quarantine, retry or loosen a test or a deadline to make CI
  pass. Fix the cause, or open a separate PR for the flaky test that explains the
  cause.

## Every PR gets an independent review

A fresh reviewer that did not write the change (a separate agent) verifies
its claims by reading the code and running the tests, and fixes what it finds
before merge. The PR body states what the review checked. Changes pushed after
the review, including conflict resolutions that change behavior, are reviewed
again.

## Merging

Every merge to `main` releases every Worker the release ledger marks `deploy` to production through
[deploy.yml](.github/workflows/deploy.yml) ([CI/CD](docs/ci-cd.md#continuous-deployment)).

Agents act through the owner's GitHub account, which has admin rights and can
bypass the ruleset. Never use that bypass. An agent's PR is one whose branch
starts with `claude/` and whose body links the thread that drove it; every
other PR authored by `risu729` is treated as the owner's.

An agent merges its own PR when all of these hold:

1. One scope: the PR does one independently reviewable thing, with its tests and
   owning docs.
2. The independent review above is done and its findings are fixed or answered in
   the PR.
3. `CI Check` is green on the PR's final head commit, and CodeQL reports no
   blocking alert.
4. The branch contains the latest `main` and `CI Check` ran on that commit. The
   ruleset does not require an up-to-date branch, so this is the agent's check.
5. The owning docs and any ADR are updated in the same PR.

Merge with squash (the only allowed method). Do not use admin bypass or merge
before green.

Merging needs no owner approval in general. Before merging a large or
hard-to-undo change, ask the owner, unless the owner already asked for that
change (owner, 2026-11-06 13:25 UTC). Examples:

- adds or changes a migration (`packages/storage-d1/migrations/`) or a resource in
  `infra/resources.json`; rollback restores no database
  ([CI/CD: rollback](docs/ci-cd.md#rollback-plan-11-7));
- changes a feature flag, grant, `OPERATOR_SUBJECTS`, Access audience, secret
  name or binding in a `wrangler.jsonc`;
- adds an agent or MCP operation or capability in
  `packages/application/src/operation-path/catalogue.ts`;
- changes `.github/workflows/`, the release ledger or the rollback floor;
- adopts or replaces a major library, framework or provider.

Renovate PRs: those with native auto-merge on follow the shared preset and
need no agent. An agent may merge another Renovate PR after green CI and a
check of the changelog, unless it is one of the changes above (for example a
workflow or action update). A Renovate PR whose `renovate/stability-days`
status is still pending is not merged, by an agent or through auto-merge
enabled by an agent, until the owner says so for that PR (owner, 2026-11-06
13:52 UTC).

After a merge, delete the branch if GitHub did not, and close PRs the merge
superseded with a comment linking it. An agent never pushes to, closes or
reopens a PR that is not its own, except to close one its own merged PR
superseded, or a PR the owner assigned to agents in the roadmap. A branch that is the base of an open PR is still in use.

## Pull request text

Write every PR, issue, commit, workflow run and URL in PR and issue text as a
Markdown link, never a bare `#123`, SHA or URL. Use short SHAs. Give times in
UTC.

## Invariants that do not bend

- Evidence is never rewritten: raw objects, fetch history and observations
  are append-only, and corrections are new revisions
  ([design: mutation policy](docs/design.md#mutation-policy)). Only tables
  classified `operational-mutable` (jobs, cursors, lane state) are mutable by
  design ([infra ledgers](docs/infra-ledgers.md#reading-the-classification)).
- Heuristics only propose; nothing changes adopted state until a decision
  accepts it (INV07, [ADR 0001](docs/adr/0001-domain-axes.md);
  [economic events](docs/economic-events.md#what-is-automatic-and-what-is-proposal-only)).
- Heuristics, rule proposal passes and AI proposals only propose (INV07
  above). Besides the human operator in the browser, only the operator's own
  MCP principal applies an operation: `mcp-client:<sub>`, verified by
  Cloudflare Access on the dedicated MCP application, whose `<sub>` the UI
  grades as the operator (`OPERATOR_SUBJECTS`). It acts as itself, never as
  the operator, inside its own `AGENT_API_GRANTS` read scope, under the
  operation's confirmation class (R1 direct, R2 prepare/confirm; R3 refused),
  through the common command layer, and with an audit record. Every other
  agent only reads and proposes
  ([change lifecycle](docs/change-lifecycle.md#grants),
  [agent API](docs/agent-api.md#card-purchase-explanation)). Grants, Access,
  the operator list, secrets and deployment (R4) are never operations
  ([ADR 0063](docs/adr/0063-delegated-ai-operation-path.md),
  [ADR 0064](docs/adr/0064-common-audit-log.md),
  [ADR 0084](docs/adr/0084-mcp-operator-authority-without-delegation.md)).
- Every operation and read the web UI offers is also an MCP operation or read,
  and both call the same application service; an MCP tool issues no SQL and
  reads no R2 on its own. A screen operation without its MCP tool is not done.
  Who may use a tool is the bullet above
  ([ADR 0081](docs/adr/0081-ui-parity-through-mcp.md)).
- Amounts are exact decimals added in `packages/domain` (`sumQuantities` and
  friends refuse mixed units and inexact values, INV03), not summed in SQL
  ([domain contracts](docs/domain-contracts.md)).
- Nothing is counted twice (INV06): one live holder per recognition key
  ([ADR 0002](docs/adr/0002-card-purchase-recognition.md)).
- Missing, unconfirmed or partial values are reasons, never zero (INV05).
- Logs and stored operational records carry counts and closed codes only,
  never provider text or amounts
  ([processor §6.1](docs/processor.md#61-tick-records),
  [observation lanes](docs/observation-lanes.md)).
- Provider semantics nobody has observed and the owner has not confirmed stay
  unsupported, never guessed
  ([ADR 0004](docs/adr/0004-payment-type-shapes-from-evidence.md)).
- Docs state what the code does today, never what it is meant to do; open
  limits are written down as limits ([roadmap](docs/roadmap.md#current-position)).

## Production data

Read production only with read-only aggregate queries (counts, shapes,
timestamps). Never copy an amount, merchant, account label or date into code,
tests, docs or PR text. Tests use synthetic inputs that mirror the observed
shapes ([ci](docs/ci.md); examples in
[economic events](docs/economic-events.md#single-payment-per-source) and
[ADR 0003](docs/adr/0003-relative-period-labels.md)).

Logging in to a provider, running a collector by hand, a hosted Container
experiment, and reading or changing a secret each need the owner's approval for
that action. Never ask the owner for passwords, codes or HAR captures.

## Toolchain

- mise is the task runner ([tooling](docs/tooling.md), [ci](docs/ci.md)):
  `mise run //<workspace>:ci`, `mise run ci:root`, `mise run fix`,
  `mise run ledger:schema`, `mise run //packages/parsers:digests`. Bun is the
  version mise pins.
- Migrations are additive and take the next free number; regenerate the
  schema ledger, classify every new table and update the migration pin in
  `services/processor/test/lanes.test.ts`
  ([infra ledgers](docs/infra-ledgers.md)).
- A query rewrite is proven equal to the shipped text: frozen legacy SQL,
  differential tests on scaled and random stores, and plan checks without
  table statistics ([read model: cost](docs/read-model.md#cost),
  [card settlements: cost](docs/card-settlements.md#cost); #239, #251).

## Where to look first

[README](README.md), [roadmap](docs/roadmap.md), [ADRs](docs/adr/),
[plans](docs/plans/), [observations](docs/observations.md),
[economic events](docs/economic-events.md).

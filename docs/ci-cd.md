# CI/CD automation

How a change reaches `main` without anyone pressing the merge button, and what
stops it when it should. [Continuous integration](ci.md) covers the checks
themselves; this document covers the automation around them.

## Auto-merge and risk gate

Two workflows implement it:

| Workflow                          | Trigger                                      | Token                         | What it does                                                              |
| --------------------------------- | -------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- |
| `.github/workflows/automerge.yml` | `pull_request_target`, `pull_request_review` | GitHub App installation token | Registers native auto-merge (squash) and updates a branch that is behind. |
| `.github/workflows/risk-gate.yml` | `pull_request`                               | `GITHUB_TOKEN` (read-only)    | Publishes the `Risk Gate` status check for high-risk changes.             |

Neither workflow checks out or executes pull request code. `automerge.yml`
checks out the repository default branch, `risk-gate.yml` checks out the base
commit of the pull request, and both then run a reviewed script from
`.github/scripts/`. Pull request titles, bodies, branch names and labels reach
those scripts only as environment values; nothing from a pull request is ever
interpolated into a `run:` block (acceptance G5-08).

Auto-merge never overrides a check. It registers GitHub's own auto-merge, so
the branch ruleset — `CI Check`, code scanning, signed commits, linear history,
squash only — stays in charge. The automation app is not a bypass actor, so a
failed, cancelled or unexpectedly skipped required job blocks the merge exactly
as it blocks a human (G5-01, G5-03).

### Who may auto-merge

`automerge.yml` re-reads the pull request from the API (the event payload can
be stale) and enables auto-merge when all of the following hold:

- the author is the repository owner, or `renovate[bot]` with account type
  `Bot`, or the pull request carries the `automerge-approved` label whose last
  `labeled` event was made by the repository owner;
- the pull request is open, not merged and not a draft;
- `mergeable_state` is not `dirty` (G5-04).

`blocked`, `unstable` and `unknown` are deliberately not treated as failures:
those are the ruleset's decision, and native auto-merge waits for it.

When `mergeable_state` is `behind`, the script calls
`PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` with
`expected_head_sha`, so a branch that moved meanwhile is never updated blindly.
The update is made with the App installation token on purpose: an update pushed
with `GITHUB_TOKEN` would not start a new workflow run, and the pull request
would wait forever for a CI result that never arrives (G5-02, G5-06). For the
same reason the eventual merge commit, pushed by the App, does start the CD
chain on `main` (G5-07).

### What the Risk Gate requires

`infra/risk-paths.json` is the ledger of high-risk changes. It lists path
patterns per rule:

| Rule                          | Covers                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `core-schema`                 | CORE migrations (today `services/raw-evidence/migrations/`, later `packages/storage-d1/migrations/`) |
| `authorization`               | `services/evidence-browser/src/auth.ts` and its successors                                           |
| `secret-consuming-collectors` | collector code that runs with a source's bank credentials                                            |
| `automation`                  | `.github/workflows/**`, `.github/scripts/**`, `.github/actions/**`                                   |
| `deployment-config`           | `wrangler*.jsonc`, `wrangler*.toml`, `infra/**`                                                      |

and label rules: a pull request labelled `high-risk` is treated as high risk
even when no listed path changed. Renovate applies that label to parser, money
and authentication dependencies (`.github/renovate.json5`), which keeps normal
dependency updates on the automatic path while these few need a look.

A high-risk pull request passes `Risk Gate` only when the review list contains
an `APPROVED` review by the repository owner whose `commit_id` equals the
current head commit. An approval of an earlier head never carries over to a new
one, and a later `CHANGES_REQUESTED` or `DISMISSED` review by the owner on the
same head withdraws it (G5-05). Low-risk pull requests pass with no approval.
If the changed-file list cannot be read completely, the gate fails closed.

The check reports the paths and rules that made it high risk. It never prints
the pull request title or body.

**After approving, re-run the failed `Risk Gate` job** (or push again): the
check is produced by a `pull_request` workflow run, and GitHub does not re-run
it when a review is submitted. This is the intended trade-off — the gate runs
with a read-only token and no access to secrets.

## Required GitHub settings

The integrator cannot change any of these. The repository owner must do them
once; until then, everything degrades safely (see below).

1. **Create a GitHub App** owned by the repository owner account, named for
   example `kogane-automation`:
   - repository permissions: `Contents: Read and write`,
     `Pull requests: Read and write`, `Metadata: Read-only`;
   - no webhook, no account permissions, no organization permissions;
   - install it **only** on `risu729/kogane`;
   - do **not** add it to any ruleset bypass list. The whole design depends on
     the app being subject to the same rules as a human.
2. **Repository variable** `KOGANE_AUTOMATION_APP_ID` = the App ID (the number
   on the App's settings page).
3. **Repository secret** `KOGANE_AUTOMATION_APP_PRIVATE_KEY` = the contents of
   a generated private key `.pem` file, including the header and footer lines.
4. **Labels** (Issues → Labels): `automerge-approved` and `high-risk`.
   Renovate also uses `dependencies`, `workers` and `deployed`; Renovate creates
   labels it needs, so only the two above matter for the gate.
5. **Ruleset** (the `main` ruleset, id 21174448): add `Risk Gate` to the
   required status checks, next to `CI Check`, with GitHub Actions as the
   integration. Leave "Require branches to be up to date before merging" off;
   `automerge.yml` updates a branch that is behind, and the strict setting would
   serialize every merge instead.
6. **Repository settings** that must stay as they are: allow auto-merge, squash
   merging only, automatically delete head branches, allow branch updates.

### When it is not configured

- No `KOGANE_AUTOMATION_APP_ID` variable: the first step of `automerge.yml`
  logs `automation app not configured` and the job ends successfully. Nothing
  else in the workflow runs, and no pull request is affected — merging stays
  manual.
- `Risk Gate` not in the ruleset: the check still runs and still reports on
  every pull request, but it does not block merging. Adding it to the ruleset
  is what turns it into a gate.
- A fork pull request: `risk-gate.yml` runs with a read-only token and works
  unchanged. `automerge.yml` runs in the base repository context, so it works
  too — but an external author is only eligible through the
  `automerge-approved` label.

## Acceptance coverage

`scripts/automerge.test.ts` (run by `mise run ci:standalone`) unit-tests the
decision functions in `.github/scripts/automerge-policy.mjs` and
`.github/scripts/risk-paths.mjs` against fixtures. The workflow wiring itself
cannot be proven offline and is verified on the first live pull request.

| Acceptance | Covered by                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| G5-01      | Tests: pending/blocked states are left to the ruleset. Live: a failing `CI Check` keeps auto-merge waiting.   |
| G5-02      | Tests: a `behind` branch stays eligible and requests an update. Live: the update starts CI before the merge.  |
| G5-03      | Tests: owner and `renovate[bot]` eligibility. Live: the app merges without a bypass entry.                    |
| G5-04      | Tests: draft, closed, merged and `dirty` pull requests are refused.                                           |
| G5-05      | Tests: approval matching on `commit_id`, supersession, non-owner reviews. Live: push after approval re-gates. |
| G5-06      | Live only: the App token update starts CI, no human approval loop. Not provable offline.                      |
| G5-07      | Live only (with U14): the merge push starts the CD workflow.                                                  |
| G5-08      | Workflows pass pull request strings through `env` only; zizmor, ghalint and actionlint enforce the shape.     |

## Renovate

`.github/renovate.json5` extends `github>risu729/renovate-config#3.19.0`, which
already pins versions, automerges minor and digest updates, and keeps
`compatibility_date` in `wrangler.jsonc` in step with Miniflare. Kogane adds
only a Cloudflare Workers group (wrangler, Miniflare, `@cloudflare/*`), keeps
the type packages in the shared `typescript` group, and labels the dependencies
whose updates must pass the Risk Gate. Automerged Renovate pull requests take
exactly the same path as any other: `CI Check`, then native auto-merge.

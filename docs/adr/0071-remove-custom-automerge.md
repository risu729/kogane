# ADR 0071: Let Renovate own dependency auto-merge

- Status: proposed (takes effect when this PR merges)
- Date: 2026-10-15
- Related: [CI/CD](../ci-cd.md), [rollout](../rollout.md)

## Context

The custom workflow enables native auto-merge for ready owner-authored and
Renovate pull requests, and owner-labeled external pull requests. It does not
consult Renovate's update classification, `automerge: false`, or a manual hold.
Its GitHub App is not configured, so its mutation steps currently skip.
Renovate already manages dependency auto-merge through the shared preset.

## Options considered

1. Configure a dedicated App and retain the broad author-based merge policy.
2. Add another policy layer that duplicates Renovate's dependency decisions.
3. Remove the custom merge workflow and keep explicit per-PR merge decisions.

## Decision

Choose option 3. Remove the workflow, executable entrypoint, merge implementation
and eligibility policy. Retain shared GitHub API helpers and their pagination
tests because release automation also uses them. Keep Renovate configuration
contracts, including the stable-version fixture fix from #719.

## Consequences

No dedicated merge App, credentials or approval label is required. Renovate
uses its configured native auto-merge policy; other pull requests require a
manual merge or an explicit per-PR native auto-merge choice. Existing GitHub
branch protections and deployment workflows continue to apply.

## Verification

Run the retained configuration and GitHub API tests, configured hk checks,
hosted CI and an independent review. Confirm that release consumers of the
shared API helper and deployment workflow files are preserved.

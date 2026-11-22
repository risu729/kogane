# Dependency and unused-code checks

`hk check` includes Knip through `mise run root:knip`. The task first rejects
unresolved imports and dependencies used without a declaration, then prints the
complete unused-code report in advisory mode. An unused finding alone is not a
deletion decision (acceptance G4-13 and G0-12).

```sh
mise run root:knip
```

The configuration is `knip.jsonc`. Knip 6.44.1 has a native
[mise plugin](https://knip.dev/reference/plugins/mise), so each workspace's
inline `mise.toml` tasks supply script entry points and local tool dependencies.
The old assumption that Knip only understands package scripts no longer applies.
Workspace discovery follows the Bun manifests; the two independently installed
Container packages are also explicit Knip workspaces so their dependencies are
resolved against the correct manifest.

## What needs an explicit entry

Wrangler's plugin reads every `wrangler*.jsonc`, including test configurations.
Platform invocation of a Worker export does not make it dead code. Container
servers, operator scripts, local diagnostic CLIs and tests that do not use the
standard test naming convention remain explicit entry points. `Xvfb` belongs to
the Container image, and the synthetic missing executable belongs to a failure
fixture; neither is an npm dependency. `cloudflare:workers` and
`cloudflare:test` are platform modules.

The root dependency-cruiser binary is launched programmatically by
`tasks/_lib/depcruise.ts`; its narrow dependency ignore records that use. The
root `cf` and `vitest` pins are ignored the same way: no root file imports
them, and they stay so that `node_modules/.bin` exists at the root (#177,
#433); removing them is a tooling decision. `services/collector-sbi-shinsei`
ignores `ws` because its `test` task runs the container's `*.node-test.mjs`
from the workspace directory, independently of the container's own `npm ci`.
`services/collector-vpass` lists `cloudflare.config.ts` and
`wrangler.config.ts` as entries because its own entry list replaces the
`services/*` one.

Files named `test/*legacy*.ts` are frozen shipped text that a rewrite is proven
equal to; `ignoreIssues` keeps their exports out of the report rather than
editing them. An export tagged `@public` in its JSDoc is one a document names
and no module imports (for example the card review subject refs and
invalidations in `packages/domain/src/card-purchase-review.ts`); Knip does not
report it.

## Findings

Checked on 2026-11-22 against `b1066a98e` with the 2026-11-22 cleanup below
applied. The command above is authoritative as the tree changes.

No unresolved imports, undeclared dependencies or unused dependencies are
reported. Knip reports two unused files, the `container/chrome-install.mjs`
copies in GLOBAL PASS and SBI Shinsei: `tasks/_lib/pinned-chrome/` holds the
canonical source, and each Dockerfile copies and runs its copy, which Knip does
not read. It also lists `dpkg-deb`, `fc-match`, `ldd` and `openssl` as unlisted
binaries; `tasks/_lib/pinned-chrome/` runs them inside the Container image, and
none is an npm dependency.

The 2026-11-07 cleanup removed the files nothing imported (the legacy
`storage.ts` of the Money Forward and MyJCB collectors, the retired GLOBAL PASS
`browser-probe.ts`, and V Point's `vpoint-pay-reconcile.ts`), the dependencies
only those used or nothing used (`@cloudflare/puppeteer` in GLOBAL PASS,
`wrangler` in `packages/collection`, `ws` in St.George,
`@types/set-cookie-parser` in V Point), and made module-private or deleted the
unused exports outside files that open pull requests were changing at the
time. The 2026-11-22 cleanup did the same for the unused exports and types that
had accumulated since, again outside files that open pull requests change.

Unused exports and types remain in files open pull requests change, and in
these, kept on purpose:

- `packages/parsers/src/` and the `packages/domain/src/` modules a parser
  imports. Their bytes are code-digested (`src/parsers/digests.ts`), and
  registering a parser name and version with a different digest is refused
  ([release adoption](release-adoption.md)), so even removing an `export`
  keyword needs a parser version bump. `packages/parsers/src/snapshot-query.ts`
  is not digested, but `UNIT_SCOPES` and `UnitScope` there name the closed
  `dataset_snapshot_policies.unit_scope` values, and only `UnitScope` reads
  `UNIT_SCOPES`, so making them module-private would mean deleting them; they
  are kept.
- Exports a document names: `collectInBankPage` in
  `services/collector-sbi-shinsei/src/browser-page.ts` (ADR 0029 and the
  next-milestone plan cite the file as the in-page collection logic),
  `LEASE_TIMING`, `cardPurchaseDecisionId`, `REWARD_READ_PAGE_LIMITS`,
  `DEFAULT_SCAN_CONTINUATION_READS`, `agentApi`, and the
  `legacyWarningCompatMembership` and `coverageV1Membership` snapshot
  policies.
- `useBalanceHistory` in `apps/web/src/api.ts`. No page calls it, but it holds
  the only `/api/v2/balances/history` literal in `apps/web/src`, and an open
  pull request's UI/MCP parity test scans those literals and lists that route
  as one the UI names; it is tagged `@public` until that is settled.
- The Container sources under `services/*/container/`, where any byte change
  releases a new Container image.
- `ACCOUNT_SUMMARY_BYTES`, reported as a duplicate of
  `COLLECTION_QUALITY_SUMMARY_BYTES`: ADR 0123 names both, and the account
  summary's bound is defined as the collection-quality one.

An unused finding alone is still not a deletion decision; the review below
applies to every removal.

## Reviewing a removal

Before removing a reported candidate, check `infra/resources.md`, the relevant
Dockerfile, mise task, workflow, Wrangler configuration and operational docs.
Confirm the directory's disposition and runtime consumers, and review the
specific deletion. Static reachability is evidence for that decision, not a
substitute for it. In particular, a collector cannot be retired solely because
nothing imports its platform entry point.

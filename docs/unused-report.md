# Dependency and unused-code checks

`hk check` includes Knip through `mise run root:knip`. The task first rejects
unresolved imports and dependencies used without a declaration, then prints the
complete unused-code report in advisory mode. An unused finding alone is not a
deletion decision (acceptance G4-13 and G0-12).

```sh
mise run root:knip
```

The configuration is `knip.jsonc`. Knip 6.35.1 has a native
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
`tasks/_lib/depcruise.ts`; its narrow dependency ignore records that use.
There is no repository-wide ignore for Wrangler or Vitest: the mise plugin can
now see their actual workspace invocations.

## Findings after the monorepo migration

Checked on 2026-09-13 against the working tree based on `49d5d65e`. This replaces
the 2026-09-11 report, whose retired `poc/` and importer paths are no longer the
current analysis scope. The command above is authoritative as the tree changes.

No unresolved imports or undeclared package dependencies were found. Remaining
unused-file candidates were:

- `services/collector-moneyforward/src/storage.ts`
- `services/collector-myjcb/src/storage.ts`
- `services/collector-smbc-direct/src/raw-evidence-types.ts`
- `services/collector-vpoint/src/vpoint-pay-raw-evidence.ts`
- `services/collector-vpoint/src/vpoint-pay-reconcile.ts`

The report also flags root `vitest`, `wrangler` in `packages/collection`, and
`ws` in `services/collector-sbi-shinsei` as unused development dependencies.
These are review candidates, not verified removals. Numerous exported functions
and types remain advisory, including domain contracts and public vocabulary;
this tooling change does not remove them or claim that their corresponding
product features are complete.

## Reviewing a removal

Before removing a reported candidate, check `infra/resources.md`, the relevant
Dockerfile, mise task, workflow, Wrangler configuration and operational docs.
Confirm the directory's disposition and runtime consumers, and review the
specific deletion. Static reachability is evidence for that decision, not a
substitute for it. In particular, a collector cannot be retired solely because
nothing imports its platform entry point.

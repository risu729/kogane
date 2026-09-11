# Kogane

A personal finance data platform: collect raw evidence from banks, cards,
brokers, exchanges, and reward programs, and keep it re-processable so that
balances, valuations, P&L, and tax views can be recomputed later under
different rules.

- [Design](docs/design.md)
- [ADR 0001: provenance classification plus domain axes](docs/adr/0001-domain-axes.md)
- [Domain contracts (`packages/domain`)](docs/domain-contracts.md)
- [Package layout and import boundaries](docs/package-layout.md)
- [Evidence collection](docs/collection.md)
- [Raw evidence store](docs/raw-store.md)
- [Collection contract (`packages/collection`)](docs/collection-contract.md)
- [Evidence ingest contract](docs/evidence-contract.md)
- [Observation layer](docs/observations.md)
- [Parser coverage contract](docs/parser-coverage.md)
- [Observation job lanes and scheduled stages](docs/observation-lanes.md)
- [Publication gate: adopted parse results](docs/publication-gate.md)
- [Release adoption, candidate results and rollback](docs/release-adoption.md)
- [Decision log, identity commands and read modes](docs/decision-log.md)
- [Change lifecycle: plan, simulate, approve, commit](docs/change-lifecycle.md)
- [Balance read model](docs/balance-read-model.md)
- [Economic events, allocations and reconciliation](docs/economic-events.md)
- [Points, miles and prepaid balances](docs/rewards.md)
- [Prices, calculation policies and report artifacts](docs/calculation-and-reports.md)
- [Read model (`packages/read-model`)](docs/read-model.md)
- [Evidence browser](docs/evidence-browser.md)
- [Agent API and the shared query service](docs/agent-api.md)
- [Frontend stack and API handoff](docs/frontend.md)
- [Development checks and CI](docs/ci.md)
- [Infrastructure ledgers: resources, CORE schema, dependencies, retention](docs/infra-ledgers.md)
- [Operations: health signals, load, retention and drills](docs/operations.md)
- [Authenticated collectors](docs/authenticated-collectors.md)
- [Credential delivery](docs/credentials.md)
- [Existing tools and reuse](docs/tooling.md)
- [Prior art: self-hosted finance software](docs/prior-art.md)
- [Vpass aggregator alternatives](docs/vpass-aggregators.md)
- [Vpass Android app API](docs/vpass-android-api.md)
- [Account and source inventory](docs/account-inventory.md)
- [Direct source policy](docs/source-policy.md)
- [Source research board](docs/source-research.md)
- [Per-source research records](docs/sources/README.md)
- [Roadmap](docs/roadmap.md)

## Getting started

One Bun workspace, one lockfile, and mise as the only task runner. There are no
`package.json` scripts; every entry point is a mise task.

```sh
mise trust
mise install              # pinned tools (bun, node, hk, oxlint, ...)
mise run install          # frozen Bun install for every workspace
mise run check --lint     # hk: lint and format check, never edits files
mise run ci:app           # one workspace's CI checks
mise run verify           # every workspace, then the Worker deployment dry runs
mise tasks ls             # what else is there
```

See [Development checks and CI](docs/ci.md) for the task naming convention, how
the CI matrices are generated, and what to do when adding a workspace.

## Proofs of concept

- [Observation pipeline (ingest, parsers, evidence browser)](poc/observation-pipeline/README.md)
- [Browserless Vpass JSON collector](poc/vpass-json/README.md)
- [SBI新生銀行 fail-closed Worker collector skeleton](poc/sbi-shinsei-worker/README.md)
- [OCI/WSL Vpass browser comparison](poc/oci-browser-probe/README.md)
- [Per-scraper tamia TCP bridge probe](poc/tamia-tcp-bridge/README.md)
- [Mobile Suica JRE ID passkey collector](poc/mobile-suica-worker/README.md)

## Open experiments

Each one carries an `EXPERIMENT.md` with its owner, expiry and stop condition.
Deployed code never imports them.

- [Cloudflare Container runtime and egress probe](experiments/cloudflare-runtime-probe/EXPERIMENT.md)
- [Cloudflare Browser Run probe](experiments/cloudflare-browser-run/EXPERIMENT.md)

## Finished experiments

Their code is no longer on `main`; the result, the commit that carried it and
how to read it back are in [`docs/research/`](docs/research/).

- [Camoufox Windows/macOS fingerprint controls](docs/research/camoufox.md)
- [Kameleo Windows Chrome container control](docs/research/kameleo.md)

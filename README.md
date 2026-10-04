# Kogane

A personal finance data platform: collect raw evidence from banks, cards,
brokers, exchanges, and reward programs, and keep it re-processable so that
balances, valuations, P&L, and tax views can be recomputed later under
different rules.

- [Documentation index](docs/README.md)
- [Current implementation and limits](docs/current-status.md)
- [Roadmap](docs/roadmap.md)
- [Design](docs/design.md)
- [Architecture decision records](docs/adr/README.md)
- [Agent instructions](AGENTS.md)

## Product status and next milestone

The infrastructure migration and legacy resource retirement are complete.
Financial product development continues: existing schemas, READ projections and
pure calculation functions do not yet provide complete transaction matching,
portfolio valuation, cost basis, P&L or tax reporting.

The first [card settlement review](docs/card-settlements.md) connects authoritative
**Vpass/MyJCB statement totals to SMBC and SBI Shinsei bank debits**. Operators can review,
accept, reject and withdraw a correspondence while preserving evidence and
history. Unknown ownership or stale evidence blocks acceptance; payment allocation
adds no duplicate cash movement or purchase expense. Source coverage, additional
bank adapters, partial payments and refund allocation remain incomplete.

[Card purchase recognition](docs/economic-events.md#card-purchase-recognition)
is the first purchase-event writer: on in production since 2026-09-24
(`PURCHASE_RECOGNITION_ENABLED`), it turns adopted Vpass/MyJCB single-payment
usage rows into purchase and refund events, each with a recorded rule decision.
When a later re-parse re-keys a row, its event is retired and the new key is
recognised as a new event, so the purchase is not counted twice. Installment,
revolving and bonus rows are never recognised, and a pending row becomes one
purchase with its posted row only through a reviewed link (or a provider link
id, which no deployed source supplies yet).

The [roadmap](docs/roadmap.md) records the current implementation limits,
development order and acceptance criteria. Its main sequence is identity and
data coverage → reconciliation/events → dated holdings and liabilities →
price/FX valuation → lots/P&L → tax. Rewards progress in parallel, while UI and
AI/MCP flows are delivered with each feature.

The operator-only **カード利用** page
([purchase explanation](docs/card-settlements.md#purchase-explanation-chain))
traces each recognised card purchase to its provider statement and, where a
settlement was accepted, to the bank debit. Captured, pending, refund and
unresolved figures stay apart, a statement total is shown beside them but never
compared with them, and a settlement adds no purchase expense. An empty list is
not proof that there were no purchases.

[Schedule administration](docs/schedules.md) connects alarm settings, public
maintenance revisions and execution history. Maintenance can be edited through
the operator HTTP API; research is not automatically refreshed. MCP code exists,
but agent grants are empty and maintenance has no MCP tool.

## Getting started

One Bun workspace, one lockfile, and mise as the only task runner. There are no
`package.json` scripts; every entry point is a mise task.

```sh
mise trust
mise install              # pinned tools (bun, node, hk, oxlint, ...)
mise run install          # frozen Bun install for every workspace
hk check --all           # lint, types, tests, Knip, builds and Worker dry runs
mise run //services/app:ci # one workspace's checks
mise run fix              # explicitly apply lint/format fixes
mise tasks ls --all        # discover the monorepo tasks
```

See [Development checks and CI](docs/ci.md) for the task naming convention, how
CI uses the same `hk check` entry point, and what to do when adding a workspace.

## Collectors

One deployed Worker per source, under `services/collector-<source>`. The runtime
each of them needs, and why, is in the
[collector runtime inventory](docs/collector-runtime-profiles.md).

- [SMCC Vpass](services/collector-vpass/README.md)
- [SBI証券](services/collector-sbi-securities/README.md)
- [SBI新生銀行](services/collector-sbi-shinsei/README.md)
- [SBI VC TRADE](services/collector-sbi-vc-trade/README.md)
  (and its [local read-only client](packages/sbi-vc-trade-client/README.md))
- [Sony銀行](services/collector-sony-bank/README.md)
- [みずほ銀行](services/collector-mizuho/README.md)
- [St.George](services/collector-st-george/README.md)
- [三井住友銀行 SMBCダイレクト](services/collector-smbc-direct/README.md)
- [PRESTIA GLOBAL PASS](services/collector-globalpass/README.md)
- [MyJCB](services/collector-myjcb/README.md)
- [Mobile Suica](services/collector-mobile-suica/README.md)
- [Money Forward](services/collector-moneyforward/README.md)
- [Vポイント](services/collector-vpoint/README.md)
- [V Point Pay](services/collector-vpoint-pay/README.md)

## Open experiments

Each one carries an `EXPERIMENT.md` with its owner, expiry and stop condition.
Deployed code never imports them.

- [Cloudflare Container runtime and egress probe](experiments/cloudflare-runtime-probe/EXPERIMENT.md)
- [Cloudflare Browser Run probe](experiments/cloudflare-browser-run/EXPERIMENT.md)
- [TAMIA raw TCP bridge](experiments/tamia-tcp-bridge/EXPERIMENT.md)

## Finished experiments

Their code is no longer on `main`; the result, the commit that carried it and
how to read it back are in [`docs/research/`](docs/research/).

- [SBI証券 Bitwarden CLI passkey overlay](docs/research/sbi-securities.md)
- [OCI/WSL Vpass browser comparison](docs/research/oci-browser.md)
- [Camoufox Windows/macOS fingerprint controls](docs/research/camoufox.md)
- [Kameleo Windows Chrome container control](docs/research/kameleo.md)

# Kogane

A personal finance data platform: collect raw evidence from banks, cards,
brokers, exchanges, and reward programs, and keep it re-processable so that
balances, valuations, P&L, and tax views can be recomputed later under
different rules.

- [Design](docs/design.md)
- [Evidence collection](docs/collection.md)
- [Raw evidence store](docs/raw-store.md)
- [Observation layer](docs/observations.md)
- [Evidence browser](docs/evidence-browser.md)
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

## Proofs of concept

- [Observation pipeline (ingest, parsers, evidence browser)](poc/observation-pipeline/README.md)
- [Browserless Vpass JSON collector](poc/vpass-json/README.md)
- [OCI/WSL Vpass browser comparison](poc/oci-browser-probe/README.md)
- [Camoufox Windows/macOS fingerprint controls](poc/camoufox-container-probe/README.md)
- [Kameleo Windows Chrome container control](poc/kameleo-container-probe/README.md)
- [Cloudflare Container runtime probe](poc/cloudflare-runtime-probe/README.md)
- [Cloudflare Browser Rendering probe](poc/cloudflare-browser-run/README.md)
- [Per-scraper tamia TCP bridge probe](poc/tamia-tcp-bridge/README.md)
- [Mobile Suica JRE ID passkey collector](poc/mobile-suica-worker/README.md)

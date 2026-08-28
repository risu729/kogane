# Observation pipeline PoC

Everything that happens **after** collection: an already-collected raw
artifact is ingested, parsed into typed observations by deterministic
versioned parsers, and browsed read-only with full provenance.

This PoC deliberately contains **no collector**. Authentication, anti-bot
handling, and session management are the subject of `poc/vpass-json` and
`poc/sbi-securities-worker`, which already write raw evidence to R2 daily.
The question here is the one nothing in the repository had yet answered:
once the bytes exist, what turns them into observations without ever
becoming a finished ledger?

It exercises phases 2 and 3 of `docs/roadmap.md` end to end, against the
payload shapes the live collectors actually emit. See `docs/raw-store.md`,
`docs/observations.md`, and `docs/evidence-browser.md` for the plans this
implements, and `RESULTS.md` for what it settled and what it did not.

## Running it

```sh
bun install
bun run demo          # ingest the fixtures, parse them, print row counts
bun run ui            # read-only evidence browser on http://localhost:8787/
bun test              # 58 tests
bun run typecheck
```

`bun run demo` is idempotent. Running it twice ingests nothing new and
parses nothing new, because runs are keyed by their external run id, blobs
by their SHA-256, and parse runs by (artifact, parser, version).

State lives in `state/` (gitignored): `kogane-poc.sqlite` stands in for D1,
and `state/blobs/` stands in for R2. Deleting the directory and re-running
is always safe — that is the point of the architecture.

## What it does

```text
collector run directory (or a single file export)
      │  ingest.ts — content-addressed, hash-verified, idempotent
      ▼
raw_objects + fetch_artifacts + fetch_runs         layer A: evidence
      │  parse.ts — deterministic, versioned, supersession-aware
      ▼
transaction / balance / position / valuation observations   layer B
      │  ui.ts — read-only, computed per request, stores nothing
      ▼
evidence browser
```

Four parsers run against the shapes the collectors already produce:

| Parser | Artifact | Emits |
| --- | --- | --- |
| `sbi-domestic-trade-records` | SBI `domestic-trade-records` | transactions |
| `sbi-foreign-cash-positions` | SBI `foreign-cash-positions` | positions, provider valuations |
| `sbi-foreign-cash-balances` | SBI `foreign-cash-balances` | balances |
| `paypay-csv` | PayPay consumer CSV export | transactions |

The demo ingests 4 artifacts from 2 sources and produces 28 observations:
8 transaction, 10 balance, 2 position, 8 valuation.

## The parser contract

A parser is a deterministic, side-effect-free function from bytes to
observations. It does not fetch, does not read the clock, and does not use
randomness, so re-parsing the same artifact always yields the same result.
Beyond that it must:

- carry a name and a version, and select the artifacts it accepts from
  metadata alone;
- record a raw locator on every observation (`json:$.records[3]`,
  `csv:row=12`) so the value can be found again in the same bytes;
- never drop a provider field it does not model — unrecognized material is
  carried in `extra`, by name;
- warn rather than discard. A row it cannot fully parse is still recorded,
  with a warning explaining what could not be read.

Re-parsing is first class. Running the same parser version again is a
no-op; a bumped version re-parses and marks the earlier parse run
superseded. No observation row is ever updated or deleted, so "current"
is a query — observations whose parse run nothing has superseded — rather
than a stored state.

## The evidence browser

Strictly read-only, and closer to a debugger than to a dashboard. It exists
so that a human can see, for any observation, the exact bytes it came from
and the parser version that produced it; re-parsing is only trustworthy if
someone can check what changed.

```text
/                              row counts, sources, fetch runs, parse runs
/transactions                  current transaction observations
/balances                      latest per (account, metric, instrument), then full history
/positions                     current positions with provider-reported valuations
/observations/:kind/:id        every column, extra_json, and the provenance walk
/artifacts                     every artifact and its observation counts
/artifacts/:id                 all parse runs including superseded ones
/raw/:sha256                   the stored bytes, verbatim
```

Every current-state view is computed per request and stored nowhere. The
provenance walk is the point of the tool: observation → parse run
(parser@version, warnings) → artifact → raw object → fetch run.

## Fixtures

`fixtures/` holds synthetic payloads shaped like the real collector output,
including a run `manifest.json` whose SHA-256 hashes match the bytes beside
it. They are not captured data: **no real balances, transactions, account
identifiers, or credentials are committed**, in line with
`docs/account-inventory.md`. Their field names and structure come from the
collectors' own source and from `docs/sources/`, so the parsers are written
against real shapes rather than invented ones.

This is also their limitation, and the reason `RESULTS.md` lists the
questions only real payloads can close.

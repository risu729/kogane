# Design

Kogane is a personal finance data platform. It collects information from
banks, card issuers, brokers, crypto exchanges, and reward programs, and
preserves it in a form that allows balances, valuations, profit and loss, and
tax figures to be recomputed later under different rules.

It is not a budgeting app. The UI and the AI/MCP interface are thin layers on
top of the data platform.

## Top Design Principle

> Do not build a system that stores current balances, valuations, and P&L.
> Build a system that stores enough evidence and events to reconstruct them
> later under different rules.

Financial data models are almost always wrong on the first attempt: providers
change amounts after the fact, external IDs are unstable, FX and fees are
ambiguous, and tax rules differ per jurisdiction and change over time. Instead
of trying to design the correct model up front, Kogane optimizes for the
ability to re-derive everything from raw evidence when the model turns out to
be wrong.

## Requirements That Drive the Design

- Many accounts and cards across multiple institutions.
- Multiple jurisdictions and currencies (initially Japan and Australia, JPY
  and AUD), including income tracking for tax purposes in both.
- Assets beyond fiat money: securities, crypto, reward points, and airline
  miles.
- Serverless hosting on Cloudflare.
- AI (via MCP) reads and writes through a controlled interface; AI mistakes
  must never destroy source data.

## Four Kinds of Information

All data in the system belongs to one of four layers. The boundaries between
them are the most important part of the design.

```text
A. Evidence
   What the source material literally contained.
   Raw JSON / HTML / CSV / PDF stored in R2, content-addressed.

B. Observation
   What a parser read out of the evidence.
   "The card site says: pending purchase, 10,000 JPY."
   Typed records produced by deterministic parsers.

C. Interpretation
   What we decided it means.
   "Pending observation A and posted observation B are the same
   purchase." "This transaction is a transfer." Identity mappings,
   observation links, classification. Rules, heuristics, and AI are
   allowed here.

D. Derived analysis
   What a versioned calculation produced.
   Positions, lots, valuations, net worth, P&L, tax views, expiry
   forecasts.
```

Layer transitions have different rules:

- A → B is as deterministic as possible. Parsers record their name and
  version on every observation so that re-parsing older evidence with a newer
  parser is a first-class operation.
- B → C may use rules, heuristics, or AI. Every interpretation records its
  origin (`provider` / `exact` / `heuristic` / `ai` / `manual`), method, and
  confidence, and is correctable.
- C → D is a versioned calculation engine. Results carry a
  `calculation_version` and are disposable caches.

### Mutation Policy

| Class | Examples | Policy |
| --- | --- | --- |
| Immutable | raw objects, fetch history, source observations, historical price observations | Append-only. Never updated or deleted. |
| Versioned / corrigible | identity mappings, observation links, event interpretation, classification | May be corrected; corrections are tracked. |
| Derived / disposable | current balances, positions, P&L, net worth, tax calculations, dashboards | Freely regenerated from the layers above. |

Evidence is not "the truth" — providers correct their own data. Evidence is a
record of *what a source claimed at a point in time*. That is why nothing
overwrites it, and why multiple conflicting claims can coexist.

## Architecture

```text
                 External Sources
      banks / cards / brokers / exchanges /
      reward programs / market data / email
                       │
                       ▼
             ┌──────────────────┐
             │   RAW EVIDENCE   │  R2 (content-addressed blobs)
             │ JSON HTML CSV PDF│  D1 (fetch runs, artifacts, hashes)
             └────────┬─────────┘
                      │  deterministic, versioned parsers
                      ▼
             ┌──────────────────┐
             │   OBSERVATIONS   │  "source X says Y"
             └────────┬─────────┘
                      │  identity / reconciliation / classification
                      ▼
      ┌───────────────┴────────────────┐
      │                                │
      ▼                                ▼
ECONOMIC EVENTS                 STATE SNAPSHOTS
"something happened"            "something was true at time T"
buy / sell / transfer /         balance / position / market value /
fee / dividend / interest /     reported P&L / credit limit /
reward earn / expiry /          reward balance / provider valuation
corporate action
      │                                │
      └───────────────┬────────────────┘
                      │        MARKET / REFERENCE DATA
                      │        price observations, FX,
                      │        reward valuation estimates
                      ▼
             ┌──────────────────┐
             │  DERIVED MODELS  │  positions, lots, valuations,
             │  (regenerable)   │  net worth, P&L, FX attribution,
             └──────────────────┘  tax views, expiry forecasts
```

## Data Model Decisions

### Instruments, not currencies

The central quantity-bearing concept is `instrument`, not `currency`. Fiat
currencies, securities, crypto assets, and reward units are all instruments
with a type:

```text
JPY   type=money      AAPL      type=security
AUD   type=money      BTC       type=crypto
USD   type=money      ANA_MILE  type=reward
```

A position is `(account, instrument, quantity)`. A bank balance is just the
special case `(bank account, JPY, n)`.

Type-specific semantics live in separate detail tables
(`money_details`, `security_details`, `crypto_details`, `reward_details`),
not in one wide `instruments` table. Tickers and symbols are display aliases;
canonical identity uses stable identifiers (ISO codes, ISIN, network +
contract, provider + program) with an `instrument_identifiers` table, because
tickers change and migrate.

### Balances are measurements, not columns

There is no `accounts.balance` column. A balance is a time-series
measurement: *subject, metric, value, as_of, source, method*. Providers
report several distinct balance metrics (ledger, available, pending, credit
limit); each is its own measurement. Later fetches append new measurements
rather than updating old ones.

Three timestamps are distinguished throughout:

- `as_of` — the point in time the value describes.
- `observed_at` — when the source displayed/reported it.
- `fetched_at` — when we retrieved the payload.

### Events with legs, not single-account transactions

An economic event has N legs across accounts and instruments:

```text
event: buy AAPL           event: reward conversion
  broker / AAPL  +10        card MR     -10,000
  broker / USD   -2,003.50  airline mile +10,000
  fee: 3.50 USD (explicit)
```

This is double-entry thinking without exposing bookkeeping to users, and it
prevents card payments and inter-account transfers from being double-counted
as spending. However, events are *not* required to balance at the raw or
reconciliation stage: a cross-currency transfer where only both endpoints are
known ("-1,000 AUD, +94,300 JPY") is stored with the gap unexplained rather
than forcing an invented fee.

### Observed values and derived values never mix

Every amount-like value carries provenance:

```text
origin: provider_reported / deterministic_derived / inferred / manual
method, confidence, calculation_version
```

Concretely:

- An FX fee the provider itemized is an explicit fee. A gap between the
  settlement rate and a reference rate is an *estimated spread*, stored
  separately with its estimation method. The two are never conflated.
- A broker's reported market value, cost basis, and unrealized P&L are stored
  as provider-reported measurements. Our own computed valuation is stored as
  a derived measurement. Both coexist; the difference between them is itself
  useful signal (FX rate differences, timestamp differences, accrued
  dividends) and a data-quality check.
- Provider-quoted FX rates, actual effective rates, tax-authority rates, and
  daily reference rates are distinct and never substituted for one another.

### Pending → posted is a link, not an update

Providers may change amount, date, description, and even external ID between
a pending and a posted transaction, and external IDs are not reliable logical
identities. Observations are append-only; relationships are expressed in an
`observation_links` table:

```text
relation:  pending_to_posted / supersedes /
           provider_same_transaction / probable_same_transaction
method:    provider / exact / heuristic / ai / manual
confidence: 0.0 – 1.0
```

### Lots and cost basis are derived

The canonical facts are acquisition and disposal events (plus corporate
actions and fees). Which lots a sale consumed depends on methodology (FIFO,
average cost, specific identification, jurisdiction-specific tax rules), so
lots are generated per methodology and per jurisdiction:

```text
tax_lots(jurisdiction=JP, methodology=...)
tax_lots(jurisdiction=AU, methodology=...)
investment_lots(methodology=FIFO)
```

Broker-reported cost basis is kept as a provider-reported measurement, not
adopted as truth.

### P&L is a calculation, not a column

P&L depends on base currency, price policy, FX policy, lot method, fee
treatment, and tax context. It is computed as
`analysis(as_of, base_instrument, methodology, …)` and decomposable into
market movement, FX movement, dividends, fees, and realized/unrealized parts.
Snapshots of results may be cached with a `calculation_version`, as read
models only.

### Market data is a separate domain, but used prices are archived

Price history does not live inside the event/transaction data. It is its own
domain of `price_observations` (`base_instrument`, `quote_instrument`,
`price`, `price_type`, `source`, `timestamp`, provenance to raw evidence).
External providers are the source, but any price actually used in a
calculation is stored locally with its provenance, so historical analyses
remain reproducible even if a provider disappears or revises data.

Execution prices from actual trades are distinct from market quotes; cost
basis uses executions, never provider quotes.

### Reward points and miles are not currencies

Reward units get four separated concerns:

1. Quantity — the balance, exact and factual.
2. Lots and expiry — expiry models differ fundamentally:
   `FIXED_LOT` (each earn expires on its own date, possibly in limited-use
   groups), `INACTIVITY` (whole balance expires after N months without
   eligible activity), `FIXED_ACCOUNT`, `NO_EXPIRY`. Expiry *rules* are
   stored as dated snapshots of program terms, separately from provider-shown
   expiry *observations* and from our derived expiry *estimates*.
3. Conversion rules — a conversion graph with offers (ratio, minimum,
   increment, campaign window, cash fees), not an FX table.
4. Valuations — multiple named methodologies per unit
   (cash-like redemption, typical redemption, target redemption, realized
   redemption value), never a single canonical "1 point = X yen". A
   provider-displayed "estimated value" is stored as that provider's
   valuation observation, never merged into the balance.

### Content-addressed evidence

Raw blobs are stored in R2 keyed by SHA-256. Identical fetches store one
blob; the fetch history (`fetch_artifacts`) is append-only, so "we confirmed
the same state again at 07:00" is preserved without duplicating storage.

## Technology

None of this infrastructure exists at the start: collection begins with
local Kuebiko captures only, and the stack below is introduced once real
captures have been analyzed (see `docs/roadmap.md`).

```text
Cloudflare Workers   HTTP ingestion API, later MCP
Cloudflare D1        structured data (metadata, observations, …)
Cloudflare R2        raw evidence blobs, content-addressed
Cloudflare Queues    ingestion / normalization jobs (when needed)
Cron Triggers        scheduled fetches (when automated)
```

### Why D1 (for now)

Serverless PostgreSQL (e.g. Neon via Hyperdrive) was considered and remains
the likely choice if and when the derived layers need exact decimal
arithmetic, complex joins, recursive conversion-graph queries, and large
reconciliation queries. The decision is to start with D1 because:

- The early phases (evidence collection, observations) need only hashes,
  timestamps, and simple indexes — well within SQLite semantics. D1 gives
  atomic batches, enforced foreign keys, and PITR with zero operational
  cost.
- The architecture itself de-risks the choice: everything below observations
  is re-derivable, and evidence lives in R2. Migrating the database later is
  mostly re-processing, not a data migration.

D1 conventions to avoid known pitfalls:

- Fiat amounts are stored as integers in minor units (JPY as yen, AUD as
  cents). `REAL` is never used for money.
- High-precision quantities (crypto, fractional shares) are stored as TEXT
  decimal strings or scaled integers with an explicit `scale`.

## Prior Art

Existing projects were evaluated as a canonical store and not adopted,
though several inform the design:

- **Plaid / Open Banking (GoCardless) transaction models** — the closest to
  this design: pending and posted are separate linked records, multiple
  dates and IDs, explicit `currencyExchange` structures.
- **Beancount / hledger** — excellent double-entry ledgers; a plain-text
  canonical file is awkward to update concurrently from Workers. The
  event/legs model borrows their thinking. A ledger export could become one
  read model later.
- **Firefly III** — solid double-entry REST backend with foreign amounts,
  but not serverless-friendly and weak raw provenance.
- **Actual Budget** — strong import/reconciliation UX, but local-first
  architecture, no native multi-currency, and reconcile-by-update semantics
  that destroy observation history.
- **Securo** — feature-wise closest (bank sync, multi-currency, MCP, AI),
  but a classic "finished ledger" DB: no raw archive layer, FX valuations
  materialized onto transactions (with a documented 1:1-fallback persistence
  bug), aggregated positions without lots. Useful as a reference and a
  possible read model, not as the store of record.
- **pnsk-lab/mnie** (MIT) — a self-hosted MoneyForward-style app. Same
  "finished ledger" shape, so not a store of record, but its provider
  clients are pure `fetch` (replayable internal APIs for SBI Securities,
  SMBC, Mobile Suica, PayPay), its `auth-bitwarden` package logs in from a
  local Bitwarden vault, and its type model (`TransactionObservation`,
  `EconomicEvent`/`Posting`, `MatchEvidence`) independently mirrors this
  design. Reused at the provider and auth level — see `docs/tooling.md`.
- **hirano00o/acctf** (MIT) — Go + Playwright scraper that captures cost
  basis and covers Sumishin SBI Net Bank. Kept as a scraping reference for
  what to extract, not adopted (browser automation, not serverless).

Owned components that already implement parts of this design —
[kuebiko](https://github.com/risu729/kuebiko) as the raw layer and
[smcc-meisai-scraper](https://github.com/risu729/smcc-meisai-scraper) as a
card-statement parser — and how all of the above map onto the four layers,
are cataloged in `docs/tooling.md`.

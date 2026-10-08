# Account and instrument identity (Layers C, phases 4–5)

The identity layer organizes the observations already collected. It does not
deduplicate purchases, turn debit-card activity into another deposit, add
balances, calculate holdings, or invent an instrument's ISIN/network.

## Contract and scope

`src/identity` in the observation PoC contains deterministic, independently
tested source rules. The production pipeline persists their interpretation in
migration `0018`. All four observation shapes and every merged parser source
are covered; the manual PayPay CSV path is also handled. Provider specifics are
in [SBI](identity-sbi.md) and [other sources](identity-sources.md).

A source account reference consists of source, producer, and exact source
account/discriminators. **Producer is a collector credential-slot boundary,
not proof of a person's permanent bank account.** The existing deployment has
one configured credential slot per such route (MyJCB/MoneyForward additionally
carry their connection/account keys). Changing the principal in that slot
requires a new producer/connection epoch, not silently reusing it. No rule
claims multi-login identity from a parser constant. Provider-local accounts
remain visibly provider-local until evidence or an explicit correction links
them. Ordinal-only card/reward references are scoped to the fetch run.

`source_accounts` preserve the exact reference; `accounts` are the independent
targets. Append-only `account_mappings` can link several references to one
account, or correct an earlier link without rewriting any observation. A
manual revision requires the expected current revision and an explanation.
Automatic policy upgrades never replace manual decisions; older policy
versions cannot replace newer ones. Labels/status are versioned mapping
claims, not updates to original evidence.

Instruments have opaque IDs, a kind, and separate namespaced identifiers.
ISO currency codes, offshore CNH, V POINT program units, exchange product IDs,
MIC+listing symbols and provider-reported RICs are different namespaces.
Tickers and labels are **not global identities**. A provider-local security can
later be mapped to an externally verified canonical instrument without changing
its observations. No currency suffix is treated as proof of a crypto asset,
and no derivative/product is automatically treated as the underlying coin.
Instrument identifier details retain identifier semantics only, not prices,
balances or credential fields. Type-specific financial metadata/valuations are
not inferred here and remain in later phases.

## Publication, provenance, and correction

Each `identity_run` names a successful parse run and an integer policy version.
Observations retain their original B identity and pinned mapping revisions;
instrument uses retain the roles unit/security/trade-unit/usage-unit. D1 checks
the actual parse/source/producer lineage rather than trusting a caller's DTO.
Publication uses an immutable completeness seal: incomplete runs are invisible
and safely resumable. Duplicate inserts, including SQLite `REPLACE`, and
updates/deletes are rejected. A seal does not make a superseded B parse current.

The effective read views select the newest sealed policy for each currently
eligible B parse and join current mapping revisions. Thus corrections change
the effective organization immediately while the original decision remains
auditable. Raw R2, Layer A and Layer B are never modified by this layer.

Manual decisions are durable records in the decision log
([decision-log.md](decision-log.md), migration 0029): an `assign` command
appends the manual mapping revision and its decision under an idempotent
operation id and a server-verified actor; a `release-override` appends a
decision that lets automatic policy apply again without deleting anything.
Automatic rules yield to the latest effective decision, not to the fact that a
manual row once existed. Which policy family and release produced an identity
run, and the digest of the evidence it depended on, is recorded per run
(`identity_run_policies`); selection is per source module, not a branch in
the store. Readers can ask for `latest` (current mapping revisions) or
`as-recorded` (the revisions the run pinned) and every organized response
names the interpretation it was computed under.

## Cross-identifier instrument candidates

One instrument can be stored under several identifiers: a listing identifier
at one source and a provider code at another, or a listing and a code inside
SBI when a trade names a venue the SBI rule does not map. Every such
identifier keeps its own rule mapping until a person re-maps it.
`queryInstrumentResolution` (`packages/application/src/query/instrument-resolution.ts`,
[ADR 0055](adr/0055-instrument-candidates.md)) reads the security, crypto and
product identifiers that current published observations use and answers,
under policy `instrument-candidates-v1`:

- **candidates**: pairs that share an equal ISIN, an equal RIC, or an equal
  country and security code as the identity rule recorded them, and state no
  conflicting fact. Each names its evidence, the facts that agree, the facts
  one side or both sides do not state (market, currency, share class, product
  class, ISIN; no rule records the last three, so every pair names them) and
  `crossSource`, which is false only when both identifiers are used by
  exactly one source, the same one;
- **separated** pairs: they share such a value but state a different
  instrument kind, ISIN, RIC, country, MIC, currency, share class or product
  class. Each side counts with every identifier that maps to its instrument
  now (`via` names the others whose facts conflict), so a code a person
  mapped onto one listing is separated from a listing on another market.
  They are never candidates;
- **hints**: equal current mapping labels (after width, case and whitespace
  normalisation) with no shared value, unless the two are already on one
  instrument or a label is only the identifier's own code (a rule's fallback
  when the provider gives no name). A name is never evidence; a hint has no
  status and nothing to adopt;
- each identifier's state: `unresolved-candidates`, `resolved-by-decision`,
  `kept-separate`, `no-candidate` (it stays what its own mapping says, which
  is not a global identification) or `shared-without-decision` (shares an
  instrument without a manual mapping; no rule produces it).

Market is compared through MIC or RIC only; the provider's market wording is
shown, never compared. An identifier's currencies are those the observations
using it as a security are denominated in: the trade unit, or the unit when
there is no trade unit or the trade unit is a crypto asset code (SBI VC
Trade). A trade or unit code outside the explicit currency catalogue, or a
use with no unit at all, makes the currency unconfirmed rather than falling
back to the settlement unit or being left out, and
valuations count, so SBI's yen valuations of a foreign holding beside its
trading-currency ones make its currencies several and the comparison
`currency-unconfirmed`.

Nothing here adopts. A candidate is `adopted` only when its two identifiers
map to one instrument, which only a manual `identity.assign` does today, and
`rejected` only when the newest `listed_as` relation from one identifier's
current instrument to the other identifier is rejected. A proposed candidate
names those two commands (assign the subject identifier to the anchor's
instrument; reject `listed_as` from the anchor's instrument to the subject) for
a person to plan with a reason through the [change lifecycle](change-lifecycle.md),
where agents can plan but never approve or commit. A manually mapped
identifier, or one sharing its instrument, is always the anchor over one that
is not; when both identifiers are settled that way the candidate names no
adopt command and a `hold` code (`subject-decided-elsewhere`,
`subject-shares-instrument`) says why. It still names the keep-apart
rejection, which moves no mapping, so a person can close it as `rejected`. `queryInstrumentHistory`
lists an identifier's mapping revisions, mapping decisions and `listed_as`
relations, oldest first; a correction is always a later entry.

Limits today: no HTTP route, page or MCP tool serves these reads. Only SBI
Securities and SBI VC Trade store security, crypto or product identifiers, so
cross-broker candidates need a second source whose identity rule records a
code and country, an ISIN or a RIC. No rule records ISIN, share class or
product class. Valuation and the report job still key holdings by the
provider-local `instrument:<source>:<market>:<code>`, so no candidate moves a
price, quantity or cost. The facts read walks every current identity
observation once, like the instrument catalogue; its D1 cost is not measured
and must be measured before a route serves it. An equal country and code is
proposed with no period comparison, so a code reassigned after a delisting
still pairs, and nothing names that as a gap. The status read ignores a
`listed_as` relation's `valid_from` and `valid_to`, so a rejection limited to
a period reads as permanent. A rejection from `instrument:<id>` keeps the
identifier apart from every identifier currently mapped to that instrument.

## Acceptance gates

- All merged source patterns exercised with synthetic tests; all seven SBI
  datasets exercised through their real parsers.
- Real stored observations audited with bounded read-only pagination; unknown
  patterns/identifiers reported by source, not hidden as successful matches.
- D1 runtime tests cover all four kinds, idempotence, interrupted resume,
  out-of-order versions, stale/manual corrections, immutable rows, invalid
  provenance, wrong mappings and incomplete seals.
- Source-level production coverage compares all currently eligible B rows to
  sealed C rows, separately from resolution status. "Organized" is not "globally
  identified," and account resolution counts are not a security resolution rate.
- Source-specific evidence-only datasets and rejected B parses have no invented
  account/instrument observations. Their existing raw/parse coverage remains
  visible separately.
- Protected UI/API tests run locally before a combined final production check.
  Existing Cloudflare Access protections and read-only browser behavior remain.

## Deployment boundary

The additive migration precedes the private observation pipeline and protected
browser deployments. No new database, bucket, public diagnostic Worker or
financial-institution login is required. Rollback can stop the identity sweep
or revert the UI without removing the additive schema or identity history.
Do not restore the whole D1 database as a routine rollback: collectors continue
to append independent evidence while this rollout is running.

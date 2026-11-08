# Account and instrument identity (Layers C, phases 4–5)

The additive pure temporal selector in
[`packages/domain/src/instrument-temporal.ts`](../packages/domain/src/instrument-temporal.ts)
implements supplied-snapshot cut, interval, relation and manifest contracts
([ADR 0055](adr/0055-instrument-candidates.md#amendment-2026-10-09-pure-temporal-selector)).
It requires an explicit interval/reference policy and keeps unknown legacy
validity unresolved. No persisted temporal journal, guarded temporal writer
or consumer integration exists yet. The current review view described below
still uses its existing current mappings and relation query.

The identity layer organizes the observations already collected. It does not
deduplicate purchases, turn debit-card activity into another deposit, add
balances, calculate holdings, or invent an instrument's ISIN/network.

## Contract and scope

`packages/identity` contains deterministic, independently
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
identifier keeps its own rule mapping until a person re-maps it, or, for one
shape inside SBI, rule `instrument-auto-v1` does (below).
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
- each identifier's state: `unresolved-candidates`, `resolved-by-decision`
  (a manual mapping among the identifiers on its instrument),
  `resolved-by-rule` (no manual mapping, an `instrument-auto-v1` decision),
  `kept-separate`, `no-candidate` (it stays what its own mapping says, which
  is not a global identification) or `shared-without-decision` (shares an
  instrument with no recorded decision; no rule produces it).

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

The read adopts nothing. A candidate is `adopted` only when its two identifiers
map to one instrument, which a manual `identity.assign` or rule
`instrument-auto-v1` (below) does, and
`rejected` only when the current `listed_as` relation from one identifier's
current instrument to the other identifier is rejected: the pair's newest
decision, which a proposal recorded after it does not replace
([ADR 0017's amendment](adr/0017-card-purchase-review-commands.md#amendment-2026-11-06-a-later-proposal-never-replaces-a-relation-decision)). A proposed candidate
names those two commands (assign the subject identifier to the anchor's
instrument; reject `listed_as` from the anchor's instrument to the subject),
to be planned with a reason through the [change lifecycle](change-lifecycle.md);
an agent on the browser's command routes can plan them and cannot approve or
commit, while an MCP client approves and commits as itself through
`kogane.command.approve` and `kogane.command.commit`
([ADR 0084](adr/0084-mcp-operator-authority-without-delegation.md)). A manually mapped
identifier, or one sharing its instrument, is always the anchor over one that
is not; when both identifiers are settled that way the candidate names no
adopt command and a `hold` code (`subject-decided-elsewhere`,
`subject-shares-instrument`) says why. It still names the keep-apart
rejection, which moves no mapping, so a person can close it as `rejected`. `queryInstrumentHistory`
lists an identifier's mapping revisions, mapping decisions and `listed_as`
relations, oldest first; a correction is always a later entry.

### Automatic adoption: rule `instrument-auto-v1`

The `instrument_auto_adoption` Processor lane
(`services/processor/src/instrument-auto-adoption.ts`,
`packages/domain/src/instrument-auto-adoption.ts`,
[ADR 0055 amendment 2026-11-08](adr/0055-instrument-candidates.md#amendment-2026-11-08-adopt-sbis-bare-domestic-code-onto-its-listing-by-rule);
owner direction 2026-11-08 03:16 UTC) adopts one shape without a person: SBI
Securities' bare domestic code `sbi-security-code/JP/<code>` onto SBI's own
listing `mic-symbol/<XTKS|XNGO|XFKA|XSAP>/<code>` of the same Japanese
securities code, both used by SBI Securities only, all in JPY, with no ISIN,
RIC, share class or product class stated, no conflict, nobody's decision on
either side (no manual mapping, no `listed_as` relation in any status naming
either identifier or instrument) and no
second candidate or separated pair for the bare code. Example: `7203` held on
東証 (`mic-symbol/XTKS/7203`) and traded on `PTS（X）`
(`sbi-security-code/JP/7203`).

An adoption is an `assign` identity command under actor
`rule:instrument-auto-v1`: a `rule` mapping revision onto the listing's
instrument and a `rule` `assign` decision naming both identifiers, guarded on
both identifiers' revisions as read, and a `lane` audit record. A later
identity policy version does not revert it. A person or an agent undoes it
with `identity.assign` of the bare code back onto its own instrument, which
the rule never touches again (a `release-override` of that mapping hands it
back to the rule). Everything else stays a candidate, for a person on the page
or an agent over MCP. A gate over the identifier catalogue ends a tick with
nothing to do; the full candidate read runs at most hourly while a pair of
the shape waits ([processor](processor.md#6-lanes)).

### Review page, route and agent tool

`reviewInstrumentCandidates` (`packages/application/src/query/instrument-candidates-review.ts`,
[ADR 0055 amendment 2026-10-09](adr/0055-instrument-candidates.md#amendment-2026-10-09-route-and-page-as-implemented))
serves one page of that read to whoever its grant allows: `records.read` over
the whole store. Views `open` (proposed, no hold), `held`, `decided`,
`separated` and `hints`; 50 items a page; an optional `identifierId`; every
item with `evidenceRefs` and the identifiers it names; the manifest of the
policy, bounds and closed codes; the summary counts of the whole read.

- `GET /api/identity/instrument-candidates?view=&offset=&identifierId=`
  (`services/app/src/instrument-candidates-api.ts`): read-only, behind the
  Access gate, under the reader grant a signed-in browser has.
- `kogane.instruments.candidates` ([agent API](agent-api.md#instrument-candidates)):
  the same answer to an agent under its own grant, read-only.
- `/identities/instrument-candidates` (`銘柄の同一性の候補`): the page. A
  proposed candidate's buttons plan its own `identity.assign` or
  `relation.reject` payload with the reason a person writes, and open the
  confirmation screen; approval and commit happen there. A held candidate
  offers keeping apart only.

Each request walks every current identity observation once, so its cost is
linear in captured history (about 0.8 to 0.95 s per 100,000 on workerd and
0.65 to 0.7 s on `bun:sqlite` on the synthetic scaled store; the amendment has
the figures). Before the walk the service counts them from the identity run
seals, in milliseconds, and refuses above 500,000 (`budget_exceeded`,
`budget:identityObservations=500000`). That is acceptable today for one owner
reading the page behind Access; routine agent polling needs a written bound
first. A reader pages to offset 950 of a view (no `nextOffset` past it);
`identifierId` narrows a larger one. The page re-reads a candidate before it
plans and plans nothing if the candidate, its commands or either
identifier's mapping revision changed. Candidate adoption payloads carry the
candidate id, anchor identifier, anchor revision and subject revision; the
server verifies the current open candidate and pins both mappings. Their
revisions are checked at approval and atomically in the commit batch.
A direct manual assignment carries no candidate provenance and cannot use
an `instrument-candidate:` base context without that bundle.

`GET /api/identity/instrument-history?identifierId=` serves the complete
stored mapping/decision/relation history for one identifier under
`records.read` and whole-store scope. The page opens it on request. The
service counts by index before loading entries and refuses past `maxRows`;
it never truncates the history. This is recorded history, not effective-date
mapping. An agent reads the same history through `kogane.instruments.history`
or `POST /api/agent/v1/instruments.history` (`services/app/src/read-tools.ts`,
[agent API](agent-api.md#delegated-execution-integration-and-shared-history-reads-s3-2026-10-10)).

Limits today: only SBI
Securities and SBI VC Trade store security, crypto or product identifiers, so
cross-broker candidates need a second source whose identity rule records a
code and country, an ISIN or a RIC. No rule records ISIN, share class or
product class. Valuation and the report job still key holdings by the
provider-local `instrument:<source>:<market>:<code>`, so no candidate moves a
price, quantity or cost. The facts read walks every current identity
observation once, like the instrument catalogue. Its D1 cost had to be
measured before a route served it; as amended on 2026-10-09 that is replaced
by the plan check without statistics, `bun:sqlite` and workerd measurements
and the observation bound above, and remote D1 remains unmeasured. An equal country and code is
proposed with no period comparison, so a code reassigned after a delisting
still pairs, and nothing names that as a gap. The status read ignores a
`listed_as` relation's `valid_from` and `valid_to`, so a rejection limited to
a period reads as permanent. A rejection from `instrument:<id>` keeps the
identifier apart from every identifier currently mapped to that instrument.

### Per-source counts

`readInstrumentCoverage` (`packages/application/src/query/instrument-coverage.ts`,
[ADR 0073](adr/0073-instrument-coverage-per-source.md)) runs the same read and
counts, for each source that uses at least one security, crypto or product
identifier in its current organized records, its distinct identifiers and how
many are in each state above. `GET /api/identity/instrument-coverage?source=`
serves it under the reader grant (`summary.read`, whole store), with the same
observation bound and read bounds, refused whole past either; `/identities`
shows it as `銘柄の整理状況` beside the account coverage. An identifier two
sources use is counted under each, so no total across sources is given; a
source with no row uses no such identifier, which is not a count of zero
resolved instruments. Counts are of identifiers, not instruments or holdings,
and are not a match rate. Only current mapping revisions and the newest
`listed_as` relation count: an adoption a person later corrected no longer
counts as resolved. An agent reads the same answer under its own grant
through `kogane.instruments.coverage` (`/mcp`) or
`POST /api/agent/v1/instruments.coverage`, which require `summary.read` over
the whole store ([agent API](agent-api.md#instrument-coverage)).

## Aggregator-to-direct account candidates

A MoneyForward account identity names one provider connection registered at
MoneyForward, which can list several products; its observations are
connection-scoped and no parser records a branch, an account number or a leaf
reference for them. The only stored evidence tying such a connection to a
direct collector's accounts is a current confirmed connection review
([account connections](account-connections.md)), possible today for SBI
Shinsei only. `reviewAccountCandidates`
(`packages/application/src/query/account-candidates.ts`,
[ADR 0077](adr/0077-account-connection-candidates.md), policy
`account-candidates-v1`) reads those reviews and answers:

- **candidates**: one per (current confirmed review, direct source account it
  pinned), proposing `connection_contains` from `connection:<producer>/<key>`
  to `source_account:<id>`, with evidence `connection-review-confirmed` and
  the review's artifact refs. Status comes from the newest stored relation of
  the pair (`accepted`, `rejected`, else `proposed`) under any reference it
  may have been recorded under, listed as `recordedContainment`: the
  candidate's own (`this-connection`), another producer's current review of
  the same identity value (`same-identity-value`), or a reference migration
  0029 backfilled under a key the identity-value rewrite (migration 0063)
  later replaced (`legacy-connection-key`, mapped through the review row the
  backfilled relation's id names). A pair already accepted under any of them
  is not offered for acceptance again; new decisions are planned under the
  candidate's own reference. Acceptance is
  withheld by a `hold`: `evidence-ineligible`, or
  `direct-account-in-several-connections` when current eligible reviews of two
  identity values pin the same direct account (none is chosen). Each names
  the `relation.accept` and `relation.reject` payloads that would decide it,
  to be planned with a reason through the [change lifecycle](change-lifecycle.md);
  rejecting an accepted pair withdraws it as a later row;
- **never `same_account`**: every candidate says why
  (`aggregator-account-connection-scoped`, and `several-direct-accounts` when
  one connection pins several direct accounts) and reports a `same_account`
  relation already stored between its two sides, in either orientation;
- **connections**: every current review with its state (`confirmed`,
  `unresolved`, `evidence-ineligible`) and its aggregator source accounts of
  any producer; **unreviewed**: aggregator source accounts no current review
  names (`no-connection-review`, `reference-unrecognized`).

A label, an institution name or an amount is never read. Nothing here adopts:
an accepted `connection_contains` is a subset claim of a `connection:` scope
no measurement has, so it moves no balance, and no transaction or display is
merged or suppressed.

It is served to whoever its grant allows, `records.read` over the whole
store: `GET /api/identity/account-candidates?view=&offset=&sourceAccountId=`
(`services/app/src/account-candidates-api.ts`, reader grant behind Access),
`kogane.accounts.candidates` ([agent API](agent-api.md#account-candidates))
and the page `/identities/account-candidates` (`口座の対応候補`), whose
buttons plan the named payload with the reason a person writes after reading
the candidate again; approval and commit happen on the confirmation screen.
Views `open`, `held`, `decided`, `connections`, `unreviewed`; 50 items a page.
Bounds: 64 current reviews, 1,000 aggregator source accounts, 10,000 newest
relation rows (and 10,000 backfilled relations under a rewritten key),
refused whole past each. Every read is keyed (ADR 0077, Cost).

Limits today: only SBI Shinsei pairs exist; candidates are listed per
producer's review (two producers' reviews of one identity value are two
candidates sharing one status); a plan pins only the revision of the
candidate's own reference, so a decision recorded under one of the pair's
other references between planning and commit does not make it stale; the
balance projection reads every accepted relation row, so a later rejection
does not remove an earlier acceptance from its declared inputs; no history
view of a pair; no validity period; no leaf-account equivalence and no dedup
of aggregator against direct rows.

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

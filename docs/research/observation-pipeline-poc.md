# Observation pipeline PoC — retired

`poc/observation-pipeline` no longer exists. It was the experiment that
answered the question nothing in the repository had answered before it: once
the bytes of a collected artifact exist, what turns them into observations
without ever becoming a finished ledger? It deliberately contained no
collector; authentication and anti-bot handling were, and remain, the subject
of the per-source experiments under `poc/`.

**Why it ended.** Not because it failed. It succeeded, and then the things it
proved had to stop being experimental. Design review D07 (#172) promoted the
parsers, the identity resolver, the observation types and the shared HTTP
contracts into `packages/`, leaving 27 one-line compatibility re-exports
behind. Unified plan U04 finished it: an experiment that a deployed Worker
serves assets from, that production tests read fixtures from, and that four
workspaces import through a compatibility shim is not an experiment any more —
it is unreviewed product with an experimental label.

**Where the code went.** Moved with `git mv`, no content change. The base
commit before the move is `d096178`, where every path in the left column still
reads as it did.

| Was                                                                                                                      | Is                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `web/**`, `vite.config.ts`, the three build modes, the frontend tests                                                    | `apps/web`                                                               |
| `fixtures/**`                                                                                                            | `tests/fixtures/observation-pipeline` (`MANIFEST.sha256` pins the bytes) |
| `src/{store,queries,ingest,parse,api,serve,demo,export-demo,normalized-values}.ts`, `schema.sql`, the store-backed tests | `experiments/observation-pipeline-local` (see its `EXPERIMENT.md`)       |
| `test/api-conformance.ts`                                                                                                | `packages/observation-shared/test-support/api-conformance.ts`            |
| `test/financial-products.test.ts`                                                                                        | `packages/observation-shared/test`                                       |
| `scripts/freeze-coverage-contract.ts`                                                                                    | `packages/parsers/scripts`                                               |
| `src/parsers/**`, `src/{types,money,snapshot-query}.ts`, `shared/**`                                                     | `packages/parsers`, `packages/observation-shared` (D07, #172)            |
| the 27 compatibility re-exports                                                                                          | deleted                                                                  |
| `RESULTS.md`                                                                                                             | this file                                                                |

**How to reproduce what is recorded below.** Every number here was produced by
the code as it stood at `d096178` or earlier, against the committed synthetic
fixtures — which are byte-identical in `tests/fixtures/observation-pipeline`
and proved so by `tests/fixture-manifest.test.ts`. The parser digests are
unchanged (`packages/parsers/test/parser-digests.test.ts`), so a re-parse of
those fixtures still produces the same observations. To run the pipeline
itself: `mise run //experiments/observation-pipeline-local:ci`, or `mise run //experiments/observation-pipeline-local:preview` for
the browsable synthetic store. For the code exactly as it was, check out
`d096178`.

**What is still live.** `experiments/observation-pipeline-local` keeps the
local store, its read API and the CLI entry points, with an owner, an expiry
of 2026-12-31 and a stop condition (the App API covering replay and status).
It is not part of any deployment and no production runtime imports it; the one
remaining coupling is the generated synthetic snapshot used by local API
conformance tests, declared in `infra/generated-files.json`. The public demo
Worker was retired on 2026-09-13.

---

## Results

Recorded 2026-08-28 and extended 2026-09-07. No captured financial data, credentials, cookies,
account identifiers, or balances were persisted or committed; every fixture
is synthetic.

The PoC ingests 11 synthetic artifacts from 3 sources into 49 observations
(14 transaction, 24 balance, 3 position, 8 valuation) across 11 parse runs.
The exact current test count is reported by CI; `tsc --noEmit` is clean.

## What it settled

**The roadmap's phase-2 table sketch survives contact with real collector
output, with two additions.** `sources` / `fetch_runs` / `raw_objects` /
`fetch_artifacts` map onto what `services/collector-sbi-securities` already writes
without distortion. Two columns had to be added: `fetch_runs.external_run_id`,
so a collector run id is the idempotency key for re-import, and
`fetch_artifacts.dataset`, because the SBI collector's artifacts are
identified by dataset name rather than by URL. A Kuebiko-sourced artifact
uses `url` instead; both coexist without a second table.

**Physically separate observation tables are the right call.** The four
shapes share only six columns (`parse_run_id`, `source_account`, `as_of`,
`observed_at`, `raw_locator`, `extra_json`). Positions need a quantity with
its own scale, balances need a metric and an instrument, valuations need a
subject and a currency. A generic table would have made every one of those
nullable and pushed the meaning into a type column.

**Supersession works as a marker on the parse run, not on observations.**
Re-parsing an artifact with a bumped parser version leaves both observation
sets intact and flips one nullable column on the older run. "Current" is
then a current-state join, which the browser uses on every page. Nothing
about the append-only rule had to be relaxed. Current state additionally
requires the parent fetch run to be successful and free of failure evidence;
partial raw evidence remains browsable but cannot replace financial state.

**Provider-reported valuations sit naturally beside positions.** SBI reports
evaluation amount and profit/loss in both JPY and the trading currency. As
observations they are four separate rows with their own currency, which is
what makes them comparable later against a valuation we compute ourselves.
Nothing forced them into a single figure.

## Defects found by review, and what they changed

An adversarial review of the first implementation found defects that broke
the guarantees the PoC exists to demonstrate. They are recorded here because
each one is a trap the real implementation would otherwise walk into.

- **An error parse run superseded a good one.** A parser that threw on a
  transient condition emptied the current-observation view, and the unique
  constraint then made the state unrecoverable without inventing a version
  number. Fixed: only a successful run supersedes anything, and uniqueness
  covers successful runs only, so a failed parse is retryable at the same
  version.
- **Supersession ignored version order.** Running an older parser after a
  newer one made the stale output current. Fixed by comparing versions
  rather than insertion order.
- **Ingestion was not transactional.** A failure partway through a run left
  a run row behind, so every later attempt returned "already ingested" and
  the run was lost permanently. Fixed: verify every artifact first, then
  write in one transaction.
- **A failed observation insert left a run marked `ok` with a truncated
  observation set** — indistinguishable from a source that really said less.
  Fixed: the parse run and its observations commit together.
- **A partial collector run could still publish current observations.** A
  pagination-total change preserved the final response correctly, but Layer B
  had no parent-run outcome and could parse that failure evidence as account
  state. Fixed by carrying status and failure count into `ArtifactMeta`,
  blocking all parsers centrally, and repeating the predicate in every current
  query. A v2-to-v3 in-place migration preserves old stores and marks legacy
  non-success runs conservatively.
- **PayPay columns were mapped positionally.** A swapped outgoing/incoming
  header recorded a payment as income, with no warning, and
  `docs/sources/paypay.md` explicitly lists the current column set as
  unverified. Fixed: columns are located by header label, with a warned
  fallback to position.
- **Amounts with trailing zeros were refused as precision loss.** An export
  writing `180,200.00` for a JPY figure lost every typed amount to a
  warning. Fixed, while `1.234` USD is still correctly refused.
- **Commas were stripped without validating grouping**, so a comma-decimal
  amount inflated a hundredfold. Fixed by validating the group pattern
  first. AUD sources make this reachable, not theoretical.
- **Unmodelled nested fields were dropped**, including, in one probe, an
  entire `totalBalance` the schema does not know about. Fixed: enclosing
  account and currency fields are carried into `extra` and warned about.

The general lesson: every one of these failed _silently_ and in the
direction of looking correct. That is the argument for the evidence browser
— and for warnings being data, not log lines.

## What the browser rebuild settled, and what it cost

The evidence browser was one 1,164-line module that ran the SQL, formatted
the amounts, and concatenated the HTML inside the same functions. It is now
`src/queries.ts`, `src/money.ts`, a Hono JSON API in `src/api.ts`, and a
React client under `web/`, built by Vite.

**The queries became testable without a renderer.** `test/api.test.ts`
drives 32 tests through the app object with no browser involved: the
current-view predicate, ids that must not be coerced into row lookups, raw
bytes round-tripping to their content address. Five further tests in
`test/browser.test.ts` run a real Chromium for the claims that only hold
end to end — provider text shaped like markup rendering as text, a
superseded observation being absent from the current view and present on
its artifact page, and the raw link returning bytes that hash to the digest
in its own URL.

**Money has one definition that a browser bundle can import.**
`formatAmount` and the minor-unit table moved into `src/money.ts`, which
imports no runtime API. The parsers, the API and the client now all import
it — before, the browser imported the parsers' helper, which a bundle
cannot follow. Nothing else in the client formats an amount.

**No chart library was added, and none is a dependency.** The rule in
`docs/evidence-browser.md` is that a chart is a claim about a trend, where
every claim here should be a row someone can trace. Keeping it out of
`package.json` is the part that will still be true in six months: adding
one means adding a package, not calling something already installed. The
same holds for a component library, a CSS framework, and an icon pack — the
client is React, TanStack Query, TanStack Table, and one plain stylesheet.

**It cost a build step and a layer of restatement.** `bun src/serve.ts`
renders nothing until `mise run //apps/web:build` has run, though the dev server builds
as it goes. The client restates every response shape in
`web/src/api.ts` rather than importing it from `src/queries.ts`, because
that file reaches `bun:sqlite`. A column added to an observation table now
lands in three places instead of one.

**Two invariants lost their tests in the rewrite, and got them back.**
`test/ui.test.ts` built a two-institution store whose account labels collide
and asserted that neither institution's balance hid the other's; it also
stored a content type containing CRLF and asserted that the raw route
neither injected a header nor returned a 500. The SQL's source-qualified
keys and the printable-ASCII check both carried over verbatim into
`src/queries.ts` and `src/api.ts` — the tests did not, and for a while the
suite grew while quietly losing two defences against exactly the kind of
failure this document is otherwise a list of. Both are now asserted again
in `test/api.test.ts`. Worth recording because the rewrite looked complete
and green at the moment the coverage was missing: a passing suite is not
evidence that the suite still checks what it used to.

**The 80 figure assumes a built client and a Chromium.** The browser tests
skip themselves when either is missing, printing why, and `bun test` then
reports 75 pass rather than failing. That is convenient on a machine
without a browser and easy to misread as a full run.

**An adversarial review of the rebuild found two blocking defects.** Amounts
were passing through an IEEE-754 double between SQLite and the screen,
because `bun:sqlite` returns an INTEGER column as a JS number — and a
comment in `src/money.ts` asserted a protection against exactly that which
nothing implemented. Amounts are now cast to text in every query. And
mutation testing showed the suite could not detect a violation of the
current-view rule for three of the four observation kinds: dropping the
status check, or the source from the balance partition key, left every test
passing. Both are fixed, and each new test was confirmed to fail when its
line is mutated.

The pattern is the same one this document keeps recording: the failure was
silent and in the direction of looking correct. A rounded amount still
renders as a neatly grouped figure; a green suite still looks like
coverage. Neither announces itself.

## Open questions

Sony Bank Layer B now covers every financial artifact family acquired by the
v2 collector: gross-balance JSON, paged yen and foreign-currency history JSON,
official yen and foreign CSV, and monthly sanitized WALLET HTML. A read-only
aggregate audit across seven successful production v2 runs established only
field names, container cardinalities, enum code sets, CSV headers, and HTML
table structure; it emitted no object key, digest, body, account identifier, or
financial value. The parsers repeat Layer A's page-local completeness checks,
pin observed enums and exact schemas, retain provider fields in `extra`, and
attach a locator to every row. Collection-wide missing-page and missing-month
inventory remains Layer A's responsibility because a Layer B parser receives
one artifact at a time. The source currently has no holdings artifact, so no
Sony position is inferred from balances or totals.

Review against the merged Layer A implementation found that the first synthetic
WALLET fixture had shortened the provider's eight-digit option value and required
an explicit `selected` marker that Layer A correctly treats as optional. It also
found that JSON and CSV were both becoming current transactions, unsigned WALLET
usage amounts were being treated as positive cashflow, malformed row pairings
could pass, and dataset currency, charset, and query-window relationships were
not bound. The fixture and parsers now use the actual selector contract, enforce
adjacent exact rows and occurrence-aware identity, omit ambiguous WALLET signed
amounts, and prefer the official CSV only in the current view while retaining
both raw-derived source views. Run windows now survive ingestion and gate every
history date. A checked-in aggregate-only canary repeats the strict source
inventory, metadata, native/application checksum, media, parser-route, and parse
checks without returning source keys, hashes, bodies, identifiers, or values.

The remaining questions need evidence beyond the shape audit described below;
none is resolved by assertion here.

### SMBC Direct Layer B validation (2026-09-07)

SMBC Direct now has two strict parsers and no raw/normalized double-count. The
canonical inputs are only `balance-normalized` and `transactions-normalized`;
their Shift-JIS raw partners remain evidence. A successful, failure-free parent
run, exact JSON media type and exact object/row shapes are required.

The transaction parser requires real Tokyo calendar dates inside the declared
monthly range, newest-first provider order, unique non-empty provider IDs,
non-negative source amounts, and exact agreement between row sums and the two
declared totals. Debit signs are applied from the explicit direction field,
never inferred from text. Provider post-row balances and all normalized fields
remain in `extra`. Re-fetches keep every append-only observation, while the
current view collapses the same provider ID to the newest parsed evidence.

A localhost-only, read-only production R2 canary reused the Layer-A validator
and scanned 189 objects. One successful manifest contained 188 data artifacts:
94 normalized artifacts parsed completely into 1,069 transactions and one
balance, and their 94 raw partners had no Layer-B parser. The canary emitted
only aggregate counts and performed no source write or delete.

### SBI Shinsei Layer B validation (2026-09-07)

SBI Shinsei stores five data artifacts on a complete run. Layer B registers
only the two independent raw sources with explicit money semantics:
`top-accounts-balance-and-activity` and `yen-deposit-account`. The top parser
emits provider account balances, provider-stated JPY equivalents, the activity
snapshot balance, and signed transactions whose sign provenance is the
mutually exclusive debit/credit field. The yen-deposit parser preserves its
two account arrays as distinct metrics. Both reject unknown fields, excessive
cardinality, duplicate provider identities, invalid dates/currencies, and
known-fiat decimals that cannot be represented exactly. Successful wrappers
with provider error fields, non-exact JSON media types, invalid provider clock
components, reversed/out-of-window activity dates, and unknown nested product
detail fields also fail closed. Aggregate overview siblings and validated
product/module/detail sections remain in provider context; row balances stay
explicit raw evidence because their post-transaction meaning is not yet proven.

Three success artifacts have deliberate no-parser decisions. `normalized` is
derived only from the top response and would duplicate observations while
discarding provider transaction identifiers. `balance-summary-and-stage`
does not state enough currency/unit context for its money-looking summary
fields. `exchange-rate` cannot be represented faithfully by the existing
money observation kinds because a quote needs numerator/denominator semantics.
The central `collector-manifest` is metadata, not financial evidence.

The production canary is aggregate-only and read-only. Its 2026-09-07 run
scanned 93 objects: 15 manifests passed the current manifest contract and all
15 recorded failed collection status; 13 other manifest candidates reduced to
the fixed `contract_validation_failed` result. No successful production
manifest was available, so the canary exited non-zero and did not use failed
evidence as parser proof. It validates every raw and derived schema before
exercising Layer B, requires a complete decision for all five successful
artifacts, and emits no object name, digest, body, account identifier, or
financial value. The canary directly reuses the importer Layer A validator for
object bounds, exact metadata/content types, native and recomputed checksums,
inventory pagination, and raw/normalized semantic equality. Partial and failed manifests remain validated raw evidence
but never enter parsers. Anonymous fixtures cover non-empty,
multi-currency, opaque product-code, debit/credit, duplicate-identity,
cardinality, and unknown-field boundaries without committing production data.

The source activity request exposes `fromDate` and `toDate`, but the current
contract contains no server pagination token or total count. Layer B therefore
records only the returned rows and does not claim that they are complete
history. Likewise product codes are retained as provider evidence rather than
mapped to an account taxonomy from client-side labels alone.

### GLOBAL PASS Layer B validation (2026-09-07)

The checked-in audit worker reuses the merged GLOBAL PASS Layer-A manifest,
R2 metadata, native-checksum, sanitized-byte, and run-completeness validator.
It lists production R2 one object at a time with a bounded, advancing cursor
and returns aggregate counts only. It never writes or deletes R2 objects and
does not disclose object keys, hashes, HTML bodies, account identifiers, or
financial values.

The audit scanned 66 objects. Twenty-five manifests passed the current strict
Layer-A contract; five of those were terminal success runs with zero failure
evidence and contained ten activity artifacts. The other twenty valid
manifests were failed runs and produced no Layer-B observations. Six retained
legacy manifests failed the current strict validation and were reported only
as one fixed aggregate failure category.

Across the ten eligible artifacts, the audit found one month selector per
artifact, fifteen eight-digit month values, exactly one selected month value,
and a selected month consistent with the artifact's manifest month. A single
unselected non-month default option is explicitly ignored. Layer A permits one
through fifteen contiguous available months, so the parser accepts that same
range and binds the selected option to the artifact key. The HTML carried
75 logical activity records. Every record had one outer row pair and one
compact/expanded responsive pair; the parser required those cardinalities and
converted them into exactly 75 transactions, not 150 or 225. All 75 displayed
transaction amounts were unsigned. Consequently the parser preserved amount
text, scale and currency but emitted no signed minor-unit amount.

The outer schema fixes the date, detail, transaction amount, three fee fields,
status, and approval-number roles. Conditional provider fields are retained by
their exact labels in `extra`; a missing required role, unknown table, duplicate
header, source-view amount disagreement, invalid calendar date, date outside
the selected month, non-contiguous selector, or row/cardinality drift rejects
the artifact. Status, authorization, fees, pending/confirmed transitions, and
family-card identity are not promoted beyond what the captured page explicitly
states. In particular, no stable pending-to-posted reconciliation key is
claimed. Append-only refetch evidence remains queryable, while the current view
selects only the latest successful artifact for each source and month; a later
empty month therefore clears older rows from the current view.

### Mobile Suica Layer B validation (2026-09-07)

A read-only aggregate/canary against production R2 confirmed that the current
successful Mobile Suica run stores exactly three data artifacts:
`sf-history-html` as Shift-JIS HTML, and `sf-history` plus
`collection-summary` as JSON. No object body, key, digest, account identifier,
or financial value was printed, retained, or committed. The normalized history
had the exact root fields `asOfDateJst`, `complete`, `pageCount`, `rows`, and
`transactionCount`; its rows had the ten exact fields pinned by the anonymous
fixture. The observed row kinds were all within the collector enum, amounts
included both signs as well as an unavailable carryover amount, and normalized
post-row balances were integral when present.

The parser makes `sf-history` the sole canonical financial artifact. It emits a
JPY transaction only when the normalized amount is available, takes direction
from that sign rather than from the row kind, and emits a JPY post-transaction
balance when available. Provider order is newest first; observations are
written oldest first so the newest same-day balance wins the append-only id
tie-breaker. Full normalized rows survive in `extra`, locators point to
`json:$.rows[index]`, and `_kogane` records that the JSON derives from
`sf-history-html`.

The current collector proves only one page and treats 100 rows as an incomplete
boundary. Current payloads therefore require `pageCount: 1`, exact
`transactionCount === rows.length`, and `complete: true`; the legacy envelope
without `complete` is accepted only below 100 rows and is warned. Empty history
is an explicit valid snapshot. Rows on or after the collection date are
rejected because the PC view is documented through the previous day.

One live canary fact conflicts with the public 26-week statement: a normalized
successful artifact contained provider-derived history older than 26 weeks.
Layer B warns and preserves such a row instead of silently deleting evidence or
making the whole snapshot unavailable. The source-side meaning of that
discrepancy remains an upstream investigation item.

Finally, `ArtifactMeta` now carries the owning fetch-run status and the parser
sweep skips every accepted artifact whose run is not `success`. A parser-level
guard provides the same boundary for direct calls. This closes the contract
gap where sealed partial/failed evidence could otherwise become a current
financial observation.

Four previously unparsed SBI datasets now have strict semantic parsers. A
read-only aggregate audit confirmed their source envelopes and container
types without printing or retaining payload values. The parsers preserve
provider transaction codes, currencies, dates, security identifiers, asset
views/categories, and F2631 byte locators in versioned observations. They
fail the artifact on schema or completeness drift rather than publishing a
partial account state. Anonymous boundary fixtures pin the accepted shapes;
they contain no production object names or evidence digests.

The F2631 parser follows the provider byte contract rather than treating UI
metadata as accounting data: `U` / `D` / `F` are display trends only, and an
amount's sign comes from its amount text. Acquisition unit price, current
price, and `kaitsukePrice` are separate metrics at their own byte locators.
Deposit type is included in the source-account identity so that otherwise
identical security codes in specific, general, and NISA holdings do not join
to one another's valuations.

### V Point Layer B validation (2026-09-07)

The repeatable production canary reused the merged strict Layer-A validator and
read the source R2 only through a local remote binding. It scanned 167 objects:
26 manifests passed the current contract, 139 non-manifest objects were skipped,
and two retained manifests failed strict validation. Those failures were reduced
to one fixed aggregate category. The valid manifests were 15 success, 11 failed,
and zero partial; failed runs produced zero Layer-B observations.

All 111 financial artifacts in the 15 valid success runs parsed completely. The
other 28 success artifacts were the non-financial collection summaries and the
observed-empty V Money boundary. The canary produced 2,307 observations: 45
balances and 2,262 signed point transactions. It found 1,902 positive, 360
negative, and no zero point rows, and verified that all 2,262 transactions omit
an invented external id. No object key, digest, response body, provider text,
financial value, credential, or session value is returned by the audit.

`balance-info` preserves each common and store-limited expiry bucket, and
`smfg-point` keeps its two displayed fields separate without claiming what the
numeric split means. `history-page-*` repeats Layer A's exact envelope, row,
graph, pagination, cardinality, UTF-8, and calendar checks. The transaction
amount and sign come directly from `point`; numeric `point_type`, `point_div`,
and `get_month` values remain unmapped provider evidence in `extra`. The history
response exposes no stable provider row id, so every occurrence is retained and
no `externalId` or reconciliation link is manufactured. Current queries select
only the newest complete V Point run, avoiding repeated full-snapshot double
counting and preventing disappeared rows or expiry buckets from lingering.

### MyJCB Layer B validation (2026-09-07)

A checked-in, aggregate-only canary replayed the production MyJCB source
contract through the importer normalizer and the Layer B registry. It scanned
184 private-R2 objects and audited 24 manifests without printing or retaining
an object key, digest, body, connection identifier, merchant, financial value,
credential, or session value. The manifests were 8 successful and 16 failed;
all 24 passed the strict source contract, and every artifact in all 8 successful
runs selected exactly one Layer B parser and parsed without error. The result
contained 181 transaction observations and 16 provider-reported statement
payment metrics. The source bucket was not written or deleted.

`credit-ledger` is the sole transaction-bearing route. Production evidence
showed internal whitespace in provider dates and also showed that the payment
type and exact JPY display can occupy either of summary cells 2 and 3. The
parser removes only Unicode whitespace from the date before validating the
calendar date, then requires exactly one of those two cells to be an exact JPY
display. Provider liability-positive amounts become observation
outflow-negative amounts; refunds therefore remain positive inflows. Duplicate
identical rows receive deterministic occurrence suffixes rather than colliding.
Across collection runs, the current view selects the newest complete snapshot
per confirmed period and the newest complete unconfirmed snapshot overall, so
repeated statements collapse and a disappeared pending row does not remain
current.

`credit-past-months` emits only displayed, available `payAmount` values as the
provider's monthly statement-payment metric. Sanitized menu/detail HTML and
collector discovery are validated evidence boundaries and emit no financial
observation, which prevents HTML and normalized ledger double counting. The
provider settlement label supplies a year-month `asOf`, preventing insertion
order from making an older month the latest statement metric. Accepted relative
fallback labels remain warning-bearing observations with no invented date and
are ranked by provider `detailMonth` only after selecting the latest complete
artifact. The
current production evidence had non-empty ledgers and displayed past-month
amounts, but no manifest had multiple connections. CSV, PDF, OFX, debit, and
cross-connection behavior therefore remain deliberately unregistered or
synthetic-only until their raw shapes are observed and contracted.

The anonymous fixture mirrors the observed envelope, metadata, date-spacing,
and amount-cell variation without copying production identifiers, hashes,
merchant text, dates, or financial values. It also pins failed-run exclusion,
metadata drift, ambiguous/missing amount cells, duplicate months, and repeated
dataset ingestion. Schema v4 adds artifact key, statement state, and period;
schema v5 adds the provider query window needed by Sony history validation.
v2, v3, and v4 stores migrate in place rather than weakening the strict importer.

**Are SBI's `evaluationAmount` fields really JPY?** The foreign-positions
parser assumes the unprefixed fields are JPY and the `frn*` variants are in
`currencyCode`. This is inferred from field naming, not observed. If it is
wrong, bumping the parser version and re-parsing corrects every historical
observation — which is precisely the operation this PoC exists to prove, so
the assumption is cheap to hold and cheap to withdraw.

**What do the Vpass `meisaiList` rows mean?** `services/collector-vpass` deliberately
stores the positional `rowType`/`data` arrays losslessly rather than
guessing, so no Vpass parser is included here. The card statement is the
repository's most mature collector and its most valuable unparsed evidence;
this is the most useful next parser, and it needs one real payload read by a
human before a line of it is written.

**Artifact encoding is not recorded.** Parsers decode UTF-8 strictly, so a
Shift-JIS (CP932) artifact becomes an error parse run rather than silent
mojibake. Several documented sources are CP932, and PayPay's export encoding
is unverified. The raw layer should carry the declared charset on the
artifact so a decoder can be selected rather than assumed. Failing loudly is
the right interim behaviour, but it is interim.

**`observed_at` has no source yet.** It is left unset rather than aliased to
`fetched_at`, because copying the retrieval time into it would collapse two
of the three timestamps `docs/design.md` separates. It stays empty until a
payload is found that states when the source displayed a value.

**Nothing here addresses identity or linking.** Two PayPay rows in the
fixtures share a transaction number — a payment and its later refund. That
is correct evidence and exactly why external ids are not logical identities.
Deciding they are related is phase 6, and no code here anticipates it.

### MoneyForward ME Layer B validation (2026-09-07)

MoneyForward ME now has one semantic transaction route. The monthly calendar
fragment supplies exact provider dates, descriptions, and explicitly signed
JPY integers; the accounts index and bounded recent account-detail view remain
strict evidence-only inputs. The parser validates neighboring-month calendar
rows but emits only rows whose date belongs to the month declared by the
artifact key, avoiding both adjacent-month and recent-view duplication.

Anonymous fixtures pin successful, empty, adjacent-month, invalid-date,
unsigned-amount, header, row-shape, metadata, and failed-run boundaries. The
current view selects the latest successful complete artifact per source,
HMAC account unit, and month, so a later empty snapshot removes stale current
rows without deleting append-only history. Ordinal changes preserve identity;
underlying institution identity is deliberately not inferred.

The adversarial review found and fixed incomplete fragments clearing complete
snapshots, whitespace joining amount digits, and unstable ordinal identity.
Layer A now supplies a domain-separated HMAC of a JSON account/service tuple via
account fetch units; index/detail agreement and within-run uniqueness are required.
The 64-account continuation is bounded below 8 KB. Regression coverage includes
unit topology, partial units, legacy cursor rejection, ordinal moves, twelve-month
overlap/refetch, duplicate row occurrences, and invalid-newer snapshot retention.
Production structural review counted 407 nonempty and 73 empty fragments. All
480 had exactly one calendar marker, no script element, and no non-tooltip table;
all 73 empty fragments shared the same audited tag/attribute-name sequence.
The final read-only reparse with HMAC/index binding and stricter empty/amount
validation accepted all 480 monthly artifacts and emitted the same 6,880
observations, with zero parser rejections. Template syntax may contain whitespace;
the signed integer itself cannot contain whitespace between digits.

The production read-only full canary scanned 540 objects across 10 successful
manifests and 530 data artifacts. It validated all 480 monthly fragments and
8,603 tooltip-body rows, emitted 6,880 selected-month observations (1,883
inflow and 4,997 outflow), and validated but excluded 1,723 adjacent-calendar
rows. The remaining 50 account index/detail artifacts were accepted as
evidence-only. Layer A and Layer B failures were both zero. Only aggregate
counts and fixed failure codes were returned; no body, object key, hash,
identifier, or individual financial value was included.

The production canary is read-only and aggregate-only. It reports only fixed
contract outcomes and counts; it does not emit object keys, digests, account or
transaction text, amounts, credentials, cookies, or raw bodies, and it performs
no R2 writes or deletes.

## Not done

The observation pipeline itself performs no collection or authentication and
has no ingestion API. Its local store uses `bun:sqlite`; schema migrations are
covered there, while production D1 deployment remains a separate operational
step. Source-specific aggregate canaries are explicit read-only validation
tools and do not make the parser process network-capable. No Worker was
deployed and no R2 or D1 object was written for this validation.

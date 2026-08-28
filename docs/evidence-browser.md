# Evidence browser

A read-only web view over layers A and B — raw evidence and observations,
nothing above them. Its purpose is narrow: let a human check what a parser
produced against the exact bytes it produced them from, and walk the
provenance chain in both directions.

It is implemented in the observation-pipeline proof of concept
(`poc/observation-pipeline/src/ui.ts`, served by `bun run ui`). This
document records what it is for, the rules that keep it small, what the
code enforces today, and what is still open.

## Where it sits in the roadmap

`docs/roadmap.md` carries it under "Operator tooling — Evidence Browser".
It is not a numbered phase, because it is not a data layer: it spans
phases 2 and 3 and would be deleted without data loss. The MVP cut in the
same document was narrowed to admit it — the exclusion that read "any UI"
now reads "the product UI" — and that narrowing is stated there
deliberately rather than quietly.

This document is the other half of that decision: the boundary written as
rules, so that a request to widen it can be refused by reference rather
than by argument.

Admitting the browser costs three things, and the rules exist because of
them:

- It is code that produces no data. Every change to the layer A or layer B
  schema breaks it, and fixing it is work that does not move phase 3
  forward. The reward table below is the first concrete instance.
- It renders real financial data, so it has to be protected as carefully
  as the ingestion API, and for the rest of its life.
- It invites drift. "Just add a chart", "just let me fix that one row",
  "just show me net worth" are each small, and each one turns the operator
  tool into the product UI a phase early.

## Why it earns its place during phases 2 and 3

`docs/design.md` makes a strong claim: A to B is as deterministic as
possible, parsers record `parser_name` / `parser_version` on every
observation, and re-parsing all historical evidence with a newer parser,
superseding prior observations, is a first-class operation from day one.
An operation nobody can inspect is an operation nobody trusts. Without a
way to see the old parse run's rows next to the new one's, "re-parse
everything" is a button no one will press on real data.

The same argument applies to writing the first parser at all. A parser is
a claim that a specific byte range in a specific artifact means a specific
typed value. Verifying that claim requires holding both ends at once: the
observation and the bytes. Reading rows out of `bun run parse` output and
opening the raw JSON in an editor does this badly, one row at a time, with
the mapping held in the operator's head. Tests pin the cases someone
already thought of; the browser is how the unthought-of cases are found —
a currency the parser silently treated as JPY, a metric that is
provider-reported rather than derived, a date that is `observed_at` and
not `as_of`.

`poc/observation-pipeline/RESULTS.md` records eight defects an adversarial
review found in the first implementation, and every one of them failed
silently and in the direction of looking correct. That is the argument in
one line. The cost of getting layer B wrong is not lost data — evidence is
immutable, and a wrong parser can be superseded — it is that the error
stays invisible until a derived figure looks wrong three phases later.
This is the cheapest phase in which to look.

## Rules

The boundary is written as rules, not intentions:

1. It reads layers A and B only. No table above `parse_runs` and the
   observation tables is queried, because when the interpretation and
   derived layers exist they are not this tool's business. That none of
   them exists yet is the weaker reason, and it expires.
2. The request handler writes nothing. No query in `src/ui.ts` is an
   `INSERT`, `UPDATE` or `DELETE`, and any method other than `GET` or
   `HEAD` is refused with 405. What that does and does not cover is stated
   exactly under "Read-only, precisely" below.
3. It stores nothing. Every "current" or "latest" view is computed by SQL
   on the request that asks for it. No cache, no materialized view, no
   snapshot table.
4. Deleting it loses no data. If `src/ui.ts` were removed, the pipeline,
   the store, and every observation would be unchanged. That is the test
   of whether it has stayed a tool.
5. It records no interpretation. Identity, links, classification, and
   every derived figure remain out of scope exactly as `docs/roadmap.md`
   says. The positions page does pair valuations with positions in order
   to lay the page out; that pairing is named below, is made at display
   time, and is never stored.

## The read model

The pages below are implemented and covered by the 20 tests in
`test/ui.test.ts`, of the PoC's 63 passing tests. Against the demo store
that `bun run demo` builds — 2 sources, 4 artifacts, 4 parse runs, 28
observations — they render the whole dataset.

### Overview — `/`

Row counts for all nine tables the schema defines, the source registry
with artifact counts, every fetch run, and every parse run with its parser
and version, status, warning count, and whether it is current or
superseded. Answers: what is in here, where did it come from, and which
parser versions are live.

### Transactions — `/transactions`

Every current transaction observation with its source, account, `as_of`,
formatted amount, currency, description, counterparty, `external_id`, and
the parser that produced it. "Current" is
`superseded_by_parse_run_id IS NULL AND status = 'ok'` on the parse run,
which is the predicate every current view uses. The page states in place
that `external_id` is what the provider said and not a logical identity: a
pending row and its posted row are related by a link, never by an update
(`docs/design.md`).

### Balances — `/balances`

Two tables. The first is the latest observation per
`(source, source_account, metric, instrument)`, computed by a
`ROW_NUMBER()` window function over current rows on each request. The
second is the full history, rows from superseded parse runs included and
marked.

The ranking rule inside that window function has to be stated, because it
mixes two timestamps `docs/design.md` keeps distinct:

```sql
ROW_NUMBER() OVER (
  PARTITION BY fa.source_id, b.source_account, b.metric, b.instrument
  ORDER BY COALESCE(b.as_of, b.observed_at, '') DESC, b.id DESC
)
```

`as_of` is the point in time a value describes; `observed_at` is when the
source displayed it. A row that has only `observed_at` is ranked against a
row that has `as_of` as though the two were the same kind of time, and
when neither is present the winner is decided by `b.id DESC`, which is
insertion order. "Latest" is therefore a display convenience, not a claim
about which measurement is the most recent one. No parser in the PoC sets
`observed_at` yet (`RESULTS.md`), so the fallback is currently
unexercised, which is exactly when the rule is cheapest to write down.

The history table marks supersession and nothing else: its lineage column
reports whether a row's parse run was superseded, not whether it
succeeded.

A balance is a measurement, so each metric an institution reports is its
own row; nothing is collapsed into one number per account.

### Positions — `/positions`

Each current position with its quantity as a decimal string and an
explicit scale, followed by the provider-reported valuations for the same
(source, account, security), each in the currency the provider stated.
Answers: what does the broker say we hold, and what does the broker say it
is worth. Kogane's own computed valuation is a derived layer and does not
appear.

This page performs the browser's one interpretive act, and it is worth
naming as such rather than presenting the pairing as a fact the data
carries. `renderPositions` buckets valuation observations by
`(source_id, source_account, subject)` and looks each position up under
`(source_id, source_account, security_code)` — an exact string match
between two observation kinds' provider labels, made at render time. It is
defensible: it stays inside one source, matches on the provider's own
identifiers, stores nothing, and every row it shows stays individually
linked to its own observation page. It is still a decision the data does
not carry. When a position has no match the page says so ("No
provider-reported valuation observation matches this position"), which is
an assertion about the match rule, not about the provider.

Nothing about the pairing is stored and no link is recorded, so
`docs/roadmap.md`'s summary — that the browser interprets nothing and
stores nothing — holds of the data. It is the page layout that makes the
claim, and it lasts exactly as long as the response.

Phase 6 is where this belongs permanently: `observation_links` with
relation, method, and confidence (`docs/design.md`, `docs/roadmap.md`),
not a render function.

### Observation detail — `/observations/<kind>/<id>`

Every stored column, the formatted amount, `extra_json` pretty-printed,
and the provenance walk described below. Answers: what exactly is this
row, and where did it come from.

### Artifacts — `/artifacts` and `/artifacts/<id>`

The index lists one row per retrieved thing with source, dataset, MIME
type, `fetched_at`, short SHA-256, parse-run count, per-kind observation
counts, and a link to the bytes. The detail page shows the artifact's full
layer-A record and then every parse run over those bytes, superseded ones
included, each with its observations normalized to a common display shape.
This is where a re-parse is compared against what it replaced.

### Raw bytes — `/raw/<sha256>`

The stored bytes, verbatim, with the digest echoed in an `x-kogane-sha256`
header. The path is validated as a 64-hex digest before anything is read,
and the response is deliberately inert — see "Raw evidence is served
inert" below. Answers the only question that ultimately matters: what did
the source actually send.

### Four of phase 3's five observation tables

`docs/roadmap.md` phase 3 lists five observation tables:
`transaction_observations`, `balance_observations`,
`position_observations`, `valuation_observations`, and
`reward_observations`. The PoC's `schema.sql` defines the first four, and
the browser covers those four: the URL whitelist, the counted tables, the
per-artifact counts, and the parse-run normalizer each enumerate them by
name.

Rewards are therefore not one missing page. Adding the table means
touching the whitelist, the count list, the artifact index, the
normalizer, and adding a view — the first concrete instance of the cost
stated at the top of this document, that this is code which produces no
data and which every schema change breaks. It is a reason to keep the
browser small, not a reason to leave the gap unstated; the exit criteria
below are written with it in mind.

## Provenance as the central interaction

The observation detail page renders one chain:

```text
observation (raw_locator)
  -> parse run   (parser_name@parser_version, parsed_at, status,
                  warnings, error, superseded_by)
  -> fetch artifact (source, dataset, url, mime, fetched_at)
  -> raw object  (sha256, size, content_type, link to the bytes)
  -> fetch run   (tool, external_run_id, status, started_at, completed_at)
```

Every link in it is load-bearing. Drop the raw locator and the operator
knows which file but not which part of it. Drop the parser version and a
wrong value cannot be attributed to a parser generation. Drop the artifact
and the same bytes cannot be found under a different fetch. Drop the raw
object and the tool asserts provenance it cannot show. Drop the fetch run
and there is no answer to "was this from the run that half failed". A
chain with a gap in it is not evidence; it is a claim.

The chain is navigable in both directions: from an observation down to the
bytes, and from an artifact up to every observation any parser version
ever derived from it.

## What the code enforces

The following is implemented in `src/ui.ts` and asserted in
`test/ui.test.ts`, rather than left to care.

### Read-only, precisely

Two different claims get made under this word, and only the narrower one
is true today.

What holds: the request handler writes nothing. No query in `src/ui.ts` is
an `INSERT`, `UPDATE` or `DELETE`, and `createUiHandler` refuses any
method other than `GET` or `HEAD` with 405 before it routes anything.

What does not: the process is not read-only. The entrypoint calls the same
`openStore()` as the ingesting and parsing tools, and `openStore()`
(`src/store.ts`) creates the state directory, opens the database with
`create: true`, and executes `schema.sql`. Pointed at a directory with no
store in it, `bun run ui` creates an empty one rather than failing.

So the accurate statement is that the handler cannot write, not that the
process cannot. Opening the connection read-only in the UI entrypoint
would close the gap locally, and a read-only D1 binding would close it in
the deployed shape. Neither is done; both are in the open questions.

### Supersession is visible, not destructive

Current views require `superseded_by_parse_run_id IS NULL` and
`status = 'ok'` on the parse run. The status test is not redundant: only a
successful run ever supersedes anything (`src/store.ts`), so an error run
is never superseded, and checking supersession alone would leave it
current. In the current pipeline an error parse run is written on its own
with no observations (`src/parse.ts`), so the test excludes no row today.
It is there because the row it would exclude is exactly the kind that must
never appear in a current view.

Superseded rows stay reachable, marked, through the artifact page and the
observation detail page. No observation row is ever hidden by deletion.

### The source is part of every key

`source_account` is only the provider's own label and carries no
institution identity: two sources can both call an account "main", and
numeric TSE security codes are shared across every Japanese broker. The
balance partition key, the position ordering, and the valuation bucket key
therefore all include `fetch_artifacts.source_id`, and the transaction and
position views show the source as a column. `test/ui.test.ts` builds a
two-institution store whose labels collide, and asserts that neither
institution's balance hides the other's and that neither's valuation
attaches to the other's position.

### Raw evidence is served inert

Stored evidence can be attacker-authored HTML — layer A holds HTML by
design (`docs/design.md`, `docs/collection.md`) — and rendered inline in
this origin it could read every other page of the browser, which is the
whole dataset. The bytes still go out verbatim, because they are the
evidence, but the response is not an active document:
`Content-Security-Policy: sandbox` denies it an origin and scripting, and
`X-Content-Type-Options: nosniff` stops the browser inferring a type the
source never declared. The disposition stays `inline`, so an operator can
read a JSON or CSV artifact in place; `sandbox` is what makes that safe.

The stored content type is itself provider-derived and reaches a response
header, so it is validated as printable ASCII first and replaced with
`application/octet-stream` otherwise. A CR or LF in it would otherwise
throw out of the handler as an unhandled 500; `test/ui.test.ts` stores a
content type containing CRLF and asserts that neither an injected header
nor a 500 results.

### All provider-derived text is escaped

Descriptions, counterparty names, security names, and `extra_json` were
written by an institution, not by us. All of it goes through `escapeHtml`,
and the rendered pages carry no client-side JavaScript, so there is
nothing on them that could act on injected text either. That covers the
HTML pages; `/raw` is covered by the rule above instead, because there the
provider's bytes are the page.

### Money is formatted without float arithmetic

`formatAmount` widens minor units with `BigInt` and formats by string
manipulation. A value that is not an integer is printed as stored rather
than rounded; an instrument with no known minor-unit exponent is labelled
rather than guessed; a `NULL` `amount_minor` falls back to the stored
decimal string verbatim.

The limit is upstream of the formatter, and worth stating precisely.
`bun:sqlite` returns an INTEGER column as a JS number, so an `amount_minor`
beyond 2^53 would already be lossy before formatting reached it.
`formatAmount` also accepts a `bigint` and is exact for one, but nothing
on the read path supplies one today. The claim to make is that formatting
introduces no error, not that the read path is exact at any magnitude. No
fiat figure this system will meet is near that bound.

### No monetary total, anywhere

Nothing is summed across rows and nothing is converted between
currencies. A JPY figure and a USD figure sit side by side, each labelled
with the currency the provider stated. Row counts are the only aggregate
the browser computes at all: `COUNT(*)` per table on the overview, and
per-kind observation counts per artifact on the artifact index. Counting
rows is not a claim about money.

### The kind in a URL selects a table through a closed map

The observation kind in `/observations/<kind>/<id>` is the only place a
table name is chosen from request input, and it is mapped through a closed
whitelist of four literal names; an unknown kind is a 404. Ids are
accepted only as digits and only as safe integers. The request text itself
never reaches SQL.

### The local server is loopback-only

`bun run ui` binds `hostname: "127.0.0.1"` (port 8787 unless `PORT` says
otherwise). It has no authentication of any kind, and the exit criteria
below ask for real captures to be read through it, so binding all
interfaces would put real financial data on whatever network the machine
is attached to. Loopback is the whole of the local protection: it must
never be run behind a port forward or on a shared interface, and it is not
a substitute for the access control a deployed instance needs.

## Deployment shape

The local Bun server is a stand-in. The deployed shape is a Worker with a
D1 binding and an R2 binding, serving the same routes. Moving it is real
work, and the work is worth counting rather than describing as a store
swap:

- What carries over: the SQL, the routing, and the HTML rendering, which
  has no runtime dependency at all. The SQL is written to stay valid on D1
  and has not been run there (`RESULTS.md`).
- What does not: the handler is synchronous. `createUiHandler` returns
  `(request: Request) => Response`, and every render function queries
  `bun:sqlite` synchronously. D1 and R2 are Promise-based, so the handler
  and each render function become `async` and every query site becomes
  awaited. `readRawObject` reads the filesystem synchronously and becomes
  an R2 `get`. `openStore()` does not move at all: it reads `schema.sql`
  from disk and executes DDL, and a Worker has no filesystem.

This surface renders real financial data in plain text. It must never be
publicly reachable. Cloudflare Access in front of the Worker is a better
fit than the ingestion API's bearer token, because a bearer token cannot
be typed into a browser and ends up in a URL or an extension if you try.
Whichever is chosen, the requirement is the same: no unauthenticated path,
and no route excluded from the check.

## What it deliberately does not do

Each of these belongs to a later phase, and each would be a phase-boundary
violation here:

- No editing, correcting, or annotating anything. Layer A and layer B rows
  are append-only; corrections live in layer C, which does not exist yet.
- No classification or categorization (phase 16, and always as a recorded
  interpretation).
- No reconciliation, no pending-to-posted matching, no duplicate detection
  (phase 6, via `observation_links`).
- No net worth, no totals, no aggregation across accounts or currencies
  (phases 11 to 13).
- No charts. A chart is a claim about a trend, and every claim here should
  be a row someone can trace.
- No cross-source identity. `source_account` is shown as the provider
  wrote it, under its own source. Canonical accounts are phase 4.

## Exit criteria

The browser has done its job for phases 2 and 3 when:

- Every parser shipped in phase 3 has had its output read against the raw
  bytes for at least one real artifact per dataset, and the discrepancies
  found that way are either fixed or recorded. A reward parser would need
  the reward table and the browser's four-kind enumeration extended first,
  so until then this criterion covers the four kinds that exist.
- A version bump has been performed on a real parser and the old and new
  parse runs compared on the artifact page — that is, "re-parse
  everything" has been exercised, not merely implemented.
- The provenance walk resolves to servable bytes for every observation
  kind the browser covers.
- It is deployed behind access control, or not deployed at all.

It is expected to be rewritten or deleted when layer C arrives. Nothing
should ever depend on it.

## Open questions

- Access control for a deployed instance: Cloudflare Access or the
  ingestion bearer token, and whether the two surfaces should share a
  boundary at all. Undecided.
- Whether a genuinely read-only D1 binding is available, and whether the
  local entrypoint should open its own connection read-only instead of
  calling `openStore()`. Either would make read-only a property of the
  process rather than only of the handler.
- Pagination and filtering. Every page lists everything, and no query in
  `src/ui.ts` carries a `LIMIT`. The demo store is 28 observations and a
  real store is not: both live collectors run daily on a Cloudflare Cron
  trigger (`poc/sbi-securities-worker`, `poc/vpass-json`), and the SBI
  collector's README records an initial backfill over 2024-08-28 to
  2026-05-29 in windows of at most 90 days. The transaction list and the
  balance history will need a bound and a source/account/date filter.
  Neither is implemented.
- Whether a deployed instance should serve raw bytes through the Worker at
  all, or hand out a short-lived R2 URL instead. Serving through the
  Worker means the Worker streams financial documents; handing out a URL
  moves the inert-response problem to R2's own response headers.
- Whether the HTML pages should carry a restrictive
  `Content-Security-Policy` of their own. They have no client-side
  JavaScript and escape all provider text, so it would be defence in depth
  against a future escaping mistake rather than a fix for a known hole.
  `/raw` already carries `sandbox`.
- Character encoding on the raw route. Bytes are served with the stored
  content type, so a Shift-JIS CSV stored as `text/csv` with no charset
  renders as mojibake. Whether the charset belongs in the stored content
  type is a layer-A schema question, not a browser question; `RESULTS.md`
  raises the same gap from the parser side.
- Comparing two parse runs mechanically, as a real diff, rather than by
  eye. Worth doing only if re-parses become frequent.
- No redaction of any kind. That is acceptable for a single-operator tool
  on loopback or behind access control, and would have to be revisited
  before anyone else ever saw a page.

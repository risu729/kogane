# Evidence browser

A read-only web view over layers A and B — raw evidence and observations,
nothing above them. Its purpose is narrow: let a human check what a parser
produced against the exact bytes it produced them from, and walk the
provenance chain in both directions.

It is implemented in the observation-pipeline proof of concept
(`poc/observation-pipeline`): a read-only JSON API in `src/api.ts` over the
queries in `src/queries.ts`, and a React client in `web/` that renders it,
served together by `bun run serve`. This document records what it is for,
the rules that keep it small, what the code enforces today, and what is
still open.

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
2. The request handler writes nothing. No query in `src/queries.ts` is an
   `INSERT`, `UPDATE` or `DELETE`, and any method other than `GET` or
   `HEAD` is refused with 405 before routing. What that does and does not
   cover is stated exactly under "Read-only, precisely" below.
3. It stores nothing. Every "current" or "latest" view is computed by SQL
   on the request that asks for it. No cache, no materialized view, no
   snapshot table.
4. Deleting it loses no data. If `src/api.ts`, `src/queries.ts`,
   `src/serve.ts` and `web/` were removed, the pipeline, the store, and
   every observation would be unchanged. Only `src/money.ts` would have to
   stay, because the parsers import it too. That is the test of whether it
   has stayed a tool.
5. It records no interpretation. Identity, links, classification, and
   every derived figure remain out of scope exactly as `docs/roadmap.md`
   says. The positions page does pair valuations with positions in order
   to lay the page out; that pairing is named below, is made at display
   time, and is never stored.

## The read model

The pages below are implemented and covered by the 25 tests in
`test/api.test.ts` and the 5 real-browser tests in `test/browser.test.ts`,
of the PoC's 73 passing tests. Against the demo store that `bun run demo`
builds — 2 sources, 4 artifacts, 4 parse runs, 28 observations — they
render the whole dataset.

Every page reads exactly one endpoint and holds nothing that response did
not carry. The endpoints mirror the page URLs under `/api`, with `/`
reading `/api/overview`.

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

The table sorts and filters in the browser, over the rows the endpoint
already returned. Neither is a query, so neither can change which
observations count as current — and neither bounds the response, which is
a separate gap, recorded under the open questions.

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
carries. `positionsWithValuations` in `src/queries.ts` buckets valuation
observations by `(source_id, source_account, subject)` and looks each
position up under `(source_id, source_account, security_code)` — an exact
string match between two observation kinds' provider labels, made on the
request that renders the page. It is defensible: it stays inside one
source, matches on the provider's own identifiers, stores nothing, and
every row it shows stays individually linked to its own observation page.
It is still a decision the data does not carry. The page says so in place,
and when a position has no match it says that too ("No provider-reported
valuation observation matches this position"), which is an assertion about
the match rule, not about the provider.

The client groups the figures it is given by the currency the provider
stated, and says on the page that two currencies are two claims rather
than two views of one number. That is layout arguing for the rule below
that nothing is ever summed; it is not a second interpretive act.

Nothing about the pairing is stored and no link is recorded, so
`docs/roadmap.md`'s summary — that the browser interprets nothing and
stores nothing — holds of the data. It is the page layout that makes the
claim, and it lasts exactly as long as the response.

Phase 6 is where this belongs permanently: `observation_links` with
relation, method, and confidence (`docs/design.md`, `docs/roadmap.md`),
not a match made while a page is being assembled.

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

### Raw bytes — `/api/raw/<sha256>`

The stored bytes, verbatim, with the digest echoed in an `x-kogane-sha256`
header. The path is validated as a 64-hex digest before anything is read,
and the response is deliberately inert — see "Raw evidence is served
inert" below. Answers the only question that ultimately matters: what did
the source actually send.

It is the one route the client links to rather than reads. Nothing fetches
these bytes into the page, because the protection below only holds for a
document the browser itself navigated to.

### Four of phase 3's five observation tables

`docs/roadmap.md` phase 3 lists five observation tables:
`transaction_observations`, `balance_observations`,
`position_observations`, `valuation_observations`, and
`reward_observations`. The PoC's `schema.sql` defines the first four, and
the browser covers those four: the kind whitelist, the counted tables, the
per-artifact counts, and the parse-run normalizer in `src/queries.ts` each
enumerate them by name, and the client enumerates them again in
`web/src/router.tsx` and in the response types it restates in
`web/src/api.ts`.

Rewards are therefore not one missing page. Adding the table means
touching the whitelist, the count list, the artifact index, the
normalizer, the client's own kind list, and adding a page — the first
concrete instance of the cost stated at the top of this document, that
this is code which produces no data and which every schema change breaks.
Splitting the browser into an API and a client made that list longer, not
shorter. It is a reason to keep the browser small, not a reason to leave
the gap unstated; the exit criteria below are written with it in mind.

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

## How it is built

The browser is a read-only JSON API and a client that renders it, not a
server that renders HTML. It was the other thing until recently: one
1,164-line module that ran the SQL, formatted the amounts, and
concatenated the markup inside the same functions.

The reason for the change is the section above. The provenance walk and
the artifact page are the two screens that justify this tool existing, and
both are trees of heterogeneous records — an artifact holding every parse
run over it, each holding observations of four different shapes; an
observation holding a chain of four further records that share almost no
columns. As
string concatenation each of those was a function that had to know the
shape of the data and the shape of the markup at once. As components each
shape is named once and reused wherever it appears. The flat tables were
fine either way; the trees were not.

The pieces:

- `src/queries.ts` — every read query. The "current" predicate,
  `p.superseded_by_parse_run_id IS NULL AND p.status = 'ok'`, is a single
  constant applied by each current-state view rather than a phrase
  repeated per route. The SQL was carried over verbatim from the module it
  replaced, including the source-qualified keys described below.
- `src/money.ts` — the minor-unit table, `formatAmount` and `amountSign`.
  It imports no runtime API, so the same module runs on Bun, on Workers,
  and in the browser. `src/parsers/util.ts` re-exports `minorUnitExponent`
  from it, and `web/src/money.ts` is a ten-line re-export that keeps
  "nothing in the client formats an amount itself" enforceable by grep.
- `src/api.ts` — a Hono app. Every route it defines is a GET, and any
  method other than GET or HEAD is refused before routing.
- `src/serve.ts` — the Bun entry point: binds loopback only, serves the
  built client, and falls back to `index.html` so that client routes
  deep-link.
- `web/` — a React client built by Vite: a hand-written pushState router
  (`web/src/router.tsx`, so there is no routing dependency), a typed fetch
  layer (`web/src/api.ts`), shared presentational components
  (`web/src/ui.tsx`), one page per route under `web/src/pages/`, and one
  plain stylesheet whose colours are custom properties, with light and
  dark through `prefers-color-scheme`.

Hono is the choice because the same app object runs on Bun now and on
Cloudflare Workers later, which is where the rest of Kogane already lives
(`poc/sbi-securities-worker`, `poc/vpass-json`). Only the store binding
and the way static files are served differ between the two, which is what
makes the deployment shape below a bounded piece of work rather than a
rewrite.

Dependencies are counted rather than assumed: Hono, React, TanStack Query
for fetching, TanStack Table for the sortable transaction list, with Vite
and Playwright as dev dependencies. There is no component library, no CSS
framework, no icon pack, and no chart library. The last of those is a rule
below, and keeping it out of `package.json` is what makes adding one a
decision someone has to defend rather than an import.

What the split buys: the queries are testable without rendering anything —
`test/api.test.ts` drives them through the app object, with no browser
involved — and one money module means the parser that writes an amount and
the page that displays it cannot drift apart about what a minor unit is.

What it costs: the client restates every response shape in `web/src/api.ts`
rather than importing it, because `src/queries.ts` reaches `bun:sqlite`
through `src/store.ts` and that has no business in a browser bundle. A
column added to an observation table now lands in `src/queries.ts`, in
that file, and in whichever page reads it. That is the cost stated at the
top of this document — code that produces no data, which every schema
change breaks — made slightly larger.

## What the code enforces

The following is implemented in `src/queries.ts`, `src/api.ts` and the
client under `web/`, rather than left to care. Most of it is asserted in
`test/api.test.ts` or in `test/browser.test.ts`, which drives a real
Chromium. Two of the rules below carried over into the code but lost their
tests in the rebuild, and each says so in place.

### Read-only, precisely

Two different claims get made under this word, and only the narrower one
is true today.

What holds: the request handler writes nothing. No query in
`src/queries.ts` is an `INSERT`, `UPDATE` or `DELETE`, and the first
middleware in `src/api.ts` refuses any method other than `GET` or `HEAD`
with 405 before any route runs, so a write could not reach a handler even
if one were added carelessly later. `test/api.test.ts` asserts that for
POST, PUT, PATCH and DELETE.

What does not: the process is not read-only. The entrypoint calls the same
`openStore()` as the ingesting and parsing tools, and `openStore()`
(`src/store.ts`) creates the state directory, opens the database with
`create: true`, and executes `schema.sql`. Pointed at a directory with no
store in it, `bun run serve` creates an empty one rather than failing.

So the accurate statement is that the handler cannot write, not that the
process cannot. Opening the connection read-only in `src/serve.ts` would
close the gap locally, and a read-only D1 binding would close it in
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
`test/browser.test.ts` asserts both halves end to end: it supersedes a
parse run, then checks in a real browser that the retired row is absent
from the transaction list and present, and marked, on the artifact page.

### The source is part of every key

`source_account` is only the provider's own label and carries no
institution identity: two sources can both call an account "main", and
numeric TSE security codes are shared across every Japanese broker. The
balance partition key, the position ordering, and the valuation bucket key
in `src/queries.ts` therefore all include `fetch_artifacts.source_id`, and
the transaction and position views show the source as a column.

Nothing asserts that today. `test/ui.test.ts` built a two-institution
store whose labels collide and asserted that neither institution's balance
hid the other's and that neither's valuation attached to the other's
position; the SQL survived the rebuild verbatim, the test did not, and no
replacement was written. The invariant is in the code and out of the
suite, which is the weakest place for an invariant to be, and restoring
the test against the API is the cheapest fix available.

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
split the response or throw out of the handler. `test/ui.test.ts` stored a
content type containing CRLF and asserted that neither an injected header
nor a 500 resulted; as with the collision test above, the check survived
the rebuild in `src/api.ts` and the test did not.

`test/api.test.ts` does assert the rest of this rule: that the bytes come
back byte for byte, hashing to the digest in the URL, and that they carry
`sandbox`, `nosniff` and `inline`.

### Provider text reaches the page as text

Descriptions, counterparty names, security names, and `extra_json` were
written by an institution, not by us. React escapes every string it
interpolates, and `dangerouslySetInnerHTML` appears nowhere in `web/` —
that pair is the whole of the argument, which is why it is worth keeping
greppable. `test/browser.test.ts` plants a description containing
`<script>window.__xss = true</script>`, loads the transaction list in a
real Chromium, and asserts both that the global was never set and that the
text is on the page verbatim.

An earlier version of this document made a stronger claim: that the
rendered pages carried no client-side JavaScript, so there was nothing on
them that could act on injected text at all. That claim is no longer true
and the argument that rested on it has to go with it. There is a
JavaScript bundle now, it holds the current view's response in memory, and
an escaping mistake would have a richer environment to act in than it
would have had before. What replaces it is narrower: the bundle is our own
code, built from `web/` at build time, and provider bytes reach it only as
JSON data that is only ever rendered as text.

The provider's bytes themselves are covered by the rule above rather than
by this one, and that rule is unaffected by any of this:
`/api/raw/<sha256>` serves captured evidence under
`Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`,
so an HTML artifact cannot execute in this origin however it was authored.
The client links to that route and never fetches it.

### Money is formatted without float arithmetic

`formatAmount` lives in `src/money.ts` and is imported by the parsers, the
API and the client alike. It widens minor units with `BigInt` and formats
by string manipulation. A value that is not an integer is printed as
stored rather than rounded; an instrument with no known minor-unit
exponent is labelled rather than guessed; a `NULL` `amount_minor` falls
back to the stored decimal string verbatim. `Intl.NumberFormat` is used
nowhere, because it takes a Number: the convenient call is the lossy one.

The limit is upstream of the formatter, and worth stating precisely.
`bun:sqlite` returns an INTEGER column as a JS number, so an `amount_minor`
beyond 2^53 would already be lossy before formatting reached it, and the
JSON response carries whatever that read produced. `formatAmount` also
accepts a string or a `bigint` and is exact for both — `test/api.test.ts`
asserts `9007199254740993` through each — but nothing on the read path
supplies either today. The claim to make is that formatting introduces no
error, not that the read path is exact at any magnitude. No fiat figure
this system will meet is near that bound.

### No monetary total, anywhere

Nothing is summed across rows and nothing is converted between
currencies. A JPY figure and a USD figure sit side by side, each labelled
with the currency the provider stated. Row counts are the only aggregate
the browser computes at all: `COUNT(*)` per table on the overview, and
per-kind observation counts per artifact on the artifact index. Counting
rows is not a claim about money. The client adds nothing to that — it
counts rows it was handed, and no component multiplies, divides or sums an
amount.

### The kind in a URL selects a table through a closed map

The observation kind in `/api/observations/<kind>/<id>` is the only place
a table name is chosen from request input, and it is mapped through
`OBSERVATION_TABLES` in `src/queries.ts`, a closed whitelist of four
literal names; an unknown kind is a 404. Ids are accepted only as digits
and only as safe integers, and `test/api.test.ts` asserts that `1e3`,
`0x10`, `1.5`, `-1`, `%201` and `abc` are each refused rather than
coerced. The request text itself never reaches SQL. The client applies the
same two rules in `web/src/router.tsx` before it asks, but that is a
convenience: the API validates independently of anything the client did.

### The local server is loopback-only

`bun run serve` binds `hostname: "127.0.0.1"` (port 8787 unless `PORT`
says otherwise). It has no authentication of any kind, and the exit
criteria below ask for real captures to be read through it, so binding all
interfaces would put real financial data on whatever network the machine
is attached to. Loopback is the whole of the local protection: it must
never be run behind a port forward or on a shared interface, and it is not
a substitute for the access control a deployed instance needs.

`bun run dev` is a second surface with the same store behind it: Vite
serves the client on port 5173 and proxies `/api` to the same server.
Vite binds localhost unless it is passed `--host`, so the default is
right; passing `--host` would expose the whole dataset on the network and
must not be done.

## Deployment shape

The local Bun server is a stand-in. The deployed shape is a Worker with a
D1 binding and an R2 binding, serving the same routes, with the built
client as static assets. Moving it is real work, and the work is worth
counting rather than describing as a store swap:

- What carries over: the Hono app object itself, which is the reason Hono
  is there; the routing; the SQL; and the whole client, which only ever
  talks to `/api` and does not know what is behind it. The SQL is written
  to stay valid on D1 and has not been run there (`RESULTS.md`).
- What does not: the query layer is synchronous. Every function in
  `src/queries.ts` calls `bun:sqlite` synchronously and returns rows, not
  promises. D1 and R2 are Promise-based, so each of those functions
  becomes `async` and each of its call sites in `src/api.ts` becomes
  awaited. `readRawObject` reads the filesystem synchronously and becomes
  an R2 `get`. `src/serve.ts` does not move at all: static assets are
  configuration on a Worker, not code. Neither does `openStore()` — it
  reads `schema.sql` from disk and executes DDL, and a Worker has no
  filesystem.

This surface renders real financial data, and its API hands the same data
as JSON to anything that can reach it. It must never be publicly
reachable. Cloudflare Access in front of the Worker is a better fit than
the ingestion API's bearer token, because a bearer token cannot be typed
into a browser and ends up in a URL or an extension if you try. Whichever
is chosen, the requirement is the same: no unauthenticated path, and no
route excluded from the check.

### A trap worth knowing before the client is deployed

Workers static assets with `not_found_handling: "single-page-application"`
is the natural configuration for this client, and it has one documented
behaviour that would break the most important route here.

With a Worker script, `assets.not_found_handling` configured, and a
compatibility date of 2025-04-01 or later (which selects
`assets_navigation_prefers_asset_serving`), a *navigation request* — one
carrying the `Sec-Fetch-Mode: navigate` header, which browsers attach when
a URL is typed or followed into the address bar — does not invoke the
Worker at all. It is answered from the asset store, which under
`single-page-application` means `index.html` with a 200. Cloudflare
documents the consequence in as many words: `fetch("/api/date")` from the
client reaches the Worker and returns the API response, while navigating
to `/api/date` in the browser returns the HTML file.

Here that route is `/api/raw/<sha256>`, and pasting one into the address
bar is exactly what an operator does with it. Under the default
configuration they would be served the client shell with a 200 instead of
the evidence — a failure that looks like a working page rather than like
an error, which is the worst shape a failure can take in this particular
tool.

The fix is to route the API paths to the Worker explicitly, which also
opts those paths out of the `Sec-Fetch-Mode` heuristic:

```jsonc
{
  "main": "./src/worker.ts",
  "assets": {
    "directory": "./web/dist/",
    "not_found_handling": "single-page-application",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*"]
  }
}
```

An array of route patterns for `run_worker_first` needs Wrangler 4.20.0 or
later. This is untested here, because nothing is deployed yet; it is
recorded now because it is cheap to read and expensive to debug.

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
  be a row someone can trace. No charting library is a dependency either,
  so drawing one would mean adding a package rather than calling something
  already installed.
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
- Pagination and filtering. Every endpoint returns everything, and no
  query in `src/queries.ts` carries a `LIMIT`. The demo store is 28
  observations and a real store is not: both live collectors run daily on
  a Cloudflare Cron trigger (`poc/sbi-securities-worker`,
  `poc/vpass-json`), and the SBI collector's README records an initial
  backfill over 2024-08-28 to 2026-05-29 in windows of at most 90 days.
  The transaction list sorts and filters in the browser now, which helps a
  reader and bounds nothing: the whole result set is still serialized,
  sent, and held in memory. The bound belongs in SQL, with a
  source/account/date filter beside it. Neither is implemented.
- Whether a deployed instance should serve raw bytes through the Worker at
  all, or hand out a short-lived R2 URL instead. Serving through the
  Worker means the Worker streams financial documents; handing out a URL
  moves the inert-response problem to R2's own response headers.
- Whether the client should be served under a restrictive
  `Content-Security-Policy` of its own. It would have to admit the bundle
  and the stylesheet, so it is narrower than it once would have been, and
  it remains defence in depth against a future mistake rather than a fix
  for a known hole. It is worth more than it was: the pages now execute
  script, where before they did not. `/api/raw/<sha256>` already carries
  `sandbox`.
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

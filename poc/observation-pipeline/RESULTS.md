# Results

Recorded 2026-08-28. No captured financial data, credentials, cookies,
account identifiers, or balances were persisted or committed; every fixture
is synthetic.

The PoC ingests 4 synthetic artifacts from 2 sources into 28 observations
(8 transaction, 10 balance, 2 position, 8 valuation) across 4 parse runs.
`bun test` is 80 pass across 4 files, `tsc --noEmit` is clean.

## What it settled

**The roadmap's phase-2 table sketch survives contact with real collector
output, with two additions.** `sources` / `fetch_runs` / `raw_objects` /
`fetch_artifacts` map onto what `poc/sbi-securities-worker` already writes
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
then a two-condition join, which the browser uses on every page. Nothing
about the append-only rule had to be relaxed.

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

The general lesson: every one of these failed *silently* and in the
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

**It cost a build step and a layer of restatement.** `bun run serve`
renders nothing until `bun run build` has run, though the dev server builds
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

These need real payloads, and none is resolved by assertion here.

**Are SBI's `evaluationAmount` fields really JPY?** The foreign-positions
parser assumes the unprefixed fields are JPY and the `frn*` variants are in
`currencyCode`. This is inferred from field naming, not observed. If it is
wrong, bumping the parser version and re-parsing corrects every historical
observation — which is precisely the operation this PoC exists to prove, so
the assumption is cheap to hold and cheap to withdraw.

**What do the Vpass `meisaiList` rows mean?** `poc/vpass-json` deliberately
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

## Not done

No collector, no authentication, no network access of any kind. No D1, R2,
or Worker deployment: `bun:sqlite` and the filesystem stand in, and the SQL
is written to stay valid on D1 but has not been run there. No ingestion API
and no importer CLI — `ingest.ts` is a library that a CLI would wrap. No
migrations; a schema change is handled by deleting the state directory and
re-ingesting, which is only acceptable because everything above the raw
layer is re-derivable.

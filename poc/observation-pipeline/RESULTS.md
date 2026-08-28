# Results

Recorded 2026-08-28. No captured financial data, credentials, cookies,
account identifiers, or balances were persisted or committed; every fixture
is synthetic.

The PoC ingests 4 synthetic artifacts from 2 sources into 28 observations
(8 transaction, 10 balance, 2 position, 8 valuation) across 4 parse runs.
`bun test` is 58 pass, `tsc --noEmit` is clean.

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

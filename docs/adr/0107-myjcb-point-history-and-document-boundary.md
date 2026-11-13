# ADR 0107: MyJCB acquisition-month points and statement document boundary

- Status: proposed
- Date: 2026-11-10

## Context

Issue #1251 asks for J-POINT history, every expiry bucket and retained statement
files. Read-only observation found three server-rendered history tables that
repeat the same acquisition rows. The overview reports monthly earned, used
and expired quantities beside acquisition-bucket remaining quantities. The
provider explicitly says use is reported in the month of use but deducted
from the oldest expiry buckets. A row's earned/used/expired arithmetic therefore
does not reconstruct its remaining quantity.

Finalised statements offered CSV, PDF and OFX links; an unconfirmed statement
offered none. The browser blocked the download before an HTTP response. File
bytes, media types and schemas have not been verified. Schedule positions in
the credit menu remain separate from actual statement months.

## Options considered

1. Treat each tab as separate transactions and derive remaining points by
   subtracting monthly activity. This duplicates rows and contradicts the UI.
2. Collect the rendered container once, cross-check the three representations
   and the existing total, and publish separate period measures and stocks.
3. Fetch export endpoints using assumed file contracts. The observation does
   not support this.

## Decision

Choose option 2 and retain the explicit document blocker of option 3.

### Acquisition and normalization

The existing J-POINT total parser and nearest-expiry metadata stay frozen.
The collector reuses that run's already fetched total response, follows the
observed point-inquiry/history GET routes and keeps sanitized HTML beside a
normalized JSON artifact. It makes no extra total POST, request window,
pagination guess or root-card switch.

The raw history has three `.tab-panel > .js-scrollable-tbl > table` elements,
each with THEAD/TBODY. Scroll-head/body wrappers and toggle buttons are inserted
by JavaScript and are not raw response contracts. Exact headers, complete
document/section/table structure, unique acquisition dates, matching row
membership, earned totals, their observed three-component exact sum and remaining quantities are checked across the
three tabs. The exact sum of overview remaining quantities must equal the
same run's existing total. Detail components are retained without publishing
them again. There is no fixed observed row-count assumption.

Normalization validates the original response before the sanitizer can repair
its DOM, then verifies that the sanitized evidence yields identical measures.
Unknown layouts, unreadable quantities, unsupported statuses, mismatched
tabs/totals and positive buckets without an expiry month leave the independent
history unit unavailable. They never become zero or an empty snapshot.

### Measures and time

`myjcb-jpoint-history` publishes four exact, non-additive J_POINT measures for
each acquisition date: monthly earned/used/expired period totals and the
remaining acquisition-bucket stock. Provider signs are preserved. The date
identifies the acquisition bucket; payment M/D text is retained separately
without inventing a year or a transaction/usage date. Capture time is
`observedAt`; acquisition dates never become the stock's `asOf`.

A provider YYYY/MM expiry is a month-granularity period, not a month-end day.
An explicitly zero remaining bucket may have unknown expiry. Only observed
row statuses are admitted; other UI-documented statuses remain a closed
unobserved-row boundary until verified.

The acquisition references map to the existing connection's J-POINT holding.
Monthly activity measures are summaries, not independently spendable buckets.
Only remaining-stock measures have an additive reward-bucket promotion rule;
no reward quantity joins a monetary asset subtotal.

### Current holding and gaps

Complete history and its reported total must belong to the same capture as
the newest published total revision. History is promoted only for that
validated cohort. The reward reader selects the acquisition set only after
all its buckets have been promoted; otherwise it selects the current total.
It never selects both. A complete newer set removes absent old buckets.

A newer total with missing/failed history does not make an older bucket sum
current. The reader prefers the current total and reports a stale/unavailable
history gap, preserving the previous history capture time and a source-fact
reference. Older observations and claims remain append-only dated evidence.

Registration v10 maps only the new normalized history artifact, preserving
the actual v1–v9 derivations. Migration 0094 installs coverage-based history snapshots under the independent
reward unit. Unavailable/empty pages cannot clear prior evidence. The local
observation store mirrors this policy idempotently.

History failure remains an explicit failed unit, which makes the parent run
partial. Leaving the existing credit datasets run-scoped would consequently
hide successful statements, including another connection's successful walk.
Migration 0094 therefore also opts exactly `credit-ledger`, `credit-detail`,
`credit-past-months` and `credit-schedule` into eligibility for a successful
connection unit. The collector proves that unit only after its offered
statement walk finishes without unread months or a stop. A partial, failed or
malformed connection remains ineligible even when it retained earlier valid
pages; an unrelated dataset receives no new permission. Discovery stays
evidence-only on a partial parent. The opt-in only admits the existing strict
parsers: a malformed schedule or statement still fails its own parser, and
no new completeness is inferred.

These four rows are eligibility-only (`snapshot_selection=0`): existing
statement/transaction membership, empty semantics, parser bytes and versions
are unchanged. Both production and local readers use the same existing unit
predicate. The local mirror seeds each missing row after policy-table creation
and preserves operator overrides when repairing a partially present policy
set. Hiding the failed history unit or allowing every partial run would remove
the failure evidence or admit incomplete statements, so neither is used.

The unchanged credit collection functions live in `credit.ts`, beside the
existing separate `debit.ts`, so the production Worker test can call the real
read collector without importing browser authentication into its type boundary.
`collector.ts` preserves its public exports and authentication orchestration;
the extraction changes no request, parsing or stop-code behavior.

The reward promotion/read release remains unchanged: the added rule admits a
new parser/metric family and reinterprets no existing claimed quantity.

### Candidate query plan verification

The promotion query keeps the existing outer balance scan and indexed
publication/claim/unit probes. Its new history and total window results are
derived relations, not additional full scans of persistent balance tables.
SQLite builds exactly two temporary partial covering indexes: history by
`(parse_run_id, history_rank)` and totals by
`(total_rank, reported_total, fetch_run_id, holding_account)`. The candidate
join probes those results instead of repeating the history input per candidate.
The plan test checks their coroutine/materialization ancestry, their exact
index keys and the persistent artifact/parse/publication/balance indexes.
It permits no other automatic index or persistent scan beyond the existing
outer balance scan and the explicitly counted small policy scans. The prior
frozen query and its original scan expectation remain unchanged.

Read-only diagnostics on full synthetic CORE stores, without `ANALYZE`, used
Bun's SQLite 3.53.4 `sqlite3_stmt_status(SQLITE_STMTSTATUS_VM_STEP)` on the
original SQL. Five captures for one connection (65 facts) took 7,719 VM steps;
ten for one (130 facts), 14,754; ten for four (520 facts), 58,371; twenty for
eight (2,080 facts), 229,087. This is near-linear growth for these measured
sizes, not a universal bound for every future engine or workload. The native
diagnostic extension stayed outside the repository; CI adds no native build
dependency. Deterministic identity probes in the test also bound evaluated
history facts and rank inputs by the number of seeded captures, with exact
result equality against the unmodified query. Scaled and randomized real
parser histories cover complete/partial/failed/mismatched captures, bounded
drains and unchanged frozen legacy candidates. This justifies the derived
plan expectations without changing production SQL for plan cosmetics.

### Statement files (original 2026-11-10 boundary)

The scheduled credit walk still reads every provider-offered statement
position, including sparse past-JSON positions, without generating missing
months. The existing h2 month / h3 schedule distinction is unchanged.
Finalised markers and the actual same-month statement hrefs determine offers;
a different PDF-labelled newsletter does not qualify.

At this original boundary, files remained unfetched. The sanitized manifest records the closed
`documentCode: statement_export_bytes_unverified` beside offered kinds.
Statement HTML and its observed export offers are retained. An unavailable
file response has not been observed; the file gap is recorded without
asserting a document acquisition unit. This is uncollected document coverage, not
proof that PDF/CSV bytes were archived. Root-card switching and unobserved
accounts remain outside this change.

## Consequences

Reward activity becomes available for the observed J-POINT product. Expiry
coverage remains partial for unobserved row statuses; document coverage remains
not collected until the offered file responses can be observed and validated. #1251
remains open for those acceptance gaps and production validation. Existing statement HTML is catalogued under
`card_statement`; offered links alone do not promote the `document` type.

Only sanitized provider evidence and financial observations carry quantities,
dates and provider text. Operational records contain counts and closed codes.
There are no new credentials, grants, authentication operations or production
replays in this change.

## Verification

Synthetic tests distinguish raw HTML from generated wrappers, validate three
tabs without triple publication, preserve monthly activity that does not
reconcile per row to remaining stock, and reject unknown/truncated shapes.
Collector tests verify the two observed GETs, total-response reuse, independent
unit failures, sparse statement walks and the unfetched document blocker.

The actual reward reader is tested for matched capture selection, newer-total
gaps, shrinking sets and partial promotion. A frozen prior SQL read is compared
on seeded scaled captures, and query plans are checked without statistics.
The collector-plan/registration/parser/promotion/reader path is checked with
synthetic evidence before the PR is ready. No live publication is claimed.

## Amendment 2026-11-12: retain observed original credit files

The source observation now witnesses normal-browser CSV/PDF/OFX downloads on
two credit displays, and exact linked-credit GET requests, attachment headers
and byte envelopes. It supersedes this ADR's earlier unverified-file boundary
for those credit formats. Debit export bytes and durable card switching remain
unverified. No credentials, auth changes or live collector run are introduced.

Production explicitly selects the file-fetch mode after the existing menu and
statement walk. Only exact same-month observed statement hrefs authorize reads:
`detailMonth` plus `output=csv|pdf|money` on the established allowlisted paths,
with no duplicate or additional query fields. Missing-month historical links,
newsletters, cross-origin links and conflicting selectors authorize no request.
Confirmed readable pages supply payment-month provenance; positional selectors
never become calendar identity. Every currently offered position is walked,
including sparse past-JSON positions, without a window or continuation cursor.

The read client requires the observed attachment/media headers, refuses
redirects and retries, and bounds each export to 30 seconds and 8 MiB while
streaming. One request-scoped 32 MiB export budget is shared across all
configured connections. The remaining allowance caps each response stream
before decoding; retained validated originals consume it. Failed files retain
no bytes and release their temporary allowance. Once exhausted, later file
requests are skipped with the closed `budget_exhausted` result, while later
financial pages still run. This is an operational memory guard, not a provider
retention limit. A full offered archive remains conditional on fitting it. Shared validation checks the observed CP932/CRLF CSV header anywhere
after its unclassified preamble, PDF 1.4 signature and EOF, and UTF-8 OFX 1.02
SGML envelope. These checks establish file envelopes only. They neither prove
file financial contents nor extract dates, amounts, rows or account identity.
The collector retains original bytes without redaction or transcoding in the
private evidence bucket; original provider filenames and response/session
headers are not stored. Existing content addressing writes a repeated hash once
and retains changed-byte revisions. Stable artifact keys are
`<connection>/credit-document-YYYY-MM.<kind>`; the period is the page's validated
provenance. Conflicting same-byte manifest period metadata remains refused by
the existing metadata extractor, without choosing a witness.

Each file has its own `connection:document:credit:YYYY-MM:kind` unit. A malformed
file cannot discard its valid financial page/ledger, healthy sibling or later
month. Its closed result is unavailable and the parent is partial. A session-wide
401/403/429 or redirect stops further provider reads and preserves the valid
current financial artifacts, without asserting complete history. Unknown export
offer shapes have a separate failed discovery unit. Manifests contain only
closed results and page-period provenance, never provider error text.

Registration v12 adds exactly the three credit export datasets while v1–v11
remain reproducible. `myjcb-statement-document-metadata@1.0.1` revalidates file
bytes and exact page-period/artifact/unit metadata, publishing zero financial
observations and one evidence-only coverage claim. Migration 0101 opts only
these datasets into per-file success eligibility (`snapshot_selection=0`,
no empty replacement). Successful files can therefore parse on a partial
parent without changing monetary snapshot selection. The local store seeds
missing policy rows individually and preserves operator alternatives.

The document catalogue becomes partial. Retention is whatever the provider
actually offered, not a promise that all fifteen calendar months or debit files
were obtained. Unobserved debit formats, J-POINT row statuses, full production
archival and live reader validation keep issue 1251 open. Deployment is outside
this change.

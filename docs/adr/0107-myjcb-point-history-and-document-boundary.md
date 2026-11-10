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

The reward promotion/read release remains unchanged: the added rule admits a
new parser/metric family and reinterprets no existing claimed quantity.

### Statement files

The scheduled credit walk still reads every provider-offered statement
position, including sparse past-JSON positions, without generating missing
months. The existing h2 month / h3 schedule distinction is unchanged.
Finalised markers and the actual same-month statement hrefs determine offers;
a different PDF-labelled newsletter does not qualify.

Files remain unfetched. The sanitized manifest records the closed
`documentCode: statement_export_bytes_unverified` beside offered kinds.
Statement HTML and its observed export offers are retained. An unavailable
document unit would downgrade the statement run and block its frozen readers,
so the file gap is reported without introducing such a unit. This is uncollected document coverage, not
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

# Observation layer

Phase 3 of `docs/roadmap.md` turns raw evidence into typed observations.
This document is the implementable version of that phase: what a parser
owes the system, how versioning and supersession work, which tables the
observations land in, and how a re-parse is run and verified.

The reference implementation is `poc/observation-pipeline`. It contains
ingestion of already-collected evidence (layer A), parsers (A -> B), the
schema for both layers, and a read-only browse layer. It deliberately
contains no collector: collection is phases 0 and 2, and already runs in
`poc/vpass-json` and `poc/sbi-securities-worker`. Every statement below
about the PoC describes code on disk. Where the PoC is deliberately
minimal, or where its behaviour diverges from what the schema comments
claim, this document says so rather than describing an intention as a
fact.

## What an observation is

An observation is one statement of the form *source X said Y*. It is
produced by reading bytes we already hold, and nothing else.

It is not:

- normalized meaning — no canonical categories, no sign convention
  invented from a transaction type, no unit conversion beyond exact
  transcription;
- cross-source identity — no claim that this account, security, or
  merchant is the same as one seen elsewhere;
- a merged view — no deduplication, no "latest wins", no reconciliation;
- a computed value — a provider's reported valuation is an observation,
  our own valuation of the same holding is layer D and never mixes with
  it (`docs/design.md`).

The boundary case that matters most is pending versus posted. Suppose the
card site shows a pending purchase of 10,000 JPY on the 15th, and on the
20th the same purchase appears as posted for 9,800 JPY with a different
merchant string and possibly a different external id. That is two
artifacts, two parse runs, and two transaction observations. Layer B
stores both verbatim and asserts no relationship between them. The claim
that they are one purchase is an interpretation with a relation, a method,
and a confidence, and it is made in phase 6 (`observation_links`). A
parser that merged them would destroy the evidence that the amount
changed — and that change is exactly the signal the design exists to
preserve.

The line between transcription and interpretation is narrower than it
looks. Reading `△100,000` as -100000 is transcription: the provider wrote
the minus sign, in its own notation. Deciding that a row labelled "sell"
implies a negative amount is interpretation, and
`sbi-domestic-trade-records` does not do it — it records the amount as
displayed and leaves the trade type in `extra`.

One parser does cross the line by a small, deliberate step.
`paypay-csv` turns the display string `2026/08/15 12:34:56` into
`2026-08-15T12:34:56+09:00`. The offset is supplied by the parser, on the
grounds that PayPay displays JST; the CSV states no zone. The verbatim
string is kept in `extra` as `datetimeVerbatim`, so the addition is
visible and reversible. Every such step should be this small, this
documented, and this recoverable.

## The parser contract

A parser is a deterministic, versioned, side-effect-free function from raw
bytes plus artifact metadata to typed observations. Its obligations:

1. Deterministic. The same bytes and the same artifact metadata always
   yield the same observations, in the same order, on any machine. The
   PoC asserts this directly: `test/parsers.test.ts` parses each fixture
   twice and compares the serialized results.
2. Side-effect free. No writes, no network, no filesystem, no clock, no
   randomness, no environment lookups. The only time-like value a parser
   may use is `artifact.fetchedAt`, which is handed to it as data; none of
   the four current parsers uses even that.
3. Named and versioned. `name` and `version` are fields of the parser
   object, and both are recorded on the parse run that carries its output.
4. Selects from metadata alone. `accepts(artifact)` sees the artifact row
   id, source id, dataset, URL, MIME type, fetched-at, and the content
   hash — never the bytes. Selection is therefore a database query in
   production, and a parser cannot sniff its way into a payload it was not
   registered for. In the PoC `accepts` is exact equality on `sourceId`
   plus `dataset` for the three SBI parsers, and `sourceId` plus `mime`
   for `paypay-csv`, whose artifact arrives through the file-export path
   with no dataset at all.
5. Records a raw locator on every observation. `rawLocator` is mandatory
   in the type and `NOT NULL` in the schema.
6. Never drops an unrecognized provider field. Everything the source said
   that the typed columns do not model goes into `extra`.
7. Warns rather than discards, at field granularity. See the field and
   container rule below, which is not the same rule for both.
8. Throws only on a wrong-shape artifact. If the payload is not what this
   parser is for, `parse` throws; `runParsers` catches it and records a
   parse run with `status='error'` and the message. A bad artifact never
   crashes a batch and never leaves a half-written parse run.
9. Holds no cross-artifact state. One artifact in, observations out. A
   truncated window (`hasMore: true`) is reported as a warning, not
   resolved by fetching the next page — fetching is layer A's job.

The contract in `poc/observation-pipeline/src/types.ts`:

```ts
export interface Parser {
  name: string;
  version: string;
  /** Decide from artifact metadata only — parsers are selected, then applied. */
  accepts(artifact: ArtifactMeta): boolean;
  /** Deterministic: same bytes + same metadata -> same observations. */
  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult;
}

export interface ParseResult {
  observations: Observation[];
  warnings: string[];
}
```

`Observation` is the union of the four shapes below, each of which
requires `rawLocator` and `extra`.

### Fields survive; containers do not always

Obligation 7 needs stating precisely, because the honest rule is not "the
row always survives".

An unreadable **field** warns, leaves its typed column empty, keeps the
verbatim value in `extra`, and the row is still written. Two worked
examples: `sbi-domestic-trade-records` writes a transaction whose
`amount_minor` is `NULL` and whose `extra.amount` still holds the string
it could not parse; `sbi-foreign-cash-positions` writes the position with
`quantity_text = ''` and `quantity_scale = 0` rather than dropping a
holding because one field was unreadable.

An unreadable **container** warns and is skipped, because there is no row
shape left to write. `sbi-foreign-cash-balances` walks accounts ->
currency entries -> schedule rows, and each level returns early with a
warning naming its locator when the level is not the expected shape: a
non-object account, a `currencyCashBalances` that is not an array ("the
whole account was skipped"), a currency entry with no `currencyCode`, a
`foreignScheduleCashBalances` that is not an array, a non-object schedule
row. A single metric whose value is not an exact decimal is likewise
skipped for that metric alone. `test/parsers.test.ts` pins this: a body
whose account has a malformed `currencyCashBalances` and a `null` sibling
produces zero observations and exactly two warnings.

The two SBI parsers that iterate a flat array take the other option and
emit a placeholder row carrying `_kogane.unparsedElement`, because at that
level a row shape does exist. The rule for a fifth parser is therefore:
emit a row wherever a row can be identified, and warn-and-skip only where
the thing that failed is the thing that would have told you how many rows
there are.

### What goes in `extra`, and how it is namespaced

The three SBI parsers and `paypay-csv` use three different `extra`
conventions, and all three are deliberate.

Spread the element. `sbi-domestic-trade-records` and
`sbi-foreign-cash-positions` put `{ ...record }` into `extra`, so nothing
the collector saw is dropped. `sbi-foreign-cash-positions` repeats the
same spread on every valuation it derives from an element, so a valuation
row is self-contained evidence of what the source said around it.

Namespace anything the parser adds. Where a provider record is spread into
`extra`, parser-added fields go under a single `_kogane` key so they can
never overwrite a provider field of the same name. The PoC uses
`_kogane.externalIdOrigin` and `_kogane.unparsedElement`. A parser that
builds `extra` entirely out of keys it chose itself has nothing to shadow
and needs no namespace — `paypay-csv` stores `header`, `cells`,
`overseas`, `method`, `installmentType`, `user`, and
`datetimeVerbatim` — but a fifth parser that spreads a provider object must
follow the convention.

Build a context object when walking. `sbi-foreign-cash-balances` cannot
spread the element, because the element it reaches is a schedule row whose
enclosing account and currency entry carry fields the schema does not
model. It instead builds a three-part context:

```ts
const context = {
  account: withoutChild(account, "currencyCashBalances"),
  currencyEntry: withoutChild(currencyEntry, "foreignScheduleCashBalances"),
  row: { ...row },
};
```

`withoutChild` copies an object without the child collection the walk
descends into. Without it, every observation would carry every sibling row
of its own currency entry, and every currency entry of its own account —
the payload duplicated once per metric. With it, an unmodelled sibling
field is still preserved: the parser also lists the row keys it does not
map to a metric and warns about them by name, so `totalBalance` appearing
in a future payload shows up as a warning rather than as silence.

### How a parser becomes live

`src/parsers/registry.ts` exports one flat array:

```ts
export const PARSERS: readonly Parser[] = [
  sbiDomesticTradeRecords,
  sbiForeignCashPositions,
  sbiForeignCashBalances,
  paypayCsv,
];
```

`runParsers(store, parsers = PARSERS, now = ...)` takes the list as a
defaulted parameter rather than importing it directly, which is how every
pipeline test drives the pipeline with fake parsers, and how a production
re-parse would run one parser over a selected slice of artifacts. Adding a
parser is therefore: write the module, add it to `PARSERS`, run the suite.

The runnable entry points are `package.json` scripts:

```text
bun run demo        ingest the fixtures, parse them, print row counts
bun run ingest      ingestion only
bun run parse       every registered parser over every artifact
bun run build       build the evidence browser's client
bun run serve       the read-only browser on 127.0.0.1:8787
bun test            the suite
bun run typecheck   tsc --noEmit
```

## Versioning and supersession

A **successful** parse run is identified by `(fetch_artifact_id,
parser_name, parser_version)`. The constraint is a partial unique index,
not a table constraint, and the restriction is the point:

```sql
-- One SUCCESSFUL parse run per (artifact, parser, version). Failed attempts
-- are deliberately not covered by this index: a parse that failed on a
-- transient condition must remain retryable at the same version, and a failed
-- attempt is itself evidence worth keeping.
CREATE UNIQUE INDEX IF NOT EXISTS idx_parse_runs_success
  ON parse_runs (fetch_artifact_id, parser_name, parser_version)
  WHERE status = 'ok';
```

A plain `UNIQUE (fetch_artifact_id, parser_name, parser_version)` would
make a failed parse permanently unretryable at the same version, forcing
an operator to invent a version number to get past a transient failure.
Worse, `runParsers` inserts the error run from inside its own `catch`, so
a uniqueness violation there would escape the handler and abort the sweep.
`findParseRun` matches the same way — it looks only for `status = 'ok'` —
so a prior failure does not count the artifact as already parsed.

Four consequences follow.

**Re-running the same version after success is a no-op.** `runParsers`
looks the tuple up first; if a successful run exists, the artifact is
counted as skipped and nothing is read, parsed, or written. Running the
pipeline twice over the same evidence costs one index lookup per artifact
per accepting parser.

**A failed parse is retried at the same version.** Fix the parser, run
again, and the same version string produces a new run that succeeds. Both
the failure and the success stay in `parse_runs`. `test/pipeline.test.ts`
covers exactly this sequence, including that the earlier good run stayed
current while the failure was outstanding.

**Bumping the version re-parses.** A new version string is a new tuple, so
the artifact is read and parsed again, a new parse run is inserted, and
new observation rows are written alongside the old ones. The run and all
of its observations commit in one transaction, so a partially written
observation set can never sit under a run marked `ok` — which would be
indistinguishable from a source that really said less.

**Supersession is decided by comparing versions, not by insertion order.**
`compareVersions` in `src/store.ts` compares dotted version strings
numerically, segment by segment, treating a missing segment as `0` and
falling back to equality or lexicographic order if a segment is not a
number. `supersedeOlderParseRuns` then reconciles lineage after a
successful parse. It selects the live runs and issues one `UPDATE` per
row it decides about:

```sql
-- the live runs to reconcile against
SELECT id, parser_version FROM parse_runs
WHERE fetch_artifact_id = ?1 AND parser_name = ?2 AND status = 'ok'
  AND id <> ?3 AND superseded_by_parse_run_id IS NULL;

-- issued once per row, after the caller compares versions
UPDATE parse_runs SET superseded_by_parse_run_id = ?1 WHERE id = ?2;
```

The `status = 'ok'` filter in the SELECT matters: an error run is never
superseded and never supersedes, so leaving it out would mark failures as
retired by a later success and quietly change what "current" means for
`parse_runs` itself.

The comparison has two directions, and the reverse one is the reason the
function exists:

- If no live run is newer, every live run at a strictly older version is
  marked superseded by the new run, one `UPDATE` each. The count returned
  is the number of runs marked, which is what the `superseded` figure in
  the run summary reports.
- If a live run at a **newer** version already exists, the new run is
  marked superseded by that run instead, and zero older runs are marked.
  Its observations are written and permanently queryable, but they are
  born superseded. Running an old parser — a rollback, a stale worker, a
  reverted registry entry — therefore cannot quietly make stale readings
  current again. `test/pipeline.test.ts` runs `0.2.0` and then `0.1.0`
  against the same artifact and asserts that both parse runs and both
  observation sets exist while only the `0.2.0` output is current.

**No observation row is ever updated or deleted.** "Current" is therefore
not a column, not a flag, and not a state — it is a query, and it has two
conditions:

```sql
SELECT t.*
FROM transaction_observations AS t
JOIN parse_runs AS p ON p.id = t.parse_run_id
WHERE p.superseded_by_parse_run_id IS NULL AND p.status = 'ok';
```

`p.status = 'ok'` is not optional. Error runs are never superseded, so
they satisfy the first condition forever. They happen to carry no
observation rows today, which makes the omission harmless when joining an
observation table and wrong for any query over `parse_runs` itself; a
future error path that recorded partial output would make it wrong
everywhere. Every current view in `src/queries.ts` uses both conditions:
transactions, the latest-balance window function, positions, and
valuations. The balances page also renders a full history with no
predicate at all, marking the superseded rows, which is how a re-parse can
be compared against what it replaced.

`superseded_by_parse_run_id` is the one deliberate `UPDATE` in an
otherwise append-only design, and the schema comment says so. It is
defensible because it is data about parse lineage, not about the world: it
records which of our programs is the current reading of a blob. The blob
is untouched, the artifact row is untouched, and every observation either
version produced is untouched. Whether the same fact would be better
modelled append-only, as a `parse_run_supersessions` table, has not been
evaluated in this repository; the schema records the exception, not a
rejected alternative.

Practical rules that fall out of this:

- Bump the version whenever the output could change for any byte sequence
  the parser accepts, including bug fixes, added fields, renamed metrics,
  and changed locator formats. Editing a parser without bumping records
  two different programs under one identity, and no query can separate
  them afterwards.
- To roll back to older behaviour, publish a *higher* version that
  restores it (`0.3.0` restoring `0.1.0` logic). Re-running the literal
  string `0.1.0` would either be skipped as already parsed, or, if that
  run had failed, insert a run that is immediately marked superseded by
  the live `0.2.0`.
- Supersession is keyed on `parser_name`. Renaming a parser leaves its old
  parse runs current forever, so a rename is a data decision, not a
  cosmetic one. If a parser is genuinely replaced by a differently-named
  one, the old runs must be superseded explicitly, or both readings stay
  current side by side.

## The observation tables

One physically separate table per shape, not a generic
entity-attribute-value table. The reason is that the shapes differ in what
must be non-null and what must be indexed: a position has a quantity and
no currency amount, a balance has a metric and an instrument, a
transaction has a counterparty and a provider status. An EAV table would
make all of those nullable strings, make every query a self-join, and make
it impossible to state a constraint like "a position always has a
quantity".

Six columns recur across all four shapes:

| column | meaning |
| --- | --- |
| `parse_run_id` | the only provenance link an observation has |
| `source_account` | which account the parser attributes the row to |
| `as_of` | the point in time the value describes |
| `observed_at` | when the source displayed or reported it |
| `raw_locator` | where inside the raw object this came from |
| `extra_json` | everything else the source said |

`parse_run_id` carries the parser name and version, and transitively the
artifact, the raw object hash, the R2 key, and the fetch run. Nothing is
denormalized onto the observation row, so there is exactly one place a
provenance answer can come from. `fetched_at` is deliberately not repeated
here: it belongs to the artifact and is reachable through the join, which
keeps the three timestamps from being confused for each other.

### `source_account` is a placeholder, not a provider label

`schema.sql` comments the column as "the provider's own account label".
That comment is misleading and the code does not implement it. In all four
parsers `source_account` is a hardcoded constant that no provider ever
emitted:

```text
sbi-domestic-trade-records    sbi-securities:domestic
sbi-foreign-cash-positions    sbi-securities:foreign
sbi-foreign-cash-balances     sbi-securities:foreign
paypay-csv                    paypay
```

The provider's own account identifiers are carried in `extra` instead —
`sbi-foreign-cash-balances` puts the enclosing account object under
`extra.account`, whatever it contains — in the collector's current payload
that is only `accountKind`, since the GraphQL selection asks for nothing
else — so nothing is lost, but nothing is resolved either. The
column currently distinguishes datasets within a source, not accounts
within an institution. Reading a real account identity out of each payload
(several SBI account kinds; one Vpass card per collected card directory)
is phase 4, and some payloads may not carry it at all. The schema comment
should be corrected when that work lands.

Two consequences hold today. `source_account` carries no institution
identity, so every current-state view must partition by source as well:
`src/queries.ts` keys the latest-balance window function on `(source_id,
source_account, metric, instrument)` and matches valuations to positions
on `(source_id, source_account, subject)`, because two institutions can
both call an account "main" and numeric TSE security codes are shared
across every Japanese broker. `test/api.test.ts` builds exactly that
collision and asserts neither institution's balance hides the other's.

### `observed_at` is deliberately empty everywhere

All four parsers leave `observed_at` unset, and the reason is written into
the code:

> `observed_at` is deliberately left unset: this payload carries no
> timestamp stating when the source displayed the value. When the value
> was retrieved is `fetch_artifacts.fetched_at`, reachable through the
> observation's parse run, and copying it into `observed_at` would
> collapse two of the three distinct timestamps `docs/design.md`
> separates.

So the column exists, is documented, and is `NULL` in every row the PoC
writes. That is the correct state: the alternative is to alias it to
`fetched_at`, which would silently make the three-timestamp distinction
two timestamps wide. It stays empty until a payload is found that states
when the source displayed a value. `sbi-foreign-cash-positions` extends
the same reasoning to `as_of`, because the positions payload states no
time for the values it reports either.

### Shape-specific columns

- **transaction** — `external_id` (evidence, never a logical identity),
  `status` in the provider's own vocabulary, `currency`, `description`,
  `counterparty`, and the amount as `amount_minor` plus
  `amount_text`/`amount_scale`.
- **balance** — `metric` and `instrument`, with the same three amount
  columns.
- **position** — `security_code`, `security_name`, `market`,
  `quantity_text` plus `quantity_scale` (both `NOT NULL`), and the trading
  `currency`. A quantity is not money: it has no minor-unit column.
- **valuation** — `subject` (what is valued), `metric`, a `NOT NULL`
  `currency`, and the same three amount columns. Provider-reported only.

The dual amount representation on all three amount-bearing shapes is
deliberate redundancy: the text is the lossless transcription of what the
provider wrote, and the integer is the convenience form, present only when
the conversion is exact.

Balances name the unit column `instrument` while transactions, positions
and valuations name theirs `currency`. `docs/design.md` makes `instrument`
the central quantity-bearing concept and a currency merely one type of it,
so the split is a tension worth naming rather than letting a reader
discover. The defence is that at layer B the provider stated a currency
code, not an instrument identity; resolving codes to instruments is
phase 5. Whichever way it is unified later, it is a schema change plus a
re-parse, not a data loss.

### The schema

```sql
CREATE TABLE IF NOT EXISTS parse_runs (
  id                          INTEGER PRIMARY KEY,
  fetch_artifact_id           INTEGER NOT NULL REFERENCES fetch_artifacts(id),
  parser_name                 TEXT NOT NULL,
  parser_version              TEXT NOT NULL,
  parsed_at                   TEXT NOT NULL,
  status                      TEXT NOT NULL,  -- 'ok' | 'error'
  error                       TEXT,
  warnings_json               TEXT,           -- JSON array of warning strings
  superseded_by_parse_run_id  INTEGER REFERENCES parse_runs(id)
) STRICT;

-- One SUCCESSFUL parse run per (artifact, parser, version). Failed attempts
-- are deliberately not covered by this index: a parse that failed on a
-- transient condition must remain retryable at the same version, and a failed
-- attempt is itself evidence worth keeping.
CREATE UNIQUE INDEX IF NOT EXISTS idx_parse_runs_success
  ON parse_runs (fetch_artifact_id, parser_name, parser_version)
  WHERE status = 'ok';

CREATE INDEX IF NOT EXISTS idx_parse_runs_artifact
  ON parse_runs (fetch_artifact_id, parser_name);

-- "The source says: this transaction happened / is pending."
CREATE TABLE IF NOT EXISTS transaction_observations (
  id             INTEGER PRIMARY KEY,
  parse_run_id   INTEGER NOT NULL REFERENCES parse_runs(id),
  source_account TEXT NOT NULL,          -- the provider's own account label
  external_id    TEXT,                   -- provider id; NOT a logical identity
  status         TEXT,                   -- provider-shown status, verbatim domain
  amount_minor   INTEGER,                -- signed minor units; NULL if unparseable
  amount_text    TEXT,                   -- verbatim/high-precision amount, never lost
  amount_scale   INTEGER,
  currency       TEXT,                   -- ISO 4217 as the provider stated it
  description    TEXT,
  counterparty   TEXT,
  as_of          TEXT,                   -- the date the value describes
  observed_at    TEXT,                   -- when the source displayed/reported it
  raw_locator    TEXT NOT NULL,          -- locator inside the raw object
  extra_json     TEXT NOT NULL           -- everything else the source said
) STRICT;

CREATE INDEX IF NOT EXISTS idx_txn_obs_account
  ON transaction_observations (source_account, as_of);

-- "The source says: metric M of account A was N at time T."
CREATE TABLE IF NOT EXISTS balance_observations (
  id             INTEGER PRIMARY KEY,
  parse_run_id   INTEGER NOT NULL REFERENCES parse_runs(id),
  source_account TEXT NOT NULL,
  metric         TEXT NOT NULL,          -- 'buy_possible' | 'keep_cash' | ...
  amount_minor   INTEGER,                -- fiat path
  amount_text    TEXT,                   -- high-precision path (crypto etc.)
  amount_scale   INTEGER,
  instrument     TEXT NOT NULL,          -- currency / unit code as provider stated
  as_of          TEXT,
  observed_at    TEXT,
  raw_locator    TEXT NOT NULL,
  extra_json     TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_bal_obs_account
  ON balance_observations (source_account, metric, instrument, as_of);

-- "The source says: account A holds quantity Q of security S."
CREATE TABLE IF NOT EXISTS position_observations (
  id              INTEGER PRIMARY KEY,
  parse_run_id    INTEGER NOT NULL REFERENCES parse_runs(id),
  source_account  TEXT NOT NULL,
  security_code   TEXT NOT NULL,         -- provider's code, verbatim
  security_name   TEXT,
  market          TEXT,
  quantity_text   TEXT NOT NULL,         -- decimal string, never REAL
  quantity_scale  INTEGER NOT NULL,
  currency        TEXT,                  -- trading currency as provider stated
  as_of           TEXT,
  observed_at     TEXT,
  raw_locator     TEXT NOT NULL,
  extra_json      TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_pos_obs_account
  ON position_observations (source_account, security_code, as_of);

-- "The source says: this holding is worth V / has P&L L" — provider-reported
-- valuations only; our own computed valuations are a derived layer, not this.
CREATE TABLE IF NOT EXISTS valuation_observations (
  id             INTEGER PRIMARY KEY,
  parse_run_id   INTEGER NOT NULL REFERENCES parse_runs(id),
  source_account TEXT NOT NULL,
  subject        TEXT NOT NULL,          -- what is valued (security code, ...)
  metric         TEXT NOT NULL,          -- 'evaluation_amount' | 'evaluation_profit_loss' | ...
  amount_minor   INTEGER,
  amount_text    TEXT,
  amount_scale   INTEGER,
  currency       TEXT NOT NULL,
  as_of          TEXT,
  observed_at    TEXT,
  raw_locator    TEXT NOT NULL,
  extra_json     TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_val_obs_subject
  ON valuation_observations (source_account, subject, metric, as_of);

-- parse_run_id is the join column for every "which observations are current"
-- query, so each observation table is indexed on it.
CREATE INDEX IF NOT EXISTS idx_txn_obs_parse_run
  ON transaction_observations (parse_run_id);
CREATE INDEX IF NOT EXISTS idx_bal_obs_parse_run
  ON balance_observations (parse_run_id);
CREATE INDEX IF NOT EXISTS idx_pos_obs_parse_run
  ON position_observations (parse_run_id);
CREATE INDEX IF NOT EXISTS idx_val_obs_parse_run
  ON valuation_observations (parse_run_id);
```

Two notes for anyone applying this DDL.

The `source_account` comment is reproduced from `schema.sql` as it stands
and is, as described above, not what the parsers do. The
`balance_observations.metric` comment is also stale: it names
`'buy_possible'`, while `sbi-foreign-cash-balances` emits
`buy_possible_amount`. Both comments should be corrected in `schema.sql`;
they are left here unedited so that this document and the file it quotes
can be diffed.

`schema.sql` contains no `PRAGMA` statements, deliberately, because D1
enables foreign keys by default and rejects the pragma. `src/store.ts`
issues `PRAGMA foreign_keys = ON;` on the connection instead. An
implementer running this file against a bare SQLite database must do the
same, or references are recorded and never enforced.

The PoC has no migrations. `src/store.ts` keeps a `SCHEMA_VERSION`
constant, checks it against `PRAGMA user_version`, and on a mismatch tells
the operator to delete the state directory and re-ingest. That is an
acceptable answer only because everything above the raw layer is
re-derivable, which is the same property the whole design rests on.

### `reward_observations` is unwritten, and the PoC is currently wrong about points

`reward_observations`, listed in `docs/roadmap.md` phase 3, remains
designed and unimplemented. The reason usually given — that no reward
evidence has been collected — is not true, and the deferral should not
lean on it.

The PoC's own PayPay fixture contains a limited-time point grant:

```text
2026/08/18 03:00:00,,120,,,,,PayPayポイント付与,PayPay,PayPayポイント,,本人,lp-0011223344
```

`docs/sources/paypay.md` records that limited-time points are labelled
`PayPayポイント`, the same as ordinary points, and that a transaction
number beginning with `lp-` identifies a limited-time point grant.
`paypay-csv` sets `currency: "JPY"` unconditionally, so this row is
recorded as a transaction observation of `amount_minor = 120, currency =
'JPY'` — 120 points stored as 120 yen. `docs/design.md` is explicit that
reward points and miles are not currencies, and that a provider-displayed
estimated value is that provider's valuation observation, never merged
into a balance. This is a live divergence between the reference
implementation and the design, and it is the concrete reason
`reward_observations` is needed.

What still justifies not writing the table yet is narrower: the columns
depend on payloads nobody has read. `docs/design.md` separates reward
units into four concerns — quantity, lots and expiry, conversion rules,
valuations — and the evidence that would settle their shape (PayPay's
limited-time point tab, the expired-points list, the expected-grant
calendar) is not collected by any path in this repository. The likely
shape is a quantity observation plus a separate expiry observation, with
provider "estimated value" reusing `valuation_observations`; that is a
hypothesis, not a decision. Until then the yen mislabelling is a known
defect with a bounded fix — a `paypay-csv` version bump and a re-parse —
and it belongs in the exit criteria, not in a footnote.

## Value handling

Fiat amounts are `INTEGER` minor units. `REAL` never appears. The PoC's
exponent table covers only the currencies its sources actually report:

```text
JPY 0    USD 2    AUD 2
```

An unknown currency has no exponent, and `amountToMinorUnits` returns
`undefined` rather than assuming 2. The helper refuses to guess in every
direction — measured behaviour, from `test/parsers.test.ts`:

| input | currency | result |
| --- | --- | --- |
| `1,802` | JPY | `1802` |
| `△100,000` | JPY | `-100000` |
| `(1,000)` | JPY | `-1000` |
| `+300` | JPY | `300` |
| `1,024.53` | USD | `102453` |
| `180,200.00` | JPY | `180200` |
| `1.230` | USD | `123` |
| `1.5` | JPY | `undefined` (precision would be lost) |
| `1.231` | USD | `undefined` |
| `1024,53` | JPY | `undefined` (comma grouping is invalid) |
| `△-100` | JPY | `undefined` (two negative markers) |
| `N/A` | JPY | `undefined` |
| `100` | XYZ | `undefined` (unknown exponent) |

Thousands separators, a leading `+` or `-`, the `△`/`▲` negative marker
used by Japanese financial sites, and parenthesized negatives are all
handled, because they are display notation rather than meaning. Grouping
is validated before it is stripped: a source that writes `1024,53` means
1024.53, and removing the comma would inflate the value a hundredfold.
Trailing zeros inside the currency's scale are exact rather than precision
loss, so an export writing `180,200.00` for a JPY figure is not thrown
away. Negative zero is never produced.

`undefined` is not a failure path that discards data. The parser emits a
warning naming the field and the verbatim string, writes the row with the
amount column `NULL`, and keeps the original value in `extra_json` — and,
where the string is a well-formed decimal, in `amount_text`/`amount_scale`
as well. A later parser version can extract it without re-fetching
anything.

High-precision quantities are decimal strings plus a scale. `decimalText`
normalizes a JSON number-or-string into `{ text, scale }` and refuses any
JSON number that is not a safe integer: by the time a fraction reaches
JavaScript as a `number`, the decimal the provider wrote is already gone,
and a value beyond `Number.MAX_SAFE_INTEGER` has already been rounded by
`JSON.parse`. `decimalToMinorUnits` converts an exact decimal string into
minor units, or returns `undefined` if the currency is unknown, precision
would be lost, or the result leaves the safe-integer range; it validates
its own input rather than trusting it, so an empty string can never become
zero yen. Position quantities keep only the text form.

The same rule holds on the way out. `formatAmount` in `src/money.ts` renders
minor units through `BigInt` and string manipulation only, so an amount
never passes through floating point even on its way to a screen, and an
instrument with no known exponent is labelled `(minor units)` rather than
given a guessed scale.

Decoding is strict: `decodeUtf8` uses `TextDecoder("utf-8", { fatal: true
})`, so a mis-encoded artifact throws and becomes an error parse run
instead of silently producing replacement characters. There is no
Shift-JIS decoder yet, and there cannot usefully be one until the raw
layer carries a declared charset on the artifact: nothing today tells a
parser which decoder to select. The Vpass CSV path will need this, and the
decoding belongs in the parser rather than in the collector, since the
collector must store the original bytes (`docs/tooling.md`).

## Raw locators

Every observation records where inside the raw object it came from. The
five formats the PoC emits:

```text
json:$.records[0]
json:$.listSecuritiesBalances.securitiesBalances[0]
json:$.listSecuritiesBalances.securitiesBalances[0].evaluationProfitLoss
json:$.listForeignScheduleCashBalances.foreignCashBalances[0]
  .currencyCashBalances[0].foreignScheduleCashBalances[1].keepCash
csv:row=2
```

The prefix names the byte format and the remainder is a path within it.
CSV rows are 1-based counting the header as row 1, so the locator matches
what a spreadsheet shows.

A locator has one job: re-find the value inside *these* bytes. It does not
have to survive a new fetch, because it never refers to one. Raw objects
are content-addressed and immutable, so a positional index into
`records[0]` cannot drift — the same sha256 always has the same element
there. Positional locators into a live page would be worthless; into a
fixed blob they are exact.

The granularity rule is to point at the smallest node that contains
everything the observation asserts. A transaction built from several
fields of one record points at the record; a balance measurement built
from one field points at the field.

The valuation locator is the exception, and it is worth naming rather than
hiding. `sbi-foreign-cash-positions` derives up to four valuations —
`evaluation_amount`, `evaluation_profit_loss`, `frn_evaluation_amount`,
`frn_evaluation_profit_loss` — from one `evaluationProfitLoss` object, and
gives all four the locator of that object rather than of the individual
field each one read. Four observations therefore share one locator. It is
still exact in the sense that matters (the value is inside that node) but
it is coarser than the rule asks for, and telling the four apart requires
the `metric` column. Tightening it to
`...evaluationProfitLoss.frnEvaluationAmount` is a locator-format change
and therefore needs a version bump, which is the machinery working as
intended.

Deliberately minimal: the strings are JSONPath-like but the PoC ships no
resolver. The browse UI prints the locator next to the raw object rather
than evaluating it and highlighting the bytes. A resolver is a small,
well-scoped addition and would make provenance visibly verifiable rather
than merely recorded.

## The first parsers

Four exist in `poc/observation-pipeline/src/parsers/`, all at version
`0.2.0`.

**`sbi-domestic-trade-records`** consumes the `domestic-trade-records`
dataset written by `poc/sbi-securities-worker`, whose body is
`{ records, hasMore }` with each record keeping the source table row in
`rawCells`. Every record becomes one transaction observation in JPY, with
`as_of` from `tradeDate`, `description` from `rawCells[1]` (falling back
to `issueName`), and the whole record spread into `extra`. The amount is
accepted as a display string or as a JSON number, and the verbatim form is
kept in `amount_text` even when it does not resolve to minor units. It
does not decide the sign from the trade type, and it does not treat the
record `id` as a provider identity: the collector computes that id as a
row fingerprint plus an occurrence counter
(`poc/sbi-securities-worker/src/main-site.ts`), so the parser tags it
`_kogane.externalIdOrigin: "collector-fingerprint"`. A record that is not
an object still produces a row carrying `_kogane.unparsedElement`.
`hasMore: true` is a warning, never an invitation to fetch the next page.

**`sbi-foreign-cash-positions`** consumes the `foreign-cash-positions`
dataset, the GraphQL `data` object of `GetSecuritiesBalanceList`. Each
balance element yields one position observation and up to four valuation
observations.

The currency attribution of those valuations is an unconfirmed working
assumption, recorded as such at the top of the parser:

> Working assumption, to be confirmed against real R2 payloads on first
> re-parse: `evaluationAmount` / `evaluationProfitLoss` are JPY figures
> and the `frn*` variants are denominated in `currencyCode`. If this turns
> out to be wrong, bumping the parser version and re-parsing corrects
> every observation; that operation is exactly what the pipeline exists to
> prove.

It is inferred from field naming, not observed — no document in
`docs/sources/` states it — and it should be read as this document's
worked example of why versioned re-parse exists rather than as settled
fact. It is a cheap assumption precisely because it is cheap to withdraw:
one version bump and one sweep correct every historical observation, and
the superseded readings stay queryable for comparison.

The rest of the parser refuses to guess in the same style. A quantity that
is not an exact decimal — a JSON float, for instance — does **not** cost
the holding: the position is emitted with `quantity_text = ''` and
`quantity_scale = 0`, a warning names the field, and the unreadable value
and all its siblings survive in `extra`, because a holding must never
disappear because one field was unreadable. A missing `securitiesCode`
warns and leaves the code empty. A missing `currencyCode` means the `frn*`
valuations cannot be denominated, so they are not emitted at all and a
warning says so; their values remain reachable on the position's `extra`.
It does not decide whether the provider's valuation is right — that
comparison is the whole point of keeping provider-reported and derived
valuations apart.

**`sbi-foreign-cash-balances`** consumes the `foreign-cash-balances`
dataset, the `data` object of `GetForeignCashBalance`. It walks accounts
-> currency entries -> schedule rows and emits one balance observation per
provider metric per row — `buy_possible_amount`, `keep_cash`,
`transfer_possible_amount`, `remaining_buy_possible_amount`,
`amount_pay_value` — with `instrument` from `currencyCode`, `as_of` from
`businessDate`, and the three-part `{ account, currencyEntry, row }`
context in `extra`. It does not decide which of the five is "the" balance.
All five coexist, which is what `docs/design.md` means by balances being
measurements rather than columns. It is also the parser whose container
handling is described above: malformed containers are warned about and
skipped, not turned into placeholder rows.

**`paypay-csv`** consumes the official consumer CSV documented in
`docs/sources/paypay.md`, ingested through the `ingest-file` path. Each
data row becomes one transaction observation: outgoing amounts negative,
incoming positive, and the overseas amount, currency, conversion rate, and
country left decomposed in `extra`, never folded into the JPY figure — the
same rule `smcc-meisai-scraper` already follows for foreign card use.

Its column mapping is load-bearing and is not positional. Columns are
located by matching a distinguishing substring of each header label
(`取引日`, `出金`, `入金`, `海外`, `通貨`, `レート`, `利用国`, `取引内容`,
`取引先`, `取引方法`, `支払い区分`/`支払区分`, `利用者`, `取引番号`).
Position is used only as a fallback, and every fallback is warned about,
as is a column found at a position other than the documented one and any
header column the documentation does not list. The parser throws outright
if the header does not mention `取引日`. The reason is in
`docs/sources/paypay.md`, which lists the 13 documented columns and then
leaves it as an open acceptance gate whether the current export still
matches them: a purely positional mapping would silently invert an amount
if PayPay ever reordered the outgoing and incoming columns. The suite pins
this with a header whose two amount columns are swapped, and asserts the
payment is still recorded as negative.

It does not decide what a row with both an outgoing and an incoming amount
means (warning, amount left empty), does not decide what a row stating
neither means (warning), and does not decide that two rows sharing a
transaction number are one event; the fixture deliberately contains a
refund reusing the original payment's number, and both rows survive
intact. It also, today, records point grants as yen — see the
`reward_observations` discussion above.

### Two more parsers come next, and are not in the PoC

**Vpass card statement (CSV).** `smcc-meisai-scraper`'s `parser.ts` is
adopted, with exactly the two changes `docs/tooling.md` names: emit
`parser_name`/`parser_version` and a raw locator on every observation, and
stop discarding unrecognized note lines with `log.warn` — carry them into
`extra` instead. Its existing behaviour already matches this design: usage
amount and payment amount stay separate fields, foreign use stays
decomposed into amount, currency, rate, and exchange date, and the CSV
total row is reconciled against the parsed sum with a mismatch warned
rather than corrected. Two adaptations are Kogane-side work: the CSV is
Shift-JIS and the scraper decodes and NFKC-normalizes before saving, where
Kogane stores the raw bytes and decodes in the parser; and the deployed
collector `poc/vpass-json` stores statement JSON rather than CSV, so the
JSON path needs its own parser even where the CSV parser is reused for
manual exports.

**Vpass positional `meisaiList`.** `poc/vpass-json` records that
`WebMeisaiTopDisplayServiceBean.meisaiList` uses positional
`rowType`/`data` arrays, and deliberately saves those arrays losslessly
instead of guessing their meaning. The row semantics are genuinely not
known: which `rowType` values exist, what each position in `data` holds,
and how the array differs between the `WebMeisaiTopDisplayServiceBean` and
`CustomizedMeisaiAnsDisplayServiceBean` response families are all open.
The correct sequencing is to leave that dataset without a parser until a
small number of real statements have been read by hand — the evidence is
already in R2 and losslessly re-parseable, so nothing is lost by waiting,
whereas a `0.1.0` that encodes a guess would put the guess into the
observation tables. When it is written, an unrecognized `rowType` must
produce a warning and a row carried into `extra`, not a dropped row.

Ingesting that evidence needs one layer-A adaptation first. The SBI
collector writes a per-run `manifest.json` listing every artifact with its
sha256, which is what `ingestRunDirectory` verifies against before writing
anything. `poc/vpass-json` writes a `manifest.json` per card, under
`vpass/YYYY/MM/DD/<runId>/card-00N/`, and writes a run-level `error.json`
when the session cannot be opened — but no run-level manifest. Its run id
is a timestamp with separators replaced, where the SBI worker's is
`crypto.randomUUID()`. Neither shape is wrong; the importer simply has to
be told which one it is reading, and that decision belongs to
`docs/raw-store.md` rather than to a parser.

## Testing

`bun test` is 63 pass, 0 fail across three files, and `bunx tsc --noEmit`
is clean. `bun run demo` ingests 4 artifacts from 2 sources and produces
28 observations across 4 parse runs: 8 transaction, 10 balance, 2
position, 8 valuation.

The fixtures live under `poc/observation-pipeline/fixtures/`:

```text
fixtures/sbi-securities/2026-08-20/run-20260820-210000-poc01/
    manifest.json
    domestic-trade-records.json
    foreign-cash-balances.json
    foreign-cash-positions.json
fixtures/paypay/paypay-transactions-202608.csv
```

The SBI fixture is shaped like the collector's output but is not a copy of
its R2 layout, and the difference is worth stating so nobody writes an
importer against the fixture. `poc/sbi-securities-worker` writes to
`raw/sbi-securities/YYYY/MM/DD/<runId>/` — three date segments and a UUID
run id — where the fixture uses one date segment and a readable run name.
The fixture also holds three of the seven datasets the collector emits
(`account-assets-current`, `yen-detail-history`, `domestic-trade-records`,
`domestic-cash-positions`, `foreign-cash-positions`,
`foreign-cash-balances`, `foreign-trade-records`). What *is* faithful is
the manifest: it carries the collector's own `schemaVersion`
`sbi-worker-poc-v1`, one entry per artifact with `dataset`, `key`,
`sha256`, `bytes` and an optional `window`, and its `key` values spell out
the real R2 layout. `ingestRunDirectory` reads `<dataset>.json` beside the
manifest and verifies every hash before writing anything. The PayPay
fixture is a single CSV, ingested through `ingestFile`.

The fixtures are synthetic. The repository is public and every real
payload is personal financial data, so committing captures is not an
option (`docs/account-inventory.md`). What the fixtures reproduce is the
structure — field names, nesting depth, Japanese display strings, the `△`
marker, a limited-time point grant, a refund reusing a transaction number
— with invented values. The honest consequence: a green fixture proves the
parser handles the shape we believe the source has. It cannot prove the
shape is right. Only running the parser against the real R2 evidence can
do that, which is why it is an exit criterion below and not a test.

A parser test asserts four things:

1. Selection. `accepts` is true for its own dataset and false for a
   sibling dataset from the same source.
2. An exact golden parse. The observation count, and the exact values of
   the fields that matter: amounts in minor units, `as_of`, the
   `raw_locator` string, and at least one `extra` key proving the
   never-drop rule.
3. Warning behaviour on malformed input. The typed field is empty, the
   verbatim value is in `extra`, a warning names the field, and the row
   survives — or, for a malformed container, the warning names the
   locator and the observation count is asserted to be zero.
4. An error, not a crash, on a wrong-shape artifact. `parse` throws; at
   pipeline level that becomes a parse run with `status='error'`, the
   message stored, and zero observations written.

`test/pipeline.test.ts` covers the layer boundaries rather than the
parsers: run-directory idempotence, one blob for identical bytes ingested
under two names, a re-fetch of unchanged bytes recorded as a second
confirmation, and three rejection paths that must leave nothing behind (a
manifest hash mismatch, a missing file, a dataset listed twice) because a
run row written ahead of a failure would make every later attempt a silent
no-op. On the parse side it covers the no-op re-parse, supersession on a
version bump with both observation sets still present, the error parse
run, an error run neither superseding a good one nor blocking a retry at
the same version, an older version failing to make stale output current, a
failed observation insert leaving no partially-parsed `ok` run, and a
missing blob failing only its own artifact rather than the sweep.

`test/api.test.ts` covers the browse layer: exact amount formatting
including values that only an exact implementation gets right, the
derived-not-stored latest-balance view, provider text escaped rather than
emitted as markup, a superseded run hidden from current views while
remaining reachable through its artifact, raw bytes served verbatim but
inert (`content-security-policy: sandbox`, `nosniff`, and a stored content
type containing CRLF neutralized), routing and method rejection, and the
two-institution label collision described earlier.

## Re-parsing as an operation

Re-parsing all historical evidence with a newer parser is a routine
operation, not a migration.

**What an operator runs.** In the PoC: edit the parser, bump its `version`
constant, run `bun run parse`. In production the same loop lives in a
Worker or queue consumer reading blobs from R2 and writing to D1, over a
selected set of artifacts — by source, dataset, or date range. That
selection does not exist yet: `src/parse.ts` loops over every artifact and
every registered parser with no filter, no batching, no concurrency, and
no resume. That is fine for four artifacts and wrong for a full backfill.

**What it costs.** One blob read and one parse per accepted artifact —
linear in artifacts, not in observations. Storage grows by one full copy
of that parser's observations, permanently, because nothing is deleted.
The number of artifacts a real sweep would touch is not recorded in this
repository; both deployed collectors run on a daily Cron
(`0 21 * * *`), and `poc/sbi-securities-worker`'s README records a
backfill invocation as `scripts/backfill.sh 2024-08-28 2026-05-29`. At
that horizon a retention policy for superseded observations becomes a real
question, and it is one this document leaves open rather than answering by
assertion.

**What it changes.** One new `parse_runs` row per artifact, the new
observation rows, and one `UPDATE` per previously-current parse run. No
existing observation row is touched.

**How to verify it worked.** For a forward version bump, the summary line
should show `parsed` equal to the number of accepted artifacts, `skipped`
zero, `errors` zero, and `superseded` equal to the number of
previously-current runs. `superseded` is zero rather than equal when a
newer version is already live — that is the out-of-order case, not a
failure, but it means the figure only reads as an invariant when the bump
really is forward. Then:

```sql
-- must return no rows: at most one current successful run per (artifact, parser)
SELECT fetch_artifact_id, parser_name, COUNT(*) AS current_runs
FROM parse_runs
WHERE superseded_by_parse_run_id IS NULL AND status = 'ok'
GROUP BY fetch_artifact_id, parser_name
HAVING current_runs > 1;

-- must return no rows: every current observation has a locator
SELECT o.id FROM transaction_observations AS o
JOIN parse_runs AS p ON p.id = o.parse_run_id
WHERE p.superseded_by_parse_run_id IS NULL AND p.status = 'ok'
  AND (o.raw_locator IS NULL OR o.raw_locator = '');

-- not an invariant, but the only place failures are visible: error runs are
-- never superseded and never appear in a current view
SELECT id, fetch_artifact_id, parser_name, parser_version, error
FROM parse_runs WHERE status = 'error' ORDER BY id;
```

Finally, compare current observation counts per shape against the previous
version's counts. A difference is expected when the parser changed, and
its direction should match the change that was made; an unexplained
difference is the signal that the bump did something other than intended.
`bun run serve` shows the same thing by hand: the new parse run current, the
old one marked superseded, both readings still reachable from the
artifact, and each run's warnings listed beside its observations.

## Exit criteria

Phase 3 is done when:

- Every dataset the deployed collectors emit either has a parser or an
  explicit recorded decision not to parse it yet. Of the seven datasets
  `poc/sbi-securities-worker` writes, three have parsers; the Vpass
  statement datasets have none.
- Parsers have been run against the real R2 evidence, not only fixtures,
  and the results have been eyeballed against the provider's own screens
  for at least one period per source.
- The SBI valuation currency attribution has been confirmed against a real
  payload, or corrected by a version bump and a re-parse.
- The PayPay export's current column set has been checked against
  `docs/sources/paypay.md`, and any header-fallback warning the real file
  produces has been resolved rather than tolerated.
- Reward evidence is no longer recorded as fiat: either
  `reward_observations` exists, or `paypay-csv` stops labelling point
  grants `JPY`.
- Artifacts carry a declared encoding, or there is a recorded decision
  that strict UTF-8 with an error parse run is acceptable for every source
  in scope.
- A version bump plus full re-parse has been executed end to end and
  verified with the queries above.
- Every observation carries a `parse_run_id` and a non-empty
  `raw_locator`, checked by query rather than by assumption.
- Golden fixture tests and the type check run in CI.
- No interpretation has leaked into layer B: no cross-source identity, no
  pending/posted merging, no computed valuations, no canonical categories.

## Open questions

- **SBI evaluation currency.** `sbi-foreign-cash-positions.ts` documents
  the working assumption that `evaluationAmount` and
  `evaluationProfitLoss` are JPY figures while the `frn*` variants are
  denominated in `currencyCode`. Nothing in `docs/sources/` confirms it
  and no real payload has been checked. If it is wrong, every affected
  observation is corrected by a version bump and a re-parse, which is
  precisely the operation the pipeline exists to make routine.
- **Vpass `meisaiList` row semantics.** Unknown, as described above. Until
  real statements are read by hand, no parser should be written for those
  rows.
- **PayPay CSV column set.** `docs/sources/paypay.md` carries this as an
  open acceptance gate: whether the current export still has exactly the
  13 documented columns is unverified. `paypay-csv` is built to survive
  being wrong about it — header-label matching, warned positional
  fallback, undocumented columns reported — but one real export settles
  it.
- **Reward units.** Point grants are recorded today as JPY transactions,
  contradicting `docs/design.md`. The fix direction is clear; the shape of
  `reward_observations` is not, because the payloads that would settle it
  (limited-time point tab, expired-points list, expected-grant calendar)
  are not collected by any path in this repository.
- **`observed_at` has no source yet.** All four parsers leave it unset,
  deliberately. Whether any collected payload states when the source
  displayed a value is unknown; until one does, the column stays empty
  rather than being aliased to `fetched_at`.
- **`source_account` identification.** It is a per-parser constant in the
  PoC and `schema.sql`'s comment on the column does not match that.
  Reading real account identity out of each payload is phase 4, some
  payloads may not carry it, and the schema comment should be corrected
  when the answer is known.
- **Artifact encoding.** The raw layer records no charset, so a
  Shift-JIS artifact can only fail loudly. Adding a declared encoding to
  the artifact is a layer-A change (`docs/raw-store.md`) that phase 3
  depends on for the Vpass CSV path.
- **Metric vocabularies.** Metric names are the provider's own fields
  transliterated to snake_case tokens, with no mapping to a shared
  vocabulary, because mapping is interpretation. The boundary is worth
  restating when a second broker reports something that looks like
  `keep_cash` but is not.
- **`instrument` versus `currency`.** `docs/design.md` makes `instrument`
  the central concept; layer B currently records a currency code on three
  of four shapes because that is what the provider stated. Whether the
  column names converge before phase 5 is undecided.
- **Selection and batching for a large re-parse.** `src/parse.ts` has no
  filter, batching, concurrency, or resume. What the production loop
  selects on, and how it resumes after a partial sweep, is unspecified.
- **Retention of superseded observations.** Nothing deletes them, by
  design. Whether that stays true at several years of daily evidence, and
  what a defensible archival rule would look like, is undecided — as is
  whether supersession should eventually be modelled append-only instead
  of as one nullable column, an alternative the repository records no
  evaluation of.

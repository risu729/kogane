# ADR 0022: Give registered shared-R2 artifacts their parser dataset

- Status: proposed
- Date: 2026-09-26
- Carried by:
  [processor §3.4](../processor.md#34-artifact-datasets-adr-0022),
  [collection: artifact datasets](../collection.md#artifact-datasets-at-registration-adr-0022),
  `packages/application/src/collection/descriptors.ts` (`ARTIFACT_DATASETS`,
  `WITHHELD_ARTIFACT_DATASETS`), `scripts/artifact-datasets.test.ts`,
  `services/processor/test/registration-datasets.test.ts`
- Related: [ADR 0010](0010-terminal-registration-budget.md) (registration
  budget), [ADR 0023](0023-vpass-collector-card-binding.md) (no trusted card
  binding for collector-vpass runs; #260), ADR 0024 (terminal scan cursor,
  in flight)
- Merge order: after #259 ([ADR 0014](0014-collector-producer-ids.md), collector producer ids, merged); see Consequences.

## Context

Since 2026-09-12 (U09, #184) the Processor registers shared-R2 terminals
through `registerTerminal` and the pure derivation in `descriptors.ts`. The
2026-09-26 production survey (counts only) found that registered artifacts
carry `dataset = NULL` (finding P4):

- `terminal-v1` has no dataset field (`TerminalArtifact` in
  `packages/collection/src/manifest.ts`), and `artifactRequest` set a dataset
  for one artifact of one source only (St George's `account-snapshot.json`).
- `observation_fetch_artifacts` passes the column through (migration 0017),
  and every registered parser except Mizuho's selects its artifacts by
  dataset. Job creation (`laneParsers` in `services/processor/src/worker.ts`)
  asks each parser's `accepts` over exactly that metadata, so a NULL-dataset
  artifact gets no job.
- Mobile Suica: 13 registered runs, 39 artifacts, 0 parses since 2026-09-12.
  Every other source is stopped earlier, by producer ids (P1, #259) or by
  lineage and unit counts (P2/P3, collector side).

## Options considered

1. **A closed per-source `artifactKey → dataset` table in `descriptors.ts`**,
   following the St George precedent. It works on the terminals already in R2,
   because the dataset is derived from what the terminal already states (key,
   role, media type). It is only as truthful as its derivation, so it must be
   derived from what each collector writes and what each parser accepts, and
   tested both ways.
2. **An optional `dataset` on `TerminalArtifact`.** A manifest schema change
   every collector would have to fill, and one that does nothing for runs
   already persisted: a terminal is immutable, so no old run would ever carry
   the field.

## Decision

**Option 1.** `ARTIFACT_DATASETS` maps each terminal `source` to closed rules
of (artifact key or whole-key pattern, role, declared media types) → dataset.
An artifact matching no rule, or matching a key with a different role or
media type, keeps `dataset = NULL`, which is what every shared-R2 artifact had
before and what no parser but Mizuho's reads. Nothing is guessed.

The rules were derived from every `services/collector-*/src/shared-*.ts`
persist path (and `docs/collection.md`'s per-collector tables), cross-checked
against the datasets the retired importer registered for the same artifact
keys (`services/collector-r2-importer`, removed in #206), and from each
parser's `accepts` in `packages/parsers/src/parsers/*.ts`:

| Terminal source      | Artifact (role, media type)                                                                                               | Dataset                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `mobile-suica`       | `sf-history.json` (`collector_derived`, JSON)                                                                             | `sf-history`                                                        |
| `moneyforward-me`    | `accounts.html`, `account-detail-NN.html`, `account-NN-month-YYYY-MM.html` (provider, HTML)                               | `accounts-index`, `account-detail`, `monthly-transactions`          |
| `myjcb`              | `<conn>/discovery.json`, `<conn>/credit-past-months.json`, `<conn>/credit-detail-NN.html`, `<conn>/credit-ledger-NN.json` | `discovery`, `credit-past-months`, `credit-detail`, `credit-ledger` |
| `prestia-globalpass` | `activity-YYYY-MM.html` (sanitized, HTML)                                                                                 | `globalpass-activity`                                               |
| `sbi-securities`     | `<dataset>.json` for its seven datasets (`collector_derived`, JSON)                                                       | the file name                                                       |
| `sbi-shinsei`        | `raw-top-accounts-balance-and-activity.json`, `raw-yen-deposit-account.json` (sanitized, JSON)                            | the name after `raw-`                                               |
| `sbi-vc-trade`       | `<dataset>.json` for the static, execution and cash-flow pages (`collector_derived`, JSON)                                | the file name                                                       |
| `smbc-direct`        | `balance.normalized.json`, `transactions/<from>-<to>.normalized.json` (`collector_derived`)                               | `balance-normalized`, `transactions-normalized`                     |
| `sony-bank`          | gross balance, history pages, history CSVs, `wallet-history-YYYY-MM.html`                                                 | `gross-balance`, `…-page-NNNN`, `…-csv`, `wallet-history-YYYYMM`    |
| `st-george`          | `account-snapshot.json` (sanitized, JSON)                                                                                 | `account-snapshot` (unchanged)                                      |
| `v-point`            | `balance-info.json`, `smfg-point.json`, `history-page-NNNN.json` (`collector_derived`, JSON)                              | the file name                                                       |
| `v-point-pay-email`  | `normalized-event.json` (`collector_derived`, JSON)                                                                       | `notification-event`                                                |

Deliberately not mapped:

- **Evidence no parser reads** stays NULL: manifests, summaries, the Mobile
  Suica CP932 page beside its normalized rows (mapping it would produce each
  row twice), SBI Shinsei's other captures and normalized file, SMBC's raw
  Shift_JIS responses, V Money pages, the V Point Pay collector's files (it is
  stopped), Vpass's card list, selection and discovery responses.
- **Mizuho** is absent: its parsers accept `dataset = NULL` and select by key
  and unit, so its registration is unchanged.
- **MyJCB `credit-menu.html`** is unreachable: its evidence-boundary parser
  accepts only the media type `text/html; charset=utf-8`, and a terminal media
  type carries no parameters (`terminal-v1`, and CORE's own media-type
  validation). The test names it with that reason.
- **Vpass is withheld** (`WITHHELD_ARTIFACT_DATASETS`). The rule is known —
  `months/<yyyymm>/<top|answer>-NNN.json` (provider response, JSON) is
  `statement-page`, the dataset the importer registered for the same key —
  but it is not applied. [ADR 0023](0023-vpass-collector-card-binding.md)
  established that a collector-vpass run
  cannot yet bind to the trusted card identity (the binding views accept only
  the importer's producer, the collector's sanitizer redacts the tuple, and no
  key is on the Worker). A parsed collector capture would become the current
  statement snapshot of its card-month (`current_vpass_snapshots` partitions
  by source, card unit and statement month, and the importer used the same
  keys and units) and retire the importer-era purchases with nothing to
  replace them. Unparsed, it is never an eligible snapshot. The rule moves
  into `ARTIFACT_DATASETS` only with the collector deriving the binding
  (ADR 0023, option 3); the test pins the withheld list, so that move is a
  visible change.

### Contract version: bumped to `terminal-registration-v2`, with carry-over

The table changes what a terminal means in CORE, so
`REGISTRATION_CONTRACT_VERSION` moves to `terminal-registration-v2`, and the
v1 derivation is kept (`DATASETS_BY_VERSION`) so a v1 registration stays
reproducible. What the bump does, read from the code:

- `collection_runs` is unique on (source, run_id, terminal_digest,
  registration_contract_version) and the scan is a full cyclic walk of
  `runs/`, so every persisted terminal gets a new row under v2 the next time
  the scan reaches it: **every source's runs, registered or blocked**.
- A plain re-registration would be a **second fetch run** (the version is in
  `sourceRunKey`) in the **same acquisition session** (the external session
  id is unchanged), over the same objects (`adoptObject` finds the same
  sha256; no raw object or byte is added), with new fetch artifacts, a new seal
  (its attempt id carries the version), a new observation work item and **new
  parse runs**.

That is what the already-sealed NULL runs need: fetch artifacts are
append-only, so a Mobile Suica run sealed under v1 (and a V Point Pay email
run sealed after #259) is made parseable only by a new registration whose
artifacts carry the dataset. It is also what doubles a capture that v1
already parsed. Registered again, a Mizuho capture is parsed twice, and
Mizuho history rows have no provider identity in the transaction list
(`mizuho-ordinary-history` is not among the parsers `TRANSACTIONS_SQL` groups
by external id, because the parser marks cross-page identity unproven), so
every one of its transactions would be listed twice and every balance would
show twice in the balance history. A first version of this change measured
exactly that on a synthetic Mizuho terminal: 2 → 4 listed transactions, 2 → 2
latest balances, 2 → 4 balance-history rows.

So the bump comes with **carry-over** (`carryOver` in `register-terminal.ts`):

- A v2 row for a terminal that an earlier version registered (sealed and
  linked) is **linked to that fetch run** — no second fetch run — when v2 does
  not change its descriptors: every artifact of the manifest is catalogued in
  that run with the same sha256 and the same descriptor digest v2 derives for
  it against that run, and the catalogue holds nothing else. The row gets a
  completed `registered` stage naming the fetch run and answers
  `already_registered`. Units, ranges, reports and the run request are the
  same derivation in both versions; a later version that changes one of them
  must extend the comparison.
- A terminal whose descriptors **do** change registers again as a new
  revision, as migration 0039 intends. v2 changes a descriptor only by giving
  an artifact a dataset, and only where v1 left it NULL, which no parser
  accepts outside Mizuho (Mizuho is not in the table). So every re-registered
  terminal's v1 artifacts were never parsed, and its capture is parsed once,
  under v2. `scripts/artifact-datasets.test.ts` proves this per artifact
  shape.
- A blocked, retryable or unfinished v1 row is not carried over: the terminal
  gets a fresh attempt under v2.

Migration 0039's comment says a changed contract "registers the run again as
a new revision instead of silently reusing the old one". Carry-over does not
change that for a terminal whose meaning changed; for one whose meaning did
not, it reuses the registration explicitly — a linked row and a stage naming
the fetch run — rather than silently. This ADR amends that design point.

INV06, per case:

- **Mobile Suica (13 runs sealed under v1) and V Point Pay email (sealed
  after #259).** Re-registered under v2: a second fetch run whose normalized
  artifact carries its dataset, parsed once. The v1 fetch run stays sealed and
  unparsed. The capture appears twice in the recorded views (fetch runs,
  artifacts), which list appearances and count nothing; transactions,
  balances and snapshots come from the one parse. Tested with a synthetic
  Mobile Suica terminal: sealed under v1 with no dataset and no parse, then
  under v2 one parse, two listed transactions, one current balance, and a
  redelivery changes nothing.
- **Mizuho (registered and parsed under v1).** Carried over: one fetch run,
  one set of parses. Tested: after v2, 2 artifacts in 1 fetch run, no new
  parse, 2 transactions, 2 latest balances, 2 balance-history rows, and the
  carry-over costs at most one preamble and one structure step of the budget.
- **St George (if registered under v1).** v1 already named its dataset;
  carried over.
- **Vpass.** Withheld in v1 and v2 alike, so carried over, and never parsed:
  `eligible_vpass_snapshots` requires a published parse of every statement
  page of a card-month, so nothing becomes current. Tested: a collector-vpass
  capture registered under v1 and v2 has no dataset, no job, no eligible
  snapshot and leaves card usage unchanged.
- **MyJCB.** Mapped, but not yet parseable from a terminal: the metadata
  extractor (`services/processor/src/metadata-extractors/myjcb.ts`) finds the
  manifest entry by `connectionId`/`filename`, which the shared collector's
  manifest does not carry, so a parse fails `manifest_artifact_mismatch`
  before it can publish and cannot displace the importer-era snapshots. Its
  jobs fail visibly; that is a recorded limit, not a double. (Read from the
  code; no test here registers a MyJCB terminal, since MyJCB terminals do not
  register today at all: P1.)
- **Blocked runs (P1, P2/P3; the 14 + 14 SBI runs).** Their v1 blocks are
  write-once on the v1 rows; under v2 each terminal gets one fresh attempt.
  A refusal about the terminal's own bytes repeats and blocks the v2 row too:
  the SBI terminals state lineage and unit counts the registration refuses
  (P2/P3), and a terminal is immutable, so the collector-side fix cannot
  change them. Those runs therefore block again, harmlessly (one attempt
  each, nothing sealed); only a refusal about CORE's configuration (a missing
  ingest route, which is `retryable`, not blocked) can succeed on the new
  attempt. Nothing is doubled: a blocked run has no seal and no parse.
  Terminals written before [ADR 0014](0014-collector-producer-ids.md) keep
  the producer no route declares, so under v2 they are refused as
  `inactive_ingest_route` again and stay `retryable` and unregistered, as
  ADR 0014 records; the bump does not register them.

## Consequences

- Every terminal gets a v2 row as the scan reaches it. Mobile Suica and V
  Point Pay email runs sealed under v1 become parseable; every other
  registered run is carried over; blocked runs are attempted once more.
- The health route's `unregistered` count now counts rows of the current
  version only: after the bump a v1 row that was retryable or unfinished is
  never worked again, and its terminal is counted under v2 when the scan
  reaches it. A v1 registration left `pending` at the deploy stays unsealed,
  and so invisible to every reader; its terminal registers afresh under v2.
- Merge order: after #259 (collector producer ids), so V Point Pay email runs
  sealed with NULL are among those made parseable. It does not need the
  collector-side lineage fix first: the SBI runs block again either way
  (above), which costs one attempt each.
- MyJCB parses fail at metadata extraction until the extractor reads the
  terminal-era manifest (see above).
- **Drain estimate** (from the constants and synthetic measurements, not a
  production measurement): `collection_scan` runs every five minutes, lists
  25 terminals, starts at most 5 registrations and continues at most 5
  pending ones, inside the 500-operation budget of #250; a carried-over or
  already registered terminal does not count against the 5. Metered on the
  synthetic terminals of `registration-datasets.test.ts`, a three-artifact
  Mobile Suica run costs 118 operations and a two-artifact Mizuho run 103; a
  carry-over costs at most 32 (asserted); ADR 0010 measured a 34-artifact
  Vpass card at two invocations. Fourteen days of every running source is on
  the order of 150–250 terminals. Most are carried over or blocked again
  (tens of operations each, so ten or more per tick); the re-registrations
  that seal are the 13 Mobile Suica runs plus the V Point Pay email runs
  sealed since #259, about four per tick. That is on the order of 15–30
  ticks, **about 1.5–3 hours** of cron time. The clock starts only once the
  scan walks the whole prefix: old terminals get no notification and are
  reached only through the scan, which is stuck on its first page in
  production until ADR 0024 lands.

## Verification

- `scripts/artifact-datasets.test.ts` (root `ci`): each collector artifact
  shape (Mobile Suica's from its real plan builder) maps to its dataset or to
  NULL; every mapped or withheld dataset is accepted by a registered parser;
  every dataset a parser requires from a shared-R2 source is mapped, withheld
  or named unreachable; every registered parser except PayPay's is reached;
  every rule is exercised; a wrong role or media type is never mapped; the
  withheld list is exactly Vpass; without the table only Mizuho's artifacts
  are read; v2 changes a descriptor only where v1 left an artifact no parser
  read.
- `services/processor/test/registration-datasets.test.ts` (every real
  migration, Miniflare): the three cases above — a Mobile Suica run sealed
  under v1 without datasets re-registers under v2 and parses once; a Mizuho
  run parsed under v1 is carried over by v2 and listed once; a collector-vpass
  capture under v1 and v2 is never parsed and moves no card snapshot.

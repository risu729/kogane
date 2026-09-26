# ADR 0022: Give registered shared-R2 artifacts their parser dataset, without a contract bump

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
- Merge order: after #259 (collector producer ids). It does not wait for the
  collector registration-contract PR (lineage and unit counts), because it
  re-registers nothing (see "Contract version").

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

### Contract version: not bumped

`REGISTRATION_CONTRACT_VERSION` stays `terminal-registration-v1`, against the
rule written next to it, because a bump double-counts. What a bump does,
read from the code:

- `collection_runs` is unique on (source, run_id, terminal_digest,
  registration_contract_version) and the scan is a full cyclic walk of
  `runs/`, so every persisted terminal is a new row under the new version and
  registers again: **every source's runs, registered or blocked**.
- `createRunRequest` puts the version into `sourceRunKey`, so each is a
  **second fetch run** in the **same acquisition session** (the external
  session id is unchanged). The objects are the same: `adoptObject` finds the
  same sha256, so no raw object and no byte is added. The fetch artifacts,
  the seal (its attempt id carries the version), the observation work item,
  the parse jobs and the **parse runs are all new**.
- A v1 block is write-once on its own row; the terminal gets one fresh attempt
  under v2, which blocks again whenever the refusal is about the terminal's own
  bytes (a lineage or unit count the collector stated wrongly cannot change in
  an immutable terminal) and succeeds only where the refusal was about CORE's
  configuration.

INV06, per case:

- **Mobile Suica (registered under v1).** Its v1 artifacts are NULL, which no
  parser accepts (`scripts/artifact-datasets.test.ts`: without the table only
  Mizuho's artifacts are read), so a v2 registration would be the first parse
  of each capture: no double. The capture would appear twice in the recorded
  views (fetch runs, artifacts), which list appearances and count nothing.
- **Mizuho (registered and parsed under v1).** The v2 registration is parsed
  again. The account list is an artifact container and latest balances rank
  one witness per account and metric, so balances stay once. But Mizuho
  history rows have no provider identity in the transaction list
  (`mizuho-ordinary-history` is not among the parsers `TRANSACTIONS_SQL`
  groups by external id, because the parser marks cross-page identity
  unproven), so **every transaction of the capture is listed twice**, and the
  balance history shows each balance twice.
  `registration-datasets.test.ts` registers one synthetic Mizuho terminal
  under the current and a second version: 2 → 4 listed transactions, 2 → 2
  latest balances, 2 → 4 balance-history rows.
- **St George (if registered under v1).** Transactions group by external id
  and balances are a container, so the lists stay once; the history would
  show two witnesses.
- **Vpass.** Withheld: every artifact stays NULL, no job is created, and
  `eligible_vpass_snapshots` requires a published parse of every statement
  page of a card-month, so nothing becomes current; the test registers a
  collector-vpass capture and shows no dataset, no job, no eligible snapshot
  and unchanged card usage.
- **MyJCB.** Mapped, but not yet parseable from a terminal: the metadata
  extractor (`services/processor/src/metadata-extractors/myjcb.ts`) finds the
  manifest entry by `connectionId`/`filename`, which the shared collector's
  manifest does not carry, so a parse fails `manifest_artifact_mismatch`
  before it can publish and cannot displace the importer-era snapshots. Its
  jobs fail visibly; that is a recorded limit, not a double. (Read from the
  code; no test here registers a MyJCB terminal, since MyJCB terminals do not
  register today at all: P1.)

Because the Mizuho case doubles, the version is not bumped. The table applies
to terminals **first registered** after this change; a run registered or
blocked before keeps what it has. The ways out, none decided here:

1. give Mizuho history rows a read-model identity (needs evidence that a row's
   fields identify it across pages, which the parser marks unproven);
2. let a new version reuse an earlier registration whose derivation it does
   not change (migration 0039 documents the opposite — a new version
   registers again rather than silently reusing — so this needs its own ADR);
3. re-register only the runs whose descriptors change.

## Consequences

- New Mobile Suica terminals register `sf-history.json` as `sf-history` and
  are parsed. The 13 Mobile Suica runs registered before stay NULL and
  unparsed until one of the ways out above is decided; their bytes and
  registrations are kept.
- Sources now blocked (P1, P2/P3) get the table when their terminals first
  register. Runs already blocked stay blocked: nothing here re-registers
  them. Without a bump, this PR has no ordering dependency on the
  collector-side lineage fix; it merges after #259.
- A registration left `pending` by the previous release when this one deploys
  can finish with artifacts catalogued before the table (NULL) and after it
  (mapped). Its seal compares the inventory with the catalogue and refuses a
  mismatch, so such a run blocks with `inventory_mismatch` rather than sealing
  a mixed derivation. Only small-run sources register today (Mobile Suica,
  three artifacts; Mizuho, whose derivation does not change), so this needs a
  budget yield inside a Mobile Suica run at the deploy; `/internal/health`
  shows it.
- MyJCB parses fail at metadata extraction until the extractor reads the
  terminal-era manifest (see above).
- **Drain estimate, for whichever way out is chosen** (an estimate from the
  constants, not a production measurement): `collection_scan` runs every five
  minutes, lists 25 terminals, starts at most 5 registrations and continues at
  most 5 pending ones, inside the 500-operation budget of #250. Metered on the
  synthetic terminals of `registration-datasets.test.ts`, a three-artifact
  Mobile Suica run costs 118 operations and a two-artifact Mizuho run 103;
  ADR 0010 measured a 34-artifact Vpass card at two invocations, and an
  eleven-artifact Mizuho run takes most of one. So about four small runs, or
  one large one, register per tick. Fourteen days of every running source is
  on the order of 150–250 terminals, roughly 50–100 ticks, **about 4–8 hours**
  of cron time. That clock starts only once the scan walks the whole prefix
  again: old terminals are reached only through the scan (no notification is
  sent for them), and the scan is stuck on its first page in production until
  ADR 0024 lands.

## Verification

- `scripts/artifact-datasets.test.ts` (root `ci`): each collector artifact
  shape (Mobile Suica's from its real plan builder) maps to its dataset or to
  NULL; every mapped or withheld dataset is accepted by a registered parser;
  every dataset a parser requires from a shared-R2 source is mapped, withheld
  or named unreachable; every registered parser except PayPay's is reached;
  every rule is exercised; a wrong role or media type is never mapped; the
  withheld list is exactly Vpass; without the table only Mizuho's artifacts
  are read.
- `services/processor/test/registration-datasets.test.ts` (every real
  migration, Miniflare): a Mobile Suica terminal registers `sf-history`, is
  parsed once and lists the same rows after a redelivery; a collector-vpass
  capture registers with no dataset, gets no job and changes neither the
  eligible Vpass snapshots nor card usage; one Mizuho terminal registered
  under two contract versions lists its transactions twice.

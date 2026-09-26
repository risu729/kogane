# ADR 0025: The MyJCB metadata extractor reads both manifest shapes

- Status: proposed
- Date: 2026-09-26
- Carried by:
  `services/processor/src/metadata-extractors/myjcb.ts`,
  [processor §3.4](../processor.md#34-artifact-datasets-adr-0022),
  [release adoption: metadata extraction](../release-adoption.md),
  [collection: MyJCB](../collection.md#myjcb-servicescollector-myjcb-kogane-myjcb-collector-poc),
  `services/processor/test/myjcb-metadata-shapes.test.ts`,
  `services/processor/test/myjcb-shared-r2.test.ts`
- Related: [ADR 0021](0021-collector-registration-contract.md) (the collector
  states the ledger's lineage), [ADR 0022](0022-registration-artifact-datasets.md)
  (registration gives MyJCB artifacts their parser datasets),
  [ADR 0005](0005-myjcb-statement-state-from-page.md) and
  [ADR 0007](0007-myjcb-statement-identity.md) (what the statement state and
  period are used for)
- Merge order: after #269 (ADR 0022) and #265 (ADR 0021); see Consequences.

## Context

Since U09 (2026-09-12) the MyJCB collector writes its runs to the shared
bucket through `myJcbRunPlan`. Three fixes let those runs register and give
their artifacts parser datasets: producer ids (#259, merged), the collector's
lineage (ADR 0021) and the dataset table (ADR 0022). A fourth thing stopped
the parse: the Processor's MyJCB metadata extractor.

The MyJCB parsers need a statement state and a period for each ledger and
statement page. The ledger parser refuses a ledger without them, and
`myjcbStatementSlot` in the read model partitions ledger captures by them.
They reach a parser, and `observation_fetch_artifacts` (`statement_state`,
`period`, through `observation_artifact_metadata`), only through the metadata
extractor, which reads them from the run's collector manifest. The terminal
does not carry them (`ranges: []`, and `terminal-v1` has no field for them).

The extractor finds an artifact's manifest entry by
`<connectionId>/<filename>`. The retired importer's central manifest had
those two fields in every entry (`MyJcbArtifactManifest` in
`services/collector-r2-importer/src/myjcb-schema.ts`, removed in #206). The
collector's own manifest does not. Its entries are `StoredArtifact`: `dataset`,
`key` (the content-addressed object key, `objects/<2 hex>/<sha256>`),
`mediaType`, `sha256`, `bytes`, and `statementState` and `period` when the
collector recorded them. So every shared-R2 MyJCB parse failed with
`manifest_artifact_mismatch` and published nothing. The values themselves are
in the manifest. Only the key to find them is missing.

## Options considered

1. **The collector writes `connectionId` and `filename` into its manifest.**
   That would fix future runs only. A terminal and its manifest are immutable,
   so every run already in the bucket would stay unparseable.
2. **The extractor reads the statement state and period from the ledger's own
   bytes** (`state` and `period` are inside `credit-ledger-NN.json`). That
   works for ledgers only, not for statement pages. It would also change what
   the value means: the value is the collector's manifest statement, which the
   ledger parser checks the ledger against.
3. **A second branch for the shared shape, keyed by the artifact's object.**
   The manifest entry names the object it describes (`sha256`, `bytes`,
   `key`), and the terminal artifact has the same digest and size. This works
   on every run already persisted, uses only what the collector wrote, and
   leaves the importer branch as it is.
4. **The same branch in a new extractor release** (`manifest-metadata-v3`).
   Parses run under `legacy-metadata-v1` unless an operator pins another
   release per dataset, so the default path would still fail. The inputs the
   new branch reads were refused by both existing releases, and no projection
   of them exists (see Consequences), so a new release would separate nothing.

## Decision

**Option 3.** The shared rule is used by both releases. `extractMyJcb` does
the following:

- It keeps the importer branch unchanged: find the entry whose
  `connectionId`/`filename` form the artifact key, check the dataset, check
  the value types.
- It takes the shared branch only when that lookup finds nothing **and** no
  entry carries `connectionId` or `filename`. These are the only inputs the
  importer branch refused with `manifest_artifact_mismatch` that the new
  branch reads. An importer-era manifest never reaches the new branch.
- In the shared branch:
  - The connection is the first segment of the artifact key (the terminal
    unit the collector wrote), and it must be a connection the manifest's
    `connections` lists.
  - The entry is the one that names this artifact's object: the same
    `sha256`, `bytes` equal to the raw object's size, and `key` equal to
    `objectKey(sha256)`. A missing object gives `manifest_artifact_mismatch`,
    and an object listed under another dataset gives
    `manifest_dataset_mismatch`.
  - When the same bytes are listed more than once (two connections with an
    identical empty ledger, say), the value is used only if every such entry
    states the same `statementState` and `period`. Otherwise the new code
    `manifest_artifact_ambiguous` is raised. The value is never chosen by
    position.
  - The value types are checked as in the importer branch. An entry without
    `statementState` or `period` gives null for it. When both are null the
    extraction is `absent`, as before.

Nothing the extractor emits is inferred:

| Value             | Importer shape               | Shared shape                                                 |
| ----------------- | ---------------------------- | ------------------------------------------------------------ |
| `statement_state` | the entry's `statementState` | the entry's `statementState` (the collector's `RawArtifact`) |
| `period`          | the entry's `period`         | the entry's `period`                                         |
| connection        | artifact key (and the entry) | artifact key only; the entry states none                     |
| position          | artifact key (and `ordinal`) | artifact key only; the entry states no `ordinal`             |
| media type        | not emitted (`mime: null`)   | not emitted (`mime: null`), although the entry states one    |

What the shared manifest lacks compared with the importer's is
`connectionId`, `filename` and `ordinal` per entry. The extractor emits none
of them in either shape. Connection and position come from the artifact key,
as before, so nothing a reader uses is lost. The shared entry's `mediaType`
keeps its parameters (`text/html; charset=utf-8`) while the terminal's does
not. Taking it would make `credit-menu.html` reachable (ADR 0022 names it
unreachable), which is a separate decision and is not taken here.

## Consequences

- With #269 (ADR 0022) and ADR 0021 on main, a shared-R2 MyJCB run's ledgers
  and statement pages no longer fail at metadata extraction.
  `observation_fetch_artifacts` has the collector's `statement_state` and
  `period`, the ledgers become current MyJCB snapshots, and purchase
  recognition recognises their rows under `collector-myjcb`. When a statement
  moves from the importer's producer to the collector's, events are retired
  and recognised again once (ADR 0014,
  `card-purchase-producer-switch.test.ts`).
- **That is still not enough for production runs to parse.** `myJcbRunPlan`
  reports every unit's coverage as `partial`, even for a successful
  connection, because a card exposes a rolling set of statement periods.
  Registration maps a partial unit to the unit outcome `partial`
  (`unitReportRequest`). A run with a non-success unit report is `partial` in
  `observation_fetch_runs`, and neither the run scope nor
  `unit-independent-v1` admits it, so the work item ends `not_eligible` and no
  parse job is created. `myjcb-shared-r2.test.ts` pins this. The importer
  wrote the connection's own status (`success`) as the unit outcome. This
  blocker is left open here. The collector cannot change the terminals it has
  already written, so the fix is a registration-side decision. The code shows
  GLOBAL PASS's plan does the same (unit coverage `partial` on success); that
  has not been exercised.
- For every input the importer branch completed, the output is identical,
  and every error it raised is raised again (tested against the extractor
  frozen at 396a370). No stored projection changes. `legacy-metadata-v1`
  writes `observation_artifact_metadata` only after a successful extraction.
  The shared inputs failed before, so they have no such row and no `ok`
  projection. The re-extraction route could have stored an `error`
  projection, but only for a registered shared MyJCB artifact, and none is
  registered: ADR 0022 records that MyJCB terminals are blocked
  `artifact_lineage_unstated` until ADR 0021. This comes from the code; no
  production survey was made for this ADR.
- `legacy-metadata-v1` is no longer exactly the rules from before A04. It is
  those rules plus the shared-shape lookup for inputs those rules refused.
  [release-adoption.md](../release-adoption.md) says so.

## Verification

- `services/processor/test/myjcb-metadata-shapes.test.ts`:
  - A differential over 4,000 generated manifests (seeded) against the frozen
    extractor (`myjcb-metadata-frozen.ts`). Every completed extraction is
    equal and every error is the same, except inputs the frozen extractor
    refused `manifest_artifact_mismatch` whose entries carry neither field.
    Each class is asserted to occur.
  - Shared-shape cases: lookup by object, `absent`, agreeing and disagreeing
    duplicates, another object, size or key, an unlisted connection, another
    dataset, and a wrongly typed value.
- `services/processor/test/myjcb-shared-r2.test.ts` (Miniflare, all
  migrations, the operator bootstrap):
  - The collector's real `myJcbRunPlan` output registers but is
    `not_eligible` (the open limit above).
  - The same plan, with only the unit's coverage set to `complete`,
    registers and parses: four jobs, no error. `observation_fetch_artifacts`
    carries the manifest's state and period, both ledgers are in
    `current_myjcb_snapshots` (each in its own statement slot:
    [ADR 0016](0016-myjcb-pending-statement-slots.md) for the pending
    ledger, the named payment month for the confirmed one), the statement total is published once, and purchase recognition
    recognises three rows (one `authorized`, two `captured`). A second pass
    changes nothing.
  - With the extractor from before this change, the same test ends with four
    parse errors.
- Existing MyJCB extractor tests (`metadata-projections.test.ts`,
  `pipeline.test.ts`, `myjcb-statement-replay.test.ts`) are unchanged and
  pass.

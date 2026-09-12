# Legacy retirement — 2026-09-13

The owner authorized removal of the legacy ingestion path, its Cloudflare
resources, and the CORE projection fallback. Original evidence was copied to
central DATA and verified before the old buckets were emptied.

## Completed resource retirement

| Resource                                        | Outcome                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `kogane-collector-r2-importer`, `kogane-ingest` | Deleted; fresh account listing confirms absence                                          |
| Old outbox reconciler Queue and DLQ             | Deleted after notification removal and empty-backlog verification                        |
| Old Vpass import Queue and DLQ                  | Deleted after consumer removal and empty-backlog verification                            |
| Twelve per-source R2 buckets                    | All 2,989 objects copied and SHA-256 verified; emptied and deleted                       |
| Current collection                              | 12 collectors write directly to shared DATA; no legacy target switch or importer binding |

The account now has 15 Kogane Workers, the central `kogane-raw-evidence` R2
bucket, and `kogane-collection-terminals` plus its DLQ. The central notification
rule (`runs/` + `/terminal.json`) and the two production Container applications
remain active. Resource identities are recorded in [the ledger](../infra/resources.md).

## Original evidence and historical repair

Every old object is mapped to `objects/<first two hex>/<sha256>` in central DATA.
The mapping is stored at `retirement/2026-09-13/legacy-object-map.jsonl`, with
SHA-256 `56b9ed5ad9199d90ae19c4f65ef7106be722fe5f3dce91243db1b1e888060e97`.
Fresh inventories after the shared-only release matched the frozen source keys,
sizes and ETags before deletion. SMBC Direct's 189 staged objects were also
preserved at their original `raw/smbc-direct/` keys so existing Durable Object
progress can resume through DATA.

A full historical importer repair pass completed for all twelve sources before
retiring the importer. Thirty SBI pages were rejected with
`yen_history_bundle_fields_invalid`; six V Point pages with
`manifest_unknown_field`. Their original bytes are preserved; retirement does
not claim those unsupported historical formats were successfully imported.
Eighteen old unsealed runs have sealed replacements in the same acquisition
sessions. The old attempts and runs remain as historical records, without
invented seals or rewritten outcomes.

The six retrievable old DLQ messages were preserved and verified at
`retirement/2026-09-13/legacy-dlq-messages.json` before acknowledgement. The
initial backlog metrics were larger than the messages actually retrievable;
this record claims only those six archived messages. All four old Queue
backlogs were zero before deletion. Future processing uses the shared terminal
Queue and bounded DATA scan. Historical repair from an archived format requires
an explicit parser or mapping change, not resurrection of the deleted Queue.

## CORE projection retirement

The READ-only App/Processor release `bdee142d49f840f8c53603702d783d2421eda5e6`
was deployed successfully by Actions run `34708232648` before preparing the
DROP migration. All six retired CORE tables contained zero rows.
Migration `0042_retire_legacy_projections.sql` removes:

- `balance_snapshot_pointer`, `current_balance_projection`, `scope_relations`,
  `balance_read_snapshots`;
- `expiry_estimates`, `conversion_simulations`.

It also deactivates the twelve `collector-r2-*` ingest clients. Their rows,
routes and historical foreign keys remain; `processor-shared-r2` remains active.
Canonical facts, decisions, receipts, reports, captured projection inputs and
original DATA objects are retained. A CORE export and Time Travel bookmark were
taken before retirement. Applied historical migrations are unchanged.

CD applies this migration before uploading scripts, which is why the earlier
READ-only production release is a prerequisite. After retirement, releases that
require the old Workers, buckets or CORE projections are not valid rollback
targets. Repair READ with [the rebuild runbook](read-rebuild-runbook.md); turning
features off pauses them and never restores a CORE projection fallback.

## Removed source

`services/raw-evidence`, `services/collector-r2-importer`, the Processor's
`legacy-import` tree and `packages/collection` legacy adapters are removed.
Tests register synthetic evidence through the same in-process application
operations as the Processor. The CD and CI ledgers contain only current services.

## Retired GlobalPass experiment — 2026-09-13

`kogane-globalpass-container-probe-20260827` was deleted using the WSL repo's
Wrangler after the owner authorized removal of unused Cloudflare resources.
Its separate Container application
`a032015d-4350-46d2-9a8b-724d8ac1f5cd` was also deleted. This was the dated
experiment, not the production `kogane-globalpass-collector-poc`.

Pre-deletion account and deployed-code checks established:

- No other Kogane Worker service binding referred to the probe; no tracked
  runtime/config reference, cron schedule or custom domain referred to it.
- It held no D1 or R2 binding and no secret bindings. The deployed handler
  required `PROBE_TOKEN` to start the experiment; that binding was absent.
- The Container application had no running instances. The probe's only Durable
  Object binding was its Container lifecycle class, alongside the existing
  `TAMIA` network binding. The shared network binding was retained.
- The September 6–12 invocation aggregate was two requests, zero errors and
  zero subrequests; this was not treated as zero traffic. The disabled handler,
  absence of instances and lack of callers established that collection was inactive.

A fresh account listing verified 17 remaining Kogane Workers and no live Worker
without repository configuration. Both production Container applications remain. The probe namespace was absent
from a fresh Durable Object namespace listing, and deleting its 15 dedicated
image tags left no probe image in the registry.

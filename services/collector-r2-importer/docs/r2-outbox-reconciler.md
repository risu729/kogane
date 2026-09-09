# R2 outbox reconciler

## Purpose and boundary

Each collector keeps its source R2 bucket as a durable, read-only outbox. The importer consumes only a collector's terminal object, validates the complete saved run with the existing strict source validator, and idempotently catalogues it in central raw evidence. The reconciler never writes to or deletes from a source bucket.

Cloudflare R2 Event Notifications deliver object-create messages to one Queue. Cloudflare Queues are at-least-once, so duplicate event notifications and continuation messages are expected; the existing immutable run keys, object hashes, and staged inventory make replay converge rather than create a second logical run.

The Queue consumer uses one message per batch and one concurrent consumer. Every deferred artifact chunk is enqueued as a new top-level Queue message, rather than recursively invoking another Worker, so the Worker invocation chain is reset between chunks. A non-advancing artifact offset, repeated R2 cursor, 1,024 import chunks, or 100,000 repair pages fails closed. Failed messages receive bounded exponential retry delay and, after the configured five retries, move to the dedicated DLQ.

Queue payloads necessarily contain the source R2 object key so the importer can read the terminal object. Application logs contain only lifecycle, message kind, allowlisted source, outcome/error code, and attempt count; they never include an object key, hash, source body, credential, or financial value.

## Entry points

The reconciler and the per-source HTTP routes execute the same application command. `processReconcilerMessage` parses the Queue message or R2 notification, converts the wire `resume` value into the internal resume state for the source's declared kind, and calls `importTerminal`, which the Worker implements with `executeImport` from `src/adapters/`; the source result is mapped back to the Queue contract by `reconcilerOutcome` (`sealed`, or `deferred` with the next `resume` and `progress`). `POST /v1/<source>/import-run` calls the same `executeImport` with that source's HTTP validation, and `POST /v1/<source>/backfill-page` calls it from the source's cursor state. Repair listing reads the bucket declared by the adapter's `repairPolicy`. The contract, the per-source budgets that stay in each adapter, and the CI registry check are described in [import-adapters.md](import-adapters.md).

## Terminal notifications

Only `PutObject`, `CopyObject`, and `CompleteMultipartUpload` notifications from the configured Cloudflare account, exact bucket, source prefix, and suffix are accepted. The Worker validates the complete official R2 notification shape before use.

| Source            | Bucket                              | Prefix                    | Terminal suffix |
| ----------------- | ----------------------------------- | ------------------------- | --------------- |
| SBI Securities    | `kogane-sbi-collector-poc`          | `raw/sbi-securities/`     | `manifest.json` |
| SBI VC Trade      | `kogane-sbi-vc-trade-poc`           | `raw/sbi-vc-trade/`       | `manifest.json` |
| Sony Bank         | `kogane-sony-bank-collector-poc`    | `raw/sony-bank/`          | `manifest.json` |
| SBI Shinsei       | `kogane-sbi-shinsei-collector-poc`  | `raw/sbi-shinsei/`        | `manifest.json` |
| Mobile Suica      | `kogane-mobile-suica-collector-poc` | `raw/mobile-suica/`       | `manifest.json` |
| GLOBAL PASS       | `kogane-globalpass-collector-poc`   | `raw/prestia-globalpass/` | `manifest.json` |
| MyJCB             | `kogane-myjcb-collector-poc`        | `raw/myjcb/`              | `manifest.json` |
| MoneyForward      | `kogane-moneyforward-collector-poc` | `raw/moneyforward/`       | `manifest.json` |
| V Point           | `kogane-vpoint-collector-poc`       | `raw/v-point/`            | `manifest.json` |
| V Point Pay email | `kogane-vpoint-pay-collector-poc`   | `raw/v-point-pay-email/`  | `.json`         |
| Vpass success     | `kogane-vpass-collector-poc`        | `vpass/`                  | `manifest.json` |
| Vpass failure     | `kogane-vpass-collector-poc`        | `vpass/`                  | `error.json`    |
| SMBC Direct       | `kogane-smbc-direct-backfill-poc`   | `raw/smbc-direct/`        | `manifest.json` |

Vpass's two suffixes are disjoint, so the two rules do not produce conflicting notifications. V Point Pay emits only the normalized `.json` notification: the collector now commits the source `.eml` first and the normalized JSON second, making JSON the terminal pair boundary.

## Missed-event repair

The Cloudflare Cron `23 19 * * SUN` runs weekly at Sunday 19:23 UTC (Monday 04:23 JST). It seeds one repair scan per source. A repair message lists at most 50 R2 objects, emits each discovered terminal as an independent import message, and independently emits the next scan cursor. Therefore, a malformed terminal run can retry and reach the DLQ without blocking later object keys. If a repair-chain message itself is lost, the next weekly scan starts from the beginning; idempotent import makes this safe.

No GitHub Actions schedule is used.

## Production activation: 2026-09-07

The authorized production rollout created the main queue `357f6274ad564f31807b854ebcb7d360` and DLQ `471f0074e8da498f835cfc33904ff44e`. Importer version `75cc8c7e-88f5-436f-a64b-9e796b071f0a` successfully attached the producer, one consumer, and `23 19 * * SUN` Cron. The earlier numeric Sunday expression (`0`) was rejected by Cloudflare; using the documented day name fixed deployment. No source collector schedule was changed.

All 13 managed notification rules across 12 buckets were created and individually verified against their exact account/bucket/queue/filter/actions/description. Their cleanup authority is retained in the ignored mode-0600 state file described below. Exactly 12 repair seed messages were accepted by the Queue API to start the historical reconciliation. This starts an asynchronous paginated scan and is not a claim that every historical run has finished importing.

Operational verification uses aggregate output only:

```sh
bun scripts/r2-reconciler-ops.ts status
bun scripts/r2-reconciler-ops.ts watch 300
# Only when another full repair scan is intended:
bun scripts/r2-reconciler-ops.ts seed I_UNDERSTAND_THIS_CHANGES_CLOUDFLARE
```

`status` reads both queues and their best-effort backlog metrics. `watch` keeps raw tail events in memory and emits only validated reconciler lifecycle/source/outcome/attempt aggregates; it discards other logs, object keys, message bodies, and credentials. It stops its tail process after the requested 10–900 seconds. `seed` uses the same twelve bounded seed messages as the weekly Cron, and never modifies source R2 objects. The helper uses the official [Queue metrics](https://developers.cloudflare.com/api/resources/queues/methods/get_metrics/) and [message batch](https://developers.cloudflare.com/api/resources/queues/subresources/messages/methods/bulk_push/) APIs.

Deployment validation: 280 tests passed, zero failed; generated bindings and TypeScript check passed. No cleanup or queue deletion was performed during activation.

The initial 300-second tail observed 31 processed events: 13 repair pages (all twelve sources reached), five deferred import continuations, and 13 sealed import outcomes (GLOBAL PASS 9, Vpass 1, V Point 3), with zero retry outcomes in that sample. At 2026-09-07 14:22:38 UTC the queue metrics showed 127 outstanding messages and DLQ zero. The backlog includes further historical scan and import work; completion and historical poison-message status were not yet established. The consumer's live settings matched batch size 1, concurrency 1, five retries, and the dedicated DLQ. A second notification-helper invocation verified all 13 rules without creating duplicates.

Follow-up at 2026-09-07 14:39:18 UTC: outstanding messages 114, DLQ zero, all 13 rules reverified, and the live Cron still `23 19 * * SUN`. The oldest-message timestamp advanced from `1788790658901` to `1788791293932` between the 14:37 and 14:39 checks, consistent with ongoing queue progress; metrics are best-effort. A bounded 120-second tail received no events and no child-process failure, so it did not establish source-specific success/error counts for that interval. No additional repair seeds were sent. Historical reconciliation is still outstanding, and a zero DLQ count is not proof that every source succeeded.

The V Point Pay writer side of #105 was also deployed on 2026-09-07: `kogane-vpoint-collector-poc` version `89bcdeee-e128-42df-b936-d214c427906b` replaces `d56d1b92-7afe-4504-a9ad-e24727b31d27` (uploaded before the #105 merge). The clean merged V Point subtree writes EML before terminal JSON. All 41 V Point tests, generated types/TypeScript, and deployment dry run passed, including partial-pair failure recovery. Deployment used `--keep-vars`; its existing `15 21 * * *` collector Cron and bindings were retained. No collection, email, secret update, or route change was triggered for verification.

Final bounded queue audit at 2026-09-07 15:08 UTC: backlog 112, DLQ zero, Cron and single-consumer settings unchanged. A non-destructive peek returned a 12-message sample: GLOBAL PASS imports 8, Vpass import 1 and repair page 1, V Point imports 2; every sampled attempt count was zero. The 90-second tail again received no events. These samples do not establish per-source reconciler errors or a complete drain. Serial concurrency, independent historical pages, and multi-chunk imports are expected to take time; a specific runtime bottleneck was not established, and best-effort oldest-message timestamps were not monotonic between checks. No reseeding, acknowledgements, purges, or queue changes were performed.

The same audit found MoneyForward already had 10 sealed successful Layer A runs, with 480 monthly HTML artifacts, 40 account-detail artifacts, and 10 accounts-index artifacts. Its missing Layer B coverage was a separate MIME-routing mismatch: the central importer deliberately declares exact HTML bytes as `text/html`, while the parsers accepted only `text/html; charset=utf-8`. The prepared parser fix accepts both exact declarations while preserving strict UTF-8 and all metadata/body checks (monthly parser 2.0.1, evidence parser 1.0.1); 12 parser tests and an actual-workerd D1/R2 routing regression passed. This audit does not claim that all twelve sources have completed Layer B parsing. The latest successful-parse coverage still showed eleven source IDs before the fix's deployment.

After deploying that routing correction, a second, distinct MoneyForward incompatibility became visible: all ten existing runs used the legacy import contract and ordinal `account` units. Six failed bodies (three monthly and three account-detail) were checked in memory against their recorded SHA-256 and byte size; each rejected with the fixed category `moneyforward account identity metadata is invalid`. Accounts-index parsing succeeded. The parser's stable account identity requirement was not relaxed.

The authorized corrective backfill resolved exactly those ten existing source terminals from integrity-verified central manifests, checked the matching source run identity read-only, and skipped any already sealed v2 counterpart. It called the current importer's private service binding with normal five-artifact continuation chunks and a bounded per-run chunk limit. The `moneyforward-r2-v2` contract derives stable keyed account identities from verified source evidence and creates separate immutable v2 runs; legacy runs and source objects remain unchanged.

Final read-only verification confirmed exactly ten v2 runs, ten seals, 530 provider-response artifacts, and ten collector manifests, alongside the unchanged ten legacy seals. There were 120 successful chunk responses overall, including ten idempotent replay chunks after one `central_500_internal_error` at the seventh run's final seal. The resumed pass skipped the six already sealed runs and successfully sealed all four remaining targets; the error did not recur and its underlying cause was not established. A read-only CLI preflight failure also recovered within bounded retries; its discarded stderr did not support retrospective classification. No import process remained running after completion.

At that final import check, MoneyForward successful parse coverage was 490 artifacts across 20 legacy/v2 runs (including legacy accounts-index successes). The 520 legacy identity-rejection jobs remained visible and unchanged, and downstream catch-up was still processing newly sealed v2 evidence. This verifies complete targeted Layer A v2 backfill, not complete Layer B parsing or a drained reconciler queue; the parent rollout performs the final downstream coverage check.

### Targeted v2 replay interface

The activation used a temporary, non-committed Node operator script and temporary local proxy configuration, not a new production endpoint or a committed private inventory. Its maintained interface is the existing private service-binding route `POST /v1/moneyforward/import-run`. Before replay, resolve and verify the exact legacy source terminal, compare its central manifest SHA-256/size and source run identity, and skip a sealed `full-snapshot-moneyforward-r2-v2` counterpart for the same acquisition session. Do not obtain targets by indiscriminate queue reseeding.

A temporary local Wrangler configuration can bind `IMPORTER` to the existing `kogane-collector-r2-importer` service with `remote: true`, the verified account ID, and the current compatibility date. With that configuration, the following Node module illustrates the bounded maintained request/continuation interface (all values below are placeholders, never paste private terminal keys into logs):

```js
import { getPlatformProxy } from "wrangler";
const proxy = await getPlatformProxy({
  configPath: "/absolute/path/to/temporary-operator-config.jsonc",
  persist: false,
  remoteBindings: true,
});
try {
  const manifestKey = "<verified exact source terminal key>";
  let continuation;
  let previousOffset = -1;
  for (let chunk = 0; chunk < 200; chunk++) {
    const response = await proxy.env.IMPORTER.fetch(
      "https://importer.internal/v1/moneyforward/import-run",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifestKey, ...(continuation ? { continuation } : {}) }),
      },
    );
    if (!response.ok) throw new Error("import request failed; inspect safe error category");
    const result = await response.json();
    if (result.status === "sealed") break;
    if (
      result.status !== "deferred" ||
      typeof result.continuation !== "string" ||
      !Number.isSafeInteger(result.nextOffset) ||
      result.nextOffset <= previousOffset
    ) {
      throw new Error("invalid or stalled continuation");
    }
    continuation = result.continuation;
    previousOffset = result.nextOffset;
    if (chunk === 199) throw new Error("bounded chunk limit reached");
  }
} finally {
  await proxy.dispose();
}
```

Run the temporary module with Node from a workspace containing the installed Wrangler dependency. The operator's existing Wrangler authorization is used internally by the proxy; do not export or print a token. Verify sealed run and artifact-role counts read-only afterward. This replays existing evidence only; it never invokes collection or writes source R2.

## Provisioning

The checked-in notification helper defaults to a read-only plan. Review current resources before any change:

```sh
cd services/collector-r2-importer
bun scripts/r2-reconciler-notifications.ts plan
npx wrangler queues list
```

Provision in this order so notifications never target a queue without a consumer:

```sh
npx wrangler queues create kogane-r2-outbox-reconciler-dlq
npx wrangler queues create kogane-r2-outbox-reconciler
bun install --frozen-lockfile
bun test
bun run typecheck
bun run cf:check
npx wrangler deploy
bun scripts/r2-reconciler-notifications.ts apply I_UNDERSTAND_THIS_CHANGES_CLOUDFLARE
```

The helper retrieves Wrangler's active credential only in memory and uses Cloudflare's read-only List Event Notification Rules API to verify the exact account, bucket, queue, description, prefix, suffix, actions, and unique rule ID after every creation. It atomically records those rule IDs in the ignored, mode-`0600` file `scripts/.r2-reconciler-notifications.state.json`. An interrupted `apply` resumes from the verified file. If the local file is lost, `capture` can reconstruct it only from unique, exact managed rules; inspect its rule count before removal:

```sh
bun scripts/r2-reconciler-notifications.ts capture
```

Wrangler's human-readable `notification list` output currently omits rule descriptions, so it is not a sufficient cleanup authority. The helper queries the official API response instead. Do not copy object keys or Queue message bodies into an issue or PR.

The commands and message shape follow Cloudflare's current official documentation:

- [R2 Event Notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)
- [List R2 Event Notification Rules API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/event_notifications/methods/list/)
- [Queues delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [Queues batching, retries, and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

## Cleanup inventory and order

The complete cleanup set for the deployed reconciler is:

1. 13 R2 notification rules across 12 source buckets.
2. Cron Trigger `23 19 * * SUN` on `kogane-collector-r2-importer`.
3. Queue producer binding `OUTBOX_RECONCILER_QUEUE` and consumer for `kogane-r2-outbox-reconciler`.
4. Queue `kogane-r2-outbox-reconciler`.
5. DLQ `kogane-r2-outbox-reconciler-dlq` and any retained poison messages.
6. Non-secret var `RECONCILER_ACCOUNT_ID`.

Remove notifications first:

```sh
bun scripts/r2-reconciler-notifications.ts remove I_UNDERSTAND_THIS_CHANGES_CLOUDFLARE
```

Before the first deletion, the helper verifies every recorded rule ID against the live description, bucket, queue, prefix, suffix, and exact three object-create actions. Missing, duplicated, ambiguous, or changed rules fail closed. It then removes only one recorded ID at a time with `wrangler ... notification delete --rule`; it never performs queue-wide notification deletion. The local state is updated after each verified deletion so an interrupted cleanup is resumable.

Then deploy a reviewed importer configuration that removes the Cron and Queue producer/consumer. Only after delivery is stopped and any DLQ evidence has been reviewed should an operator explicitly delete the two queues. Queue deletion is destructive and is deliberately not included in the helper.

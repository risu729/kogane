# R2 outbox reconciler

## Purpose and boundary

Each collector keeps its source R2 bucket as a durable, read-only outbox. The importer consumes only a collector's terminal object, validates the complete saved run with the existing strict source validator, and idempotently catalogues it in central raw evidence. The reconciler never writes to or deletes from a source bucket.

Cloudflare R2 Event Notifications deliver object-create messages to one Queue. Cloudflare Queues are at-least-once, so duplicate event notifications and continuation messages are expected; the existing immutable run keys, object hashes, and staged inventory make replay converge rather than create a second logical run.

The Queue consumer uses one message per batch and one concurrent consumer. Every deferred artifact chunk is enqueued as a new top-level Queue message, rather than recursively invoking another Worker, so the Worker invocation chain is reset between chunks. A non-advancing artifact offset, repeated R2 cursor, 1,024 import chunks, or 100,000 repair pages fails closed. Failed messages receive bounded exponential retry delay and, after the configured five retries, move to the dedicated DLQ.

Queue payloads necessarily contain the source R2 object key so the importer can read the terminal object. Application logs contain only lifecycle, message kind, allowlisted source, outcome/error code, and attempt count; they never include an object key, hash, source body, credential, or financial value.

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

The Cloudflare Cron `23 19 * * 0` runs weekly at Sunday 19:23 UTC (Monday 04:23 JST). It seeds one repair scan per source. A repair message lists at most 50 R2 objects, emits each discovered terminal as an independent import message, and independently emits the next scan cursor. Therefore, a malformed terminal run can retry and reach the DLQ without blocking later object keys. If a repair-chain message itself is lost, the next weekly scan starts from the beginning; idempotent import makes this safe.

No GitHub Actions schedule is used.

## Provisioning (not performed by this change)

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

This PR does not create any Cloudflare resource. If the reconciler is deployed later, its complete cleanup set is:

1. 13 R2 notification rules across 12 source buckets.
2. Cron Trigger `23 19 * * 0` on `kogane-collector-r2-importer`.
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

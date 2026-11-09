# V Point Pay app API implementation note

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-31

VポイントPay (V Point Pay) is a prepaid ledger separate from Vポイント (V Points)/Vマネー (V Money)
My Page and Vpass. Official Play package: `com.smbc_card.vpoint`. Analyzed candidate APK 2.5.0 in WSL with
JADX 1.5.6/apktool 3.0.3, reproduced an ordinary DEX loader, decrypted 8,300-byte protected DEX. Binaries/all
analysis outputs stay in private archive; no secrets/actual data/decryption keys/app distributions in Kogane.

## Conclusion

No need to run browsers/Android each time. If refresh tokens/random device UUIDs can be safely carried from
initial legitimate app registration, standard Workers `fetch()` can renew tokens/retrieve balances/all available
monthly statements. PoC in `services/collector-vpoint-pay/`.

Established APIs:

| Method | Path                                                     | Purpose                                              |
| ------ | -------------------------------------------------------- | ---------------------------------------------------- |
| POST   | `/vpoint/api/v2/token`                                   | Authorization code / refresh token grant             |
| GET    | `/vpoint/api/v2/prepaid/balance`                         | Currency/balance/top-up limit/earliest inquiry month |
| GET    | `/vpoint/api/v1/prepaid/transaction?target_month=yyyyMM` | Monthly statements                                   |

Token responses include access token, generation time, validity seconds, rotated refresh token.
Authenticated reads use `X-Vapp-Access-Token`. Shared headers: app version, Android OS, WebView-style
User-Agent, no-cache, `device_id`.

Monthly statements contain use date/description/original currency-amount/billing currency-amount/transaction-
ATM-exchange fees/exchange rates/settlement statuses/authorization numbers/remarks/activity-transaction types.
Do not infer actual enums/original-refund linkage before live responses.

## Protected DEX and device headers

APK asset `assets/nhnltyyy` was AES-128-CBC encrypted with asset-name Java hash as mask. Restore two 16-byte
loader arrays, mask-XOR second as key/first as IV, remove PKCS#7 padding → Dalvik DEX 037. Reproduction scripts,
hashes/tool versions/JADX-apktool outputs saved privately.

Decrypted `EncryptDevice` deterministically transforms UUID hex/current epoch seconds/weighted checksums.
Header generation uses no Android Keystore/hardware keys/Play Integrity/device-specific signing. UUID as
secret therefore permits Worker porting.

No certificate pinning found in ordinary Retrofit clients; network security config only prohibits cleartext.
Static analysis does not establish production acceptance.

## Retrieval and storage policy

Scan from balance `inquiry_period` earliest month through current JST month; do not infer fixed retention
from FAQs. Save monthly raw responses privately in R2; retain later authorization-settlement/cancellation/
refund changes as snapshot differences.

Refresh tokens rotate: only initial value in Worker secrets; subsequent values in one Durable Object. No
tokens/UUID/access tokens in R2/logs. On refused refresh such as 401, no repetition; reauthenticate through
legitimate app/update secrets.

## Incomplete live checks

- Existing user registration on owner account (phone/SMS/six-digit app passcode)
- Safe one-time refresh token/Realm device UUID extraction
- Worker refresh/balance/all monthly transactions
- Actual `inquiry_period`, enums, empty months, refresh lifetime, device revocation behavior

Payment/top-up/points transfer/card settings/other write APIs out of implementation scope.

## Cloudflare live probe

Deployed dedicated Worker/R2 on 2026-08-31. Standard Worker `fetch()` reached unauthenticated
`/vpoint/api/v2/common_settings` with statically identified app/OS/User-Agent/device headers; HTTP 200 JSON.
Response not account data, not stored in R2.

This shows requests are not rejected for the Cloudflare edge IP or TLS fingerprint alone. It does not prove
authenticated-API token/device binding.
After owner app bootstrap, verify refresh/balance/transactions individually.

## Supplementary notification email ledger

Official emails supply usage/top-up/balance addition/decline events even without app sessions. Separate source
supplementing gaps, not authoritative replacement for app statements. Added ingestion to existing
`services/collector-vpoint/` Email Worker, saving original EML/normalized JSON to V Point Pay private R2.
Gmail forwarding wraps originals in inline `message/rfc822`; validate inner official senders, not outer Gmail senders.

After registered email changed to `vpointpay@takuk.me`, save direct official delivery then forward to Gmail.
Do not reforward Gmail-backfilled `message/rfc822` notifications. Distinguish transport shapes explicitly,
preventing loops without losing ordinary notices.

Backfilled 85 existing notices on 2026-08-31, all saved without duplicates by hash keys. Compared same-time
149 V Points history entries using explicit points amounts/JST calendar dates only. Of 34 comparable entries,
11 matched/23 mismatched/zero ambiguous; 51 excluded. No live app snapshots, so email/app comparison unperformed.

Do not rewrite source events due to mismatches. When app APIs recover, reconcile email/app transactions/
V Points history independently, adding authorization/settlement/refund differences to reports. Unmatched stays unknown.

## Layer A: central ingestion of notification email evidence

Historical Importer route retired on 2026-09-13. Importer (`services/collector-r2-importer`), audit scripts,
collector Service Binding, historical scan/backfill scripts no longer exist. Old bucket pairs copied/verified
in central DATA ([legacy-retirement.md](../legacy-retirement.md)); new notices written directly to shared DATA
by `services/collector-vpoint` as `v-point-pay-email` runs
([collection.md](../collection.md#v-point-pay-email-email-route-of-servicescollector-vpoint)).

App polling in `services/collector-vpoint-pay` stopped in PR #60; this ingestion does not reenable it.
Existing source only official notice pairs saved by `services/collector-vpoint`.

- `raw/v-point-pay-email/{date}/{message-sha256}.eml`: Internet Message Format from EmailEvent/forwarded RFC822 parts
- `raw/v-point-pay-email/{date}/{message-sha256}.json`: legacy `vpoint-pay-email-event-v1` or envelope-provenance `vpoint-pay-email-event-v2` normalized events

Importer checks exactly two same-prefix objects, key date/RFC Date, raw SHA-256/key ID, schema-specific exact
custom metadata/media types/RFC5322 From/target subjects/strict JSON. Independently recomputes EML events,
replicates centrally only on exact normalized JSON match. v2 pins EmailEvent SMTP envelope From/To,
direct-versus-forwarded RFC822 storage boundary, outer checksums. EmailEvent exposes no trusted SPF/DKIM/DMARC
results; infer no authentication from RFC headers. Use
`authenticationProvenance=not-exposed-by-cloudflare-email-event`, `sourceVerification=source_unverified`.
Do not fabricate envelope provenance for 85 old v1 pairs; legacy unverified with transport `unknown`.

Old history lacked R2 native SHA-256 on storage; bind recomputed bounded-body SHA-256 strictly to keys/pairs/
central checksums. Existing native checksums must match recomputation too; new raw/JSON storage sets both.
Audits report native checksum presence only in aggregate counts, not absence as value mismatch.

Centrally map external `v-point-pay-email` to canonical `v-point-pay`. Raw `user_capture / unknown` claims no
provider provenance; JSON `collector_derived / transformed` has raw lineage. Seal one message unit/two artifacts/
`email_batch` inventory. Fixed `vpoint-pay-email-r2-v2` contract governs `producerVersion`/`sourceRunKey`,
so deployment revision changes still idempotently replay pairs into the same runs.

`derived/v-point-pay-email-reconciliation/...` is another collector summary comparing V Points history,
canonical source `v-point`. Email Importer does not scan it, nor app snapshot prefixes; email is not an app statement substitute.

Historical scans use HMAC-signed opaque cursors, scanning objects individually, importing per `.json`.
Skip `.eml` in scans because corresponding JSON validates it. Responses/scripts emit only counts/fixed codes,
no source keys/individual hashes/bodies/values/tokens. Import failures return no continuations/advance no
cursors; same input retries same pairs. No source R2 writes/deletes.

At the time, central ingestion was attempted with `waitUntil` after new email saves; failures rescanned from
source R2. Audit/backfill scripts/Service Binding retired with Importer on 2026-09-13. No GitHub Actions cron;
existing collector schedules/retired app polling settings unchanged.

## Layer B: financial observations from notification events

Layer B reads only `normalized-event.json` of centrally canonicalized `v-point-pay` `notification-event`.
Paired `notification-mail` is evidence only, no parser. Avoid double counting original/normalized as one transaction.

Notices do not claim settlement/confirmed sales. Non-declined events go to `v-point-pay:notification-events`
with `status=notified`: `usage` outflow, `charge`/`balance-addition` inflow, normalizing displayed amount signs
only, not confirmed prepaid cashflows. `declined` retains `status=declined` as failed attempts; amounts only
in `extra`, not typed cashflow.

Even with `usedPoints`, do not infer two legs splitting total usage into prepaid yen/V Points. Retain total/
points in `extra`. Create separate `v-point-pay:prepaid-yen` balance snapshots only with `balanceYen`.
Avoid showing points-first payments as confirmed full prepaid-yen outflows; preserve later app reconciliation.

Parser validates same exact v1/v2 schemas as Layer A, event identities/canonical UTC/subject-event types/
v2 envelopes/integer amount bounds, rejecting non-successful/non-failure-free runs. Current transactions
collapse identity replays; current balances select latest event time in successful runs, not insertion order.
Anonymous fixtures pin four types, dual-route refusal, notice status-signs, no funding split inference,
declined amounts, balance account separation, schema/provenance drift, failed runs.

`services/collector-r2-importer/scripts/audit-v-point-pay-layer-b-r2.sh` was a production canary running Layer B
after pair validation (retired with Importer 2026-09-13). Localhost-only Worker/remote read-only R2, returning
only aggregate object/observation types, no keys/hashes/bodies/amounts/balances/points/authentication.
No deploy/R2-write/delete paths.

## Addendum: switch to shared DATA R2 (U09)

`services/collector-vpoint-pay` ignores `COLLECTION_TARGET`. Only binding `DATA` (`kogane-raw-evidence`).
Durable Object stores through `packages/collection` at `objects/<2hex>/<sha256>`, writing
`runs/v-point-pay/<runId>/terminal.json` last. Result `target` only `"shared"`. Artifacts:
`balance.json`/`transactions-yyyyMM.json` (role `collector_derived`), `collection-summary.json`
(role `collector_summary`), bytes unchanged. Terminal `requestedScope`: `month_range` from `inquiry_period`
through current month; if failures leave range unknown, use `unspecified`, no inference. No refresh tokens/
device UUIDs/access tokens in artifacts/logs; fixed machine failure codes only.

App collector remains stopped; add no Cron/triggers. Durable Object in-flight exclusion/class-tag, Worker names,
bucket bindings unchanged. Notice collection remains `services/collector-vpoint` `v-point-pay-email` runs.
Switch order/rollback in `docs/collection.md`.

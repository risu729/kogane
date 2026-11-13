# V Point Worker PoC

This PoC uses an authenticated `Vポイント` (V Point) My Page session to capture balances, expiry buckets, SMBC-derived breakdowns and up to 3 years of V Point history, plus `Vマネー` (V Money) balances and up to 3 years of history, from first-party JSON APIs. Raw responses go to shared DATA (`kogane-raw-evidence`). V Point Pay and Vpass details are excluded because they have separate services, authentication and ledgers.

`packages/collection` writes runs directly to shared DATA and writes the terminal last. A run that cannot write its terminal is not treated as successful. The Processor registers DATA terminals in-process ([processor.md](../../docs/processor.md)). The Service Binding to `kogane-collector-r2-importer`, dedicated source bucket and backfill routes/scripts were retired on 2026-09-13 ([legacy-retirement.md](../../docs/legacy-retirement.md)).

## Runtime profile

- **Browser: none.** It uses neither Cloudflare Browser Run, Container Chrome/Chromium nor existing browser cookies.
- Worker `fetch` follows the first-party form chain, an Email Worker receives authentication codes, and a SQLite Durable Object retains short-lived sessions for JSON-API capture.
- Kogane Capture Chrome was used only for owner verification of endpoints/schemas; the production collector starts no browser.

<a id="liveで確認したデータソース"></a>

## Live-verified data sources

The following were verified with the user's account in Kogane Capture Chrome on 2026-08-31. Values, merchants, cookies, member numbers and personal information are not stored in this repository.

- `POST https://mypage.tsite.jp/api/balance_info`
  - `results.common[]`: `point`, `expiration`, `point_type`
  - `results.store[]`: store-limited expiry buckets.
  - `results.tmoney`: V Money balance/expiry; an empty object in the live account.
- `POST https://mypage.tsite.jp/api/tpoint_history`
  - multipart `page`, `get_graph`, `sort` and all history filters.
  - The live account had `total=149`: pages 1–4 each had 30 records, page 5 had 29, and terminal page 6 had 0; all returned HTTP 200 / application status `0000`. The PoC stops on page 5 once total is reached.
- `POST https://mypage.tsite.jp/api/smfg_point`
  - `results.get_point.point_smbc`, `point_smcc`
- `POST https://mypage.tsite.jp/api/tmoney_history`
  - multipart `page`, `sort` and all usage/top-up/cancellation/expiry/migration/refund history filters.
  - Uses the same My Page session as V Point history.
  - The live account returned HTTP 200 / application status `0000`, `total=0`, `history=[]`.

The [official V Point FAQ](https://ssl.help.tsite.jp/faq/show/25463?site_domain=qa-tsite) explains that V Money history is available in the same My Page, limited to the past 3 years. The [official top-up guide](https://t-point.tsite.jp/finance/tmoney/charge/ptcharge/) also explicitly distinguishes V Money from `三井住友カード` (Sumitomo Mitsui Card) V Point Pay. V Money is a separate electronic-money ledger, but belongs to this collector's authentication boundary/data sources and is collected in the same run.

<a id="認証とsession自動更新"></a>

## Authentication and automatic session renewal

My Page APIs return HTTP 200 even without authentication, but application status is `0010`; authenticated status is `0000`. On 2026-08-31, Kogane Capture Chrome traffic was compared with browserless live requests, confirming that a session can be created using a V member number and email authentication, without a password.

The first-party login form chain follows below. Hidden fields and Struts tokens pass between screens, and Windows-31J responses are decoded. In the sequence, `V会員番号` means "V member number", `メール送信` means "send email", and `メール認証コード` means "email authentication code".

```text
GET  /tm/pc/login/STKIp0018001.do
POST /tm/pc/login/STKIp0002010.do
POST /tm/pc/login/STKIp0002011.do  (V会員番号)
POST /tm/pc/login/STKIp0002040.do
POST /tm/pc/login/STKIp0002042.do  (メール送信)
POST /tm/pc/login/STKIp0002045.do  (メール認証コード)
POST https://mypage.tsite.jp/api/user_info
```

Consecutive live emails had 4-, 5- and 6-digit authentication codes, so no fixed length is assumed. Emails state a 1-minute validity period. Final `POST /api/user_info` cannot be omitted: it issues My Page `SESSIONID`. Going directly to `/api/balance_info` without it returns `0010`.

In the production PoC, a single SQLite Durable Object instance retains:

- A valid My Page session cookie.
- Serializable challenge state usable for one minute, only while awaiting email.

A run without a session, or receiving `0010`, requests a new authentication email. A Cloudflare Email Routing rule scoped to the target address delivers to this Worker's `email()` handler, which forwards the original message to the existing Gmail destination and extracts the code. Once the Durable Object completes login, collection runs again within the email event. The ordinary catch-all forwarding rule is unchanged.

Cookies, member numbers, authentication codes, email bodies and challenge state are stored in neither source, logs, R2 nor manifests. Cookies, pending challenge state and the briefly queued owner OTP remain only in private Durable Object storage. A claimed job removes its stored code/challenge before its external attempt begins.

## Private Fumi owner adapter

Status: implemented with synthetic tests; Service Binding adoption, Email Routing
cutover and real OTP acceptance remain separate. [ADR 0111](../../docs/adr/0111-fumi-vpoint-owner-offers.md)
records the owner-approved boundary and recovery behavior.

The existing Worker's named `FumiOffer` entrypoint provides private RPC methods
`manifest()`, `offer(request)` and `receipt({schemaVersion,operationId,requestSha256})`.
Its default HTTP routes do not expose those methods. An administrator binds Fumi
to Worker `kogane-vpoint-collector-poc`, entrypoint `FumiOffer`; no bearer secret or
public endpoint is added. The manifest's exact JSON bytes and digest come from
Kogane's `src/fumi-offer.ts`, not an edited copy of provider rules in Fumi.

Fumi pins the manifest/version/digest, grants metadata-only matching on `subject`
and separately permits offer fields `subject`, trusted SMTP `envelope` and bounded
decoded `text`. The owner checks its configured recipient and pending request.
An unrelated or expired OTP returns `not_applicable` without a claim or provider
call. A new offer's attempt expires within ten seconds and is checked in the claim
transaction. The host must offer promptly after durable MIME extraction, with a
short retry cadence; a five-minute repair schedule cannot satisfy OTP validity.

`handled` acknowledges durable responsibility. The existing session object stores
an immutable operation/hash receipt and a queued job before acknowledging; an alarm
then authenticates and runs the shared terminal-last collection. Replays return the
same receipt, changed request hashes reject, and legacy delivery uses the same
exclusive claim gate. A lost external response is held internally as `uncertain`
and is never automatically replayed or turned into normal fallback. Small receipts
and source-deduplication markers are retained indefinitely. `not_found` is used
only by status lookup; the host must first wait out the sending lease/attempt.

Legacy mail still forwards according to its existing rules and fails if its
synchronous post-authentication collection writes no terminal. Adopted offers never
forward. Select exactly one forwarding owner during cutover; this implementation
does not alter production Email Routing, secrets, schedules or forwarding rules.

The Web screen kept the V member number masked even after login, but collection APIs do not require it as a request field. The member number is a Worker secret solely for session regeneration.

Login screens displayed normally through Cloudflare, and anonymous curl API calls returned `0010`, so bot challenges were not the main obstacle in this observation. Standard Workers `fetch()` completed login, email authentication and JSON collection without a browser, TLS impersonation or Container.

<a id="保存内容"></a>

## Stored contents

Each run content-addresses the following artifacts in shared DATA at `objects/<2 hex>/<sha256>`, then writes terminal `runs/v-point/<run-id>/terminal.json` last. No collector manifest is stored as an artifact; the terminal records the run.

```text
balance-info.json
smfg-point.json
history-page-0001.json
...
vmoney-history-page-0001.json
...
collection-summary.json
```

Every run scans all pages of the public maximum 3-year V Point and V Money history with empty `filter_date`. Current capture needs 5 requests for 149 V Point records and 1 request for 0 V Money records, so no Queue is needed.

<a id="開発とデプロイ"></a>

## Development and deployment

```bash
mise run install                              # from the repository root
mise run //services/collector-vpoint:test
mise run //services/collector-vpoint:ci
mise run //services/collector-vpoint:dry-run
```

Required Cloudflare resources/secrets:

- R2 binding: `DATA` → `kogane-raw-evidence` (shared by all collectors; the old dedicated source bucket was deleted on 2026-09-13)
- SQLite Durable Object: `VPointSession`
- Email Routing rule: `kogane-vpoint-auth` (delivers only `vpoint@takuk.me` to the Worker)
- Email Routing rule: `kogane-vpoint-pay` (delivers only `vpointpay@takuk.me` to the same Worker)
- secret: `VPOINT_MEMBER_NUMBER`
- secret: `VPOINT_EMAIL_RECIPIENT`
- secret: `VPOINT_EMAIL_FORWARD_TO`
- D1 binding: `SCHEDULE_DB` → `kogane-raw-evidence` (execution lease)
- var: `VPOINT_PAY_EMAIL_RECIPIENT` (`wrangler.jsonc`)
- Schedule: the Processor's `ScheduleAlarm` calls `ScheduledCollection.runScheduled` (`src/schedule-entrypoint.ts`) for the `vpoint` job in [`config/alarm-jobs.json`](../../config/alarm-jobs.json), `15 21 * * *` UTC (daily 06:15 JST). The Worker has no Cron Trigger (`triggers.crons` is empty).

Public manual triggers are retired (404). Existing private RPC, authentication-email receipt, V Point Pay notification-email storage and forwarding remain. `GET /health` returns neither secrets nor account data.

The historical outbox in the old source bucket (V Point manifests and V Point Pay notification-email pairs) was copied to central DATA, verified and then deleted on 2026-09-13. Routes used by `backfill-raw-evidence.sh` and `backfill-vpoint-pay-email-raw-evidence.sh`, the Service Binding called from `waitUntil` after notification storage, and `services/collector-r2-importer` audit scripts were retired at the same time ([legacy-retirement.md](../../docs/legacy-retirement.md)). Both scripts were also deleted.

The read-only contract audit on 2026-09-05 found all 24 source-R2 manifests (5 v1, 19 v2; 13 successful, 11 failed) and 10 reconciliation references passed strict validators. The 3 old reconciliations used the old exact-match policy, and the remaining 7 used the current exact policy; both are explicit compatibility contracts.

In production verification on 2026-08-31, the first trigger requested an authentication email; the Email Worker received it, forwarded it to Gmail, generated a session and recollected. The successful run scanned 149 history records over 5 pages and saved 8 artifacts plus a failure-0 manifest in R2. A subsequent manual trigger reused the Durable Object session without another email, again succeeding with 149 records, 5 pages and 8 artifacts.

Production verification after adding V Money that day also returned HTTP 200 / application status `0000` from `/api/tmoney_history` with the same email authentication and My Page session. Although the live account had 0 V Money history records, the empty page-1 raw response was retained. Rereading the R2 v2 manifest confirmed 149 V Point records / 5 pages, 0 V Money records / 1 page, 9 artifacts and failure 0.

Treat the following as a unit when removing the verification environment.

1. Email Routing rules `kogane-vpoint-auth`, `kogane-vpoint-pay`.
2. Worker `kogane-vpoint-collector-poc` (including secrets and the `VPointSession` namespace).

Remove/disable Email Routing rules first, then remove the Worker. The catch-all rule and shared DATA used by other collectors and the Processor are excluded from removal.

<a id="vポイントpayとapp-archive"></a>

## V Point Pay and the app archive

`VポイントPay` (V Point Pay) is a separate ledger for prepaid JPY balances, authorization, settlement, refund and charge, with `com.smbc_card.vpoint` as its authoritative app. This Web PoC neither obtained nor decompiled its APK. App polling in `services/collector-vpoint-pay` is stopped and is not re-enabled by this Email Worker or raw-evidence adoption. Future app analysis keeps binary/decompiled/decrypted artifacts in the existing private Android archive repository; Kogane holds only provenance, hashes, reproduction steps and sanitized schemas.

<a id="vポイントpay通知メールの取り込みと照合"></a>

## V Point Pay notification-email import and reconciliation

The same Worker's V Point Pay-specific Email Routing rule also archives notifications. Forwarding target notifications from Gmail to `vpointpay@takuk.me` sends originals as inline `message/rfc822` attachments. The handler separates inner originals with `forceRfc822Attachments` and imports only when the inner From is `info@prepaid.smbc-card.com` and subject is one of:

- `ご利用のお知らせ` ("usage notification").
- `チャージ受付のお知らせ` ("top-up acceptance notification").
- `プリペイド残高加算のお知らせ` ("prepaid balance addition notification").
- `ご利用不可のお知らせ／カードがご利用頂けませんでした` ("unavailable-use notification / your card could not be used").

Original `notification.eml` and normalized `normalized-event.json` are content-addressed in shared DATA as 1 run per 1 notification, followed last by terminal `runs/v-point-pay-email/<original-sha256>/terminal.json`. The run ID is the original hash, so forwarding the same notification again yields `already_persisted` without adding another original. Notifications forwarded from Gmail as `message/rfc822` attachments already exist in Gmail and are not sent back by the Worker. Official-sender notifications delivered directly to `vpointpay@takuk.me` are forwarded to the existing Gmail destination after DATA storage. Other mail, such as OTPs or forwarding-address confirmations, is also forwarded as before. This distinction lets Gmail continue displaying notifications after the registered V Point Pay address changes to the alias, while Gmail backfill avoids forwarding loops.

Existing-email backfill procedure:

1. Search Gmail with:

   ```text
   from:info@prepaid.smbc-card.com (subject:"ご利用のお知らせ" OR subject:"チャージ受付のお知らせ" OR subject:"プリペイド残高加算のお知らせ" OR subject:"ご利用不可のお知らせ" OR subject:"カードがご利用頂けませんでした") -in:spam -in:trash
   ```

2. Forward results with original attachments intact to `vpointpay@takuk.me`. Gmail API use must preserve `message/rfc822`, splitting requests at a maximum of 10 messages per 1 request.
3. Each forwarded notification is saved to DATA as a `v-point-pay-email` run. Re-forwarding is safe (`already_persisted`), but forwarding only missing messages is sufficient. The handler stores notifications only when the envelope recipient is `VPOINT_PAY_EMAIL_RECIPIENT` (`vpointpay@takuk.me`); notifications forwarded to `vpoint@takuk.me` are not stored.

`vpoint@takuk.me` is solely for V Point Web authentication emails; `vpointpay@takuk.me` is the V Point Pay app registration address, official-notification destination and historical-notification backfill destination. Both routes reach the same Worker, but the latter is not used for code extraction. Keep the ordinary catch-all forwarding rule.

The collector's email reconciliation report depended on old source-bucket `raw/v-point-pay-email/` listings, so none has been generated since retirement on 2026-09-13. Cross-source reconciliation belongs to the Processor reading terminals ([collection.md](../../docs/collection.md#v-point-servicescollector-vpoint)). The following records the reconciliation rules at that time.

Reconciliation uses only these exact rules.

- Use the explicit value when email states `内、利用Vポイント数` ("of which, V Points used").
- Use the top-up amount when top-up `取引内容` ("transaction description") explicitly states `ポイント` ("points").
- Only exactly 1 usage-history row matching the JST calendar day and V Point count is `matched`.
- 0 rows are `unmatched`, multiple rows are `ambiguous`, and notifications without an explicit amount are `not-comparable`.

No approximate merchant matching, adjacent-day shifting, amount adjustment or automatic candidate selection is performed. Reports refer only to source keys and row fingerprints; they do not change, delete or merge original emails, normalized events, V Point history or V Point Pay app history. A missing live app transaction snapshot is explicitly `unavailable-no-live-snapshot`.

Live backfill on 2026-08-31 matched 85 Gmail search results with 85 R2 events. Exact reconciliation against 149 V Point history records yielded, among 34 comparable events, 11 matched, 23 unmatched and 0 ambiguous, plus 51 not-comparable. The 23 unmatched events were not corrected by guessing. V Point Pay app history had not been captured after live credentials were lost; email-to-app reconciliation was not run.

<a id="段階別の運用ログ"></a>

## Operational logs by stage

`collector-stage-started` / `collector-stage-failed` correlate the same execution by runId, distinguishing balance, SMFG points, V Point history, V Money history, R2 storage, email reconciliation and manifest storage. Failures retain only fixed `failureCode`, allowed `errorType`, observed HTTP status, 4-digit application code and page-inconsistency `reasonCode`. Partial failures are logged individually; runId remains in logs even if the manifest itself cannot be saved.

`vpoint-auth-step` distinguishes reauthentication email requests, code submission and session checks. Notification emails have independent runIds for parsing, storage, forwarding and code-processing traces. Post-authentication collection links to email processing through `vpoint-post-auth-collection` parentRunId.

Exception messages/stacks, response bodies, URLs, cookies, tokens, authentication codes, email addresses and email bodies do not enter logs. Official raw-data R2 storage, failed/partial outcomes and email-reforward prevention remain. The V Point Pay app API Worker is stopped separately; this Worker's notification-email capture continues.

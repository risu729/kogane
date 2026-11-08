# PRESTIA GLOBAL PASS read-only Worker PoC

This independent PoC captures server-rendered HTML from GLOBAL PASS (`Vpassデビット専用サイト`, "Vpass debit-only site") with Playwright Google Chrome in a Cloudflare Container and saves it to private R2. It uses neither the SMBC-card Vpass app API nor `mnie` as a runtime dependency, configuration source or submodule.

On 2026-08-30, setting only the Cloudflare Container timezone to `Asia/Tokyo` reproduced Turnstile token generation and completed real-account login, daily capture and a 15-month backfill end to end. HTML and manifests are saved in private R2. The Worker has no Cron Trigger (`triggers.crons` is empty in `wrangler.jsonc`): the Processor's `ScheduleAlarm` calls `ScheduledCollection.runScheduled` (`src/schedule-entrypoint.ts`) once a day for the `prestia-globalpass` job in [`config/alarm-jobs.json`](../../config/alarm-jobs.json) (03:17 JST). No GitHub Actions schedule is used. Since public admin entrypoints were retired on 2026-10-10, normal collection uses only fixed-daily private Service Binding/schedule paths. Former manual-backfill, diagnostic and container-stop entrypoints return 404. `/latest-manifest`, which read the old staging bucket, was retired on 2026-09-13.

## Runtime profile

- **Browser: throughout collection.** Ordinary daily/backfill launches headed Google Chrome Stable through Playwright inside a Cloudflare Container.
- The browser generates Turnstile tokens, executes official JavaScript login, displays server-rendered details and switches months through the available-month selector. It does not hand off to Worker `fetch` after login; detail HTML comes from the same browser session.
- The Worker-side Browser Run binding is an unused legacy diagnostic binding; public `/browser-probe` is retired. Production collection does not use it. The Worker handles Container orchestration, opaque relay to TAMIA, NDJSON receipt and R2 storage.

<a id="現在の実行構成"></a>

## Current execution architecture

```text
private ScheduledCollection RPC / scheduled handler
  -> Worker orchestration
  -> Container Playwright Google Chrome Stable
  -> Container-local HTTP CONNECT proxy
  -> authenticated WebSocket relay on the Worker
  -> specify TAMIA Tunnel directly by tunnel_id
  -> tamia cloudflared
  -> www.debit.vpass.ne.jp:443

GLOBAL PASS + Turnstile hosts
  -> fixed to the same TAMIA egress

```

The Worker relays encrypted TCP without terminating TLS, so Chromium itself performs the GLOBAL PASS TLS handshake. Inside the Container, a standard Node.js HTTP server handles Chrome CONNECT requests through its `connect` event and connects them to a backpressured `ws.createWebSocketStream()`. Both Worker-side VPC relay and Container permit only port 443 on these 3 production hosts (plus the Worker host used for egress diagnostics), without expanding to arbitrary request-specified hosts or a generic TCP proxy.

- `www.debit.vpass.ne.jp`
- `challenges.cloudflare.com`
- `brunhild.challenges.cloudflare.com`

The Container runtime remains Node.js. Boundary testing confirmed that Bun 1.4.0 reports `Not supported yet in Bun` for `ws.createWebSocketStream()`. Google Chrome dominates startup time/resource use in this Container, so switching to Bun has little practical benefit. Rewriting with Bun native WebSocket/TCP APIs would reintroduce manual queues/backpressure control and is not adopted now. Bun remains the package manager and existing test runner.

The VPC binding specifies TAMIA's `tunnel_id` directly rather than `network_id: "cf1:network"`. Only this Worker uses TAMIA Tunnel, without adding Zero Trust account hostname routes, so personal-PC WARP traffic is unaffected. This follows Cloudflare's [VPC Network binding](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/) and [Cloudflare Tunnel](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/) configuration.

<a id="取得保存の予定"></a>

## Capture and storage plan

- `daily`: recaptures the current and previous months. Every Worker entry point (`alarmCollection` behind `runScheduled` and `runOperation`, and the unused `scheduled` handler) runs `daily` only (`src/worker.ts`).
- `backfill` (captures every selector-offered month in 1 session) remains in the container contract (`src/model.ts`, `container/server.mjs`), but no Worker entry point requests it since the manual routes were retired.
- Shared DATA (`kogane-raw-evidence`): saves each page to `objects/<2 hex>/<sha256>`, writing terminal `runs/prestia-globalpass/<run-id>/terminal.json` last.
- Manifest: records hashes, byte counts, offered months and partial failures.

The Container streams HTML page by page as NDJSON. The Worker retains sanitized pages (at most 15 months × 5 pages) in memory until writing the terminal, without R2 staging objects. Daily-equivalent captures also append per run to retain pending-to-confirmed updates. Split into monthly Queues only if measured execution exceeds the 15-minute window. No GitHub Actions schedule is used.

The WebSocket TCP relay is non-hibernating. Its corresponding upstream TCP socket cannot be restored, so this opaque tunnel does not use Durable Object WebSocket Hibernation. Runs interrupted by isolate, network or Tunnel disconnection are recorded as partial failures and recaptured next time.

### Raw evidence v3 contract

`globalpass-browser-poc-v3` treats Container NDJSON as a strict contract. Metadata must arrive exactly 1 time; `availableMonths` must be a contiguous descending sequence of at most 15 months. `selectedMonths` must exactly equal the first 2 months for daily or every month for backfill. Artifact rows are `{type: "artifact", month, page, pageCount, html}` and arrive sequentially per month from page 1 through `min(pageCount, 5)`, before the next month begins (otherwise `container_contract_invalid`). The manifest records `selectedMonths`, `captureComplete`, `paginationStatus: "pages_walked"`, each artifact's `page` and fixed-shape failures (`operation`, `errorType`, `errorCode`, `artifactKey`). Only a run with every selected month saved, provably complete capture of each 1-month period and 0 failures is `success`. Failed runs are also saved whenever a DATA terminal can be written.

After the last month's last page, the Container sends exactly one `{type: "logout", failed}` line (`failed` is a boolean and the line has no other field) from `container/logout.mjs`. The Worker accepts it only after metadata, with every selected month attempted, the last month's walk finished and no container error; any later line other than a container `error` is `container_contract_invalid`. A failed sign-off never lowers the run's status or coverage: the manifest keeps `logoutFailed: true` and the terminal gets the auxiliary run report `reportRef: logout`, `outcome: failed`, `safeErrorCode: logout_failed` ([collection: logout audit](../../docs/collection.md#logout-audit-2026-11-08)).

Failures for sanitizer-refused pages use closed `errorCode` values to identify the failed check (`globalpass_html_contract_invalid`, `globalpass_html_redaction_failed`, `globalpass_html_shape_unreviewed`, `globalpass_html_utf8_invalid`). The same code appears in `code` on the `artifact-write` diagnostic line. Neither provider strings nor matched values are emitted.

The failed expectation is a closed code (`GLOBALPASS_SANITIZER_EXPECTATIONS` in `src/sanitize.ts`, for example `forbidden_token`, `activity_heading_missing`, `credential_field`, `hidden_name_unallowed`) recorded in manifest-failure `expectationCode` and the same diagnostic line's `shape`. `shape` describes only the refused page's structure: expectation, phase (`input`/`output`), element/attribute classifications (closed codes), tag counts (`table`, `tr`, `th`, `td`, `form`, `input`, `select`, `script`, `a`, etc.), form/hidden-input counts defining the reviewed variant, landmark presence (doctype, detail heading `ご利用明細` ("usage details"), `利用明細` ("usage details") or English `Account Activities`, title, `usrId`, password field, `select`, sentinel), occurrence counts per forbidden token, and digit counts of byte/text lengths. It contains no page strings, attribute values, URLs or numbers read from the page. `safeShape` in `packages/collector-diagnostics` drops everything except closed codes, booleans and non-negative integers (ADR 0026 amendment of 2026-09-28). Error banners are not recorded because no markup has been observed.

After selecting a month, the Container clicks the upper pager's (`div.nablarch_paging`) `Next` while it is an enabled `a.nablarch_nextSubmit`, waiting for POST to the same path (`/p/statementInquiry/RW1313010201`). It verifies that the new page shows the next page number, unchanged page/record counts and at least 1 detail block; any mismatch throws a container error. A click with no observed POST is retried only 1 time (robustness only: an extension's coordinate click failed 1 time to navigate on the 1st attempt, while page-internal click events always navigated on the 1st attempt, so this is not site behavior). The limit per 1 month is 5 pages (50 records; the observed maximum was 20). Months exceeding it send their first 5 pages and become `activity_pages_unwalked`. Each page emits 1 line; page 1 is saved as `activity-YYYY-MM.html` and page N as `activity-YYYY-MM-pN.html`.

Before storage, the Worker reads only record count (`Found N Result` / `検索結果 N件` ("N search results")), page number (`[p/Ppage]` / `[p/Pページ]` ("page p of P")) and detail-block count (2 `table.tableStyle4` elements per 1 record) from each page body. It records these in `globalpass-activity-pages` (month position within the run, `page`, `walkPageCount`, `statedTotal`, `pageIndex`, `pageCount`, `statementBlocks`). A 1-month period is complete only if empty (no Found line, pager or block), or if every page 1..P exists, every page states the same N/P and its own page number, and the sum of blocks equals N. Other months receive 1 `operation: "pagination"` failure: `activity_pages_unwalked` (missing pages), `activity_pager_unreadable` (inconsistent record/page counts or page numbers, or details/Found line without a pager), or `activity_total_mismatch` (block sum differs from N). Results go to `globalpass-activity-coverage` (month position, `pagesCaptured`, `walkPageCount`, `errorCode`). A `success` run's `account` unit is `complete` and eligible for parsing. Run coverage stays `partial` because the month window moves ([ADR 0026 amendment of 2026-10-04](../../docs/adr/0026-collector-unit-coverage.md#amendment-2026-10-04-global-pass-walks-every-page-of-a-month)).

The Japanese pager was observed only on the real screen (2026-10-04; markup matched English). Browser cookies determine display language; the collector logs in with a fresh browser each time without setting that cookie. Server-side language persistence is unverified. The activity parser reads only English table headers, so saved Japanese pages fail parsing.

Before storage, only the 2 screen shapes confirmed by auditing 35 existing HTML captures are allowed. Only varying nonempty `nablarch_hidden` values become `__KOGANE_REDACTED_DYNAMIC_VALUE__`; empty values stay empty, while fields needed for detail selection, such as `W131301.referenceDate`, remain. Separately, current-document-fragment `href` becomes `#`, and entire permitted `onclick`/`onchange` values become `return false;`, keeping original fragments/handler arguments out of R2. Hidden fields, duplicate input `id/name/type/value`, duplicate form actions, URL-bearing attributes and inline event handlers are permitted only within the audited exact inventory. Query-bearing URLs, unknown hosts/paths/schemes, `formaction`, data URLs, `srcset`, `ping`, CSS `url()`/`@import`, meta refresh, SVG URL attributes, unaudited network/navigation sinks such as `base`/`object`/`embed`/`iframe`, unknown event attributes/functions, login screens, session/token strings or invalid UTF-8 fail closed; that HTML is not saved to R2. Saved pages are recorded on the terminal as `redacted` transformations (`globalpass-activity-sanitizer`).

`packages/collection` writes runs directly to shared DATA, and the Processor registers DATA terminals in-process ([processor.md](../../docs/processor.md)). Private Service Binding `RAW_EVIDENCE_IMPORTER`, `POST /backfill-raw-evidence`, `scripts/backfill-raw-evidence.sh` and the dedicated source bucket were retired on 2026-09-13 ([legacy-retirement.md](../../docs/legacy-retirement.md)). Backfill runs also write through the terminal in 1 operation, without 10-artifact transfer batches or deferral.

No Queue is introduced: 1 run has at most 15 HTML + 1 manifest, and measurements fit the 15-minute window. Queue splitting would repeat browser login and Turnstile each month and complicate completeness boundaries. Reconsider only after measuring a time-limit overrun.

## Secret

- `GLOBALPASS_ID`
- `GLOBALPASS_PASSWORD`
- `RELAY_TOKEN`: WebSocket relay only.

Session cookies, Turnstile tokens and Nablarch hidden state are neither stored nor reused; each run obtains them in a fresh browser context. Keep credential JSON, secrets and real data out of Git. Remote secrets appear in neither `wrangler.jsonc` nor generated types, so `env.d.ts` augments only the 3 secret names above.

Example synchronizing only necessary local fields:

```sh
scripts/sync-local-secrets.sh \
  ~/.local/share/kogane/secrets/globalpass.json
```

Input JSON contains only `{"username":"...","password":"..."}`; the script displays no values.

<a id="デプロイ済みリソース"></a>

## Deployed resources

- Worker: `kogane-globalpass-collector-poc`
- URL: `https://kogane-globalpass-collector-poc.takuanimal.workers.dev`
- Container app: `kogane-globalpass-collector-poc-globalpasscollectorcontainer`
- Container app ID: `a03ac341-52a7-4e81-9a7c-279a90cc4b0c`
- Container limit: 2 (1 fixed ID for normal collection, 1 slot to set aside an old instance during image rollout)
- R2 binding: `DATA` → `kogane-raw-evidence` (shared by all collectors; the old dedicated source bucket was deleted on 2026-09-13)
- Browser Run binding: `BROWSER`
- VPC binding: directly specifies TAMIA Tunnel `6b0ccf30-68b2-494e-baa8-f4f9f3e46b33`
- Schedule: the Processor alarm job `prestia-globalpass` (`config/alarm-jobs.json`, daily 03:17 JST, `17 18 * * *` UTC). No Workers Cron Trigger.

The current Container explicitly sets startup environment `TZ=Asia/Tokyo` and launches Google Chrome Stable as a headed persistent context on Xvfb. GLOBAL PASS, Turnstile and its helper use the same fixed TAMIA egress. The current image including the NRT Gateway diagnostic variant has digest `sha256:195ebaa959f2676e08e8c6d40335b5984e64e36e905efc957a4061070835e6b1` and runtime revision `timezone-collector-v6`. v6 only replaces the Container-local custom SOCKS5 relay with Node.js HTTP CONNECT; ordinary collector browser conditions are unchanged from v4.

In a controlled A/B changing only egress after the timezone correction, direct Container (Cloudflare IPv6 SG/SIN egress) had Turnstile token length 0 in both of 2 runs despite HTTP 200 login pages; a concurrent all-TAMIA control generated a token of length 794. Current production therefore remains fixed to TAMIA. Details are in [`docs/browser-run-investigation-2026-08-28.md`](docs/browser-run-investigation-2026-08-28.md).

Additional Cloudflare Gateway diagnostics placed the Worker near Tokyo, achieving JP/NRT Cloudflare IPv6 egress through `cf1:network`. NRT generated token 0 in both of 2 runs, but the immediately following TAMIA control also generated token 0, confounding the result with successive challenges over a short interval or time variation. Normal collection remains on TAMIA; the NRT variant stays only for sufficiently spaced revalidation.

Deployment output for Worker version `2abc1133-83db-4c8d-b593-c82ec8ca4dcf` on 2026-08-30 also confirmed schedule `17 18 * * *` (a Workers Cron Trigger then; since #430 the Processor alarm calls the Worker instead).

Daily/backfill sends `destroy()` to the ephemeral fixed Container instance last, regardless of success/failure including DATA storage. Destroy-request failures stay separate from collection results and enter structured logs. The `30s` idle timeout remains, but live verification showed an instance still `running` after relay use even with `stop()` RPC outcome `ok`; `destroy()` therefore ensures billing stops.

Post-deploy daily run `8d498b19-dda5-4dfb-84b6-1239c4d9e765` on 2026-08-30 took about 52 seconds, with status `success`, 2 HTML artifacts for 2026-08 and 2026-07, and failure 0. However, despite `stop` RPC outcome `ok` and app state `assigned: 0`, a later instance list showed `v18` as `running`. This difference was discovered during Chromium A/B rollout; old `v18` was explicitly destroyed and post-collection cleanup changed to `destroy()`.

Corrected daily run `251bbae4-007c-4d91-b7e5-9b4385656285` also had runtime v5, status `success`, 2 HTML artifacts and failure 0. Immediately after R2 manifest storage, `globalpass-collection-container-destroyed` was recorded, and Wrangler's instance list confirmed `v18` became `inactive`.

HTTP CONNECT runtime v6 ran a bounded probe with new identity `v19`, confirming GLOBAL PASS HTTP 200, a 794-character Turnstile token and TAMIA JP/KIX egress. Subsequent daily run `8101b4c8-170d-400a-9e27-7823dce9cf28` took about 42 seconds with status `success`, discovered 15 available months, saved 2 HTML artifacts for 2026-08 and 2026-07 and had failure 0. The same manifest was retrieved through `/latest-manifest`, and the instance list confirmed `v19` became `inactive`.

Container-app image rollout continues asynchronously after `wrangler deploy` completes. During verification, confirm the new image digest and healthy instances with `wrangler containers info <app-id>`, then use a fresh Durable Object ID. Running before rollout can use an old image and look like a code defect.

## 2026-08-27 live verification

Results of the bounded real-account run:

1. `cf1:network` alone had no route to public destinations, producing `ERR_CONNECTION_CLOSED` for GLOBAL PASS.
2. Changing the VPC binding to directly specify TAMIA's `tunnel_id` successfully captured the GLOBAL PASS login screen, ID field and Turnstile hidden input. It was not `Access Denied`.
3. `cf-turnstile-response` remained empty after 45 seconds; execution stopped before credential entry or login POST.
4. Network diagnostics observed failure to reach `brunhild.challenges.cloudflare.com` alongside missing token generation. That name returns only AAAA; TAMIA/home egress had no usable IPv6 route during verification.
5. Including that host in the TAMIA relay produced `ERR_CONNECTION_CLOSED`; ordinary Container egress produced `ERR_ABORTED`. However, Browser Run below never called `brunhild` and generated no token despite every Turnstile request returning 200, so the missing-IPv6 cause hypothesis was rejected.
6. Proxying Turnstile requests through Worker `fetch()` was also tried: isolating only the helper returned 403; proxying both Turnstile hosts also returned 403 for `/turnstile/v0/api.js`. Replacing browser requests with Worker fetch is not adopted.
7. R2 contains only failure manifests per run, with 0 `activity-YYYY-MM.html` artifacts. Representative run: `1fe39ff7-a382-4786-a200-0908f57928ea`.

Cloudflare Containers [outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/) supports HTTP/HTTPS allow/deny rules, Worker handlers and ordinary internet egress, but public configuration/current Wrangler schemas offer no switch to IPv6 general internet egress. This is a Container routing limitation, not an established cause of this Turnstile failure.

## 2026-08-28 Browser Run verification

A Browser Run binding and admin-token-required `POST /browser-probe` were added to the existing Worker for 3 bounded GLOBAL PASS diagnostics. No run generated a Turnstile token, so neither ID/password entry nor login POST to GLOBAL PASS occurred.

- Login returned HTTP 200 with title `ログイン` ("login"), a form and Turnstile hidden input, rather than `Access Denied`.
- Network User-Agent/Client Hints matched Windows Chrome 153, but page JavaScript saw `Cloudflare-Workers`, `Linux x86_64`, `navigator.webdriver=true`, `en-US`.
- `challenges.cloudflare.com/turnstile/v0/api.js` redirected with 302 to a build returning 200. Challenge documents, both of 2 XHR POSTs and images also returned 200.
- A cross-origin challenge frame existed, but `cf-turnstile-response` still had 0 characters after 30 seconds.
- There were 0 requests to `brunhild.challenges.cloudflare.com`, HTTP 4xx/5xx responses or request failures.
- Cloudflare's official specification adds non-removable identifying headers and Web Bot Auth signatures to Browser Run Puppeteer/CDP traffic; changing UA does not bypass bot protection. This environment did not demonstrate fully automated login.

Sanitized steps, observations, inferences and uncertainties are recorded in [`docs/browser-run-investigation-2026-08-28.md`](docs/browser-run-investigation-2026-08-28.md).

The same day, the same login URL was compared in ordinary Chrome/Kuebiko freshly launched from Start-menu `kogane capture`. No credentials were entered and no login POST was sent.

- HTTP 200, form presence and no `Access Denied` matched Browser Run.
- Page JavaScript saw Windows Chrome 153, `Win32`, `navigator.webdriver=false`, `en-US`.
- Turnstile API redirected with 302 to build 200; challenge documents returned 200.
- `cf-turnstile-response` reached 773 characters within about 15 seconds; Browser Run remained at 0 after 30 seconds.
- Structured CDP/Kuebiko metadata showed no `brunhild.challenges.cloudflare.com` requests or target-host 4xx/5xx. Only 1 unused CSS request had `ERR_ABORTED`, without challenge failure.
- Raw Kuebiko capture run `2026-08-27T21-46-51` may contain cookies or similar data and stays local; only sanitized results were saved in Git.

Kuebiko generated a token with remote debugging while `navigator.webdriver=false`. Stronger differences than CDP use itself are Browser Run's `Cloudflare-Workers`/Linux/`webdriver=true` fingerprint and non-removable identifying headers. However, Kuebiko and Browser Run egress differed, so fingerprint alone is not yet established as the cause.

## 2026-08-28 Container browser A/B

GLOBAL PASS stayed on the same TAMIA path while Playwright Chromium progressively approached the successful environment: `baseline`, `webdriver=false`, Windows-like fingerprint, headed mode and fresh persistent profile, changing 1 condition at a time. All 5 conditions returned login-page 200, a form and no `Access Denied`, but token length remained 0 after 30 seconds. All observed challenge-fetch 401 and `ERR_ABORTED` immediately after Brunhild 204.

The same conditions were also tried with branded Google Chrome Stable `152.0.7977.64` installed in the Container through official Playwright `channel: "chrome"`. Login returned 200 but token length stayed 0; challenge-fetch 401 and `ERR_ABORTED` immediately after Brunhild 204 were unchanged. Playwright-bundled Chromium alone therefore does not explain failure.

No credential entry, login POST, cookie reuse or R2 write occurred. Old instances `v9`/`v10` are destroyed; Google Chrome verification instance `v11` is stopped. Detailed comparisons are in [`docs/browser-run-investigation-2026-08-28.md`](docs/browser-run-investigation-2026-08-28.md); removal targets are in [`docs/cleanup.md`](docs/cleanup.md).

## 2026-08-29 same-egress / workaround verification

Rechecking Cloudflare's official material withdrew the earlier inference treating PAT-endpoint 401 and ERR_ABORTED immediately after Brunhild 204 as root causes. PAT 401 is normal fallback; some challenge-subdomain failures alone do not imply challenge failure. However, differing IPs between challenge retrieval and solve submission can invalidate solves, so the previous split path was rechecked first.

New bounded probes measured all-parent-page/Turnstile traffic through TAMIA, all-direct Container traffic and the former split path. All-TAMIA egress was 223.223.22.214, JP/KIX, ASN 18144, HTTP/2; direct Container egress was Cloudflare IPv6, SG/SIN, ASN 13335. A split run also observed challenge-image HTTP 400, so production should avoid it; however, using one egress still generated no token.

Additional conditions tried native Linux Chrome, webdriver true/false, Patchright 1.62.2, Chrome launched as an ordinary process with CDP attached only after 25 seconds, and Windows UA/Client Hints/platform/languages matched to Chrome 152. All 10 extra conditions, including headed mode, fresh persistent profiles and no UA override, had token 0. Credential entry, login POST, cookie reuse and R2 writes occurred 0 times.

## 2026-08-30 OCI `bots` Chrome verification

To compare outside Cloudflare Containers, official Google Chrome Stable 152 was installed and retained on OCI ARM64 host `bots`, running headed on Xvfb without Playwright. Ordinary fresh profile, a copy of the successful local WSL profile, a separate fresh profile with SwiftShader WebGL, and the same OCI Chrome fixed to TAMIA through the existing Worker relay all displayed Sign On and the Turnstile widget but had token 0. Egress was `138.2.53.208`, JP/KIX, without WARP; pages saw native Linux and `navigator.webdriver=false`. TAMIA comparison egress was `223.223.22.214`, JP/KIX, ASN 18144, with the same result. The token gate kept credential entry/login POST at 0. Installations, profiles, dependencies and logs were retained for revalidation. See [`docs/browser-run-investigation-2026-08-28.md`](docs/browser-run-investigation-2026-08-28.md) for details and rerun scripts.

Next, the same local WSL Google Chrome 152 used 2 fresh profiles to compare only egress in the same time window. WARP JP/NRT (`104.28.211.106`) produced token 752; TAMIA JP/KIX (`223.223.22.214`, ASN 18144) through the existing Worker relay produced 794. Both displayed Sign On, form and widget, without Access Denied. Credential entry/login POST occurred 0 times. Local WSL succeeded while Container/OCI failed on the same TAMIA egress, so TAMIA network reputation alone is not the root cause. Server host/runtime or browser/OS integrity signals became the next main differences.

Changing only local WSL display from WSLg to Xvfb (`1365x768x24`) still generated token 794 with TAMIA egress, a fresh profile, ordinary Chrome 152 and `webdriver=false`. Chrome logs showed WebGL 1/2 blocklisted, so neither Xvfb nor unavailable WebGL alone explains failure. Focus moved to server-specific host/container runtime or undisclosed integrity signals.

The current Cloudflare-deployed Container image, digest `sha256:db2ea4549e95c40114e95648d625b498c6d0ed7095a6d05bbc6d56bd09709f6c`, was run unchanged without rebuilding in local WSL Docker Engine. `chrome-direct-process-attach-late-all-tamia` launches ordinary Chrome and delays CDP attachment for 25 seconds; both Cloudflare-`basic`-equivalent 0.25 CPU / 1 GiB and unrestricted resources yielded token 0. Native Chrome on the same WSL host produced token 794, also 794 with Container flags `--no-sandbox --disable-dev-shm-usage`. Host/image Chrome matched version `152.0.7977.64`, package and SHA-256 of `/opt/google/chrome/chrome`. Image runs with UID 1000 and `--network=host` also yielded token 0. CPU/memory, the 2 startup flags, Chrome binary, root and Docker bridge network were each excluded as sole root causes; fonts, speech/locale and shared libraries inside the image became the next browser-visible userland comparisons. Local Containers simulate Docker rather than Cloudflare production runtime, so this does not reproduce a Cloudflare-specific host signal.

With the same Chrome/Xvfb/TAMIA conditions, CDP attached to Turnstile OOPIFs and workers to compare successful WSL and failed OCI 2-stage POSTs, response bodies and compiled scripts. Both used identical 84,236-byte `api.js`, but session-specific `rch` runtime, 2nd POST and 2nd response differed. In particular, 2nd responses were 4,288 bytes on success and 127,724 bytes on failure, both HTTP 200. The runtime resolves API names/payloads at execution through a custom bytecode VM and bitwise codec rather than standard WebCrypto. Confirmed API vocabulary, deobfuscation steps, safe analyzers and targeted-breakpoint limits are recorded in [`docs/turnstile-local-analysis.md`](docs/turnstile-local-analysis.md). Raw bodies, cookies and challenge IDs were not committed.

The timezone A/B on 2026-08-30 updated this conclusion. Ordinary Chrome Containers can generate tokens, so the browser approach remains the PoC's first candidate. Investigated Camoufox, Patchright, SeleniumBase Pure CDP and other third-party workarounds, with adoption/rejection reasons, are collected in docs/browser-run-investigation-2026-08-28.md.

## 2026-08-29 local Windows / WSL profile A/B

In the same time window, local Windows Chrome Beta 153 and WSL Google Chrome 152 compared fresh profiles with copies of existing Kuebiko profiles. All 4 conditions generated `cf-turnstile-response`, had a form, no `Access Denied` and `navigator.webdriver=false`. Token lengths were Windows copy 794, Windows fresh 752, WSL copy 773 and WSL fresh 730. Token values, credentials and login POSTs were neither stored nor sent.

WSL succeeded with a Windows-profile copy, but also with a fresh profile; profile copying or DPAPI-protected Windows cookies therefore cannot explain success. Native Linux Chrome also works locally, so do not attribute Container failure solely to Linux, fresh profiles or CDP. Measured Cloudflare traces for Windows/WSL both had WARP enabled and JP/NRT. Detailed steps/interpretation are in [`docs/browser-run-investigation-2026-08-28.md`](docs/browser-run-investigation-2026-08-28.md).

Next, credentials were submitted only 1 time from the same fresh WSL profile. With token length 730, login POST returned HTTP 200 and navigated to title `TOP`, no login form and an activity-details entrypoint. No Access Denied, Turnstile error or credential error appeared. Local WSL can therefore automate server-side token validation and login without manual actions or Windows spoofing. Detail capture was outside this bounded run's scope.

<a id="次に試す順序"></a>

## Next trial order

1. Confirm post-login activity-detail navigation and month selectors, including English display, in a bounded live run.
2. Confirm `daily` saves current/previous-month HTML and manifests in R2.
3. Run `backfill` only 1 time after daily success, saving the 15 offered months.
4. Avoid split egress; fix GLOBAL PASS and Turnstile to the same TAMIA egress.
5. Do not treat PAT 401 or Brunhild abort alone as blockers.
6. Do not enable Cron until bounded tests pass in order: token generation, login POST, detail screen, month selector, R2 storage.

This order was completed on 2026-08-30 (login, daily and a 15-month backfill end to end, above). Daily collection now runs from the Processor alarm job, not a Workers Cron Trigger.

<a id="ローカル検証"></a>

## Local verification

```sh
mise run install                               # from the repository root
mise run //services/collector-globalpass:test     # bun test, vitest worker tests, node relay test
mise run //services/collector-globalpass:ci       # typecheck, cf-typecheck, test, container
mise run //services/collector-globalpass:dry-run
```

Old `scripts/trigger.sh` and public manual entrypoints are retired. No internal APIs replace arbitrary backfill, probes or container stops. Normal collection requests use the existing Access-protected App operation path.

<a id="残る検証項目"></a>

## Remaining verification

- Current DOM selectors for the post-login `ご利用明細` link and month selector.
- Whether a `select` change event alone performs the month POST.
- Whether every month's HTML stays within 2 MiB.
- Stable normalization keys for family-card labels, pending/confirmed and authorization numbers.
- Whether the non-hibernating WebSocket relay sustains the browser session across every month.

## Operational diagnostics

Collection logs include a generated run ID, bounded stage name, outcome and duration.
The Worker distinguishes container startup/request, browser collection, artifact storage,
manifest storage and container teardown. Browser logs identify challenge/login, activity
navigation, month discovery and statement reads; HTTP failures contain status only.
Each Worker relay tunnel logs one `globalpass-relay-closed` line: run ID, relay ID, host class,
network, `outcome` (`peer-closed`, `upstream-closed`, `upstream-connect-failed`,
`upstream-read-failed`, `upstream-write-failed`), duration and bytes each way. An error after the
container closed its end is teardown (`peer-closed`, level `log`), not a fault. The container's
local relay logs `globalpass-container-relay-summary` at close: CONNECT requests by outcome, bytes each way
and socket errors by closed code (`ECONNRESET`, `EPIPE`, …). Every socket and stream the local
relay owns keeps an `error` listener, so a browser that resets a tunnel ends that tunnel and never
the process (before `timezone-collector-v8` a reset on a refused CONNECT crashed the container with
`read ECONNRESET`, 2026-11-07). A failure nothing handled is logged as `globalpass-container-crash`
(error type and socket code only) before the process exits.
Each challenge attempt logs its number, duration, a closed code and the attempt's last HTTP error
status; a failed run's container `error` record names the failed step as a closed code
([docs/collection.md](../../docs/collection.md#prestia-globalpass-kogane-globalpass-collector-poc)).
New diagnostic logs omit exception text, stack traces, request URLs, credentials and statement bodies.
A page the sanitizer refuses logs its closed code and a `shape` object on the `artifact-write`
line: which expectation failed, and counts and booleans describing the page's markup (tags,
reviewed hidden inputs, landmarks, forbidden-token occurrences, lengths as digit counts), never
its text, attribute values, URLs or numbers read from it
([ADR 0026 amendment of 2026-09-28](../../docs/adr/0026-collector-unit-coverage.md#amendment-2026-09-28-global-pass-sanitizer-refusals-log-a-counts-only-shape)).
The `terminal` line reports the run's status only and carries no error fields.

Implementation update (2026-11-08 14:56 UTC): `container/collect.mjs` owns the
collection orchestration and NDJSON error record. `server.mjs` remains the HTTP
and probe entrypoint and injects the relay, browser launch and existing page
actions; importing the orchestration starts no HTTP server. Browser and relay
teardown both run, and their errors cannot replace a primary acquisition error.
After successful acquisition, the first teardown failure still fails the run,
including a thrown `undefined` or `null`. A separate failure flag preserves that
first thrown value; previously an `undefined` teardown could disappear and a
later error could replace a first nullish value. Provider logout retains the
auxiliary flag contract above.

`test/container-collection.test.mjs` uses fake pages and resource lifecycles to
check challenge counts, failure codes/stages, HTTP status bounds, non-Error
throws, cleanup order and the logout record. `worker-test/relay.test.ts` drives
the real Worker relay handler in workerd with fake WebSocket endpoints and VPC
streams: normal/EOF closes, open/read/write failures, queued-write suppression,
byte counts, and a read error after peer close. These tests use no provider
connection or browser; the existing Node CONNECT relay suite remains separate.

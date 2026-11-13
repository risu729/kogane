# SBI VCトレード (SBI VC Trade / VCTRADE) research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

- Research date: 2026-08-26 (Australia/Sydney)
- Scope: collection surfaces for Japanese-yen/cryptoasset account data in **VCTRADE**, provided by SBI VCトレード株式会社 (SBI VC Trade Co., Ltd.)
- Out of scope: the company's other services, SBI証券 (SBI Securities), cards, and external aggregators
- Constraints: public information, public Web artifacts, read-only static analysis of legitimately distributed apps, and read-only dynamic observation during owner operation are in scope. Do not obtain or record account identifiers, names, email addresses, phone numbers, actual balances, transaction contents, cookie values, tokens, passwords, TOTP seeds, OTPs, or passkeys. Do not place/cancel orders, deposit/withdraw money or cryptoassets, apply for coin lending, change authentication/account settings, or bypass security controls.

## Conclusion

SBI VCトレード has read surfaces for cryptoasset/yen asset status, balance history, order history, execution history, deposit/withdrawal history, profit/loss and reports, staking, and coin lending. A public customer API is not currently provided; the official FAQ describes future plans to publish one. Alongside browserless replay of the internal Web gateway with authenticated cookies and `secureKey`, unattended reauthentication creating a new session solely in a Cloudflare Worker from an existing Bitwarden passkey was demonstrated on 2026-08-31. A collector using a fixed read allowlist appears operable without a browser.

Overall assessment: manual export + local parsing is **E / cost 1**; a Web collector including unattended passkey reauthentication is **B / cost 3**. A read-only collector using standard Bun/Workers `fetch` and passkey login using Workers Web Crypto succeeded with real data; Cloudflare IP, browser TLS fingerprints, Chrome, and Turnstile were not prerequisites for the passkey route. Daily collection with a fixed read allowlist and private R2 storage is integrated into the Worker, making full browser/app automation unnecessary. Remaining work is long-term observation of fallback at absolute expiry and specification changes, and integration from the PoC into the main design.

Since 2026-09-13 the daily run is stored in the shared `DATA` bucket rather
than a private one, and since 2026-10-05 the Processor's alarms, not Cron
triggers, start the keepalive and the daily collection
([§15](#15-cloudflare-workers-sessionpasskey-poc),
[shared DATA bucket](#shared-data-bucket-u09-2026-09-11)).

## 1. Accounts, products, and enumerable information

### Officially confirmed facts

- `資産状況` ("asset status") displays holdings in Japanese yen and all assets.
- `残高履歴` ("balance history") displays Japanese-yen and all-asset balances as of a reference date/time.
- `ポジションサマリー` ("position summary") aggregates leveraged positions by asset and buy/sell direction; `ポジション照会` ("position inquiry") displays individual positions.
- `口座詳細` ("account details") displays net assets, margin for open orders, required position margin, margin maintenance ratio, available withdrawal amounts for money/cryptoassets, and similar fields.
- Current official tools are browser-based `VCTRADE（シンプルモード）` ("VCTRADE, simple mode"), `VCTRADE（トレーダーモード）` ("VCTRADE, trader mode"), and the iOS/Android `SBI VCトレードアプリ` ("SBI VC Trade app"). The app handles day-over-day changes/graphs of asset holdings, charts, orders, and staking information.
- Holding eligible cryptoassets generally enrolls the user in staking automatically. Average quantities are calculated from holdings at 06:59:59 on each business day, and rewards generally appear in deposit history by the 15th of the following month. Eligible assets and rates vary.
- Coin lending is a separate service requiring an application specifying quantity, with history/status inquiry surfaces. Unlike staking, it has applications, quantity conditions, and lending periods.

Primary sources:

- [Inquiry feature list](https://www.sbivc.co.jp/guide/1-14)
- [Trading tools/apps](https://www.sbivc.co.jp/services/tools-apps)
- [Report field descriptions](https://www.sbivc.co.jp/faqs/content/w6w84vhcjqwi)
- [Staking](https://www.sbivc.co.jp/services/staking)
- [Coin lending](https://home.sbivc.co.jp/services/lending)
- [Coin-lending applications/history](https://www.sbivc.co.jp/faqs/content/ktg3vu85rt7)

### Matters not inferred

- The complete eligible-cryptoasset list and rates change frequently and are not pinned in this document.
- The complete current coin-lending history column list cannot be established from current public primary sources.
- Reported total assets exclude unrealized profit/loss on open leveraged positions. Do not assume equality with other valuations displayed on screen.

## 2. Statement granularity, periods, counts, CSV/PDF

### On-screen granularity

- `注文履歴` ("order history"): new/closing orders for spot (brokerage/exchange) and leveraged trading. Includes unfilled orders.
- `約定履歴` ("execution history"): executed trades only. Excludes unfilled/canceled orders.
- `入出金・入出庫履歴` ("money/cryptoasset deposit/withdrawal history"): yen deposits/withdrawals, cryptoasset deposits/withdrawals, trading profit/loss, etc.
- `残高履歴`: Japanese-yen/cryptoasset balances as of a reference date/time.
- `報告書` ("reports"): annual/monthly/daily reports can be selected and downloaded as PDFs. Annual transaction reports are also provided to individuals.
- `年間損益報告書` ("annual profit/loss reports") covers per-asset transactions/realized profit/loss, beginning/end-of-year valuations and differences for spot trading, and position profit/loss, funding rates, and similar items for leveraged trading.

### Exports

- `損益計算用データ` ("profit/loss calculation data") is a ZIP containing 2 CSVs: execution history `TRADE_RECORD_LIST` and wallet/trading-account fund movements `CASHFLOW`.
- Annual profit/loss and similar reports are electronically delivered PDFs, not mailed.
- For garbled CSV text from September 2022 onward, the official FAQ recommends saving again as UTF-8 with BOM. ZIP extraction may be needed first.
- The new app officially lists annual/monthly/daily reports, but not CSV/ZIP retrieval. PC trader mode handles annual/monthly/daily reports and profit/loss calculation data; simple mode handles annual/monthly reports and profit/loss calculation data.

### Periods and counts

- A year for tax/annual reporting runs from January 1 07:00:00 through the following January 1 06:59:59. Daily boundaries also run from 07:00 to 06:59 the next day.
- Order/execution-history guides distinguish `直近4か月` ("most recent 4 months") from `4か月以前の履歴` ("history before 4 months ago") and explain filtering by period, asset, and similar criteria.
- Public primary sources do not establish maximum retention years including history before 4 months ago, per-retrieval limits, total-count limits, page size, or complete CSV column definitions.

Primary sources:

- [Viewing reports/downloading PDFs](https://www.sbivc.co.jp/guide/4-63)
- [Reports available by tool](https://www.sbivc.co.jp/faqs/content/e6vz-8vae19)
- [Annual profit/loss report and calculation CSV](https://www.sbivc.co.jp/faqs/content/apvc2fpgs6)
- [Annual aggregation period](https://www.sbivc.co.jp/faqs/content/jt0lgp_bl5gv)
- [Electronic PDF report delivery](https://www.sbivc.co.jp/faqs/content/wcl7k4f45k)
- [CSV encoding](https://www.sbivc.co.jp/faqs/content/mtjuaeit_5ib)
- [Order history](https://www.sbivc.co.jp/guide/4-21)
- [Execution history](https://www.sbivc.co.jp/guide/4-49)

## 3. Distinguishing pending / settled

- Unfilled exchange orders appear in a dedicated list. For FAS limit orders, the remaining quantity stays valid after partial execution; for FAK market orders, the remaining quantity expires after partial execution.
- Unfilled orders are canceled/expire during scheduled maintenance every Wednesday. The official FAQ states there is no other absolute order expiry.
- Execution history means `約定済み` ("executed"), not the accounting term settled, and excludes unfilled/canceled orders. Blockchain confirmation counts for cryptoasset deposits/withdrawals and accounting finalization times cannot be uniformly established from public screen specifications.
- A report's `出金・出庫予定額` ("scheduled money/cryptoasset withdrawal amount") means requests submitted but not yet completed. Accepted withdrawals are deducted from transferable amounts.
- Only 1 cryptoasset withdrawal reservation can exist at once; the next is accepted after completion. Do not enter this screen even for read-only research.

Primary sources:

- [Unfilled-order list](https://www.sbivc.co.jp/guide/4-89)
- [States excluded from execution history](https://www.sbivc.co.jp/guide/4-22)
- [Exchange rules (FAS/FAK)](https://www.sbivc.co.jp/auction)
- [Unfilled-order expiry](https://www.sbivc.co.jp/faqs/content/ohdsqdyigx)
- [Cryptoasset withdrawal reservations](https://www.sbivc.co.jp/guide/1-16)
- [Accepted withdrawals and transferable amounts](https://www.sbivc.co.jp/faqs/content/dokbb1fmd)

## 4. Authentication, MFA, passkeys, Bitwarden

### Confirmed facts

- Traditional login uses the registered email address or account number and password, followed by a 6-digit code when an authenticator app is configured.
- MFA has been mandatory since 2025-09-03. It uses an authenticator app or SMS; if neither is configured, a code is sent to the registered email address.
- Authenticator-app setup uses TOTP registered by QR code or account key. Seeds/keys and codes are secrets and must never be obtained.
- Passkeys were introduced to Web trader/simple/My Page modes on 2026-03-18 and supported in the current app from June that year. They use FIDO2; biometric information stays on the device. Passkey login can skip additional two-factor authentication, while ID/password + MFA remains available.
- Officially listed providers are iCloud Keychain, Google Password Manager, and Windows Hello. Up to 5 passkeys can be registered. Cloud synchronization within the same OS is possible, but synchronization across different OSs is not guaranteed.
- Repeated login failures cause a lock requiring a password reset.

### Relationship with Bitwarden

Bitwarden itself supports storing/using website/app passkeys. Although Bitwarden is absent from SBI VCトレード's official provider list, selecting the owner's existing Bitwarden passkey successfully logged in to current VCTRADE on 2026-08-31. Login success was also seen in ordinary Chrome opened mistakenly at first, but that tab was closed. The authoritative authenticated-traffic/schema evidence below was obtained in **Kogane Capture Chrome**, where the owner subsequently completed login. Bitwarden interoperability is therefore live-confirmed.

On the same day, the owner unlocked Bitwarden CLI 2026.8.0 in WSL with their master password and confirmed that the `SBI VCトレード` item held 1 FIDO2 credential. Inspecting field names without displaying values showed the CLI can obtain the structures needed for a WebAuthn assertion: `credentialId`, P-256 `keyValue`, `rpId`, `userHandle`, `counter`, etc. No Kogane-specific credential is created; this existing credential is the unattended-reauthentication candidate. Credential values, master password, and vault session are not saved in Git, PRs, or standard output.

Bitwarden's official documentation generally warns that exported passkeys may be rejected if their counters diverge from the service. This credential's stored value and successful browser assertion both had counter `0`. Bitwarden 2026.8.0 also increments only stored counters greater than 0, so this credential does not diverge from Bitwarden itself. The Worker accepts only counter `0`; if it becomes non-zero, it stops instead of guessing automatic updates.

Primary sources:

- [Normal login](https://www.sbivc.co.jp/guide/1-1)
- [Mandatory MFA and methods](https://www.sbivc.co.jp/faqs/content/fychc8w9x)
- [Authenticator-app setup](https://www.sbivc.co.jp/faqs/content/mmiani3gx8)
- [Passkey specification/supported environments](https://www.sbivc.co.jp/guide/5-1)
- [Passkey introduction](https://www.sbivc.co.jp/faqs/content/ym7cngjgatqv)
- [Passkey registration limit](https://www.sbivc.co.jp/guide/5-6)
- [Login lock](https://www.sbivc.co.jp/faqs/content/m9howuvxidze)
- [Bitwarden official: passkey storage/autofill](https://bitwarden.com/help/storing-passkeys/)
- [Bitwarden official: vault export/passkey counter caution](https://bitwarden.com/help/export-your-data/)

### Unknowns

Public documentation does not establish session lifetime, presence of refresh tokens, specific device-trust expiry, certificate pinning, device attestation, or private-API signature methods.

## 5. WAF / anti-bot

Passive observation on 2026-08-26, using only DNS resolution and HEAD/GET to public hosts, confirmed the following. Cookie **values** were not saved.

- `www.sbivc.co.jp`: confirmed Amazon CloudFront response/cache headers.
- `simple.sbivc.co.jp`: confirmed a Cloudflare CNAME, `server: cloudflare`, `cf-ray`, and the `__cf_bm` cookie name.
- `account.sbivc.co.jp`: confirmed a Cloudflare CNAME, the same headers/cookie name, and responses indicating CloudFront behind it.
- Cloudflare's official documentation says `__cf_bm` is used by Bot Management or Bot Fight Mode. There is therefore a direct technical signal of bot protection, but active WAF rules, bot mode, challenge conditions, and post-login behavior remain unknown.
- Absence of CAPTCHA on public routes is not evidence that authenticated or repeated access has no challenges. No signal of Akamai use was observed in this research.

Reference:

- [Cloudflare cookie documentation](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/)

## 6. Roles of the official app and Web

- The current official Android app package is `co.jp.sbivc.trade.app`; its iOS App Store ID is `6639604109`.
- The official Google Play listing linked from the official website names developer `SBI VC Trade Co., Ltd.` and shows an update date of 2026-08-05. Structuring the same public Google Play payload with `google-play-scraper` on 2026-08-26 yielded versionName `3.2.4`. versionCode could not be obtained from the public listing and remains unconfirmed.
- The old mobile app ended on 2026-01-28; the current app became the sole app from 2026-01-29. Do not infer current transport/authentication from old APKs/manuals.
- Simple mode provides a simplified PC/smartphone UI; trader mode a feature-rich PC UI; the current app integrates holdings trends, TradingView charts, speed orders, and staking displays.
- Obtaining legitimate split APKs, signature verification, decompilation, deobfuscation, static analysis, runtime tracing, and traffic-metadata observation are in scope. Do not execute modified APKs, bypass certificate pinning/attestation/root detection/Cloudflare challenges, save secrets/PII/actual values, or perform writes.

### 6.1 Legitimate split-APK acquisition status and provenance

This WSL/Windows environment had no Android device with the app legitimately installed from Play, ADB, Android SDK build-tools, or authorized Google Play delivery client. The public Google Play listing provides no APK download URL. Without switching to third-party APK mirrors, actual analysis of split APKs, manifest, signing certificate, versionCode, native libraries, and pinning/integrity implementations therefore remains unperformed.

Next time, use the same package legitimately installed from Google Play on an owner-controlled device and pull splits into temporary storage outside Git. Save every base/config split returned by `pm path`; do not mistake a single APK for the complete artifact.

```bash
export SBI_VC_APK_DIR="$(mktemp -d)"
adb devices -l
adb shell dumpsys package co.jp.sbivc.trade.app \
  | rg 'versionName|versionCode|firstInstallTime|lastUpdateTime'
adb shell pm path co.jp.sbivc.trade.app \
  | sed 's/^package://' > "$SBI_VC_APK_DIR/device-paths.txt"
while IFS= read -r remote_apk; do
  adb pull "$remote_apk" "$SBI_VC_APK_DIR/"
done < "$SBI_VC_APK_DIR/device-paths.txt"
sha256sum "$SBI_VC_APK_DIR"/*.apk
for apk in "$SBI_VC_APK_DIR"/*.apk; do
  apksigner verify --verbose --print-certs "$apk"
done
```

Record the Play listing's package/developer/version, device package/version, base APK manifest, hashes of every split, and consistent signer certificate digests across all splits as provenance. Do not commit APKs, certificates, or analysis output to the repository. Use the same acquisition method and certificate digest when comparing before/after updates.

### 6.2 Next static-analysis experiment

Once legitimate artifacts are obtained, separate manifest/resources/native libraries first, then examine decompiled code.

```bash
for apk in "$SBI_VC_APK_DIR"/*.apk; do
  apktool d -f "$apk" -o "$SBI_VC_APK_DIR/apktool-$(basename "$apk" .apk)"
done
jadx --log-level ERROR -d "$SBI_VC_APK_DIR/jadx" "$SBI_VC_APK_DIR"/*.apk
rg -n -i \
  'https?://|wss://|/api/|graphql|retrofit|okhttp|certificatepinner|network_security_config|play.?integrity|safetynet|attestation|refresh.?token|access.?token|session' \
  "$SBI_VC_APK_DIR/jadx" "$SBI_VC_APK_DIR"/apktool-*
```

Run MobSF locally only, record the image digest, then inspect the base and splits as an artifact set of the same version. Do not put result HTML/JSON in Git even after secret/PII scans.

```bash
docker pull opensecurity/mobile-security-framework-mobsf:latest
docker image inspect opensecurity/mobile-security-framework-mobsf:latest \
  --format '{{index .RepoDigests 0}}'
docker run --rm -it -p 127.0.0.1:8000:8000 \
  opensecurity/mobile-security-framework-mobsf:latest
```

Investigate hosts/paths, request/response model names, WebSocket/REST/GraphQL, token/session refresh, secure storage, network security config, certificate pinning, Play Integrity/attestation candidates, and root/anti-tamper candidates. Strings/classes are candidates, not proof of runtime activation. Do not confuse deobfuscation with control bypass.

Primary sources:

- [Official tool list/store links](https://www.sbivc.co.jp/services/tools-apps)
- [Old-app retirement/migration to the current app](https://www.sbivc.co.jp/newsview/r1rbpq2ec0)
- [Official Google Play listing](https://play.google.com/store/apps/details?id=co.jp.sbivc.trade.app)
- [Official Apple App Store listing](https://apps.apple.com/jp/app/6639604109)

## 7. Public API and third-party clients

### Confirmed facts

- SBI VCトレード's official FAQ and exchange description say the API is `今後公開予定` ("planned for future publication"). As of 2026-08-26, no public customer API specification, API keys, scopes, or read-only endpoints were found.
- Public GitHub searches by service name, official host, and Android package found no maintained public client connecting to current authenticated VCTRADE.
- [`kittyflip-zig/crypto-ledger-tools`](https://github.com/kittyflip-zig/crypto-ledger-tools) is an MIT-licensed local CSV normalization tool whose README has an initial SBI VC Trade adapter item. It is not a network client using API keys; full support for current SBI CSV is also unconfirmed.

Transport/authentication confirmed in third-party implementations is limited to "reading local files manually obtained by the user / no authentication." Official public Web bundles/source maps, however, make the current Web client's own transport concrete and were statically analyzed as described next. Endpoint/schema inspection itself is not prohibited; saving secret values and sending write events are prohibited.

### 7.1 Public Web JavaScript / source-map observation

On 2026-08-26, `https://simple.sbivc.co.jp/` served 4 public bundles as a Nuxt client; main bundle `/_nuxt/f89914f.js` had SHA-256 `ff7856cdbd3080d87c8bfba7f45fb6b2982fdf26699114a57bd7089a3f87582f`. The corresponding [`f89914f.js.map`](https://simple.sbivc.co.jp/_nuxt/f89914f.js.map) was also public, containing TypeScript source filenames and `sourceContent`. At research time, the source map returned HTTP 200, 882,355 bytes, and `Last-Modified: 2026-08-05`. Bundle hashes/filenames change on deployment and are not fixed API versions.

Public source `plugins/api/serverAPIClient.ts` established the following Web transport.

- JSON POST to the same origin, generally with body `{ event, data }` and response `{ meta, body }`. Timeout: 15 seconds.
- Login uses `/api/cccmdipresen/gw/login`, additional authentication `/api/cccmdipresen/gw/loginSecondAuth`, passkey start/completion dedicated paths, and market data `/api/cccmdipresen/gw/market`.
- Authenticated assets, orders, executions, cashflow, reports, coin lending, settings, orders/withdrawals, etc. go to the same `/api/cccmdipresen/gw/trade`, with functions dispatched by `event`.
- Candidate read events include `cashBalanceList`, `orderList`, `executionList`, `accountMargin`, `getCashflowList`, `tradeReportList`, `monthlyTradeReport`, `yearlyPlReport`, `plCalcData`, and `lendingStatusList`.
- Write events on the same path/session include `exStreamingOrder`, `requestWithdrawal`, `executeNetDeposit`, `applyReserveRequest`, `lendingRequest`, and MFA/passkey/customer settings changes. HTTP path/method alone cannot isolate reads/writes; an event allowlist is mandatory.
- `executionList` merges `historical=true/false` results client-side, showing recent/past data are separate backend views.
- Code persists Vuex `loginId`, wallet, and report state to `sessionStorage`. A separate Web3/NFT wallet module uses `accessToken`/`refreshToken` and an Authorization header; do not treat it as the VCTRADE trading-account session.
- The bundle contains Cloudflare Turnstile script/site-key configuration and a challenge-response field in login requests. Secret-like client config values are also visible in the public bundle, but were neither recorded, reproduced, nor tested for validity. Do not use them to bypass security controls.
- A client constant `sessionTimeoutTime: 14400` exists, but an actual server session lifetime of 4 hours is not yet confirmed.

Because no explicit Authorization header is visible in core trade calls, use of same-origin browser sessions/cookies remains an **inference**. Check cookie names, CSRF, server-side session refresh, and post-passkey session establishment through sanitized network metadata from owner operation. A public source map does not mean the API is public, stable, or licensed for use.

### 7.2 Web/app transport differences

The Web side is confirmed through the same-origin event gateway above. Without split APKs, app-side hosts, protocols, request models, token storage, pinning/integrity, and use of the same gateway remain unconfirmed. Do not guess whether the app uses WebView, native REST, WebSocket, or another method. Diff host/schema candidates from the legitimate APK against the Web list; promote only candidates actually used during owner read-only screen operation through dynamic observation.

Primary sources:

- [Official FAQ on planned API publication](https://www.sbivc.co.jp/faqs/content/5c0nv5540jm3)
- [Exchange-service description](https://www.sbivc.co.jp/auction)

## 8. Isolating read / write endpoints

### Recommended boundary

The safest configuration excludes authenticated network connections themselves from the parser. The user manually obtains PDF/ZIP files from official screens; the local parser processes only read-only-mounted input. Do not send raw files, PII, amounts, addresses, or account IDs to Git, logs, or the cloud.

Even when using a future official API or observed internal transport, do not connect until the following hold.

1. For an official API, read-only scopes/endpoints are documented. For internal transport, side-effect-free events/schemas are confirmed by one observation of owner operation.
2. Credentials without write authority are best. If reads/writes share a session as on the current website, fix origin+path+event in a collector-side egress proxy, making write events structurally unsendable.
3. Allowlist only confirmed read events. Do not regard HTTP GET/POST alone as proof of safety.
4. Apply deny-by-default, outbound-destination restrictions, response-log value masking, and small synthetic tests.

### Allowlist for UI observation

Only asset status, balance history, order history, execution history, money/cryptoasset deposit/withdrawal history, reports, coin-lending history, and staking displays are candidates. Cancellation/closing operations are adjacent to unfilled-order lists and position inquiries, so do not click after displaying the list.

### denylist

Orders, speed orders, cancellation/modification, quick closing, yen deposits/withdrawals, cryptoasset deposits/withdrawals, adding/deleting withdrawal addresses, coin-lending applications/cancellations, recurring purchases, password/MFA/passkey/personal-information/bank-account settings, and agreement to terms are all prohibited. With reads/writes sharing the same JavaScript-app session, browser automation alone cannot prove strong transport isolation.

## 9. Workers / Containers / OCI / Kubernetes suitability

- **Local OCI container: suitable.** An offline ZIP/CSV/PDF parser can be reproducible as an OCI image. Read-only input mounts, local output, no network, non-root operation, and pinned digests are desirable. An ordinary local CLI is enough for a single user.
- **Cloudflare Workers: suitable.** Cookie + `secureKey` replay succeeded with standard Bun/Workers `fetch`; a 15-minute Cron, encrypted Durable Object state, and `Set-Cookie` tracking were implemented. New-session bootstrap with Workers Web Crypto and an existing Bitwarden passkey was also demonstrated.
- **Cloudflare Containers: unnecessary.** Worker-only passkey login succeeded, so there is no reason to add a Container for full Chrome/WebAuthn.
- **Cloudflare Browser Rendering: unnecessary.** Both authentication and read transport were demonstrated with only a Worker.
- **Kubernetes: excessive for one account.** CronJobs, Secrets, NetworkPolicies, and similar features could be considered only for processing many manual exports within an organization; retain a design without authenticated retrieval first.

Infrastructure primary sources:

- [Cloudflare Workers Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/get-started/)
- [Cloudflare Browser Rendering CDP](https://developers.cloudflare.com/changelog/post/2026-04-10-browser-rendering-cdp-endpoint/)
- [OCI Image Specification](https://specs.opencontainers.org/image-spec/)
- [Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)

## 10. Shared A–E / cost assessment

Use only the shared scale from [PR #5](https://github.com/risu729/kogane/pull/5).

- A: documented direct export/API suitable for scheduled headless execution
- B: stable read-only internal API with renewable/reusable sessions
- C: headless replay after browser/app bootstrap is feasible
- D: full browser/device automation appears necessary
- E: manual capture is the safe default
- cost 1: small wrapper through cost 5: device-bound automation with bot protection

| Method                                                |               Assessment | Decision                                                                                                                                           |
| ----------------------------------------------------- | -----------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual PDF/ZIP retrieval + local parsing              |                **E / 1** | Official exports isolate secrets from processing. Recommended.                                                                                     |
| Future official read-only API                         | Unassessed (A candidate) | Specification not public yet. Reinvestigate after checking scopes/endpoints/rate limits.                                                           |
| Private Web API + unattended passkey reauthentication |                **B / 3** | Worker-only new passkey sessions, 15-minute rolling refresh, daily read collection, and private R2 storage succeeded. Long-term operation remains. |
| Full Web automation                                   |  **D / 5 (not adopted)** | Unnecessary because the Worker-only route works. Also increases risk from adjacent writes.                                                         |
| App static analysis + read-only dynamic observation   |    **C candidate / 4-5** | Next stage checks legitimate splits, signatures, hosts/schemas, tokens/sessions, and pinning/integrity candidates.                                 |
| Full app/device automation                            |                **D / 5** | Device authentication and mixed read/write surfaces. Reassess based on analysis results.                                                           |

## 11. Read-only live verification plan and stop conditions

### Staged verification

1. Retrieve public guides, FAQs, official stores, DNS/HTTP headers, and public HTML/JS/source maps; record URLs, hashes, and times. Do not reproduce or test token/secret-like bundle values.
2. Pull split APKs from the owner's device with a legitimate Play installation and check package/version/hashes/signing certificate. Extract host/path/schema/token/session/pinning/integrity candidates with jadx/apktool/MobSF, but keep artifacts/analysis output outside Git.
3. On the Web, the user logs in themselves; observe only method, origin, path, event name, status, content-type, and timing for 1 allowed read-screen operation through DevTools. Do not save request/response bodies, headers, cookies, tokens, IDs, or actual values. If using HAR, exclude bodies/headers at capture time and scan for secrets/PII before sharing.
4. In the app on the owner's device, operate only read screens such as assets, balance history, execution history, and reports; observe only host/path/status and similar metadata with standard ADB/logcat/Perfetto or ordinary local VPN capture. If TLS pinning prevents viewing contents, do not bypass it; limit work to static candidates and UI-automation assessment. Stop collection immediately if logcat emits actual values.
5. Compare confirmed Web/app read events, distinguishing matching schemas from app-specific APIs/tokens. If read-only replay cannot synthesize the body and requires a real session, restrict it to the owner's device, 1 event, 1 attempt, and a deny-by-default egress proxy.
6. The user downloads a report/ZIP themselves once and places it in local temporary storage outside Git. Initially inspect only masked column names, filenames, encoding, and period representations, without loading values. Do not commit, log, or send raw files to the cloud.
7. Create synthetic fixtures only from confirmed schemas and verify the offline parser. Do not copy actual values into fixtures. Do not explore unknown maximum periods/counts through repeated retrieval.

### Immediate stop conditions

- The researcher needs to enter/display/save login, MFA, passkey, email/SMS codes, QR, TOTP seeds, private keys, or cookie/token values, except where the owner operates normally and the researcher can observe only metadata without seeing values.
- Agreement to additional terms, device registration, authentication-settings changes, or password reset is required.
- A 403, 429, Cloudflare challenge, CAPTCHA, access restriction, login failure, or lock warning appears. Do not repeatedly retry, change IPs, or spoof headers.
- Progress requires orders, cancellation, closing, money/cryptoasset deposits/withdrawals, address registration, coin-lending applications, recurring purchases, or settings changes.
- Certificate pinning, Play Integrity/attestation, root/anti-tamper, or obfuscation is present and observation/execution requires bypassing those security controls. Their presence alone is not a stop condition.
- Sending non-allowlisted events, write events, or requests with unknown method/path/schema is necessary.
- Files/screens show PII, real balances/transactions, cryptoasset addresses, or similar information that might be logged/saved before masking.

Stop a route that reaches these conditions and retain manual export at E / cost 1. This does not prohibit all other read-only static analysis or observation without control bypass.

## 12. Reverification of the current Web on 2026-08-31

Rechecked without entering credentials whether public artifacts researched in PR #23 were still used in the current deployment. Filenames are observations that may change with each Nuxt deployment, not fixed collector contracts.

### Browser observation

- The initial public-login UI check mistakenly used ordinary Windows Chrome 151, confirming HTTP 200, email address/account number, password, and `パスキーでログイン` ("log in with a passkey"). That tab was closed. Only Kogane Capture Chrome is authoritative for subsequent authenticated network/schema observation.
- Initial display loaded `/libs/simplewebauthn-browser.min.js` and the Cloudflare Turnstile script/iframe.
- Before credential interaction, the browser sent `POST /api/cccmdipresen/gw/initiateLoginWithPasskey` once and received HTTP 200 `application/json`. The private capture's response contained `challenge`, RP ID, timeout, and `userVerification`; RP ID was `sbivc.co.jp`, and user verification `required`. Values are not saved in Git or PRs. This event bootstraps a WebAuthn challenge; although POST, it is not a write changing assets/settings. It is a concrete example of why HTTP method alone cannot classify reads/writes.
- Only the presence of the owner's SBI VCトレード item and passkey section in the Bitwarden vault was checked. Username, password, passkey material, TOTP, cookies, and response bodies were not displayed/copied/saved. Live bootstrap uses the existing passkey in Kogane Capture Chrome, retaining ID/password + MFA as the officially available fallback.

### Public bundles/source maps

The following 5 current chunks were observed directly from `/login` or at runtime.

| artifact     |     bytes | SHA-256                                                            |
| ------------ | --------: | ------------------------------------------------------------------ |
| `b21877a.js` |    33,499 | `d68fba0d820170d325466a639f2aa2e52a8b95e9b0ca015561d38dca3e9fe3c5` |
| `138abe1.js` |     4,128 | `21f1333fc473cab7db5d1bacb4627919fc9e6ea756bc13b003342e9df19cb602` |
| `70aeb42.js` |   300,940 | `78e0f0c8a551be815eeafc77133f10ce1e77545bf1af5466bb57b8802e020ad4` |
| `85a3155.js` | 1,564,956 | `4bf32b912ad1b72cfab6e9a2bfde4601d53ccac45b06966dae6b97775ca3dbf6` |
| `f89914f.js` |   496,749 | `ff7856cdbd3080d87c8bfba7f45fb6b2982fdf26699114a57bd7089a3f87582f` |

All 5 `.map` files also returned HTTP 200. `f89914f.js.map` had 882,355 bytes and SHA-256 `2c7c20685a71b1e9748e48e7cd8cb7d9e00271a9f68a4feccf22e5a3f69492fe`, with the same main bundle/source contents as at PR #23. The minimal read schema rechecked from `serverAPIClient.ts` follows.

Login-page map `b21877a.js.map` had 91,166 bytes and SHA-256 `d5c3e578f302981163acf19289631468cb0185b4229c231cd5c5c69a7fe2935a`; distributed `simplewebauthn-browser.min.js` had 9,234 bytes and SHA-256 `7597a071cdf7634156e2185a61b6e3f535fe544c23d3bad1be7f599c0a3b4cfa`. The source corresponds to `@simplewebauthn/browser@13.2.2`. All major artifacts recorded here had `Last-Modified` 2026-08-05.

| event                 | path                         | Required request-data elements                         | Purpose                                             |
| --------------------- | ---------------------------- | ------------------------------------------------------ | --------------------------------------------------- |
| `cashBalanceList`     | `/api/cccmdipresen/gw/trade` | `secureKey`                                            | Japanese-yen/cryptoasset balances                   |
| `accountMargin`       | Same as above                | `secureKey`                                            | Account details such as net assets/margins          |
| `positionSummaryList` | Same as above                | `secureKey`                                            | Held-position summary                               |
| `executionList`       | Same as above                | `secureKey`, page, sort, `historical`                  | Execution history. Separate recent/historical views |
| `getCashflowList`     | Same as above                | `secureKey`, page, `historical`, currency/type filters | Cashflow such as yen deposits/withdrawals           |

The execution-history page's runtime chunk was `32085e8.js` (23,308 bytes, SHA-256 `5669689931bf53e76a3cd98d4f4144ce70e5fb70e7feef9a74722085bee867c3`); its map had 61,277 bytes and SHA-256 `78b0bcfdaf5c37d72a8b79220c784286fe5dd5363e520e5187e6248d369867aa`. Source `pages/trade-history.vue` uses `sortKey: "executionDatetime"`, `sortAsc: "false"`, and page size 30. It obtains the historical page first, fetches the recent view only for page 0, and merges client-side. Page 1 onward uses only the historical view. The PoC follows that order and those values, without guessed sort keys or scanning every recent page.

The deposit/withdrawal-history page's chunk was `12ae015.js` (10,317 bytes, SHA-256 `d2a77c40f3a80e68010be78f14eec395c9fbddc7562ff4d65673b15242d5e706`); its map's SHA-256 was `4746882930a46470b5042c68ca9b3482afc3c92d745b8964dc50e904a6032269`. Source `pages/account-activity/history.vue` scans each page once with page size 30 and `historical: "true"`, without recent/old merging. Default filters are `currency: ["JPY"]` and `cashflowType: ["REMITTANCE_DEPOSIT", "REMITTANCE_WITHDRAW"]`. The public UI sends no date field; the PoC likewise sends no arbitrary date filter with a guessed format.

In public source, `secureKey` is `store.state.loginId`; it is not confirmed as an Authorization bearer. Cookie names, presence of CSRF, binding of cookies to `secureKey`, server session TTL, refresh method, and whether ordinary HTTP replay is allowed after Turnstile remain unconfirmed in a live session. Do not interpret client constant `sessionTimeoutTime: 14400` as a server-side 4-hour guarantee.

### Login transport and boundaries

- Password login: `POST /api/cccmdipresen/gw/login`, `{event: "login", data: {accountId, password, response}}`. `response` is the Turnstile token.
- Second auth: `POST /api/cccmdipresen/gw/loginSecondAuth`, `{event: "loginSecondAuth", data: {accountId, authCode}}`.
- Passkey start: `POST /api/cccmdipresen/gw/initiateLoginWithPasskey`, with data `channel: "SIMPLE_MODE"`.
- Passkey completion: `POST /api/cccmdipresen/gw/loginWithPasskey`. Sends challenge, credential ID, authenticator data, client data JSON, signature, and user handle.

Password-login requests contain Turnstile token `response`, but public source's passkey-start/completion request DTOs have no Turnstile token field. Start/completion returned 200 in Kogane Capture Chrome on 2026-08-31, and the same 2 requests succeeded with the new Worker session below. This demonstrated that this passkey route requires neither a Turnstile token, browser cookies, nor Cloudflare bot cookies.

Second auth's `authType` is `0` for email, `1` for authenticator/TOTP, and `2` for SMS. On password-login failure, the client resets the widget rather than reusing the Turnstile token. Cloudflare specifies Turnstile tokens as 5-minute/single-use, not session credentials to save/reuse. After passkey completion, the flow goes to login-success handling without the second-auth endpoint.

When login result `isAgreed` is false, the current UI proceeds to write event `setAgreement`. The collector does not automatically agree to terms; it stops that login and waits for the owner's agreement. Since 2026-11-07 the collector retries the passkey login hourly while it waits, so collection resumes on its own once the owner has agreed ([§16](#16-resuming-after-a-terms-agreement-2026-11-07)).

### Authenticated live verification

On 2026-08-31, the owner selected the existing Bitwarden-stored passkey in the **Kogane Capture Chrome profile** and logged in successfully. All authenticated network/schema evidence below was obtained in this profile. Secrets, actual request/response-body values, cookie values, account IDs, balances, and IPs were not saved.

| Order | sanitized metadata                                      | Result                                                              |
| ----: | ------------------------------------------------------- | ------------------------------------------------------------------- |
|     1 | Unauthenticated `accountMargin` / `positionSummaryList` | HTTP 403 `text/html`                                                |
|     2 | `initiateLoginWithPasskey`                              | HTTP 200 JSON                                                       |
|     3 | Owner approves WebAuthn assertion; `loginWithPasskey`   | HTTP 200 JSON                                                       |
|     4 | Authenticated `accountMargin`                           | HTTP 200 JSON                                                       |
|     5 | `informationTitle`, `getAuthStatus`, `getPasskeyList`   | All HTTP 200 JSON                                                   |
|     6 | Read-only asset-holdings screen                         | `positionSummaryList` and `accountMargin`: HTTP 200 JSON            |
|     7 | Read-only trade-history screen                          | `executionList` once each for recent/historical, both HTTP 200 JSON |
|     8 | Read-only trade-report list                             | `tradeReportList` twice, both HTTP 200 JSON                         |
|     9 | page reload                                             | Redirect to `/login#verifyGa`                                       |

Live `loginWithPasskey` request keys matched the public DTO: challenge, credential ID, authenticator data, client data JSON, signature, and user handle, with no Turnstile field. All fields used unpadded base64url. `clientDataJSON` had `webauthn.get`, origin `https://simple.sbivc.co.jp`, and `crossOrigin: false`; authenticator data was 37 bytes, with matching RP ID hash, flags `0x1d` (UP/UV/BE/BS), counter 0, and a P-256 ECDSA ASN.1 DER signature. Converting the Bitwarden-stored credential ID's UUID to raw 16 bytes matched the request value; the user handle matched too.

The `accountMargin` body contained `cashBalance`, `receivedMarginList` (46 items), `lendingLimitList` (33 items), `withdrawalLimitList` (23 items), `restrictedWithdrawalAmountList` (23 items), and related margin fields. Only counts/field names were recorded, not items, amounts, assets, or similar values. The `getAuthStatus` body had `isIdentified` and `isTotpIdentified`; `getPasskeyList` items had channel, credential ID, last-used datetime, label, registration datetime/source IP fields, and list length 1. Values were not saved.

On the asset-holdings screen, `positionSummaryList` sent only `{secureKey}` and returned HTTP 200 JSON. This account's live response body was an empty object, so position-item shape is not live-confirmed; the public bundle DTO structure remains provisional. The balance collector includes this event in its fixed allowlist alongside `cashBalanceList` and `accountMargin`.

The trade-history screen sent `executionList` twice as in the public source, with request keys `historical`, `isCloseOrder`, `isExOrder`, page number/size, `secureKey`, and sort ascending/key. Both returned HTTP 200; one had 6 items and the other 0. Distinguish recent/historical through request field `historical`, not inferred from response values. Live item keys included execution ID/sub-number, currency pair, product ID, execution quantity/price/datetime, commission amount/currency, trade/order price, order/buy-sell/close/ex-order type, settle/swap/base-currency PL, trade channel, public/internal memo, and value date. The envelope contained page number/size/total pages/total size and meta `secureKey`, session update time, status, and timestamp. Only field names/counts were saved; actual values were discarded.

The trade-report list sent `tradeReportList` twice, with request keys basis date from/to, unread-only, page number/size, `secureKey`, and statement type. Both returned HTTP 200 with 7 items each; item keys were basis date, read status/name, report title, and statement type, and pagination fields were strings. Values were discarded. The list event is added to the typed allowlist, but report details/downloads are neither clicked nor implemented because possible read-status updates remain unconfirmed.

Initial home display and read APIs succeeded, but reloading returned to `/login#verifyGa`. The cause remains unresolved among short-lived post-passkey sessions, additional verification on reload, cookie/sessionStorage combinations, Kogane Capture conditions, and other possibilities. Persistence across normal reload, transferring cookies/`secureKey` to Bun, and reuse by daily cron therefore remain unproven.

Passkeys are not a proprietary method like SMBC Safety Pass requiring biometric approval on a particular bank app's registered device every time. The existing Bitwarden credential logged in live, and its WebAuthn credential structure was obtainable through the CLI. Owner policy creates no Kogane-specific credential; the same existing credential is used for unattended Worker reauthentication. Treat private keys, credential IDs, user handles, and counters as financial credentials restricted to Worker Secrets, not Git or Durable Objects; only resulting sessions go into encrypted Durable Object state.

Cloudflare Workers Web Crypto implemented the same RP ID/origin, flags, counter, credential ID conversion, and P1363→DER signature conversion as the browser assertion above. Only required fields from the existing credential were supplied from Bitwarden CLI to Worker Secrets, and actual login from the Cloudflare Worker succeeded. With credential counter 0, no divergence from Bitwarden itself was observed; neither a dedicated passkey nor Container/browser handoff is needed.

## 13. read-only gateway PoC

A local Bun client calling only the 4 events above from an authenticated session was added to [`packages/sbi-vc-trade-client`](../../packages/sbi-vc-trade-client/).

Design constraints:

1. Export no generic event sender. Implement no APIs for orders, cancellation, money/cryptoasset withdrawals, coin-lending applications, recurring purchases, or MFA/passkey changes sharing the `trade` path.
2. Separate browser login from read replay. The PoC accepts no passwords, TOTP, SMS/email OTPs, Turnstile tokens, or passkey secrets.
3. Temporary session files contain only a Cookie header and `secureKey` and enforce mode 600. Do not expose values in arguments, stdout, or errors.
4. Retrieve recent and historical separately. Do not assume a single `historical=true` retrieves the full period.
5. Require HTTP success, JSON content type, and `meta.status === "OK"`. Do not save maintenance HTML or validation errors as raw data.
6. Continue pagination only when `list` and `totalSize` are confirmed, with a default cap of 100 pages. Do not scan indefinitely on unknown schemas.
7. Output contains actual balances/history: keep it only in local private directories, not Git, CI artifacts, stdout, or Cloudflare.

Synthetic tests verified request shapes, recent/historical separation, pagination stopping, non-JSON/error rejection, and exclusion of session values from error text. The authenticated Kogane Capture Chrome session was also passed to the local Bun client through a mode-600 tmpfs file, and every fixed-allowlist collector completed with real data. Direct HTTP replay, pagination, rolling session refresh, and unattended passkey reauthentication are demonstrated; only server absolute TTL remains unconfirmed.

### Completed live verification

1. Kogane Capture Chrome login succeeded with the existing passkey.
2. Treated Kuebiko raw capture as a secret artifact; passed cookies and `secureKey` to a mode-600 tmpfs file without stdout exposure.
3. Confirmed once that replay without cookies produces the application's `ログインしていません` ("not logged in") 403.
4. With cookies + `secureKey`, the Bun client's `cashBalanceList`, `accountMargin`, `positionSummaryList`, `executionList` recent/historical, and `getCashflowList` historical all returned HTTP 200 JSON and gateway `OK`.
5. Confirmed pagination stopping and private output modes, then deleted the tmpfs session file. Actual values/counts/secrets were not recorded in Git/PRs.
6. Triggered Workers Cron several times and confirmed rolling refresh of the encrypted session and 8 cookies.
7. Supplied a minimal existing Bitwarden passkey to Worker Secrets; Worker-only new login and immediately subsequent read-only keepalive succeeded.

Both direct authenticated-session replay and new bootstrap for use after expiry were demonstrated Worker-only. The existing Bun collector's fixed read allowlist was also ported into the Worker, through saving sanitized responses to private R2. Password-route Turnstile, browser TLS fingerprints, Chrome, Containers, and TAMIA are not adopted.

### Runtime candidate priority

| Runtime                                  | Current decision | Next proof                                                                                         |
| ---------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| Worker-only + existing Bitwarden passkey | **Adopted**      | New login from Cloudflare IP, construction of 8 cookies/`secureKey`, and read checks succeeded     |
| Worker keepalive                         | **Adopted**      | 15-minute Cron and cookie rotation succeeded. Observe fallback on actual absolute expiry long-term |
| Container + full Chrome                  | Not adopted      | Unnecessary because Worker-only authentication works                                               |
| Worker-only + password                   | Not recommended  | High instability in passing DOM Turnstile/single-use tokens to a separate runtime                  |
| Browser Rendering                        | Lower priority   | WebAuthn virtual-authenticator support in the current CDP schema remains unconfirmed               |

### Third-party client reinvestigation

GitHub code search was rerun on 2026-08-31 for `simple.sbivc.co.jp`, `co.jp.sbivc.trade.app`, and `cashBalanceList`, but found no maintained public client logging in to current VCTRADE for network retrieval. No SBI VCトレード implementation was found in the CCXT snapshot of 2026-08-29 either.

`kittyflip-zig/crypto-ledger-tools` is an MIT-licensed local CSV normalizer, not a network client. The 2026-06 snapshot's `sbivc_trade_record` adapter recognizes `trade_record_list` or columns `約定日時/銘柄/売買/数量` ("execution datetime/asset/buy-sell/quantity") and converts quantity, execution rate, fees, and similar fields to common JPY-quote records. SBI-specific fixtures/tests and a `CASHFLOW` parser were not found. It is an offline-import reference, not a precedent for authentication/session automation.

Additional technical references:

- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Current login-page source map](https://simple.sbivc.co.jp/_nuxt/b21877a.js.map)
- [Execution-history page source map](https://simple.sbivc.co.jp/_nuxt/32085e8.js.map)
- [Deposit/withdrawal-history page source map](https://simple.sbivc.co.jp/_nuxt/12ae015.js.map)
- [`crypto-ledger-tools` SBI adapter](https://github.com/kittyflip-zig/crypto-ledger-tools/blob/33758391c2b93ce99812257b2e4c1c82b67c6a1d/src/crypto_ledger_tools/exchange_adapters.py)

Remaining unknowns are server absolute TTL, the error schema for expired passkey credentials, rate limits, read-status updates on report retrieval, maximum page size, history retention, and app-specific transport/pinning/integrity.

## 14. Direct replay of an authenticated Web session on 2026-08-31

After the owner completed Bitwarden passkey login in Kogane Capture Chrome, browserless replay was verified once per read-only event. Kogane Capture was launched with `--net-log-capture-mode=Everything`, so raw capture itself is treated as a secret artifact potentially containing cookies and similar data. Cookie values, `secureKey`, account identifiers, amounts, assets, transaction contents, and response bodies were not exposed in stdout, Git, or PR bodies.

### Authentication and session boundaries

- `initiateLoginWithPasskey` and `loginWithPasskey` returned HTTP 200 JSON in Kogane Capture Chrome. Live `loginWithPasskey` top-level request fields were the full WebAuthn assertion, with no Turnstile response field.
- Unauthenticated `trade` calls returned HTTP 403 HTML; authenticated `accountMargin`, `positionSummaryList`, `executionList`, and `tradeReportList` returned HTTP 200 JSON.
- Kuebiko NetLog showed a `cookie` header on authenticated `trade` requests and multiple `set-cookie` response headers. Cookie-session use, previously inferred only from public bundles, was live-confirmed.
- Sending `accountMargin` from WSL/Bun with only the latest Kuebiko-saved `secureKey` and no cookies returned HTTP 403 with HTML title `ログインしていません`. This was application-session rejection, not a Cloudflare challenge page.
- Adding authenticated cookies to the same WSL/Bun request body returned HTTP 200 `application/json` and gateway status `OK`. Browser TLS fingerprints or the browser process itself were therefore not prerequisites for replay in this test; cookies paired with `secureKey` were required.
- Server-side absolute TTL of cookies and `secureKey` remains unconfirmed. A reload once returned to `/login#verifyGa`, so do not derive session lifetime solely from client constants. Transfer to another IP/region and fully unattended bootstrap from passkeys succeeded in subsequent Worker tests.

### Cookie minimization and rotation

For 19 authenticated `trade` requests, only SHA-256 equality comparisons were performed without outputting cookie values or `secureKey`. `secureKey`, `vct_bff_sid`, `JSESSIONID`, and `AWSALBAPP-0` through `AWSALBAPP-3` stayed identical throughout. `AWSALB`, `AWSALBCORS`, and 2 `__cf_bm` cookies changed repeatedly, and the full Cookie header differed almost every time across the 19 requests.

Login-response attributes set `Expires` about 30 minutes ahead for `vct_bff_sid`/`__cf_bm` and about 7 days ahead for `AWSALB`, `AWSALBCORS`, and `AWSALBAPP-0..3`. `JSESSIONID` had neither `Expires` nor `Max-Age`, making it a session cookie. Subsequent authenticated `trade` responses also set the same cookie names through `Set-Cookie`, extending unchanged `vct_bff_sid` values about 30 minutes ahead and AWS routing cookies about 7 days ahead. Thus 30 minutes is likely a rolling idle window rather than fixed login lifetime. A persistent collector avoiding reauthentication needs read-only keepalive less than 30 minutes apart and `Set-Cookie` tracking. Server absolute lifetime remains unknown.

Leave-one-out tests using only `accountMargin` gave the following results.

| Cookie subset                                                               | Result                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Only `vct_bff_sid` + `JSESSIONID`                                           | Application-side 403                                                           |
| Those 2 + `AWSALBAPP-0..3`                                                  | Initially 200, but 403 on later retest. Routing-dependent and not reproducible |
| Remove each `AWSALBAPP` fragment individually from the successful set above | All 4 cases: application-side 403                                              |
| `AWSALBAPP-0..3` + `JSESSIONID` (without `vct_bff_sid`)                     | Application-side 403                                                           |
| `AWSALBAPP-0..3` + `vct_bff_sid` (without `JSESSIONID`)                     | Application-side 403                                                           |
| Full header minus `__cf_bm`                                                 | HTTP 200 / gateway `OK`                                                        |
| Full header minus `AWSALB`/`AWSALBCORS`/`AWSALBAPP-*`                       | Application-side 403                                                           |

One attempt passed with only 6 cookies but was not reproducible, so do not remove `AWSALB` and `AWSALBCORS` from production input. The reproducible set here was 8 cookies: `vct_bff_sid`, `JSESSIONID`, split `AWSALBAPP-0..3`, `AWSALB`, and `AWSALBCORS`. Excluding `__cf_bm` still succeeded; the full header succeeded with both Bun's default User-Agent and Chrome User-Agent. Cloudflare Bot Management cookies and Chrome UA are therefore not prerequisites for same-host replay. AWS routing cookies rotate frequently, so long-running collectors may need a cookie jar tracking response `Set-Cookie`. Do not yet assert parity across other IPs/regions.

### Read-only collector verification with real data

Cookies and `secureKey` were passed to `packages/sbi-vc-trade-client` through a mode-600 tmpfs file; only the following fixed allowlist was executed.

- `cashBalanceList`
- `accountMargin`
- `positionSummaryList`
- `executionList` recent page 0 and historical pagination
- `getCashflowList` historical pagination (JPY deposit/withdrawal filter)

All events returned HTTP 200 JSON and gateway status `OK`; the collector produced 6 local artifacts and exited successfully. After typing session input to the 8 cookies above, the full collector also succeeded again without sending `__cf_bm`. Actual counts/values are not recorded in public documentation. Pagination stopped using `list` and `totalSize`, retaining the maximum cap of 100 pages. The initial output directory was mode 700 and each JSON mode 600, stored outside Git at `~/.local/share/kogane/sbi-vc-trade/<timestamp>/`. Output and the session file for the 8-cookie retest were deleted after verification on tmpfs. Cookies/`secureKey` were excluded from artifacts.

These results led to porting the transport to standard Workers/Bun `fetch`. Using the existing Bitwarden passkey with Worker Web Crypto also successfully bootstrapped new cookies/`secureKey`. Because the gateway/session is shared with write events, continue without a generic event sender and retain the compile-time read allowlist.

## 15. Cloudflare Workers session/passkey PoC

Temporary Worker `kogane-sbi-vc-session-poc` was added under [`services/collector-sbi-vc-trade`](../../services/collector-sbi-vc-trade/). GitHub Actions is not used as a trigger.

The Worker uses a Durable Object on the paid Cloudflare plan. Since
[#430](https://github.com/risu729/kogane/pull/430) (2026-10-05) it has no Cron
trigger: the Processor's `ScheduleAlarm` calls its private
`ScheduledCollection` entrypoint for the alarm jobs `sbi-vc-keepalive` (every
15 minutes) and `sbi-vc-trade` (06:05 JST), whose `cron` values `*/15 * * * *`
and `5 21 * * *` in `config/alarm-jobs.json` are the only ones
`runScheduled` accepts ([schedules](../schedules.md)).

### Configuration

- Initially supply the empirically required 8 cookies and `secureKey` in Worker Secret `SESSION_SEED`.
- Use Worker Secret `SESSION_ENCRYPTION_KEY` as an AES-256-GCM key to encrypt rotated sessions in the Durable Object.
- Worker Secret `PASSKEY_CREDENTIAL` contains only the existing Bitwarden credential's credential ID, PKCS#8 P-256 private key, RP ID, user handle, counter, and algorithm/curve. It excludes the master password and Bitwarden session key.
- Each keepalive run (`*/15 * * * *`) sends the light read-only event
  `informationTitle` once; the official UI itself sends it every 10 minutes.
- The daily job (`5 21 * * *`, 06:05 JST) reads cash balances, account margin,
  the position summary, recent and historical executions, and historical JPY
  cashflows.
- Artifacts and the collector manifest are written to the shared `DATA`
  bucket (`kogane-raw-evidence`) as content-addressed
  `objects/<2hex>/<sha256>` objects, and the `terminal-v1` manifest last at
  `runs/sbi-vc-trade/<runId>/terminal.json`
  ([below](#shared-data-bucket-u09-2026-09-11)). Until 2026-09-13 they went to
  the private bucket `kogane-sbi-vc-trade-poc` under
  `raw/sbi-vc-trade/YYYY/MM/DD/<run-id>/`; that bucket was emptied and deleted
  ([legacy retirement](../legacy-retirement.md)).
- Remove response `meta.secureKey` after using it for session refresh; do not save it in R2.
- The sanitized artifacts of a run are held in the Durable Object's memory
  until the terminal is written, and nothing is staged
  (`services/collector-sbi-vc-trade/src/worker.ts`, `#performCollection`).
  Writing each artifact to R2 as soon as it was read was the behaviour of the
  retired private-bucket path.
- Responses are capped at 64 KiB; check only the JSON envelope and `meta.status === "OK"`, without saving the body.
- Track only the 8 cookies from `Set-Cookie`, ignoring `__cf_bm`. Changes to `meta.secureKey` also update encrypted state.
- Plaintext health contains only last attempt/success, HTTP status, a closed gateway-status category (`OK` or `rejected`; non-`OK` strings returned by the gateway are neither saved nor logged), cookie-update count, consecutive-failure count, and fixed error codes. It excludes balances/history/cookie values/response bodies.
- Manual `/run`, `/reauth`, `/collect`, `/health`, and `ADMIN_TOKEN` were retired on 2026-11-08. Request manual collection through operations API `collection` and forced login through `session-refresh` (at most once per hour) ([ADR 0069](../adr/0069-collector-admin-retirement.md#retirement-of-the-last-two-admin-routes-2026-11-08)).
- Reauthenticate only when keepalive returns HTTP 401/403, gateway rejection, or a missing seed (while a terms agreement is pending, also on the gateway's 3xx `http_rejected`; [§16](#16-resuming-after-a-terms-agreement-2026-11-07)). A 6-hour cooldown (1 hour for up to 72 hours while an agreement is pending) prevents repeated logins; concurrent operations of the same kind collapse into one Promise, and keepalive/reauthentication session changes are serialized within the Durable Object.
- Passkey-completion response `body.accountId` matched the immediately subsequent read API's `secureKey`, so use it as the new session's `secureKey`. If `isAgreed !== true`, end that login with `manual_agreement_required` without sending `setAgreement`.

### Live results

On 2026-08-31 JST, the latest authenticated `trade` request was structured from the final 256 MiB of Kuebiko NetLog; 8 cookies were extracted without exposing values in stdout. `secureKey` was also obtained from the latest `informationTitle` request and passed through mode-600 tmpfs to standard input of `wrangler secret put`. The seed tmpfs file was deleted immediately after submission.

The first run returned HTTP 200 JSON and gateway `OK`, reflecting 3 session updates in encrypted state. The current authenticated session was therefore transferable to Cloudflare Workers egress; at least on this route, Japanese residential IPs, TAMIA, browser TLS fingerprints, Chrome User-Agent, and `__cf_bm` are unnecessary. Subsequent tests also succeeded at login/passkey bootstrap from Cloudflare IPs.

A subrequest with `redirect: "error"` in Workers runtime threw TypeError without returning a response. Changing the same request to `redirect: "manual"` (no following) produced 200; record this as a Workers fetch redirect-mode difference, not an observed SBI-side 3xx.

Cron fired several times, remaining HTTP 200, gateway `OK`, and consecutive failures 0 at least as of 2026-08-31 02:00 UTC.

On the same day, Bitwarden CLI was unlocked in WSL and only the required 7 fields were extracted from the `SBI VCトレード` item's existing FIDO2 credential to tmpfs. After supplying the Worker Secret, `/reauth` was executed once; the Cloudflare Worker successively completed `initiateLoginWithPasskey`, P-256 WebAuthn assertion generation, `loginWithPasskey`, and `informationTitle` with the new session. Health showed reauthentication success, HTTP 200, gateway `OK`, 3 cookie updates, and 0 consecutive failures. No Chrome, TAMIA, Japanese residential IP, Turnstile token, previous session cookies, or `__cf_bm` were used.

On the same day, an R2 binding and daily Cron were added to the Worker and an admin-authenticated `POST /collect` was executed once. The 6 artifacts `cash-balances`, `account-margin`, `position-summary`, `executions-recent-page-0001`, `executions-historical-page-0001`, and `cashflows-historical-page-0001`, totaling 35,180 bytes, plus a manifest were saved to private R2 with status `success` and failure 0. All artifacts were retrieved again from R2, confirming manifest SHA-256 matches, JSON-envelope gateway status `OK`, and exclusion of `meta.secureKey`. Financial values/bodies were neither displayed nor logged.

On 2026-09-07, 5 parsers were added to normalize the same 6 datasets into Layer B with source separation. Recent/historical executions share the provider's record shape and composite identity, so one parser using a collision-free tuple of `CExecutionId` and `CExecutionIdSubNo` handles both without duplicate implementation. Cashflow direction comes from signed `cashflowAmount`, not inferred from type labels. Cryptoasset quantity/amount/price retain decimal text and scale, without guessed conversion to known minor units as for fiat currencies. Every observation retains a fixed source account, JSON locator, and sanitized gateway meta/page context.

Timestamps (parsers 0.2.1, 2026-11-06): `meta.timestamp`, `statusDate`,
`executionDatetime` and `eventDatetime` are read in the audited slash form
`YYYY/MM/DD hh:mm:ss`, as JST, or as an ISO 8601 date-time with seconds and
an explicit offset, kept verbatim. The audited captures use only the slash
form. A value of either form whose date, clock time or offset does not exist
is refused, never repaired: an execution or cashflow page fails, and a gateway
timestamp or status date leaves the instant empty. 0.2.0 checked the ISO form
only for its shape; see [observations](../observations.md#sbi-vc-trade-an-iso-timestamp-that-does-not-exist-is-refused-five-parsers-021).

A reproducible read-only actual-shape canary against production R2
(`services/collector-r2-importer/scripts/audit-sbi-vc-r2.sh`) scanned the 63 objects / 9 manifests
present as of 2026-09-07, confirming only through aggregates that all 9 runs were successful, every artifact
matched exactly one parser, and parse failures were 0.
The canary performs only R2 list/get from a temporary localhost Worker and outputs no object keys, hashes, bodies,
financial values, account identifiers, or secrets. In the 9 observed runs, positions and
recent executions were both empty; historical executions/cashflows each had 1 page.
Non-empty positions/recent executions, multi-page chains, and same-identity overlap between
recent/historical views are therefore unconfirmed in production evidence. Those boundaries are pinned with anonymous
synthetic fixtures and negative tests, not described as actually observed.

This demonstrated both rolling keepalive and an unattended recovery route after absolute/session expiry. Automatic fallback at the actual instant of absolute expiry, credential revocation, backend schema changes, and long-term rate limits remain unconfirmed. Successful manual `/reauth` alone does not prove every failure mode of Cron fallback.

### Central raw-evidence transfer

Historical record: the private outbox bucket, the importer
(`kogane-collector-r2-importer`), its Service Binding and
`scripts/backfill-raw-evidence.sh` described in this section and the next were
retired on 2026-09-13 ([legacy retirement](../legacy-retirement.md)). The
collector now writes each run once, into `DATA`
([below](#shared-data-bucket-u09-2026-09-11)).

An internal Service Binding to `kogane-collector-r2-importer` was added while keeping private R2 as a durable outbox without deleting it. The collector saves the manifest last to establish the run boundary and passes only its key to the importer.

Each artifact/manifest R2 put uses `etagDoesNotMatch: "*"` to reject overwriting the same key and specifies native R2 SHA-256. UUID run prefixes and manifest-last can serve as commit markers for future R2 notifications too, so no separate `commit.json` is added. Existing outbox data without native SHA-256 remains backfillable through agreement of manifest values, custom metadata, and recalculated SHA-256.

Using SBI VC Trade-specific ordering/pagination contracts, the importer validates manifest schema/source/run/date/status, fixed datasets, sequential historical pages/consistent `totalSize`/page lengths/stopping conditions, the next missing dataset on failure, all prefix objects, sizes, custom metadata, and SHA-256 before creating a central run. The collector, importer, and Layer B parsers all validate page size 30, page numbers, `totalNumOfPages`, `totalSize`, and list cardinality, failing closed with truncation evidence when the recent view exceeds one page. Artifacts are at most 4 MiB and at most 204 in number; validate sequentially without retaining all bytes at once, then transfer original bytes reread/revalidated at transfer time without reserialization. The synchronous Service Binding route allows up to 11 data artifacts; 12 or more defer in R2 to the later Queue reconciler without creating central state. The central route and Bearer client are dedicated to `collector-r2-sbi-vc`, separate from the SBI証券 client.
The importer also rejects duplicate provider identities within one page and throughout the historical page chain.
Recent/historical views are validated as separate sets, so the same execution tuple may appear
in both views; Layer B retains it with the same externalId and different sourceView.

When `collect` detects a pagination anomaly, the collector saves the last provider response that caused it before finalizing a partial manifest. For that final artifact, the importer validates the envelope, gateway status, secret removal, R2 metadata, hash, size, and dataset position; rather than treating it as a normal page, it catalogues it centrally as "raw evidence of the failure cause." This preserves the anomalous response while sealing the whole run as partial/failed.
The observation pipeline carries parent fetch-run status and failure count into artifact metadata
and excludes runs without success and failure 0 from execution across all parsers.
Current queries recheck the same conditions, so even successful parses left by an older implementation
on partial runs do not become current observations. An end-to-end regression pins a pagination-total-changed partial
run to 0 current observations.

The outbox remains even if immediate transfer fails; `scripts/backfill-raw-evidence.sh` repeats separate top-level requests with cursors. Each request scans at most 1 R2 object and, when it finds a manifest, idempotently resubmits only 1 run. Automatic retries/monitoring belong to the later reconciler and are outside this change.

Manifests exceeding the synchronous limit are counted as deferred rather than backfill failures, advancing the cursor. This prevents large runs from permanently blocking later synchronously transferable runs, while deferred runs remain candidates for the reconciler's Queue chunking.

### Production verification of central transfer

On 2026-09-04 JST, central D1 migration `0006_sbi_vc_trade_collector_r2.sql`, the central ingest Worker, collector-R2 importer, and SBI VC Trade collector were deployed to production in that order. Central `/health` returned schema `0006`; a synthetic round trip also completed through sealed.

One new collection was then run on the real account. The source saved 6 data artifacts and a manifest with `success`; the central side accepted 7 artifacts and sealed. Without displaying financial values or response bodies, 1 source R2 artifact and the central content-addressed object were retrieved again and compared: bytes, SHA-256, and size matched exactly.

Backfill of the entire existing outbox scanned 35 objects, 5 manifests, and 30 data objects; all 5 runs sealed centrally. Running the same backfill again idempotently reused existing runs for all 5 manifests; central D1 aggregates were 5 runs, 5 seals, 35 artifacts, and 0 unsealed. Source R2 objects were not deleted.

### Cleanup targets

- Worker: `kogane-sbi-vc-session-poc`
- Durable Object class: `SbiVcSessionState`
- Alarm jobs (Processor, `config/alarm-jobs.json`): `sbi-vc-keepalive`, `sbi-vc-trade`
- Secrets: `SESSION_SEED`, `SESSION_ENCRYPTION_KEY`, `PASSKEY_CREDENTIAL` (`ADMIN_TOKEN` was retired on 2026-11-08 with its routes, [ADR 0069 amendment](../adr/0069-collector-admin-retirement.md#retirement-of-the-last-two-admin-routes-2026-11-08))

The Worker has no Cron trigger and holds no bucket of its own: the private
bucket `kogane-sbi-vc-trade-poc` was emptied and deleted on 2026-09-13 after
its objects were copied to `DATA` ([legacy retirement](../legacy-retirement.md)),
and the 15-minute and daily runs are Processor alarm jobs since
[#430](https://github.com/risu729/kogane/pull/430). Tearing the collector down
means deleting the Worker (`npx wrangler delete --name kogane-sbi-vc-session-poc`
from `services/collector-sbi-vc-trade`), its Durable Object binding and
secrets, and disabling or removing the two alarm jobs; the shared `DATA` bucket,
which every collector and the Processor use, is not deleted. All of it stays
in place for daily collection.

## Shared DATA bucket (U09, 2026-09-11)

The collector does not read `COLLECTION_TARGET`. It persists the run only
through the `DATA` binding to the central `kogane-raw-evidence` bucket. The
session Durable Object writes the sanitized gateway envelopes and the collector
manifest with `packages/collection`, then the `terminal-v1` manifest last. The
upload to `kogane-collector-r2-importer` is not part of this path. The
keep-alive (`*/15 * * * *`) and the collection (`5 21 * * *`) were unchanged
by this switch; since [#430](https://github.com/risu729/kogane/pull/430) they
run as Processor alarm jobs rather than Cron triggers (§15). The run is
stored once, in `DATA`.

The Durable Object now also keeps a **session generation id** (`sessionRef`),
minted when a session is seeded and rotated when re-authentication replaces it,
written in the same storage batch as the session so a failed re-authentication
cannot lose the previous generation. The terminal carries that opaque id as
`acquisitionSessionRef`; no cookie, encryption key or passkey credential is
ever written to `DATA`.

A collection blocked on re-authentication is recorded as a `failed` run with
`human_required_reauth` (or `manual_agreement_required` while the provider's
terms wait for the owner) and a `waitingForHuman` signal; the blocked
collection itself is never retried. The login behind it is retried on its
cooldown ([§16](#16-resuming-after-a-terms-agreement-2026-11-07)).

The artifact/role table is in
[`docs/collection.md`](../collection.md#sbi-vc-trade-kogane-sbi-vc-session-poc).

## 16. Resuming after a terms agreement (2026-11-07)

Owner decision, 2026-11-07 06:28 UTC (options A and D of the reviewed
proposal; recorded in the
[ADR 0026 amendment](../adr/0026-collector-unit-coverage.md#amendment-sbi-vc-retries-the-login-while-a-terms-agreement-is-pending-2026-11-07)):
collection resumes by itself once the owner has agreed to the provider's
terms. No `ADMIN_TOKEN`, `/reauth` call or other manual step is needed. (Since
2026-11-08 there is no `/reauth` route: an operations-API `session-refresh`
request is the operator's forced login, ADR 0069 amendment.)

What happened before: a passkey login whose result has `isAgreed !== true`
stored `lastReauthErrorCode: "manual_agreement_required"`, and from then on
`shouldReauthenticate` returned `false` for good. Only a successful forced
`POST /reauth` cleared it, and the bearer token for it is a write-only Worker
secret, so every agreement meant rotating that secret by hand. In production
the keepalive failed this way from 2026-10-23 18:00 UTC and again from
2026-11-07 04:30 UTC; the health record then held
`lastErrorCode: "http_rejected"` (the gateway answers the stale session with a
3xx, which `redirect: "manual"` surfaces), `lastReauthErrorCode:
"manual_agreement_required"` and 1,604 consecutive failures.

What the collector does now
(`services/collector-sbi-vc-trade/src/session-policy.ts`):

- The usual re-authentication triggers apply while an agreement is pending
  (HTTP 401/403, `gateway_rejected`, a missing session seed). A healthy
  keepalive that still carries the old code does not log in.
- While an agreement is pending (`manual_agreement_required` is stored, or
  `manualAgreementPendingSince` is set because a later retry failed for another
  reason), `http_rejected` with a 3xx status is also a trigger, because that is
  how the gateway refuses the stale session. Outside that state a 3xx stays a
  plain failure, as before.
- An unforced login waits 1 hour after the previous attempt while the stored
  code is `manual_agreement_required`, for 72 hours after the first refused
  login since the last successful one (`manualAgreementPendingSince` in the
  health record), and then the usual 6 hours. A record written before this
  field existed opens the 72-hour window at its next refused login. Only a successful login clears the
  field: a different login failure in between (a maintenance answer, a network
  error) keeps it, so a later refusal does not reopen the window.
- The collector still never sends `setAgreement`: agreeing is the owner's act
  (§8 denylist).

What the owner does: agree once at simple.sbivc.co.jp. The login uses the
`SIMPLE_MODE` channel; whether agreeing in another SBI VC app clears it has not
been observed. The keepalive runs every 15 minutes, so the next login comes at
the first tick an hour after the previous one, and recovery takes up to about
1 h 15 min after the agreement. The keepalive then refreshes the new session
and the next daily collection (`5 21 * * *`) runs.

Collection quality flags `manual_agreement_required` as `user_action_required`
(`packages/application/src/query/collection-quality.ts`), on the job's newest
receipt and on a blocked unit, so the pending agreement shows the same day.

Risks the owner accepted with this decision, which also approves these
unattended production logins: repeated failed logins can lock the account
(§4) and the provider's rate limit is unconfirmed (§13). Whether a login that
stops at `isAgreed` counts as a failed login, and whether each one e-mails the
owner, is unknown. The 72-hour window bounds the hourly logins to at most 72,
about 60 at the usual 75-minute cadence; after it, one login every 6 hours.

When a retry during the wait fails with another code (for example
`passkey_http_503` during provider maintenance), that code replaces the stored
one and the occurrence carries `human_required_reauth` (also flagged as
`user_action_required`). The kept `manualAgreementPendingSince` still makes the
3xx a trigger, so logins continue at the usual 6-hour spacing. When a retry is
refused for the agreement again, the hourly spacing returns only inside the
original 72-hour window, which is not reopened.

## 17. Unfiltered cash-flow observation (2026-11-10)

The owner authenticated the local Chrome session. Observation of the official
trader-mode cash-flow history used read-only screen controls. Its transport was
Socket.IO: an event frame names `getCashflowList` and an argument carries the
gateway-shaped `meta` / `body` response. This is distinct from the simple-mode
HTTP gateway already used by the collector (§12–§13). No manual HTTP replay,
new collector run or hosted validation of these additional parameters was done.
Normal navigation of the current simple-mode JPY history also confirmed
`POST https://simple.sbivc.co.jp/api/cccmdipresen/gw/trade`, with an
`event: "getCashflowList"` / `data` JSON request. That screen sends the existing
size-30, `historical: "true"`, JPY/remittance filter and the runtime
`secureKey`; it offers no all-type selector. The common event and envelope are
observed on both transports, while the unfiltered parameters on HTTP remain
unverified.

The screen's all-currency/all-type request carries these fields:

| Field                          | Type and value                                                               |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `historical`                   | string `"false"` for `最新` (latest), `"true"` for `過去履歴` (past history) |
| `currency`, `cashflowType`     | empty arrays                                                                 |
| `eventDateFrom`, `eventDateTo` | empty strings                                                                |
| `sortKey`, `sortAsc`           | strings `"cashflowDatetime"`, `"false"`                                      |
| `pageNumber`, `pageSize`       | strings `"0"`, `"20"` on the first page                                      |

Responses carry `list`, `pageNumber`, `pageSize`, `totalSize` and
`totalNumOfPages`. The latest view had an empty list with page number 0,
page size 20, total size 0 and total pages 0. The past view's list length
matched its stated total and its cash-flow identities were distinct. Its rows
had string fields `cashflowAmount`, `valueYmdDate`, `publicMemo`, `cashflowID`,
`cashflowType`, `eventDatetime`, `processStatusType`, `currency` and
`cashbalance`. Observed closed type codes were `WITHDRAW_COMMISSION`,
`REMITTANCE_WITHDRAW`, `EXCHANGE`, `COMMISSION` and `REMITTANCE_DEPOSIT`;
the observed status code was `PROCESSED`. These codes are recorded as protocol
evidence, without inferring a fee, exchange, transfer or income publication rule.
Selecting the trader UI's staking option sent `cashflowType: ["STAKING"]`
and returned an empty list. This establishes a selectable code, not a reward
row's schema or a positive collection result.

The collector retains the existing filtered JPY dataset and additionally walks
both all-type views in `cashflows-all-recent-page-NNNN` and
`cashflows-all-historical-page-NNNN`, using the existing HTTP
`getCashflowList` event. Stable totals, exact page sizes and list cardinality
are required before the raw collection unit can succeed. These new datasets
have no publishing parser, so an overlapping JPY row is not published twice and
an unknown type or status cannot be classified as a fiat movement or income.
The lists have their own `full-cashflows` unit: a failure there leaves the run
partial but does not invalidate a completed classic `account` unit. Only the
exact classic dataset paths opt into unit eligibility; a failed classic unit
still publishes nothing from that run.

Remaining limits for [the cash-flow issue](https://github.com/risu729/kogane/issues/1227):
no crypto deposit, crypto withdrawal, staking reward or lending reward response
row was observed. Their codes and semantics remain unsupported; `asset_transfer`
and `income` stay `not_collected` in the provider catalogue. Full-list capture is
not proof that those typed data are collected. Counts per type matching a new
scheduled collection, full-retention coverage and the additional parameters on
the deployed HTTP transport remain unverified.

## 18. Simple-mode documents and spot execution correspondence (2026-11-10)

Normal navigation of the authenticated official simple-mode `/trade-report`
screen confirmed the same HTTP gateway host and session mode used by this
Worker: `POST https://simple.sbivc.co.jp/api/cccmdipresen/gw/trade`, JSON
`{event, data}`, with the runtime `secureKey` in `data`. These document calls
were observed over HTTP; they are not an inferred port of trader Socket.IO.
No new hosted collector run was made as part of this observation.

| Event / statement type           | Observed request fields beyond `secureKey`                                                                                                                  | Response shape                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `tradeReportList` / `MONTH`      | `statementType: "MONTH"`, `fromBasisYmdDate: "YYYY0101"`, `toBasisYmdDate: "YYYY1231"`, `getUnreadReportOnly: "false"`, `pageSize: "30"`, `pageNumber: "0"` | `body` has string `pageNumber`, `totalSize`, `totalNumOfPages`, and `list`; no `pageSize` |
| `tradeReportList` / `TRADE_DATA` | Same year bounds and paging fields, `statementType: "TRADE_DATA"`                                                                                           | `body` has only `list`; no totals or pagination metadata                                  |
| `tradeReportList` / `YEAR`       | `statementType: "YEAR"`, unread/paging fields as above; no date bounds                                                                                      | String pagination metadata and an explicitly empty `list`                                 |
| `monthlyTradeReport`             | `basisYmDate` copied unchanged from the selected row's eight-digit `basisYmdDate`                                                                           | PDF download described below                                                              |
| `plCalcData`                     | The same unchanged eight-digit row identity                                                                                                                 | ZIP download described below                                                              |

MONTH rows have string `readStatus`, `readStatusString`, `statementType`,
`reportTitle`, `basisYmdDate`. TRADE_DATA rows have only the last three fields.
Opening a monthly PDF changes its server-side read status from `0` to `1`
(`閲覧済`); no separate write event was sent. This read receipt is an intrinsic
side effect of the document collection authorized by the owner. The allowlist
does not add a status-update event.

Both download responses were HTTP 200 with `application/pdf` or
`application/zip`, but their HTTP bodies were JSON, not native file bytes:
`{body: {type: "Buffer", data: number[]}, meta: {status: "OK"}}`. The top keys
were `body` and `meta`; the download metadata had only `status`. The collector
bounds the envelope, requires integer bytes in 0..255 and the native signature,
then stores the decoded bytes. It never saves the JSON wrapper as a PDF/ZIP.
The full eight-digit `basisYmdDate` is the download identity even though the
request field is named `basisYmDate`; reducing it to six digits is unsupported.

The UI offered years 2018..2026. Each of 2018..2025 returned empty MONTH and
TRADE_DATA lists; 2026 offered ten of each. This is a selectable window, not a
provider retention guarantee. The collector's operational window is 2018
through the capture's Asia/Tokyo calendar year, bounded to fewer than 100 years.
That is our collection policy, not a claim to have inspected the UI's year
calculation script. MONTH walks at most 100 size-30 pages with stable totals,
cardinality and unique report identities. TRADE_DATA has no pagination proof:
a list reaching 30 rows is retained but refused as potentially truncated.
Unknown response shapes fail closed. YEAR is requested once without bounds;
its explicit zero is recorded as complete-empty raw index evidence. A future
nonempty annual index is retained as partial; no annual download event is
inferred. Daily reports and valuation history remain unobserved.

The ordinary ZIP has two deflated UTF-8 CSV entries, named with
`TRADE_RECORD_LIST` and `CASHFLOW` prefixes. CSV parsing handles quoted fields,
escaped quotes and CRLF. The execution CSV has these exact 14 headers:

```text
約定日時,取引番号,取引区分,銘柄,注文先（自己または委託の別）,売買,数量,約定レート,建玉損益,建玉損益（円）,取引手数料,ファンディングレート（円）,決済損益（円）,円転レート
```

Two valid cash-flow header versions were observed, with 47 and 53 columns.
Their first six headers are `日時,入出金の種別,暗号資産/通貨,数量,評価レート,入出金額（円）`,
the last is `備考`, and the intervening unique `残高_*` columns vary in count
and order. The latest version added assets including JPYSC and POL and omitted
MATIC. The validator accepts 1..128 unique uppercase alphanumeric balance
column suffixes; it does not interpret balances or publish unknown assets.
Both CSVs were also observed as header-only files with zero data rows. Every
row must match its own file's header width, with valid `YYYY/MM/DD HH:mm:ss`
dates within the selected identity's first-six-digit month. No timezone
conversion is inferred from these offset-free provider strings.

For the populated observed month, all five execution CSV rows matched API
`CExecutionId + "-" + CExecutionIdSubNo` one-to-one; the bare execution ID
matched none. Each CSV `約定日時` equalled its matched `executionDatetime`
exactly. API `executionYmdDate` uses `YYYY/MM/DD`. All five CSV rows said
`現物`: one `販売所（自己）` row matched `isAuction: false`, and four
`取引所（委託）` rows matched `isAuction: true`. All had API
`isExOrder: {attribute: "EX", value: "true"}` and
`isCloseOrder: {attribute: "new", value: "false"}`. Thus the existing spot
filter includes both retail and exchange executions; another venue endpoint
would duplicate them. This resolves that distinction for
[#1228](https://github.com/risu729/kogane/issues/1228), while leverage opening
and closing filters were subsequently observed in section 20. The full historical API list had six
executions; the same-month CSV contained five. The cash-flow CSV's sixteen
rows matched the all-type API count within that month. Individual financial
values and identities are not included here.

The implementation archives native PDF/ZIP files as immutable private
`provider_document` evidence, with period and content hash in their keys.
The metadata parser emits evidence-only coverage and zero economic
observations. CSV validation and comparison emit a separate count-check
artifact; they never issue a second execution or cash-flow publication.
Comparison requires all four recent/historical API views and a completed
full-cashflow unit: missing data is not treated as zero. A failed comparison
keeps the valid ZIP, while a failed download cannot borrow a previous run's
unit. CORE 0097 opts only the two document datasets into independent-unit
metadata parsing; raw evidence listing does not require those policy rows.

[#1249](https://github.com/risu729/kogane/issues/1249) remains partial: annual
PDF downloads, daily reports, balance/valuation history, provider retention
limits, and a deployed scheduled run with these document calls are unverified.

## 19. Intermittent keepalive refusals and recovery (2026-11-11)

A read-only Workers Logs review on 2026-11-11 contradicts the continuous
outage suggested by [#1300](https://github.com/risu729/kogane/issues/1300).
HTTP 403 keepalive failures occurred between 2026-11-09 23:00 UTC and
2026-11-11 05:00 UTC, with successful HTTP 200 keepalives between them.
Error-level logs alone cannot establish that every keepalive failed.

Two unsampled boundary traces establish the recovery path:

- 2026-11-10 17:30:03.126 UTC: HTTP 403; 17:30:04.094: passkey
  reauthentication succeeded; 17:30:04.240: keepalive HTTP 200.
- 2026-11-11 05:00:01.338 UTC: HTTP 403; 05:00:03.092: passkey
  reauthentication succeeded; 05:00:03.248: keepalive HTTP 200;
  05:15:01.300: another keepalive HTTP 200.

The disappearance of the observed errors after 05:00 is therefore consistent
with successful automatic session replacement, not an alarm stopping. The
read-only operations snapshot also showed a completed 14:45 keepalive and an
armed 15:00 occurrence. The 2026-11-10 21:05 scheduled collection was completed
and its fetch was registered. These observations establish recovery at those
instants, not a guarantee of future health or of every dataset's publication.

The rejected responses' bodies were not inspected. Whether the original 403
was caused by expiry, invalidation, a notice, routing or request blocking
remains unknown; a 403 alone cannot distinguish them. No new provider login,
credential access or collection was performed for this investigation.

The collector now records `sessionRefreshRequired: true` with a keepalive
refusal that calls for reauthentication: HTTP 401/403, gateway rejection,
missing seed, or the existing pending-agreement redirect case. Further
keepalive calls return that stored failure without contacting the gateway,
updating the failure timestamp/count, or seeding the rejected session again.
A successful passkey login stores the replacement session and clears the flag
atomically. The next keepalive validates it before collection can proceed.
A health record from before this field defaults to false; its next refusal
sets the flag. Ordinary server/network failures retain their retry behavior.

Processor alarms remain enabled and keep the existing unforced login cooldown:
six hours normally, or one hour for the bounded pending-agreement window in
section 16. The owner session-refresh operation keeps its existing one-hour
forced-login spacing. No provider terms are accepted automatically. A failed
login leaves the flag and stored failure intact. Synthetic Workers-runtime
tests cover refused-session suppression, failed login, successful passkey
replacement and resumed keepalive, plus retry after a server error.

No owner session action was indicated by the verified recovery snapshot. If a
later login reports `manual_agreement_required`, the owner must agree at the
provider; another human-required reauthentication failure needs the existing
operations recovery path. The underlying cause of the intermittent 403s is
still unverified and this issue must not claim it has been diagnosed.

## 20. Trader leverage execution filters (2026-11-11)

Normal authenticated trader navigation selected `販売所：レバレッジ` →
`約定履歴` → `検索`. The screen displays a My Number registration prerequisite
for leverage; no registration, order or account-setting action was performed.
Read-only execution-history controls remained accessible. The observed transport
was Socket.IO event `executionList`, not the simple-mode HTTP gateway.

All four combinations below displayed the official no-data marker. The inspected
empty acknowledgement had numeric `pageSize`, `pageNumber`, `totalSize` and
`totalNumOfPages`, with `pageSize: 20`, the other three zero, and `list: []`.
No populated leverage execution, fee semantics or row contract was observed.

| Selected kind | `isExOrder` | `isCloseOrder` | Latest `historical` | Past-history `historical` |
| ------------- | ----------- | -------------- | ------------------- | ------------------------- |
| `新規`        | `"false"`   | `"false"`      | `"false"`           | `"true"`                  |
| `決済`        | `"false"`   | `"true"`       | `"false"`           | `"true"`                  |

The exact history labels were `最新` and `過去履歴`; this observation does not
establish a four-month retention boundary. With neither kind selected,
`isCloseOrder` was omitted. Collection uses only the four individually selected
combinations and avoids an overlapping unfiltered fifth dataset.

The common request fields beyond the session-only `secureKey` were:

```json
{
  "currencyPairs": [],
  "fromDate": "",
  "toDate": "",
  "isActiveStatus": false,
  "isTodayOrder": "false",
  "isHistory": true,
  "isTargetDate": true,
  "isAuction": "false",
  "sortKey": "executionDatetime",
  "sortAsc": "false",
  "pageNumber": "0",
  "pageSize": "20"
}
```

The collector's bounded implementation retains sanitized page-one evidence in
`executions-leverage-{open|close}-{recent|historical}-page-0001`, each in its own
unit. A numeric-zero envelope remains `partial` with
`leverage_execution_transport_unverified`: an HTTP acknowledgement alone cannot
prove that the HTTP gateway applied filters observed only on Socket.IO. It has
no complete-empty absence claim. A nonempty first page is retained as partial
`leverage_execution_rows_unobserved`; further populated pagination and financial
publication remain unsupported. Missing, string-valued or contradictory empty
pagination is refused. No parser accepts these dataset names, and no leverage
quantity, direction, price, fee or realized result is guessed from spot rows.

A transport, session, redirect or unknown failure stops subsequent leverage
requests. A refusal already recorded by earlier capture stages also skips all
four views. Skipped units remain partial with zero artifacts. Local envelope or
unobserved-row failures do not suppress an independent sibling view. These new
failures cannot revoke the completed classic account unit or valid document
units. No extra publishing policy or parser registration is added.

The source `execution` capability remains partial for
[#1228](https://github.com/risu729/kogane/issues/1228). HTTP compatibility for these
parameter combinations, populated leverage rows and fees, complete retained
pagination, and a deployed scheduled run with per-kind count reconciliation
remain unverified. This change performs no hosted experiment or production run.

# V Point / V Point Pay source research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26 (public information, logged-out public endpoints, public JavaScript, public third-party implementations)

Live follow-up: on 2026-08-31, logged into Vポイント (V Points) My Page with the user's account in Kogane Capture Chrome and validated `balance_info`, `tpoint_history`, and `smfg_point` read-only. No values, merchants, member numbers, Cookies, or personal information were saved to the repository. The PoC is in `services/collector-vpoint/`. That day's VポイントPay (V Point Pay) app static analysis and independent Worker design are separate in `docs/sources/v-point-pay.md` and `services/collector-vpoint-pay/`.

## 1. Scope and safety boundaries

This record covers personal V Point and V Point Pay, comparing official routes through V Point sites/apps, V Point Pay app, Vpass, and 三井住友銀行 (SMBC) app/SMBC ダイレクト (SMBC Direct)/Olive. V Points and V Point Pay balances are separate assets; 三井住友カード (Sumitomo Mitsui Card) billing statements and bank deposits are separate ledgers too. V Money, former T マネー (T Money), PayPay ポイント (PayPay Points), ANA マイレージ移行可能ポイント (points transferable to ANA Mileage), and partner-specific points are excluded despite similar names/navigation.

Permitted activities are read-only display of existing balances, regular/fixed-expiry/store-limited points, expirations, existing accrual/use/expiry/exchange history, and existing V Point Pay use/refund/top-up history; static analysis, deobfuscation, runtime tracing, and communication metadata observation on user-controlled devices. No writes such as payments, top-ups, exchanges, transfers, ID linking/unlinking, passkey registration, authentication/notification settings, or member-information changes.

Do not retain `V会員番号` (V member number), Yahoo! JAPAN IDs, Vpass IDs, SMBC IDs, phones, names, birth dates, card/account numbers, Cookies, OTPs, app passcodes, sessions/tokens, passkey private keys, actual balances/history/merchant names in acquired artifacts, HARs, screenshots, logs, or commits. Do not bypass WAF/CAPTCHA, rate limits, certificate pinning, device integrity/attestation, or other security controls.

## 2. Research method and evidence strength

- Primary evidence came from official V Point, Sumitomo Mitsui Card, SMBC, and Google Play pages. Aggregators were used for neither discovery nor evidence.
- On 2026-08-26, observed public URL statuses/headers/redirects and publicly served V Point My Page JavaScript bundles at low frequency while logged out. No authentication, credential entry, challenge triggering, private-API replay, or load testing.
- Checked public GitHub implementations at pinned commits. Also locally referenced a user-controlled private Vpass 5.12.0 static-analysis snapshot for transport/auth/schema type/field names. This is not a public third-party client or evidence for public URLs. Its provenance/signature claims are distinct from fresh APK acquisition/verification in this research.
- V Point Pay APK candidates were separately acquired/analyzed on 2026-08-31. Binaries, normal/decrypted DEX, and decompiler output went to a private archive, with evidence boundaries separate from this V Point Web validation. See `docs/sources/v-point-pay.md`.
- Below, explicitly separate **confirmed facts**, resulting **inferences/design decisions**, and **unconfirmed items**.

## 3. Authoritative ledgers and route tradeoffs

| Asset/record                                                                  | Candidate authority | Read surface            | Strength                                                                                | Main gaps/risks                                                                                   |
| ----------------------------------------------------------------------------- | ------------------- | ----------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Integrated V Point balance, regular/fixed-expiry/store-limited points/history | V Point site/app    | My Page, V Point app    | Expiry buckets/integrated history together; concrete internal APIs/schemas in public JS | Official CSV/PDF unconfirmed publicly; phone/passkey/Cloudflare sessions involved                 |
| Sumitomo Mitsui Card-origin points                                            | Vpass               | Vpass Web/app           | Card accrual, Olive credit mode, pre-integration/unlinked coverage                      | Unlinked history limited to 1 year/100 rows; full-history endpoint unconfirmed in static snapshot |
| SMBC/Olive bank/debit-origin points                                           | SMBC app/Direct     | V POINT/services screen | Bank/debit/bank-program origins                                                         | Nearby out-of-scope bank balances/PII; Vpass candidate authority for credit accrual               |
| V Point Pay balance/use/refunds/top-ups                                       | V Point Pay app     | App home, usage details | Current Pay balance and authorization/settlement/refund display                         | Adjacent payment/top-up writes; retention/counts/export/internal transport unconfirmed            |

Do not add the V Point ledger and V Point Pay prepaid balances despite the same V Points display. Moving points to Pay creates two ledger events, decreasing points and increasing Pay, rather than duplicate display of one asset or consumption. Public specifications did not establish stable linking IDs; do not automatically join by amount/time alone.

Recommended sources of record:

1. V Point site/app for integrated spendable V Points, regular/fixed-expiry/store-limited expiry buckets, and integrated history.
2. Vpass for Sumitomo Mitsui Card/Olive credit-mode accrual provenance and old/unlinked history.
3. SMBC for SMBC bank/Olive debit/points-payment-mode provenance; no bank-account values collected.
4. Separate V Point Pay app ledger for Pay balance, use, settlement, refunds, and top-ups.

## 4. V Point balances, types, expiry, and history

### 4.1 Regular, fixed-expiry, and store-limited points

Confirmed facts from [V Point terms of service](https://privacy.vpoint.co.jp/terms/point/):

- Regular points expire one year after the last point activity, including regular accrual/use/exchange and use of non-store-limited fixed-expiry points.
- Fixed-expiry points have individual expirations, not extended by their accrual/use.
- Store-limited accrual/use does not extend regular-point expiry.
- V Point sites display held-point breakdowns/expirations.

The [fixed-expiry points FAQ](https://ssl.help.tsite.jp/faq/show/62773?site_domain=qa-tsite) describes `ストア限定` (store-limited) and points usable anywhere with fixed expiry. Usage order is generally store-limited, anywhere fixed-expiry, then regular, with earliest-expiring first within each type. The [store-limited points FAQ](https://ssl.help.tsite.jp/faq/show/43147?site_domain=qa-tsite) says use locations/expiry are restricted and shown in history.

Minimum stored granularity is `asset=v_point`, `point_type`, available quantity, expiry date, store/alliance restrictions, and `observed_at`. Snapshot all available expiry buckets, not just the earliest; do not mistake dynamic regular-point expiry for permanent-lot expiry.

### 4.2 History granularity, periods, counts, and export

Confirmed facts from [My Page guide](https://ssl.help.tsite.jp/faq/show/35501?site_domain=qa-tsite) and [checking-method FAQ](https://ssl.help.tsite.jp/faq/show/42305?site_domain=qa-tsite):

- My Page shows total points, regular/fixed-expiry breakdowns, store-limited balances/expirations.
- V Point history displays **up to the past 3 years**, with use-date/reflection-date sorting, period/type filtering, and row details.
- Accrual graphs cover up to 12 months monthly or 5 years annually. They exclude store-limited points and negative returns/cancellations, etc., so do not replace complete ledgers.
- Sites/apps show balances/history; phone inquiries show only balances without store-limited points.

History fields confirmed from public JavaScript and live response schemas on 2026-08-31 are `date_reflect`, `date_use`, `point_div`, `store_company`, `store_category`, `store_name`, `point_type`, `point`, `is_use_mbo`, `store_alliance_name`, and `reason`. `point_div` distinguishes accrual/use/expiry/correction/cancellation, etc.; `point_type` distinguishes regular/store-limited/anywhere-fixed-expiry points. Public-bundle display mappings are limited to the 2026-10-09 record below; activity classification under the terms remains unconfirmed.

Official public material did not establish CSV/PDF downloads, per-page/total count limits, APIs, or stable IDs for missing/cancelled rows. Treat this as **unconfirmed in public material**, not impossible export. For retention beyond 3 years, first validate monthly/quarterly read-only capture, matching `results.total` to retrieved row counts.

### 4.3 Vpass, ID linking, and SMBC/Olive

Confirmed facts from [Vpass points-history FAQ](https://qa.smbc-card.com/mem/detail?category=61&id=1939&site=4H4A00IO):

- With linked `V会員番号`/Sumitomo Mitsui Card IDs, Vpass/app navigates to integrated V Point history. History on or before 2024-04-21 is separate.
- Unlinked Vpass history covers **the past 1 year, maximum 100 rows**; excess rows cannot be checked.
- Ordinary card-use points are generally calculated from monthly total usage, preventing mechanical one-card-transaction/one-accrual-row matching.
- Exchanges to PayPay Points, ANA-mileage-transferable points, and partner-specific points may be absent from the main V Point display.

The [exchange-history FAQ](https://qa.smbc-card.com/mem/detail?category=16&id=272&site=4H4A00IO) also splits linked V Point versus unlinked 1-year/100-row Vpass history. The [2024 integration guide](https://www.smbc-card.com/mem/cardinfo/23/cardinfo4010742.jsp) says ID linking combines former T Points and SMBC Group points, allowing combined Vpass display. [Linking instructions](https://www.smbc-card.com/mem/for_info/vpo_idrenkei.jsp) cover V Point Pay/Vpass Web/app, but linking/unlinking are writes and not tested live.

The [SMBC history FAQ](https://qa.smbc.co.jp/faq/show/8824?site_domain=default) routes from SMBC app/Direct `V POINT`/services to history, but directs Olive credit-mode/card accrual checks to Vpass. Scheduled accruals are not displayed. [Olive accrual-timing FAQ](https://qa.smbc.co.jp/faq/show/7616?site_domain=default) and [Vpass display FAQ](https://qa.smbc-card.com/mem/nyukai/detail?category=215&id=2374&site=4H4A00IO) suggest credit/debit/points-payment modes, branches/cards, and benefit names as attribution candidates.

Design decision: Vpass/SMBC displays supplement accrual provenance/legacy gaps rather than replace full V Point history. Bank deposit balances, account numbers, and deposit/withdrawal statements remain excluded when reading SMBC screens.

## 5. V Point Pay

### 5.1 Balance, use, authorization/settlement, and refunds

[V Point Pay balance explanation](https://qa.smbc-card.com/mem/nyukai/detail?category=189&id=1774&site=4H4A00IO) describes prepaid shopping balances topped up from points, etc. The [usage-details FAQ](https://qa.smbc-card.com/mem/nyukai/detail?category=193&id=1810&site=4H4A00IO) routes from app home to usage details.

Confirmed status facts:

- The [usage-amount changes FAQ](https://qa.smbc-card.com/mem/detail?category=189&id=1806&site=4H4A00IO) says merchant authorization first reduces balance; later merchant sales amounts may update statement/balance to finalized amounts. Do not assume first display is posted.
- The [refund FAQ](https://qa.smbc-card.com/mem/detail?category=193&id=1805&site=4H4A00IO) says refunds normally appear as positive amounts in usage details about 1–4 weeks after merchant information arrives.
- The [expiry FAQ](https://qa.smbc-card.com/mem/detail?category=189&id=1800&site=4H4A00IO) specifies 5 years from registration, renewed to 5 years from qualifying use/top-up within the specified period. Conditions may differ from older guidance; recheck current FAQ/app display when implementing.
- The [top-up reflection FAQ](https://qa.smbc-card.com/mem/nyukai/detail?category=189&id=1799&site=4H4A00IO) distinguishes reflection times for points/gifts versus card/bank top-ups requiring identity verification.

At minimum distinguish `authorization_observed`, `settled`, `refund`, and `charge`. Snapshot authorizations without destructive later overwrites. Public material did not establish authorization/settlement IDs, original/refund linking IDs, or complete merchant/currency fields. Do not join by matching amounts/dates alone before live schema validation.

### 5.2 Periods, counts, and export

Official public material did not establish retention, CSV/PDF/file export, or stable row IDs for Pay usage details. Later APK analysis found monthly JSON via `target_month=yyyyMM`, using balance-response `inquiry_period` as the earliest month. Do not assume fixed retention; leave earliest actual-account month, whether authorization updates settled rows or creates separate rows, and original/refund linkage for live validation.

[Points top-up instructions](https://qa.smbc-card.com/mem/vptapp/detail?category=189&id=1778) are official information, but execution decreases points/increases Pay balances and is a write. Do not navigate to top-up screens in read-only validation; read only rows in existing history.

## 6. Authentication, MFA, passkeys, and Bitwarden

### 6.1 V Point site/app

- The [login FAQ](https://ssl.help.tsite.jp/faq/show/69477?site_domain=qa-tsite) describes smartphone login using `V会員番号` without Yahoo! JAPAN ID, as well as Yahoo! JAPAN ID routes.
- [Official app instructions](https://web.tsite.jp/pt/howto_app/?mode=PC) describe registration with `V会員番号` or Yahoo! JAPAN ID followed by identity verification through an outgoing phone call.
- The [passkey FAQ](https://ssl.help.tsite.jp/faq/show/73314?site_domain=qa-tsite) says V Point site/app supports passkeys as of 2026-05-18. Registration requires login/phone verification; currently iOS-only, without Android/PC support. This officially confirms WebAuthn/FIDO-family passkeys.

Hand off for phone verification, additional Yahoo! JAPAN authentication, or passkey registration/deletion. Existing-passkey login may be a read entrypoint; new registration is a settings write and not performed.

### 6.2 V Point Pay

- The [app passcode FAQ](https://qa.smbc-card.com/mem/nyukai/detail?category=194&id=2874&site=4H4A00IO) uses six-digit passcodes for card-information display/procedures.
- The [SMS authentication FAQ](https://qa.smbc-card.com/mem/nyukai/detail?category=196&id=1770&site=4H4A00IO) describes SMS authentication codes.
- The [reauthentication FAQ](https://qa.smbc-card.com/mem/vptapp/detail?category=189&id=1808&site=4H4A00IO) describes post-inactivity reauthentication using phone number, kana name, birth date, SMS code, and a new six-digit passcode.
- The [biometric authentication FAQ](https://qa.smbc-card.com/mem/info/detail?id=1776&search=true) describes Face ID/Touch ID as app-passcode replacement/unlocking, not evidence of V Point Pay WebAuthn passkeys.

V Point Pay passkeys were not confirmed. Do not equate app biometric unlock, SMS, and V Point iOS passkeys.

### 6.3 Vpass / SMBC

The [Vpass Web FAQ](https://qa.smbc-card.com/mem/detail?category=216&id=2283&site=4H4A00IO) says Web accepts only Vpass ID/password, while SMBC ID is app-only. The [Vpass app login FAQ](https://qa.smbc-card.com/mem/detail?category=177&id=1335&site=4H4A00IO) describes Vpass ID or SMBC ID/password with optional biometric/automatic login. The [biometric authentication FAQ](https://qa.smbc-card.com/fs/collection/detail?id=991) describes app biometrics, not WebAuthn passkeys. Device authentication such as SMBC Safety Pass in the SMBC app is bank-route-specific, not shared V Point passkeys. 3D Secure SMS/email OTP is payment authentication, distinct from balance-inquiry login MFA.

### 6.4 Bitwarden: confirmation and inference

Bitwarden generally provides [browser autofill](https://bitwarden.com/help/auto-fill-browser/), [Android autofill](https://bitwarden.com/help/auto-fill-android/), and [passkey storage](https://bitwarden.com/help/storing-passkeys/). It may therefore generally serve Vpass Web ID/password autofill or passkeys on supported OS/browser combinations.

However, no official V Point statement of Bitwarden compatibility was confirmed. Given currently iOS-only V Point passkeys and non-passkey biometric unlock in Pay/Vpass/SMBC apps, **do not infer Bitwarden can make every route unattended**. Do not combine IDs, phones, names/birth dates, app passcodes, and OTPs in one vault item/runtime.

Unconfirmed: each session's lifetime/refresh, device/IP binding, phone/SMS challenge frequency, Yahoo! JAPAN MFA conditions, V Point passkey compatibility with Bitwarden's iOS provider, and Pay/Vpass app device keys.

## 7. CDN, WAF, and anti-bot

Low-frequency logged-out observations on 2026-08-26:

| Public entrypoint                                       | Result                                                                   | What can/cannot be concluded                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `https://vpoint.net/`                                   | `302` to `https://tsite.jp/`, `Server: nginx`                            | Old/guidance-entry redirect; does not establish auth-origin defenses       |
| `https://web.tsite.jp/`                                 | `200`, CloudFront `X-Cache`/`Via`/`X-Amz-Cf-*`                           | CloudFront on public content                                               |
| `https://mypage.tsite.jp/tpoint/?hid=1`                 | `200`, `Server: cloudflare`, `CF-Cache-Status: DYNAMIC`, Sydney `CF-Ray` | Auth My Page SPA front door is Cloudflare; WAF/bot products/scores unknown |
| `https://www.smbc-card.com/mem/index.jsp`               | `403`, `Server: AkamaiGHost`                                             | Akamai on public Vpass entry; reason for anonymous curl 403 unknown        |
| `https://www.smbc-card.com/mem/for_vpointapp/index.jsp` | `403`, `Server: AkamaiGHost`                                             | Akamai on card-side V Point app entry too; authenticated behavior unknown  |
| `https://qa.smbc-card.com/`                             | `200`, `Server: Apache`                                                  | FAQ accessible; may differ from Vpass/app API protection                   |
| `https://direct.smbc.co.jp/aib/aibgsjsw5001.jsp`        | `200`, `X-Akamai-Transformed`                                            | Akamai confirmed at public SMBC Direct entry                               |

These CDN/front-door headers do not establish WAF settings, bot decisions, app-API defenses, authenticated challenges, or Cloudflare/Akamai protection across all surfaces. Cloudflare-fronted My Page does not imply guaranteed access or special ease from Cloudflare Workers because they share a provider.

Stop for 401/403/429, CAPTCHA/challenges/interstitials, authentication loops, or unexpected reauthentication. No cookie/header synthesis to bypass defenses, browser-fingerprint spoofing, CAPTCHA solvers, rate-limit probing, or pinning/integrity bypasses.

## 8. Official Web/apps/APKs and first-party transport

### 8.1 Official app and Web roles

| Official app                                                                      | Google Play package    | Play metadata version on 2026-08-26 | Main read role                                                                 |
| --------------------------------------------------------------------------------- | ---------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| [V Point](https://play.google.com/store/apps/details?id=jp.co.ccc.Tsite)          | `jp.co.ccc.Tsite`      | `3.7.3`                             | Integrated balances/types/expiry/history; adjacent accrual/use/exchange writes |
| [V Point Pay](https://play.google.com/store/apps/details?id=com.smbc_card.vpoint) | `com.smbc_card.vpoint` | `2.5.0`                             | Pay balance/use/settlement/refunds/top-ups; payments/top-ups coexist centrally |
| [Vpass](https://play.google.com/store/apps/details?id=com.smbc_card.vpass)        | `com.smbc_card.vpass`  | `5.12.0`                            | Card-origin points/linking state, Olive credit provenance                      |
| [SMBC](https://play.google.com/store/apps/details?id=jp.co.smbc.direct)           | `jp.co.smbc.direct`    | `12.7.0`                            | SMBC/Olive bank/debit provenance; nearby excluded deposits/data                |

Web suits observing V Point history pagination/schemas and Vpass legacy routes. Apps suit device-bound auth, current Pay ledgers, and first-party API identification, but are close to writes. Do not start with app UI automation; proceed through V Point Web, existing Vpass sessions, then Pay/SMBC devices.

Versions change. Record package, versionCode/versionName, acquisition time, SHA-256, and signer-certificate digest per artifact. Official standalone APK distribution was not confirmed.

### 8.2 Public V Point My Page JavaScript

Static analysis of anonymously accessible [V Point My Page SPA](https://mypage.tsite.jp/tpoint/?hid=1) Nuxt chunk `/_nuxt/64c5c08.js` as of 2026-08-26 confirmed this same-origin first-party transport.

| Method/path                | Client request/response schema                                                                                                            | Interpretation                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `POST /api/balance_info`   | `status`; `results.common[] {point, expiration, point_type}`; `results.store[] {alliance_name, items[] {point, expiration}}`; `get_month` | Regular/fixed-expiry/store-limited balances/expiry buckets    |
| `POST /api/tpoint_history` | Multipart: `page`, `get_graph`, `sort`, filters, `filter_date`; response `results.total/history/graph`                                    | History pagination/graphs; internal `tpoint` is legacy naming |
| `POST /api/smfg_point`     | `results.get_point.point_smbc`, `point_smcc`                                                                                              | Candidate separate SMBC bank/card points display              |
| `POST /api/tmoney_history` | V Money history                                                                                                                           | **Excluded: not V Point Pay**                                 |

`tpoint_history` filters include accrual, use, cancellation, expiry, transfer, correction, expiry extension, reissuance, others, and use/reflection-date sorting. Clients compare `results.total` with collected rows to paginate. This strongly establishes concrete read APIs/schemas, but they are session/cookie-protected internal APIs, not public APIs. On 2026-08-31, same-origin read-only requests were validated live through a user-controlled browser's normal login session. Renewable sessions, CSRF, rate limits, schema stability, and terms permission for automated retrieval remain unconfirmed.

### 8.3 Next legitimate split-APK experiment

This research did not newly acquire V Point/V Point Pay/SMBC APKs. After legitimate Google Play installation on user-controlled Android, perform the following per package. Keep binary/decompiled/decrypted artifacts out of Kogane's public repository; save them with provenance in the existing private Android archive repository.

```bash
PKG=jp.co.ccc.Tsite  # Change to com.smbc_card.vpoint / com.smbc_card.vpass / jp.co.smbc.direct
adb shell dumpsys package "$PKG" | grep -E 'version(Name|Code)|firstInstallTime|lastUpdateTime'
adb shell pm path "$PKG"
# Use adb pull for base.apk and every split_config*.apk obtained above, one by one
sha256sum artifact/*.apk
apksigner verify --verbose --print-certs artifact/*.apk
jadx -d jadx-out artifact/*.apk
apktool d -f artifact/base.apk -o apktool-out
rg -a -n 'https?://|wss://|retrofit|okhttp|graphql|grpc|protobuf|oauth|bearer|cookie|session|pin|certificate|integrity|attestation|safetynet' jadx-out apktool-out
```

- Verify matching signer digests across all splits and include package/version/signer/hash in public provenance records too. Commit APK/decompiled code only to the private archive.
- Inventory manifest, network security config, hosts/paths, Retrofit/OkHttp/gRPC/GraphQL/protobuf schemas, session/token renewal calls, and Play Integrity/attestation/pinning-library candidates.
- R8/ProGuard/string-encryption deobfuscation and read-method runtime tracing can be in scope. Never log tokens/cookies/keys/PII/actual values or hook changes to pinning/integrity decisions.
- MobSF is local static scanning only; no third-party cloud upload, automatic dynamic actions, or binary redistribution.

## 9. Concrete transport/auth in static-analysis artifacts and public third-party implementations

### 9.1 User-controlled Vpass 5.12.0 static-analysis snapshot

Referenced a Vpass `5.12.0` JADX/apktool snapshot in the user's private repository. This is not a public third-party client; do not put repository/commit/code links in public documents. Limit use to transport/schema fact checking, without redistributing/reproducing APK/decompiled code. Snapshot metadata claiming Google Play provenance/apksigner verification does not establish fresh signer verification here. Reproduction requires legitimate installation from the [official Google Play listing](https://play.google.com/store/apps/details?id=com.smbc_card.vpass) on a user-controlled device and independent signer/hash checks through section 8.3.

Concrete implementation findings:

- `AppService.java` and `FaVpointAPI.java` implement `POST https://spap.smbc-card.com/api/v3/fa/Vpoint` through Retrofit/OkHttp/Gson, with an empty `AppRequest` body.
- `AppClient.java` and `BaseClient.java` show conditional `Authorization`, `X-App-Version`, `X-OS-Version`, app User-Agent, JSON content type/cache-control, `X-VappSessionTime`, cookie jars/interceptors.
- `FaVpoint.java` and `FaVpointPoint.java` responses have `cardIdentifyKey`, `pointAccountNumber`, `pointIntegration`, and `points[] {pointAmount, expirationPoint, pointExpirationDate}`. Only field names were checked, no values retrieved/recorded. Realm local caching also exists.
- Protected-DEX analysis in the snapshot describes an auth flow combining app-layer encrypted envelopes of Vpass ID/password, persistent device UUID, push token, company/timestamp, etc. with login tokens/cookies/session-time. RSA OAEP/AES-CBC candidates were identified for 5.12.0, but no secrets were retrieved/decrypted/replayed.

`Fa/Vpoint` is a concrete read endpoint returning Vpass balances/expiry buckets/linking state. The same `AppService` did not reveal full V Point history; the app may navigate to Web/V Point. Static crypto procedures alone do not create a renewable client meeting current device-header/cookie/Akamai/session conditions. This supports C candidacy, not B.

### 9.2 Public old Vpass scraper

[hdemon/vpass-scraper](https://github.com/hdemon/vpass-scraper/blob/902e5322e6f94f847742bd70c11d661857a090a4/get_current_state.py) (2017, license display unconfirmed) is an old Selenium/Chrome DOM implementation entering Vpass ID/password at `https://www.smbc-card.com/mem/index.jsp`, then using card expiry/CVV to display the card number on another screen. It is not a V Point balance/history client, requires sensitive card data, and lacks MFA/Akamai/current DOM support. Do not adopt it. GitHub searches found no current personal V Point Pay read client or official public API/SDK, but do not prove absence.

## 10. Read-only dynamic observation

### 10.1 Live results on 2026-08-31

Using the user's normal Kogane Capture Chrome login session, observed only statuses, schemas, and counts without outputting values. Web-screen `V会員番号` remained masked; API requests had no member-number field and succeeded through the session alone.

| Endpoint                   | HTTP/application status | Live-confirmed scope                                                                   |
| -------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `POST /api/balance_info`   | `200` / `0000`          | `results.get_month/common/store/tmoney`; `common[]` `point/expiration/point_type`      |
| `POST /api/tpoint_history` | `200` / `0000`          | `total=149`; pages 1–4 each 30 rows, page 5 29, page 6 0; full traversal/end confirmed |
| `POST /api/smfg_point`     | `200` / `0000`          | `point_smbc`, `point_smcc`                                                             |
| `POST /api/rank_info`      | `200` / `0000`          | Transport only; excluded from collector                                                |

History requests are multipart with `page`, `get_graph=1`, `sort=use`, accrual/use/cancellation/expiry/transfer/correction/expiry-extension/reissuance filters, and `filter_date=""`. The PoC stops at `results.total` and does not request empty terminal pages in normal runs. Anonymous sessions return application status `0010` even with HTTP 200, so HTTP status alone cannot determine login success.

This run left no My Page traffic in Kuebiko's own request artifacts; confirmation came through CDP from concurrently attached Chrome controls. Competing debugger attachments are a candidate cause, not confirmed. Missing Kuebiko records do not prove no communication. Cookies, member numbers, actual balances/history values/merchants/PII were saved to neither repository nor tool output.

### 10.2 Next dynamic observations

1. **V Point Web**: normal user-controlled-browser login; open only balances/all expiry buckets and one history page. Allowlist DevTools origin/method/path template/status/content-type/field names/pagination metadata. Compare `/api/balance_info` and `/api/tpoint_history` request/response shapes; immediately discard values.
2. **Vpass/SMBC**: only with existing login state, open point screens to check linked/unlinked routes, old history, 100-row/1-year boundaries, Olive-mode attribution. No ID linking, bank-account screens, or auth settings.
3. **V Point Pay**: only home balances/existing usage details; observe earliest dates, pages/counts, authorization/settlement/refund/top-up fields/state transitions. No code display, payments, top-ups, exchanges.
4. **Sanitization**: remove Cookies/Authorization/CSRF/OTPs, query/body values, IDs, phones/names/birth dates, actual amounts/merchants before or immediately after capture. Do not save HARs by default; create synthetic field-name-only schemas. Do not share before secret-scanner/manual review.
5. **App metadata**: only if the app normally accepts user-installed CAs, observe host/method/path/status/content-type through a local proxy saving no bodies/secrets. On rejection/pinning/integrity errors, return to DNS/SNI/IP/timing only without bypassing.
6. **Runtime tracing**: URL builders, serializers/models, read-method calls can be in scope; never log tokens/cookies/crypto keys/OTPs/PII/actual values. No triggering write methods or hooks changing security decisions.
7. **Replay gate**: try one isolated idempotent read only when method/path/schema are clearly read-only and existing sessions can be safely reused. Without separation of login/refresh and read/write scopes, or recurring MFA/phone verification, return to browser/device/manual rather than B.

## 11. Read/write isolation

Minimum allowlist:

- Normal existing-session login/read-only reauthentication (exclude new registration/resets/settings)
- V Point balances, all expiry buckets, history list/detail, filters/sorting/pagination
- Vpass points/expiry/integration state/old history and SMBC/Olive points provenance
- Existing V Point Pay balances/use/settlement/refunds/top-up history
- Download existing CSV/PDF/export files if present in official screens

Denylist:

- V Point/Pay payments, code display, top-ups, exchanges, transfers, sending, withdrawals, points use
- `V会員番号`/Yahoo! JAPAN/Vpass/SMBC ID linking/unlinking, ID/member integration
- Passkey registration/deletion, password/passcode resets, phone/SMS/email/biometric/notification/device settings
- Olive/card/bank payments, transfers, account transfers, balance movements, account/card settings, applications/cancellations
- Campaign/lottery/mission entry, new services requiring terms consent

Use origin + method + path allowlists, denying by default. Do not assume `GET` safe or `POST` a write; V Point read APIs actually use `POST`. Map response fields to UI actions per endpoint; stop before sending unknown paths, redirects, methods, or content-types.

## 12. Workers / Browser Run / Containers / OCI / Kubernetes suitability

- **Cloudflare Workers**: [Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) suits external HTTP API calls, JSON/HTML parsers, schedules, schema normalization. Suitable for read collectors after live proof that humans can safely bootstrap/renew V Point internal sessions and Cloudflare/Akamai accepts them. Unsuitable alone for device-bound apps, phone/SMS/passkeys, Android runtimes.
- **Cloudflare Browser Run**: [official Browser Run description](https://developers.cloudflare.com/changelog/post/2026-04-15-br-rename/) provides full-browser sessions, record/replay, human-in-the-loop. C candidate for V Point Web/D for Vpass Web; remote logins may increase challenges. Keep secrets out of recordings; stop for 401/403/429/CAPTCHA.
- **Cloudflare Containers**: [Containers](https://developers.cloudflare.com/containers/) combines arbitrary runtimes, filesystems, existing OCI images, and CPU/memory-intensive tools with Workers. Better than Workers for isolated Playwright/parser/jadx/apktool jobs, but no immediate solution for Pay's Android devices/emulators, Play distribution, device attestation, persistent secure sessions.
- **OCI/container runtime**: hardened local/CI OCI images are most practical for pinned browser/parser/decompiler versions, read-only filesystems, network allowlists, ephemeral secrets, no retained artifacts. Separate login profiles from analysis images.
- **Kubernetes**: suits many-source scheduling, per-source NetworkPolicies, Secret providers, job isolation, retries/observability, but operationally excessive for one family. Controllers must not retry OTP/CAPTCHA/unknown writes; device farms do not justify security-control bypasses.

## 13. PR #5 common automation levels A–E and cost 1–5

Common definitions:

- **A**: scheduled official/documented read-only APIs or official exports
- **B**: direct stable internal read APIs with renewable/reusable sessions
- **C**: headless HTTP/browser replay after human browser/app login bootstrap
- **D**: ongoing full browser/device UI automation required
- **E**: manual capture/import

| Route                               | Current assessment              |    Cost | Evidence/promotion conditions                                                                                                                                         |
| ----------------------------------- | ------------------------------- | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V Point Web                         | **C candidate**                 | **3-4** | Concrete same-origin read POST/schema/pagination in public JS; B/3 after live proof of renewal/MFA/Cloudflare/terms/schema stability. Official export/API unconfirmed |
| Vpass app point balance             | **C candidate**                 |   **4** | Current 5.12.0 host/path/model/auth envelope concrete, but device/cookie/session/Akamai required; full-history endpoint unconfirmed                                   |
| Vpass/SMBC/Olive Web/app provenance | **D**                           |   **4** | Multiple IDs, device auth, legacy/linked routes, bank-data isolation; C if stable limited-route APIs confirmed                                                        |
| V Point Pay                         | **D**                           |   **5** | Nearly app-only, adjacent writes; retention/schema/transport/session/pinning/integrity unconfirmed                                                                    |
| Entire family                       | **D** (points are C candidates) | **4-5** | Complete separate Point/Pay ledgers still require devices; safe initial route E/1                                                                                     |

Do not choose A currently. Official CSV/PDF/public personal APIs remain unconfirmed; Web/Vpass endpoints are internal. First establish schemas/double-counting prevention with E/1 sanitized samples, then introduce only V Point Web as limited C. Do not force Pay into B/C simultaneously.

## 14. Live-validation checklist and stop conditions

Read-only live checks:

- [x] V Point My Page `common`/`store` expiry-bucket schemas and total-balance API
- [x] History `results.total`, per-page count, all-page traversal, row schema
- [ ] History use/reflection-date sorting, filters, details, oldest 3-year boundary
- [ ] CSV/PDF/export presence and, if present, periods, headers, encoding, maximum counts
- [ ] Identify linking state without changing it; Vpass old history, 1-year/100-row boundaries
- [ ] Olive credit/debit/points modes and SMBC bank/card provenance labels; no bank/card values recorded
- [ ] Earliest Pay date, page/count, authorization→settled, refunds, existing top-up displays
- [ ] Public linking IDs between existing Point→Pay ledger events; field names only, no saved values
- [ ] Login/MFA/passkey/biometrics, timeouts, human-handoff points per V Point/Vpass/Pay/SMBC
- [ ] My Page/Vpass/Pay app hosts/methods/paths/content-types/schemas and read/write route separation
- [ ] Disable retries on 401/403/429/CAPTCHA; secret/PII redaction; default-deny unknown endpoints

Immediate stops:

- Confirmation/execution buttons for payments, top-ups, exchanges, transfers, ID linking, auth settings, campaign entry, etc.
- OTP, outgoing phone calls, passkey registration, password/passcode reset, identity verification, terms consent required
- Cookies/tokens/OTPs/IDs/phones/names/birth dates, actual balances/history/merchants could remain in logs/HAR/screenshots
- 401/403/429, CAPTCHA, bot/interstitials, auth loops, pinning/integrity/attestation errors
- Unknown origin/path/method, inseparable write/read scopes/sessions, unexpected requests
- Cannot distinguish asset/source boundaries among V Point, Pay, V Money, card/bank ledgers

## 15. Conclusions, inferences, and unconfirmed items

### Confirmed

- V Points distinguish regular, anywhere fixed-expiry, and store-limited points; My Page history covers up to 3 years. Unlinked Vpass history separately limits 1 year/100 rows.
- Pay is a separate prepaid ledger; authorization can later become settled amounts and refunds may appear positively later. Public retention/export unconfirmed.
- Public My Page JS includes concrete first-party internal POST APIs/schemas for balances/expiry buckets/history pagination.
- Live normal-session validation retrieved balances, SMBC breakdowns, and all 149 history rows across 5 pages without passing member numbers in requests. Anonymous HTTP 200 has application status `0010`; authenticated status is `0000`.
- User-controlled Vpass 5.12.0 static snapshots establish `spap.smbc-card.com/api/v3/fa/Vpoint`, Retrofit/OkHttp/Gson, headers/cookies/session-time, balance/expiry/linking models.
- V Point passkeys are officially confirmed, currently iOS-only. Pay/Vpass/SMBC app biometric unlocking is not passkeys; Bitwarden compatibility unconfirmed.
- Anonymous headers confirm Cloudflare for My Page and Akamai for Vpass/SMBC Direct.

### Inferences/design decisions

- Separate integrated V Point authority into Web/app, card/bank provenance into Vpass/SMBC, and Pay into its own ledger to best prevent double counting.
- Live read-only V Point Web replay supports a C/3 PoC. B requires proof of renewable-session generation/renewal. The family remains D/4-5 because Pay devices are needed.
- Vpass `Fa/Vpoint` is for balances/expiry/linking; full history may be delegated to V Point Web.

### Unconfirmed

- Official CSV/PDF/export per surface, total V Point count limits, Pay retention/pages/counts.
- Stable history/Pay row IDs and linking IDs for original/refund and Point→Pay ledgers.
- Internal V Point sessions/CSRF/refresh/rate limits/terms treatment, current live Vpass responses.
- V Point Pay/SMBC/V Point APK hosts/paths/schemas, pinning/integrity candidates, Pay app APIs/WAF.
- Service-specific Bitwarden/V Point iOS passkey compatibility, Pay/Vpass passkey availability.

## 16. 2026-09-05 Layer A raw-evidence implementation

Historical record: the private outbox bucket, the importer, its
`collector-r2-v-point` credential and Service Binding described in this section were
retired on 2026-09-13 ([legacy retirement](../legacy-retirement.md)). The
collector now writes each run once, into the shared `DATA` bucket
([U09 below](#addendum-switch-to-shared-data-r2-u09)).

The V Point Web collector now collects on a schedule through browserless Workers fetch and Email Worker reauthentication, using private R2 as an immutable outbox. Central ingestion is separated through a `collector-r2-v-point` credential and Service Binding independent of the collector. It validates all manifest v1/v2, prefix inventories, metadata, checksums, JSON schemas, pagination, failure complements, collection summaries, and V Point Pay email reconciliation before idempotently sealing a dedicated central run. Large runs fix a complete inventory and transfer up to 8 artifacts per HMAC-signed continuation, advancing the R2 scan position only after sealing.

Terminal-run `producerVersion` uses the fixed source contract `vpoint-r2-v3`. Excluding Importer deployment revisions from immutable reports means rescanning the same run with different `IMPORTER_VERSION` leaves report bodies unchanged. v3 registers collector transport-decoded/reencoded JSON as `collector_derived/transformed` and central manifests stripped of free-form failure text as `collector_manifest/generated`, matching actual D1 contracts through descriptor hashes including centrally added nullable fields/empty arrays. Deployment revisions remain only for failed/incomplete-attempt diagnostics.

Without modifying actual R2, audited 24 manifests: v1 5, v2 19, successful 13, failed 11, reconciliation references 10, all conforming to strict contracts. `bash scripts/audit-v-point-r2.sh` (removed with the importer on 2026-09-13) reproduced the same aggregate-only audit, outputting no bodies, values, object keys, individual hashes, or secrets. Reconciliation has different exact policy strings in 3 old versus 7 current records; only those two observed values are explicitly accepted, without arbitrary-string relaxation. Candidates bind to existing history pages, indices within actual row counts, and `sha256(JSON.stringify(row))`; duplicates within entries are rejected.

V Money is retrieved through the same session/API but is a separate electronic-money ledger. All audited-account runs currently have empty pages; Layer A's V Point contract permits only empty V Money observations and fails closed on nonempty results. Before attributing nonempty history automatically, design independent source IDs, asset/account boundaries, parsers, and reconciliation policy in a separate PR.

## Addendum: strict Layer B parser and production aggregate canary (2026-09-07)

Layer B converts only merged Layer A's strictly validated `balance-info`, `smfg-point`, and `history-page-*` into financial observations. `collection-summary` and history graphs support completeness checks; empty `vmoney-history-page-*` produces no observations across its separate asset boundary. Do not guess numeric enum names for `point_type`, `point_div`, or `get_month`; preserve original fields/values in `extra`. History amounts/signs use `point` unchanged.

History rows have no observed stable provider IDs; invent neither `externalId` nor cross-row reconciliation identities. Preserve every occurrence with raw locators without deduplication; current queries choose only the latest complete run as one snapshot. This avoids double counting daily full-history retrieval and leaves no disappeared rows/expiry buckets in current state.

A local/read-only aggregate canary on production R2 scanned 167 objects: 26 valid manifests under current strict contracts, 139 non-manifest skips, and 2 manifests reduced to fixed validation-failure categories. Valid manifests: success 15, failed 11, partial 0. All 111 financial artifacts across 15 successful runs parsed into 45 balances and 2,262 transactions. Failed runs yielded 0 observations; aggregate checks confirmed no invented external IDs on transactions. No object keys, hashes, bodies, provider text, individual financial values, credentials, or session values were output/saved. The audit performs no R2 writes/deletes or Worker deployments.

## Addendum: switch to shared DATA R2 (U09)

`services/collector-vpoint` does not read `COLLECTION_TARGET`; its only destination is binding `DATA` (`kogane-raw-evidence`). Switching/importer retired on 2026-09-13 (`docs/collection.md`). The same sanitized bytes are content-addressed in `objects/<2hex>/<sha256>`; `runs/v-point/<runId>/terminal.json` is written last. Worker name, Email route, `VPointSession` Durable Object, and secrets are unchanged.
The only R2 binding is `DATA`. Since
[#430](https://github.com/risu729/kogane/pull/430) (2026-10-05) the Worker has
no Cron trigger: the Processor's alarm job `vpoint` (06:15 JST, `15 21 * * *` in
`config/alarm-jobs.json`) calls its private `ScheduledCollection` entrypoint.

V Point Pay notifications received by Email routes save `notification.eml` (role `user_capture`) and `normalized-event.json` (role `collector_derived`) as independent `v-point-pay-email` runs. Run identity is the message SHA-256, so redelivery resends the same digest. When the same email triggers V Point post-auth collection, both runs share `acquisitionSessionRef` (`email-<message sha256>`) without mixing sources.

No V Point Pay email reconciliation report is created: its old-bucket-prefix aggregation omits notifications. Cross-source reconciliation belongs to the terminal-reading Processor (U08). Processor `SHARED_R2_INGEST_ENABLED` gates registration, not collector destinations. Existing terminals remain valid; see `docs/collection.md`.

## 2026-10-09: public UI enum labels and expiry-calculation boundaries

Anonymously available [My Page HTML](https://mypage.tsite.jp/tpoint/?hid=1) directly references a [first-party asset](https://mypage.tsite.jp/_nuxt/6e0bc81.js) script. Acquisition UTC was `2026-10-09T09:44:51.0733363+00:00`; raw HTTP body SHA256: HTML `9fbdadf2616f5206d2e3f878f341569167414aa00f795c81df91f467fa3ad59b`, asset `78df56dd541250c8a0b5aa190e2323686c02834bf8b4a6b5e78e9320afcd0692`. Public modules directly map numbers as array indices to display labels.

| Field      | Value            | Public-module display label                                                                         |
| ---------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| point_div  | 1, 2, 3, 4, 5, 6 | `貯める` (earn), `使う` (use), `失効` (expire), `修正` (correct), `取消` (cancel), `その他` (other) |
| point_type | 1, 2             | `ｽﾄｱ限定` (store-limited), `期間限定` (limited-period)                                              |
| point_type | 0                | Empty; does not establish regular points                                                            |

This proves the served module's lookup, not execution in authenticated UI or a stable server enum contract. No login, auth headers, private APIs, or account values were acquired. This record enables no runtime expiry-activity mapping. `date_use` and `date_reflect` are separate sort/group inputs; [FAQ35501](https://ssl.help.tsite.jp/faq/show/35501?site_domain=qa-tsite) also describes sorting by use/reflection date but does not establish which field maps to Article 3's last activity date. Regular points also display expiration, so expiration presence does not establish bucket kind.

Article 3 differs between [2026-04-01 terms](https://privacy.vpoint.co.jp/terms/point/) and [2024-04-22 official PDF](https://privacy.cccmkhd.co.jp/wp-content/uploads/2024/04/point_20240422.pdf). Current terms explicitly renew expiry for regular accrual/use/exchange and non-store-limited fixed-expiry usage. Intermediate versions/transitions for existing expiry, activity withdrawal after cancellation/correction, base dates/leap days/boundary times remain unresolved. Keep old v1 seeds unchanged as history; this unknown-kind gate does not enable actual expiry calculation using them.

### Minimum remaining observations (proposed only, not performed)

1. Match common type displays with same-row enums in existing authorized stored material/normal authenticated UI. Record field/value→label evidence refs/acquisition digests without copying raw member numbers/balances/bodies to the repo. Empty type 0 alone does not establish regular points.
2. Match rows with differing use/reflection dates and seek first-party explanation of which is the terms' last activity date. Without explanation, prepare wording for the owner to ask support. This PR does not send it, log in again, or refetch APIs.
3. Confirm cancellation/correction relationships to originals and existing-expiry treatment after terms revisions; classify only confirmed subsets. Fix same-run all-pages/total/filter/sort/window-edge evidence in inputs. Do not promote latest-capture eligibility to lifetime-history completeness.

### Minimum observed facts missing for actual calculation in #554

Before creating new acquisition/input contracts, tie these four facts to evidence for the same member holding and acquisition run.

1. **Activity/type**: confirm original `point_div`/`point_type` fields, values, labels and whether rows represent regular earn/use/exchange, store-limited points, or limited-period usage. Public-bundle labels alone do not establish `point_type=0`, exchanges, correction/cancellation targets/relationships, or qualifying activity under the terms. Do not exclude unconfirmed enums as inactivity.
2. **Basis date**: reconcile the same activity's `date_use`/`date_reflect` values with displays; tie the field for Article 3's `変動` (activity) date, time zone/day boundaries, and post-cancellation/correction base dates to provider explanations/confirmed examples. Display order/latest rows alone do not establish basis dates.
3. **Acquisition window**: confirm same-run filters/sorting/all pages, total versus actual rows, oldest/newest dates, provider-accessible period/gaps. Publishing 3 datasets from existing eligible captures is not lifetime completeness. Empty arrays/maximum 3-year displays alone do not establish no qualifying activity.
4. **Applicable terms**: confirm versions effective between candidate base dates/evaluation date, change-effective dates, carryover/transitions for old limited-period use/base dates. Differences between 2024 and April 1, 2026 versions are confirmed; holding-specific transition rules remain unconfirmed. Do not apply current rules historically based on open-ended current-seed periods.

Only after confirmed facts/source refs exist should a design connect classification versions, qualifying activities, windows, date bases, and applicable terms to existing fixed inputs. This PR implements no such adapter and does not close #554.

## 2026-11-11: scheduled session refusal and automatic email recovery

The error-only view in [#1301](https://github.com/risu729/kogane/issues/1301)
showed one expired-session balance read on each of November 9 and 10 at
21:15 UTC. It did not show the successful recovery events. A read-only,
unsampled Workers Logs review of 21:14 through 21:20 UTC on both days found:

- A balance read returned application code `0010`, classified as
  `VPointSessionExpiredError` / `authentication_required`, at about 21:15:03.
- The collector invalidated the retained cookie and requested an email login
  challenge. The delivered email completed authentication automatically.
- A separate post-authentication collection persisted a successful terminal at
  2026-11-09 21:15:25.501 UTC and 2026-11-10 21:15:27.015 UTC. In both traces,
  the authentication email's run ID matched the post-auth parent's ID, and the
  post-auth child ID matched the persisted successful collection's ID.

Both observed attempts therefore recovered automatically. The post-auth parent
is the email run, not the original scheduled run. The original scheduled
receipt remains failed with `reauthentication_pending`, and its failed terminal
retains `authentication_required`; these records are immutable history. A
successful separate follow-up does not turn the original receipt into success.
The operations snapshot's later registered successful V Point fetch is also
consistent with recovery. No new login, email delivery or collection was
initiated for this investigation.

The provider rejected the retained cookie at the next daily read. These two
observations do not distinguish a fixed session lifetime from idle expiry,
revocation or another invalidation mechanism. They establish no exact TTL.
V Point Pay is a separate source and this finding says nothing about its app
session or email notifications.

The expected recovery path is already automatic: delete the expired session,
request an email code, complete a fresh pending challenge from the delivered
message, then collect again. The challenge freshness window is two minutes in
our implementation; this is not the provider's session lifetime. A failed
challenge after an expired-session read now retains the explicit scheduled
reason `human_required_session_refresh`, rather than a generic collection
failure. A challenge still awaiting email remains `reauthentication_pending`.
Neither is reported as a successful scheduled collection.

Collection quality interprets an unresolved V Point recovery receipt as
`user_action_required`, making the existing owner session-refresh path visible
while automatic recovery is still pending. This is a recovery option, not proof
that a human must immediately intervene. After a later registered successful
V Point fetch, the current recovery action and waiting state clear; the failed
receipt and acquisition history remain visible. The comparison uses the actual
failed occurrence's finish time, falling back to its start time, never its
nominal scheduled time. Equal, missing or invalid times and later failed or
partial fetches do not establish recovery. Summary, cell and account freshness
share this rule. No unrelated authentication codes or V Point Pay statuses are
reclassified.

If recovery remains unresolved, the owner can request the existing
`kogane.ops.session.refresh` operation for the V Point connection through the
operations UI/API. It follows the same email challenge flow; it does not need
a new public collector admin route, secret rotation or manually supplied cookie.
Check that email handling completes and a new registered collection succeeds;
submitting a refresh request alone is not proof of recovery. A provider refusal,
email-routing failure or authentication-completion error still needs separate
investigation using closed diagnostic codes.

Synthetic tests cover actual expired-read handling, challenge creation, delivered
email completion and a separate persisted successful follow-up while preserving
the failed terminal. SQLite read tests cover unresolved action, later registered
success, older/equal/invalid time boundaries, a newer failure, summary/cell/account
agreement and the bounded schedule read. The literal acceptance condition in
#1301 that a scheduled receipt succeeds after refresh is not established by
these production observations; the verified success was the separate email
follow-up. The issue remains open for that distinction and any required later
scheduled-success observation.

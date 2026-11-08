# Smart EX source research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26 (public information, logged-out public endpoints/JavaScript, public third-party implementations);
no live validation using member information was performed.

## 1. Scope and safety boundaries

The unit of this record is personal **スマートEX (Smart EX)** reservations, use, refunds, purchase history, receipts, and boarding transit-IC assignments. エクスプレス予約 (Express Reservation), EX旅パック (EX Travel Packages), e5489, WESTER, transit-IC issuers, and credit-card issuers' ledgers handled by the same EX app are excluded except when explaining integration boundaries.

Permitted activities are read-only display/retrieval of existing reservations, purchase/change/refund history, receipts/refund statements/refund fees, and boarding-IC assignment status; public JavaScript, legitimate-app static analysis/deobfuscation, read-only runtime tracing, and communication metadata observation.

The following are strictly prohibited.

- New reservations, purchases, changes, passenger reductions, cancellations/refunds, repurchases, or seat/train/route changes
- Adding/assigning/changing/deleting boarding IC cards or editing companion IC lists
- Changes to payment cards, member information, external-ID linking, passwords, OTP delivery methods, easy login, biometrics, or similar settings
- Issuing ticket-pickup codes, campaign/points use, or new registration/consent for external services

Do not retain member IDs, names, birth dates, addresses, phone numbers, emails, payment/transit-IC card numbers, reservation numbers, deposit-reference numbers, Cookies, OTPs, sessions/tokens, passkey private keys, actual reservations, boarding dates, routes, trains, seats, amounts, or receipt addressees in HARs, screenshots, HTML, PDFs, logs, or the repository. Do not bypass security controls such as WAF/CAPTCHA, rate limits, certificate pinning, or device integrity/attestation.

## 2. Research method and strength of evidence

- Primary evidence was the [official Smart EX site](https://smart-ex.jp/), [official FAQ](https://faq.expy.jp/?site_domain=smart-ex), and [official Google Play listing](https://play.google.com/store/apps/details?id=jp.co.jr_central.exreserve). Search aggregators were not used as evidence.
- On 2026-08-26, public URL statuses/headers/redirects and login HTML/JavaScript were observed at low frequency while logged out. No credential entry, login, OTP issuance, private-page/API replay, challenge triggering, or load testing was performed.
- Public GitHub/Gist implementations were pinned to commits/revisions and checked for transport, authentication, DOM selectors, output scope, and security/privacy shortcomings. Published receipt PDFs were not opened.
- No APK/split APK legitimately installed from Google Play was obtained in this environment. Package/version were checked in the official listing; binary transport remains a reproducible next experiment.
- Below, **confirmed facts**, resulting **inferences/design decisions**, and **unconfirmed items** are separated.

## 3. Authoritative records and boundaries

| Record                              | Candidate authoritative record | Main read surface                                                                                                   | Strength                                                                                                         | Boundary/gaps                                                                          |
| ----------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Valid reservations before departure | Smart EX reservation ledger    | Web/EX app `予約確認/変更/払戻` (reservation confirmation/change/refund)                                            | Product, boarding date, route, train, accommodation/seat, passengers, IC assignment, payment-card identification | Change/refund buttons coexist; highest risk. Not a replacement for all past history    |
| Purchases/changes/refunds           | Smart EX usage history         | Web `ご利用履歴・領収書の発行` (usage history/receipt issuance), app `購入履歴・領収書` (purchase history/receipts) | Reconciles reservations, changes, and refunds as separate events; up to 15 months                                | Station refunds after ticket pickup, etc. may be absent. No official CSV/API           |
| Receipts/refund statements/fees     | Smart EX displayed documents   | Web/app receipt display                                                                                             | Invoice-compliant; reconciles purchases and refunds/fees by deposit-reference number                             | Not one net statement. PDF depends on device. Includes addressee/actual values         |
| Actual card charges/refunds         | Card issuer                    | Finalized card statements                                                                                           | Final authority for authorization/settlement and refunds across billing cutoffs                                  | Smart EX boarding date may differ from card usage date                                 |
| Shinkansen boarding rights/gate use | Smart EX carriage/gate records | Reservation details, gate-issued EX usage slip                                                                      | IC assignments and train/seat guidance at boarding                                                               | Independent gate entry/exit history/export in public UI unconfirmed                    |
| IC balances/conventional-line use   | IC issuer                      | Suica/ICOCA and similar apps/history                                                                                | Authority for conventional-line fares/IC balances                                                                | Smart EX charges are not deducted from IC balance. Keep separate from Smart EX history |

Use separate objects for `reservation`, `purchase_event`, `refund_event`, `receipt_document`, `boarding_assignment`, `card_settlement`, and `transit_ic_event`. Deposit-reference numbers are reconciliation candidates within Smart EX, but are treated like secrets/PII and never used as repository keys. Use random local source keys for storage.

## 4. Reservation, usage, and refund history

### 4.1 Reservations before departure

Confirmed facts from the [official reservation-confirmation procedure](https://www.smart-ex.jp/reservation/guide/referral/):

- Open reservation lists/details from Web/EX app `予約確認/変更/払戻`.
- Details show the last four digits and international brand of the payment card.
- Boarding transit-IC assignment status can be checked. A displayed number indicates assignment.

Official screen examples show boarding date, train name, departure/arrival times, route, accommodation/seat, etc. Live validation should check round-trip/connecting journeys as one reservation, companions, non-reserved seating, early-discount products, and changed/ticket-picked-up/gate-entered state fields. However, reservation details have adjacent `変更` (change), `払戻` (refund), and `IC指定` (IC assignment) controls, making this retrieval route more dangerous than usage history.

The reservation list is a source for current/future carriage-contract state, not a settlement-event ledger for the past 15 months. Disappearance alone does not establish boarding, refund, or expiry; reconcile it with usage history/refund statements.

### 4.2 Usage-history granularity and period

The [browser usage-history FAQ](https://faq.expy.jp/faq/show/244?site_domain=smart-ex) and [EX app FAQ](https://faq.expy.jp/faq/show/245?site_domain=smart-ex) state that **up to 15 months** of history can be queried from the day after reservation. On Web, choose a period and `再検索` (search again); in the app, choose a period.

The [receipt display service](https://smart-ex.jp/reservation/reserve_smart/receipt/) says history displays reservations, changes, and refunds for reconciliation with card statements. Do not interpret one history row as one journey; distinguish at least these events.

- Reservation/purchase
- New payment for the changed product
- Refund of the previous product
- Member-initiated refund
- Automatic/specified-amount refunds for departure-time passage, non-use, delays/cancellations, etc.
- Refund/non-use fees

The [card-billing FAQ](https://faq.expy.jp/faq/show/319?site_domain=smart-ex) says the reservation date is generally the purchase-settlement date and completed refund-operation date is the refund date; the card statement's `利用日` (usage date) is not the boarding date. The [refund-on-change FAQ](https://faq.expy.jp/faq/show/276?site_domain=smart-ex) says the changed product is generally charged before the previous product is refunded. Do not remove temporary double display as a duplicate purchase.

The [double-charge FAQ](https://faq.expy.jp/faq/show/389?site_domain=smart-ex) says Smart EX promptly sends purchase/refund data to card issuers, but billing cutoffs/finalization may delay reflection; station refunds after ticket pickup may be absent from Smart EX history. Reconcile Smart EX history as the authority for transport/order events with finalized card statements as the authority for actual settlement.

Public official material did not establish rows per page, total maximum count, pagination tokens, stable row IDs, CSV/JSON/API, or machine-readable IDs linking before/after changes or original transactions/refunds. A public third-party implementation suggests `div.pager` can have `次へ` (next), but is not evidence of count specifications.

### 4.3 Receipts, refund statements, refund fees, and PDF/export

Confirmed facts from the [receipt display service](https://smart-ex.jp/reservation/reserve_smart/receipt/):

- Display is available from 5:30 the day after reservation completion through 23:30 up to 15 months later, not on the reservation day.
- `領収書表示` (receipt display), `払戻明細` (refund statement), and, where fees apply, `払戻手数料` (refund fee) are separate documents. Calculate final net cost by combining documents with the same deposit-reference number.
- Entering an addressee and printing produces an invoice-compliant screen. There is no issuance-count limit within the display period.
- For purchases from 2023-04-08 onward, coverage was expanded to specified-amount refunds for non-use, delays of two hours or more, etc.

The [PDF FAQ](https://faq.expy.jp/faq/show/1298?site_domain=smart-ex) says saving displayed receipts as PDF depends on the device; Web-form applications are mailed on paper with no PDF issuance. Thus, this is an official HTML/print-view route converted to PDF with device printing, not an official PDF-download API. Official public material did not establish CSV, bulk export, or machine-readable receipt schemas.

Collecting only receipts omits refunds/fees. The collector needs document types and separately reconciles counts of `領収書表示`, `払戻明細`, and `払戻手数料`. PDFs may contain boarding dates, routes, amounts, addressees, and deposit-reference numbers. Originals belong in encrypted storage outside the repository; this research's live validation checks only field names without saving documents.

### 4.4 Post-departure, non-use, and automatic refunds

The [refund conditions](https://smart-ex.jp/reservation/guide/cancel/) generally allow member-initiated refunds before gate entry/ticket pickup and departure, but say results are not emailed and should be checked in history from two days after boarding. The [non-use FAQ](https://faq.expy.jp/faq/show/267?site_domain=smart-ex) says automatic refunds minus fees occur from the day after boarding; check history/documents from two days after boarding.

This collector does not execute refunds. Do not decide `unused`/`cancelled` at reservation time; retain provisional status until the official ledger shows an automatic refund event. Special-treatment banners for cancellations/delays also guide operations; read them only.

## 5. Transit IC cards and boarding-history boundaries

The [transit-IC boarding guide](https://www.smart-ex.jp/entraining/iccard/) explicitly says Smart EX charges the registered payment card at reservation, without deducting transit-IC balance. Shinkansen gates use IC to identify boarding rights and issue an `EXご利用票（座席のご案内）` (EX usage slip/seat guide) showing boarding date, route, train, seat, etc. This paper is boarding guidance, not a payment receipt.

The [registration/change guide](https://www.smart-ex.jp/reservation/other/ic_card/) says the ten nationwide interoperable types, モバイルSuica (Mobile Suica)/PASMO/ICOCA, etc. can be assigned. Assignment varies by single/multiple passengers and self/companions. The [IC assignment FAQ](https://faq.expy.jp/faq/show/592?site_domain=smart-ex) shows a 17-digit number on details. Do not retrieve/save it; observe only `specified=true/false` and seat assignment counts.

The [conventional-line connection FAQ](https://faq.expy.jp/faq/show/259?site_domain=smart-ex) says conventional-line segments require separate fares. Even when the same IC passes consecutive gates, do not merge Smart EX Shinkansen charges, conventional-line IC fares, and IC balances into one transaction.

Public material did not confirm independent gate entry/exit times, actual-boarding flags, gate IDs, digital EX usage-slip copies, or boarding-record CSV/API in Smart EX UI. Reservation/purchase history records reservations/payments and is not always gate history proving actual travel. The [privacy page](https://www.smart-ex.jp/privacy/) says the operator handles reservations and boarding records, but does not imply member export.

All IC registration/assignment/removal is an account/booking write and is not performed in read-only validation. For assignment/inquiry restrictions such as 2:00–3:00, return later without automatic retries.

## 6. Authentication, MFA, passkeys, and Bitwarden

### 6.1 Direct Smart EX login

The [official browser procedure](https://smart-ex.jp/reservation/reserve_smart/sp/) specifies a 10-digit member ID and a 4–8-character password. The [2025 official notice](https://www.smart-ex.jp/topics/detail/?id=834) and [OTP FAQ](https://faq.expy.jp/faq/show/1174?site_domain=smart-ex) say that since 2025-09-27, login OTP may be required when access is judged unusual, such as a changed device/browser or multiple environments.

Confirmed facts from the [OTP delivery-method FAQ](https://faq.expy.jp/faq/show/323?site_domain=smart-ex):

- New members from 2022-05-21 onward use phone-number SMS or automated voice guidance.
- Earlier members may retain email settings.
- Delivery-method changes can be irreversible, such as being unable to return to email after switching to phone.

If OTP sending/entry is required, hand off to a human and retain no value in files/logs/clipboard history. Delivery-method, phone/email changes, or account re-registration are writes and are not performed. 3D Secure is card-payment authentication for reservations/changes, distinct from read-only login MFA.

### 6.2 Easy login, EX app biometrics, and passkeys

The [easy-login guide](https://smart-ex.jp/reservation/reserve_smart/access/) describes bookmarking a member/device-specific screen and logging in with only a password. This is neither passkey/WebAuthn nor MFA. The dedicated URL may identify the member; treat it like a secret, excluding it from logs/screenshots/repository. Creating/deleting settings is a write and is not performed.

The [official EX app listing](https://play.google.com/store/apps/details?id=jp.co.jr_central.exreserve) advertises fingerprint/Face ID login. This is local credential unlocking/device authentication and does not demonstrate Smart EX WebAuthn passkey support. No official direct Smart EX passkey-login guidance was confirmed in this research.

### 6.3 WESTER external ID

The [external-ID service](https://smart-ex.jp/reservation/other/id_link/) says a previously linked WESTER ID can log in to Smart EX Web/EX app; linking involves a WESTER password, OTP, and information-sharing consent. An already-linked WESTER login is a candidate read entrypoint; new linking/unlinking/consent are writes and are not performed.

JR西日本 (JR West)'s [passkey FAQ](https://faq-support.westjr.co.jp/hc/ja/articles/55648108612761-%E3%83%91%E3%82%B9%E3%82%AD%E3%83%BC%E3%81%AE%E7%99%BB%E9%8C%B2-%E5%89%8A%E9%99%A4%E6%96%B9%E6%B3%95%E3%82%92%E6%95%99%E3%81%88%E3%81%A6%E3%81%8F%E3%81%A0%E3%81%95%E3%81%84) confirms passkey registration/deletion through WESTER member support. However, Smart EX official material does not confirm that WESTER passkeys always work for federated login to an already-linked Smart EX account. **Do not reinterpret WESTER passkey support as direct Smart EX passkey-login support.**

### 6.4 Bitwarden: confirmation and inference

Bitwarden generally provides [browser autofill](https://bitwarden.com/help/auto-fill-browser/), [Android autofill](https://bitwarden.com/help/auto-fill-android/), and [passkey storage](https://bitwarden.com/help/storing-passkeys/). It may therefore autofill Smart EX IDs/passwords or serve as a passkey provider where WESTER accepts it.

Official Bitwarden integration/compatibility with Smart EX/EX app is unconfirmed. EX app biometrics are not Bitwarden passkeys; easy login is a secret-bearing URL plus password. Do not combine member ID, password, easy-login URL, OTP destination, and card/IC numbers into one runtime secret.

Unconfirmed: session lifetime/refresh, device/IP binding, OTP risk decisions, WESTER federation tokens/sessions, actual Smart EX login through WESTER passkeys, and EX app biometric credential storage.

## 7. CDN, WAF, and anti-bot

Low-frequency logged-out observations on 2026-08-26:

| Public entrypoint                                              | Result                                                 | What can/cannot be concluded                                             |
| -------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `https://smart-ex.jp/`                                         | `301` then `200`, HSTS, public HTML                    | Marketing/help surface; may differ from auth-origin protection           |
| `https://shinkansen2.jr-central.co.jp/RSV_P/S_smart_index.htm` | `200`, `X-Akamai-Transformed`, `_abck`/`bm_sz` cookies | Akamai on Smart EX auth surface; strong bot-management-cookie candidates |
| `https://shinkansen2.jr-central.co.jp/RSV_P/smart_index.htm`   | Also `200`, Akamai headers/cookies                     | Smartphone login may share the classic-form backend                      |
| `https://faq.expy.jp/?site_domain=smart-ex`                    | `200`, `Server: nginx`                                 | Separate FAQ surface, not evidence for auth protection                   |

Akamai's [bot-management explanation](https://techdocs.akamai.com/cloud-security/docs/about-bots) describes behavioral detection protecting login/transactional paths. Observed headers/cookies suggest Akamai and bot-management involvement, but do not establish contracted Bot Manager/Account Protector/WAF products, policies, scores, challenge conditions, or native-app protection. No Cloudflare-specific headers were observed at auth entrypoints, but this does not prove Cloudflare/WAF absence.

Stop for 401/403/429, CAPTCHA/challenge/interstitial, authentication loops, unexpected OTP, or Akamai denial. Do not synthesize cookies, falsify telemetry/fingerprints, use CAPTCHA solvers, probe rate limits, rotate proxies, or bypass pinning/integrity. Cloud-provider headless browsers may increase OTP/bot decisions through IP/device changes.

## 8. Public Web JavaScript and concrete transport

### 8.1 Login transport

Confirmed facts from static analysis of public login pages/JavaScript on 2026-08-26:

- The login form uses `POST https://shinkansen2.jr-central.co.jp/RSV_P/ClientService`.
- Member-ID/password input names are `01`/`02`. Values were not entered or retrieved.
- The form has hidden fields including `_PageID`, `_ActionID`, `_DataStoreID`, `_SeqNo`, `_ControlID`, `_WBSessionID`, and `AppSessionID`. Values vary by session and are not recorded.
- Login-page `_PageID` is `RSWP100P211`; login action is `RSWP100AIDP312`. WESTER login navigation uses the same form/action framework.
- `cfEXPY_doAction(argsAid)` in `cfEXPY_common.js` sets `_ActionID` and submits the entire form. This is classic HTML POST exchanging server-side page state through hidden fields, not JSON REST/GraphQL.

Provenance:

- `/_javascript/cfEXPY_common.js?20260824`: SHA-256
  `b4371b3107a1eabbbcbfbe678a501817cef78e3671b218399a6a624e24847e82`
- `/_javascript/common_func.js?20260824`: SHA-256
  `b6cef7849910306a2d1efd87bc98b823f1bec0b88897366f5f61327230409fb7`
- Login-page-specific `RSWP100P211.js?20260824`: SHA-256
  `7ab1638e790ece608db76fad27678d2df6ae61014ceb5c6bf35ec8cbe8038ba0`

### 8.2 Implications for read/write isolation

The same path `/RSV_P/ClientService` and POST method may dispatch login, reads, reservations, changes, refunds, and settings changes. **Origin + method + path allowlists alone are insufficient.** At minimum, combine `_PageID`, `_ActionID`, page title, expected button label, and response page, allowing only read actions confirmed live.

Anonymous pages did not establish usage-history list/detail, receipt-display, refund-statement, or pagination `_PageID/_ActionID`. In authenticated read-only dynamic observation, retrieve only field names without saving values. Do not guess action IDs and POST them.

Current transport evidence strongly supports a C/D candidate using HTML navigation with a browser session, but does not establish a B client with a stable renewable session.

## 9. Official EX app, APK, and static/dynamic analysis

### 9.1 App and Web roles

Information checked directly in the [official Google Play listing](https://play.google.com/store/apps/details?id=jp.co.jr_central.exreserve) on 2026-08-26:

- Package: `jp.co.jr_central.exreserve`
- Version: `10.0.0`
- Last update shown on Play: `2026-08-10`
- Shared app for Smart EX and Express Reservation, providing reservations, confirmation, changes/refunds, purchase history/receipts, member information, IC assignment, and biometric login.

Because one package handles multiple services, specify service=`smart-ex` in analysis/collectors and do not mix Express Reservation accounts/hosts/pages/schemas. The app suits identifying biometric/device-bound auth and app-specific transport, but reservation/change/refund writes coexist centrally. Prefer Web initially because classic-form fields/actions are easier to observe and receipt printing is supported.

No official standalone APK distribution was confirmed. Do not use third-party mirrors for initial provenance; use artifacts legitimately installed from Google Play on user-controlled Android.

### 9.2 Next experiment for legitimate APK/split APKs

This environment lacked the complete set of a user-controlled Android with Google Play installation, `adb`, `apksigner`, `bundletool`, `jadx`, `apktool`, and MobSF, so no binary was obtained. Use the following procedure in encrypted temporary storage outside the repository.

```bash
PKG=jp.co.jr_central.exreserve
adb shell dumpsys package "$PKG" | grep -E 'version(Name|Code)|firstInstallTime|lastUpdateTime'
adb shell pm path "$PKG"
# Use adb pull for base.apk and every split_config*.apk obtained above, one by one
sha256sum artifact/*.apk
apksigner verify --verbose --print-certs artifact/*.apk
jadx -d jadx-out artifact/*.apk
apktool d -f artifact/base.apk -o apktool-out
rg -a -n 'https?://|wss://|ClientService|RSWP|retrofit|okhttp|webview|oauth|saml|bearer|cookie|session|pin|certificate|integrity|attestation|akamai' jadx-out apktool-out
```

- Verify matching signer digests across all splits; retain only package/version/signer/hash/acquisition time in provenance records. Do not commit APKs/decompiled code or upload them to third-party clouds.
- Inventory manifest, network security config, WebView/native boundaries, host/path/action-ID constants, serializers/models, session/cookie renewal, biometric key storage, Akamai mobile modules, and pinning/integrity candidates.
- R8/ProGuard/string-encryption deobfuscation and runtime tracing of URL builders/serializers/read methods can be in scope. Never log tokens/cookies/keys/OTPs/PII/actual values or create hooks changing pinning/integrity decisions.
- MobSF is for local static scans only. No automatic dynamic actions, third-party cloud upload, or binary redistribution.

### 9.3 Read-only app dynamic observation

1. With an existing installation/session, select Smart EX and open only reservation lists, purchase history, and existing document displays.
2. Without saving bodies, observe only DNS/SNI, host, method, path template, status, content-type, and field names.
3. Use a local proxy only if the app normally accepts a user-installed CA. For rejection/pinning/integrity errors, return to encrypted-metadata observation without patch/hook bypasses.
4. Limit runtime tracing to read pages/serializers; do not call reservation search/purchase/change/refund/IC/settings methods.
5. Without confirmed scope/session separation from write endpoints, do not replay directly; return to UI/manual routes.

## 10. Public third-party implementations

### 10.1 `hhhryoma/smartex-receipt`

[hhhryoma/smartex-receipt](https://github.com/hhhryoma/smartex-receipt) at commit [`7ba77bedc4749369e1cf589501878b4d45ecd641`](https://github.com/hhhryoma/smartex-receipt/blob/7ba77bedc4749369e1cf589501878b4d45ecd641/index.js) (2026-08-02, no license shown) is a concrete third-party implementation operating Web UI with Playwright 1.52 and persistent Chromium.

Transport/auth implementation:

- Navigates to `https://shinkansen2.jr-central.co.jp/RSV_P/smart_index.htm` and enters member ID/password from `.env` into `input[name="01"]`/`02`.
- Detects OTP pages by body text and clicks the SMS-send button. Reads OTP from `output/otp.txt`, enters it into inputs such as `tx01`, and saves a persistent profile to `output/.browser-profile`.
- After login, searches menu links with `cfEXPY_doAction` for `利用履歴/領収書/購入履歴` (usage history/receipts/purchase history) and processes `input[name="b1"][value="領収書表示"]` page by page.
- Converts print popups to PDF through Playwright `page.pdf()` and follows `次へ` in `div.pager`. This is C/D using Smart EX HTML/form sessions, not a direct API client.

Reasons it cannot be adopted unchanged:

- Stores passwords in plaintext `.env`, sessions in persistent browser profiles, and OTPs in plaintext files, logging OTP values to the console. Debug mode saves authenticated HTML/screenshots; normal runs save PDFs potentially containing actual dates/routes/amounts.
- The public repository itself commits PDF outputs with route/date names. PDF bodies were not opened in this research, but this is a privacy-design counterexample; do not fork, run, or redistribute it.
- `force: true`, generic `戻る/OK/次へ` (back/OK/next) selectors, and body-text fallback risk unexpected button presses after DOM changes. Strict read-only collectors must not use generic clicks.
- It targets only `領収書表示`, omitting `払戻明細`/`払戻手数料`, and cannot fully reconstruct net cost.
- Automatically clicks SMS sending and retries up to three times. Strict routes hand OTP off to humans without automatic retries on failure.
- Exclude its LINE push, an external write and additional secret.

This demonstrates receipt retrieval through a Playwright browser route, but does not prove a B-level internal API, current stability, terms compliance, or complete history retrieval.

### 10.2 Public reservation-notification email Gist

[dora1998's Gist](https://gist.github.com/dora1998/5a626f20797bd305fd93c76faab9da1b/8ba79dde474131fe4a20e12107467302d4b201b7) (revision `8ba79dde474131fe4a20e12107467302d4b201b7`, 2019, no license shown) uses Google Apps Script to search reservation emails from `yoyaku@expy.jp`, extract deposit-reference number, boarding date, stations, times, and train with regular expressions, and create Google Calendar events.

This is a concrete secondary-notification transport without login/session handling. However, it does not guarantee complete changes/refunds/automatic refunds/receipts/IC assignments/card settlement, and calendar creation is a write. This collector does not execute it. Even if email becomes a supplementary source, Smart EX usage history remains authoritative and email bodies/PII are not saved.

GitHub code/repository searches did not confirm a current documented personal API/SDK, renewable Smart EX read-API client, or public signature-verified decompilation of EX app 10.0.0. This does not prove absence.

## 11. Read/write isolation

Minimum allowlist:

- Normal login and existing WESTER federation login (exclude new linking, resets, settings changes)
- Reservation list/detail display, with button presses limited to strict selectors for `詳細` (details) and `戻る` (back)
- Period selection, `再検索`, and read pagination in `ご利用履歴・領収書の発行`/`購入履歴・領収書`
- Display/print views of existing `領収書表示`, `払戻明細`, and `払戻手数料`
- Display of boarding-IC `指定済/指定なし` (assigned/unassigned) and assignment counts; do not retrieve numbers

Denylist:

- `新幹線予約` (Shinkansen reservation), `予約を続ける` (continue reservation), `購入` (purchase), `変更`, `払戻`, `取消` (cancel), `人数を減らす` (reduce passengers)
- `乗車用ICカードを指定` (assign boarding IC card), `新しいカードを登録` (register new card); IC addition/editing/deletion/reordering
- `お客様情報の変更・退会` (change customer information/withdraw membership), `パスワード変更` (change password), `簡単login設定` (easy-login settings), `外部ID利用サービスの管理` (manage external-ID services)
- OTP delivery-method/phone/email/card changes, biometric/passkey registration, membership withdrawal, terms consent
- Pickup codes, ticket issuance, EXポイント (EX Points) use, travel-package/destination reservations, LINE/calendar notifications

Implementation gates:

1. In addition to origin/path/method, allowlist `_PageID + _ActionID + page title + exact label`.
2. Stop before submitting unknown action IDs even when the form action is `ClientService`.
3. Fix selectors to button names/values and parent pages; never use `force:true`, generic `OK/次へ/戻る` (OK/next/back), or coordinate clicks.
4. Classify all forms/buttons before clicking; hand off if any target candidate has a denied term or unknown action.
5. Stop on unexpected response page IDs/titles or redirects from usage history to reservation-operation screens.
6. Receipt-addressee entry is not an account write, but generates PII, so leave it blank in this validation.

## 12. Workers / Browser Run / Containers / OCI / Kubernetes suitability

- **Cloudflare Workers**: the [Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) supports HTTP POST, HTML parsing, schedules, and normalization. However, Smart EX POSTs mutable hidden sessions/action IDs to one `ClientService`, with Akamai/OTP. Unsuitable as the collector itself until renewable sessions and complete read-action separation are proven live; suitable for sanitized parsers/downstream transforms.
- **Cloudflare Browser Run**: the [official overview](https://developers.cloudflare.com/browser-run/) provides Playwright/CDP browser sessions; [Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/) allows handoff for MFA/secrets. A C candidate, but cloud IP/device changes may increase Akamai/OTP checks. Disable Session Recording because recording/Live View can retain PII, and check remote-secret policy separately.
- **Cloudflare Containers**: [official Containers](https://developers.cloudflare.com/containers/) support full filesystems, arbitrary runtimes, and existing OCI images. Better suited than Workers to Playwright, PDF printing, local parsers, and jadx/apktool, but do not solve Android devices/Play provenance/Akamai acceptance.
- **OCI/local container**: a practical candidate with pinned Playwright/browser/parsers, read-only rootfs, ephemeral `/tmp`, encrypted profile volumes, and egress allowlists. Keep profiles/receipts/debug out of image layers/repository; discard ephemeral volumes after processing rather than using secure deletion.
- **Kubernetes**: suits many-source CronJobs, per-source NetworkPolicies, external secrets, retries/observability, but excessive for Smart EX alone. Requires a controller that does not retry unknown DOM/OTP/401/403/429/writes.
- **Android device automation**: EX app routes require a real device/managed emulator and do not suit Workers/ordinary OCI alone. Do not assume pinning/integrity bypasses.

## 13. PR #5 common automation levels A–E and cost 1–5

Common definitions:

- **A**: official/documented read-only API or official machine-retrieval export
- **B**: direct use of stable internal read APIs and renewable/reusable sessions
- **C**: headless HTTP/browser replay after human browser/app login bootstrap
- **D**: ongoing full browser/device UI automation required
- **E**: manual capture/import

| Route                                             | Current assessment       |    Cost | Evidence/promotion conditions                                                                                                           |
| ------------------------------------------------- | ------------------------ | ------: | --------------------------------------------------------------------------------------------------------------------------------------- |
| Manual print of official receipt/refund documents | **E**                    |   **1** | Up to 15 months, no issuance-count limit. PDF is device-dependent; no bulk/CSV/API                                                      |
| Web usage history/receipts via Playwright         | **C candidate**          | **3-4** | Public third-party implementation demonstrates session UI/PDF. Requires Akamai/OTP, hidden actions, privacy hardening, refund documents |
| Web reservations/IC assignment status             | **D**                    |   **4** | Adjacent change/refund/IC writes share paths. C/4 if strict read-action allowlists confirmed live                                       |
| Direct internal `ClientService` replay            | **C candidate, below B** |   **4** | Classic form/session/action IDs confirmed; renewal, read-only actions, schema stability, Akamai acceptance unconfirmed                  |
| EX app                                            | **D**                    |   **5** | Shared-service app, device/biometrics, APK transport unconfirmed, adjacent writes                                                       |
| Email notification parsing                        | **C supplement**         |   **2** | May avoid login but incomplete secondary notifications. Does not replace authority/receipts/IC/settlement                               |
| Smart EX overall                                  | **D**                    |   **4** | Receipts are C candidates; reservation/IC/actual-boarding boundaries and safe write isolation still require full-browser confirmation   |

Do not choose A. Official HTML/print views exist, but are not documented machine APIs/CSV/bulk export. Promotion to B requires live proof of usage-history/receipt-only read-action IDs, renewable sessions, low-frequency replay accepted by Akamai, and structural separation from change/refund actions.

## 14. Read-only live-validation checklist and stop conditions

Read-only live validation:

- [ ] Only Smart EX service selected; no Express Reservation/travel-package/e5489 data mixed in
- [ ] Reservation list/detail field names, states, round-trip/connection/companion structure; no saved values
- [ ] Oldest 15-month history boundary, inquiry period, rows per page, pagination, total count, stable-ID presence
- [ ] Reservation/change/refund/non-use/delay/fee event types and before/after/original-transaction link-field presence
- [ ] `領収書表示`/`払戻明細`/`払戻手数料` counts, HTML/print/PDF fields, deposit-reference links
- [ ] Presence of CSV/JSON/export navigation; do not assume unmentioned functions are absent
- [ ] Boarding IC only `specified`/assignment counts; no capture of 17-digit numbers
- [ ] Actual-boarding/gate-history presence and distinction from reservations/purchases; do not open IC balances/conventional-line history
- [ ] Login/OTP/WESTER/biometric/session timeout and human-handoff points; no settings changes
- [ ] Observe origin/method/path/page ID/action ID/field names/response page for each read screen, without values
- [ ] Disable retries on Akamai/401/403/429/CAPTCHA; secret/PII redaction; default-deny unknown actions

Immediate stops:

- A confirmation/execution button for reservation, purchase, change, refund/cancellation, passenger reduction, IC assignment/editing, ticket pickup, or settings becomes a target
- OTP sending, 3D Secure, identity verification, WESTER linking/consent, passkey/biometric registration, or password reset is required
- Member/card/IC/reservation/deposit-reference numbers, Cookies/tokens/OTPs, actual dates/routes/trains/seats/amounts/addressees could remain in logs/HAR/screenshots/HTML/PDF
- 401/403/429, CAPTCHA/bot/interstitial, Akamai denial, authentication loop, or pinning/integrity error occurs
- Unknown `_ActionID/_PageID`, unexpected redirects, generic selectors, or inability to separate write/read sessions
- Cannot determine source boundaries among Smart EX, Express Reservation, card settlement, and IC transit ledgers

## 15. Conclusions, inferences, and unconfirmed items

### Confirmed

- Smart EX usage history covers up to 15 months from the day after reservation, displaying reservations/changes/refunds. Receipts, refund statements, and refund fees are separate documents, combined by deposit-reference number to calculate net cost.
- Official CSV/public API/bulk PDF is unconfirmed. Receipt PDF saving depends on device printing.
- Smart EX charges the card at reservation, not boarding-IC balance. IC identifies Shinkansen boarding rights; conventional-line fares/IC balances have separate ledgers.
- Direct login uses ID/password and risk-based OTP. Easy login is a dedicated password-only URL, not a passkey. Direct Smart EX passkeys are unconfirmed; do not reinterpret WESTER passkeys as Smart EX-specific support.
- Auth Web indicates Akamai involvement; public JS is classic transport POSTing hidden session/page/actions to one `ClientService`. Path/method alone cannot isolate reads/writes.
- Public Playwright code demonstrates C-level receipt potential, but cannot be adopted because it saves secrets/OTPs/PII, uses generic clicks, omits refund documents, and commits public PDFs.

### Inferences/design decisions

- Separating Smart EX usage history as purchase/refund authority, finalized card statements for actual settlement, reservations/gates for boarding rights/IC assignment, and IC issuers for conventional-line IC use best prevents double counting.
- Receipt/history-only is a C/3-4 candidate; Smart EX overall is D/4 due to dangerous adjacent actions. The safe initial route is E/1.
- Limited B may be possible if `ClientService` read-action IDs and session renewal can be established live.

### Unconfirmed

- Usage-history page size/maximum counts, stable IDs, before/after/original-transaction/refund links, CSV/JSON/export.
- Member display/export of actual-boarding/gate events and digital EX usage-slip copies.
- Authenticated read-screen `_PageID/_ActionID`, session lifetime/refresh, Akamai challenge/rate conditions.
- EX app 10.0.0 hosts/paths/schemas, WebView/native boundaries, signer, pinning/integrity candidates.
- WESTER passkey federated login to Smart EX and Bitwarden-specific compatibility.

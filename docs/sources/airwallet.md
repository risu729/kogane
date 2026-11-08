# AirWallet / COIN+ source research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26 (public information); authenticated live verification has not been performed.

## 1. Scope and safety boundaries

This record covers the **AirWallet app** provided by 株式会社リクルートMUFGビジネス (Recruit MUFG Business Co., Ltd.)
and the personal **COIN+ account/balance** it uses. The Airペイ (AirPAY) merchant ledger,
リクルートID (Recruit ID)/リクルートポイント (Recruit Points)/Pontaポイント (Ponta Points), linked banks' deposit ledgers,
AirWallet クイックローン (Quick Loan), and Airワーク給与支払 (AirWORK payroll) are separate sources.

Allowed activities are owner-operated reads of existing balances, registered financial institution displays,
existing usage history/transaction reports, and existing COIN+ QR/Visa payment history, plus static analysis
and dynamic observation of those read paths. Do not make payments, transfers, receipt requests, top-ups,
withdrawals, bank account additions/deletions, Visa card issuance/suspension, borrowing, campaign entries,
Recruit ID linking/unlinking, identity verification, or PIN/notification or other settings changes.
Do not retain phone numbers, names, bank/account numbers, counterpart users, actual merchants,
actual balances/amounts, passwords, SMS codes, four-digit PINs, cookies/tokens/device identifiers in
artifacts, logs, HARs, screenshots, or commits. Do not bypass security controls, probe load/rate limits,
or make small transactions for verification.

## 2. Research method and strength of evidence

- Prioritized the [official AirWallet site](https://airwallet.jp/), [official COIN+ site](https://coinplus.jp/),
  [COIN+ security explanation](https://coinplus.jp/security/), official FAQs, and official store listings.
- On 2026-08-26, made a small number of HEAD/GET requests to public URLs while logged out, observing
  only HTML/JavaScript, DNS, and CDN/WAF response headers. No login or challenge was triggered.
- Searched packages/domains in GitHub code search to check whether public third-party implementations
  implement the personal COIN+ transport.
- Did not obtain authenticated screens, personal data, APKs, app traffic, or actual export files. History
  periods/counts, pending schemas, and sessions/tokens not established by official public material remain
  unverified or are recorded as next experiments.

## 3. Surfaces and data boundaries

### 3.1 AirWallet is effectively app-only

- The [official AirWallet site](https://airwallet.jp/) describes top-ups, payments, transfers, and withdrawals
  using COIN+ as **app** features. The public web provides product descriptions, onboarding, and links to
  terms/FAQs; no web dashboard for logging in to personal balances or history was found.
- The official [Google Play](https://play.google.com/store/apps/details?id=jp.coinplus.app) package is
  `jp.coinplus.app`, provided by 株式会社リクルートMUFGビジネス.
  The [App Store](https://apps.apple.com/jp/app/%E3%82%A8%E3%82%A2%E3%82%A6%E3%82%A9%E3%83%AC%E3%83%83%E3%83%88/id1549123889)
  Apple ID is `1549123889`, for iPhone. As of 2026-08-26, the store displayed iOS 1.74.0;
  the Google Play update date was 2026-07-29.
- [COIN+](https://coinplus.jp/) states that the COIN+ account, registered financial institutions, and balance
  are shared across multiple COIN+-compatible apps. However, **transfers and withdrawals are available
  only in AirWallet**. Treat AirWallet as a display of the shared COIN+ ledger, rather than an app-specific balance.

### 3.2 Keep balances, banks, cards, and points separate

| Surface                           | Authoritative record/scope             | What public information establishes can be checked in AirWallet                                  | Do not conflate with                                                 |
| --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| COIN+ balance                     | Shared COIN+ balance                   | Current balance; changes from top-ups/payments/transfers/receipts/withdrawals                    | Linked bank deposit balances                                         |
| Registered financial institutions | Owner's accounts registered with COIN+ | Selection of top-up sources/withdrawal destinations; routes for moving between multiple accounts | Bank statements or complete bank account balances/attributes         |
| COIN+ QR payments                 | COIN+ payment ledger                   | Payment destinations and amounts in history                                                      | AirPAY merchant sales ledger                                         |
| AirWallet Visa                    | Prepaid Visa card                      | Visa payment destinations/amounts, card screen, payment management                               | An assumption that authorization/cancellation schemas match COIN+ QR |
| Recruit ID                        | ID linking/campaign boundary           | Linking to a COIN+ account as a condition of some campaigns                                      | COIN+ login ID or points balances                                    |
| Rewards                           | Often credited as COIN+ balance        | Candidate incoming entries in balance/history                                                    | Recruit Points/Ponta Points                                          |
| Quick Loan                        | Separate GeNiE loan                    | Borrowed funds may enter the COIN+ balance                                                       | Automation of ordinary COIN+ history                                 |

The [official AirWallet Visa explanation](https://airwallet.jp/visa-card/) states that COIN+ balance
is automatically converted to Visa card balance at Visa payment, and destinations/amounts remain in history.
The implementation therefore keeps `coinplus_balance`, `visa_card_balance`, `conversion`, and `visa_payment`
as separate events, avoiding double counting of balance movements and card payments. Virtual/physical card
issuance and suspension are writes and out of scope.

The [official Recruit ID/Points AirWallet campaign](https://point.recruit.co.jp/recruitid/doc/campaign/aw/airwallet202606_charge/A3hE2/)
requires Recruit ID linking but credits rewards as `COIN+残高` ("COIN+ balance"). This establishes a relationship
between ID linking and balance credits, but is no evidence that AirWallet provides Ponta/Recruit Points
balances, expiry dates, or history. Read points from separate sources.

## 4. Balances, history, states, and exports

### 4.1 Read scope established by public information

| Data               | Granularity/display | Established facts                                                                                                                                                                                   | Unverified                                                                             |
| ------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| COIN+ balance      | Current value       | Displayed at the top in official store images/explanations                                                                                                                                          | Available/held breakdown; update timestamp                                             |
| Usage history      | Event rows          | MUFG Bank's [official campaign FAQ](https://www.bk.mufg.jp/tsukau/lp/coin_202606_2/index.html) also directs users to check bank-specific top-up records in AirWallet's `利用履歴` ("usage history") | Row fields, status, pagination, earliest date                                          |
| Transaction report | Totals by type      | Official Google Play images display counts and totals for top-ups/withdrawals/payments, plus individual rows                                                                                        | Aggregation period selection; treatment of transfers/receipts/Visa                     |
| Payment management | Monthly totals      | The Google Play 2026-07-29 update description lists this month's payments, a budget usage graph, and past months' payment results                                                                   | Number of past months; QR/Visa distinction; whether budget is on-device or server-side |
| Visa history       | Payment rows        | The official Visa page states that all payment destinations and amounts remain in history                                                                                                           | Authorization/sales/cancellation/refund; original transaction links; foreign currency  |
| Withdrawal result  | Completion screen   | The [official instant withdrawal explanation](https://coinplus.jp/realtime-withdraw/) says to check the applied conditions on the withdrawal completion screen                                      | Pending/processing/failed codes; time reflected in history                             |

The [COIN+ limits](https://coinplus.jp/terms/limit/) state that only identity-verified, bank-account-registered
COIN+ (Standard) can use bank withdrawals and inter-account transfers. Light/Standard may have different
history schemas or retrieval scopes: check only the account class during live verification, without
performing new identity verification.

### 4.2 Pending / settled

Official public information describes `利用履歴`, `取引レポート` ("transaction report"), and `出金完了` ("withdrawal complete"),
but does not publish universal `pending/settled/failed/reversed` definitions, stable transaction IDs,
or original transaction links for corrections/refunds. Separate facts from hypotheses as follows.

- **Fact**: Withdrawals of up to JPY 100,000 at some banks are candidates for instant withdrawal; ordinary
  withdrawals arrive the next business day. Maintenance and other conditions may prevent instant processing
  even when eligibility conditions are met. Check the applied result on the completion screen.
- **Fact**: Visa payments involve conversion from COIN+ balance to Visa card balance; destinations/amounts remain in history.
- **Unverified**: Whether a withdrawal request is retained as a pending row, and bank receipt as settled.
- **Unverified**: Whether QR cancellation/refund updates the original row, adds a negative row, or temporarily hides it.
- **Unverified**: Visa authorization/clearing stages, final amount adjustments, foreign exchange, and cancellation/refund schemas.

The collector must not immediately interpret disappearance as deletion, or balance recovery as refund.
Retain `observed_at`, displayed status, type, and an anonymized source-local key; treat changes as snapshot
differences until pending/settled correspondence is demonstrated.

### 4.3 Periods, counts, and CSV/PDF/exports

Official public material establishes only that past months' payment results can be viewed. It did not establish:

- Earliest dates, retention years, or selectable months for usage history/transaction reports/payment management
- Rows per screen/request, infinite scroll/page/cursor, or maximum retrieval count
- Availability of filters or search by date/type/amount
- Personal CSV, PDF, JSON, email statements, or data portability exports
- Export columns, character encoding, single-month/bulk-period scope, or inclusion of Visa/transfers/withdrawals

Failure to find CSV/PDF/exports on public sites/FAQs/official stores does not prove they do not exist,
but gives no basis for an A rating as a documented export API. Safe capture currently means counting
schemas/rows on-device without exporting actual values, or the owner manually capturing only needed
rows after redaction.

## 5. Authentication, MFA, devices, passkeys, and Bitwarden

### 5.1 Established facts

- The [COIN+ security explanation](https://coinplus.jp/security/) states that registration links a smartphone
  to the COIN+ account through SMS two-factor authentication; afterwards it can be used with phone number
  and password. Login from an unregistered smartphone requires SMS two-factor authentication.
- The [official login procedure](https://faq.coinplus.jp/hc/ja/articles/4409254965145-%E3%83%AD%E3%82%B0%E3%82%A4%E3%83%B3%E3%81%99%E3%82%8B)
  shows phone number, password, then SMS code. Resending requires an interval of at least about one minute.
- COIN+ account creation requires a mobile phone number, SMS code, name in kana, password, and four-digit PIN.
- Executing top-ups/transfers and updating registered personal information require the four-digit PIN.
  This is a write authorization barrier separate from read login, but the same session still exposes write UI.
- The provider states that it continuously monitors unauthorized logins/transactions and sends SMS notifications
  for access from a device other than the one in use.

### 5.2 What is not established fact

- `紐づけ` ("linking") is official terminology, but the cryptographic binding mechanism—hardware-backed key, device
  certificate, Android Keystore, installation ID, or other mechanism—is unverified.
- No official material establishing passkey/WebAuthn/FIDO2 support was found. Do not treat non-discovery as proof of no support.
- Whether Face ID/Touch ID/Android biometrics can unlock reads, and whether this is server authentication or local unlock, is unverified.
- Session/cookie/token lifetimes, refresh, multiple devices, concurrent logins, and IP/UA binding are unverified.

### 5.3 Bitwarden (hypotheses kept separate)

Bitwarden/OS autofill might assist phone number/password entry, but is not an official COIN+ integration.
It does not solve SMS codes, device registration, four-digit PINs, or reuse of internal app sessions.
Do not consolidate PINs or SMS codes in password items/custom fields; the owner enters OTPs at the time.
Even if passkey support is later found, Bitwarden compatibility remains unverified until the platform/API
and app implementation are checked live.

## 6. Public web, WAF, and anti-bot

Small-number logged-out HEAD/GET observations on 2026-08-26:

| Entry point       | Observation                                                              | What can / cannot be concluded                                                                   |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `airwallet.jp`    | `Server: AmazonS3`, `Via: ...cloudfront.net`, `X-Cache`, `X-Amz-Cf-*`    | Marketing site served by S3/CloudFront; not the personal API architecture                        |
| `coinplus.jp`     | Also S3/CloudFront                                                       | Public brand/terms/store search delivery; personal API WAF unknown                               |
| `faq.coinplus.jp` | `Server: cloudflare`, `CF-Ray`; CNAME to Salesforce Siteforce/Cloudflare | FAQ served by Salesforce Experience/Aura through Cloudflare; separate from the COIN+ account API |

The main scripts loaded by public HTML are marketing UI such as `airwallet.jp/assets/js/main.js`
and `coinplus.jp/assets/js/main.js`. The FAQ loads Salesforce Aura bootstrap/app scripts. Public marketing
JS did not establish personal balance login, account APIs, or token issuance. Observing Cloudflare on the FAQ
does not establish Cloudflare, no WAF, or no bot protection for the app API. No Akamai-specific headers were
observed at these three entry points.

Because official material explicitly describes fraud monitoring, unknown device/IP reputation, rate limits,
integrity checks, and gateways may exist. Do not bypass CAPTCHA/pinning/attestation/anti-tamper,
spoof headers/device identifiers, or trigger challenges.

## 7. APKs, deobfuscation, and read-only runtime observation

No official standalone APK distribution was found. The legitimate Google Play package is `jp.coinplus.app`.
The research host had no existing ADB, connected Android device, or jadx/apktool environment, so APK static
analysis was not performed. Do not use third-party APK mirrors as the initial source.

The next stage targets the same version legitimately installed from Google Play on an owner-controlled Android device.

1. Enumerate base/split APK paths with `adb shell pm path jp.coinplus.app`; retrieve them only if non-root
   `adb pull` is permitted. Verify package/version/signing certificate/digest; do not put binaries in the repository.
2. Statically inventory the manifest, exported components/deep links, SDKs/permissions, backup/debuggable,
   network security config, cleartext settings, Play Integrity/SafetyNet candidates, and certificate pinning candidates.
3. Use jadx/apktool to examine host/path strings, OkHttp/Retrofit/Ktor/WebView, protobuf/JSON models,
   session/refresh, device registration, CSRF/idempotency, and read/write service boundaries. Do not force
   restoration of R8 names; assign provisional names from control flow, types, and strings. Deobfuscation
   is read-only work for understanding, not work to disable security controls.
4. Dynamically observe only one owner-operated session opening balances, history, transaction reports,
   and payment management. Through ordinary Android profiler/logcat, OS-permitted proxy/Network Inspector,
   or runtime hooks on read methods, emit only origin, method, path template, status, and field **names**
   to a sanitized allowlist. Drop arguments/bodies, headers, tokens, device IDs, PII, and actual values
   at the hook/trace stage.
5. Stop without bypassing integrity checks rejecting instrumentation/root/debuggers, certificate pinning,
   or anti-tamper. Hooks such as Frida are allowed only when they can observe normal read paths without bypassing protection.

Even if static analysis finds candidates, treat them as schema candidates without calling endpoints.
After dynamic observation, check read/write scope, token updates, idempotency, and alert/rate responses
before replaying read requests.

## 8. Public third-party implementations and transport/auth

GitHub code searches for `jp.coinplus.app`, `coinplus.jp`, and `airwallet.jp` on 2026-08-26 did not identify
a public client implementing current personal COIN+ balances/history or login/session renewal.
This is not proof that none exists.

The discovered [ohru131/coin_plus_map](https://github.com/ohru131/coin_plus_map/tree/fac52f370838de105a228d575687bd9bb2803cfe)
HTTP GETs `https://coinplus.jp/assets/csv/storesearch/all_shop_list.js`, used by public store search,
and parses store names/addresses/categories as CSV. It is an unauthenticated merchant search transport,
not personal balances, usage history, or COIN+ authentication. It supplies no basis for a personal source's
A/B/C rating or client code reuse.

Personal auth/transport currently established goes only as far as UI/official descriptions: the official
mobile app uses TLS; phone number/password, SMS on unregistered devices, and a four-digit PIN for writes.
API hosts, REST/GraphQL/gRPC, request signing, cookies/bearer tokens, refresh, CSRF, gateways, and read-only scopes are unverified.

## 9. Read/write isolation

### allowlist

- Existing session status checks and ordinary login (excluding password reset, account creation, and device unlinking)
- Display of current COIN+ balance, anonymized existing registered banks, usage history/transaction reports/payment management
- Display of existing COIN+ QR/Visa payment history and existing top-up/transfer/receipt/withdrawal history
- Download through an existing official export control if found (no generation/sending/sharing)

### denylist

- Payment/refund requests, transfers/receipt requests, top-ups, withdrawals, recurring transfers
- Bank account addition/deletion, identity verification, COIN+ account class changes
- Visa card issuance/applications, physical card applications, suspension/resumption, automated retrieval of card information displays
- Quick Loan applications/contracts/borrowing/repayment, payroll receipt settings
- Gift codes, campaign entries, Recruit ID/Points linking/unlinking, points use
- Password/PIN/phone/name/notification/budget/`みまもり` ("monitoring") and other settings changes, logout/reset/account closure

Internal tokens may cover both reads and writes, so do not isolate by HTTP method alone. Use
origin+method+path+request schema allowlists, an egress proxy, response type/size limits, dry-run, and auditing.
`POST` may be a read query and `GET` may have side effects; do not classify methods without actual observation.

## 10. Runtime suitability

| Runtime                                                                                              | Suitability                                                                                     | Reason                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare Workers                                                                                   | Suitable for parsing obtained sanitized exports/JSON; currently unsuitable for direct retrieval | An isolate alone cannot handle mobile app bootstrap, SMS, device binding, or unknown tokens. Reassess only after read-only personal API replay is demonstrated                                                                                               |
| Cloudflare Browser Run                                                                               | Usable for public FAQ research; unsuitable for personal data retrieval                          | Offers [Playwright](https://developers.cloudflare.com/browser-run/playwright/) and [session reuse](https://developers.cloudflare.com/browser-run/features/reuse-sessions/), but no personal web dashboard exists and it cannot bootstrap mobile app sessions |
| [Cloudflare Containers](https://developers.cloudflare.com/containers/platform-details/architecture/) | Parser/secretless replay candidate; unsuitable for Android UI                                   | Arbitrary runtimes/filesystems are available in containers, but Play devices, SMS, hardware-backed state, and accelerated Android emulators are separate problems                                                                                            |
| General [OCI container](https://github.com/opencontainers/runtime-spec)                              | Suitable for static analysis/parsers and HTTP replay after demonstration                        | Can reproducibly pin jadx/apktool/parsers. Keep APKs/secrets/profiles out of images and use short-lived mounts                                                                                                                                               |
| [Kubernetes](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)                   | Suitable for orchestration of many sources' parsers/replays, excessive for AirWallet alone      | CronJob/NetworkPolicy/Secret isolation is useful. Does not solve Android emulator/device routing or manual SMS                                                                                                                                               |
| Android emulator                                                                                     | Initial candidate, inferior to a physical device                                                | Official Android documentation requires host hypervisor/KVM for VM acceleration and restricts accelerated emulators inside VMs/Docker. Play Integrity/device binding may also behave differently on physical devices                                         |
| Owner-controlled physical Android device                                                             | Best for obtaining static artifacts and live read observation                                   | Uses legitimate Play installation, an already registered device, and owner SMS without exporting secrets to the cloud. Does not become fully unattended                                                                                                      |

Recommendation: perform one read-only schema check on an owner-controlled physical device, then pass
manually redacted captures to a local parser. Do not distribute credentials to Workers/OCI/Kubernetes before API replay is demonstrated.

## 11. Automation levels A-E and cost

Use only the common definitions from PR #5.

- **A**: direct documented/export API suitable for scheduled headless use
- **B**: stable read-only internal API with renewable/reusable session
- **C**: browser/app bootstrap + headless replay plausible
- **D**: full browser/device automation probably required
- **E**: manual capture remains safe default
- Cost ranges from 1 (small wrapper) to 5 (device-bound/adversarial)

| Route                                                                                                      | Level       | Cost | Assessment                                                                                                               |
| ---------------------------------------------------------------------------------------------------------- | ----------- | ---: | ------------------------------------------------------------------------------------------------------------------------ |
| Owner manually captures/redacts AirWallet balances/history/transaction reports and passes them to a parser | E           |  1-2 | Current safe default. Official export unverified; 2 for multiple screens/OCR                                             |
| Manual download + ingest if an official export is found live                                               | E           |    1 | An official manual export alone is E under the common rubric. Its existence is currently unverified                      |
| App UI/device automation                                                                                   | D           |    5 | App-only, SMS/device linking, adjacent write UI, session/integrity unverified                                            |
| Sanitized read endpoint replay after owner-device bootstrap                                                | C candidate |  4-5 | Transport/token renewal/read-write isolation not demonstrated. Candidate only if pinning/integrity bypass is unnecessary |
| Direct retrieval from a stable read API                                                                    | B candidate |  3-4 | Not currently B because a stable endpoint and reusable/renewable session have not been observed                          |

**Overall: E, cost 1-2. Full automation: D, cost 5. C candidate, cost 4-5, only after transport is demonstrated.**
Not A because there is no documented personal API/export API; not B because a stable read-only internal API
and session renewal have not been observed. Public store CSV is not personal data and is outside this assessment.

## 12. Read-only live verification plan

### Phase 0: Check displays only on the owner's device

1. Check only the legitimate Play/App Store version, version number, COIN+ Light/Standard class, and whether the device is already registered.
2. Record **field names only**: whether COIN+ balance and Visa card balance are separate on the home screen,
   and what registered banks display. Do not copy actual values even if bank deposit balances are not visible.
3. Open usage history, transaction reports, payment management, and Visa history. Do not press payment/transfer/top-up/withdrawal buttons.

### Phase 1: History schemas/periods/exports

1. Scroll to the oldest/latest month; count months available, pages/cursors, rows per load, and maximum rows without actual values.
   <!-- translation: ambiguous, original: 最古/月最新へscroll -->
2. Check only displayed fields and candidate statuses for top-ups, QR payments, Visa payments, transfers/receipts,
   withdrawals, and reward credits. Do not create transactions to produce absent types.
3. Check display schemas for cancellation/refund/failed/pending only if naturally present in existing history.
   Record original transaction links, transaction IDs, timestamps/timezones without values.
4. Check the presence, formats, and scope of filter/search and CSV/PDF/share/export controls in the UI. Do not press share/send.
5. Check payment management's month coverage, QR/Visa inclusion, and overlap rules with transaction reports.

### Phase 2: Static/dynamic transport

1. Obtain and verify signatures of legitimate installation artifacts using Section 7; statically inventory manifest/hosts/schemas.
2. Take a sanitized trace of one session in which the owner opens read screens; organize read/write hosts/paths,
   pagination, status models, and session/refresh candidates using field names only.
3. Before replay, verify read-only requests, credential scope, renewal, device/IP/UA binding, and rate responses.
   Do not store actual values even for one minimal read request; confirm balance/count consistency as yes/no on the owner's screen.
4. Do not advance to C/B if the same credential can write, refresh requires OTP/re-registration, or protection bypass is necessary.

## 13. Immediate stop conditions

- Navigation to payment, transfer, receipt request, top-up, withdrawal, bank addition/deletion, Visa/loan/identity verification/settings change screens
- Need to press a side-effect button such as `確認` ("confirm"), `申込` ("apply"), `変更` ("change"), `送る` ("send"), `受け取る` ("receive"), `チャージ` ("top up"), `出金` ("withdraw"), or `借りる` ("borrow")
- Risk of retaining passwords, SMS codes, four-digit PINs, tokens, accounts/phones/names, or actual amounts in logs/HARs/hook output
- Login alerts, fraud detection, CAPTCHA, rate limits, account locks, forced password reset, or additional identity verification
- Observation requires bypassing pinning, attestation, root/debugger detection, or anti-tamper
- Endpoint read/write side effects, idempotency, or target account cannot be determined
- Determining pending/settled/refund requires a test transaction or balance operation
- Retrieval crosses into Quick Loan, Recruit Points/Ponta, bank deposit ledgers, or another person's COIN+ account

On stopping, do not resend requests or try another device/IP; return to E manual capture. Do not share/commit
temporary artifacts containing secrets/PII. Safely discard them after checking whether they can be deleted on the owner's device.

## 14. Main primary sources

- [Official AirWallet site](https://airwallet.jp/)
- [Official COIN+ site](https://coinplus.jp/)
- [COIN+ security initiatives](https://coinplus.jp/security/)
- [COIN+ instant withdrawals](https://coinplus.jp/realtime-withdraw/)
- [COIN+ upper/lower limits](https://coinplus.jp/terms/limit/)
- [AirWallet Visa card](https://airwallet.jp/visa-card/)
- [Google Play: jp.coinplus.app](https://play.google.com/store/apps/details?id=jp.coinplus.app)
- [App Store: AirWallet](https://apps.apple.com/jp/app/%E3%82%A8%E3%82%A2%E3%82%A6%E3%82%A9%E3%83%AC%E3%83%83%E3%83%88/id1549123889)
- [COIN+ login procedure](https://faq.coinplus.jp/hc/ja/articles/4409254965145-%E3%83%AD%E3%82%B0%E3%82%A4%E3%83%B3%E3%81%99%E3%82%8B)
- [MUFG Bank campaign FAQ (checking AirWallet usage history)](https://www.bk.mufg.jp/tsukau/lp/coin_202606_2/index.html)
- [Official Recruit ID/Points campaign](https://point.recruit.co.jp/recruitid/doc/campaign/aw/airwallet202606_charge/A3hE2/)
- [Cloudflare Browser Run session reuse](https://developers.cloudflare.com/browser-run/features/reuse-sessions/)
- [Android Emulator hardware acceleration](https://developer.android.com/studio/run/emulator-acceleration)
- [Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [OCI Runtime Specification](https://github.com/opencontainers/runtime-spec)

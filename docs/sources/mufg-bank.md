# 三菱UFJ銀行 (MUFG Bank): MUFG Direct / banking app

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26

## Conclusion

Initially use **browser-based 三菱UFJダイレクト (MUFG Direct)** as Kogane's primary source. The user first
approves login on the smartphone registered with MUFGあんしんパス (MUFG Anshin Pass); after login save designated
service accounts' lists/balances/statements and official CSV/PDF. Browser offers yen deposit CSV, foreign-currency
ordinary/savings CSV, up to 25 months of Eco通帳 (Eco Passbook), and up to 10 years of transaction history
report PDF under the same contract, more output features than the app.

Assess fully unattended feasibility **medium**, implementation cost **4/5**. Data screens are ordinary automatable
Web UI, but MUFG Anshin Pass introduced in 2026 requires one registered smartphone/biometrics, including approval
for PC logins. Live screens must distinguish whether the owner's passkey means Bitwarden-synced WebAuthn or
official FIDO-compliant bank-app biometrics/MUFG Anshin Pass. Official material does not describe WebAuthn passkeys
storable in Bitwarden etc. as login methods. Currently treat Bitwarden as potentially supplying login passwords
safely, not replacing registered-phone approval.

Static public login SPA analysis established JSON BFF, CSRF cookies/headers, screen IDs, device fingerprints,
and cookie-based session extension rather than direct HTML form submission. Pursue public artifact static
analysis and owner-operated read-only traffic metadata observation in parallel. Authenticated balance/statement
endpoints and session replay remain undetermined; do not infer from public JS alone.

Official MUFG Direct APIs exist but require external service company contracts/consent. No self-service production
token issuance for personal developers' own accounts found; exclude as initial route. Mable ended; successor
Money Canvas retrieves financial institution statements through Moneytree, conflicting with this research's
requirement to use official bank sites/apps directly.

## Scope and non-goals

- Only personal MUFG Bank accounts, MUFG Direct, official `三菱UFJ銀行` app, old Mable/successor positioning,
  and personal Direct API feasibility.
- Do not research 三菱UFJカード (MUFG Card), My Digital Connect, JAL/J-WEST, securities, other banks, BizSTATION as sources.
- Read-only evaluation; no transfers/account transfers/time-deposit/foreign exchange transactions, account registration, Eco Passbook switching, points applications, settings changes.
- No authenticated account login or retrieval/recording of actual balances, account/contract numbers, names, secrets, cookies, OTPs.
- Only official pages, public login HTTP/DNS, public Google Play information, public GitHub code.

## Official entry points

| Route                  | Entry                                                                                                                                                                                                 | Main readable data                                                                                                                                                        | Export/automation role                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MUFG Direct (browser)  | [Official home](https://direct.bk.mufg.jp/index.html), [current PC login](https://directg.s.bk.mufg.jp/APL/LGP_P_01/PU/LG_0001/LG_0001_PC01)                                                          | Primary/designated service accounts, balances, yen deposits/withdrawals, time deposit details, foreign-currency deposits, transaction records, recent bank points accrual | **Recommended**. CSV/PDF/print; easy observation in ordinary browsers such as Playwright. Login likely needs smartphone approval                                                |
| Official MUFG Bank app | [Google Play (`jp.mufg.bk.applisp.app`)](https://play.google.com/store/apps/details?id=jp.mufg.bk.applisp.app&hl=ja), [official guidance](https://direct.bk.mufg.jp/btm/banking/sp_appli.html)        | Balances, statements, time deposits, foreign currency, etc.; smartphone statements up to 200 entries                                                                      | Important for displays/authentication issuance, but no yen statement print button; official CSV PC-browser-only. Device binding/root detection, unsuitable as primary collector |
| MUFG Direct API        | [Service](https://direct.bk.mufg.jp/btm/ser_naiyo/api.html), [terms](https://direct.bk.mufg.jp/btm/kitei/api.html), [developer portal FAQ](https://developer.portal.bk.mufg.jp/btmu/openapitrial/faq) | Account information, statements, time deposits, etc.; access tokens                                                                                                       | Official/ideal, but linked service companies required. No public self-service from trials to personal production clients. Initial cost **5/5**                                  |
| Mable                  | [Official termination](https://www.bk.mufg.jp/tsukau/app/lp/mable/moneycanvas/index.html)                                                                                                             | Former household accounting/separate-use account operations                                                                                                               | **Ended 2024-03-27**; unusable even for existing users, not a collection route                                                                                                  |
| Money Canvas           | [Mable differences/migration FAQ](https://faq01.bk.mufg.jp/faq/show/4980?site_domain=moneycanvas), [refresh delay FAQ](https://faq01.bk.mufg.jp/faq/show/4979?site_domain=moneycanvas)                | Assets/statements/trends; some Mable migration                                                                                                                            | Bank-provided, but institution statements use Moneytree. Separate-use account operations/deposit-withdrawal notifications do not migrate. Violates aggregator avoidance         |

## Account enumeration and balances

MUFG Direct home shows primary account balance; others via `口座一覧／ほかの口座残高` ("account list / other
account balances"). Invisible held accounts may need registration as service-designated accounts.
That registration is a settings change; do not automate in this PoC.

[Personal Direct API terms](https://direct.bk.mufg.jp/btm/kitei/api.html) explicitly list 10 linkable
designated service account types. Relevant bank deposits: ordinary, savings, current, time, foreign-currency
ordinary, foreign-currency savings, foreign-currency time, property-formation savings (terms also include
My Card/investment trusts). Web balances/statements likewise use designated service accounts.

- **普通預金／スーパー普通預金（メインバンク プラス） (ordinary / Super Ordinary Deposits (Main Bank Plus))**: Super Ordinary is ordinary deposits with preferential features, not another collection route; same account list/yen statements as primary/designated accounts.
- **つかいわけ口座 (separate-use accounts)**: under [current terms](https://www.bk.mufg.jp/regulation/tsukaiwake.html), ordinary deposits (Eco Passbook) without cash cards, automatically registered as designated service accounts on opening; cannot unregister. Remain ordinary deposits after Mable ended. [Transaction history report applications available in Direct](https://faq01.bk.mufg.jp/faq/show/5533?site_domain=default).
- **Yen time deposits**: total account balances/all current placement details. [Official help](https://directg.s.bk.mufg.jp/refresh/ib_help/yen_teiki.html) explicitly paginates; no personal CSV guidance. Night/holiday requests may appear around 08:00 next business day.
- **Foreign-currency ordinary/savings/time**: [help](https://directg.s.bk.mufg.jp/refresh/ib_help/gaika.html) offers total reference yen equivalents, individual balances, per-account details; foreign-currency savings also current withdrawable amounts. Time deposits show all current placements.

No direct historical balance series from account lists established. Reconstruct yen deposit post-transaction
balances from statements; continuously save time/foreign-currency snapshots.

## Statements, periods, counts, confirmed states

### Yen ordinary/savings etc. deposits and withdrawals

[Current browser help](https://direct.bk.mufg.jp/fw/ib_help/meisai.html) specifies:

- Initial view: primary account's latest 30 days.
- Eco Passbook: up to 25 months. Non-Eco: previous month's first day through today.
- Eco Passbook `取引推移表` ("transaction history report"): up to 10 years' past PDF statements by application.
- Browser CSV is **per account**, PC only. `全取引／入金／出金` ("all transactions / deposits / withdrawals") up to 200 per operation;
  `振込入金` ("incoming transfers") up to 100. Split periods when exceeding limits.
- Screen filters: all transactions/deposits/withdrawals/incoming transfers. App display also maximum 200.
- Print screens include names/branch/account numbers etc.; keep out of public Kogane logs/Git.
- Optional Eco Passbook notes: seven characters per entry/up to 25 months; note editing is a write, not a collector operation.

Official public pages do not detail personal CSV columns. The still-updated third-party
[Zaim CSV Converter MUFG row model](https://github.com/yukihiko-shinoda/zaim-csv-converter/blob/66b93b514bc12f45c29c349e6a84cc39ad9b1f39/zaimcsvconverter/data/mufg.py)
reads date, description, description contents, payments, deposits, balance, notes, unrecorded flag,
deposit/withdrawal type. Strong CSV granularity evidence, not a current bank specification; recheck only
actual file headers without secrets.

### Yen time deposits and foreign currency

- Yen time deposits emphasize current placements/total account balance, not history; no personal CSV found.
- Foreign-currency ordinary/savings periods depend on account form: generally 40 days for passbooks, 40 or 220 days for statement accounts,
  generally 60 days for paperless internet-branch accounts. Per-account CSV matches inquiry conditions.
- Foreign-currency time/internet foreign-currency time deposits show all current holdings; help explicitly says **no CSV**.
- Foreign-currency past transactions/notices include Eco通知 (Eco Notices) as research targets; document types/retention/machine readability unverified for the actual contract.

### Pending/confirmed treatment

Treat statements/CSV as posted account transactions. No card-like pending statement field found in help.
[お取引記録 (transaction records)](https://directg.s.bk.mufg.jp/refresh/ib_help/kiroku.html) cover up to six months
(inquiry operation two months), 50 rows/page, with `受付完了` ("request accepted"), `処理中` ("processing"),
`取引完了` ("transaction complete"), `エラー` ("error"), scheduled processing dates. Official guidance says
transfer destination discrepancies can cause later errors even after `取引完了`.

Keep two series separate:

1. Statements/CSV: ledger evidence already reflected in accounts.
2. Transaction records: operational evidence of acceptance/scheduled processing/completion/errors; store separately as pending until completion.

Read-only collection never re-executes/cancels/transfers even after checking transaction records.

## Points

Bank-account-side data mainly covers **メインバンク プラス Pontaポイント (Main Bank Plus Ponta Points)** for
Super Ordinary Deposits. [Official guidance](https://www.bk.mufg.jp/kouza/yugu/mb/pointservice/index.html)
says Direct shows the latest month's awarded points; a button leads to external PontaWeb. Bank-only data
therefore cannot provide a complete Ponta total/history ledger.

Official app advertises card usage/points inquiries, but [help](https://direct.bk.mufg.jp/fw/ib_help/credit_shoukai.html)
describes logging into other member Web screens using registered card credentials. This is not bank deposit
data; bank collectors do not retrieve グローバルポイント (Global Points) etc. Separate recent bank-side Ponta
awards from balance/history through other points routes.

## Authentication and sessions

### Established facts

- Ordinary login: primary account branch/account number or contract number, 8–16-character login password.
- [MUFG Anshin Pass](https://direct.bk.mufg.jp/secure/ansnps/index.html), official 2026 feature, requires one registered smartphone/fingerprint-face authentication.
  Other phones/PCs enter browser passwords then require registered-phone approval. QR codes generated per operation, not reusable; device changes/app reinstalls require re-registration.
- Prior app biometrics are also [FIDO-compliant](https://direct.bk.mufg.jp/btm/banking/sp_appli/seitai.html), but not officially described as equivalent to general synced passkeys.
- Transfers/other fund movements require app/card OTPs. App OTP registration: one device per contract; other-device registration/device change requires re-registration. Collector never calls fund movement screens.
- [Official FAQ](https://faq01.bk.mufg.jp/faq/show/63?site_domain=default) explicitly describes six-digit email OTP/cash-card PIN step-up for unusual device/network or possible non-owner access, denying especially high-risk access.

### Unverified

- Exact authenticated cookie lifetimes, reuse after Chrome restart, validity after IP/OS changes.
- Moving Anshin-Pass-approved sessions to WSL/OCI/Cloudflare.
- Whether read-only re-login always needs phone approval or trusted browser state exists.
- Whether the owner's Bitwarden passkey is actually offered as WebAuthn on this bank login.

Retrieve secrets from Bitwarden only at runtime; keep out of logs/images/raw evidence/environment dumps.
No rapid authentication retries; return to manual approval/new sessions.

## Akamai, WAF, anti-bot

### Established

Public DNS on 2026-08-26: `direct.bk.mufg.jp`, `directg.s.bk.mufg.jp`, `entry11.bk.mufg.jp` resolved through
`*.edgekey.net` to `*.akamaiedge.net`, establishing **Akamai CDN/edge use**. Ordinary `curl` public home/login
HTML returned 200 without explicit Bot Manager cookies/challenges. Login requests User-Agent Client Hints;
MUFG FAQ explicitly describes device/network risk analysis.

### Hypotheses/unverified

Whether Akamai Bot Manager/WAF protects authentication POST/post-login APIs is unverified. DNS alone does
not establish Bot Manager. No credentialed tests performed; no 403, Akamai reference numbers, `_abck`, `bm_sz`,
etc. observed. Anticipate anti-bot in design without transferring Vpass/other services' behavior to MUFG Bank.

## Public Web SPA / BFF static analysis

On 2026-08-26 retrieved [current PC login](https://directg.s.bk.mufg.jp/APL/LGP_P_01/PU/LG_0001/LG_0001_PC01)
and public JavaScript referenced by its HTML without credentials; inspected statically. Login HTML has no
`form`; Angular SPA starts with base `/APL/LGP_P_01/`. Public config includes:

- Login BFF: `https://entry11.bk.mufg.jp/ibg/dfw/APLIN/bff_lgp/v1/ib`
- Post-login candidates: `https://entry11.bk.mufg.jp/ib/dfw/APLAG/bff_go/v1/ib` and
  `https://entry11.bk.mufg.jp/ib/dfw/APLS`
- Session extension: `/BFF_LG_1000_01`; framework logs: `/BFF_LG_1000_03`

Public login services define `/BFF_LG_0001_01`–`05`. `02` sends branch/account/contract numbers, login
password, `devicePrint`, browser language, timezone as JSON. `03` has extra authentication types,
card PIN/email OTP candidates, `devicePrint` again; `04` retrieves QR information, `05` checks out-of-band
approval status. These are **public-code request schema candidates**, not proof every field is always sent
or required for the current contract. No values retrieved/recorded.

Common transport copies `drb-CSRF-Token` cookies into `CSRF-Token` headers, adds `X-Screen-ID`,
`X-Screen-Event-ID`, POSTs with `withCredentials`. If `drb-ak` cookies exist, adds `X-Trusteer-Rapport: ak=...;`.
Session extension BFF uses CSRF/headers/cookies and sequences. Public `encode_deviceprint()` combines user
agent, OS/browser, screen, timezone/language, plugins, cookie availability, proxy timing, optional location,
etc. Input event collectors handle focus/blur/key/paste counts/lengths and similar metadata. Symbols/headers
indicate an RSA-family device-print implementation; specific fraud product names/server decisions unverified.

This establishes login BFF existence, CSRF/session framework, device risk signals. Authenticated balance,
account enumeration, yen/time/foreign-currency statement endpoints, response schemas, pagination,
token/cookie lifetimes remain unverified. Public assets had no source map references; no need to call BFFs
unauthenticated. Next observe only method, origin, path template, status, content type, field **names**
with DevTools/Kuebiko during owner login. Discard bodies, cookies, CSRF, OTPs, account identifiers, actual values at capture.

## Android app, legitimate split acquisition, static/dynamic analysis

Google Play link on the [official bank app page](https://direct.bk.mufg.jp/btm/banking/sp_appli.html)
directly targets `jp.mufg.bk.applisp.app`. [Public Play page](https://play.google.com/store/apps/details?id=jp.mufg.bk.applisp.app&hl=ja&gl=JP)
retrieved on 2026-08-26 showed developer `MUFG BANK, LTD.`, version `13.11.0`, updated 2026-08-05,
5 million+ downloads. Provenance: bank official link, Play developer, package. No independent official
APK distribution from the bank site found; official route is Play. App Bundles need all delivered
configuration/feature splits, not base alone.

Public Play description explicitly warns of problems on devices with rooting history/tools, and lists
phone/location permissions, biometrics, OTP. Location is optional for improved fraud detection. These
suggest integrity/risk checks, not specific Play Integrity/SafetyNet/custom root detection without artifacts.

Research environment lacked ADB, Android SDK build tools, jadx/apktool, connected owner physical Android;
no legitimate artifact obtained from Play-authenticated devices. Do not use unofficial mirrors without
provenance. Reproducible acquisition:

1. On owner non-root Android, follow official bank page to Google Play and install target package.
2. With owner consent, enable USB debugging; use `adb shell dumpsys package jp.mufg.bk.applisp.app` to record
   versionName/versionCode, installer, split names; enumerate base/split paths with `adb shell pm path ...`.
3. Only if shell-readable, `adb pull` all base/splits privately, record SHA-256 and
   `apksigner verify --print-certs` signers. Stop on pull denial, no root/protection bypass.
4. Keep binaries, non-signature device information, accounts out of Git; reassess private artifact retention after analysis.

After legitimate splits are available, statically check:

- Manifest permissions, exported components, App Links/custom schemes, min/target SDK, backup/debuggable,
  native libraries, Network Security Config/cleartext settings.
- Host/path strings, WebView, OkHttp/Retrofit etc. transports, JSON/protobuf etc. schema candidates.
- Candidate Android Keystore, BiometricPrompt, FIDO2, MUFG Anshin Pass, Play Integrity/SafetyNet, root/debug detection,
  certificate pinning libraries/config. Promote to fact only what artifacts establish.
- Whether account lists/yen/time/foreign-currency reads share public Web BFF/WebView or use native-only APIs.

In parallel, research read-only runtime tracing while the owner opens balances/account lists/statements.
First try Android Studio Network Inspector (if profileable), standard proxy/PCAP metadata, filtered logcat;
retain only methods/origins/path templates/status/content types/call order/schema field names. Frida/Objection
hooks may observe network client method/WebView navigation metadata only while the app works normally on
owner devices. **Stop immediately** if root/debugger/integrity/pinning detection terminates the app; no certificate
replacement, pinning disablement, attestation spoofing, root hiding, or other bypass. Call no transaction
endpoints/replay no unknown read-write requests. Static analysis alone does not reproduce device keys,
biometrics, session tokens.

### App/Web read coverage differences

Officially both show balances, statements, yen time/foreign-currency deposits. Web offers yen/eligible foreign
currency CSV, printing, 25-month Eco Passbook, 10-year report PDFs; app statements maximum 200, yen CSV/printing
PC Web only. No current public evidence of app-only bank history/granularity advantages. App also hosts OTP,
notifications, cards, etc.; runtime allowlists cover only bank reads, excluding cards/transaction starts as
separate source/write boundaries.

## Public client research

Code inspection of current/old implementations found mostly **browser DOM operations or official CSV**;
no maintained client directly calling current authenticated internal JSON APIs. Public bank login JS establishes
JSON BFF transport itself, not a third-party client or authenticated read endpoints.

| Implementation                                                                                                                                              | Last checked            | Method                                                                                                                                                              | Assessment                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [4noha/openmoney `plugins/mufg/scraper.py`](https://github.com/4noha/openmoney/blob/7fa001a411549f3b55ec766701dd4c07b45c8c98/plugins/mufg/scraper.py)       | File commit 2026-05-09  | Playwright current login, contract/password entry, sends Anshin Pass QR to user, waits approval, parses monthly yen statements up to 25 months in 100-row DOM units | Strong current reference; explicitly phone-approved, not fully unattended. Balances/foreign currency/time deposits/CSV raw evidence missing |
| [nakaomote/financial `ufj_download.py`](https://github.com/nakaomote/financial/blob/1565e12aab81c4ac08687e405869f5681ede20ca/ufj_download.py)               | File commit 2025-04-20  | Headless Selenium login/yen CSV download                                                                                                                            | Before Anshin Pass, old selectors; current operation unverified                                                                             |
| [yusuke1225math2/my-finance `ufj_driver.py`](https://github.com/yusuke1225math2/my-finance/blob/ea552e35974d6c6efbf9936e88800eaf80c9a5ab/ufj/ufj_driver.py) | File commit 2024-05-30  | Headless Selenium/latest 30-day CSV                                                                                                                                 | Old example vulnerable to auth/UI changes                                                                                                   |
| [shinichy/get_statement `get_statement.py`](https://github.com/shinichy/get_statement/blob/6f9730162d72eb9d14fa950767fdbcc8836676c1/get_statement.py)       | 2018-12-01              | Selenium old image buttons/CSV                                                                                                                                      | Historical only                                                                                                                             |
| [Finance::Bank::JP::MUFG](https://github.com/gitpan/Finance-Bank-JP-MUFG/blob/7a19f150108c58153167eda612ff44f54bee04e0/lib/Finance/Bank/JP/MUFG.pm)         | 2012-10-21              | `WWW::Mechanize` direct HTML `_TRANID` POST, parses accounts/transactions/CSV                                                                                       | Browserless precedent, far older than current auth/Angular UI, unusable                                                                     |
| [Zaim CSV Converter](https://github.com/yukihiko-shinoda/zaim-csv-converter)                                                                                | Repo updated 2026-08-20 | Local conversion of owner-downloaded official Web CSV                                                                                                               | Parser reference, no login/internal APIs                                                                                                    |

`openmoney` shows post-login Web retrieval is realistic but does not remove Anshin Pass approval from the
human loop. Public JS establishes part of login BFF request shapes, not authenticated reads/session replay.
Passive owner-operated traffic metadata observation in Kuebiko is the next minimal verification.

## Runtime suitability

| Platform                    | Suitability      | Reason                                                                                                                                                                                            |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Worker (isolate) | Low              | No full Chrome/Android; useful for coordination/ingest if authenticated simple HTTP APIs become identified/replayable                                                                             |
| Cloudflare Container        | Medium           | Linux Playwright possible, but short-lived container alone cannot complete registered-phone biometric approval. First test approved session import/replay; collector candidate only if successful |
| OCI VM / Kubernetes         | Medium-high      | Easier persistent Chrome profiles, fixed environment, long approval waits. No unattended guarantee, but easier browser issuer with phone approval than Container                                  |
| Local visible Chrome        | High (initially) | Easy registered-phone approval/safe Bitwarden input/Kuebiko traffic observation; first issuer/fallback                                                                                            |

Recommended split: visible Chrome **session issuer**, short-lived Linux **read-only consumer**. Without session
replay, use persistent OCI etc. browsers for user-approved semi-automatic collection; Cloudflare only receives/stores raw evidence.

## Implementation cost and recommended order

| Route                                                             |          Cost (1-5) | Automation feasibility                            | Decision                                                                                  |
| ----------------------------------------------------------------- | ------------------: | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Manual browser + official CSV/PDF + Kuebiko                       |                   2 | Manual recurring operations, high post-processing | **Adopt now**; most accurate, preserves raw evidence                                      |
| Visible Playwright + owner Anshin Pass approval + DOM/CSV         |                   4 | High semi-automatic, low-medium fully unattended  | **First PoC**; existing 2026 implementation                                               |
| Approved Web session internal API replay                          | 3 (after discovery) | High if successful                                | **Highest technical verification priority**; login BFF known, authenticated reads unknown |
| Official Direct API                                               |                   5 | Very high if contracted                           | Production external-service-company connection requirements too heavy; defer              |
| Legitimate Android split static analysis + owner runtime metadata |                   5 | Low-medium                                        | **Parallel research** once device/artifacts available; stop at security barriers          |
| Money Canvas/Moneytree                                            |                   2 | High                                              | Reject: violates aggregator avoidance                                                     |

## Next verification steps

1. Open current login in visible Chrome; compare public `BFF_LG_0001_01`–`05` call order in DevTools/Kuebiko.
   Distinguish owner-described passkeys as WebAuthn/Bitwarden versus registered-phone Anshin Pass using UI/WebAuthn events only; save no bodies/secrets/cookies.
2. Login once with user approval, passively capture in Kuebiko, enumerate only primary/designated account types.
   Mask numbers/names/balances; record only where ordinary/Super Ordinary/separate-use/yen time/foreign-currency ordinary-savings-time appear.
3. Display short-period yen statements; check official CSV headers/encoding, limit-exceeding behavior, pagination,
   current/pending screen representations. Actual files only in private capture storage, never Git.
4. Open each read-only yen time/foreign-currency ordinary-savings-time/Eco Notice/report PDF screen once;
   capture content types/internal APIs/pagination/update times. Press no transaction start buttons.
5. Record only authenticated read BFF methods/origins/path templates/status/content types/request-response field names/
   pagination. Exclude shared transaction/settings endpoints or unknown side effects from replay.
6. Only with explicit collection approval, encrypt immediate post-login cookies in source-scoped envelopes;
   replay balance home in order: new same-machine profile, WSL, OCI. Stop on 401/403/login redirects/phone reapproval;
   no CSRF/Trusteer/device print forgery or password retry.
7. Only after success, try the same read-only GET/internal API once in Cloudflare Container.
   On failure return to persistent OCI Chrome issuer, without declaring anti-bot the cause.
8. In parallel install app via official links on owner's non-root device; record `dumpsys package`, `pm path`,
   all split signers/hashes. Analyze statically if obtained, no Git binaries. Otherwise record permissions/errors and stop, no root/mirrors.
9. Owner opens app balances/accounts/yen-time-foreign-currency statements once each; observe read-only runtime metadata.
   Prohibit write navigation, secrets/PII/request body retention, pinning/integrity bypass.
10. If authenticated read APIs remain unknown or offer less than CSV, adopt periodic official CSV/PDF semi-automatic
    collection as formal route. Retain app findings for coverage differences/future transport decisions.

## Unverified items

- Whether all actual accounts are designated service accounts, especially old yen time/foreign-currency accounts.
- Exact current personal CSV headers/encoding/notes/unrecorded flags/line endings/filenames.
- Complete yen/foreign-currency time fields: placement/maturity dates, rates, maturity handling, yen valuations, etc.
- Foreign-currency Eco Notice document types, PDF/HTML, retention, historical gaps.
- When reserved transactions enter ledger between CSV/operational records, stable transaction IDs.
- Authenticated read BFF paths/schemas/pagination/rate limits/cookie-token expiry; login CSRF/session framework established.
- Safe cross-OS/IP replay of Anshin-Pass-approved sessions.
- Akamai Bot Manager/WAF on authentication POSTs; public DNS alone insufficient.
- Legitimate Android split versionCodes/signers/manifests/hosts/native-WebView boundaries/network config/schemas.
- Android device keys/FIDO/Anshin Pass/integrity-root-debug detection/certificate pinning implementations.
- Practical availability of MUFG Direct production API contracts for Kogane.

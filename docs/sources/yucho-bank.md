# ゆうちょ銀行 (Japan Post Bank): ゆうちょダイレクト (Yucho Direct) / ゆうちょ通帳アプリ (Yucho Bankbook App)

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26

## Conclusion

- **Kogane's primary route is CSV download from official Web ゆうちょダイレクト**. Comprehensive accounts' ordinary/savings deposits provide current/withdrawable balances and deposit/withdrawal statements. CSV has output sequence numbers and `詳細1` (detail 1)/`詳細2` (detail 2), splitting descriptions beyond screen information. Each file holds 3,000 rows, up to 10 files/30,000 rows.
- Statement periods vary greatly: passbook comprehensive accounts up to 2 months, transfer accounts up to 15 months, passbook-free ゆうちょダイレクト＋（プラス） (Yucho Direct Plus) up to 20 years from March 2021. Switching to `ダイレクト＋` (Direct Plus) changes account state; **never switch without authorization as Kogane collection preparation**. Use existing subscriptions for long-term backfill.
- Enumerate collateral TEIGAKU/time deposits separately from ordinary ledgers as **deposit lots** from official Web/app `明細情報一覧` (statement-information list). Public material confirms deposit-status details and transaction-result inquiries, but not CSV/PDF export, retention, or exact fields. TEIGAKU/time deposits with dedicated passbooks/certificates are excluded from Direct.
- The Bankbook App shows ordinary/savings balances/transactions and collateral TEIGAKU/time balances/details. Initial coverage depends on registration timing, etc.; Android device changes do not carry over statements. Device biometrics, four-digit passcodes, and on-device FIDO make it a tool for **official-screen checks, human Web-login authentication, and Web coverage comparison**, rather than the primary cloud route.
- The bank has read APIs for current balances, transactions, collateral TEIGAKU/time deposits, overdraft principal, and investment trusts. They are not public developer APIs: Banking Act electronic payment service provider qualification, standards compliance, individual contracts, and renewed user consent every 90 days are required. Ideal official data sources, but contractual costs dominate implementation for a personal Kogane MVP; not currently adopted.
- `www`, `direct`, and `direct3` DNS CNAMEs are `edgekey.net`, confirming Akamai delivery. Generic curl to `direct` timed out/failed HTTP2, while search crawlers/normal-browser public pages reached it. Normal Chrome public-login observation confirmed HTML forms with Struts tokens/events, separate password/app `direct1` transitions, FIDO app links/returns, and security-telemetry POSTs to `directss`, etc. This alone does not confirm Akamai Bot Manager/WAF products, bot scores, or headless blocking.
- Official Google Play on 2026-08-26 listed Bankbook App `jp.japanpost.jp_bank.bankbookapp` **21.0.0** (updated 2026-04-10) and ゆうちょ認証アプリ (Yucho Authentication App) `jp.japanpost.jp_bank.FIDOapp` **18.0.0** (updated 2026-04-09). Without a legitimate installed device, APK/splits/versionCode/signers were unavailable, but reproducible split acquisition, signature checks, deobfuscation, and read-only runtime tracing were specified.
- No currently functioning third-party client was confirmed. `kkosuge/bank_job` is 2014 Mechanize HTML forms/security phrases/table parsing; `toc/pogact` uses Selenium on old screens. `shinichy/get_statement` is a 2018 Selenium downloader but **does not implement Japan Post Bank**. None is a current-client foundation; use only as historical HTTP/HTML-structure references.

Overall assessment: **semiautomatic monthly CSV 2/5; browser collector including balances/ordinary statements/collateral TEIGAKU-time deposits 3/5; fully unattended login 4/5; official API technical implementation 2/5, adoption including contracts 5/5**. Automation prospects are medium–high for reads with existing registered browsers/sessions, medium or lower for unattended fresh logins every run.

## Scope and non-goals

Only direct read-only retrieval of the user's own Japan Post Bank accounts through official Web/apps or bank-owned read APIs is in scope.

- Scope: Yucho Direct, Direct Plus, Bankbook App, Authentication App, bank read APIs
- Retrieval candidates: registered-account lists, current/withdrawable balances, ordinary/savings/transfer-account transactions, current collateral TEIGAKU/time details, official CSV, passbook images
- Non-goals: JP BANKカードWEB (JP BANK Card Web)/credit cards, ゆうちょデビット (Yucho Debit) usage details, other banks, securities, ゆうちょPay (Yucho Pay), Moneytree/other aggregators, corporate Web transfer-receipt/payment-notice operations
- Safety boundaries: no transfers, account transfers, payments, TEIGAKU/time deposits/redemptions, maturity-treatment changes, automatic-loan changes, account registration/deletion, Direct Plus switching, or authentication-setting changes

This research did not log into authenticated accounts, checking only public pages/login entrypoints, unauthenticated DNS/HTTP observations, and public code. Bitwarden vaults were not opened; no secrets, personal identifiers, actual balances, account numbers, or auth cookies were saved.

## Research method

1. Checked current bank service pages, FAQs, guides, terms, API policies, and official Google Play listings.
2. On 2026-08-26, checked public hosts unauthenticated for DNS CNAMEs, HTTP responses, official login procedures. Normal Chrome observation was limited to public login DOM, loaded JavaScript, host/path/method/status; no form submission, login requests, invented account entry, or request-body saving.
3. Searched GitHub Code Search for current/old clients, reading pinned-commit code to classify browsers, CSV, HTML forms, internal HTTP.
4. Left unsupported official details for next user-operated bounded live validation rather than extrapolating current specifications from third-party code.

## Official entrypoints and data surfaces

| Official route     | Entry                                                                                                                                                                                  | Read data                                                                                                                                             | Automation role                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Yucho Direct Web   | [Official guide](https://www.jp-bank.japanpost.jp/direct/pc/dr_pc_index.html), [login](https://direct.jp-bank.japanpost.jp/tp1web/U010101SCK.do)                                       | Registered accounts, current/withdrawable balances, transactions/deposit details, unprinted passbook entries, collateral TEIGAKU/time details/results | **Primary**; combine CSV/HTML                                       |
| Direct Plus        | [Official guide](https://www.jp-bank.japanpost.jp/direct/pc/plus/dr_pc_pl_index.html)                                                                                                  | Up to 20-year history, passbook images, collateral-deposit maturity notices                                                                           | Best existing-subscription backfill; never switch during collection |
| Bankbook App       | [Official guide](https://www.jp-bank.japanpost.jp/app/app_tsucho.html), [Google Play](https://play.google.com/store/apps/details?id=jp.japanpost.jp_bank.bankbookapp)                  | Ordinary/savings balances/history, income-expense graphs, collateral TEIGAKU/time balances/details                                                    | Device-bound manual fallback/Web comparison                         |
| Authentication App | [Official guide](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_nshtouroku.html), [Google Play](https://play.google.com/store/apps/details?id=jp.japanpost.jp_bank.FIDOapp) | FIDO-compliant Web/app authentication, not financial data                                                                                             | Human bootstrap; collector must not imitate                         |
| Read APIs          | [Official policy](https://www.jp-bank.japanpost.jp/aboutus/activity/api/abt_act_api_houshin.html)                                                                                      | Balances, transactions, collateral TEIGAKU/time, overdrafts, fund details                                                                             | Ideal runtime; contracted electronic payment service providers only |
| ゆうID (Yu ID)     | [Japan Post linking policy](https://www.post.japanpost.jp/notification/pressrelease/2025/00_honsha/0616_01_01.pdf)                                                                     | Not currently confirmed as bank-statement login entry                                                                                                 | Future group-ID linking; distinct from Direct customer numbers/FIDO |

`ゆうID` is Japan Post Group's common ID; broader bank-account linking plans are public. However, official Direct/Bankbook procedures as of 2026-08-26 use `お客さま番号` (customer number), login passwords, account information, cash-card PINs, phone checks, and Authentication App. Do not use `ゆうID` as balance/statement collector credentials.

## Account enumeration and balance granularity

### Web

Direct permits up to 10 registered accounts per `お客さま番号` for combined management. Registration is a write, so Kogane enumerates only existing registrations. Complete coverage requires asking the user whether any own-name accounts are unregistered.

| Account/product                                      | Enumeration/balance unit                                                    | Statements                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 通常貯金 (ordinary deposits, comprehensive account)  | Registered account; current balance, transfer portion, withdrawable balance | HTML/CSV; unprinted-entry inquiry                                                    |
| 通常貯蓄貯金 (savings deposits)                      | Registered account; current/withdrawable balance                            | HTML/CSV; ineligible for Direct Plus switching                                       |
| 振替口座 (transfer account)                          | Current balance per registered account                                      | Transaction/deposit CSV up to 15 months; individual ordinary-payment images separate |
| 担保定額貯金 (collateral TEIGAKU deposits)           | Deposit account/details/deposit lot                                         | Deposit-status and transaction-result inquiries; CSV/PDF unconfirmed                 |
| 担保定期貯金 (collateral time deposits)              | Deposit account/details/deposit lot                                         | Deposit status, maturity treatment, results; CSV/PDF unconfirmed                     |
| Dedicated-passbook/certificate TEIGAKU/time deposits | Official FAQ excludes from Direct                                           | Do not expect Web/API enumeration                                                    |

Official balance-screen definitions:

- `現在高` (current balance): account balance; may be negative when using deposit-secured automatic loans.
- `うち振替現在高` (transfer-balance portion): comprehensive accounts only; amount exceeding autoswing thresholds transferred to non-interest-bearing transfer accounts.
- `引出可能残高` (withdrawable balance): comprehensive accounts only; includes current balance and available deposit-secured automatic credit.
- Unsettled checks, etc. and some transfer-account withdrawals are excluded from current balances. Separate `current_balance`/`available_balance`; do not estimate/correct unfinished amounts.

Collateral TEIGAKU/time deposits need a model separate from ordinary transactions. Candidate lot fields include source account, product type, detail identifier, deposit date, principal, maturity/holding period, rate, maturity treatment, and automatic-loan eligibility. Confirm exact fields live.

### Bankbook App

- Personal comprehensive ordinary/savings accounts only; no transfer/corporate accounts.
- Up to 2 same-name accounts. One account can register on multiple devices, but transaction authentication is active on one, with the most recently configured device taking precedence.
- App terms include current balances, transactions, income-expense graphs, collateral TEIGAKU/time details, and overdraft borrowing balances in registered-account inquiries.
- Gaps before app re-registration or completed Direct reapplication may be unavailable. Android→Android/cross-OS device changes do not carry over on-device statements/login methods.

## Transaction statements, artifacts, and retention

### Periods and counts

| Scope                                           | Screen period                                                                  | CSV period                                    | Count                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------ |
| Passbook comprehensive ordinary/savings account | Up to 2 months, from previous month's first day                                | Same                                          | 100 per screen retrieval; CSV up to 30,000 |
| Transfer account                                | Up to 15 months, from first day 14 months earlier                              | Same                                          | 100 per screen retrieval; CSV up to 30,000 |
| Direct Plus                                     | Up to 20 years, but from March 2021                                            | Same                                          | 100 per screen retrieval; CSV up to 30,000 |
| Unprinted passbook entries                      | Passbook comprehensive account, regardless of period                           | Not explicitly covered in public CSV material | Aggregated at 30 rows                      |
| Bankbook App                                    | Start depends on initial registration/Direct application/March 2021 conditions | App-only CSV unconfirmed                      | Public maximum displayed count unconfirmed |

Statements before Direct paper-application processing, or Web application time, are unavailable. Direct Plus through February 2021 also had a maximum 15 months. Twenty years means future retention of March 2021 onward, not 20 years already existing.

Screens show 100 rows per retrieval, with narrower periods allowing further checks. But over 100 transactions in a day leaves only the latest 100 visible, with excess unrecoverable on screen. CSV lacks this limit and supports up to 30,000, making it Kogane's primary artifact.

### CSV

- Rows output oldest first.
- One CSV per 3,000 rows, up to 10 CSVs, downloadable together as zip.
- Official FAQ defines `入出金明細ID` (transaction-statement ID) as **a sequence number within that output**, not a bank-wide stable transaction ID. Never use alone for cross-download deduplication.
- `詳細1`/`詳細2` split comprehensive-account screen `預入/支払内容` (deposit/payment contents) into types/counterparty names, etc.; transfer accounts correspond to `取扱種別/備考` (handling type/remarks).
- Older public guides exclude today/yesterday from CSV. Current HTML guides/FAQs are unclear, so compare live whether current CSV includes them.
- Public material does not establish encoding, full headers, amount signs, balance columns, account identifiers, or same-day ordering.

Provisional deduplication uses source, account pseudonym, transaction date, deposit/withdrawal amounts, details 1/2, same-day ordinal, and artifact hash. Use `入出金明細ID` only for same-artifact order checks, never as a persistent bank ID.

### Unprinted, aggregated, and pending entries

- Passbook comprehensive accounts can query unprinted entries regardless of period.
- Entries aggregate at 30 unprinted rows; individual rows may become unrecoverable from paper/screens. Collect periodic CSVs within the two-month window.
- Direct Plus/transfer accounts lack `通帳未記入分` (unprinted passbook entries) inquiry.
- Current balance excludes unsettled checks, but official material does not establish card-authorization-style `pending` rows in ordinary transactions.
- Transfers/payments and fees appear separately. Processing may reflect them after handling dates with different order than passbooks. Refetch short overlaps and allow source corrections rather than assuming immutability.

### PDFs, passbook images, and electronic delivery

| Artifact                                   | Scope                                  | Granularity                                                                                  | Kogane handling                                                  |
| ------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Transaction CSV                            | Ordinary/savings/transfer, Direct Plus | Structured rows, details 1/2, output-local IDs                                               | Primary transaction artifact                                     |
| Transaction HTML                           | Same                                   | Current balance, screen descriptions, recent 5/custom conditions                             | Balance/discovery and CSV checking                               |
| `通帳イメージ` (passbook image)            | Direct Plus only                       | Cover image with name, symbol/number, branch name/number, deposit type, account number, etc. | Manual account-metadata evidence, not transactions               |
| Transfer receipt/payment-notice PDF/images | Transfer-account notices/payment slips | Payer address/name/message fields, etc.                                                      | Outside ordinary personal-deposit MVP; separate source if needed |
| Electronic delivery                        | Mainly investment-trust documents      | Per-document search/display                                                                  | Not an ordinary-transaction replacement                          |

Direct Plus `通帳イメージ` is Web/display/print view; official guides do not describe PDF downloads. Browser printing can create PDFs, but do not label them bank-issued transaction-statement PDFs. Official ordinary/savings transaction PDF export was not confirmed publicly.

## Collateral TEIGAKU/time details and history

Official Web/Bankbook App confirms these for collateral deposits linked to comprehensive accounts.

- Deposit-status confirmation/change (detail inquiry)
- Transaction-result inquiry
- Collateral time-deposit maturity treatment
- Direct Plus emails around the 10th two months before maturity, with message-box details

Official `明細情報一覧` guides select redemption targets per deposit account/detail. This strongly supports current-lot enumeration, but retention of redeemed-lot results and combined export of current lots/past operations are unpublished.

Direct covers only **collateral** TEIGAKU/time deposits in comprehensive accounts. Do not include dedicated-passbook/certificate products in the same Web coverage. User holdings of these need separate paper/branch sources and are excluded from this PR's automation assessment.

## Authentication, device binding, and sessions

### Web login

Official guidance describes two routes.

1. **Normal login**: enter 13-digit `お客さま番号` in 4-4-5 groups and an 8–12-character login password. With login two-step authentication enabled, unregistered browsers additionally require email OTP.
2. **App login**: enter customer number to display a PC QR code; scan through Authentication App or transaction-authentication-enabled Bankbook App, authenticate by biometrics/app passcode, then return to PC login.

Email login two-step verification can skip later OTP after registering the current device/browser. App login and registered devices/browsers are also exempt. Persistent Chrome profiles help automation, but registration may depend on bank/session and browser storage; cookie-only reproduction is unconfirmed.

The bank states idle sessions time out but publishes no minutes, absolute lifetime, post-restart cookie reuse, concurrent-session behavior, or cross-session logout invalidation. Treat session cookies like password-equivalent bearer secrets; exclude from logs, Git, plaintext D1/KV/R2, and images.

### Authentication/Bankbook apps

- Authentication follows FIDO using credentials registered on smartphones.
- Initial Authentication App registration uses a code sent to the registered phone, login password, and biometrics/six-digit app passcode. One customer number cannot be simultaneously enrolled on multiple devices; the latest registration wins.
- Initial Bankbook registration uses account symbol/number, kana name, birth date, cash-card PIN, phone number, and five-digit confirmation code. Launch uses four-digit passcode, Android pattern, or biometrics.
- Bankbook permits multiple devices per account, but transaction authentication on one only.
- Enabling Bankbook transaction authentication switches from Authentication App/tokens and may be irreversible. Do not make this major settings change for collector validation.

The user has reported using passkeys stored in Bitwarden in the broader project context, but official Yucho FIDO procedures refer to **Authentication/Bankbook credentials registered on a smartphone**. Official procedures do not confirm Bitwarden WebAuthn passkey login. Whether the Yucho Bitwarden item instead contains ordinary customer number/password is also unconfirmed; do not assume passkey automation before live validation.

## API

The bank officially publishes these read APIs.

- `現在高照会` (current-balance inquiry)
- `入出金明細照会` (transaction-statement inquiry)
- `担保定額定期明細照会` (collateral TEIGAKU/time-deposit details)
- `口座貸越元金等照会` (overdraft principal, etc.)
- `投資信託明細照会` (investment-trust details)

Technically, retrieving accounts, ordinary ledgers, and TEIGAKU/time lots through one official surface approaches Kogane's ideal, avoiding browser HTML changes, CSV downloads, and Akamai edges and suiting Workers `fetch`. Conditions follow.

- Be a Banking Act electronic payment service provider meeting bank security/operational standards.
- Contract with Japan Post Bank for API access. No public developer token/sandbox for individuals' own accounts.
- User `サービス連携に関する同意` (service-linking consent) ends after 90 days; continued use requires renewed consent.

APIs can use the bank directly without aggregators, but Kogane must itself be the contracting entity. Retain as a future formal-service business/onboarding track, not a personal-MVP shortcut.

## Akamai, WAF, and anti-automation

### Confirmed facts

- DNS on 2026-08-26 resolved `www.jp-bank.japanpost.jp`, `direct.jp-bank.japanpost.jp`, and `direct3.jp-bank.japanpost.jp` to `edgekey.net` CNAMEs, confirming Akamai edge use.
- Public `www` returned Apache 200 to generic curl. `direct` had HTTP/1.1 20-second no-response timeouts and HTTP/2 stream errors. Normal browsers/crawlers retrieved official login pages, ruling out simple host outage.
- The bank requires JavaScript/Cookies, navigation through onscreen buttons, and official login entrypoints. It warns browser back/forward/bookmarked direct access may interrupt/break procedures.
- Idle sessions disconnect; concurrent app registration and Direct login across devices may cause security interruption errors.
- Official environments require connection through an ISP located in Japan.

### Inferences/unconfirmed

- `edgekey.net` establishes Akamai CDN, **not specific WAF/anti-bot product names or policies** such as App & API Protector/Bot Manager.
- Curl timeouts/HTTP2 errors may reflect edge policies, fingerprints, or network compatibility; do not treat them as confirmed bot detection.
- Headless/datacenter-IP/Cloudflare shared-egress blocking is unconfirmed.
- Authenticated passive capture is needed to establish JSON/internal API use alongside HTML forms or TLS/browser fingerprints in login decisions.

## Static inventory of public Yucho Direct Web

### Login forms and navigation transport

On 2026-08-26, displayed [official login](https://direct.jp-bank.japanpost.jp/tp1web/U010101SCK.do) unauthenticated in normal Chrome, checking only DOM attributes/public JavaScript, without reading values. Screens retain server-side HTML/Struts forms.

| Item                  | Public-screen finding                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Initial document      | `GET direct.jp-bank.japanpost.jp/tp1web/U010101SCK.do`                                                                                                                                                                   |
| Forms                 | `submitData` and `simpleTransitionForm`, both initially action `U010101SCK.do`, method `POST`                                                                                                                            |
| State/CSRF candidates | Hidden `org.apache.struts.taglib.html.TOKEN` and `event`; no token values retrieved/recorded                                                                                                                             |
| `お客さま番号`        | Three inputs `okyakusamaBangou1`/`2`/`3`; no values/autofill state read                                                                                                                                                  |
| Password login        | Button `U010103` sets `event=U010103`, submits `POST https://direct1.jp-bank.japanpost.jp/tp1web/pc/U010901BLC.do`                                                                                                       |
| App login             | Button `U010107` sets `event=U010107`, submits `POST https://direct1.jp-bank.japanpost.jp/tp1web/pc/U011101BLC.do`                                                                                                       |
| Smartphone navigation | `event=U010105` navigates to `https://direct1.jp-bank.japanpost.jp/tp1web/sp/U010101SCK.do`                                                                                                                              |
| App deep links        | Authentication App `fidoap.jp-bank.japanpost.jp/links/fido/...`, Bankbook same-host `links/banking/...`; both pass `redirect_uri=https://direct.jp-bank.japanpost.jp/tp1web/pc/U011401BLC.do` and `loginFuriwakeKubun=1` |

That day's public screen showed `QRコード読み取りによるログインを一時的に停止` (QR-code login temporarily suspended), directing users to password login or smartphone Direct. App-login routes in DOM/JavaScript do not prove PC QR login currently available. Recheck suspension on official screens during live validation.

Public `dcRequest(formName, url, names, values, alreadyClickControl)` sets events in hidden fields, replaces the form action with the argument URL, then calls `submit()`. Thus `.do` paths/`POST` alone cannot isolate reads/writes. After authentication, combine screen IDs, events, exact button labels, and response screens, allowlisting only live-confirmed reads.

`org.apache.struts.taglib.html.TOKEN` is a CSRF/page-state candidate, not proof of session issuance. App return to `U011401BLC.do` is confirmed; FIDO assertions, subsequent cookies, and session sharing with password/OTP flows are unconfirmed. Cookies, tokens, QR, and FIDO `rawdata` are excluded from observation.

### Public JavaScript and security/anti-fraud candidates

Hashed artifacts actually loaded by public login, without values. Hashes are 2026-08-26 snapshots, not stable API contracts.

| artifact                                        | SHA-256                                                            | static inventory                                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache.../run.js?rv=26051`                      | `8b3c4673af6cfeb824b14914e9821799f7fbda3bde947ada63833ff2d1154b31` | FIDO app launch helper; constructs `redirect_uri` and `loginFuriwakeKubun`                                                                                           |
| `cache.../dgbaRequestControllerP02.js?rv=26051` | `4d889649c218bde85ab1af95f9779b5cad73578d0033b85027018f4b41c4d647` | Public-page request/UI controller                                                                                                                                    |
| `directcss.../HcFwEhqexk.js`                    | `3fca08de3ca3293ea490d557d7bae615f4a09916d36fce2bf06e2f157663f876` | Candidate loader with `sendBeacon`/XHR, device/token/AES terms; role/vendor undetermined                                                                             |
| `directacct.../aes.js`                          | `fc7e184beeda61bf6427938a84560f52348976bb55e807b224eb53930e97ef6a` | Public AES implementation; target fields unconfirmed                                                                                                                 |
| `directacct.../load.js`                         | `f8bf373263f5a240e0233345e28bc19c5c56119115d936197d3cc13b3fa8756d` | Beacon/XHR, device/token/encrypt/decrypt candidates                                                                                                                  |
| `directacct.../dl.js`                           | `8948fc815424bd77a7692f64b2b8e488295dff14ab2963798e22088a74fdec5b` | Loader                                                                                                                                                               |
| `directss.../ig.json`                           | `0d7c95ddd386ea08185249944e82fa26ee0965bdd13482b46e42baf09b2733c3` | Bootstrap calling `pwc_loadpljs`                                                                                                                                     |
| `directss.../js/r.js?ver=21&rev=826202611`      | `aaa4679b3b76bfaf83374efe520289d2ccc1752a1c18f20855b9529c2d61cf95` | Obfuscated instrumentation candidate with page IDs, FIDO/token, screen/window, localStorage/cookie UUID, public-key encryption, `dcRequest` hooks, XHR/JSONP symbols |

Public page load alone loaded `/akam/13/198d305`, GET then POST to a same-origin dynamic path, and CORS preflight/POST to `directss.jp-bank.japanpost.jp/d`. No bodies, headers, Cookies, tokens, or fingerprint values were retrieved/replayed. Strong Akamai-sensor/behavioral-fraud-telemetry candidates; distinguish specific vendors/products, collected fields, and decision policies from confirmed facts.

### Read coverage established publicly

Public login established pre-auth transport only. Official guides confirm balance/transaction/CSV/collateral-deposit features, but public pages did not reveal authenticated read endpoints/events/HTML-JSON schemas/CSV-generation requests. `U010901BLC.do` and similar are login transitions, never reused as balance/statement reads. In user-operated read-only runtime observation, discard values and inventory only the following.

- Page title, form name, event/button label, method, host, path template, status, content-type
- Whether balance/statement/CSV/fixed-deposit screens use HTML navigation, XHR/JSON, or downloads
- Session issuance/refresh differences among password/app login and registered browsers
- Writes such as sending/payments/TEIGAKU-time deposits/redemptions within the same endpoint/event families

## Android APK and static analysis

### Official packages, versions, and provenance

Checked official Google Play HTML directly on 2026-08-26.

| App                                                                                                  | Package                            | Version/Play update     | Read/auth role                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------- |
| [ゆうちょ通帳アプリ](https://play.google.com/store/apps/details?id=jp.japanpost.jp_bank.bankbookapp) | `jp.japanpost.jp_bank.bankbookapp` | `21.0.0` / `2026-04-10` | Balances, transactions, collateral deposits, up to 2 accounts; adjacent transaction functionality |
| [ゆうちょ認証アプリ](https://play.google.com/store/apps/details?id=jp.japanpost.jp_bank.FIDOapp)     | `jp.japanpost.jp_bank.FIDOapp`     | `18.0.0` / `2026-04-09` | No financial data; device FIDO for Direct login/transactions                                      |

No standalone APK distribution from bank sites was confirmed. Do not acquire from third-party mirrors: package/version displays do not guarantee legitimate splits or signer provenance. This environment lacked a managed Android with Google Play installation, `adb`, `apksigner`, `bundletool`, `jadx`, `apktool`, `aapt2`, and MobSF, so no binary was obtained. Docker alone cannot create Play entitlement, device-specific splits, or signing provenance.

Play HTML establishes only package/versionName/update date. Confirm versionCode, base/split structure, signer digests, APK hashes, ABI/density/language splits, and rollout variants after legitimate artifact acquisition.

### Legitimate split-APK acquisition/signature checks

After normal Google Play installation on user-controlled Android, run outside the repository in encrypted temporary storage.

```bash
for PKG in jp.japanpost.jp_bank.bankbookapp jp.japanpost.jp_bank.FIDOapp; do
  adb shell dumpsys package "$PKG" | rg 'versionName|versionCode|firstInstallTime|lastUpdateTime|signingInfo'
  adb shell pm path "$PKG"
  mkdir -p "artifact/$PKG"
  while IFS= read -r LINE; do
    REMOTE=${LINE#package:}
    adb pull "$REMOTE" "artifact/$PKG/$(basename "$REMOTE")"
  done < <(adb shell pm path "$PKG")
done

sha256sum artifact/jp.japanpost.jp_bank.bankbookapp/*.apk
sha256sum artifact/jp.japanpost.jp_bank.FIDOapp/*.apk
for APK in artifact/jp.japanpost.jp_bank.bankbookapp/*.apk artifact/jp.japanpost.jp_bank.FIDOapp/*.apk; do
  apksigner verify --verbose --print-certs "$APK"
done
```

Verify matching signer digests across base/splits per package; do not assume both apps share a signer. Provenance records retain only package, versionName/versionCode, split names/hashes, signer certificate SHA-256, acquisition time, and Play-install device. Never upload APK/decompiled code to Git/third-party clouds.

### Manifest, hosts, schemas, and session/security inventory

```bash
jadx -d jadx-bankbook artifact/jp.japanpost.jp_bank.bankbookapp/*.apk
jadx -d jadx-fido artifact/jp.japanpost.jp_bank.FIDOapp/*.apk
apktool d -f artifact/jp.japanpost.jp_bank.bankbookapp/base.apk -o apktool-bankbook
apktool d -f artifact/jp.japanpost.jp_bank.FIDOapp/base.apk -o apktool-fido
aapt2 dump xmltree artifact/jp.japanpost.jp_bank.bankbookapp/base.apk AndroidManifest.xml
aapt2 dump xmltree artifact/jp.japanpost.jp_bank.FIDOapp/base.apk AndroidManifest.xml
rg -a -n 'https?://|wss://|jp-bank|direct[0-9]?|fidoap|redirect_uri|loginFuriwakeKubun|rawdata|okhttp|retrofit|webview|cookie|session|token|bearer|fido|webauthn|keystore|biometric|integrity|attestation|safetynet|certificate|pin' jadx-bankbook jadx-fido apktool-bankbook apktool-fido
```

Separate the static inventory as follows.

- Manifest: exported components, permissions, intent filters, custom schemes/app links, Android/ABI targets, backup/debuggable/profileable, network security config
- Inter-app integration: Authentication/Bankbook package checks, `fidoap` deep links, `redirect_uri`, `loginFuriwakeKubun`, FIDO `rawdata` generation/handoff boundaries
- Transport/schema: host/path constants, WebView/native, OkHttp/Retrofit, methods, serializers/models, balance/statement/fixed-deposit response fields, CSV/download presence
- Session: server issuance/refresh, cookie/token storage, Android Keystore/EncryptedSharedPreferences, reinstall/device-change invalidation; no secret extraction
- Security: FIDO libraries/profiles, biometric keys, Play Integrity/SafetyNet/attestation, root/debug/instrumentation detection, signature self-checks, pinning candidates; do not modify detection/decisions

R8/ProGuard/string-encryption deobfuscation and static URL-builder/serializer data-flow tracing are in scope. Do not extract actual FIDO private keys, biometric templates, account identifiers, cookies/tokens, or cached statements. Static analysis alone does not establish response schemas/session issuance.

### User-operated read-only runtime metadata observation

1. Use legitimately installed, already registered devices; no new/re-registration or transaction-authentication switching.
2. The user normally opens only current balances, transactions, existing collateral TEIGAKU/time details in Bankbook. No transfers, payments, deposits, redemptions, addresses/phones, limits, or Direct Plus switching.
3. Record only DNS/SNI, host, method, path template, status, content-type, field names. No body/header values, Cookies, tokens, FIDO assertions/QR/rawdata, accounts/balances/descriptions.
4. Use local proxies only if the app normally accepts user-installed CAs. On pinning/integrity/FIDO errors, return to encrypted metadata/static analysis without patch/hook bypasses.
5. Limit tracing to read-screen URL builders, OkHttp metadata, serializer/model fields, WebView navigation. Never hook certificate verifiers, trust managers, FIDO/Keystore, or integrity verdicts.
6. The user approves only existing logins in Authentication App; observers see only launch/return hosts/statuses. No credential registration, eKYC, transaction authentication, or transaction-code settings.
7. Compare the same short Web/app period without values: account counts, current/available balance fields, statement counts/fields, collateral-deposit lot coverage. Recheck absent official app CSV export in UI too.

Frida/Objection tracing itself is not excluded, but only passive read-serializer observation in environments where legitimate apps normally launch. Stop when root, Gadget injection, signature repacking, anti-instrumentation disabling, or pinning/integrity/FIDO bypass becomes necessary.

## Third-party clients

| Implementation                                                                                                                                    | Last update/period                              | Method                                                                                                                                 | Current handling                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`kkosuge/bank_job`](https://github.com/kkosuge/bank_job/blob/0908e082d4c196a0fc8335351855874eb88b1549/lib/bank_job/strategies/bank_job_yucho.rb) | Implementation commit 2014                      | Ruby Mechanize sends 4-4-5 customer number/security phrase/password from `U010101SCK.do` through HTML forms, parses transaction tables | Before security-phrase retirement; no current-functionality evidence |
| [`toc/pogact`](https://github.com/toc/pogact/blob/83c82ef99197c960a4d22ad127dfa14a78a393e8/pogact/RPAbase/JPBankBase.py)                          | Repo updated 2024; JPBank code uses old screens | Selenium enters customer number/security phrase/password, skips PhishWall guidance                                                     | Browser-method reference; lacks current auth/app login               |
| [`pocke/japan-post-bank-login`](https://github.com/pocke/japan-post-bank-login)                                                                   | 2016                                            | Chrome extension autofills three customer-number fields                                                                                | Login helper, not statement client                                   |
| [`shinichy/get_statement`](https://github.com/shinichy/get_statement/blob/master/get_statement.py)                                                | 2018                                            | Python Selenium downloads company CSV/PDFs                                                                                             | No Yucho implementation or JP Bank in supported list                 |

Old `bank_job` is an HTTP client with cookie jars, not a browser. It extracts form actions/events from JavaScript `onclick` and parses HTML tables, establishing historical stateful server-side HTML rather than JSON APIs. Current login removed images/security phrases and added app FIDO/email 2FA; do not reuse endpoint/field names.

No bank-only OSS client, official SDK, or personal API wrapper claiming current support was found. Discovered household-finance/accounting integrations are aggregators contracting for bank read APIs, excluded as implementation candidates.

## Runtime suitability

| Platform                              | Suitability                                      | Reason                                                                                                                    |
| ------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| User-controlled normal Chrome/Kuebiko | **High**                                         | Legitimate browsers, registered devices, app QR, human auth, CSV downloads; best initial observation/MVP                  |
| Cloudflare Workers                    | Browser login **low**, API/orchestrator **high** | Cannot run browser/app/FIDO; Japanese ISP/shared-egress issues. Ideal HTTP collector after formal API contract            |
| Cloudflare Containers                 | **Medium**                                       | Playwright/Chrome/downloads possible; persistent profiles, human app QR, Akamai, overseas/variable egress need checks     |
| OCI VM/Container (Tokyo/Osaka)        | **Medium–high**                                  | Easier Japanese regions, fixed disks, normal Chrome, encrypted downloads; login/ISP compliance require live checks        |
| OCI Kubernetes                        | **Medium**                                       | CronJobs, secret isolation, persistent volumes; excessive for device-bound single-account collection; prevent concurrency |

Workers alone cannot handle stateful HTML/browser CSV downloads or device FIDO. Containers are technically possible, but official environments require an ISP located in Japan; do not adopt overseas egress such as Sydney. Stable guaranteed Cloudflare Japanese egress is also unconfirmed.

Persistent OCI Tokyo/Osaka VMs/containers most realistically support cloud browsers with normal profiles. Do not interpret cloud datacenters as satisfying bank ISP requirements; perform one bounded login and support/terms confirmation. Defer Kubernetes until a shared browser runtime across multiple sources is needed.

## Recommended architecture

1. Open official login in a user-controlled normal Chrome profile. Reuse valid existing sessions; request human password/app-QR login only on expiry.
2. Initially use Kuebiko passive authenticated read-only capture, opening only home, current balances, transactions, CSV downloads, collateral-deposit detail lists; no write forms.
3. Save CSV as primary transaction artifacts, balance HTML/JSON, collateral-deposit HTML/JSON lots, and Direct Plus passbook images as account-metadata evidence.
4. Encrypt source-scoped session envelopes; do not pass customer numbers/passwords, app auth keys, or Bitwarden vaults to collectors. Stop on login redirects/timeouts/401/403 without automatic credential-login retries.
5. One active run per source; no concurrent app registration/Web login. Workers handle schedules, leases, encrypted artifacts, R2/D1 metadata; browsers run locally or on validated OCI.
6. Refetch overlapping passbook-account CSVs about weekly rather than monthly to preserve two-month windows. Direct Plus can be monthly, still refetching the same period to detect corrections/order changes.
7. Evaluate electronic payment service provider adoption separately only when formal API-contract business requirements arise.

## Next bounded validation

All checks use the user's own accounts read-only, saving only sanitized field names/types/counts/shapes, not values.

1. Check existing Chrome tabs/profiles and auth state at official URLs.
2. Determine only whether the reported Bitwarden item provides normal password fill, passkey prompts, or is inapplicable. Record no secrets, customer numbers, or vault-item IDs.
3. One user login checks normal password/email 2FA/app-QR flow. No auth-setting changes or repeated failure attempts.
4. From home/registered accounts, check account types, masked identifiers, current/transfer/withdrawable fields, paging across up to 10 accounts, and own-name accounts outside registration.
5. Retrieve the same short period once each as HTML/CSV; compare encoding, headers/all columns, signs, same-day order, `入出金明細ID` restart, today/yesterday inclusion, balance columns, paging below 30,000 rows.
6. Only if unprinted entries exist, check counts/aggregate-row shapes; no passbook printing/settings.
7. With existing Direct Plus, check one old month's CSV/passbook-image display. Otherwise do not switch; confirm only official maximum-20-year specifications.
8. Only if collateral TEIGAKU/time holdings exist, open `明細情報一覧` and transaction results; check current-lot fields, historical counts/periods, CSV/PDF presence. Do not press deposit/redemption/change buttons.
9. Passively classify authenticated server-side forms, XHR/JSON, CSV generation/download request families. Save no auth bodies, Cookies, FIDO payloads, or anti-bot telemetry.
10. For 7 days, once daily on the same persistent profile, retrieve only home/short statements to measure reuse, idle/absolute expiry, Akamai/concurrency errors, rate limits.
11. Only after stable local Chrome, try the same read-only flow once in persistent OCI Tokyo Chrome, checking Japanese ISP requirements/additional auth/blocks. Compare Containers afterwards.
12. Once managed Android with legitimate Google Play installation is available, retrieve Bankbook 21.0.0/Authentication 18.0.0 base/all splits; check package/versionCode/signer/hash before static inventory.
13. The user operates Bankbook read screens and existing Authentication App login once; observe host/method/path template/status/content-type/field names without values. Compare Web/app coverage/sessions.
14. Limit tracing to read URL builders/serializers/WebViews, without hooking pinning/integrity/FIDO/Keystore decisions. Stop without bypass when instrumentation/root/CAs are rejected.

Success means reproducible stable pseudonymous identifiers across registered accounts, current balances, incremental CSV, collateral-deposit lots, raw hashes, without write screens. Stops include auth-setting changes, repeated cash-card PIN/OTP requests, account locks, app re-registration, root/pinning bypass, or signs of service suspension.

## Confirmed, inferred, and unconfirmed

### Confirmed

- Official Web provides ordinary/savings/transfer balances/transactions and collateral TEIGAKU/time details/results.
- Passbook comprehensive accounts 2 months; transfer 15 months; Direct Plus up to 20 years from March 2021.
- CSV 3,000 rows/file, up to 10 files/30,000; screens 100 per retrieval.
- CSV `入出金明細ID` is output-local sequence; `詳細1`/`詳細2` split screen descriptions.
- Unprinted entries aggregate at 30 rows; Direct Plus/transfer accounts lack this inquiry.
- Bankbook up to 2 accounts; Authentication App one device per customer number; FIDO-compliant.
- Read APIs provide balances/transactions/collateral deposits, etc.; consent renews after 90 days.
- `www`/`direct`/`direct3` resolve to Akamai `edgekey.net`.
- Public login uses Struts-token/event HTML forms, separate password/app `.do` endpoints on `direct1`; app returns through `fidoap` to `U011401BLC.do`.
- Public login loads telemetry POSTs to Akamai-style dynamic paths/`directss`; no body values retrieved.
- Official Android packages are Bankbook 21.0.0 and Authentication 18.0.0, distributed through Google Play.

### Inferences

- CSV collection is likely automatable after human bootstrap in registered persistent Chrome.
- Authenticated flows may retain historical stateful forms alongside current XHR/internal APIs.
- Persistent OCI Tokyo browsers may need less additional auth than overseas/shared Cloudflare egress.
- Bankbook local caches retain statements, but Web CSV is more stable as the primary cloud route.

### Unconfirmed

- Which user account types exist: passbook, Direct Plus, savings, collateral TEIGAKU/time.
- Whether reported Bitwarden passkeys apply to Yucho; official WebAuthn/passkey-login presence.
- Idle/absolute lifetimes, post-restart reuse, concurrency, logout invalidation.
- Current CSV columns/encoding/today-yesterday/stable balances and actual corrections/duplicates.
- Exact collateral-deposit fields, historical retention/export.
- Authenticated HTML-form versus JSON endpoints and shared app/Web backends.
- Akamai WAF/bot products, headless/datacenter decisions, Cloudflare/OCI login.
- Bankbook/Authentication versionCode, splits, signers, hosts/paths/schemas, session issuance, WebView/native boundaries, FIDO profiles, pinning/integrity, local DB schemas/encryption.
- Timing/method of Yu ID integration into bank-statement login.

## Main evidence URLs

- [Yucho Direct public login](https://direct.jp-bank.japanpost.jp/tp1web/U010101SCK.do)
- [Yucho Direct services/hours/environments](https://www.jp-bank.japanpost.jp/direct/pc/service/dr_pc_sv_index.html)
- [Current-balance fields](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=2)
- [Transaction inquiry periods](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=96)
- [CSV periods/maximum 30,000](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=59)
- [CSV download procedure](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=134)
- [CSV transaction-statement ID/detail 1/detail 2](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=132)
- [100 screen rows/30,000 CSV rows](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=17)
- [Transaction guide](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_meisai.html)
- [Direct Plus](https://www.jp-bank.japanpost.jp/direct/pc/plus/dr_pc_pl_index.html)
- [Passbook-image guide](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_bankbookimage.html)
- [Collateral TEIGAKU/time procedures](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=25)
- [Collateral TEIGAKU/time detail list](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_ttharaimodosi_sp.html)
- [Yucho Bankbook App](https://www.jp-bank.japanpost.jp/app/app_tsucho.html)
- [Bankbook usage caveats](https://www.jp-bank.japanpost.jp/app/app_goriyo.html)
- [Bankbook history start date](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=10051)
- [Bankbook multiple devices](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=2837)
- [Bankbook device changes](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=10671)
- [Web login security/FIDO/two-step authentication](https://www.jp-bank.japanpost.jp/direct/pc/security/dr_pc_sc_ds_drsecurity.html)
- [Normal password login](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_normalloginguide.html)
- [PC login with Authentication App](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_nshlogin.html)
- [PC login with Bankbook App](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_tchlogin.html)
- [Authentication App initial registration](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_nshtouroku.html)
- [Read-API coverage](https://www.jp-bank.japanpost.jp/aboutus/activity/api/abt_act_api_houshin.html)
- [API access standards](https://www.jp-bank.japanpost.jp/aboutus/activity/api/abt_act_api_kijun.html)
- [90-day API consent](https://www.jp-bank.japanpost.jp/direct/pc/drnews/2024/drnews_id000137.html)
- [Electronic payment service provider contracts](https://www.jp-bank.japanpost.jp/aboutus/activity/api/abt_act_api_keiyaku.html)
- [Google Play: Bankbook App](https://play.google.com/store/apps/details?id=jp.japanpost.jp_bank.bankbookapp)
- [Google Play: Authentication App](https://play.google.com/store/apps/details?id=jp.japanpost.jp_bank.FIDOapp)

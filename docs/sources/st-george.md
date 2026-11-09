# St.George Bank Australia source research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26 (Australia/Sydney)

## Collector integration (2026-09-13)

The runnable service is now [`services/collector-st-george`](../../services/collector-st-george/README.md).
It follows Kogane's existing browser-container, shared DATA terminal, Processor
registration and parser paths. A normal form login is followed by bounded
portfolio/account-details GETs for the observed accounts. The existing local PoC
remains available for diagnostics; there is no dependency from the deployed
service on the experiment.

Tamia is the explicit default egress, using the existing tunnel through an
authenticated, host-restricted TCP relay. Direct container egress is a separate
configuration; a rejection never automatically switches paths and retries login.
With the user's PC back on WARP, a public login GET executed on Tamia returned
HTTP 200 with all three expected login controls. This confirms Tamia reachability,
not authenticated operation of the new cloud container. No WARP or tunnel setting
was changed.

The minimized JSON DOM capture contains stable hashed account identities,
current/available balance text and the canonical `#transaction-all` rows.
Opening/closing balance rows are preserved separately. The same extractor and
strict validator successfully processed the private live capture offline:
two portfolio accounts and one matching account-details capture, with 22 real
transaction rows. The observation parsers produced two balance metrics and 22
transaction observations for that captured account, without publishing values or
raw HTML. Alternate date-tab tables are not combined.

A successful bounded acquisition is distinct from complete history coverage.
The balance parser can establish complete extraction of the captured balances;
transaction history remains partial, with unverified pagination, populated
pending rows, custom date ranges and unattended cloud authentication. AUD is an
explicit source configuration, not an observed DOM currency label.

The Durable Object serializes attempts and records uncertainty before bank I/O.
Only a refused, challenged or unrecognised login (`login-rejected`,
`authentication-challenge`, `human-required`, and `http-denied`,
`bank-request-error` and `unexpected-route`, any of which may be how the bank
answers a wrong password) pauses later logins (2026-11-08 UTC; before that every
failure blocked until an operator resume). The pause ends by itself when the
credential secret changes, or for one login on an operations-API collection
request, at most once per 24 hours; there is no resume step
([ADR 0069](../adr/0069-collector-admin-retirement.md#retirement-of-the-last-two-admin-routes-2026-11-08)). What the
bank showed when a run failed (stage, exception type, route refusal, login POST
count and its redacted visible notices) is kept in that failed run's manifest
([collector README](../../services/collector-st-george/README.md)). Every other failure is a
failed run and the next run tries again, including a collection its lease
holder stopped ([ADR 0085](../adr/0085-collection-lease-heartbeat.md)): its
failed run keeps the reason `deadline-exceeded` (the 13-minute deadline) or
`collection-interrupted` (the lease was lost). A refused lease answers `busy`
and records no run. Pending
validated evidence is retained in bounded chunks until the shared terminal is
verified, so storage retries do not repeat authentication. Credentials, cookies,
hidden form state and raw capture bodies never enter this state or Git.

The service is registered for repository CI and the existing release workflow.
PR #214 merged and the Worker secrets were provisioned out of band. The original
release (34747193708) uploaded the Worker but its public health postcheck returned
HTTP 404. Later release 36123890722 at `c246de9` passed both public and authenticated
health gates. On 2026-09-26, a fresh health check returned HTTP 200, the active
source/ingest route and migration 0046 were present, and no St.George collection
had yet been registered.

The first authenticated administrative POST returned `no-parameters-accepted`
before any bank request: an empty incoming POST can still expose a body stream.
The request guard was then changed to check for actual bytes. That route and its
guard were removed on 2026-11-08
([#1131](https://github.com/risu729/kogane/pull/1131),
[ADR 0069 amendment](../adr/0069-collector-admin-retirement.md#retirement-of-the-last-two-admin-routes-2026-11-08)):
public HTTP now offers `GET /health` and the authenticated `/tcp` relay, and
every other request answers 404.

The Worker has no Cron trigger. Since
[#430](https://github.com/risu729/kogane/pull/430) (2026-10-05) the Processor's
alarm job `st-george` (06:35 JST, `35 21 * * *` in `config/alarm-jobs.json`,
enabled) calls its private `ScheduledCollection` entrypoint
([schedules](../schedules.md)). Whether an authenticated cloud collection and
downstream publication have succeeded is not recorded here.

For `http-denied`, `bank-request-error` and `unexpected-route`, a validated
`loginPostCount: 0` with a stage before the login click means the failed run
does not pause the next scheduled login. One or more observed POSTs, a stage
from the click on, or a missing diagnostic keep the pause.
Explicit login refusals and challenges always pause; an existing stored pause
has no diagnostic and keeps its conservative handling
([operations](../../services/collector-st-george/README.md)).

## Automation PoC (2026-09-13)

An isolated runnable browser experiment now lives in
[`experiments/st-george-automation`](../../experiments/st-george-automation/README.md).
It navigates the existing Internet Banking portfolio and one observed account link;
it does not import CSV/PDF files or connect to production ingestion. Local tests use
synthetic pages. A normal live browser login succeeded on 2026-09-13 after the
user disconnected WARP. Pagination and session renewal still require validation;
a successful login alone is not complete transaction collection.

For live request/response discovery, use the existing **kogane capture / Kuebiko**
Chrome profile before authentication. The user explicitly requested Kuebiko network
capture for this PoC. Raw capture files can contain credentials, cookies and account
data and must remain in the private local Kuebiko capture directory, outside Git.
Only minimized route/schema findings belong in this document. An include filter
alone does not scope NetLog or storage snapshots: a narrowly scoped capture also
needs `--no-netlog` and should omit storage snapshots/tracking. This user-authorized
capture workflow is an exception to the original metadata-only research boundary
below, not permission to publish raw evidence or change banking settings.

### Live Kuebiko result and network constraint

On 2026-09-13, normal Windows Chrome in the existing Kuebiko capture reached the
bank edge, but initially did not reach an authentication form. The first captured
St.George responses were:

| Request                       | Status | Observed response                                                                   |
| ----------------------------- | ------ | ----------------------------------------------------------------------------------- |
| `GET /ibank/loginPage.action` | 200    | HTML headed `Request error`, with a VPN/TOR connection note; zero forms and inputs. |
| Favicon GET                   | 403    | HTML access-denied response.                                                        |

Both response bodies were captured locally. These initial attempts had no login
POST or authenticated account evidence. Header names included
`akamai-grn` and `server-timing`, consistent with the previously observed Akamai
edge. No header values, IP addresses, reference numbers, credentials, cookies, or
raw bodies are included here.

Cloudflare WARP was connected during the rejected attempts. After the user
personally disconnected it and the Windows client reported `Disconnected`,
reloading the same login URL in the same Kuebiko Chrome tab returned HTTP 200 with
normal Internet Banking Logon HTML: one form and the three expected credential
controls. This provides strong evidence of a **WARP/network-path-dependent
rejection** in this environment. It does not reveal the bank's exact rule or
distinguish egress reputation from other network-path signals. The agent did not
change network protections.

The current public login controls were verified from the captured normal page:

| ID                  | Name             | Type     |
| ------------------- | ---------------- | -------- |
| `access-number`     | `userId`         | text     |
| `securityNumber`    | `securityNumber` | password |
| `internet-password` | `password`       | password |
| `logonButton`       | `Login`          | submit   |

The form is `#logonAction`, named `logonForm`, with
`POST /ibank/logonActionSimple.action`. Only names and structure are recorded;
obfuscated hidden values are not reusable credentials or an established direct
login protocol. A normal login form is reachability evidence, not authenticated
collection success. Captured public scripts confirm security-number/password
mapping on blur or Enter, and device-print/duplicate-submission handling on the
Logon button. Authentication must use the normal browser controls; a guessed
POST, direct `form.submit()`, or replay of mapped payloads omits or reuses
page/session-dependent state.

After connectivity recovered, the normal form login succeeded in Kuebiko Chrome.
The authenticated My Accounts heading and Logout link appeared, and the login
inputs disappeared. No additional authentication or device enrollment appeared
in this session. This establishes one successful browser login, not unattended
renewal or a stable direct-login API.

A live PoC run then completed the guarded portfolio GET. It observed two
`#acctSummaryList > li` account cards with current and available balance fields.
The current `h2 a` links use `javascript:viewAccountDetails` with one literal
`/ibank/accountDetails.action` URL and an `index` query key. The captured function
only guards duplicate navigation and assigns `document.location.href`; it does
not submit a form. The initial PoC correctly stopped at this unfamiliar wrapper.
The adapter extracts only this strict literal form and performs the same guarded
GET without evaluating JavaScript or logging the query value. The adapted live
run completed successfully: portfolio metadata was observed again and the first
account-details GET reached the expected route with `#transHistExport` present.
Its three visible tables and three generic body rows are structural counts, not
a verified transaction count. No export control was clicked.

The captured account-details response was HTTP 200 server-rendered HTML. It
confirmed `#transHistExport`, `#txnHistoryTable`, text date controls
`#acctDetDateFrom[name=dateFrom]` and `#acctDetDateTo[name=dateTo]`, and debit/credit
and amount filters. Duplicate table IDs and hidden alternate layouts prevent
generic row counts from establishing transaction semantics or completeness.
Dispute forms are also present; no form or filter submission was attempted.
Pagination, date coverage, pending/posted reconciliation and session renewal
remain unverified.

The PoC now classifies the visible bank error as `stopped / bank-request-error`
even when the document returns HTTP 200. A synthetic regression verifies that it
cannot be mistaken for login or portfolio success and initiates no further
navigation. The experiment's 15 browser tests / 63 assertions and TypeScript check pass.

## Conclusion

St.George Bank personal accounts are **not app-only**. Both official Internet Banking and the St.George App handle account balances, transaction history, cards, loans, eStatements, and Proof of Balance/Transaction Listing PDFs. App-specific features include Quick Balance, Spend Tracker, push notifications, Digital Card, and Security Wellbeing Check. A physical Android device is not essential for balance/statement collection itself.

The common rubric's primary personal-data collection rating is **C / cost 4**. A 2026 public third-party implementation demonstrates CDP connection to the user's already-authenticated Chrome and DOM reads of account cards/balances. An older Puppeteer implementation downloads CSVs from Internet Banking date-range searches. This research also statically formatted current public login JavaScript, confirming dynamic form state, credential-character substitution, device prints, remote-access probes, and BioCatch behavioral telemetry/session start/resume/reset. However, authenticated read-route pagination, banking-session renewal, and stable APIs remain unconfirmed, with adaptive authentication and an Akamai login edge. This is therefore not B.

The safe initial operational default is **E / cost 1**, importing PDFs the user obtains through official screens. Public Product APIs are **A / cost 1** but return only products, not personal balances/statements. Personal-data CDR APIs are **A / cost 5** as a protocol, but require ACCC accreditation/sponsorship, CDR Register onboarding, certificates, conformance, and ongoing security/privacy operations. They are not a shortcut for a small personal collector.

## Scope and boundaries

- This document covers only **St.George Bank Australia** (`stgeorge.com.au`, official Android package `org.stgeorge.bank`).
- St.George is legally a division of Westpac Banking Corporation, but do not reuse Westpac-brand, BankSA, Bank of Melbourne, or RAMS screen/API/app behavior as St.George evidence.
- The St.George Product API page has an apparent template inconsistency: "Bank of Melbourne currently offers". Use St.George's official page, `digital-api.stgeorge.com.au`, CDR Register brand entry, and response `brand: St. George Bank` as evidence; do not infer sister-brand features from that sentence.
- Business Banking Online, PayWay, PaymentsPlus, and merchant APIs are separate products. Do not count their CSV/report/API features as personal Internet Banking capabilities.
- Research/future validation is read-only. Do not retrieve/save/log Customer Access Numbers (CAN), security numbers, passwords, OTPs, cookies/tokens, account numbers, names/addresses, balances, or transaction contents. No transfers, payments, account transfers, card operations, account-setting changes, or CDR consent creation/amendment/revocation.
- Reverse engineering, public-JS formatting/deobfuscation, legitimate Play-split static analysis, and user-operated read-only runtime metadata tracing are in scope. Prohibited activities are write endpoints, saving secrets/PII/bodies, disabling certificate pinning, root/emulator/integrity concealment, attestation spoofing, repacking/re-signing, and similar security-control bypasses.

## Objects confirmed in official screens

| Object                 | Officially confirmed scope                                                                                                                                         | Caveat                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transaction / savings  | Dashboard balances, recent transactions, transaction history, eStatements, Proof of Balance/Transaction Listing                                                    | Proof PDFs contain names/addresses/account numbers/balances; never put them directly in logs                                                                                                                  |
| Debit / credit cards   | Balances/statements, pending/confirmed card transactions, credit-card eStatements                                                                                  | Pending authorization is not a finalized transaction. Digital Card/dynamic CVV are app-only and excluded                                                                                                      |
| Home loans             | Rates, terms, repayment frequency, balances, Available funds, eStatements in app Details/Internet Banking Account details                                          | Joint/offset accounts, etc. may not support eStatements. Closed-loan statements unavailable online                                                                                                            |
| Personal loans         | App loan-account Details, personal-loan eStatements                                                                                                                | Public explanations do not establish all Web/app field granularity                                                                                                                                            |
| Term deposits          | Select accounts in Internet Banking/App to manage maturity notices and renewal/redemption instructions                                                             | Balance display is strongly suggested by general portfolio descriptions and "select your Term Deposit", but personal-screen field names are unconfirmed live. Maturity instructions are writes and prohibited |
| Product reference data | Public CDR Product API covers transaction/savings, term deposits, credit cards; actual responses also include residential mortgages, personal/business loans, etc. | Not customer-held accounts, balances, or transactions                                                                                                                                                         |

[Internet Banking](https://www.stgeorge.com.au/online-services/internet-banking) describes balances, recent transactions, and transaction history as shared Web/app features. [Mobile Banking](https://www.stgeorge.com.au/online-services/mobile-banking) explicitly identifies app-only features; basic balances/statements are not app-only. [Home loan management](https://www.stgeorge.com.au/personal/home-loans/manage) and [Term Deposit management](https://www.stgeorge.com.au/personal/bank-accounts/term-deposits/manage-online) also confirm accounts appearing in Web/app.

### Pending versus posted

The [Pending transactions FAQ](https://www.stgeorge.com.au/online-services/internet-banking/faqs/pending-transactions) says credit/debit purchases reduce available funds at authorization, remain pending for up to 7 days, and become fully processed at merchant settlement. [Look Who's Charging](https://www.stgeorge.com.au/online-services/mobile-banking/look-whos-charging) shows merchant names, logos, addresses, phone numbers, websites, and map locations for confirmed and pending transactions in the app. Collectors must not deduplicate pending/posted early as one transaction; preserve at least `status` and stable-transaction-ID presence for reconciliation.

CDR transaction schemas also represent `PENDING`/`POSTED`, with `transactionId`, `isDetailAvailable`, type, description, posting/value/execution times, amount/currency, reference, merchant name/category, etc. Posted transactions require `postingDateTime`. The standard explicitly does not guarantee correlation between pending and later posted transactions, so do not assume matching IDs. Responses have `links` (self/first/prev/next/last) and `meta.totalRecords`/`totalPages`; requests paginate with `page`/`page-size`. St.George authenticated CDR responses and Internet Banking/App internal schemas remain unvalidated.

## Statement periods, counts, and export

| Route                                | Period/count                                                                                                                                                                                                                                       | Format                                              | Confidence                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| Internet Banking transaction history | `Last 7 days`, `Last 30 days`, `All`, custom date ranges. FAQ history window: 3 months from last statement for monthly cycles, 2 statements for quarterly/6-month/yearly cycles. Maximum 500 transactions per retrieval, 25–500 displayed per page | Screen; CSV not found in official personal guidance | Period/500 official; CSV only in third-party implementations                    |
| App transaction search               | Date ranges, descriptions, amount ranges, debit/credit                                                                                                                                                                                             | Screen                                              | Official                                                                        |
| Proof of Balance                     | Current point in time; multiple accounts selectable                                                                                                                                                                                                | St.George letterhead PDF                            | Official                                                                        |
| Transaction Listing                  | 30 / 90 / 120 days or custom date range                                                                                                                                                                                                            | St.George letterhead PDF                            | Official                                                                        |
| eStatement                           | Most transaction/savings, credit cards, sole home/personal loans. Missing online statements within past 7 years may be archived. Normally semiannual; monthly/quarterly/semiannual/yearly on request; loans fixed at 6-month, credit cards monthly | Savable/printable statement PDF                     | Official                                                                        |
| Previous/interim statement request   | Maximum 14 statements per request; cannot combine all 7 years in one document. Interim covers last statement to request date, normally next business day; unavailable for credit cards                                                             | eStatement or mail                                  | Official, but request/Confirm changes state, so automated validation prohibited |
| CDR transactions                     | `oldest-time`/`newest-time`; default 90 days back from latest date. Since 2025-03-04, past 2 years required consumer data; over 2 but under 7 years voluntary                                                                                      | Paginated JSON                                      | CDR standard/current ACCC guide; St.George voluntary-range support unconfirmed  |

Evidence: [Viewing transactions](https://www.stgeorge.com.au/online-services/internet-banking/view-transactions), [Proof of balance / transaction listing](https://www.stgeorge.com.au/online-services/internet-banking/proof-of-balance), [Managing accounts FAQ](https://www.stgeorge.com.au/online-services/internet-banking/faqs/managing-accounts-faqs), and [Internet Banking customisation FAQ](https://www.stgeorge.com.au/online-services/internet-banking/faqs/customisation-faqs).

### CSV / OFX / QIF / PDF conclusion

- **PDF**: official personal-account evidence exists for Proof of Balance, Transaction Listing, and eStatements. Current Play descriptions explicitly allow downloading Proof of Balance, Interest Earned, and Transaction Listing reports from app Services. Keep Web/app PDF availability separate by official help source; do not infer identical Web coverage from app descriptions.
- **CSV**: not found in current official personal help. However, a 2022 public Puppeteer implementation clicks `#transHistExport` and parses `Date`, `Debit`, `Credit`, `Description`. A 2012 Mechanize implementation also sends `exportFileFormat=CSV`. Strong evidence that Web CSV existed, but current 2026 availability requires live read-only confirmation.
- **OFX / QIF**: neither current official personal Internet Banking material nor checked public implementations provides evidence. Treat as unconfirmed, not unsupported.
- **CDR JSON**: structured account/transaction data for accredited/sponsored recipients, not PDF/CSV/OFX/QIF export or a format consumers directly download with a button.
- Exclude separate Business Banking Online configurable exports and PayWay/PaymentsPlus CSVs from these judgments.

## Authentication, MFA, devices, passkeys, and Bitwarden

### Confirmed facts

1. Internet/Mobile Banking registration requires a card/account number, birth date, and registered phone. Users create a security number/password and receive a CAN. See official [registration](https://www.stgeorge.com.au/online-services/get-started).
2. Both public login forms and St.George-specific third-party implementations use CAN/access number, security number, and Internet password as the three normal-login elements.
3. [Secure Code](https://www.stgeorge.com.au/online-services/security-centre/protect-yourself/securecode) sends SMS OTP to registered mobile numbers for **certain types** of Internet/Mobile Banking transactions, payee creation, settings changes, etc. Official guidance does not require OTP on every login.
4. St.George Secure uses adaptive authentication and behavioral/suspicious-activity detection. Official security articles say unexpected-location logins/transactions may require additional Secure Codes.
5. App Quick logon supports Face ID, fingerprints, four-digit security numbers, and passwords. Initial setup requires bank details. Constraints include iOS 15+/Android 10+; Google Play says rooted devices cannot use fingerprint quick logon and may lose some functionality.
6. CDR authorization redirects from the ADR consent portal to St.George, authenticating with CAN and Secure Code OTP. It is not a screen directly issuing personal CDR access tokens.
7. St.George's [data/device security article](https://www.stgeorge.com.au/online-services/security-centre/articles/are-your-data-and-devices-safe) advises against storing sensitive banking details even when using password managers.

### Distinguish inference from unconfirmed items

- **Device binding**: Quick logon enrollment is likely device-local, but public material does not establish server-side token binding, concurrent registered-device limits, or specific attestation methods. Biometrics are naturally understood as OS biometric gates, but do not guess template storage or app-token encryption.
- **Passkey**: no official evidence of St.George FIDO2/WebAuthn passkey login found. Do not call Face ID/fingerprint quick logon passkeys.
- **Bitwarden**: official guidance neither supports nor rejects Bitwarden by name. Browser-autofill compatibility is unconfirmed. Generic password-manager advice does not establish permission to store CAN/security number/password together in Bitwarden.
- **Session reuse**: current public implementations demonstrate reuse of already-authenticated Chrome sessions, but cookie lifetime, refresh, and IP/device binding are unknown. Cookies/tokens are not established renewable collector credentials, so not level B.

### Static confirmation of current Web login transport

On 2026-08-26, the [official Internet Banking login](https://ibanking.stgeorge.com.au/ibank/loginPage.action) and its public JavaScript were retrieved without credentials. Bundles were statically formatted with Prettier; unknown code was not `eval`uated/executed and dynamic values were not recorded.

- Login uses `POST logonActionSimple.action`, sending normal `userId` (CAN/card), `securityNumber`, `password`, and hidden fields such as `nameId`, `bmNameId`, `bmSessionId`, `statperfid`, `devicePrint`, `radRes`. Do not treat these as fixed values/reusable tokens.
- `logonCrypto.js` decrypts security-number/password substitution tables with per-page AES keys, substitutes input characters, and submits. This is client-side credential obfuscation, not banking access tokens or a replacement for transport encryption.
- `encode_deviceprint()` in `rsa.min.js` generates `devicePrint`. `rdagent.js` probes page-supplied localhost WebSocket ports and puts results in `radRes`. This is consistent with anti-fraud signals detecting possible remote-access software; decision rules are unknown.
- Approximately 1 MB `BM_v2_43.js` (public asset version `26E3MR36`) contains formatted class/function names including `BioCatchClient`. It uses `cdApi.setCustomerSessionId(...)` and `LOGIN_PAGE`, internal `sid`/customer-session/partner-session/`muid`, server `sts`/`std`/`ott`, and request counters. Includes `startNewSession`, `resumeSession`, `ResetSession`, context changes, local/session storage (`bmuid`, `cdSrvrState`, etc.), VM detection, mouse/touch/key telemetry, `/client/v3.1/web/wup`/`/api/v4/wup`. This is a fraud-telemetry session, not proven identical to account-read sessions/tokens.
- Login GET issues `LastLoginCookie`, `JSESSIONID`, `PD-S-SESSION-ID`, etc. Observed attributes: `LastLoginCookie` Secure/HttpOnly/SameSite=Strict; `PD-S-SESSION-ID` Secure/HttpOnly; `JSESSIONID` HttpOnly. Values were not saved. Unauthenticated GETs to `viewAccountPortfolio.html`/`accountDetails.action` return HTTP 200 logout pages, so status alone cannot identify authentication.

Public login assets establish only authentication bootstrap. Current portfolio/transaction routes, HTML/JSON transport, banking tokens, idle/absolute expiry, renewal, pagination, and pending/posted fields require authenticated runtime metadata. The pending/posted model below is from official UI descriptions/CDR standards; do not confuse it with Internet Banking internal schemas.

## Public edge, WAF, and anti-bot

On 2026-08-26, read-only DNS/HTTP probes were performed without credentials.

| Host                          | Observation                                                                                                                               | What can/cannot be concluded                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `www.stgeorge.com.au`         | CNAME `*.cloudfront.net`; responses include `via: ...cloudfront.net`, `x-cache`, `x-amz-cf-*`                                             | AWS CloudFront edge; headers alone do not establish WAF/rules                                                            |
| `ibanking.stgeorge.com.au`    | CNAME `*.edgekey.net`; `akamai-grn`, `server-timing: ak_p`; unauthenticated GET/HEAD show `JSESSIONID` and `PD-S-SESSION-ID` cookie names | Akamai edge; cookie values not recorded. Specific Akamai Bot Manager/WAF products/policies unconfirmed                   |
| `digital-api.stgeorge.com.au` | CloudFront CNAME; `x-amz-apigw-id`/`x-amzn-requestid`; Product API with correct `x-v` and discovery status return 200                     | CloudFront + AWS API Gateway. Public API validates versions/headers; full customer-API gateway/auth topology unconfirmed |

No CAPTCHA was observed on normal public Product API GETs or unauthenticated login retrieval. This does not establish challenge-free authenticated login automation. Official adaptive authentication indicates additional checks based on location/behavior; avoid repeated headless logins from fixed cloud egress. Do not bypass or automatically solve 403/429/CAPTCHA/Secure Code/unusual-activity prompts.

## Official mobile app artifacts/transport

### Play provenance and current metadata

The [official St.George mobile page](https://www.stgeorge.com.au/online-services/mobile-banking) Play link goes directly to package [`org.stgeorge.bank`](https://play.google.com/store/apps/details?id=org.stgeorge.bank&hl=en_AU&gl=AU). Current metadata confirmed from official Play responses on 2026-08-26: title `St.George Mobile Banking`, developer `St.George Bank`, version **9.52**, updated **2026-07-07**. Public metadata does not expose versionCode/signers.

The same Play metadata shows [BankSA `org.banksa.bank`](https://play.google.com/store/apps/details?id=org.banksa.bank&hl=en_AU&gl=AU) and [Bank of Melbourne `org.bom.bank`](https://play.google.com/store/apps/details?id=org.bom.bank&hl=en_AU&gl=AU) at 9.52, updated the same day; public Web login `logonSimple.js?ver=26E3MR36` also has matching SHA-256 across all three brands. This strongly supports a shared release/code line among St.George division brands, but not identical authenticated hosts/schemas/sessions. Westpac itself instead has a separate [package `org.westpac.bank`](https://play.google.com/store/apps/details?id=org.westpac.bank&hl=en_AU&gl=AU), different Play release display, and [official Web](https://banking.westpac.com.au/) using Customer ID/password at `banking.westpac.com.au/wbc/banking/...`. Do not port St.George's three-field login/`ibanking.stgeorge.com.au/ibank/...` routes to Westpac or vice versa.

### Barriers to legitimate split acquisition and reproduction

St.George does not officially distribute standalone APKs; consumer Play delivery uses app bundles/splits for registered Android devices/accounts. This Windows/WSL environment lacked Android SDK/`adb`, `apkanalyzer`/`aapt2`/`apksigner`, `jadx`/`apktool`, and a connected user-owned device, so legitimate base/splits were not obtained. Current 9.52 signer, versionCode, manifest, permissions/exported components, hosts/schemas, network config, device binding, pinning, and integrity/attestation remain undetermined. Do not adopt third-party APK mirrors as current official artifacts.

Reproducible acquisition/verification:

1. Install/update 9.52 on a supported, non-rooted user-owned Android through the official St.George page's Play link. Do not clear app data, reinstall, or migrate devices with Quick Logon enrolled.
2. With user consent, temporarily enable USB debugging; retrieve only versionName/versionCode, installer, and split names using `adb shell dumpsys package org.stgeorge.bank`. Pull all base/splits returned with normal permissions by `adb shell pm path org.stgeorge.bank` to a private work area.
3. Check every split's SHA-256 and signer digest with `apksigner verify --print-certs`. Exclude binaries, certificates, device serial/account metadata from Git/CI.
4. Stop on pull denial, app termination, or Quick Logon/device re-registration prompts. No root, backup exploits, repacking/re-signing, mirror substitutes, or detection bypasses.

### Static/runtime observation after acquisition

- Check manifest permissions, exported components/deep links, backup, `debuggable`/`profileable`, network security config, FileProvider, biometrics/Keystore, and native libraries.
- Extract transport such as OkHttp/Retrofit/WebView/Custom Tabs, host/path templates, JSON/protobuf schemas, session issuance/renewal, pagination/cursors, pending/posted models, token storage, and account namespaces from strings/call graphs. Do not handle actual tokens/bodies.
- Separate **candidates** for Quick Balance/Quick Logon device-registration tokens, BiometricPrompt/Keystore gates, push registration, and Play Integrity/root/debug/emulator/pinning libraries.
- Check Proof of Balance, Interest Earned, and Transaction Listing renderer/download/share routes and MIME/schemas; separate from write services/payment/card functions through call graphs.
- In the user's existing registered official app, display only account lists, balances, transaction searches, pending/posted, and report controls. Through normally attachable Android Studio Network Inspector, standard proxies/PCAP/logcat, or Frida/Objection within normal unmodified-app operation, immediately redact to method/origin/path template/status/content-type/call order/field names only. Save no bodies, headers/cookies/tokens, account IDs, values, screenshots, or DB contents.

Stop on pinning, root/debug/integrity detection, additional authentication, device registration, or app termination. Do not install CAs, disable pinning, hide root, spoof attestation, or repack/re-sign. Do not replay until read/write side effects are classified; write endpoints remain prohibited after classification.

Public third-party artifacts are limited. [Tabbed Out analysis result](https://github.com/beerphilipp/tabbed-out/blob/3ada3bb1fc317cdf9a442a52445614ee5a8b7cff/analysis/results/org.stgeorge.bank.res.json) finds Android Custom Tabs strings in an unknown-version `SINGLE_APK`; [GrapheneOS report #570](https://github.com/PrivSec-dev/banking-apps-compat-report/issues/570) reports normal operation of Play 9.44/build 2025010700. Neither establishes current 9.52 hosts, signers, pinning/integrity, or banking schemas.

## Official CDR / Open Banking

### Public Product API

[St.George Product API](https://www.stgeorge.com.au/online-services/open-banking/product-api) uses base `https://digital-api.stgeorge.com.au/cds-au/v1/banking/products/`, REST GET/JSON, and Australian Consumer Data Standards without security/special auth headers. However, `x-v` is required for per-endpoint version negotiation. Read-only GETs on 2026-08-26 returned 42 Product records with `x-v: 5` and Discovery Status `OK` with `x-v: 1`. Product page counts depend on requested `page-size`; these are dated counts, not constants.

The government CDR Register's St.George Bank brand entry gives public/product base URI `https://digital-api.stgeorge.com.au`. The Register v2 read-only GET on 2026-08-26 showed `lastUpdated` `2026-08-03T01:12:10Z`. The official DSB product comparator also obtains base URIs from the Register, adds `Accept: application/json`, `x-v`, `x-min-v` to browser `fetch` GETs, and navigates to `/banking/products/{productId}`. This is not customer-data transport.

### Customer-data coverage and APIs

[St.George Open Banking](https://www.stgeorge.com.au/online-services/open-banking) and [St.George error mapping](https://www.stgeorge.com.au/online-services/open-banking/error-mapping) establish at least CDR API families for accounts, account detail, bulk/specific/account balances, transactions, transaction detail, direct debits, scheduled payments, and payees. CDR-covered products include transaction/savings/debit accounts, term deposits, credit/charge cards, residential/investment home loans, personal loans, etc. Actual selectable accounts vary by ownership, online eligibility, closed status, and product classification.

The current ACCC guide after 2025-03-04 makes the past 2 years of transactions required, over 2 but under 7 years voluntary, and closed-account data voluntary. Required direct-debit coverage is 13 months. CDR Get Transactions has `oldest-time`, `newest-time`, amount, text, `page`/`page-size`, and paginated links/meta, defaulting to the past 90 days. CDR JSON is a machine-readable customer-data route, not an alternate Internet Banking CSV/official-report PDF format. Actual St.George voluntary 2–7-year/closed-account support requires live ADR testing.

### Consumer and ADR requirements

- Consumers need Internet Banking registration. First consent in the ADR app/site, redirect to St.George authorization, authenticate with CAN + Secure Code OTP, and select shared accounts/data.
- Consent/authorization is managed in both dashboards and can be revoked through St.George Internet Banking. Joint accounts follow St.George's enable/disable rules.
- Ordinary consumers directly requesting St.George CDR APIs are outside current CDR rules; accredited persons request on their behalf.
- Becoming an ADR requires ACCC accreditation (or a sponsored participation route), fit-and-proper checks, information-security controls, internal/external dispute resolution, appropriate insurance, an Australian address for service, CDR policy/privacy safeguards, and records/reporting. CDR Register onboarding, PKI certificate agreements, and Conformance Test Suite are additional requirements.
- Transport follows the CDR Security Profile's OAuth 2/OIDC/FAPI family. Data Recipients use CDR Register Software Statement Assertions (signed JWTs) for Dynamic Client Registration with Data Holders, handling `private_key_jwt` client authentication, mTLS endpoints, signed requests/responses, and versioned CDR headers. This is not simple CAN/password-login replay.

See [CDR Data Standards](https://consumerdatastandardsaustralia.github.io/standards/), [ACCC accreditation](https://www.cdr.gov.au/for-providers/become-accredited-data-recipient), [IT requirements](https://www.cdr.gov.au/for-providers/it-requirements-data-recipients), and [current banking data-holder compliance guide](https://www.cdr.gov.au/resources/guides/compliance-guide-data-holders-banking-and-non-bank-lenders-sectors). Existing ADRs/aggregators may be lawful initial options, but this research evaluates official St.George routes first and does not count aggregator abilities as St.George-specific capabilities.

## Public third-party implementations

| Implementation                                                                                                                                         | Date/status                                            | Transport/auth/implementation facts                                                                                                                                                                                                                                                                                       | Assessment                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [tekumara/cashgrab `stgeorge-balances.js`](https://github.com/tekumara/cashgrab/blob/main/src/stgeorge-balances.js)                                    | Last St.George-module commit 2026-04-05                | Connects to existing Chrome at localhost:9222 using Puppeteer/CDP. Assumes authenticated St.George Internet Banking; navigates to `viewAccountPortfolio.html`, parses nickname, BSB, account number, current/available balances from `#acctSummaryList > li`. Without account cards, opens login and prompts manual login | Near-current proof of authenticated browser bootstrap/read-only balances. Emits PII/balances to stdout; cannot adopt unchanged. No session renewal/transaction export |
| [geofflamrock/ynab-sync St.George package](https://github.com/geofflamrock/ynab-sync/tree/main/packages/st-george-au)                                  | Last package commit 2022-12-11; repo pushed 2023-03-26 | Puppeteer enters access number/security number/password at `loginPage.action`, expects portfolio URL, uses account index for `accountDetails.action`, date fields/search/`#transHistExport`, and downloads CSV. Converts `Date`, `Debit`, `Credit`, `Description` to YNAB transactions                                    | Concrete CSV/DOM-route evidence, but old, lacks OTP/adaptive challenges, and passes credentials into a process; not a current safe design                             |
| [yec/bankscripts `stgeorge.pl`](https://github.com/yec/bankscripts/blob/master/stgeorge.pl)                                                            | 2012-04-23                                             | Perl `WWW::Mechanize` POSTs userid/securityNumber/password to `logonForm` and `exportFileFormat=CSV` to account-detail form                                                                                                                                                                                               | Historical evidence only of longstanding CSV export; obsolete URL/HTML/auth, not reusable                                                                             |
| [CDS product comparator demo](https://github.com/ConsumerDataStandardsAustralia/product-comparator-demo/blob/master/src/store/banking/data/actions.js) | Public DSB demo                                        | Gets brand base URI from CDR Register; unauthenticated browser GET with `Accept`, `x-v`, `x-min-v`, pagination, product-detail fetch                                                                                                                                                                                      | A/cost 1 transport also usable for St.George Product API; no personal-account data                                                                                    |

Public GitHub code search found no other current St.George-specific customer-data API clients, renewable-token clients, or APK reverse-engineered protocols. Westpac-brand clients are excluded and not assumed transferable to St.George.

## Runtime suitability

| Runtime                        | Product API                                 | CDR ADR client                                                                                                                                                                                     | Internet Banking C route                                                                                                                                   | App/device route                                                                                              |
| ------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers             | Best; easy scheduled GET/JSON normalization | Outbound mTLS certificate bindings and WebCrypto/JWT are technical candidates, but require design review for ADR compliance, key lifecycle, CDR data environment, audit/retention on Workers alone | Not ordinary fetch alone. Browser Run provides Puppeteer, but not first choice given login bootstrap, sessions, bank PII, adaptive auth, egress reputation | Unsuitable                                                                                                    |
| Cloudflare Containers          | Excessive                                   | Normal OAuth/FAPI stacks in `linux/amd64` images; compliance remains separate                                                                                                                      | Playwright/Puppeteer in OCI images; separately design secure persistent-profile/human-bootstrap handoff                                                    | Supports APK static toolchains; Play delivery/user devices/runtime separate                                   |
| Generic OCI container          | Easy                                        | Easier composition of mTLS, HSM/KMS clients, JWT, refresh tokens, audit sidecars                                                                                                                   | Easier browser-version pinning, stable egress, encrypted ephemeral volumes                                                                                 | Suits jadx/apktool static analysis; runtime needs physical Android bridge                                     |
| Kubernetes                     | Excessive for small Product APIs            | Most operational flexibility for CronJobs, Secrets/KMS, NetworkPolicy, audit/rotation; does not reduce accreditation cost                                                                          | Headful/headless pods and human handoff possible; treat browser profiles like secrets                                                                      | Possible with separately managed device farms/ADB, cost 5                                                     |
| Non-rooted Android real device | Unnecessary                                 | Unnecessary                                                                                                                                                                                        | Unnecessary because Web routes exist                                                                                                                       | First choice for legitimate splits, Quick Logon/device binding, app read transport. No root/emulator bypasses |

Current official Cloudflare material provides Workers [mTLS certificate binding](https://developers.cloudflare.com/workers/wrangler/configuration/#mtls-certificates), Browser Run [Puppeteer sessions](https://developers.cloudflare.com/browser-run/puppeteer/), and Containers [linux/amd64 image](https://developers.cloudflare.com/containers/get-started/)/[managed/external registries](https://developers.cloudflare.com/containers/platform-details/image-management/). Kubernetes runs standard [container image](https://kubernetes.io/docs/concepts/containers/images/)s. None overrides bank terms, CDR accreditation, or anti-fraud challenges.

## Common automation rubric

Apply PR #5's common definitions unchanged, without custom definitions.

- **A** — direct documented/export API suitable for scheduled headless use
- **B** — stable read-only internal API with renewable or reusable session
- **C** — browser/app bootstrap plus headless replay is plausible
- **D** — full browser/device automation is probably required
- **E** — manual capture remains the safe default
- **Cost 1–5** — 1 is a small wrapper; 5 is device-bound/adversarial

| Route                                                    | Level |  Cost | Reason                                                                                                                                                                             |
| -------------------------------------------------------- | ----- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary personal balance/transaction route               | **C** | **4** | 2026 public code demonstrates authenticated Chrome bootstrap/DOM reads; old code implements CSV export. Renewable sessions unconfirmed; adaptive auth/Akamai/selector drift remain |
| Candidate read-only transport replay after app bootstrap | **C** | **4** | Current splits/runtime unavailable. Valid only if normal-device observation confirms renewable sessions, read endpoints, pinning/device binding                                    |
| Manual official PDF retrieval/ingestion                  | **E** | **1** | Official, stable, safe; requires human App/Internet Banking retrieval                                                                                                              |
| Public Product API                                       | **A** | **1** | Documented unauthenticated REST GET; no personal balances/statements                                                                                                               |
| Accredited/sponsored CDR participant                     | **A** | **5** | Documented machine-readable API suits consented scheduled retrieval; heavy accreditation, PKI/mTLS/FAPI, conformance, security/privacy obligations                                 |
| Physical Android UI automation                           | **D** | **5** | Biometrics/quick logon/device integrity/UI drift. Reverse engineering is in scope, but full devices needed if transport replay fails                                               |

## Read-only live-validation plan

### Phase 0: public and unauthenticated

1. GET St.George's CDR Register brand entry, Product API `/products` and one product detail, and `/discovery/status`. Record only status/version/pagination/schema; save full product snapshots only if needed.
2. Recheck vendor-neutral DNS CNAME/response-header facts. No high-frequency probes, path enumeration, or login POSTs.
3. Pin third-party GitHub commit SHAs/dates/selectors without executing. Statically format public login JS, retaining only hashes, asset versions, form-field/function names; no dynamic values.

### Phase 1: user-attended Internet Banking

1. The user logs in through a normal browser. The collector does not enter/retrieve/save CAN/security number/password/OTP.
2. Through DevTools protocol, record only method, origin, path template, status/content-type, redirect/call order, and cookie **names/attributes**, without capturing request bodies/headers. Use DOM markers to distinguish portfolio/logout HTTP 200 at `viewAccountPortfolio.html`.
3. Check only DOM roles/selectors/counts for transaction/savings/card/loan/term-deposit account cards in the portfolio, without reading values. Exclude nicknames, BSBs, account numbers, and balance text from screenshots/logs/traces.
4. On a representative account, check current/available balance **field presence**, pending/posted labels, date/amount/type filters, maximum-display-count selectors. Do not record transaction descriptions, merchants, amounts, dates. Check field presence for page/page-size/cursor/total and pending→posted correlation IDs; classify HTML fragments, JSON, or form POST transport.
5. Check only whether CSV export and PDF-report/eStatement menus remain available. Do not download actual files containing personal data in this research. If needed, obtain separate explicit permission, check only schemas in encrypted temporary storage, then erase immediately.
6. Observe idle/absolute expiry and cookie/session renewal during normal navigation only through cookie names, attributes, and issuance/renewal-event presence, without comparing values. Close the browser without duplicating sessions. Prepare separate explicit permission, secret storage, redaction, and revocation procedures before testing reusable sessions.

### Phase 2: user-owned Android

1. First perform legitimate Play-split acquisition, signer/manifest/static analysis described above. Do not change existing OTP/Quick Logon enrollment.
2. The user displays account lists, balances, transaction search, pending/posted, and report controls. Capture metadata only: method/origin/path/status/schema field names, pagination/session-refresh events. Check whether hosts/schemas match Internet Banking or are St.George app-specific APIs.
3. Do not execute report downloads, shares, payments/transfers, card/limit/settings operations. Compare Web/app read coverage only through control/field presence.

### Phase 3: CDR

1. Stop at public Product APIs. Do not begin customer-data live tests until an active ADR/sponsor, CTS-approved software product, consent UX, and CDR data environment exist.
2. Even then, start with minimum scopes (`bank:accounts.basic:read`, and `bank:transactions:read` if needed) and short periods. Research logs exclude transaction contents/balances; redacted evidence includes only schemas, pagination, status, latency, token-refresh results.

### Stop conditions

Stop immediately on any of the following without bypass/retry.

- Secure Code/OTP, CAPTCHA, push approval, new-device enrollment, biometric prompts, unusual-location/activity warnings.
- 401/403/429, account-lock warnings, session invalidation, unexpected redirects.
- Targets enter transfers/payments, payees, BPAY, scheduled payments, card activation/lock/PIN, limits, disputes, contact details, statement-delivery preferences, term-deposit maturity instructions, CDR consent/authorization changes/revocation.
- POST/PUT/PATCH/DELETE with unclassified side effects. Even read-only POST navigation is not replayed until user screens/public implementations establish no side effects. Do not send CDR-standard read-only bulk POSTs without an active ADR's formal validation plan.
- PII, account identifiers, balances, transactions, cookies/tokens/OTPs risk entering consoles, traces, HARs, screenshots, or crash dumps.
- Vendor challenges require stealth, fingerprint spoofing, proxy rotation, root/emulator concealment, or certificate-pinning bypasses.

## Unconfirmed items

- Whether 2026 personal Internet Banking retains CSV export; columns, encoding, pending inclusion, per-file row limits, credit-card/loan/term-deposit coverage.
- OFX/QIF export presence; no official personal-account evidence found.
- Current portfolio/search DOM selectors, idle/absolute session lifetimes, cookie refresh, IP/device binding, and Secure Code triggers for read-only login.
- App 9.52 versionCode/signer, splits/manifest, hosts/paths/schemas, pagination/pending-posted model, Quick Logon server-side registration/attestation, registered-device counts, token storage, pinning/integrity, passkey/WebAuthn support, Bitwarden autofill.
- Actual St.George CDR voluntary 2–7-year, closed/offline-account, and product coverage; St.George-specific current auth/mTLS endpoint metadata.
- Akamai/CloudFront WAF/bot-management products/rules; public headers do not establish these.
- Internal app transport/APIs remain unconfirmed without legitimate splits/user devices. The above `dumpsys`/`pm path`/all-split pull/`apksigner`/static analysis/runtime metadata tracing are the concrete next experiments. Reverse engineering itself is in scope; security-control bypasses are not.

## Main sources

- [St.George Internet Banking](https://www.stgeorge.com.au/online-services/internet-banking)
- [St.George Mobile Banking](https://www.stgeorge.com.au/online-services/mobile-banking)
- [Viewing transactions](https://www.stgeorge.com.au/online-services/internet-banking/view-transactions)
- [Pending transactions](https://www.stgeorge.com.au/online-services/internet-banking/faqs/pending-transactions)
- [Proof of balance and transaction listing](https://www.stgeorge.com.au/online-services/internet-banking/proof-of-balance)
- [Managing accounts FAQ](https://www.stgeorge.com.au/online-services/internet-banking/faqs/managing-accounts-faqs)
- [Quick logon](https://www.stgeorge.com.au/online-services/mobile-banking/quick-logon)
- [Secure Code](https://www.stgeorge.com.au/online-services/security-centre/protect-yourself/securecode)
- [St.George Open Banking](https://www.stgeorge.com.au/online-services/open-banking)
- [St.George Product API](https://www.stgeorge.com.au/online-services/open-banking/product-api)
- [St.George CDR error mapping](https://www.stgeorge.com.au/online-services/open-banking/error-mapping)
- [Consumer Data Standards](https://consumerdatastandardsaustralia.github.io/standards/)
- [CDR provider accreditation](https://www.cdr.gov.au/for-providers/become-accredited-data-recipient)
- [CDR IT requirements](https://www.cdr.gov.au/for-providers/it-requirements-data-recipients)
- [ACCC banking/NBL data-holder compliance guide](https://www.cdr.gov.au/resources/guides/compliance-guide-data-holders-banking-and-non-bank-lenders-sectors)
- [Google Play: `org.stgeorge.bank`](https://play.google.com/store/apps/details?id=org.stgeorge.bank)
- [Apple App Store: St.George Mobile Banking](https://apps.apple.com/au/app/st-george-mobile-banking/id294380705)
- [CDR Register: Data Holder Brands Summary API](https://api.cdr.gov.au/cdr-register/v1/banking/data-holders/brands/summary)
- [Tabbed Out: `org.stgeorge.bank` static result (third-party, unknown version)](https://github.com/beerphilipp/tabbed-out/blob/3ada3bb1fc317cdf9a442a52445614ee5a8b7cff/analysis/results/org.stgeorge.bank.res.json)
- [GrapheneOS compatibility report #570 (third-party, 9.44)](https://github.com/PrivSec-dev/banking-apps-compat-report/issues/570)

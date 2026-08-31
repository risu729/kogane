# SBI新生銀行 source assessment

調査日: 2026-08-31（公式資料・公開コード・未認証edge probeを再確認）

## Scope and safety boundary

This assessment covers **SBI新生銀行 (retail PowerFlex / PowerDirect) only**.
It does not use SBI証券, 住信SBIネット銀行, SBI VC Trade, another bank, or a
financial aggregator as a data source. User-controlled authenticated captures
were used to validate transport topology, but no authenticated value or body is
included in this public repository.

The proposed collector is read-only. It must not initiate a domestic transfer,
an account-to-account transfer, an FX conversion, a time-deposit transaction, a
memo edit, or a settings change. It must not retain credentials, one-time codes,
account identifiers, names, or real balances in logs, fixtures, screenshots, or
repository history.

## Executive decision

**Recommendation: use the official desktop PowerDirect web surface as the next
collector target.** The official security and operation guides now give strong
evidence that an ordinary read-only web login requires only the 10-digit
branch/account identifier and PowerDirect password. The registered-phone FIDO
approval is documented for important transactions, not as a mandatory approval
for every browser login. This is materially different from SMBC Safety Pass.

Visible, user-controlled live runs have now succeeded in both ordinary Chrome
and the dedicated Kuebiko profile. The Kuebiko capture confirms the login and
major read-adapter request/response bodies and HTTP 200 results, but no live value
is reproduced in this repository. An unauthenticated direct HTTP probe from the
current Windows and WSL network paths received no response bytes before timeout,
so a Workers-compatible endpoint has not yet been proved. The current PoC keeps
CAFIS generation, login and authenticated reads in one Chrome context; a plain
Worker isolate cannot yet replace that browser boundary.

This route has the best evidence-to-maintenance ratio:

- the top page and balance/product screens cover yen savings, SBI Hyper Yokin,
  yen time deposits (including 2-week maturity), foreign-currency savings and
  foreign-currency time deposits;
- desktop PowerDirect officially exports yen- and foreign-currency savings
  account activity as CSV;
- monthly transaction reports fill the older-history and time-deposit evidence
  gap as PDF for up to 60 months;
- a login to the browser PowerDirect site uses branch/account number plus the
  PowerDirect password, while FIDO/SMS/telephone approval is documented for
  protected transactions and procedures. A read-only collector must never enter
  those flows.

An official PowerDirect API also exists, but the published route is an
external-service-provider integration. Becoming such a provider is a separate
business/compliance project, not a shortcut for a personal collector. The mobile
app is valuable for discovery and as an operator interface, but its FIDO-bound
device model makes it a poor first automation target. The public Web surface is
the preferred implementation route; app analysis is a parallel inventory/fallback
track, not a prerequisite for the first collector.

Overall implementation cost is **2/5** for a reliable, user-assisted
PowerDirect CSV/PDF collector and **3/5** for an unattended persistent-browser
collector. A browserless HTTP collector remains **3/5 but conditional** on a
local direct client reproducing the captured risk/login/token/read sequence and
receiving the same Akamai decision outside Chrome.
The automation outlook is **high for balances and ordinary-account activity
after a session is established**, **medium for deposits represented only by
product/statement screens**, and **unproven for cloud-side login**.

### Current blocker matrix

| Question | Evidence as of 2026-08-31 | Decision impact |
| --- | --- | --- |
| Is Akamai in front of PowerDirect? | Yes. The login hostname CNAMEs through `edgekey.net` to `akamaiedge.net`. | Expect edge policy and possible fingerprint/IP sensitivity. |
| Is Akamai browser telemetry proved? | Yes. The public login loads an Akamai sensor path under `/akam/13/...`. The exact Akamai product/rule and cookie behavior are not yet identified. | Browser telemetry exists, but do not equate it with a proved rejection decision. |
| Is Turnstile present? | Not observed. Successful normal-Chrome and Kuebiko logins showed no Turnstile step, asset or challenge. | Do not carry the GLOBAL PASS Turnstile architecture into this collector unless another environment actually receives a challenge. |
| Is registered-device approval required for read-only browser login? | No in two successful runs: ordinary Chrome and the dedicated Kuebiko profile both reached read adapters with branch/account number plus PowerDirect password and without OTP or FIDO. | Unlike SMBC Safety Pass, registered-device approval is not a blocker to the observed read-only Web login. Risk-triggered behavior on other networks/headless clients remains untested. |
| Can a Worker perform the login today? | Not proved. Accepted Chrome topology is captured, but plain Windows/WSL HTTP timed out and CAFIS needs browser surfaces. | Validate the one-context Chrome client, then move that boundary to Browser Run or a Container before attempting to remove the browser. |
| Is the app an easier path? | No. Current app login is biometric/FIDO, one registered phone per account, and device replacement/reinstall repeats identity verification. | Keep app static analysis separate; prefer Web for collection. |

## Official surfaces and data coverage

### PowerDirect web

The official entry point is
[PowerDirect](https://www.sbishinseibank.co.jp/service/newpd/), whose login link
currently resolves to
`https://bk.web.sbishinseibank.co.jp/SFC/apps/services/www/SFC/desktopbrowser/default/`.
The bank describes PowerDirect as its PC/smartphone internet banking surface for
balances, account activity and transfers.

The bank's [service matrix](https://www.sbishinseibank.co.jp/service/newpd/service.html)
and [operation-guide index](https://www.sbishinseibank.co.jp/service/newpd/guide/)
establish the following read coverage:

| Data family | Official read surface | Initial collection interpretation |
| --- | --- | --- |
| 円普通預金 | Top-page/account balance; account activity | Current balance plus latest 10 or a selected period; desktop CSV exists. |
| SBIハイパー預金 | Dedicated top-page balance and account-activity link | Treat as a separate balance and history stream. Do not merge it into 円普通預金. |
| 2週間満期預金 | 円預金保有商品照会 / deposit menu | Enumerate holdings from product detail; no official per-product CSV was found. |
| パワーフレックス円定期 / パワーダイレクト円定期 / other held yen deposits | 円預金保有商品照会 | Enumerate each holding and retain product-detail evidence; monthly report is the durable fallback. |
| 外貨普通預金 | Account balance/list and per-currency activity | Preserve native currency and the bank's displayed yen equivalent separately; desktop CSV exists. |
| 2週間満期外貨預金 / 外貨定期 / other held foreign deposits | 外貨預金保有商品照会 | Enumerate holdings from product list/detail; no official per-product CSV was found. |
| Legacy/structured deposits still held | 仕組預金保有商品照会 | Read held products only; do not assume a currently sold product catalog is the account inventory. |

The [account-information guide](https://www.sbishinseibank.co.jp/service/newpd/guide/koza.html)
says the top page shows balances and the balance list leads to native-currency
foreign-currency balances. The
[yen holding guide](https://www.sbishinseibank.co.jp/service/newpd/guide/yenyokin_hoyuu.html)
and
[foreign-currency holding guide](https://www.sbishinseibank.co.jp/service/newpd/guide/gaikayokin_hoyu.html)
show separate held-product lists, with filtering/sorting when multiple time
deposits exist. Therefore, a single total or top-page yen-equivalent figure is
not sufficient raw evidence.

The bank's Hyper Yokin FAQ documents both the dedicated app route and the
PowerDirect top-page route for
[balance](https://faq.sbishinseibank.co.jp/faq_detail.html?category=1195&id=3494320&page=1)
and
[account activity](https://faq.sbishinseibank.co.jp/faq_detail.html?category=1196&id=3494321&page=1).
A second official FAQ warns that after approximately 18:30 a next-business-day
automatic settlement can already be included in the displayed Hyper Yokin
balance. A collector must retain the transaction date and ordering rather than
silently treating the top-page number as a settled end-of-day balance. The
[bank's worked instructions](https://faq.sbishinseibank.co.jp/faq_detail.html?id=3494287&page=1)
say to use the latest row within the requested month for a month-end check, even
when the list also contains a next-month settlement row.

### SBI新生銀行 app

The official Android listing is
[Google Play package `com.shinseibank.powerdirect`](https://play.google.com/store/apps/details?id=com.shinseibank.powerdirect&hl=ja&gl=JP).
At the time of the 2026-08-31 refresh the public listing showed 500,000+
installs, an Android update date of 2026-08-24, balance/account-activity and
time-deposit functions, smartphone ATM, and smartphone authentication. The
bank's current guide applies to app version 3.9.0 or later. The official Apple
listing reported version 3.11.0 on 2026-08-31; the public Google Play page did
not expose a trustworthy Android version number, so do not assume parity from
the update date alone.

The app gives a compact asset/bank-account view and dedicated Hyper Yokin and
account-activity screens. Its
[held-deposit guide](https://www.sbishinseibank.co.jp/service/newpd/app_pd/guide/yokin_shokai.html)
shows product-detail navigation and filtering/sorting when multiple products
are held. Its data breadth is useful for operator checks, but it lacks the
desktop-only CSV control and is bound to the bank's FIDO device-registration
model.

No bank-hosted standalone Android APK was found. The official distribution
surface is Google Play; Kogane should obtain any analysis artifact only through
the user's authorized Play delivery/device, not a third-party APK mirror. A
Play App Bundle may produce split APKs, so analysis must preserve the full split
set and signing-certificate metadata.

APK/split APK bytes, decompiler output, signing metadata and any generated
intermediate files belong only in the designated private Android-analysis
repository. This public repository should contain the reproducible acquisition
and decompilation procedure plus sanitized package/version, architecture and
endpoint conclusions, but not full hashes, bank application binaries or
decompiled code.

#### Sanitized historical Android findings

An authorized **historical version 3.6.0 / version code 71** artifact was
archived with its private static-analysis output in signed private commit
`63a7b1f2`. These findings must not be described as the current 3.11.0 app:

- the hybrid WebView identifies itself with `SHINSEI/SNBSDK_2.0` in its user
  agent;
- app preferences are copied into WebView `sessionStorage` to bootstrap
  `token` and `SFC_CONTROL_INFO` state;
- a `JavaInterface` bridge exposes the names `refreshCsrfToken`, `openURL`,
  `callNative`, `downloadDynamicPDF` and `clearSDKData`;
- ThreatMetrix and Transmit Security components are present alongside Android
  Keystore/biometric handling;
- Kony/VoltMX message-integrity support code is present.

This historical structure is consistent with a native security/bootstrap shell
around Web content, but it does not prove that current app requests or session
state can be reproduced by a Worker. Static searches in this artifact found no
literal `/SFC/app/` route, Akamai cookie name or Play Integrity reference. Those
negative results are narrowly scoped: indirect construction, another split,
the current build, edge policy and runtime-delivered code were not covered and
therefore are not disproved.

The private workflow has only a hash/signature metadata checkpoint for the
**current version 3.11.0 / version code 115**. Its binary is not archived because
the Play acquisition attempt returned HTTP 429. The next authorized acquisition
path is an owner-device handoff: enumerate the installed base/split paths with
`adb shell pm path com.shinseibank.powerdirect`, then pull that exact split set
and verify it privately. Do not substitute the historical archive for that
current-device capture.

Static analysis is useful **later** to inventory official hostnames, deep links,
network libraries, certificate-pinning or device-integrity controls, local
storage and the split between embedded web screens and native calls. It cannot
show which endpoints the current account is authorized to use, prove runtime
request fields, bypass FIDO, or establish that an endpoint is safe to replay.
Dynamic read-only capture on the user's registered physical device is still
required before adopting an app endpoint.

### Official PowerDirect API

The bank publishes a
[PowerDirect API service agreement](https://www.sbishinseibank.co.jp/powerflex/pdf/kiyaku.pdf).
It describes a bank-hosted authorization screen reached from an external
service, account-number/password registration, user consent, periodic
reauthorization, and access only to the accounts/periods the bank makes
available. The agreement explicitly says the linked information is not
guaranteed to be current.

The bank also publishes its
[open-API policy and contact](https://corp.sbishinseibank.co.jp/ja/api/apipolicy.html),
[connection criteria](https://corp.sbishinseibank.co.jp/ja/api/apiguideline.html),
and
[contracted electronic-payment-service providers](https://corp.sbishinseibank.co.jp/ja/api/apikeiyaku.html).
This confirms a supported API program, but not a public self-service developer
API for Kogane. The published criteria imply contracting, security and
regulatory review.

Even if access were obtained, API parity with PowerDirect must not be assumed.
The bank's
[2026 account-activity redesign notice](https://www.sbishinseibank.co.jp/info/news2601_accountactivity02.html)
says the richer transaction descriptions and user-entered memos in the web/app
screens are not applied to external-app PowerDirect API data. Another official
[FAQ](https://faq.sbishinseibank.co.jp/faq_detail.html?id=1000028&page=1)
gives a concrete example where the PowerDirect screen identifies the
cashless-payment business but an external data-link service does not.

For this project, direct access to the bank's own API would still count as an
official source. However, using a contracted aggregator's copy of the data does
not meet this assessment's source policy.

## Activity, transfers and statement granularity

### Savings-account activity and CSV

The bank's
[account-activity guide](https://www.sbishinseibank.co.jp/service/newpd/guide/nyuusyutsukin_meisai.html)
documents filter selection, the result list, and desktop-only CSV download. It
also exposes an editable 15-character memo control; the collector must not use
that control because even a memo is an external write.

The official service matrix gives the latest 10 entries by default plus a
specified-period query for both yen savings and foreign-currency savings. The
[history FAQ](https://faq.sbishinseibank.co.jp/faq_detail.html?category=687&id=105&page=1)
sets the interactive window at the current date through the same month two years
earlier and confirms CSV only on desktop PowerDirect. The exact CSV delimiter,
encoding, column names, maximum rows per export, pagination interaction and
whether the current CSV includes the new richer descriptions were not confirmed
without an authenticated download.

Likely minimum fields, supported by a current maintained third-party parser of
the official export, are transaction date, description, debit, credit and
balance. This is implementation evidence, not a bank-published schema, and must
be verified against a fresh export before a parser is frozen.

### Monthly PDF transaction reports

The official
[electronic-report guide](https://www.sbishinseibank.co.jp/service/newpd/guide/estatement_kakunin.html)
offers the latest three months directly or a selected month from the latest
report back through 60 months, as PDF. The current month becomes available on
the seventh bank business day of the following month according to the
[reissue FAQ](https://faq.sbishinseibank.co.jp/faq_detail.html?id=112550).
Older reports can be ordered by post up to ten years, but that is outside an
automated collector.

The bank's
[report-content FAQ](https://faq.sbishinseibank.co.jp/faq_detail.html?category=687%3Fpage%3D1&id=647&page=1)
lists customer/account header data, prior-month savings balances, one month of
savings-account transactions and balances of held time deposits and other bank
products. Raw PDF storage must therefore use access-controlled paths and
redacted fixtures; reports contain PII even when no transaction parser is run.

### Transfer and pending/posted state

Do not use the ordinary account-activity list as proof that every future-dated
transfer has completed. PowerDirect has a distinct `振込状況の照会・取消` surface.
The bank's
[transfer-status guide](https://www.sbishinseibank.co.jp/service/newpd/guide/furikomi_jyoukyo.html)
distinguishes cancellable accepted transfers from bank-processed transfers,
and the
[print/history FAQ](https://faq.sbishinseibank.co.jp/faq_detail.html?category=687%3Fpage%3D1&id=1000000&page=1)
limits this status view to the latest 30 transfers within 45 days.

Kogane should model this as a separate read-only evidence stream:

- accepted/cancellable or reserved is pending-like evidence;
- `当行処理済` is the bank's processed status;
- an ordinary account-activity row is posted account evidence;
- an error/return can occur after initial acceptance and must not be inferred
  away.

The collector does not need transfer-status data for a first balance/history
milestone. If it is added, it must only open the status list and never click
cancel, print-related transaction controls that mutate state, or any new
transfer action.

For internal transfers, FX and time-deposit transactions, the public material
confirms the official menus and resulting held-product/activity views but does
not publish a separate comprehensive, machine-readable event feed. The initial
collector should retain the savings-side posted entries plus product snapshots
and monthly reports, not manufacture a unified event ledger prematurely.

## Authentication and session behavior

### Confirmed facts

- Browser PowerDirect login is documented as branch number + account number +
  PowerDirect password. The bank's dedicated
  [login-authentication page](https://www.sbishinseibank.co.jp/security/pd/005.html)
  explicitly calls those the two login factors, and the
  [account-information guide](https://www.sbishinseibank.co.jp/service/newpd/guide/koza.html)
  shows the same login before read-only balance access.
- Manual logins in the user's ordinary Chrome profile and dedicated Kuebiko
  profile succeeded on 2026-08-31 without OTP, FIDO or Turnstile. The Kuebiko
  run reached the core read adapters with HTTP 200; no credential, token,
  identifier or account value is transcribed here.
- The bank states that browser PowerDirect remains available regardless of the
  authentication method, while use of the current app requires smartphone
  authentication (FIDO).
- The app's
  [registration/login guide](https://www.sbishinseibank.co.jp/service/newpd/app_pd/guide/login.html)
  requires supported biometrics and NFC, initial account/password login,
  online identity verification and registration of one smartphone per account.
  Reinstall/device change repeats initial registration and invalidates the old
  app login. Subsequent app login uses device biometrics.
- For protected web transactions, FIDO approval displays a number in
  PowerDirect, sends a push to the app, and requires choosing the matching
  number. SMS or telephone code is the fallback flow. See the
  [authentication guide](https://www.sbishinseibank.co.jp/service/newpd/guide/authentication.html).
  The bank's
  [push-notification guide](https://www.sbishinseibank.co.jp/service/newpd/app_pd/guide/push.html)
  says approval must complete within 120 seconds.
- The former VIP Access smartphone-authentication method ended on 2026-06-27.
- No official source found a browser passkey login for PowerDirect. The bank's
  current use of the word FIDO refers to the one-phone SBI新生銀行 app
  registration and transaction approval flow, not a syncable credential that
  can be fetched from Bitwarden and supplied to a Worker.
- The bank documents automatic browser logout after an unspecified period of
  inactivity in its
  [security guidance](https://www.sbishinseibank.co.jp/security/pd/010.html).

### Not yet confirmed

- exact idle and absolute session lifetimes;
- whether a PowerDirect session survives browser restart or can be replayed in
  another browser/container while retaining the same cookie jar;
- whether another IP/network or unattended/headless login triggers additional
  SMS/telephone/FIDO checks despite the successful visible-Chrome runs;
- whether concurrent sessions are allowed or one login invalidates another;
- which cookies or browser storage values are necessary after login;
- whether download navigation uses the same session or a short-lived token.

Do not assume passkey-style FIDO credentials can be exported to a server. The
current documented FIDO path is tied to the registered physical smartphone and
biometric approval. Credentials may be delivered to an interactive bootstrap
from an approved secret manager, but Kogane must never extract or log them and
must not automate a transaction approval.

## WAF and anti-bot observations

### Confirmed

On 2026-08-31, a repeated live DNS lookup showed:

```text
bk.web.sbishinseibank.co.jp
  -> bk.web.sbishinseibank.co.jp.edgekey.net
  -> e227354.b.akamaiedge.net
```

This confirms that the authenticated PowerDirect hostname is delivered through
an Akamai edge. HTTP/1.1 probes from both the current Windows and WSL paths each
timed out after 20 seconds with zero response bytes, while a normal Chrome
session and indexed fetch infrastructure could load the login surface. The TLS
handshake itself succeeded and presented the bank's current certificate. This
separates TCP/TLS reachability from HTTP acceptance, but it does not identify a
particular Akamai blocking rule or prove that cloud traffic is always rejected.

### Public login assets and authenticated transport observations

Inspection of the current public login page and JavaScript, followed by the
authenticated Kuebiko read-only capture, materially narrows the architecture:

- the visible entry is
  `https://bk.web.sbishinseibank.co.jp/SFC/apps/services/www/SFC/desktopbrowser/default/login?mode=1`;
- page assets include an Akamai sensor path under `/akam/13/...`, a CAFIS Brain
  risk collector, `fp-clientlib-v5`, Transmit Security `platform-websdk`, and
  `WLClient.js`;
- the login form exposes `nationalId`, `password` and hidden `dtokeninfo` fields;
- `LG0001_login.js` invokes ThreatMetrix, a Transmit Security DRS
  `triggerActionEvent` with a claimed user identifier, and
  `CAFISBrainRiskCollector.getDeviceTokenInfoV3`, whose result is placed in
  `dtokeninfo` and submitted as `jsc`; Transmit DRS also sends device
  configuration/events to `collect.riskid.security`;
- the application login payload includes `fldUserID`, `password`, `langCode`,
  `mode`, `postubFlag`, `jsc`, `forward`, and `userAgentInfo`;
- the credential submission route is
  `POST /SFC/app/ShinseiAuthenticatorRealm/login_auth_request_url`;
- a successful login returns an authorization response header and a separate
  response token, both kept in browser session state;
- post-login adapter traffic uses `POST /SFC/app/{adapter}/{procedure}` with a
  session token in `Authorization`, a JSON request body, and a response-header
  token that rotates for subsequent calls;
- CSV export is a separate authenticated POST to
  `/SFC/adapters/IFAI_CsvDownloadAdapter/csvDownload/getCsv`, carrying the
  session token plus account/date selection.

One successful sample established the token transition: the login JSON token is
the initial `X-CSRF-Token`; `securityConnect` and `validateToken` reuse the login
authorization; `validateToken.header.newToken` becomes the CSRF token for the
next serialized request. Any later known response may carry another `newToken`,
so the implementation replaces it atomically before continuing. No token value
is stored in this repository.

The same capture confirms that `securityConnect`, `validateToken`, both top
reads and `getExchangeRate` have no request body. `getYenDepositAccount` uses
only `{requestParam:{screenGroupID}}`; the observed read-only screen value is
encoded as a fixed request builder rather than exposed through a generic caller.

Initial navigation and Akamai sensor execution established the browser cookie
jar before credential submission. Successful login added the application load
balancer/session cookies, while the observed client created `_sb.pcd` after
`securityConnect`. The official client also emits `sendActivityLog`; Kogane does
not allowlist that telemetry/write-like procedure. If the client-side cookie is
proved mandatory for validation, automation should reuse the official bootstrap
inside the same page rather than invent its value.

This proves more than a generic Akamai edge. The login is coupled to multiple
device/risk signals, and the JSON adapters depend on a rotating authenticated
token. It still does **not** prove that those risk libraries reject automation,
that every signal is mandatory, or that a direct HTTP client cannot reproduce
the accepted read-only flow. It does show why a bare username/password POST is
not a sufficient first implementation. It also changes the preferred collector
classification: current post-login reads should target the official JSON adapter
transport, with CSV/PDF retained as raw evidence, rather than scrape rendered
HTML tables.

The authenticated Kuebiko run observed HTTP 200 for the following read families:

| Adapter family | Observed procedures |
| --- | --- |
| `IFCM` | `securityConnect`, `validateToken`, `getExchangeRate`, `getApplicationInformationList` |
| `AIAI` | `getInboxList` |
| `AICM` | `getUiuxFlag` |
| `IFTP` | `getAccountsBalanceAndActivity`, `getBalanceSummaryAndStage` |
| `IFEM` | `getEmailAddress` |
| `AIYD` | `getYenDepositAccount` |

Public JavaScript names additional read-looking procedures. They remain
allowlist candidates until authenticated validation:

| Adapter | Observed read-looking procedures |
| --- | --- |
| `IFCM_CommonAdapter` | `getAccountInformationListDisplay`, `getProductDescription` |
| `IFAI_AccountAdapter` | `getAccountInformationOthersDisplay`, `getCasaAccountActivitySpecificPeriod` |
| `AIAI_AccountInfomationAdapter` | `getAccountList` |
| `AIYD_YenDepositAdapter` | `getYenProductDetails` |

Only sanitized field topology crossed into fixtures. The top read contains
`savingsDetails` and `activityDetails`; the yen-deposit read returns separate
arrays for savings/deposit/product/module families; the exchange-rate read
contains per-currency buy/sell/mid values. Unknown fields and unknown nested
item shapes fail before storage.

The current account screen distinguishes at least product code `601` for yen
ordinary savings and `603` for SBI Hyper Yokin. Foreign savings, yen time
deposits, foreign time deposits, structured deposits and loans are represented
as distinct arrays. These are client-side observations, not yet authenticated
response-schema guarantees.

The current activity controller receives `activityDetails` and performs local
pagination at 30 rows per page. Query fields include `accountNo`, `type`,
`fromDate`, `toDate`, `eventType` and optionally `accountActivityDetails`. The
CSV controller creates a UTF-8-BOM Blob from the authenticated response. A
collector must compare full returned row counts rather than mistake the 30-row
UI page size for a server/export limit.

Procedure naming is not an authorization or safety guarantee. The collector
must use an explicit allowlist of captured read procedures; everything else,
especially transfers, FX, deposit creation/changes, memo updates, settings and
registration procedures, is denied by default.

Minimum explicit write-deny examples from the current client include:

- `AIAI_AccountInfomationAdapter/editCasaAccountActivityMemo`;
- password, email, address, transfer-limit and My Number update procedures;
- transfer registration, confirmation, cancellation and beneficiary deletion;
- FX registration procedures;
- smartphone-authentication device registration/deletion;
- account opening and investment profiling.

Production code must not expose a generic `{adapter}/{procedure}` caller to a
scheduled job. Because `header.newToken` replaces the current token after a
response, calls must be serialized per session and the latest token persisted
atomically before the next request.

### CAFIS Brain `jsc` bootstrap: sanitized implementation contract

The successful Kuebiko sample makes the CAFIS part concrete without retaining
its output. The public application loads
`https://distribute.cafisbrain.com/cafisbrainriskcollector.js` from the login
index before the bank's
`/SFC/apps/services/www/SFC/desktopbrowser/default/js/controller/LG0001_login.js`.
The login view contains a hidden `input#dtokeninfo`, explicitly labelled in the
bank HTML as JavaScript-collected CAFIS Brain device information.
The exact public assets observed in this sample had SHA-256
`1fe49a16ff5a02d7bc9a82340c8bafb021c8b4b7814642186a3e377eb2cc4f3d`
(vendor collector) and
`8416c7d16d84c96f34b15aa3c6a0846b9c07e254cecf3292167a2181c957f426`
(bank login controller), so later drift can be distinguished from analysis
error without archiving authenticated traffic in this repository.

The bank controller performs this sequence during controller initialization:

1. `CAFISBrainRiskCollector.init({clientChannel: "CBRU"})`;
2. `CAFISBrainRiskCollector.getDeviceTokenInfoV3({submitEvent, inputEL})`, where
   `inputEL` is `#dtokeninfo`;
3. on login click, read the hidden value into the `jsc` request field;
4. if the hidden field is still empty, use the literal client fallback `aaaa`;
5. submit `jsc` with the other login fields to
   `login_auth_request_url`.

The successful captured login had a present, non-empty `jsc` and did **not** use
the literal fallback. No value or length is recorded here. The fallback proves
only that the public client tolerates collector failure long enough to send a
login request; it does not prove that the server accepts that request. Do not
turn it into an authentication retry strategy.

Deobfuscating only the public SDK's exported wrapper gives the following API
contract:

- exports are `init`, `getDeviceTokenInfoV3` and `getSDKVer`;
- `init(options, callback)` accepts `clientChannel` as a string and maps it into
  the SDK client/channel configuration; the bank uses `CBRU`;
- `getDeviceTokenInfoV3(callback, option)` accepts a callback overload. The
  second argument defaults to `true`; its semantic name is not exposed by the
  wrapper, so an implementation should omit it instead of guessing `false`;
- the successful callback model contains at least
  `{deviceTokenInfo: string}`. The object overload is just a DOM adapter: it
  calls `submitEvent.preventDefault()`, invokes the same version-3 collector,
  assigns `result.deviceTokenInfo` to `inputEL.value`, and calls
  `submitEvent.target.submit()`;
- a synchronous module-start failure is converted through the SDK's
  `buildDetectInfoM` error model. Code must treat a missing/non-string
  `deviceTokenInfo` as failure and must never log the result.

The callback overload is the stable integration point for automation; it avoids
depending on the bank controller's unbound global `event`. In a real page, the
minimum safe bridge is conceptually:

```js
await page.evaluate(() => new Promise((resolve, reject) => {
  CAFISBrainRiskCollector.getDeviceTokenInfoV3((result) => {
    const value = result?.deviceTokenInfo;
    if (typeof value !== "string" || value.length === 0) {
      reject(new Error("CAFIS device token was not generated"));
      return;
    }
    document.querySelector("#dtokeninfo").value = value;
    resolve(true); // never return the value across the browser boundary
  });
}));
```

Production automation should first wait briefly for the bank controller to
populate the hidden field and call the callback overload only if it remains
empty, so one login does not create needless duplicate risk requests.

In the same successful sample, the SDK made CORS preflights and JSON POSTs from
the bank origin to these public CAFIS endpoints, in this observed order:

1. `https://diproxy.cafisbrain.com/data/1938/forward`;
2. `https://diproxy.cafisbrain.com/data/1941/forward`.

Both returned HTTP 200 before credential submission. Their request envelopes
have the shape
`{req:{content,channel,token,version,type,timestamp}}`; `content` is an opaque
string produced by the vendor SDK. The first response includes risk-result and
client-info fields, while the second includes control/signing fields. No request
or response value is transcribed. The captured diproxy requests had no HTTP
`Cookie` header, and no CAFIS/diproxy-named local- or session-storage entry was
found in this sample. That is evidence about one execution, not a promise that
all SDK branches are stateless. The bank page's origin, DOM and browser state
still feed the collector.

Decoded string references in the public vendor bundle show probes or support
for all of the following browser surfaces: `navigator` user agent and UA data,
language/platform, screen geometry/orientation/pixel ratio, timezone, touch and
motion, hardware concurrency, device memory, plugins/MIME types, cookies,
local/session storage and IndexedDB, canvas, WebGL renderer/vendor/parameters,
audio, fonts, media-device enumeration, permissions, performance, WebDriver
markers, `Worker` and `SharedWorker`. This inventory does not prove that every
probe is used in the `CBRU` version-3 path, but it explains why the opaque
`content` is not equivalent to a small documented JSON payload.

#### Runtime fit for generating `jsc`

| Runtime | Can run the public SDK faithfully? | Implementation decision |
| --- | --- | --- |
| Plain Cloudflare Worker isolate | No. It has `fetch`, but not a page DOM, Chrome canvas/WebGL/audio/font/plugin surfaces or the browser worker/storage environment expected by this collector. | Do not port the minified collector or synthesize its opaque encrypted `content`. A direct POST to diproxy is not an equivalent client. |
| Bare Node.js or DOM shim | No for production. A shim can expose the three wrapper methods but produces synthetic/missing fingerprint inputs. | Use only for static wrapper inspection, never for authentication. |
| Cloudflare Browser Run | Yes at the API level: it supplies a managed Chromium controlled from a Worker through Puppeteer/Playwright. | Bounded trials timed out before CAFIS became ready and before any credential POST, so it is no longer the active PoC runtime. |
| Cloudflare Container + Chrome | Yes, with a full browser and more control over profile, flags and proxy/egress. | Current deployed PoC runtime. Direct APAC egress returned login 403; the same image completed a full live run through the allowlisted TAMIA/VPC relay path. |
| OCI/Kubernetes + Chrome/Playwright | Yes, with the most control over the browser build, persistent volume and egress. | Operational fallback, not needed until both direct fetch and Browser Run have a bounded result. |

Cloudflare officially exposes Browser Run as a Chromium browser binding with
[Puppeteer](https://developers.cloudflare.com/browser-run/puppeteer/) or
[Playwright](https://developers.cloudflare.com/browser-run/playwright/) and
supports [reconnectable sessions](https://developers.cloudflare.com/browser-run/features/reuse-sessions/).
Its Puppeteer documentation also states that changing the user agent does not
bypass bot protection and Browser Run requests remain bot-identified.
[Cloudflare Containers](https://developers.cloudflare.com/containers/) run
arbitrary Linux images alongside a Worker and are available on the Workers Paid
plan. These runtime facts support the matrix; they do not predict the bank's
risk decision.

The implemented validation path is now:

1. scheduled Worker starts one isolated Container and opens the official login
   page in its browser;
2. wait for the public CAFIS object and a non-empty hidden field; if necessary,
   invoke the callback overload once and assign the result only inside the page;
3. fill and submit the official login form in that same browser context, with
   request/console logging redacted before credentials are introduced;
4. stop on any challenge, non-success auth state, 401, 403 or 429; never fall
   back to repeated `aaaa` submissions;
5. issue only the explicit read allowlist from the authenticated page context,
   so its cookies and browser risk state remain coupled to the session;
6. return only the bounded validated-read envelope to the Worker, then destroy
   the Container; retain scheduling, validation and R2 storage in the Worker.

An optimized hybrid that extracts `jsc` from Browser Run and performs login in
a plain Worker is not the first implementation: `jsc` is only one of Akamai,
ThreatMetrix, Transmit and browser-session signals, and moving it across contexts
breaks the exact accepted topology. Optimize the browser away only after one
bounded local direct-client test proves which inputs are actually optional.

The PoC's preferred local path now keeps CAFIS generation, credential submission,
Authorization/CSRF state and all serialized reads inside the same Chrome target.
Only the four validated read JSON bodies cross the CDP boundary. A separate
hybrid implementation exists only as a diagnostic; it is not the production
path because moving `jsc` to another HTTP/TLS context may break risk binding.

An initial bounded automated login stopped with `authStatus=failed` because the
client used the guessed language code `JPN`. Sanitized comparison with the
successful browser request isolated the correct adapter value as `JAP`; all
credential fields, mode, post-login flag, forward value and user agent matched.
The client was corrected and did not retry automatically. This was an
implementation-contract error, not evidence that Akamai rejected automation.

The corrected Kuebiko same-context run then completed login, `securityConnect`,
`validateToken` and all four core reads with HTTP 200. This is the positive
control for the implemented orchestration; it proves neither Browser Run nor a
Linux Container is accepted.

Subsequent cloud-runtime comparisons established a narrower boundary. Browser
Run timed out before CAFIS was ready on both the official-entry and direct-login
routes, and made no credential-bearing login POST. The first Container image
had a local startup defect (`xvfb-run` prevented the Node service from
listening); running Node as PID 1 and starting Xvfb internally fixed that
defect. With the service reachable, local stable-Chrome Container trials
received HTTP 403 at login for plain Linux, Windows-matched UA/platform/client
hints, and those hints plus hidden `navigator.webdriver`/disabled
`AutomationControlled` when login was reconstructed with direct fetch.

The final local comparison used Docker, stable Google Chrome, its native Linux
fingerprint and a Japanese egress while NRT/WARP was connected. Direct-fetch
login returned HTTP 403 both before and after a late CDP attachment. Patchright
did not reach login because its main-world execution left the CAFIS collector
unavailable. With the same late-CDP Chrome, continuously filling the real form
and activating its submit control invoked the bank page's own `login()` path and
returned HTTP 200. The page automatically issued `securityConnect`; the
Container retained login Authorization and initial CSRF in that same page, then
explicitly ran `validateToken` and the four allowlisted core reads. All four
reads succeeded. A subsequent Cloudflare deployment reproduced the complete run
through the scoped TAMIA/VPC relay path described below.

The deployed route is Container-local HTTP CONNECT to an authenticated Worker
WebSocket `/tcp`, then a Worker VPC binding configured with TAMIA's explicit
`tunnel_id`. It is independent of the user's personal WARP hostname routes. The
relay accepts only TCP 443 for `bk.web.sbishinseibank.co.jp`,
`www.sbishinseibank.co.jp`, `distribute.cafisbrain.com`,
`diproxy.cafisbrain.com` and `platform-websdk.transmitsecurity.io`. The APAC
Container using direct egress and no TAMIA path returned login HTTP 403 after
the new image was active.

Live run `0e999a32-6994-450e-a495-2daff0e7aeb1` completed successfully with
zero failures and five artifacts (four raw plus one normalized). Metadata-only
verification found all hashes valid, all byte counts positive and the Container
instance inactive after the run. No artifact body, balance, transaction,
credential, cookie, Authorization or CSRF/token value was read during this
verification. Earlier failure manifests are retained for two rollout
cold/listen failures, one direct-Container login 403 and two old-response-shape
failures while the TAMIA image revision was rolling out.

### Unconfirmed inference

It is plausible that Akamai WAF/bot controls, TLS/client fingerprinting,
JavaScript telemetry, CAFIS/ThreatMetrix/Transmit risk decisions, IP reputation
or rate limits affect non-browser/cloud clients. The Akamai sensor asset is
stronger evidence than DNS alone, but it still does not identify the exact
product/rule or show which signal caused the command-line timeout.
The corrected Kuebiko same-context run and the native-Linux real-form local
Container run are accepted, while direct-fetch login remained 403 before and
after late CDP. Windows fingerprinting is therefore not required in the
accepted local topology, and network location alone cannot explain the 403/200
split because both local paths shared the same Japanese egress. This does not
prove that an overseas egress would be accepted. Late CDP alone is also
insufficient; the successful implementation passed through the bank page's own
form/login processing. The exact internal difference from direct fetch remains
unisolated. The collector must stop on
401, 403, 429, login redirect, challenge or non-success auth state and must not
automatically retry.

## Existing third-party implementations

Repository/code search refreshed on 2026-08-31 found no current unofficial
client for the 2026 Web adapter or app/FIDO stack. A GitHub code search for the
current `sbishinseibank.co.jp/SFC` host found only this assessment. The useful
public historical/CSV evidence is:

| Project | Last activity observed | Implementation confirmed in code | Reuse value |
| --- | --- | --- | --- |
| [`rlan/beancount-multitool`](https://github.com/rlan/beancount-multitool/blob/d135cdb2775421d587656b4024e3a5f33841dbd7/src/beancount_multitool/ShinseiBank.py) | 2025-10 | Reads a user-supplied official CSV with Japanese or English headers and parses date, description, debit, credit and balance. It does not log in. | High as a CSV-shape hint; copy no schema assumption until a 2026 export is checked. |
| [`t-bucchi/accagg`](https://github.com/t-bucchi/accagg/blob/3bb5786a84387795ffaa1bdd4f0ab7d22bb72708/accagg/bank/shinseibank.py) | 2021-03 | Selenium/Firefox browser automation, DOM table parsing and pagination against the pre-brand URL; requests a two-year period. | Architectural precedent only. Selectors, URL and authentication are stale. |
| [`knshiro/shinseibank-ruby`](https://github.com/knshiro/shinseibank-ruby/blob/45099a9262a78aa56df87795e116756e86015c99/lib/shinseibank.rb) | 2017-07 | Direct form POSTs to the old `MfcISAPICommand` application, parses JavaScript variables, keeps a server session ID, requests accounts, downloads a tab-separated statement and reads transfer statuses. Login requires the retired security-code card model. | Strong evidence that an old internal API existed; not a present client. Do not revive transaction methods. |
| [`apparition47` userscript](https://gist.github.com/apparition47/e8671954c614385b78ed9e8b2cde98e6) | 2018-06 | Browser userscript that fills the old login/security-card form. | Obsolete and unsafe for current credential handling. |

The old Ruby client is especially important for classification: it is neither
an official Open API client nor simple HTML scraping. It called the legacy
internet-banking application's internal form protocol and parsed response-side
JavaScript. That protocol, URL and authentication scheme predate the current
PowerDirect site. Its write methods are outside Kogane's scope and must never be
used for validation.

## Automation and runtime fit

| Route/runtime | Fit | Cost (1 low - 5 high) | Decision |
| --- | --- | ---: | --- |
| Visible local/physical Chrome + official CSV/PDF | High | 2 | Best initial evidence path. User logs in; collector performs only verified read/download navigation. |
| Persistent local browser automation | Medium-high | 3 | Promising if read-only login and downloads repeat after restart; requires safe secret delivery and session tests. |
| Official PowerDirect API as a contracted provider | Potentially high | 5 | Most supportable long-term route, but availability/fields/contract are unknown and onboarding is disproportionate for the first personal prototype. |
| Cloudflare Workers isolate | Low for login | 3 | The JSON reads fit Workers after bootstrap, but direct-fetch login returned 403. Keep the accepted login/browser state in Chrome; use the Worker for scheduling, relay policy, validation and storage. |
| Cloudflare Containers with Chrome + scoped TAMIA/VPC relay | High for current PoC | 4 | Deployed Worker/Container/R2/Cron completed one live run with four raw and one normalized artifact. Direct APAC Container egress still returned login 403. |
| OCI VM or Kubernetes with Chromium + encrypted persistent volume | Medium-high | 4 | Best cloud control over browser, storage and egress, but operationally heavier. A stable IP does not guarantee Akamai acceptance. |
| Reverse-engineered Android app API | Low | 5 | FIDO/device binding, app attestation/pinning risk and rapid drift. Static inventory only; not the recommended collector. |

The accepted unattended architecture keeps the official form/login path and
session bootstrap inside Container Chrome, sends only the five exact HTTPS host
families through the authenticated TAMIA/VPC relay, and leaves scheduling,
relay policy, strict validation and R2 storage in the Worker. A plain Worker
login and direct Container egress are not current fallbacks because their login
attempts were rejected. OCI/Kubernetes remains only an operational alternative
if repeat Cloudflare runs become unreliable.

## Proposed validation plan

All steps below are read-only and use the customer's account only with redacted
capture/logging rules.

Current checkpoint: visible Chrome and Kuebiko logins plus sanitized core schema
capture are complete, and the corrected same-context client has completed all
four core reads. Browser Run stopped before CAFIS without an authentication
POST. The initial Container listen defect is fixed. Native Linux stable Chrome
then completed login and four reads locally when the actual form invoked the
bank page's own login path; direct fetch remained 403 before and after late CDP,
and Patchright left CAFIS unavailable in the main world. The deployed TAMIA/VPC
relay path then completed one metadata-verified live run. Repeat reliability,
CSV/PDF validation and session lifetime remain open.

1. Completed: dedicated visible Chrome/Kuebiko login. Record sanitized
   host/path, adapter/procedure, field names,
   status/content type and token-rotation topology; exclude authentication
   values, cookies/tokens, account identifiers, customer name and amounts.
2. Enumerate the labels and stable product identifiers, if any, for 円普通預金,
   SBIハイパー預金, every held yen time-deposit family, each foreign-currency
   savings account and every held foreign-currency time deposit. Store a
   synthetic/redacted fixture only.
3. Export a small period and the maximum allowed period for yen savings, Hyper
   Yokin if a CSV control is present, and one foreign-currency savings account.
   Determine encoding, delimiter, headers, row order, pagination, duplicate
   behavior, maximum rows and whether every visible row appears in the file.
4. Open the latest electronic transaction report and one older month. Verify the
   PDF's month, product-balance sections and ordinary-account fields, then store
   only checksums/schema notes for the investigation. Do not commit the PDF.
5. Compare the same Hyper Yokin date range in app and web, including any
   next-business-day settlement row, without recording values. Define explicit
   `as_of` and effective-date handling before parsing.
6. Build an explicit read allowlist from the observed top/common/account/yen
   adapters. Capture the login risk-bootstrap ordering, session token issuance,
   response-header token rotation, balance list, product list, period query,
   CSV download and PDF navigation. Preserve no live values.
7. Replay one allowlisted balance or activity call in the same authenticated
   browser context and compare it with the UI. Then implement the same call in a
   local direct HTTP client. Stop rather than guessing if the risk bootstrap or
   token transition is incomplete.
8. Measure idle timeout, browser-restart survival and one same-host session
   replay. Then run one bounded WSL/OCI/Cloudflare Container validation with an
   already established read-only session. Stop at the first login redirect,
   401, 403 or challenge; do not submit credentials repeatedly.
9. Separately acquire the current Play-delivered split APK set from the user's
   registered/authorized device and perform static endpoint/library inventory.
   Archive binaries/decompiler output only in the private analysis repository;
   publish the reproducible procedure and sanitized findings here. Do not hook
   biometrics, bypass device checks or exercise transaction APIs.
10. If a supported direct API is still desirable, contact the bank's published
   retail API channel for documentation, sandbox/onboarding conditions, exact
   balance/product/history coverage, consent lifetime and read-only scope. Keep
   this track independent of aggregator ingestion.

## Open questions

- Does the 2026 desktop CSV include SBI Hyper Yokin directly, or only yen and
  foreign-currency ordinary savings activity? The public matrix confirms the
  Hyper history screen but not a Hyper-specific CSV button.
- What are the exact 2026 CSV headers, encoding, maximum export size and row
  ordering after the account-activity redesign?
- Which product identifiers, maturity dates, rates, principal values and status
  fields appear in yen/foreign time-deposit holding details?
- Are there pending/reserved markers outside the dedicated transfer-status
  view, especially for internal transfers and scheduled maturity actions?
- What are the exact session idle/absolute lifetimes and same-account concurrent
  session rules?
- Does an authenticated session survive transfer between local Chrome and a
  Linux browser/container, and does the Akamai edge permit a cloud replay?
- Which endpoints are native-app-only, web-backed, pinned or device-attested in
  the current Play build?
- Can Kogane qualify for the official API program, and does that API expose SBI
  Hyper Yokin and detailed time-deposit holdings rather than only ordinary
  account balances/activity?

Until these are answered, implementation remains an official Web collector with
the browser security boundary intact. The mobile app API is not the first
collector path.

## Implementation status (2026-08-31)

[`poc/sbi-shinsei-worker`](../../poc/sbi-shinsei-worker/) now contains an
isolated local Chrome collector and a Container/R2/Cron collector. It does
not depend on Mnie. The local CLI accepts credentials through stdin or a
private mode-0600 file. Both paths keep CAFIS/session material inside one
browser page and hand off only four validated read JSON bodies. The corrected
local run completed login, bootstrap and all four core reads. The cloud resources
have been provisioned for bounded validation, but Browser Run did not reach an
authentication POST. The real-form Container topology now succeeds in local
Docker with native Linux Chrome. The deployed APAC Container failed with direct
egress but completed a live run through the exact-host TAMIA/VPC relay. Captured
core routes have strict
synthetic fixtures and response validators; bundle-only and direct-HTTP routes
remain unreachable. See the PoC's
[`INVESTIGATION-2026-08-31.md`](../../poc/sbi-shinsei-worker/INVESTIGATION-2026-08-31.md)
for the evidence boundary and enablement checklist.

The deployed schedule is `0 21 * * *`. Teardown inventory is the active Worker,
the SBI credential/admin-trigger/relay secrets, the R2 bucket containing the
success and retained failure manifests/artifacts, the Container application and
image revisions, and the explicit-tunnel VPC binding configuration. The local
Docker test Container/image should be removed after validation; the cloud
resources remain active for scheduled collection and evidence retention.

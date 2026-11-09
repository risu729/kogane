# みずほ銀行 (Mizuho Bank): みずほダイレクト (Mizuho Direct) / みずほダイレクトアプリ (Mizuho Direct app)

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26

## 2026-09-13 direct-collector feasibility check

This follow-up tests a direct bank collector, not a user-export/import workflow.
Authenticated browser account and ordinary-deposit history reads succeeded.
The historical research below predates this follow-up.

- The official login page opened successfully in the Codex in-app browser at
  approximately 14:47 JST. It displayed the customer-number field `txbCustNo`
  and the disabled Next button before any identifying input.
- An unauthenticated WSL HTTP client received HTTP 200 with the explicit
  unsupported-browser text and `SERVICE Unavailable:50020`. A separate web
  retrieval returned maintenance code `50010`. These are observations of
  different request environments, not evidence of a general bank outage.
- The public bootstrap still supplies a bank-selected `webX.ib.mizuhobank.co.jp`
  base and the public form/JavaScript framework described below. The public
  scripts inspected in this follow-up did not establish WebAuthn support.
  The current [official login FAQ](https://www.faq.mizuhobank.co.jp/faq/show/10035?site_domain=default)
  describes customer number, password and a conditional first PIN.
- `experiments/mizuho-direct` contains a bounded, unauthenticated entry probe.
  Its output is diagnostic metadata only. It cannot authenticate, collect
  balances or transactions, or establish that a Worker runtime is supported.
  The observed ordinary-deposit parsers are promoted to `packages/parsers`;
  their fixtures are synthetic.
- Its one live Bun invocation returned HTTP 200, 5,817 response bytes and
  `unsupported-environment-50020`, with no redirects or recognized login form.
  No identifying input, authenticated request or credential retry was made.
- Authenticated reads were observed with Kuebiko 1.3.0 and its dedicated Chrome
  Beta profile. Login completed through the official bank page; the collector
  reused the resulting session without implementing password submission.
- Unchecked notices were passed without changing notification preferences.
  Account enumeration returned an ordinary-deposit account, and its account
  card opened the `入出金明細` ("deposit/withdrawal statements") page. Kuebiko saved the corresponding HTML and
  requests. These observed reads use authenticated HTML form POSTs; no JSON API
  is needed for these two surfaces.
- Account-list navigation uses `/servlet/MENSRV0100002B.do`, returning form
  `BALINQ_03010B`. The ordinary-deposit card uses
  `/servlet/BALINQ0301002B.do` with the account `_SUBINDEX`, returning history
  form `ACCHST_04110B`. Shared navigation fields are `_FRAMEID`, `_TARGETID`,
  `_LUID`, `_TOKEN`, `_FORMID`, `_SUBINDEX` and `POSTKEY`. Tokens and session
  cookies must come from the current session, not checked-in examples.
- Account fields have indexed IDs `txtAccType_`, `txtBrnch_`, `txtAccNo_`,
  `txtCrntBalBrrwBal_` and `txtCrntBalBrrwBalCrenCode_`. History rows use
  `.box-row-tx-ditails`, `txtDate_`, `txtTransCntnt_`, a signed amount and
  `txtEachBal_`. The balance element is repeated for desktop/mobile rendering
  and must be deduplicated within each row. `txtDispDetails` and
  `txtAllDispDetails` expose displayed/total counts.
- Both offline parsers passed against the private captured pages. Discovery
  contains a branch-code/account-number pair; history shows only the account
  number and branch name. Signed history amounts include a space after the
  sign. Synthetic regression fixtures cover those observed differences.
- Raw captures stay local and private; credentials, cookies, account identifiers,
  personal amounts and captured bodies must not enter this repository.
- A one-off Python HTTP client in WSL reused the fresh browser session and
  history form to request the observed account-list route. It followed one
  same-origin, same-path POST/redirect/GET sequence and received HTTP 200,
  20,092 response bytes and one account card. No password was resubmitted.
  The first attempt stopped at the redirect because its origin comparison
  incorrectly distinguished explicit HTTPS `:443` from the default port. The
  observed redirect established equivalence; after a fresh browser read, the
  corrected check succeeded. Other origins, paths and ports remain rejected.
  This verifies local session portability for this account-list read only.
- After integration, the production TypeScript client was exercised once from
  WSL with a newly authenticated browser session. Both account-list and
  ordinary-history POST/redirect/GET reads succeeded (four requests: 302, 200,
  302, 200), returning two sanitized evidence artifacts without partial results.
  The client did not submit a password, write to the bank or persist live data
  to Kogane during this validation. Shared ingestion/projection is tested with
  synthetic data, including real local Workers/R2 semantics.

`services/collector-mizuho` integrates password login, the direct read client,
sanitized evidence persistence, shared parsers, and existing projections.
It runs daily at 06:25 JST: the Worker has no Cron trigger, and the
Processor's alarm job `mizuho-bank` (`25 21 * * *` UTC in
`config/alarm-jobs.json`) calls its private `ScheduledCollection` entrypoint.
Its `runOperation` method would run the same path under the same lease, but the
Processor's `OPS_COLLECTOR_DISPATCH_CONNECTIONS` does not name `mizuho-bank`,
so an operations-API request for it waits and expires after 24 hours
([current status](../current-status.md)).
Public HTTP offers only `GET /health`: `POST /trigger` and the explicit
browser-session request were retired with the collector admin routes and answer
404 ([ADR 0069](../adr/0069-collector-admin-retirement.md)). Customer number and
login password are provisioned as Worker secrets out of band; neither enters
CI/CD, evidence or response logs.
Each invocation attempts login once and stops on additional authentication;
scheduled retries are disabled. The normal production release includes the
Worker and health postcheck. A successful health check alone does not establish
authenticated bank access; that is established by the daily scheduled runs,
which have registered in production since 2026-09-24. Pagination still requires its
own observed-transition validation.

The bank app was renamed to みずほ銀行アプリ (Mizuho Bank app) on 2026-09-03; historical app names
below describe the original research. The
[current service page](https://www.mizuhobank.co.jp/direct/about/service/balance.html)
and [login guidance](https://www.mizuhobank.co.jp/retail/products/direct/goriyo/loginout/n00000.html)
are the current starting references.

## Empty history page (2026-11-09)

Every daily run from 2026-11-01 failed the ordinary-account history unit
([issue 1145](https://github.com/risu729/kogane/issues/1145)); the first run
after [PR 1115](https://github.com/risu729/kogane/pull/1115) (fetch run 1481,
2026-11-08 21:25 UTC) named the check `parse-unrecognized-empty-state` and kept
the sanitized page. That page is the history form `ACCHST_04110B` with only the
account header (`txtBrnch`, `txtTransType`, `txtAccNo` and a `span.amount`
holding only the currency mark, the same header a populated page has) and no
transaction block at all: no `.box-row-tx-ditails` row, no `.t1-2` amount
column, no `txtTransCntnt_`, `txtDate_` or `txtEachBal_` field, and neither
`txtDispDetails` nor `txtAllDispDetails`. The last populated capture (fetch
run 1258, 2026-10-30) held one row dated 2026-08, so a display window that no
longer reaches it gives this page. The provider's empty-state wording is not in
the sanitized capture (the sanitizer keeps only the listed fields), so it is
not part of the rule: a provider notice that kept the header and dropped the
block for another reason would read the same. Telling those apart needs a
structure-only outline of the raw page, which the collector does not keep.

`parseHistoryPage` returns this page as `state: "empty"`,
`displayedRange: null`, `transactions: []` (a listed page is
`state: "listed"`). Any part of the transaction block without rows (a
displayed range such as `0 - 0 件`, an amount column or a row field) is still
refused as `unrecognized-empty-state`. The collector stores the page as
`ordinary/<branch>-<account>/history/empty.html`, unit
`ordinary:<branch>:<account>:page:empty`, not `partial`; the
`mizuho-ordinary-history` parser (1.1.0) accepts that unit only for the empty
state and emits no transaction and one complete-container claim with
`observedCount: 0`, `expectedCount: null` (`complete-empty`). A listed page
under the empty unit, or the empty page under a range unit, is refused as
`artifact-page-range-mismatch`. `mizuho-account-list` moves to 1.0.2 only
because the shared module's code digest changed; its output is unchanged.

## Conclusion

- **Recommended authoritative source: official Web Mizuho Direct**. Account enumeration/balances use authenticated HTML;
  ordinary/savings/foreign-currency ordinary statements combine recent three-month HTML/PDF/CSV with up to 10 years
  of `みずほダイレクト通帳` (Mizuho Direct Passbook) PDF/CSV if already enrolled.
- みずほグローバル口座 (Mizuho Global Account), ordinary yen/foreign-currency time deposits, installment time deposits
  are not ordinary-deposit transaction tables. Retrieve currencies, placement details, maturities, rates, etc. as
  **deposit lots** from official balance screens; cancellation/renewal history for the past year, receipt results separately.
- Continued app use accumulates statements older than three months locally and shows per-transaction balances.
  Device-local storage, migration handoff, biometrics, root/modified-device restrictions apply. Use for **official Web
  authentication/display verification and the Mizuho Point Mall entry**, not primary cloud collection.
- みずほポイント (Mizuho Points) is current. The app `P` mark leads to the bank's `みずほマイレージクラブ専用ページ`
  ("Mizuho Mileage Club exclusive page") for balances, accrual/use history, expiry. Retention/pagination/machine-readable
  fields are not established by public material alone.
- Public login remains Shift_JIS HTML forms using `JSESSIONID`, POST tokens, cookies/JavaScript, client environment
  values. Akamai edge/device fingerprint scripts established. Public JS shows dynamic `webX` host form POST,
  screen-event action switching, Dojo XHR with `POSTKEY`; no balance/statement JSON APIs on unauthenticated screens.
  No current working third-party client found; 2011–2021 implementations depend on old HTML forms/OFX, design references only.
- Owner reports using a Bitwarden-stored passkey, but public bank specifications/login on 2026-08-26 describe customer
  number/login password and conditional first PIN. Whether this passkey is for Mizuho Direct or means ordinary
  Bitwarden credentials is unverified. Do not assume Mizuho Direct WebAuthn/passkeys before live verification.

Overall: **ordinary/savings MVP 3/5; full version including time/foreign currency/Global Accounts/points 4/5;
fully unattended login feasibility 2/5; scheduled collection using existing official browser sessions 4/5**.

## Scope and non-goals

Only read-only direct routes from official bank Web/app for owner-held Mizuho accounts.

- Scope: Mizuho Direct, Mizuho Direct app, Mizuho Direct Passbook,
  Mizuho Global Account screens, official bank みずほポイントモール (Mizuho Point Mall)
- Candidates: account lists/current balances, ordinary/savings/foreign-currency ordinary statements,
  yen/foreign-currency time/installment/Global Account placements and readable history, Mizuho Points
- Non-goals: J-Coin Pay, みずほWallet (Mizuho Wallet), Smart Debit, みずほJCBデビット (Mizuho JCB Debit), MyJCB,
  card company points, other banks, securities, マネーフォワード (Money Forward) and other aggregators
- Safety: no transfers/account transfers/foreign exchange/time placements-cancellations/points exchanges/account additions-deletions,
  みずほe-口座 (Mizuho e-account)/Direct Passbook applications, authentication settings changes

This research did not log in to authenticated accounts; checked only public pages/login/code. Did not open
Bitwarden vaults or store secrets, personal identifiers, actual balances, authentication cookies.

## Research method

1. Researched current official service pages, FAQs, terms, guides, Google Play listings.
2. On 2026-08-26, retrieved only public entry points unauthenticated; checked DNS, HTTP headers, login forms,
   cookie attributes, delivered scripts in ordinary browser too. Statically examined JS form transport/client
   environment handling. No authentication requests/fictitious customer number inputs.
3. Searched GitHub Code Search for current/old clients, reading Ruby/Go/Perl by commit to distinguish browser,
   CSV/OFX, internal HTTP form use.
4. Kept unestablished official facts as future live checks, without extrapolating current specifications from third-party code.

## Official entry points and available data

| Official route         | Entry                                                                                                                                                          | Readable data                                                                                                                                                                      | Automation role                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Mizuho Direct Web      | [Official guidance](https://www.mizuhobank.co.jp/direct/index.html), [legitimate login URL guidance](https://www.mizuhobank.co.jp/crime/info110520.html)       | Registered accounts/current balances, ordinary-savings-foreign ordinary-card loan statements, time/installment/foreign time/Global balances-placement details, transaction results | Primary route, desktop CSV/PDF                                                                                                    |
| Mizuho Direct Passbook | [Official service](https://www.mizuhobank.co.jp/direct/about/service/directpassbook/index.html)                                                                | Older ordinary/savings/foreign ordinary statements saved after enrollment, up to 10 years                                                                                          | Primary structured backfill; check existing use only, do not enroll                                                               |
| Mizuho Direct app      | [Official features](https://www.mizuhobank.co.jp/direct/app/index.html), [Google Play](https://play.google.com/store/apps/details?id=jp.co.mizuhobank.banking) | Current balances/statements/per-transaction balances/local history/income-expense reports/points entry                                                                             | Manual checks/auth help; device storage/biometrics unsuitable for cloud workers                                                   |
| Global Account screens | [Official product](https://www.mizuhobank.co.jp/direct/about/service/global/index.html)                                                                        | Yen time/six-currency foreign time deposits, placements/reference yen equivalents/results                                                                                          | Collect dedicated screens separately from ordinary account lists                                                                  |
| Mizuho Point Mall      | [Official guidance](https://www.mizuhobank.co.jp/mmc/mizuhopointmall/index.html), [guide](https://www.mizuhobank.co.jp/mmc/mizuhopointmall/ebook/)             | Mizuho Points balance/accrual-use/expiry, みずほギフト (Mizuho Gift) balance/history                                                                                               | Bank-owned separate Web surface via app `P`; second stage                                                                         |
| Personal bank API      | [Bank API policy](https://www.mizuhobank.co.jp/company/activity/api/policy/index.html)                                                                         | REST/JSON/OAuth 2.0 balance/statement APIs established                                                                                                                             | Contracted electronic payment service providers; no public own-account developer token found, rejected under aggregator avoidance |

Legitimate public login URL: `https://web.ib.mizuhobank.co.jp/servlet/LOGBNK0000000B.do`. Official guidance
says post-login host changes to `webX.ib.mizuhobank.co.jp` according to load. Respect bank-returned origins/
cookie domains instead of pinning one host.

## Account enumeration and balance granularity

Official [balance/statements](https://www.mizuhobank.co.jp/direct/about/service/balance.html) and
[account registration FAQ](https://www.faq.mizuhobank.co.jp/faq/show/246?site_domain=default) give:

| Account type                                                             | Enumeration/balance units                                                            | Statement treatment                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary deposits (including comprehensive-account ordinary)             | Current balance by branch/account; primary/additional registered accounts            | Statements, recent downloads, Direct Passbook                                                                                            |
| Savings deposits                                                         | Current balance by branch/account                                                    | Same statements/Direct Passbook as ordinary                                                                                              |
| Time deposits (including comprehensive-account time)                     | Account totals/placement details                                                     | Current lots plus past-year cancellations/renewals; lots, not transaction ledger                                                         |
| Installment time deposits (including comprehensive-account installments) | Contracts/accounts/placements                                                        | Balances/placements/results; cannot enumerate through ordinary CSV alone                                                                 |
| Foreign-currency ordinary                                                | Account/currency; USD/EUR/GBP/CHF/AUD/NZD on Web                                     | Statements/Direct Passbook                                                                                                               |
| Foreign-currency time                                                    | Account/currency/placements; USD/EUR/GBP/CHF Web details                             | AUD/NZD time details unsupported on Web; verify eligible currencies for current/past-year cancelled-renewed lots live                    |
| Mizuho Global Account                                                    | Yen time/six-currency foreign time within one multicurrency account, by currency/lot | Dedicated balances/results; separate from ordinary foreign-currency accounts                                                             |
| Current accounts                                                         | Registrable                                                                          | Personal Web only describes as transfer/account-transfer withdrawal accounts, excluded from balance enumeration; read support unverified |
| Card loans                                                               | Contract/account                                                                     | Balances/statements; may exclude from MVP                                                                                                |

Global Accounts automatically become registered accounts on opening, not ordinary add-account screen targets.
Users with multiple customer numbers can add/switch them in official app. Do not assume one list is all accounts;
check the number of customer numbers used live.

Global Accounts hold yen time and six-currency foreign time deposits; screens show reference yen equivalents
using bank-published mid-rates. Store native amounts/currencies separately; do not treat reference equivalents
as book values or execution rates.

## Statements, downloads, retention

### Ordinary, savings, foreign-currency ordinary

- Ordinary Direct statements: first day two months before inquiry through today (current/previous/second preceding months).
  Paper passbook accounts may show older unrecorded entries too.
- If already enrolled in Direct Passbook with e-account, retain from first day two months before enrollment month
  through end of month three months before inquiry, up to 10 years. No retroactive older pre-enrollment coverage.
- Recent three months/Direct Passbook downloadable as Web PDF; PC browsers also CSV.
  Opens Web screens, not standalone app CSV.
- Older Direct Passbook statements lack per-transaction balances. App/recent statements show them, but older periods
  not retrieved in app show `残高表示期間外` ("outside balance display period").
- App fetches first day of second preceding month through now on startup, saving locally. Monthly use retains
  four-plus months; gaps possible when unused three-plus months. Uninstall/device change without handoff loses local history.
- Official FAQs do not publish display/download row limits. High-frequency pagination, PDF/CSV period limits,
  encoding/headers/column counts require live fixtures.

Public HTML/official description examples suggest at least dates, outflow/inflow, descriptions, recent
post-transaction balances. Prior-day-accounting transactions etc. may reorder same-day rows; do not use screen
order alone as stable IDs. Current CSV columns unestablished publicly; do not import third-party actual data samples into Git.

### Time, installments, foreign currency, Global Accounts

- Read current accounts/placements through `残高照会` ("balance inquiry") for time/installment/foreign time.
- Cancelled/renewed time/foreign-time details generally past year, but internet branch/e-account/leaf-type cancellation
  rates/interest etc. may be about three months.
- Ordinary `各種取引の履歴・明細` ("transaction history/details") offers latest 18 months/five entries for yen time,
  installment, foreign ordinary; latest five for foreign time. Receipt results, not deposit/withdrawal ledger.
- Global Accounts: opening/placement results latest 18 months/10 entries; other transaction types five each.
- Night/holiday foreign ordinary/time transactions may remain `受付済` ("accepted") until next business morning.
  Foreign-time openings/placements after 15:00 weekdays may affect balances/statements next business day or later.

Keep deposit ledgers with `posted_at` separate from operational statuses such as `受付済`/`取引成立` ("transaction
concluded"). Public ordinary statements have no pending authorization column; treat as posted ledgers.
Pending is relevant for results of user-initiated Direct time/foreign/Global transactions; read-only Kogane
observes existing transactions only.

### Official artifact comparison

| Artifact                         | Period/scope                                          | Granularity                                               | Recommended use                                         |
| -------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| Recent statement HTML            | About three months, ordinary/savings/foreign ordinary | Dates/descriptions/inflows-outflows/post-balances         | Incremental collection/latest balances                  |
| Recent statement PDF             | About three months                                    | Saved official display; exact columns need live check     | Audit/CSV comparison                                    |
| Recent statement CSV (PC)        | About three months                                    | Structured; encoding/headers/balance columns unverified   | Primary MVP transaction artifact                        |
| Direct Passbook PDF/CSV          | Older post-enrollment, up to 10 years                 | No per-transaction balances                               | Backfill/long-term audit                                |
| Time/foreign/Global balance HTML | Current placements                                    | Currency/principal/maturity lots; exact fields unverified | Current positions                                       |
| Time/foreign/Global result HTML  | 3–18 months or 5/10 entries                           | Operational history including acceptance                  | Supplement lot lifecycle                                |
| App local history                | Adds about three months each startup                  | Post-balances/income-expense categories etc.              | Gap detection/manual fallback; no raw DB extraction MVP |

## Mizuho Points

Mizuho Point Mall is a current official bank service requiring Mizuho Mileage Club membership, Direct app
use, and service activation.

- App home `P` mark leads to Point Mall.
- Mileage Club exclusive page shows points balances/accrual/use (Gift top-up timing/counts), Gift balances.
- Guide describes points accrual/use/expiry breakdowns and Gift accrual/use/expiry history.
- Points expire at 23:59 month-end 24 months after award month: 25 months including award month under terms,
  carried over when topped up to Gift.
- No public description of access solely from browser Direct home. Separate module from bank balance/statements
  as app-started bank-owned Web surface.
- Retention, row fields, pagination, CSV/PDF exports, scheduled expiry bucket granularity unverified.
  Only balance is an MVP candidate until live DOM/JSON observation.

Public evidence establishes only app home `P` → bank points page. Native API/WebView/external browser and
bank app session handoff by cookies/one-time codes unverified. In legitimate split static analysis enumerate
points deep links/hosts/WebView routes; owner-operated read-only observations retain only before/after origins,
methods/path templates/statuses. No queries/cookies/authorization/SSO codes/actual points; call no exchange/top-up endpoints.

Do not navigate to J-Coin, MyJCB, or card company points in this scope.

## Authentication and sessions

### Web

Official ordinary browser login:

1. Eight- or ten-digit customer number.
2. 6–32 half-width alphanumeric login password.
3. Four-digit first PIN if bank requires extra checks, such as unusual environments.

Second PINs, dedicated OTPs, five-digit SMS, email OTPs are mainly initial registration, app-version usage-card
setup, transactions such as transfers. FAQs do not say they are always required for ordinary balance/statement
login. Kogane does not enter writes; give collectors no second PINs/OTPs.

Unauthenticated observations on 2026-08-26:

- Shift_JIS HTML forms POST customer numbers to another `webX` host.
- `JSESSIONID`: domain `.ib.mizuhobank.co.jp`, `Secure`, `HttpOnly`.
- Forms contain POST tokens/form IDs/client environment fields; cookies required for screen handoff.
- Bank specifies automatic timeouts but does not publish idle/absolute minutes, concurrent sessions,
  cookie reuse, all-session invalidation on logout.

### Public Web JS and login transport

Opening [legitimate login](https://web.ib.mizuhobank.co.jp/servlet/LOGBNK0000000B.do) in ordinary browser issues
`JSESSIONID` on initial GET; HTML `base`/form actions point to load-balanced `webX.ib.mizuhobank.co.jp`.
Form `LOGBNK_00000B`, method POST, next `/servlet/LOGBNK0000001B.do`. Public field names excluding input values:

- Session/page handoff candidates: `_FRAMEID`, `_TARGETID`, `_LUID`, `_TOKEN`, `_FORMID`, `_SUBINDEX`
- Request/client candidates: `POSTKEY`, `CLIENT_ENV`
- First owner input: `txbCustNo` (customer number)

Statically examined common `EmfJScript.js`, `MizuhoJScript.js`, `common.js`, inline scripts. `doTransaction`
builds `/servlet/<ID>.do` from event IDs, updates frame/target/subindex, POSTs same form. `getClientEnv`
sets browser language etc. in `CLIENT_ENV`. `EmfJScript.js` also has Dojo `xhrPost` with `POSTKEY`, but established
public uses are invalid input/script checks etc., not balance/statement JSON transport. Login `rsa.js` is a
stub with `post_deviceprint()` returning true; its filename alone does not imply RSA encryption.

Separate-origin `directinfo.ib.mizuhobank.co.jp/fp/tags.js` loads with temporary per-page session/page parameters.
Together with official explanations, candidate device/browser risk signals; vendor, collected fields, scores,
shared app device binding unverified. Session identifiers themselves not recorded.

Current classification: **unauthenticated login uses cookie-based Shift_JIS form POST**, some helpers Dojo XHR.
Post-password pages, whether authenticated reads use only forms or also JSON/XHR, sessions beyond JSESSIONID,
and fingerprint binding need owner-operated read-only runtime metadata observation.

During live checks, enter owner-reported Bitwarden credentials through extension/user operation; emit no
values to Kogane, logs, captures, Git, PRs, container environment variables. No passkey/WebAuthn options found
on public login; first bounded check only whether Bitwarden fills passwords or presents WebAuthn prompts.

### App

- Initial registration uses primary account branch/account number/first PIN, personal information, SMS,
  login settings, six-digit app password or biometrics.
- Startup uses app password/biometrics; Android FAQ specifies fingerprints, not face.
- `ご利用カード（アプリ版）` (usage card, app version) shows transaction-varying second PINs after biometrics/app
  password; extra SMS may occur, not requested for read collection.
- Separate `キャッシュカード認証（残高照会のみ）` ("cash card authentication (balance inquiry only)") mode
  covers ordinary/savings, excludes time balances, requires re-registration after non-use. Unsuitable for complete enumeration.

## CDN, WAF, anti-automation

### Established facts

- `www.mizuhobank.co.jp`, `web.ib.mizuhobank.co.jp`, `web1.ib.mizuhobank.co.jp` resolve to Akamai;
  login CNAME `edgekey.net`, response `Akamai-GRN`.
- Generic command-line requests received `Server: AkamaiGHost` 403 on official `www`, but 200 on legitimate login;
  edge policies differ per host/path.
- Login loads `directinfo.ib.mizuhobank.co.jp/fp/tags.js` with session/page IDs, sends `CLIENT_ENV`.
  Official guidance describes login environment analysis/first-PIN step-up in unusual environments.
- Login/application responses no-cache, requiring HTML forms/cookies/JavaScript.

### Hypotheses/unverified

- Akamai Bot Manager/equivalent bot scores likely affect authenticated screens, but products/rules/headless
  detection/datacenter IP checks unverified.
- `fp/tags.js` likely device/browser fingerprinting; fields/vendor/scoring unverified.
- Correct tokens/cookies/fields in HTTP clients may suffice or actual browser JS may be required; unverified.
  Old HTTP-only scrapers do not establish current success.

Start with ordinary Chrome/bank-issued sessions and narrow read endpoints/artifacts incrementally rather
than immediately recreating login with bare Workers `fetch`.

## Android app, legitimate split acquisition, static/dynamic analysis

[Official app page](https://www.mizuhobank.co.jp/direct/app/index.html)'s
[Android distribution link](https://www.mizuhobank.co.jp/special/directapp/dl_android.html) redirects to Play
[`jp.co.mizuhobank.banking`](https://play.google.com/store/apps/details?id=jp.co.mizuhobank.banking&hl=ja&gl=JP).
Public Play on 2026-08-26: developer `MIZUHO BANK, LTD.`, version `5.30.0`, updated 2026-07-22, 1 million+
downloads. Provenance: bank link, Play developer, package. No direct official APK was found; do not use third-party APK mirrors because their provenance cannot be guaranteed.

Play listing/official FAQs establish:

- App balances/statements/income-expense reports/transactions; JavaScript/cookies required.
- Illegally modified devices may not start normally.
- Android app prohibits statement screenshots.
- Official support as of 2026-01-31: Android 15/16; unsupported devices/tablets not guaranteed.

Reverse engineering/deobfuscation/static analysis/owner runtime tracing are **current parallel research**.
Research environment lacked ADB, Android SDK tools, jadx/apktool, connected owner Android; no legitimate
Play-authenticated artifacts obtained. Reproducible procedure:

1. On compatible owner non-root Android, install via official Play route. Existing registered apps:
   no reinstall/data clearing to avoid changing server device registration.
2. With owner consent, use USB debugging and `adb shell dumpsys package jp.co.mizuhobank.banking` to record
   versionName/versionCode, installer, splits; `adb shell pm path ...` for base/split paths.
3. Only if shell-readable, `adb pull` base/all configuration-feature splits privately;
   record SHA-256/`apksigner verify --print-certs` signers, no Git binaries.
4. Stop on pull denial/app termination/device re-registration. No root, third-party mirrors, re-signing, bypass.

After acquisition, statically distinguish facts/candidates:

- Manifest: permissions/exported components/App Links/custom schemes/min-target SDK/backup-debuggable-profileable/
  native libraries/Network Security Config/cleartext policy.
- Transport/schema: hosts/paths/WebView/OkHttp-Retrofit/JSON-protobuf/API-model classes/downloads.
- Local long history: Room/SQLite/SQLCipher, SharedPreferences/DataStore, DB files/schemas/migrations/indexes,
  customer/account namespaces, last-sync cursors, transaction balances/categories, encryption/key candidates.
  Schemas only, no owner records/actual DB extraction-retention.
- Points: `P` deep links/hosts/WebView-external-browser/SSO-session handoff candidates.
- Auth/device: Android Keystore/BiometricPrompt/app passwords/device registration identifiers/session issuance-renewal/
  FIDO-WebAuthn candidates. Separate from owner Web Bitwarden/passkey claims.
- Integrity: Play Integrity/SafetyNet/root-debug-emulator detection/certificate pinning candidates.
  Strings/library presence alone does not establish active use; compare normal observations.

Owner-operated read-only traces open balances/accounts/recent statements/older local statements/time-foreign-Global/
`P` once each. Record only methods/origins/path templates/status/content types/call order/schema field **names**/
local DB-file **names**; discard bodies/cookies-tokens/device identifiers/account numbers/values at capture.
First try Network Inspector if profileable, normal proxy/PCAP metadata, filtered logcat. Frida/Objection hooks
may observe network/WebView/DB-open metadata only while official app works normally unmodified on owner devices.
Stop at root/debug/integrity/pinning termination; no root hiding/attestation spoofing/pinning disablement/
certificate replacement/repack/re-sign or other bypass.

### App/Web read coverage differences

| Read surface                         | Web                                                    | App                                                         | Automation conclusion                                              |
| ------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Ordinary/savings/foreign ordinary    | Balances/recent ~3-month HTML/PDF/CSV                  | Balances/statements/post-balances/local history             | Web artifacts authoritative; local app gap detection candidate     |
| Long-term statements                 | Enrolled Direct Passbook PDF/CSV up to 10 years        | Accumulates >3 months with use; non-use gaps/migration loss | Local DB valuable, not complete backfill                           |
| Time/installment/foreign time/Global | Dedicated balances/lots/results officially established | Native or Web navigation unverified                         | Resolve routes statically/dynamically                              |
| Exports                              | PC Web PDF/CSV                                         | Standalone app CSV unestablished                            | Web advantage for ingestion                                        |
| Mizuho Points                        | Desktop home entry unverified                          | `P` to official points page                                 | Important app read route; separate bank statement sessions/sources |

App long-history schemas/points routes merit research; official exports/reproducible long-term backfill favor
Web. Keep Web primary, using app research now for coverage/transport discovery.

## Third-party clients

No bank-only client established as supporting current official screens found.

| Implementation                                                                                  | Last functional update                                                | Method                                                                                                     | Current treatment                                                                    |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [`kimoto/mizuho_bank`](https://github.com/kimoto/mizuho_bank)                                   | 2012, MIT                                                             | Ruby Mechanize old forms/customer number/password/secret phrase; parses balance/history HTML               | Old endpoints/UI; design only                                                        |
| [`binzume/gobanking/mizuho`](https://github.com/binzume/gobanking/blob/master/mizuho/mizuho.go) | Login/history effectively 2018–2021, repo dependency update 2024, MIT | Go `net/http`, cookies, Shift_JIS, POSTKEY/form IDs; HTML balances/dates/descriptions/deposits-withdrawals | Similar form architecture reference, no current working evidence; never reuse writes |
| [`Finance::Bank::JP::Mizuho`](https://github.com/gitpan/Finance-Bank-JP-Mizuho)                 | 2011                                                                  | Perl LWP/cookies, old account lists/bank OFX download                                                      | Current official guidance only PDF/CSV; regard OFX retired, do not expect live       |

All directly send HTML forms/cookies instead of browser automation. This shows theoretical HTTP collection,
but includes old phrases/page IDs/OFX. Newly observe current forms, reimplement from read allowlists.

## Runtime suitability

| Platform                                     | Suitability                                    | Reason                                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kuebiko/ordinary Chrome + persistent profile | **Best**                                       | Official browser handles Bitwarden/user input/step-up/first PIN/downloads/Akamai-fingerprints; easier post-auth read automation                    |
| Cloudflare Workers                           | Login collector **low**, orchestrator **high** | Cookie HTTP/schedules possible, no ordinary Chrome/extensions/desktop downloads/biometrics; Akamai/datacenter compatibility unverified             |
| Cloudflare Containers / Browser Rendering    | **Medium**                                     | Playwright/persistent storage possible, headless-datacenter fingerprints/session persistence/encrypted downloads challenging; not first MVP choice |
| OCI VM/Containers                            | **Medium-high**                                | Easier ordinary Chrome/Playwright/fixed disks/secret brokers; domestic-Japan bank use assumption requires region/egress/use conditions checks      |
| OCI Kubernetes                               | **Medium**                                     | Scheduling/isolation easy, need stable browser profiles/no concurrent login; excessive for one-account MVP                                         |

Bank [supported environment](https://www.mizuhobank.co.jp/direct/goriyo/notice/index.html) explicitly assumes
use in Japan. Overseas/unfixed-region/changing-IP unattended login is not recommended for extra authentication/
suspension risks as well as success rates. Prefer Cloudflare/OCI for local/controlled Chrome scheduling,
encrypted storage, notifications, normalized APIs, not session issuance.

## Recommended architecture

1. Open legitimate login in user-controlled ordinary Chrome profile. Bitwarden stays user/extension-operated,
   no credentials to automation.
2. Reuse valid sessions, ask human reauthentication only on expiry. Encrypt cookies in OS-backed vaults,
   exclude from logs/D1-KV/Git.
3. Initial read allowlists only home/accounts, ordinary/savings/foreign ordinary balances/statements,
   CSV/PDF downloads.
4. CSV primary, HTML balances/discovery, PDF audit. Without stable IDs, provisional deduplication key from
   source/account pseudonym/date/amount/description/same-day ordinal, retaining raw artifact hashes.
5. Separate position collectors for time/installment/foreign time/Global lots;
   call no write controls/forms/actions.
6. Mizuho Points separate sessions/surfaces; observe legitimate `P` transition before balance/history collectors.
7. Cloudflare/OCI only schedules/locks/encrypted artifact receipt/normalization/monitoring;
   prohibit concurrent use of one profile.

## Next bounded verification

All owner-held accounts/read-only; redact values, retain only field names/shapes.

1. Check existing Chrome tabs/profiles, determine unauthenticated/authenticated status from legitimate URLs.
2. Resolve terminology: check only whether Bitwarden offers password filling/passkey prompts on Mizuho;
   no secret values.
3. After user login, measure idle/absolute lifetimes, restart cookie reuse, different-IP risk step-up,
   first-PIN conditions once each. No repeated login on failure.
4. Record home account types/currencies/masked identifiers/balances/available amounts/multiple-customer-number
   presence as sanitized schemas.
5. For ordinary/savings/foreign ordinary, download one HTML/PDF/CSV each over the same short period;
   compare encoding/headers/columns/order/count limits/pagination/post-balances/pending fields.
6. **If already using** Direct Passbook, compare one month PDF/CSV. Otherwise enrollment is a settings change;
   leave unverified without applying.
7. Open only held time/installment/foreign ordinary-time/Global types; record current lot fields/history-result
   field names/retention. No placement/cancellation buttons.
8. Follow app `P` to official points page; record origins/session boundaries/balances/accrual-use-expiry
   row fields/pagination. No top-ups/exchanges.
9. Compare only established public login field names/`LOGBNK...do` transitions in DevTools. Passively observe
   authenticated read methods/origins/path templates/status/content types/field names, classifying forms/JSON-XHR.
   Save no bodies/tokens/cookies/fingerprint values.
10. Obtain legitimate base/splits/signers/hashes from owner compatible non-root devices as above; statically analyze
    manifests/hosts/transports-models/local history/points/session-device-integrity-pinning candidates if obtained.
11. Owner operates existing registered app; observe read-screen network/local metadata once.
    No writes/app re-registration/request replay/secrets-PII retention; no bypass on pinning/integrity/anti-debug stops.
12. Compare Web/app same short period: counts/post-balances/categories/older local entries/gaps.
    Export no local records themselves, retain field names/aggregate differences only.
13. For seven days, once daily on same browser profile, retrieve only accounts/short statements, assessing Akamai
    blocks/session expiry/duplicates/gaps/rate limits to decide MVP method.

Success: after manual login, reproduce stable pseudonymous IDs/current balances/incremental statements/official
artifact hashes for all targets without entering writes. Stop for authentication setting changes, constant
read OTP/second-PIN requirements, root/pinning bypass, repeated locks, signs of bank suspension, or need
for non-owner information.

## Established facts, hypotheses, unverified items

### Established

- Web balance types: ordinary/savings/time/installment/foreign ordinary-time/Global/card loans;
  statements: ordinary/savings/foreign ordinary/card loans.
- Recent statements from first day of second preceding month; enrolled Direct Passbook up to 10 years.
  PDF/PC CSV available.
- Time/foreign-time cancellation-renewal history generally one year; Global results 18 months/10 or five entries.
- App stores locally, displaying >3 months with continued use, with gaps/device migration loss.
- Mizuho Points current, bank page offers balances/accrual-use/expiry.
- Browser login customer number/password, risk-based first PIN; Akamai edge/cookies/JS/
  client environment/fingerprint scripts.
- Official Android route redirects to Play `jp.co.mizuhobank.banking`, research-time version `5.30.0`.
- Unauthenticated Web issues `JSESSIONID` first, uses Shift_JIS POST to `webX`, page/session fields,
  `POSTKEY`, `CLIENT_ENV`, fingerprint tags; no balance/statement JSON API on public login.

### Hypotheses

- Once actual browser sessions obtained, balances/CSV/PDF likely automatable stably.
- App likely mixes native storage/Web screens; time/foreign/points likely WebView/external browser.
- Datacenter/headless traffic likely gets extra checks/blocks from Akamai/bank risk analysis.

### Unverified

- Whether owner-reported passkey is for Direct, current WebAuthn support.
- Idle/absolute lifetimes, portability, concurrent login, logout invalidation.
- Post-password/authenticated endpoints HTML-only or JSON/XHR too; current read forms/page IDs.
- Current CSV/PDF columns/encoding/per-operation periods-counts/pagination/stable transaction IDs.
- Stable identifiers/available balances/exact foreign-time lot fields for all types.
- Ordinary deposit pending statements; public specifications establish posted ledger only.
- Points history retention/row fields/exports/expiry buckets/session boundaries.
- Legitimate Android split versionCodes/signers/manifests/hosts/native-WebView/API-model schemas.
- Local DB schemas/migrations/encryption-keys, points origins/session handoff, device binding/session issuance.
- Bot Manager products, certificate pinning, Play Integrity/root/debug implementations.

## Main evidence URLs

- [Mizuho Direct](https://www.mizuhobank.co.jp/direct/index.html)
- [Balance/statements](https://www.mizuhobank.co.jp/direct/about/service/balance.html)
- [Statement inquiry periods](https://www.faq.mizuhobank.co.jp/faq/show/276?site_domain=default)
- [Mizuho e-account/Direct Passbook](https://www.mizuhobank.co.jp/direct/about/service/directpassbook/index.html)
- [Direct Passbook PDF/CSV downloads](https://www.faq.mizuhobank.co.jp/faq/show/10039?site_domain=default)
- [App local statement storage](https://www.faq.mizuhobank.co.jp/faq/show/7271?site_domain=default)
- [History after device changes](https://www.faq.mizuhobank.co.jp/faq/show/12914?site_domain=default)
- [Cancelled time deposit details](https://www.faq.mizuhobank.co.jp/faq/show/11523?site_domain=default)
- [Transaction result periods/counts](https://www.faq.mizuhobank.co.jp/faq/show/10064?site_domain=default)
- [Foreign-currency deposits](https://www.mizuhobank.co.jp/direct/about/service/gaika.html)
- [Web currencies for foreign ordinary/time](https://www.faq.mizuhobank.co.jp/faq/show/5888?site_domain=default)
- [Mizuho Global Accounts](https://www.mizuhobank.co.jp/direct/about/service/global/index.html)
- [Registrable accounts](https://www.faq.mizuhobank.co.jp/faq/show/246?site_domain=default)
- [Browser login authentication](https://www.faq.mizuhobank.co.jp/faq/show/10035?site_domain=default)
- [PIN types](https://www.faq.mizuhobank.co.jp/faq/show/10085?site_domain=default)
- [Supported environment, cookies, JavaScript](https://www.mizuhobank.co.jp/direct/goriyo/notice/index.html)
- [Legitimate login URL](https://www.mizuhobank.co.jp/crime/info110520.html)
- [Mizuho Direct app](https://www.mizuhobank.co.jp/direct/app/index.html)
- [Official Google Play listing](https://play.google.com/store/apps/details?id=jp.co.mizuhobank.banking)
- [Mizuho Point Mall](https://www.mizuhobank.co.jp/mmc/mizuhopointmall/index.html)
- [Mizuho Points terms](https://www.mizuhobank.co.jp/mmc/regulation/index.html)
- [Point Mall guide](https://www.mizuhobank.co.jp/mmc/mizuhopointmall/ebook/)
- [Personal bank API scope](https://www.mizuhobank.co.jp/company/activity/api/policy/index.html)
- [Contracted electronic payment service providers](https://www.mizuhobank.co.jp/company/activity/api/index.html)

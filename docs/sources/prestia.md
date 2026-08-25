# SMBC Trust Bank PRESTIA / GLOBAL PASS

Research date: 2026-08-26

## Scope and decision

This note evaluates SMBC Trust Bank PRESTIA and its GLOBAL PASS debit-card
member site as direct, official data sources for Kogane. It does not cover
SMBC Bank, Vpass credit cards, other banks, or personal-finance aggregators.
The source is read-only: no transfer, foreign-exchange order, card control,
limit change, or profile change is part of collection.

**Decision:** start with PRESTIA Online in an established Kuebiko/Chrome
profile. Collect balance pages, the official 180-day CSV exports, and new
six-year statement PDFs. Treat the GLOBAL PASS member website as a second
collector behind a separate validation gate. Prefer the member website over
bank-account debits for card detail, because it exposes pending state,
merchant and card-specific fields for 15 months. Do not use the bank's
contracted aggregator API.

The estimated implementation cost is **3/5 for PRESTIA bank balances and
account activity**, and **4/5 when detailed GLOBAL PASS activity is included**.
A browser implementation is plausible and has current third-party precedent,
but the confirmed Akamai edge and the separate card site make unattended
login the main risks.

## Research method and safety

- Read the bank's current product, help, FAQ, terms, Google Play, and API
  partnership pages.
- Probed only public, unauthenticated DNS and HTTP entry points. No credential,
  account number, session cookie, personal identifier, or balance was used or
  retained.
- Searched public GitHub code for current and older PRESTIA clients and
  inspected their data paths rather than assuming they used an API.
- Used a prior read-only local observation only to establish that an existing
  browser session had once been reusable and later expired. No value or
  identifier from that observation is recorded here.

This is a feasibility assessment, not a live authenticated capture. All
session lifetimes, response formats, download URLs, and GLOBAL PASS behavior
remain provisional until the bounded Kuebiko validation below is complete.

## Official entry points

| Surface | Official entry | Read-only data | Important constraint |
| --- | --- | --- | --- |
| PRESTIA Online (desktop) | [`login.smbctb.co.jp`](https://login.smbctb.co.jp/ib/portal/POSNIN1prestiatop.prst?LOCALE=ja_JP) | Balance summary, account details/activity, PDF statements, domestic-transfer acceptance history, overseas-remittance history | Only official channel that downloads account activity as CSV. |
| PRESTIA Mobile (mobile web) | [`mlogin.smbctb.co.jp`](https://mlogin.smbctb.co.jp/ib/portal/POSNIN1prestiatop.prst?LOCALE=ja_JP) | Balances, activity and statements broadly matching Online | No account-activity download. |
| SMBC Trust Bank app | [Official feature page](https://www.smbctb.co.jp/service/app/banking/), [Google Play](https://play.google.com/store/apps/details?id=jp.co.smbctb.prestia_app) | Balance summary, account details/activity, statements and the mobile banking menus | First sign-on needs Online ID/password; later biometric sign-on is device-oriented; no account-activity download. |
| GLOBAL PASS member website | [`vpass.jp/globalpass/`](https://vpass.jp/globalpass/) via the bank's [official guide](https://www.smbctb.co.jp/product/globalpass/guide.html) | Visa debit shopping/overseas-ATM detail, pending status, limits and card controls | Separate member credentials; after initial linkage, the terms also permit SSO from signed-in PRESTIA Online. Collection must never visit write controls. |
| Contracted account-information API | [Bank API policy](https://www.smbctb.co.jp/eaea/) | Account list, yen/FX/structured-deposit/fund balances, account activity, FX rates | Available to contracted electronic-payment intermediary operators, not published as a personal developer API. Current partners are listed on the bank's [contract page](https://www.smbctb.co.jp/dendai/detail.html). This path is intentionally excluded. |

The bank documents that desktop, mobile web, and the app share most online
banking menus, but explicitly excludes activity downloads from mobile web and
the app. Desktop PRESTIA Online is therefore the canonical bank source.

## Account enumeration and balance grain

The official [Balance Summary help](https://www.smbctb.co.jp/ib_help/ai/balance_summary.html)
lists these balance groups:

- yen savings, yen time deposits;
- foreign-currency savings, foreign-currency time deposits;
- Premium Deposit (structured deposit), mutual funds, and commingled money
  trusts;
- PRESTIA MultiMoney Credit borrowing, yen current accounts, and monthly
  average total relationship balance.

For the user's core deposit accounts, the expected identifiers and grain are:

| Account family | Enumeration grain | Evidence and qualification |
| --- | --- | --- |
| 7-digit yen savings / settlement account | One row with account type, 7-digit account number, JPY and balance/available amount | This is the representative account shown on Home and the Japanese settlement account used by GLOBAL PASS. See the bank's [account structure](https://www.smbctb.co.jp/service/welcome/account_structure.html) and [Home help](https://www.smbctb.co.jp/ib_help/myhome/myhome.html). |
| 8-digit PRESTIA MultiMoney yen savings | Separate JPY row under the investment MultiMoney account | It cannot be the GLOBAL PASS yen settlement account. The distinction is explicit in [FAQ 960](https://faq.smbctb.co.jp/faq/show/960?site_domain=smbctbjp). |
| PRESTIA MultiMoney foreign-currency savings | One row per held/displayed currency; every currency shares the same 8-digit MultiMoney account number | [FAQ 1364](https://faq.smbctb.co.jp/faq/show/1364?site_domain=smbctbjp) says unused currencies may be absent and the bank supports 17 currencies after foreign-currency activation. |
| Yen/foreign-currency time deposits | Summary group plus detail per deposit | A current HTML parser demonstrates separate foreign time-deposit rows with account number, five-digit sequence, date, currency and amount. Exact current labels and whether every yen deposit has the same keys require a live capture. |

Two independent browser clients corroborate the HTML grain. The current
[`bank_scrapers` PRESTIA driver](https://github.com/eebette/bank_scrapers/blob/master/bank_scrapers/scrapers/smbc_prestia/driver.py)
reads visible Balance Summary tables and normalizes account number, currency
and available amount. [`yokwe-root`](https://github.com/yokwe/yokwe-root/blob/main/yokwe-finance/src/main/java/yokwe/finance/account/prestia/BalancePage.java)
parses the 7-digit yen row, the 8-digit MultiMoney JPY row, currency-specific
MultiMoney rows, USD savings, and per-contract foreign time deposits. These
are third-party observations, not a schema guarantee.

Do not commit raw HTML, screenshots, account numbers, or balances. The live
validation should retain raw evidence only in the private Kuebiko capture
store and record sanitized field names in this document later.

## History, exports, and retention

### Deposit-account activity

The official [Account Details and Activities help](https://www.smbctb.co.jp/ib_help/ai/account_details_and_activities.html)
allows Today, last 30 days, last 180 days, or a custom period within 180 days.
For yen deposits it displays at most 250 rows per query; for foreign-currency
deposits it displays at most 150. The bank says a narrower date range is needed
to reach newer rows when a broad query exceeds the cap.

Desktop Online has an official [CSV download](https://www.smbctb.co.jp/ib_help/ai/download_account_activities.html)
with the same 180-day window and per-download limits: 250 for yen savings,
MultiMoney JPY savings and yen current accounts; 150 for USD savings and
MultiMoney foreign-currency savings. Oldest rows in the selected range are
returned first. CSV is the only documented download format.

A recent third-party CSV parser,
[`ofxstatement-japan`](https://github.com/elrandar/ofxstatement-japan), shows a
four-column CP932/Shift-JIS format: date, bilingual description, signed amount
with ISO currency, and account number. That parser converts a user-downloaded
file to OFX; it does not log in or download anything. The live fixture must
confirm headers, quoting, encoding, decimal scale, and whether the bank has
added fields.

For older data, the bank's [statement help](https://www.smbctb.co.jp/ib_help/ai/statement.html)
provides up to six years of transaction statements/balance reports as PDF for
viewing, saving, and printing. These PDFs are the historical backfill and
audit source, not the first choice for structured ingestion. Publication can
be annual rather than monthly when account activity does not require more
frequent issuance.

Practical schedule: collect every active account at least monthly, subdividing
high-volume ranges before export. This stays well inside 180 days and reduces
the risk of silently losing rows to 250/150 caps. Fetch newly published PDFs
by issue month and content hash, then keep the six-year catalog as a backfill
queue.

### Transfers and foreign currency

- Normal incoming/outgoing transfers and same-currency transfers appear as
  credits/debits in the relevant account activity. The official structured
  CSV fields are not documented beyond the download mechanics; payee/payer
  descriptions, rate fields and stable identifiers must be captured live.
- The dedicated [domestic transfer acceptance history](https://www.smbctb.co.jp/ib_help/transfer/domestic_transfer_history.html)
  covers up to 180 days and 300 transfers made through Online/Mobile/app, with
  ten rows per page. As of the cited help, it starts from 2025-11-13.
- The dedicated [overseas remittance history](https://www.smbctb.co.jp/ib_help/transfer/overseas_remittance_history.html)
  covers roughly six years or the most recent 300 executed remittances and
  exposes a printable detail view. It is updated the next business-day morning.
  The remittance input screen separately shows only one month / ten recent
  submissions and does not prove execution.
- FX purchase/sale and cross-currency exchange should create a debit and a
  credit in their respective currency accounts. Whether the 180-day activity
  or CSV includes the applied rate and fees is **not confirmed**. The PDF
  statement may be richer; Kuebiko should compare the same transaction across
  both outputs without recording the real values in Git.

### GLOBAL PASS activity

The bank's current [GLOBAL PASS guide](https://www.smbctb.co.jp/product/globalpass/pdf/gpguide.pdf)
states that the member website provides the most recent **15 months** of Visa
debit shopping and overseas-ATM activity. Documented fields include:

- transaction date and merchant/transaction description;
- transaction-currency amount and funded-currency amount;
- ATM owner fee in transaction and funded currencies;
- authorization number, notes/card attribution, and confirmed/pending state.

For a family card, the primary account holder can see both primary and family
activity, while the family member sees only their own. An official
[screen example](https://www.smbctb.co.jp/globalcompass/tips/globalpass-familycards/)
also shows exchange rate, exchange fee, an explicit pending marker, and a
family-card/user label such as `02`. The public example does not establish
whether this label is an interactive filter, a selected-card heading, or only
a display annotation. Card-by-card filtering must therefore be verified live.

The corresponding debit also reaches the 7-digit yen account or the selected
MultiMoney currency account, and eventually the bank statement. That ledger
path is valuable for balance reconciliation and six-year retention, but it is
not an adequate substitute for the member site: it does not document pending
authorization state, authorization number, family-card attribution, or all
card/ATM fee fields. No official CSV export for GLOBAL PASS activity was found.

PRESTIA Alert e-mail is a near-real-time notification route, not a historical
source. It may help detect new activity, including family-card use, but the
member site remains the canonical detailed record and the deposit ledger the
canonical posted cash movement.

### GLOBAL PASS family cards: attribution and privacy

The current [GLOBAL PASS terms](https://www.smbctb.co.jp/gp/terms/pdf/prestia_ja.pdf)
make the ownership model explicit. A family member uses the separately issued
family card as the primary member's agent, every purchase debt created by the
family card belongs to the primary member, and the bank may disclose family
usage to the primary member. The official family-card article also says that a
family purchase immediately debits the primary member's account: JPY from the
primary member's yen settlement account, or a supported held currency from the
primary member's MultiMoney foreign-currency savings. Principal and family
cards share the principal card's aggregate usage limit.

Kogane should consequently model the deposit asset and funded card payment as
belonging to the **primary account owner**. A family member/card is an
`economic_actor` or `actor_card_id`, not a second asset owner or a separate
card debtor. This rule covers the bank-account debit, foreign-currency funding,
fees and the Visa purchase obligation. It does not establish the beneficial
owner of every non-cash reward.

The available routes have different family-card fidelity:

| Route | Confirmed family-card visibility | Remaining uncertainty |
| --- | --- | --- |
| GLOBAL PASS member website as primary member | Primary and family activity are visible together; the official example shows a card/user label, pending/confirmed state and card-detail fields | Whether the service can filter/export by card or user; stable opaque card identifiers; pagination and transition behavior |
| GLOBAL PASS member website as family member | The family member sees only their own activity | Do not automate a separate family login; collection should use only the user's authorized primary-member view |
| PRESTIA Online/app account ledger | The resulting cash movement appears in the primary member's yen or MultiMoney foreign-currency account | No public source proves the ledger carries family-card identity, authorization state, or a card-level filter |
| PRESTIA Online CSV | The posted principal-account debit is within the account export route | The bank does not publish a family-card field list; the current third-party parser has only four generic columns. Confirm rather than assume that card identity is absent |
| PDF statement | Principal-account posted activity is retained through the statement route | No public example confirms whether a cardholder/card label is printed; verify one sanitized family-card transaction live |

For rewards, the bank's [benefit page](https://www.smbctb.co.jp/product/globalpass/benefits/)
says cashback is paid in JPY into the account and miles are posted later. The
cashback receipt is therefore a principal-account asset. ANA family cards can
be linked to a family member's separate ANA Mileage Club customer number, but
the public [application material](https://www.smbctb.co.jp/ib_help/globalpass_apply_for_globalpass.html)
does not unambiguously say which mileage account receives miles earned by each
family-card transaction. An [introductory campaign](https://www.smbctb.co.jp/gpstart2/)
combines principal and family use for qualification; that campaign-specific
rule must not be generalized to every benefit. Preserve source-card
attribution where available, but do not value or assign family miles until the
live statement/terms path confirms it.

Family-card collection has a stricter privacy boundary than ordinary account
activity:

- Keep raw HTML/JSON/PDF/screenshots containing a family name, full or partial
  card number, e-mail address, device data, or ANA customer number only in the
  restricted raw-evidence store with separate access and lifecycle controls.
- Normalize to `owner_role=primary`, `actor_role=primary|family`, and a stable
  pseudonymous `actor_card_id`. Derive the identifier with a source-scoped
  keyed hash from a bank-provided stable opaque ID when available; do not use a
  family name or last four digits as the primary key.
- Never emit plaintext family names, PANs, member numbers, authentication
  material, or real values to logs, Git, PR descriptions, screenshots, D1/KV
  metadata, metrics, or error messages. Redact before diagnostic persistence.
- Keep raw evidence and normalized financial records in separate stores. The
  normalized record may retain a family/primary role and pseudonymous actor
  only when that distinction is needed for reconciliation or household views.
- Use only the authorized primary-member view. Do not request, store, or replay
  a family member's independent login credentials.

## Route trade-offs

| Route | Retention and detail | Automation trade-off | Use |
| --- | --- | --- | --- |
| PRESTIA Online CSV | 180 days; date, description, signed currency amount and account identifier; 250/150 caps | Best structured official artifact, but desktop browser and download handling are required | Primary account-activity source |
| PRESTIA Online HTML | Current balances and 180-day activity, plus specialized transfer histories | Existing browser implementations prove selectors are tractable; HTML is more brittle than export | Primary balances; discovery and gap checks |
| PRESTIA PDF statements | Up to six years; balances and ledger detail | Stable audit artifact but parsing/OCR and issue-date dedupe add cost | Historical backfill and audit |
| PRESTIA Mobile / official app | Same core balances, activity and PDF access | Convenient manual biometric access; no CSV, and app/device state is harder to operate in cloud | Fallback/manual validation, not the first collector |
| GLOBAL PASS member website | 15 months, merchant/card/fee/authorization/pending detail; primary view includes family activity | Separate service and credentials, no found third-party client/export; card/user filtering is unconfirmed; SSO from PRESTIA Online may reduce repeated login friction | Primary card-detail and family-attribution source |
| Deposit ledger for GLOBAL PASS | 180-day CSV and six-year PDFs, posted cash movement | Already collected with bank accounts but has less card detail | Reconciliation and long-term history |
| Contracted bank API | Account list/balances/activity and FX rates | Requires a contracted regulated intermediary; this is the aggregator route the project is avoiding | Exclude |

## Authentication and session behavior

### PRESTIA Online

- Normal sign-on is user ID plus password. The current official
  [sign-on help](https://www.smbctb.co.jp/ib_help/signon.html) says an optional
  account setting can require a physical-token OTP after credentials.
- A token OTP is mandatory for selected write operations, and a transaction
  signing code is additionally required for unregistered-payee transfers.
  These write paths are outside Kogane's scope.
- The app's first sign-on uses the same Online ID/password. Later biometric
  sign-on is tied to the device's biometric capability and must be re-enrolled
  after some credential/app/device changes.
- The bank automatically signs off an inactive session, but the public help
  does not state the timeout. One prior bounded local observation found an
  existing authenticated browser session reusable and later received
  `ERROR_401` after expiry. Cookie/session portability, idle lifetime,
  absolute lifetime, concurrent use and logout invalidation are unmeasured.

### GLOBAL PASS

The [registration guide](https://www.smbctb.co.jp/service/security/gp/) says
the member website has a separate user ID/password. Initial enrollment uses
registered phone SMS or phone-call authentication (e-mail for an overseas
address), card information, and a confirmation e-mail. Primary and family
cards enroll separately.

The current [member-site terms](https://www.smbctb.co.jp/gp/terms/pdf/prestia_ja.pdf)
also describe an SSO route: after the member credentials are linked once from
signed-in PRESTIA Online, later visits can enter the member service through
the Online session while those credentials remain unchanged. This makes the
SSO route the first GLOBAL PASS experiment. Direct login remains a fallback,
not a reason to put card credentials in the bank collector.

No public documentation found in this pass specifies member-site session
lifetime or recurring-login OTP. A previous unauthenticated connection to
`vpass.jp/globalpass/` timed out from this environment; this is not evidence
that the service is generally unavailable.

## WAF and anti-bot assessment

### Confirmed on 2026-08-26

- `www`, `login`, `online`, `mlogin`, and `mobile.smbctb.co.jp` resolved via
  `*.edgekey.net` to `*.akamaiedge.net`.
- The public `www` response included `Akamai-GRN`.
- Plain command-line GETs to the four online-banking entry hosts returned
  HTTP 403 `Access Denied` pages referencing `errors.edgesuite.net`.

This confirms an Akamai delivery/protection edge in front of PRESTIA Online
and that a naive HTTP client from the current environment is rejected. It does
**not** prove which Akamai product/rule made the decision, that every cloud IP
is rejected, or that Bot Manager is enabled. No bot-score or sensor endpoint
was inspected.

`vpass.jp` resolved directly to an IPv4 address in this probe and timed out.
There is therefore no confirmed Akamai finding for the GLOBAL PASS member
site. Its WAF, TLS client requirements, and availability must be measured from
an accepted browser session.

## Official Android app and APK value

Google Play publishes the official package as
`jp.co.smbctb.prestia_app` by SMBC Trust Bank Ltd. The Play listing reports
50K+ installs and describes the same balance/activity features as mobile
banking, explicitly excluding activity downloads.

The bank does not publish a standalone APK on its official website. Obtain the
installed split APKs from an owned Android device or an authenticated Google
Play acquisition flow and verify the package/signing identity against the
installed official app. Do not trust a third-party APK mirror as the
collection runtime.

Static analysis is useful, but it is a second-phase discovery aid:

- enumerate official API/HTML hosts, WebView routes and deep links;
- determine whether balances are rendered by a WebView or native JSON calls;
- inspect certificate pinning, Network Security Config, root/emulator checks,
  biometric-keystore usage and token storage;
- compare response models with Kuebiko's web capture.

It is not yet evidence that those endpoints can be replayed. The app's
biometric/device binding and potential Play Integrity or pinning checks may
make unattended Android automation more expensive than desktop Online, and
the app cannot produce the official CSV export in any case.

## Third-party clients and implementation evidence

Public GitHub code search found three relevant implementations as of the
research date:

1. [`eebette/bank_scrapers`](https://github.com/eebette/bank_scrapers/tree/master/bank_scrapers/scrapers/smbc_prestia)
   has a PRESTIA driver last changed for Patchright in August 2025 in a repo
   pushed in July 2026. It launches a persistent visible Chrome context under
   a virtual display, types ID/password sequentially, navigates the English
   HTML UI, and parses Balance Summary tables. It collects balances only; it
   does not use CSV or a discovered internal API.
2. [`yokwe/yokwe-root`](https://github.com/yokwe/yokwe-root/tree/main/yokwe-finance/src/main/java/yokwe/finance/account/prestia)
   uses Selenium (currently configured for Safari in the PRESTIA updater),
   saves authenticated HTML, parses deposit/time-deposit/fund pages, and signs
   off. The PRESTIA path was updated in May 2025. It is another browser/HTML
   implementation, not an API client.
3. [`elrandar/ofxstatement-japan`](https://github.com/elrandar/ofxstatement-japan)
   is an October 2025 CP932 CSV-to-OFX parser. It validates the official export
   as a low-cost integration artifact but provides no downloader.

No public PRESTIA internal-API client or GLOBAL PASS downloader was found in
the searches for the official login hosts, PRESTIA, and SMBC Trust Bank.
Absence from code search is not proof none exists. The important positive
evidence is that recent clients still choose a full browser and HTML/CSV,
rather than a stable public consumer API.

## Runtime assessment

| Runtime | Fit | Reason |
| --- | --- | --- |
| Local Windows Kuebiko / persistent Chrome | **Best for discovery and immediate collection** | Accepted interactive browser, download support, reusable profile, and complete request/response capture. |
| OCI VM or Kubernetes pod with persistent browser profile | **Best first unattended PoC; medium confidence** | Full Chrome/Xvfb/Patchright and durable profile are straightforward; similar to the current public client. Akamai acceptance and login/session replay still need a controlled test. |
| Cloudflare Container | **Plausible after OCI control; medium-low confidence** | Can run full Chrome and download artifacts, but persistent-profile handling, startup time and Akamai egress behavior need validation. Prefer importing an already accepted session before attempting password login. |
| Cloudflare Worker isolate | **Not suitable for login; speculative for replay** | No full browser/download manager, and the public plain HTTP probe received Akamai 403. It becomes interesting only if Kuebiko proves a simple post-auth internal API that accepts an imported session. |
| Android emulator/container | **Do not prioritize** | Adds Play distribution, device/biometric storage, possible integrity checks and instrumentation complexity while losing CSV download. |

Keep `prestia-bank` and `prestia-globalpass` as separate collector identities,
credential scopes, session generations, host allowlists and health checks.
They can run in one scheduled workflow only after both gates pass. A failure
or login redirect on one must not cause password retries or writes on the
other.

## Cost and automation rating

| Capability | Cost (1-5) | Automation outlook | Main risk |
| --- | ---: | --- | --- |
| Monthly balances via PRESTIA Online HTML | 3 | Medium-high after accepted browser bootstrap | Akamai and selector drift |
| 180-day account CSV collection | 2 | High after browser session exists | Per-account/currency selection, range row caps, browser downloads |
| Six-year PDF statement backfill | 2 | High after browser session exists | Issue cadence/catalog and PDF parsing |
| Domestic/overseas transfer histories | 3 | Medium-high | Pagination and overlapping representations |
| GLOBAL PASS detailed activity | 4 | Medium, currently unproven | Separate site/session, SSO behavior, no found client/export, current timeout |
| Official-app extraction | 5 | Low-medium | Device binding, biometrics, pinning/integrity, no CSV |
| Contracted API | 5 / not applicable | Technically high, operationally unavailable | Regulated intermediary contract and aggregator dependency |

## Next bounded validation

All steps are read-only. Do not enter a transfer, FX trade, time deposit,
limit, card-control, registration, or settings screen except to leave it.

1. Start a fresh Kuebiko run using the established dedicated PRESTIA Chrome
   profile. Record browser/OS, egress region, time, and public-entry status.
2. Sign in once through the official PRESTIA Online page. Record whether this
   account's current sign-on policy asks for token OTP; do not change the
   policy. Exclude authentication bodies, cookies, headers, identifiers, and
   Akamai telemetry from normal evidence ingestion.
3. Visit Home and Balance Summary. Record sanitized response classes, the
   number and labels of balance groups, and whether data arrives as HTML,
   XHR/fetch JSON, or both. Do not put values or account numbers in Git.
4. For the 7-digit JPY account, the 8-digit MultiMoney JPY account, and one
   displayed foreign currency, open Account Details/Activities for bounded
   dates and download CSV. Record only encoding, header names, MIME type,
   filename pattern, row-order semantics, pagination/cap behavior, and stable
   transaction-key candidates.
5. Open the statement catalog and download one recent and one older PDF.
   Record catalog metadata, delivery URL class, `Content-Disposition`, issue
   cadence and whether the bytes are stable across a repeat download.
6. Open domestic-transfer acceptance and overseas-remittance histories without
   selecting any write action. Record list/detail request shapes, pagination,
   timestamps and identifiers.
7. Enter GLOBAL PASS from inside PRESTIA Online first. Determine whether SSO
   works for the existing enrollment, then capture the 15-month month selector,
   pagination, pending/posted transition fields, family-card attribution and
   response transport. With one already-posted family transaction, compare the
   primary member-site row against PRESTIA Online activity, CSV and PDF using
   sanitized field names only. Determine whether card/user filtering exists,
   whether an opaque stable card ID is present, and whether pending-to-posted
   rows keep a stable identifier. Do not visit limit or card-stop controls. If
   SSO fails, stop and schedule one separate visible direct-login validation.
8. Close and restart the browser, then test only an authenticated read health
   check. Repeat at bounded intervals to measure idle/absolute lifetime and
   whether profile restart preserves the session. Stop on login redirect,
   `ERROR_401`, 401 or 403; never retry credentials rapidly.
9. Only after the Windows/Kuebiko control is repeatable, import a freshly
   accepted session into WSL/OCI Chrome and attempt the same read health check.
   Test Cloudflare Container replay after OCI. Do not send ID/password to a
   Worker or Container until password bootstrap independently passes more than
   once.
10. After web transport is understood, acquire the official installed Android
    package from an owned device and perform static analysis only if it can
    answer an unresolved host/model/pinning question. Do not build the first
    collector around the app.

## Open questions

- Does this account require optional OTP at every sign-on, and can an existing
  accepted session be replayed after a browser restart or across runtimes?
- What are the precise idle and absolute session lifetimes for PRESTIA Online
  and GLOBAL PASS, and does explicit sign-off revoke every copy?
- Are balance/activity pages server-rendered HTML, internal JSON, or a mixture?
- What are the exact current CSV headers, encoding, stable identifiers, row
  ordering, and FX-rate/fee fields?
- Does the six-year statement catalog have a stable machine-readable index and
  stable PDF URLs/bytes?
- Does PRESTIA Online SSO currently open GLOBAL PASS without another member
  password, and is the resulting session scoped to `vpass.jp`?
- Does GLOBAL PASS offer any undocumented print/download artifact, or only
  month-by-month HTML?
- Can the primary GLOBAL PASS view filter by family card or user, and does it
  expose a stable opaque card identifier without a name or PAN?
- Do PRESTIA Online activity, its CSV, or PDF statements retain any family-card
  label, and can one member-site authorization be reconciled to one posted
  account debit without using a real amount in durable logs?
- Does a family-card transaction's ANA mileage credit go to the primary or the
  family member's Mileage Club number, and is cashback attributable by card or
  only as a combined JPY deposit to the primary account?
- Which WAF protects `vpass.jp`, and can an accepted GLOBAL PASS session be
  replayed in OCI or Cloudflare without device re-authentication?
- Does the current official Android app use WebView banking pages or separate
  native APIs, and are certificate pinning or integrity checks present?

## Primary references

- [PRESTIA Online/Mobile](https://www.smbctb.co.jp/service/online/)
- [Official banking channel comparison](https://www.smbctb.co.jp/service/welcome/channel.html)
- [Balance Summary help](https://www.smbctb.co.jp/ib_help/ai/balance_summary.html)
- [Account Details and Activities help](https://www.smbctb.co.jp/ib_help/ai/account_details_and_activities.html)
- [CSV download help](https://www.smbctb.co.jp/ib_help/ai/download_account_activities.html)
- [Statement and balance-report help](https://www.smbctb.co.jp/ib_help/ai/statement.html)
- [Domestic transfer acceptance history](https://www.smbctb.co.jp/ib_help/transfer/domestic_transfer_history.html)
- [Overseas remittance history](https://www.smbctb.co.jp/ib_help/transfer/overseas_remittance_history.html)
- [SMBC Trust Bank app](https://www.smbctb.co.jp/service/app/banking/)
- [Official Google Play listing](https://play.google.com/store/apps/details?id=jp.co.smbctb.prestia_app)
- [GLOBAL PASS guide](https://www.smbctb.co.jp/product/globalpass/pdf/gpguide.pdf)
- [GLOBAL PASS family-card article and member-site example](https://www.smbctb.co.jp/globalcompass/tips/globalpass-familycards/)
- [GLOBAL PASS benefits](https://www.smbctb.co.jp/product/globalpass/benefits/)
- [GLOBAL PASS application help](https://www.smbctb.co.jp/ib_help/globalpass_apply_for_globalpass.html)
- [GLOBAL PASS introductory campaign](https://www.smbctb.co.jp/gpstart2/)
- [GLOBAL PASS security and enrollment](https://www.smbctb.co.jp/service/security/gp/)
- [GLOBAL PASS member-site terms](https://www.smbctb.co.jp/gp/terms/pdf/prestia_ja.pdf)
- [Bank API policy](https://www.smbctb.co.jp/eaea/)
- [Contracted API operators](https://www.smbctb.co.jp/dendai/detail.html)

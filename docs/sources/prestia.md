# SMBC Trust Bank PRESTIA / GLOBAL PASS

Research date: 2026-08-27

## Scope and decision

This note evaluates SMBC Trust Bank PRESTIA and its GLOBAL PASS debit-card
member site as direct, official data sources for Kogane. It does not cover
SMBC Bank, Vpass credit cards, other banks, or personal-finance aggregators.
The source is read-only: no transfer, foreign-exchange order, card control,
limit change, or profile change is part of collection.

**Decision after live validation:** split the implementation paths.

- For PRESTIA bank balances and account activity, stop treating password login
  through PRESTIA Online as the first implementation. A single credential POST
  from an otherwise normal Windows Chrome 153 session was denied by the Akamai
  edge. Acquire and inspect the official Android package next, then decide
  between its read-only transport and a persistent-browser fallback.
- For GLOBAL PASS, keep the member website as the first collector. The same
  capture session completed direct login without visible interaction and read
  the month-by-month activity pages. The member website remains preferable to
  bank-account debits because it exposes merchant, authorization, fee,
  pending/confirmed, and family-card fields for 15 months.
- A pure Cloudflare Worker HTTP client is an experiment, not the baseline.
  GLOBAL PASS login includes a freshly generated Cloudflare Turnstile token
  and Nablarch hidden state. Full Chrome is the only verified token-generation
  path so far. Do not use the bank's contracted aggregator API.

The revised estimated implementation cost is **4/5 for PRESTIA bank balances
and account activity until the app transport is understood**, and **3/5 for
detailed GLOBAL PASS activity with a browser runtime**. Browserless GLOBAL
PASS collection is not yet rated as feasible.

## Research method and safety

- Read the bank's current product, help, FAQ, terms, Google Play, and API
  partnership pages.
- Performed one bounded PRESTIA credential POST and one bounded GLOBAL PASS
  login in the dedicated Kuebiko capture profile. Secrets, cookies, account
  identifiers, values, raw bodies, and screenshots remain outside Git.
- Searched public GitHub code for current and older PRESTIA clients and
  inspected their data paths rather than assuming they used an API.
- Used a prior read-only local observation only to establish that an existing
  browser session had once been reusable and later expired. No value or
  identifier from that observation is recorded here.

This is a feasibility assessment with a live authenticated transport check.
Session lifetimes, PRESTIA app transport, PRESTIA authenticated response
formats, GLOBAL PASS pagination/transition identity, and portable unattended
runtime behavior remain provisional.

## Official entry points

| Surface | Official entry | Read-only data | Important constraint |
| --- | --- | --- | --- |
| PRESTIA Online (desktop) | [`login.smbctb.co.jp`](https://login.smbctb.co.jp/ib/portal/POSNIN1prestiatop.prst?LOCALE=ja_JP) | Balance summary, account details/activity, PDF statements, domestic-transfer acceptance history, overseas-remittance history | Only official channel that downloads account activity as CSV. |
| PRESTIA Mobile (mobile web) | [`mlogin.smbctb.co.jp`](https://mlogin.smbctb.co.jp/ib/portal/POSNIN1prestiatop.prst?LOCALE=ja_JP) | Balances, activity and statements broadly matching Online | No account-activity download. |
| SMBC Trust Bank app | [Official feature page](https://www.smbctb.co.jp/service/app/banking/), [Google Play](https://play.google.com/store/apps/details?id=jp.co.smbctb.prestia_app) | Bank-account balance, details/activity, statements and mobile banking menus | First sign-on needs Online ID/password; later biometric sign-on is device-oriented; no account-activity download. Official materials do not list full GLOBAL PASS Visa-card activity as an app function. |
| GLOBAL PASS member website | Current official short entry [`http://vpass.jp/globalpass/`](http://vpass.jp/globalpass/) via the bank's [official guide](https://www.smbctb.co.jp/product/globalpass/guide.html); observed login host [`www.debit.vpass.ne.jp`](https://www.debit.vpass.ne.jp/p/login/RW1312010001?cc=01006) | Visa debit shopping/overseas-ATM detail, pending status, limits and card controls | Separate member credentials; login includes Turnstile and Nablarch form state. Collection must never visit write controls. |
| Contracted account-information API | [Bank API policy](https://www.smbctb.co.jp/eaea/) | Account list, yen/FX/structured-deposit/fund balances, account activity, FX rates | Available to contracted electronic-payment intermediary operators, not published as a personal developer API. Current partners are listed on the bank's [contract page](https://www.smbctb.co.jp/dendai/detail.html). This path is intentionally excluded. |

The bank documents that desktop, mobile web, and the app share most online
banking menus, but explicitly excludes activity downloads from mobile web and
the app. Desktop PRESTIA Online is therefore the canonical bank source.

`vpass.jp/globalpass/` is not a deprecated or "old" entrance. As of the
research date the bank's current guide still links to that HTTP vanity URL.
In the live browser it opened the actual HTTPS login endpoint on
`www.debit.vpass.ne.jp`. Treat the first URL as the official discovery entry
and allowlist the resolved service host explicitly; do not assume that the
vanity host itself serves the application.

## Live transport validation: 2026-08-27

The checks used the dedicated Kogane Capture profile on Windows Chrome Beta
153. The network exited through Cloudflare WARP/Gateway in Sydney, Australia.
The user's Zero Trust hostname routes had no rule matching either service, so
the traffic did not use the home/TAMIA tunnel. Exact addresses, credentials,
tokens, cookies, hidden values, and account data are intentionally omitted.

| Check | Result | Consequence |
| --- | --- | --- |
| PRESTIA login page | Initial GET returned 200 | Public browser access alone does not establish accepted authentication. |
| PRESTIA credential POST | The first and only POST returned Akamai/Edgesuite 403. The form was ordinary URL-encoded ID/password input; a Caulis fraud-detection script was also loaded. | Stop repeated web-password tests. Analyze the official app transport before investing in browser fingerprint tuning. |
| GLOBAL PASS official entry | The bank's current `vpass.jp/globalpass/` link opened `www.debit.vpass.ne.jp` | Document both the stable official entry and the concrete service host. |
| GLOBAL PASS direct login | GET and POST returned 200; no visible challenge or user gesture was required | Automated browser login is a viable PoC path on the Sydney WARP egress. |
| GLOBAL PASS login state | The POST included `cf-turnstile-response`, `nablarch_hidden`, and standard Nablarch form fields | A plain HTTP rewrite must reproduce more than headers, cookies and TLS appearance. |
| GLOBAL PASS activity | Authenticated read and month-selection POSTs returned 200; the selector exposed 15 months, from the current month through 14 prior months | Implement month-by-month server-rendered HTML ingestion; no JSON API or CSV export was observed. |

The live activity page exposed transaction date/detail, transaction and funded
currency amounts, transaction/ATM/FX fees, status, authorization number,
remarks, local amount/fee, and applicable rate. It confirmed the documented
retention window, but did not yet establish a stable pending-to-posted key or
a reliable family-card identifier from sanitized transport metadata alone.

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

The official banking app does **not** replace the GLOBAL PASS member website
for this dataset. The bank describes the app as providing bank-account
balances, account details/activity, statements, and online-banking functions.
Its current FAQ separately assigns card-shopping and overseas-ATM detail
(date/time, merchant and amount) to the GLOBAL PASS member website and assigns
bank-account balances/activity to internet banking. Therefore the app can
show the posted settlement-account debit as ordinary account activity, but no
official source found in this pass says it shows the full card authorization
record, pending state, authorization number, family-card attribution, or the
15-month card-detail view. The app package may still reveal a useful PRESTIA
banking transport; it should not be assumed to contain a second GLOBAL PASS
activity API.

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
the Online session while those credentials remain unchanged. Direct member
login is now the verified collector bootstrap; SSO is optional future work and
must not couple the PRESTIA and GLOBAL PASS credential/session scopes.

No public documentation found in this pass specifies member-site session
lifetime or recurring-login OTP. The current official short entry and direct
service login both worked in the live browser validation.

## WAF and anti-bot assessment

### Confirmed on 2026-08-27

- `www`, `login`, `online`, `mlogin`, and `mobile.smbctb.co.jp` resolved via
  `*.edgekey.net` to `*.akamaiedge.net`, and the public `www` response included
  `Akamai-GRN`.
- Plain command-line GETs to the online-banking entry hosts returned HTTP 403
  `Access Denied` pages referencing `errors.edgesuite.net`.
- More importantly, a normal Windows Chrome 153 load returned 200 for the
  PRESTIA login page but the first credential POST returned the same class of
  Akamai/Edgesuite 403. The page also loaded a Caulis fraud-detection script.

This confirms an Akamai delivery/protection edge in front of PRESTIA Online
and shows that browser presence alone was insufficient in the tested session.
It does **not** prove which Akamai product/rule made the decision, that every
cloud IP is rejected, that Bot Manager is enabled, or that the denial was
caused by IP, browser state, telemetry, credentials, or a combination. No
rapid retry was performed.

The GLOBAL PASS service behaved differently. Its current official short URL
opened `www.debit.vpass.ne.jp`; direct login and activity requests succeeded.
The captured origin traffic did not exhibit an Akamai denial. The login page
loaded Cloudflare Turnstile from `challenges.cloudflare.com`, but the
application origin was not observed behind Cloudflare's reverse proxy. This
is consistent with Cloudflare's documented design: Turnstile can protect a
site regardless of whether that site is proxied through Cloudflare.

### Turnstile and a browserless Worker

The successful GLOBAL PASS POST contained a fresh `cf-turnstile-response`.
Cloudflare documents that the client-side widget runs in the visitor context,
produces a token, and the protected service validates it with Siteverify.
Production tokens expire after five minutes and are single-use. They cannot be
stored for the daily job, replayed from a successful Chrome login, or replaced
with Cloudflare's test token on a production site.

No official Cloudflare documentation found here says that merely originating
the request from a Worker or another Cloudflare-network address improves a
visitor's trust score. Turnstile explicitly works for sites outside the
Cloudflare proxy, and its analytics/risk model considers browser, operating
system, user agent, IP, ASN, country, and client-side signals. A Worker egress
therefore is not a documented substitute for executing the widget. It might
produce a different risk decision in an empirical test, but any claim that it
is inherently trusted would be speculation.

A plain Worker remains worth a **bounded compatibility experiment** only if
the login can legitimately obtain a fresh accepted token without a browser.
The experiment must stop before credential submission if it cannot. Header,
User-Agent, or TLS impersonation alone does not address Turnstile token
generation or the Nablarch hidden state. The currently verified design is a
real browser; Browser Rendering or a Container can host it, whereas an isolate
`fetch()` implementation cannot execute the page widget by itself.

### Cloudflare Container, TAMIA egress and raw-TCP follow-up (2026-08-27)

A bounded Cloudflare Container experiment tested whether Playwright Chromium
could keep its own TLS handshake while only the network path moved through the
existing TAMIA Cloudflare Tunnel. No PRESTIA or GLOBAL PASS credential request
was sent in this phase, so every result below is **before Turnstile and before
the member-site login**.

The desired property is different from an HTTP reverse proxy. Calling
`TAMIA.fetch()` makes Cloudflare originate the upstream HTTPS request. It can
select TAMIA's path, but the destination then observes Cloudflare's HTTP/TLS
client rather than Chromium's original TLS fingerprint. To preserve the
browser handshake, the experiment instead used an opaque byte path:

`Chromium -> local SOCKS5 -> WebSocket -> egress Worker ->
TAMIA.connect() -> destination`

The measured results were:

| Probe | Result | Interpretation |
| --- | --- | --- |
| `TAMIA.fetch()` to an AWS IP reflector | HTTP 200 and TAMIA public IPv4 | HTTP-level VPC routing through the existing Tunnel works. |
| Container Chromium -> local SOCKS5 -> egress Worker | SOCKS negotiation and WebSocket upgrade succeeded | The Container, Chromium proxy configuration and Worker relay were not the first failure. |
| `TAMIA.connect()` to Cloudflare-hosted `icanhazip.com:443` | Socket became readable EOF with zero response bytes; Chromium timed out | Initially suggested the documented Workers restriction on outbound TCP to Cloudflare IP ranges, but this was only a hypothesis. |
| `TAMIA.connect()` to AWS-hosted `checkip.amazonaws.com` on 80 and 443 | Same zero-byte EOF | Falsifies “Cloudflare-owned destination alone caused the EOF.” Public raw-TCP egress through this direct `tunnel_id` binding is not established. |
| Direct read-only TCP/TLS from TAMIA to both reflectors | Successful | The public destinations and TAMIA's ordinary IPv4 Internet access were healthy. |
| `TAMIA.connect("100.64.1.254:22")` | Zero-byte EOF | TAMIA's LAN-side address was not reachable as an announced route through this binding. |
| `TAMIA.connect("127.0.0.1:22")` | Returned the TAMIA OpenSSH banner | Raw TCP over the VPC binding works for a service local to the `cloudflared` host. |

Here, EOF means the Worker's `ReadableStream` completed with `done: true`
before returning any application bytes. It is not an HTTP status and does not
show that Akamai, Turnstile or GLOBAL PASS rejected the browser. The contrast
between public destinations and `127.0.0.1:22` is consistent with the documented
scope of VPC `connect()`: private services reachable through a Tunnel, Mesh or
WAN on-ramp. Cloudflare documents public-Internet egress for the account-wide
`network_id: "cf1:network"` / Gateway path; this experiment bound one Tunnel
directly by `tunnel_id`. Workers VPC and its raw-TCP API are also still beta, so
the exact EOF rather than a thrown routing error may be implementation behavior
rather than a stable contract.

Cloudflare separately documents that the ordinary Workers outbound TCP Socket
API blocks Cloudflare-owned IP ranges. That warning explains why a
Cloudflare-hosted reflector was a poor first test target, but it does **not**
explain the AWS EOF and must not be generalized into “every Cloudflare VPC TCP
connection to Cloudflare is impossible.” The VPC binding's successful
localhost SSH connection is a distinct private-network path.

The remaining no-MITM design is SSH dynamic forwarding. OpenSSH `ssh -D`
creates a local SOCKS4/5 listener; for each hostname and port requested by
Chromium, the authenticated SSH server opens the destination connection from
the remote machine. Applied here, the path would be:

`Chromium -> Container-local SOCKS5 -> SSH stream over WebSocket ->
egress Worker -> TAMIA.connect("127.0.0.1:22") -> TAMIA sshd -> destination`

The destination would therefore see TAMIA's home IP while Chromium still
performs the end-to-end TLS handshake. This is not TLS interception and does
not require an HTTP proxy on TAMIA. The control connection does require a
separate read-only SSH credential. The normal localhost sshd rejected the
existing WSL identity and the user's `authorized_keys` file was empty. WSL's
working `tamia` alias used a different no-key authentication path; reusing that
would depend on Tailscale and is intentionally outside this design. No key,
package, route or service was added to TAMIA during the probe.

[`nyanshiba/warp-router`](https://github.com/nyanshiba/warp-router) is useful
context but not a drop-in fix for this direct-Tunnel experiment. It configures
a dual-stack Linux WARP Connector as a gateway to AS13335 and changes nftables,
IP forwarding and optionally FRR. TAMIA had ordinary IPv4 but no global IPv6
route in the read-only inspection, and changing its routing stack was outside
the experiment. A later `cf1:network` / Cloudflare Mesh design should evaluate
it separately from the narrower SSH-forward approach.

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
| Local Windows Kuebiko / persistent Chrome | **Verified for GLOBAL PASS discovery; rejected once for PRESTIA login** | GLOBAL PASS direct login and 15-month activity navigation succeeded. PRESTIA's first credential POST received Akamai 403. |
| OCI VM or Kubernetes pod with persistent browser profile | **Best first unattended GLOBAL PASS PoC; medium-high confidence** | Full Chrome/Xvfb/Patchright and durable profile are straightforward; the remaining question is whether a fresh Linux/cloud browser earns an accepted Turnstile token. |
| Cloudflare Browser Rendering / Container | **Browser runtime works; TAMIA egress remains gated; medium confidence** | A Container ran Playwright Chromium, local SOCKS5 and the Worker WebSocket leg. HTTP `fetch()` used TAMIA's IP but replaced the browser TLS client; public raw TCP through a direct `tunnel_id` binding returned zero-byte EOF. A narrowly scoped SSH dynamic forward through TAMIA localhost is the next no-MITM path. Browser Rendering may be simpler if TAMIA egress is unnecessary. |
| Cloudflare Worker isolate | **Unproven for GLOBAL PASS login; unsuitable for PRESTIA login** | `fetch()` cannot itself execute the Turnstile browser widget, and PRESTIA rejected the tested browser credential POST. Use only for orchestration/storage or after a compliant browserless token and authenticated read flow are demonstrated. |
| Official Android app analysis/runtime | **Next PRESTIA discovery path** | May expose read-only native endpoints or an app-specific WebView route that avoids the failing desktop entry. Device binding, biometrics, pinning/integrity, and Play distribution remain possible costs. |

Keep `prestia-bank` and `prestia-globalpass` as separate collector identities,
credential scopes, session generations, host allowlists and health checks.
They can run in one scheduled workflow only after both gates pass. A failure
or login redirect on one must not cause password retries or writes on the
other.

## Cost and automation rating

| Capability | Cost (1-5) | Automation outlook | Main risk |
| --- | ---: | --- | --- |
| Monthly balances via PRESTIA Online HTML | 4 | Low until an accepted bootstrap exists | Akamai denied the first tested credential POST |
| 180-day PRESTIA account CSV collection | 3 | High only after an accepted bank session exists | Bootstrap, per-account/currency selection, range row caps and downloads |
| Six-year PRESTIA PDF statement backfill | 3 | High only after an accepted bank session exists | Bootstrap, issue cadence/catalog and PDF parsing |
| Domestic/overseas PRESTIA transfer histories | 4 | Medium after bootstrap | Login, pagination and overlapping representations |
| GLOBAL PASS detailed activity in Chrome | 3 | Medium-high; login and month navigation verified | Turnstile/browser runtime, HTML drift and pending-row identity |
| Browserless GLOBAL PASS Worker | 4 / unproven | Unknown | Fresh accepted Turnstile token and Nablarch state |
| Official-app PRESTIA extraction | 4 | Medium discovery value | Device binding, biometrics, pinning/integrity, no CSV |
| Contracted API | 5 / not applicable | Technically high, operationally unavailable | Regulated intermediary contract and aggregator dependency |

## Next bounded validation

All steps are read-only. Do not enter a transfer, FX trade, time deposit,
limit, card-control, registration, or settings screen except to leave it.

1. Acquire the official installed Android split APKs from an owned device,
   verify the package/signing identity, and record a reproducible extraction
   and decompilation procedure. Map only hosts, WebView/native transport,
   read-only response models, pinning, device binding, integrity, and biometric
   dependencies before attempting authenticated replay.
2. If the app reveals a plausible PRESTIA read-only route, test one balance
   request locally. Otherwise keep PRESTIA Online browser automation as a
   fallback but do not repeat credential submissions without a materially
   different, evidence-based configuration.
3. Implement a local GLOBAL PASS HTML parser around the verified direct login
   and 15 month selector. Capture no write forms. Derive a stable normalized
   key from documented fields and retain enough raw restricted evidence to
   reconcile pending-to-posted transitions.
4. Repeat GLOBAL PASS once in fresh local/OCI Chrome without importing the
   Kuebiko profile. This distinguishes a generally accepted browser flow from
   profile reputation. Before a Cloudflare Container credential request, use a
   separate revocable key to complete an IP-only SSH dynamic-forward check
   through `TAMIA.connect("127.0.0.1:22")`; prove that the reflector sees
   TAMIA's IPv4 and Chromium keeps its end-to-end TLS. Do not use Tailscale or
   install a proxy on TAMIA. Then test Browser Rendering or the Container while
   preserving the same bounded stop conditions.
5. Separately test the public GLOBAL PASS page with a Worker `fetch()` client
   and inspect form/state shape without sending credentials. Continue to a
   credential POST only if there is a legitimate, freshly accepted Turnstile
   token path; do not fabricate, replay, or bypass the token.
6. Compare one posted GLOBAL PASS transaction against the PRESTIA app/account
   ledger when that route works. Verify family attribution, pending-to-posted
   identity, and whether the app shows only the cash debit or any complete
   card-detail record.

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
  password, and is the resulting session scoped to `www.debit.vpass.ne.jp`?
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
- Can a fresh OCI or Cloudflare-hosted Chrome session obtain an accepted
  GLOBAL PASS Turnstile token without importing the Kuebiko profile?
- Is there any supported way to obtain a production GLOBAL PASS Turnstile
  token in a Worker isolate, or must the scheduled collector always include a
  browser runtime?
- After a TAMIA SSH dynamic-forward IP check passes, does GLOBAL PASS accept
  Container Chromium, and does bypassing only `challenges.cloudflare.com` from
  the home proxy materially change Turnstile issuance? Keep this as a separate
  A/B test; do not infer it from the current pre-login network probes.
- Does the current official Android app use WebView banking pages or separate
  native APIs, and are certificate pinning or integrity checks present?

## Primary references

- [PRESTIA Online/Mobile](https://www.smbctb.co.jp/service/online/)
- [Official banking channel comparison](https://www.smbctb.co.jp/service/welcome/channel.html)
- [Official app feature page](https://www.smbctb.co.jp/service/app/banking/)
- [GLOBAL PASS member website versus internet banking FAQ](https://faq.smbctb.co.jp/faq/show/1842?category_id=42&site_domain=smbctbjp)
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
- [Cloudflare Turnstile overview](https://developers.cloudflare.com/turnstile/get-started/)
- [Cloudflare Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Cloudflare Workers VPC binding API](https://developers.cloudflare.com/workers-vpc/api/)
- [Cloudflare VPC Networks](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/)
- [Cloudflare Workers TCP socket considerations](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
- [OpenSSH dynamic forwarding (`ssh -D`)](https://man.openbsd.org/ssh#D)
- [Bank API policy](https://www.smbctb.co.jp/eaea/)
- [Contracted API operators](https://www.smbctb.co.jp/dendai/detail.html)

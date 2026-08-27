# SBI新生銀行 source assessment

調査日: 2026-08-26

## Scope and safety boundary

This assessment covers **SBI新生銀行 (retail PowerFlex / PowerDirect) only**.
It does not use SBI証券, 住信SBIネット銀行, SBI VC Trade, another bank, or a
financial aggregator as a data source. The customer has an SBI新生銀行 account,
but no authenticated account data was collected in this research pass.

The proposed collector is read-only. It must not initiate a domestic transfer,
an account-to-account transfer, an FX conversion, a time-deposit transaction, a
memo edit, or a settings change. It must not retain credentials, one-time codes,
account identifiers, names, or real balances in logs, fixtures, screenshots, or
repository history.

## Executive decision

**Recommendation: start with the official desktop PowerDirect UI and its own
CSV/PDF exports, using a visible, user-controlled browser session.** Capture the
read-only network traffic during that manual run. Only after the response shapes
and session behavior have been observed should Kogane decide whether to automate
the official export buttons or replay a read-only internal endpoint.

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
device model makes it a poor first automation target.

Overall implementation cost is **3/5** for a reliable, user-assisted
PowerDirect CSV/PDF collector and **4/5** for unattended browser collection.
The automation outlook is **high for balances and ordinary-account activity
after a session is established**, **medium for deposits represented only by
product/statement screens**, and **unproven for cloud-side login**.

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
At the time of research the public listing showed 500,000+ installs, a
2026-08-06 update date, balance/account-activity and time-deposit functions,
and smartphone authentication. The bank's current guide applies to app version
3.9.0 or later.

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
  PowerDirect password. The
  [account-information guide](https://www.sbishinseibank.co.jp/service/newpd/guide/koza.html)
  shows this login before read-only balance access.
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
- The bank documents automatic browser logout after an unspecified period of
  inactivity in its
  [security guidance](https://www.sbishinseibank.co.jp/security/pd/010.html).

### Not yet confirmed

- exact idle and absolute session lifetimes;
- whether a PowerDirect session survives browser restart or can be replayed in
  another browser/container while retaining the same cookie jar;
- whether read-only login ever triggers additional SMS/telephone/FIDO checks
  based on risk, IP, device or session history;
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

On 2026-08-26, a live DNS lookup showed:

```text
bk.web.sbishinseibank.co.jp
  -> bk.web.sbishinseibank.co.jp.edgekey.net
  -> e227354.b.akamaiedge.net
```

This confirms that the authenticated PowerDirect hostname is delivered through
an Akamai edge. A plain WSL `curl` probe did not complete successfully (HTTP/2
internal error, then HTTP/1.1 timeout), while a normal indexed web fetch could
load the login HTML. These observations justify a browser-first test but do not
identify a particular Akamai product or blocking rule.

### Unconfirmed inference

It is plausible that Akamai WAF/bot controls, TLS/client fingerprinting,
JavaScript telemetry, IP reputation or rate limits affect non-browser/cloud
clients. The DNS chain and one failed command-line request do **not** prove Bot
Manager, prove that automation is blocked, or show which signal mattered.
No credentialed anti-bot test was performed. The collector must stop on 401,
403, login redirect or challenge and must not rapidly retry authentication.

## Existing third-party implementations

Repository/code search found no current unofficial client for the 2026 app/FIDO
stack. The useful public evidence is:

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
| Cloudflare Workers isolate | Low for collection; high for orchestration/storage | 4 | No full browser/App/FIDO runtime and poor fit for authenticated downloads. Use only after a browser/container produces artifacts or a supported API token. |
| Cloudflare Containers with Chromium | Medium, unproven | 4 | Can run a browser, but persistent profile/secret handling and Akamai/cloud-login acceptance need testing. Use after local session behavior is understood. |
| OCI VM or Kubernetes with Chromium + encrypted persistent volume | Medium-high | 4 | Best cloud control over browser, storage and egress, but operationally heavier. A stable IP does not guarantee Akamai acceptance. |
| Reverse-engineered Android app API | Low | 5 | FIDO/device binding, app attestation/pinning risk and rapid drift. Static inventory only; not the recommended collector. |

For an unattended deployment, OCI is currently the more controllable browser
host. Cloudflare Containers remain worth a bounded comparison, while a Worker
is the coordinator/ingestion layer rather than the bank client. The preferred
architecture still keeps authentication bootstrap on a user-controlled,
trusted device until a cloud login has passed repeated read-only tests.

## Proposed validation plan

All steps below are read-only and use the customer's account only with redacted
capture/logging rules.

1. Start a dedicated visible Chrome/Kuebiko profile locally. Log in manually to
   PowerDirect. Record only public host/path names and response shapes; exclude
   authentication bodies, cookies, headers, account identifiers, customer name
   and amounts.
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
6. Observe network calls for balance list, product lists, activity query, CSV
   download and PDF download. Prefer an official download over endpoint replay.
   If an internal read endpoint is considered, replay it once in the same
   authenticated browser context and compare it byte/row-wise with the UI.
7. Measure idle timeout, browser-restart survival and one same-host session
   replay. Then run one bounded WSL/OCI/Cloudflare Container validation with an
   already established read-only session. Stop at the first login redirect,
   401, 403 or challenge; do not submit credentials repeatedly.
8. Separately acquire the current Play-delivered split APK set from the user's
   registered/authorized device and perform static endpoint/library inventory.
   Do not hook biometrics, bypass device checks or exercise transaction APIs.
9. If a supported direct API is still desirable, contact the bank's published
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

Until these are answered, the implementation should remain an official-export
collector with browser-assisted capture, not a credentialed headless scraper or
mobile API client.

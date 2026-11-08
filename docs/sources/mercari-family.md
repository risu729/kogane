# Mercari / Merpay / Mercoin personal account source assessment and transport re-audit

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26

## Scope and safety boundaries

This document covers only three families directly accessible from Japanese personal メルカリ (Mercari) accounts.

- Mercari sale transactions, sales proceeds, sales history
- メルペイ (Merpay) balances, メルカリポイント (Mercari Points), Merpay credit usage history (including あと払い (deferred payment) and メルカード (Mercard))
- メルコイン (Mercoin) cryptoasset holdings, deposits/withdrawals, trading history, transaction reports

Even through the same Mercari account/official app, do not conflate operators, asset types, authoritative
histories, or reports. In particular, keep pre-identity-verification `売上金` ("sales proceeds"), post-verification
`メルペイ残高` ("Merpay balance"), points, credit liabilities, cryptoassets, and yen for cryptoasset trading
in separate fields. Do not assume cryptoassets mediated through コインチェック (Coincheck) linked accounts
share a ledger with Mercoin's directly handled BTC / ETH / XRP.

Do not use account aggregators as the initial route. Limit experiments to reading balances/history/reports;
no listing, purchases, payments, top-ups, bank transfer applications, transfers, points purchases, deferred-payment
settlement, cryptoasset purchase/sale/deposit/withdrawal/recurring purchases, applications, or settings changes.
Do not retain account IDs, names, email, phone numbers, addresses, order/transaction IDs, actual balances,
transaction amounts, cryptoasset quantities, cookies, tokens, passkeys, OTPs, device identifiers, authentication/
integrity information in logs, fixtures, issues, PRs, or commits.

## Research method

Used current Mercari, Merpay, Mercoin help and official Google Play listings as primary sources. Also obtained
anonymously available current `jp.mercari.com` HTML, route manifests, JavaScript chunks only in temporary storage;
formatted with Prettier and statically checked hosts, paths, request/response models, authentication/token renewal.
Source maps for representative chunks returned 403 and could not be obtained. Public execution was limited to
ordinary page/asset `GET` and WAF-check `HEAD`; no authentication endpoints, financial APIs, or write endpoints called.

At research time, [Mercari Web](https://jp.mercari.com/) release was `1.260824.091703-sha.f2d8bd3`, asset origin
`https://web-jp-assets-v2.mercdn.net`. Retrieved 39 JavaScript files referenced from home; representative SHA-256s:
common/auth chunk `36a9b0b446c68407284f35fa72c59cca0b4e91e37fc371076724267d41b403e4`, sales history page chunk
`39a3ae59986fe12c7fcc846ef43e080969821c0dfeff832e10423007fbc00790`, balance page chunk
`207a26a01270892dadb3d662e7579cc9688333cfb5ddd668d9a3c8e014b747dd`, points page chunk
`f1368dcf0d09dfe7deefc3665370caabb4c50283b3529a48c3cbb29a300a9dcc`, credit page chunk
`317312e11be2d37a7f3d9dfbba37106dcc33d8008c9972963631bd99bd4f78cc`. These identify public artifacts
for reproducibility, not a stable API guarantee.

There were no existing Mercari-family tabs in the user's browser, so no login/account-page navigation was
performed. No legitimate Play-installed Android device was connected; no APK obtained. Statically read public
third-party sources to check destinations, request signing, and implementation scope. No actual values,
authenticated traffic, transactions, or settings changes.

Below, distinguish official facts, direct public-surface observations, third-party implementation evidence,
and hypotheses/unverified items.

## Conclusion

No public personal API collecting all three families unattended was found. However, it is no longer appropriate
to lump them together as unknown financial app transport. Current Web artifacts establish concrete official
read routes and common OIDC / PKCE / DPoP session transport for settled Mercari sales, Merpay balances/sales
proceeds/points/credit billing summaries. Before authenticated live verification, rate these **C candidates /
cost 4**, not B. Mercoin assets/executions were absent from Web artifacts; official internal app routes
remain unverified, thus **D / cost 5**.

Automated collector implementation order: (1) settled Mercari sales, with explicit page sizes, offsets, total
counts, fee/profit fields; (2) Merpay sales proceeds/points/balance snapshots; (3) Merpay monthly credit billing
summaries; (4) live Mercoin app routes. For a manual accounting importer, monthly Mercoin transaction report
CSV containing monthly transactions/month-end balances can come first. Do not conflate automation priority
with structured manual export priority.

Overall unattended collection remains **D / cost 5**. Some financial data is app-centered, with passkeys, SMS,
identity verification, and service-specific applications; public surfaces show Cloudflare Bot Management cookies.
Anonymous search DPoP in public third-party clients supports transport evidence, not personal financial authorization.

## Authoritative records and scope

| Family                      | Candidate authoritative current values                    | Candidate authoritative history                            | Confirmed/pending boundary                                                                                                          |
| --------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Mercari sales               | Web balance (or sales) screen                             | Web sales history/individual transactions                  | Sales unconfirmed during transactions; profit normally reflected in proceeds/balance on completion                                  |
| Sales proceeds              | Proceeds shown before identity verification               | Sales history                                              | Bank transfer application deadline: 180 days after acquisition; balance display after verification                                  |
| Merpay balance              | App `おさいふ＞残高` ("wallet > balance")                 | Balance history                                            | No expiry after identity verification. Ledger includes top-ups, sales credits, payments, refunds, etc.                              |
| Mercari Points              | App `おさいふ＞ポイント` ("wallet > points")              | History/expiry                                             | Purchased points: 365 days from purchase; free points depend on campaign. Erroneous awards may be cancelled                         |
| Merpay credit               | App `○月の請求` ("bill for month ○")                      | Monthly billing breakdown/usage status                     | `処理中` ("processing") before store data arrives; may change until merchant sales data arrives and billing is confirmed            |
| Direct Mercoin assets       | App `おさいふ＞ビットコイン等` ("wallet > bitcoin, etc.") | Per-asset trades, deposits/withdrawals, monthly report CSV | Direct BTC / ETH / XRP. Investment value is mark-to-market from holdings/current prices, separate from yen balance/acquisition cost |
| Linked-account cryptoassets | Linked-account display in app                             | Linked-account trades/reports                              | Separate service where Mercoin mediates Coincheck spot trading; separate assets/reports from direct holdings                        |

Official evidence:

- [When sales profit is reflected](https://help.jp.mercari.com/guide/articles/95/)
- [From sale to transaction completion](https://help.jp.mercari.com/guide/articles/63/)
- [180-day proceeds bank transfer application deadline](https://help.jp.mercari.com/guide/articles/96/)
- [Proceeds/balance displays after identity verification](https://help.jp.mercari.com/guide/articles/560/)
- [Merpay balance and identity verification](https://help.jp.mercari.com/guide/articles/551/)
- [Points types, history, expiry](https://help.jp.mercari.com/guide/articles/40/)
- [Credit usage processing](https://help.jp.mercari.com/guide/articles/1234/)
- [Direct cryptoassets and linked accounts](https://help.jp.mercari.com/guide/articles/1336/)
- [Supported cryptoassets](https://help.jp.mercari.com/guide/articles/2036/)
- [Cryptoasset investment value/valuation profit-loss displays](https://help.jp.mercari.com/guide/articles/1352/)

## History granularity, periods, and exports

### Mercari sales

Official Web `おさいふ＞残高（または売上）＞残高履歴（または売上履歴）` ("wallet > balance (or sales) > balance
history (or sales history)") lists transaction information for sold products. Official guidance explicitly
says sales history is unavailable in iOS/Android apps and CSV output is unavailable, recommending Web printing
for retention. PDF is not a dedicated report, but browser print-to-PDF can save the screen.

The official guide does not publish earliest dates, retention years, rows per page, total row limits,
or pagination. Do not treat all periods as retrievable; measure earliest displays, counts, and page boundaries live.

- [Sales history, Web-only, no CSV](https://help.jp.mercari.com/guide/articles/97/)

### Merpay balances, points, and credit

Official app histories by payment method: credit `○月の請求＞内訳を見る` ("bill for month ○ > view breakdown"),
balance `残高＞残高履歴` ("balance > balance history"), points `ポイント＞履歴と有効期限` ("points > history and expiry").
`最近の利用＞毎月のご利用状況` ("recent usage > monthly usage status") groups monthly Mercari/merchant purchases
using points/balances/credit, but excludes top-ups, refunds, proceeds credits, bank transfer applications, and
outflows paying credit usage. Do not use the integrated display as a complete ledger.

No paper statements; official guidance recommends screen saving/printing. No primary source was found offering
personal balance/points/credit history CSV, PDF reports, or annual usage reports. Retention, earliest month,
page sizes, total row limits are also unpublished. Recent wallet usage may appear with delays.

Cancellation refunds to balances/points normally appear simultaneously; check each history. Late merchant data
can change credit billing/refund displays. Store `processing` and `settled` as transitions of the same row;
do not freeze first-seen values as final.

- [Histories by payment method/month; no paper statements](https://help.jp.mercari.com/guide/articles/578/)
- [Events excluded from monthly usage history](https://help.jp.mercari.com/guide/articles/746/)
- [Wallet/history reflection delays](https://help.jp.mercari.com/guide/articles/2037/)
- [Balance/points refund history and timing](https://help.jp.mercari.com/guide/articles/466/)
- [Merchant-data rebilling after cancellation](https://help.jp.mercari.com/guide/articles/2093/)

### Mercoin

Select assets for app trade history; individual details contain transaction types (purchase, recurring purchase,
sale, sale for payment, receipt, etc.), datetime, order IDs, etc. Do not retain IDs/actual values in collection
records. Separate `チャージ・移した履歴` ("top-up/transfer history") keeps yen-for-cryptoasset-trading deposits/
withdrawals by date/amount/type; separate it from cryptoasset trading history.

Statutory monthly transaction reports provide monthly transactions/month-end balances as CSV, including
months without transactions; email notification after previous-month report completion. Download per month
in app. Reports also cover the termination month and following month; past reports can be requested from
support after membership termination.

Official annual profit/loss guidance asks users to aggregate January–December monthly CSV values; it does
not show a single annual CSV/PDF. CSV includes transaction types/pairs, cryptoasset quantity changes,
execution amounts, etc., supporting per-trade profit/loss calculations. Screen history retention/row limits
are unpublished, but monthly CSV exists, so do not use screen history as long-term authoritative records.

- [Per-asset trade history/individual details](https://help.jp.mercari.com/guide/articles/1368/)
- [Yen-for-cryptoasset-trading deposit/withdrawal history](https://help.jp.mercari.com/guide/articles/1361/)
- [Monthly report CSV, month-end balances, after termination](https://help.jp.mercari.com/guide/articles/1369/)
- [Annual profit/loss using monthly CSV](https://help.jp.mercari.com/guide/articles/1513/)
- [No fees; spread included in quoted prices](https://help.jp.mercari.com/guide/articles/1473/)

## Authentication, MFA, passkeys, and Bitwarden

### Officially established facts

- Mercari has phased in login method updates since 2026-05-29. Accounts with registered passkeys use them for Mercari login; depending on conditions, alternatives include Apple / Google / Facebook / LINE or email magic links and SMS. Unregistered accounts retain email/phone and password etc. routes.
- Web `パスキーでログイン` ("log in with passkey") shows QR codes to scan with smartphones etc. holding passkeys registered in the Mercari app. Passkey authentication is still required after device replacement if registered.
- SMS authentication uses six-digit codes. Login or Merpay use may require identity verification.
- Starting Mercoin requires a Mercari account, passkey registration, identity verification, service application. Common login does not equate Mercoin eligibility/ledgers with Mercari sales.
- Mercari guidance excludes issues caused by `デジタル認証アプリ` ("digital authentication apps") from support; this does not directly establish Bitwarden WebAuthn passkey compatibility.

Official evidence:

- [Login method updates](https://help.jp.mercari.com/guide/articles/1860/)
- [Passkey login and Web QR](https://help.jp.mercari.com/guide/articles/1875/)
- [Six-digit SMS authentication and passkey recommendation](https://help.jp.mercari.com/guide/articles/1043/)
- [Identity verification by SMS](https://help.jp.mercari.com/guide/articles/687/)
- [Passkeys after changing phones](https://help.jp.mercari.com/guide/articles/243/)
- [Mercoin eligibility](https://help.jp.mercari.com/guide/articles/1336/)

### Relationship with Bitwarden

Bitwarden generally stores/uses WebAuthn passkeys through browser extensions and autofills passwords/TOTP.
This is established as a Bitwarden capability.

- [Bitwarden passkey/credential autofill](https://bitwarden.com/help/auto-fill-browser/)

Whether Mercari-app-registered passkeys can select Bitwarden as credential provider, whether Bitwarden-stored
passkeys work in both official app/Web QR flows, and whether OS/device-bound are unverified. Do not infer
unattended login through Bitwarden. Live verification manually checks only registered provider names and
whether Web login offers them, without displaying/outputting secrets.

## Roles of official app, APK, and Web

Official Japanese Android app: Google Play package [`com.kouzoh.mercari`](https://play.google.com/store/apps/details?id=com.kouzoh.mercari&hl=ja),
publisher `Mercari, Inc`. Official Play HTML checked on 2026-08-26 gave current version `5.217.0`, updated
2026-08-21, minimum Android 8.0. Mercari/Merpay/Mercoin features share a package; the official listing also
describes cryptoasset trading inside Mercari app. Shared package does not equate sales/payment/cryptoasset
ledgers, operators, or read models.

Web offers sales history lists/printing alongside product/transaction screens; sales history is conversely
unavailable in app. Web login has a QR flow using app-registered passkeys; browser-only password autofill
may not reach all screens.

No Mercari-distributed standalone APK found; research environment lacked `adb`, `apksigner`, `bundletool`,
`jadx`, `apktool`, `aapt2`, `apkanalyzer`, MobSF. Do not use APK mirrors without guaranteed provenance/signers.
After connecting a non-root user device legitimately installed from Google Play, extract split APKs temporarily,
checking matching packages, versionCodes, and signers across all splits.

```bash
PKG=com.kouzoh.mercari
OUT="$(mktemp -d)/$PKG"
mkdir -p "$OUT"
adb shell dumpsys package "$PKG" \
  | rg 'versionName|versionCode|firstInstallTime|lastUpdateTime|signingInfo'
adb shell pm path "$PKG" | tee "$OUT/package-paths.txt"
while IFS= read -r line; do
  remote=${line#package:}
  adb pull "$remote" "$OUT/$(basename "$remote")"
done < "$OUT/package-paths.txt"
sha256sum "$OUT"/*.apk
for apk in "$OUT"/*.apk; do
  apksigner verify --verbose --print-certs "$apk"
done
jadx -d "$OUT/jadx" "$OUT"/*.apk
apktool d -f "$OUT/base.apk" -o "$OUT/apktool-base"
apkanalyzer manifest print "$OUT/base.apk" > "$OUT/AndroidManifest.xml"
rg -a -n \
  'https?://|wss://|api|mercari|merpay|mercoin|balance|sales|point|credit|defpay|crypto|asset|order|execution|fill|trade|statement|report|session|token|dpop|okhttp|retrofit|grpc|protobuf|certificate|pin|integrity|attestation|keystore|biometric' \
  "$OUT/jadx" "$OUT/apktool-base"
```

Keep artifacts out of Git. Produce only redacted inventories of manifest exported components/app links/network
security config, hosts/paths, Retrofit/OkHttp or gRPC/protobuf schemas, session issuance/renewal, keystore/
biometric/device binding, certificate pinning, Play Integrity/attestation candidates. Optionally use a local
version-pinned MobSF container. Deobfuscation/call graphs/owner-operated read-only runtime tracing are in scope;
bypassing pinning/integrity/root detection to decrypt communication bodies is out of scope.

## Common auth / session in public Web JavaScript

Current Web common chunks implement Authorization Code + PKCE (`S256`) with issuer `https://auth.mercari.com`.
Browser sends `X-Platform: web`, calls `GET /jp/v1/authorize` with `rmode=direct` and `prompt=none`, exchanges
returned codes through `POST /jp/v1/token` with code verifier, resource host, public client ID/scope.
Redirect URI: `https://jp.mercari.com/auth/callback`. These are code routes; no requests sent in this research.

Access/ID tokens and expiration go to localStorage `authTokenData`, sign-in marker to `signIn`. WebCrypto
generates non-extractable P-256 ECDSA DPoP keys, stored in IndexedDB database `auth-sdk`, object store `keyPairs`,
key `dpop`. Proofs use `typ=dpop+jwt`, `alg=ES256`, containing `iat`, random `jti`, `htu`, `htm`, shared UUID.
Each API request includes `DPoP`; authenticated requests include access-token `Authorization`.

API clients have at least three surfaces.

| Surface  | Base / header                                                   | Established role                                                             |
| -------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Mercari  | `https://api.mercari.jp`, `X-Platform: web`                     | Sales history, mypage components, product/transaction surfaces               |
| Merpay   | `https://api.merpay.com`, same DPoP / Authorization interceptor | Proceeds, points, balances, credit billing                                   |
| Accounts | `https://accounts.mercari.com`                                  | Separate account bootstrap client; do not equate with financial read clients |

Production browser processing may rewrite to `https://jp.mercari.com/api` or `/merpay-api` proxies depending
on configuration. On 401/403, except explicit passcode/SMS/country errors etc., it performs silent `authorize`
flow/token exchange and retries the original request once. This establishes a session renewal implementation,
not live verification of token lifetime, long-term unattended renewal stability, device binding, or WAF acceptance.

## Official Web read routes by ledger

Statically analyzed anonymously retrievable page shells/page-specific chunks for `/mypage/sales_history`,
`/mypage/balance_details`, `/mypage/point/history`, `/mypage/merpay/smartpayment`, `/mypage/listings/sold`.
No account responses retrieved.

### Mercari: settled sales ledger

`GET https://api.mercari.jp/sold_histories/list` takes `{year, limit, offset}`; current UI uses `limit=20`,
`offset=(page-1)*20`. Response contains `sold_histories`, `total_count`; rows expose `price`, `sales_fee`,
`seller_shipping_fee`, `seller_additional_fee`, `tax_rate`, `sales_profit`, `transaction_finished_at`,
`donation_amount`. `item_id`, product names, thumbnails also return; collectors must not save/output them as
PII/product information.

This is the settled sale/profit ledger after transaction completion, not listed/in-progress pending states.
Do not follow UI `/transaction/{itemId}` links or transaction operations. Explicit pagination and fee/profit
schemas make this the first automated collector candidate.

The Merpay balance surface separately has proceeds reads:

- `GET https://api.merpay.com/balance/v1/list_sales_histories`: displays `histories[]` `type`, `datetime`, `changedAmount`, `title`; sales may also contain `mercariExtraInfo.itemId`. Do not save IDs/titles.
- `GET https://api.merpay.com/balance/v1/list_sales_expiry_dates`: displays pre-verification proceeds expiry.

Current Web client passes no pagination parameters to these; server retention/implicit caps are unverified.
Settled sales profit and proceeds change events reflected in balances can overlap; do not double count in one ledger.

### Merpay: balance/points ledgers

`GET https://api.mercari.jp/v2/mypage/top/components` takes page-generated `mypageRequestId`; wallet components
display `balance.balance`, `hasFundsAccount`, `totalPoint`, `serviceState`. If Mercari Bank is enabled,
separate `baasAccountBalance.availableBalance` as another ledger. Feature flag `BRIDGE-77_baas_mypage_web`
affects this surface.

Points surfaces read through the same Merpay session client:

- `GET https://api.merpay.com/v1/get_balance`: current balance/points snapshot.
- `GET /v1/list_point_histories`: `results[]` `id`, `type`, `title`, `datetime`, `changedAmount`. Collector does not save `id`/`title`.
- `GET /v1/get_point_history?id=...`: individual details; exclude from initial allowlist.
- `GET /v1/list_point_expiry_dates`: `date`, `amount`, `purchased`.

Lists have no current client-side pagination parameters; retention/server caps unverified. Use separate record
types for current snapshots, accrual/use change events, expiry buckets. The same module contains
`/v1/create_point_recharge`, `/v1/create_funds_recharge`, limit/deferred-payment consent updates;
deny per route, not per module.

### Merpay: payment/credit billing ledger

Current Web pages have these read routes.

- `GET https://api.merpay.com/shared/defpay/v1/defer/get_user_status`
- `GET /shared/defpay/v1/check_easypay_terms_updates`
- `GET /defpay/v1/get_easypay_repayment_setting`
- `GET /defpay/v1/get_easypay_convertible_payment_list`
- `GET /defpay/v1/get_repayment_top`

`get_repayment_top` returns invoices; UI distinguishes `status=DRAFT`, displays `useMonth`, `deadlineAt`,
`repaymentAmount`, `demandFee`, `lateFee`, `totalEasypayPrincipalAmount`, `totalEasypayFee`,
`usingScheduledRepayment`, etc. This is a monthly invoice/repayment summary, not full merchant-level
processing → confirmed → refund history. Official Help establishes `処理中`, but these Web chunks did not
identify merchant line read routes/status schemas.

`calc_easypay_repayment_plan` and applicant conditions are unnecessary for ledger retrieval; exclude from
initial allowlists even as GETs. Strictly deny same-module `convert_monthly_clear_to_easypay`,
`cancel_invoice_repayment`, `initialize_post_pay_user`, `update_easypay_repayment_setting`,
`update_easypay_monthly_installments`, `create_invoice_repayment`.

### Mercoin: assets/orders/executions ledger

Current public route manifests/retrieved Web chunks did not establish financial routes for Mercoin
assets/orders/executions/monthly reports. Do not infer app-only route names/hosts/schemas.

After APK acquisition, search separately for (1) asset snapshots by symbol: quantity/valuation/cost basis/
unrealized P&L; (2) executions: order ID/status, fills/average prices/spreads/fees; (3) yen-for-cryptoasset-trading
funding change events; (4) monthly report lists/downloads. Do not conflate orders/executions, directly handled
BTC / ETH / XRP and Coincheck linking, cryptoasset quantities/yen valuations. For read-only runtime observation,
the owner displays each list once; collect only method, host, path template, query key names, status/content-type,
and response key names.

## Public APIs and third-party implementations

No public self-enrollable official API for personal sales/balances/points/credit/cryptoasset ledgers was found.
メルカリShops (Mercari Shops) GraphQL API/Personal Access Tokens are for shop businesses, not these personal
account sources. Merpay merchant APIs are contracted payment-acceptance APIs, not consumer ledger exports.

- [Mercari Shops API reference](https://api.mercari-shops.com/docs/index.html)
- [Online API in Merpay merchant terms](https://www.merpay.com/merchant/terms/)

Public third-party [`take-kun/mercapi`](https://github.com/take-kun/mercapi/tree/9455cf167d4a3eff5674612631a6e88e72424c7f)
uses Python `httpx.AsyncClient` to:

- Generate P-256 keys/random UUID on startup.
- Add `X-Platform: web`, sign each request URL/method/UUID as ES256 DPoP JWTs.
- Search products with `POST https://api.mercari.jp/v2/entities:search`, handling page tokens.
- Read public products/sellers with `GET /items/get`, `/users/get_profile`, `/items/get_items`.

[`marvinody/mercari`](https://github.com/marvinody/mercari/tree/8aa38587a7905d62cadaf4cfb35bb555eefa7d96)
also implements public search/product retrieval with `requests` and ES256 DPoP.
[`enemy732/mercari-jp-wrapper`](https://github.com/enemy732/mercari-jp-wrapper/tree/bd87146c39c839901ac58f689a16dcba98b018cf)
shows obtaining Authorization/DPoP headers through preliminary `accounts.mercari.com` requests and sending
them to `api.mercari.jp` search.

These are concrete public product transport/request-signing examples, not implementations of login, session
renewal, personal sales history, Merpay, or Mercoin. Successful third-party DPoP generation does not establish
financial data authorization or long-term session reuse. Do not call discovered internal endpoints indiscriminately.

## WAF / anti-bot observations

Anonymous WSL `HEAD` observations on 2026-08-26: `jp.mercari.com`, `help.jp.mercari.com`, `auth.mercari.com`,
`api.mercari.jp`, `accounts.mercari.com` returned `server: cloudflare`, `cf-ray`, `__cf_bm`.
`__cf_bm` is a Cloudflare Bot Management-family cookie. `jp.mercari.com`/help also showed `via: 1.1 google`
behind them. Anonymous method-mismatched HEAD to `api.mercari.jp/v2/entities:search` returned Cloudflare 403;
auth/accounts roots or unsupported paths returned 404.

This establishes Cloudflare edges/bot-management cookies for observed hosts, not shared post-login financial
API policies, bot-only reasons for 403, rate limits, challenge conditions, geographical restrictions, device
attestation, or certificate pinning. No Akamai CNAMEs, `AkamaiGHost`, or rejection markers were found in these
responses; do not affirm Akamai adoption currently.

Do not rotate IPs, spoof fingerprints, or bypass challenges to evade repeated 403/429, challenges, CAPTCHA,
passkey reauthentication, or app session expiry.

## Read / write isolation

Collectors allowlist semantic operations, not entire API hosts on the assumption they are safe.

| Initial read allowlist candidates                                      | Prohibited                                                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Fixed year / limit / offset lists from `sold_histories/list`           | Listings/price changes/deletion, product/transaction details                                       |
| `balance/v1/list_sales_histories`, `list_sales_expiry_dates`           | Top-ups, bank transfer applications, balance transfers                                             |
| Wallet component from `v2/mypage/top/components`                       | Accounts/identity verification/limits/payment settings                                             |
| `v1/get_balance`, `list_point_histories`, `list_point_expiry_dates`    | Point/funds recharge, exchanges, expiry avoidance operations                                       |
| Invoice summary from `defpay/v1/get_repayment_top`                     | Settlement, repayment creation/cancellation, installment changes, consent/automatic debit settings |
| Existing monthly report lists/downloads (after app route verification) | Cryptoasset orders/trades/recurring purchases/deposits/withdrawals                                 |

HTTP `POST` can be read-only, such as search; `GET` may have side effects such as eligibility calculations or
signed URL issuance. Do not classify by method alone. Initially allow only table routes/response schemas;
deny parameterized details, unknown routes/fields, write verbs. Separate read-only types into packages;
do not link write methods into the same process. Egress proxies also allowlist host + exact path + method;
stop if redirect destinations are outside the allowlist.

## Runtime suitability

| Runtime                                    | Suitability                                                      | Reason                                                                                                                                                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers                         | **High for manual export import, low for auth bootstrap**        | Fetch API sends ordinary HTTP, suitable for receiving/normalizing CSV/PDF/HTML. No local filesystem/official Android app; cannot create passkey QR, SMS, device state. Replay from Cloudflare edge may face different WAF policies |
| Cloudflare Containers                      | **Medium for post-processing, low for app automation**           | Arbitrary languages/Linux filesystem, but no reproduction of Play-installed devices/passkeys/SMS/device integrity. Worker on-demand startup also unsuitable for long-lived human app sessions                                      |
| OCI VM / fixed egress                      | **Medium after proven read-only replay**                         | Easier encrypted sessions, resident processes, fixed egress, browser management; does not solve official app/bot/device boundaries or improve unknown endpoint stability                                                           |
| Kubernetes                                 | **Medium for many sources, excessive for one initial collector** | Fits CronJob, secret separation, network policies, auditing. Operations outweigh benefits for a single Mercari manual export import. Useful if network/code policy can deny writes                                                 |
| User-controlled official Android + browser | **Best for primary verification**                                | Existing legitimate sessions/compatible passkeys; user selects read-only screens/existing CSV, verifying without exporting secrets/actual values                                                                                   |

Evidence for current Cloudflare specifications:

- [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [Workers security model and lack of filesystem support](https://developers.cloudflare.com/workers/reference/security-model/)
- [Cloudflare Containers overview](https://developers.cloudflare.com/containers/)

## PR #5 common A–E / cost assessment

Common definitions: A = public documented API/export API for scheduled headless; B = stable read-only internal
API/renewable sessions; C = headless replay after browser/app bootstrap; D = full browser/device automation;
E = manual capture. Cost ranges from 1 (small wrapper) to 5 (device-bound/adversarial automation).

| Route                                               | Level           |    Cost | Assessment                                                                                                                                                                                                   |
| --------------------------------------------------- | --------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mercari settled sales Web reads                     | **C candidate** |   **4** | **First automated collector candidate**. Static verification of exact GET, 20-row pages, offsets, total count, fee/profit schema, common session transport. Not B before live renewal/retention verification |
| Merpay proceeds/points/balance Web reads            | **C candidate** |   **4** | Exact GET/schemas established; verify pagination/implicit caps, snapshot/event consistency live                                                                                                              |
| Merpay credit billing summary Web reads             | **C candidate** | **4–5** | Exact invoice summary GET established; merchant processing/settled/refund routes unidentified. Lower priority due to adjacent writes                                                                         |
| Manual Mercoin monthly CSV download + import        | **E**           |   **1** | **First manual importer candidate**. Official, structured, month-end balances. Accounting authoritative records can precede automated app transport                                                          |
| Mercari sales history Web printing + import         | **E**           | **1–2** | No CSV; tolerate printed HTML/PDF schema drift, retain originals                                                                                                                                             |
| Merpay history screen saving + manual normalization | **E**           |   **2** | Separate balance/points/credit captures; integrated monthly screen alone insufficient                                                                                                                        |
| Mercoin internal app reads                          | **D**           |   **5** | Package identified, but APK/routes/schemas/sessions/integrity not obtained. Reassess C after separating assets/orders/executions/reports                                                                     |
| Official Android UI automation                      | **D**           |   **5** | Requires devices, passkeys, service-specific screens, asynchronous reports, misoperation prevention                                                                                                          |

Overall **D / cost 5**; safe manual initial route **E / cost 1–2**. Web reads are C candidates based on
current official financial page chunks themselves, not public product search clients; do not adopt implementation
or promote to B before gates for one authenticated observation, renewal, retention, and schema drift are met.

## Read-only live verification plan

1. Use existing official app/Web sessions, recording only service names, screen headings, displayed field names. Do not record actual values, IDs, notification bodies, email, QR, cookies, tokens. No existing tabs were present in this research; first the user opens official URLs through ordinary operation.
2. Sanitized DevTools logger emits only method, host, path template, query key names, status, content-type, response top-level key names, discarding headers, bodies, tokens, IDs, amounts, product names, counterparties before capture. Save no HAR.
3. Display settled Web sales once; check `sold_histories/list` limit/offset/total count, year boundaries, earliest year, empty pages. Do not open individual `/transaction/{itemId}` or operation buttons.
4. Display proceeds history, points history/expiry, balance components, credit billing summaries once each, checking only static route/response key agreement. Do not initially call `get_point_history`, repayment calculations/applicant conditions.
5. View app balance history, monthly usage, credit billing breakdowns; identify Web-unresolved merchant line `processing / settled / refund` statuses/route templates. Do not enter payment/settlement paths.
6. Owner displays Mercoin assets, per-asset trades, orders/executions, deposit/withdrawal history, report lists sequentially once. Runtime observations only host/path/schema metadata; do not enter purchase/sale/top-up screens.
7. User manually downloads one existing monthly CSV; in an isolated local environment check headers, encoding, row types, month-end balance rows, asset symbols, correction rows. Keep actual data out of Git/diagnostic logs.
8. Observe ordinary Web passkey QR scanning once on a registered device, checking only whether Bitwarden provider is offered. No re-registration, deletion, passkey settings changes.
9. After live metadata and explicit permission, try one local allowlisted GET for session replay. Do not persist tokens/DPoP proofs. Even after success, reassess silent renewal, concurrent sessions, expiry, egress/WAF, write egress denial before moving sessions to cloud.

## Immediate stop conditions

Stop that route on any of these without retry/bypass.

- Navigation to confirmations for listings, purchases, payments, top-ups, transfers, bank transfers, settlement, cryptoasset trades, recurring purchases, applications, consent, settings saves.
- Passkey registration/deletion, SMS/OTP input, identity verification, account linking, limit changes requested.
- Requests outside read-only allowlists or semantically unknown responses.
- 401/403/429, Cloudflare challenges, CAPTCHA, extra identity verification, unusual-login notices, app session expiry.
- Need to bypass certificate pinning, device attestation, root/emulator rejection.
- Host/path metadata unobservable in unmodified Android app without pinning/integrity bypass or secret header/body hooks.
- Risk of actual values, PII, IDs, secrets remaining in URLs, screens, logs, exceptions, telemetry.
- Retrieval requires automation/excessive load/security-control bypass prohibited by terms.

## Unverified items / acceptance gates

- [ ] Earliest dates/months, row limits, page sizes for sales history, balance history, points history, credit billing breakdowns.
- [ ] State names from processing to confirmed/cancelled/refunded; whether corrections update the same ID or add rows.
- [ ] Full monthly report CSV headers, encoding, distinction between direct/linked accounts, identity on corrections/reissuance.
- [ ] In-app report retention. Post-termination support provision established, but no guarantee all months are retrievable from lists during membership.
- [x] Official Web settled sales, proceeds, points, balance component, credit billing summary routes/response keys (static verification of public current JS).
- [x] Web OIDC Authorization Code + PKCE, DPoP keys, Authorization/DPoP interceptors, silent renewal/retry (static verification of public current JS).
- [ ] Authenticated Web agreement with those routes/schemas, server pagination behavior, token lifetimes, renewal success conditions, WAF/egress differences.
- [ ] Merpay merchant line processing/settled/refund read routes and transitions.
- [ ] Legitimate split APK package/versionCode/signer/manifest/hosts/schemas, mobile session issuance, device binding, certificate pinning, Play Integrity/attestation candidates.
- [ ] Mercoin app read routes/schemas for assets, orders, executions, funding, report lists/downloads.
- [ ] Whether Mercari-app-registered passkeys can be stored/used with Bitwarden provider; do not infer from generic WebAuthn support.
- [ ] Reasons for Cloudflare 403s, rate limits, regional/egress differences, authenticated API host CDN/WAF.
- [ ] Personal read-only APIs/data portability routes; Shops/merchant APIs are not substitutes.

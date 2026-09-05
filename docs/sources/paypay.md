# PayPay consumer wallet source assessment

Research date: 2026-08-26

## Scope and safety boundary

This assessment covers only the consumer PayPay wallet: PayPay Money,
PayPay Money Lite, ordinary PayPay Points, limited-time PayPay Points, and
their payment, receipt, charge, withdrawal, refund, and point histories. It
does not cover PayPay Bank, PayPay Securities, PayPay Card account data,
Yahoo! JAPAN as a separate source, merchant PayPay for Business data, or any
other payment service.

Kogane should obtain this data directly from PayPay's official app, official
export, or official API. An account aggregator is deliberately not part of
the proposed path. All experiments must remain read-only: do not pay, send,
receive, charge, withdraw, change settings, or invoke similarly mutating
third-party-client methods. Do not save phone numbers, passwords, OTPs,
access tokens, device identifiers, integrity material, or personal identifiers
in captures, fixtures, issues, commits, or logs.

This is a first-pass cost and automation assessment, not a completed API
reverse engineering report. Statements below distinguish official facts,
direct probes, third-party implementation evidence, and inferences.

## Research method

The assessment used PayPay's current consumer help, Google Play listing, and
Open Payment API documentation as primary sources. It then inspected the
checked-out source of `pnsk-lab/mnie` at `c87e65c`, and compared it with full
Git histories of PayPax and PayPaython to avoid mistaking a recent README edit
for a recently maintained client. Finally, bounded anonymous `HEAD`/`GET`
probes recorded DNS and response headers for public/help, old consumer-BFF,
and official OPA hosts. No authenticated request, account page, APK download,
credential entry, or account mutation was performed.

## Executive decision

Use the official in-app CSV export first. It provides two years of transaction
data, one request can span at most 365 days, and the result has stable tabular
fields. Importing a user-downloaded CSV is implementation cost **2/5** and is
the best initial route. A monthly cadence avoids the two-year expiry window and
keeps re-runs small.

Current balance-by-type and limited-time-point expiry are not fully represented
by that CSV. Collect those as separate snapshots from the official app while
investigating the current Android read-only APIs. The existing
`pnsk-lab/mnie` provider is useful proof that an authenticated balance request
can be replayed, but it accepts an Android app token and app/device/integrity
headers from elsewhere, has no login or refresh implementation, and exposes
only total, transferable, and payoutable amounts. It is not yet a complete
PayPay collector.

Do not start with the official Open Payment API (OPA). Its balance endpoint is
well documented and highly automatable after approval, but PayPay requires
merchant onboarding, separate approval for balance access, API credentials,
a client-IP allowlist, and user authorization. No consumer transaction-history
export endpoint was found in the public OPA documentation. OPA is therefore a
high-cost future option, not a substitute for the app CSV.

## Official source surfaces

| Surface                                | Data that is officially documented                                                                                                                                                                                                       | Period / limit                                                                                                            | Automation trade-off                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| PayPay app: Wallet / balance breakdown | Current PayPay Money, PayPay Money (salary), PayPay Money Lite, and PayPay Points breakdown                                                                                                                                              | Current snapshot; no historical snapshot retention is documented                                                          | Best semantic breakdown, but Android UI/app API and authenticated device state are required                                                        |
| PayPay app: transaction history        | Payments, transfers sent, donations, bank withdrawals, charge reversals, payment acceptance, bill payments, points earned, transfers received, charges, refunds, and salary receipts; filters by type, payment/charge method, and period | The UI help does not state a general maximum. Point history includes points earned from payments from October 2019 onward | Rich per-item detail, including the balance types used for a payment; harder than CSV because pagination and current API schemas remain unverified |
| PayPay app: transaction detail         | Transaction number, payment method, the balance-type allocation used for a payment, and point grant status/expected grant date where applicable                                                                                          | Per transaction                                                                                                           | Highest detail; requires one detail fetch/navigation per transaction unless a batch/detail API is identified                                       |
| PayPay app: usage report               | Monthly totals for payments, transfers sent, bank withdrawals, points earned, charges, transfers received, refunds, plus merchant ranking                                                                                                | Monthly selection; the help page does not state the oldest selectable month                                               | Useful for reconciliation only; it aggregates away transaction identity and balance subtype                                                        |
| PayPay app: point screen               | Ordinary point balance, point grant history, and a calendar of expected grants. The expected calendar combines ordinary and limited-time points                                                                                          | No retention maximum is documented                                                                                        | Good current/forecast snapshot, but the calendar alone does not preserve point type for each expected grant                                        |
| PayPay app: limited-time point tab     | Limited-time awards and each expiry; a separate expired-points list; refund notices can contain restored amount and expiry                                                                                                               | No retention maximum is documented                                                                                        | Necessary for lot/expiry modeling. More complete semantically than CSV, but app-only and probably a separate endpoint from wallet summary          |
| PayPay app: CSV export                 | The 13 fields listed below                                                                                                                                                                                                               | Past two years; at most 365 days per request; unlimited request count; generated download expires after 24 hours          | Recommended initial source. Asynchronous in-app request/notification/download adds UI-automation cost, but manual import is cheap and robust       |
| Public PayPay website/help             | Documentation only; no personal wallet/history dashboard was found                                                                                                                                                                       | Not applicable                                                                                                            | Good for specifications, not account collection                                                                                                    |
| Official Open Payment API              | Current wallet total and `balanceDetails`, subject to `get_balance` or `mini_app_payment_balance` scopes and explicit user authorization                                                                                                 | Authorization has an onboarding-defined expiry and can be revoked; calls can extend it in documented cases                | Clean JSON and good scheduled-call potential, but merchant approval and network controls make onboarding cost **5/5**                              |

Official source references:

- [Balance types and point behavior](https://paypay.ne.jp/help/c0048/)
- [Current balance breakdown](https://paypay.ne.jp/help/c0051/)
- [Transaction history and filters](https://paypay.ne.jp/help/c0141/)
- [PayPay balance history detail](https://paypay.ne.jp/help/c0075/)
- [Transaction, point-grant, and breakdown navigation](https://paypay.ne.jp/help/c0413/)
- [Usage report](https://paypay.ne.jp/help/c0078/)
- [Point history and expected-grant calendar](https://paypay.ne.jp/help/c0410/)
- [Limited-time point history and expiry](https://paypay.ne.jp/help/c0464/)
- [Consumer transaction CSV](https://paypay.ne.jp/help/c0447/)
- [Official wallet balance API](https://www.paypay.ne.jp/opa/doc/jp/v1.0/get_balance.html)
- [Official user authorization flow](https://www.paypay.ne.jp/opa/doc/jp/v1.0/account_link.html)

### CSV granularity and omissions

The official consumer CSV has these 13 columns:

1. transaction date and time;
2. outgoing amount in JPY;
3. incoming amount in JPY;
4. overseas outgoing amount;
5. currency;
6. conversion rate in JPY;
7. country;
8. transaction description/type;
9. counterparty;
10. transaction method;
11. payment installment type;
12. user; and
13. transaction number.

The export excludes processing, failed, expired, cancelled, and over-limit
transactions. Refund transactions are included. Automatic onward transfers
from PayPay Salary Receipt are excluded. The export identifies a payment
method such as PayPay balance, but does not document a column containing the
per-payment split among Money, Money (salary), Money Lite, and points.
Limited-time points are labelled as `PayPayポイント`, the same as ordinary
points; a transaction number beginning with `lp-` identifies a limited-time
point grant. Consequently, CSV is strong transaction evidence but cannot by
itself produce a complete balance-type ledger or expiry-lot ledger.

### Multiple paths for the same or related value

| Value                                 | Paths                                                                                                | Precision versus automation                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Total usable wallet value             | Wallet UI; Android wallet-display API observed by `mnie`; OPA balance API after approval             | `mnie` is cheap after a token is supplied, but does not expose the official UI's full type breakdown. OPA is stable/documented but expensive to obtain. UI is authoritative but app-bound.                                                                                                                           |
| Money / Money Lite / points           | Wallet breakdown UI; older unofficial `getBalanceInfo`; current `mnie` summary; OPA `balanceDetails` | UI has the clearest consumer semantics. The older endpoint parsed separate e-money, prepaid, and cashback fields, but is stale and unverified. Current `mnie` intentionally maps only total/transferable/payoutable, so those values must not be relabelled as the four official types without live schema evidence. |
| Payment / charge / withdrawal history | App transaction list/detail; CSV; usage report                                                       | CSV is easiest and covers two years, but omits non-final states and subtype allocation. App detail is richer. Report is only monthly aggregate and should be used as a reconciliation check.                                                                                                                         |
| Ordinary point award                  | Transaction history; point screen; expected-grant calendar; CSV after grant                          | Transaction detail preserves the link to a payment and expected date. CSV is durable after grant but has no expected state. Point calendar is easy to read but combines ordinary and limited-time expected amounts.                                                                                                  |
| Limited-time point balance/expiry     | Limited-time point tab; transaction history/filter; notification for certain refunds; CSV            | The dedicated tab is required for expiry lots. CSV identifies limited-time grants through `lp-` but otherwise labels them as ordinary PayPay Points and does not provide the documented expiry field.                                                                                                                |

## Authentication and session reuse

### Confirmed official behavior

- A new or unusual device can require SMS authentication or an authorization
  QR code displayed by an already logged-in device. The base login flow uses
  the registered phone number and password.
- If no old logged-in device is available, the documented fallback is SMS to
  the registered phone number. Linked Google, Apple, or Yahoo! accounts and
  supported carrier-line authentication can provide other login routes.
- The app exposes login-device management and can log out all devices. PayPay
  warns that logging in again after that operation requires SMS.
- The supported Android environment is Android 9 or newer, and PayPay says an
  SMS-capable smartphone subscription is required.
- PayPay documents that transaction history and usage reports remain available
  in its restricted overseas-access mode. This does not prove that a server
  API replay from any country will be accepted.

Official references:

- [New-device SMS/QR authentication](https://paypay.ne.jp/help/c0374/)
- [New-login notification and device management](https://paypay.ne.jp/help/c0304/)
- [Supported environment](https://paypay.ne.jp/help/c0007/)
- [Overseas access mode](https://paypay.ne.jp/help/c0419/)

PayPay does not publicly document consumer-app access-token lifetime, refresh
semantics, mandatory request headers, or whether a particular session can be
replayed from a server. Treat those as unconfirmed until a read-only capture is
made from the user's current app.

### Third-party implementation evidence

`pnsk-lab/mnie` at commit
[`c87e65c`](https://github.com/pnsk-lab/mnie/tree/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-paypay)
implements only a read-only wallet-display request:

- caller supplies an origin, an already-authenticated Android access token,
  and arbitrary app/device/integrity headers;
- it calls `GET /bff/v2/getWalletDisplayInfo?usingPaymentInfoV2=false` with a
  Bearer token;
- it parses `totalBalanceInfo`, `transferableBalanceInfo`, and
  `payoutableBalanceInfo`;
- it exposes only account listing and balance listing;
- it serializes the token and headers in `exportSession()` / `importSession()`;
  and
- it has no phone/password login, SMS handling, token refresh, history,
  balance-type detail, point-lot, or CSV implementation.

The serialized session therefore supports replay only while PayPay continues
to accept that token and header set. `mnie`'s README says app login requires
device-bound state and integrity material. That is useful current third-party
evidence, not an official PayPay statement; APK and live-request inspection
must confirm the exact mechanism.

Two other unofficial projects show older consumer-web BFF shapes but should
not be adopted:

- [`EdamAme-x/paypax`](https://github.com/EdamAme-x/paypax) uses
  `/app/v1/oauth/token`, phone/password plus a generated or reused
  `client_uuid`, SMS OTP, a token cookie, `/app/v1/bff/getBalanceInfo`, and an
  arbitrary v2 BFF request that includes `getPay2BalanceHistory`. Its main
  client code was last materially changed in January 2024, and it also exposes
  payment and transfer mutations.
- [`taka-4602/PayPaython`](https://github.com/taka-4602/PayPaython) uses the
  same older login and endpoints. Its `get_balance()` parsed e-money as Money,
  prepaid as Money Lite, and cashback as points; `get_history()` called
  `/app/v2/bff/getPay2BalanceHistory`. Its main client file was last changed in
  February 2025, includes mutating methods, and says token refresh was not
  working in its example.

These projects establish that a history BFF existed, but they do not establish
current endpoint viability, retention, pagination, anti-bot acceptance, or
safe unattended login. Their login code stores phone/password and mixes
read/write methods, so only endpoint/schema ideas should be used.

The official PayPay OPA SDKs are merchant SDKs, not consumer account clients.
They do not remove the merchant approval, client scope, user authorization,
and IP allowlist requirements and should not be confused with an aggregator or
with a personal-wallet export API.

## WAF and anti-automation observations

### Confirmed for the probed hosts

- `paypay.ne.jp` public help returned through Amazon CloudFront (`Via` and
  `X-Amz-Cf-*` headers) with an nginx origin response.
- Anonymous requests from the current WSL environment to the older
  `www.paypay.ne.jp/app/v1/bff/getBalanceInfo`,
  `www.paypay.ne.jp/app/v2/bff/getPay2BalanceHistory`, and OAuth paths returned
  CloudFront 403 responses.
- An unauthenticated request to `apigw.paypay.ne.jp` reached the official OPA
  and returned a structured 401 through CloudFront, consistent with the
  official documentation's statement that OPA uses CloudFront.
- No Akamai CNAME, `AkamaiGHost` server header, or Akamai denial marker was
  observed on those hosts. There is therefore **no current evidence that the
  tested PayPay surfaces are protected by Akamai**.

### Not yet confirmed

- A CloudFront 403 alone does not distinguish deliberate hostname routing,
  regional policy, missing browser/app context, WAF, or bot detection. Do not
  label it a confirmed bot challenge.
- The current Android API origin is intentionally supplied as configuration
  to `mnie` and was not disclosed in its source. It may have different edge
  protection from the public/help, old web-BFF, and OPA hosts.
- Device integrity/attestation, certificate pinning, token binding, request
  signing, and exact required headers remain hypotheses supported by `mnie`'s
  integration boundary, not findings from a current APK.

## Android package and value of static analysis

PayPay publishes the official Android app on Google Play as package
[`jp.ne.paypay.android.app`](https://play.google.com/store/apps/details?id=jp.ne.paypay.android.app&hl=ja),
under PayPay Corporation. The listing observed on 2026-08-26 showed 50M+
downloads and a 2026-07-30 update. PayPay's own help pages link to Google Play.
No PayPay-hosted standalone APK download was found; do not use APK-mirror
sites. In practice, obtain the official installed package/splits from a
user-controlled Play-installed device if analysis is authorized.

Static analysis is **high-value discovery but not proof of replayability**. A
bounded first pass should identify:

- API origins and migrations from old `/app/v1`/`v2` BFFs;
- wallet summary/detail, transaction list/detail, pagination, point expiry,
  usage report, and CSV request/status/download request models;
- access-token/refresh code paths and expiry handling;
- required version, device, integrity, and request-signing headers;
- certificate pinning and the attestation/integrity SDKs actually present; and
- whether endpoint strings/configuration are native, obfuscated, encrypted, or
  fetched dynamically.

Obfuscation, split APKs, native libraries, runtime configuration, and pinning
may hide the important pieces. Static findings must be checked against a
read-only live network capture; do not bypass device integrity or pinning in a
production collector.

## Runtime suitability

| Runtime                               | Suitability                                                                  | Reason                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Worker                     | **Good for CSV ingestion; conditional for token replay; poor for bootstrap** | A Worker can ingest/parse a downloaded CSV and can make the simple authenticated `fetch()` used by `mnie` if a valid token/header envelope is supplied. It cannot run the PayPay Android app or receive device SMS. OPA's client-IP allowlist also needs a deliberate fixed-egress design rather than assuming ordinary global Worker egress is acceptable. |
| Cloudflare Browser Run                | **Low**                                                                      | It supplies managed Chromium, while the documented consumer data UI is in the Android app. The old consumer web-BFF route is stale/unverified, and managed Chrome does not reproduce Android device/integrity state.                                                                                                                                        |
| Cloudflare Container                  | **Low to medium**                                                            | It can run ordinary Linux/native tools and perhaps an emulator, but Play distribution, persistent device state, SMS, attestation, and app integrity make an Android-in-Container bootstrap a high-cost experiment. It is reasonable only for post-auth HTTP replay after that replay has been proven locally.                                               |
| OCI VM / Kubernetes with fixed egress | **Medium for replay; medium-low for emulated bootstrap**                     | Better for a persistent process, encrypted session envelope, fixed egress, or Android tooling. A Japanese region/fixed address is useful if policy or OPA allowlisting demands it. It still does not make an emulator equivalent to the user's real SMS-capable, Play-installed device.                                                                     |
| User-controlled physical Android      | **Best issuer / validation environment**                                     | It is the official supported environment and already owns the account session. Use it to perform manual CSV export and to issue a narrowly scoped, encrypted replay session if live capture proves that safe. It need not be the always-on collector.                                                                                                       |

Cloudflare can run server-side browser sessions, but that capability does not
change the app-only authentication boundary. See [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/get-started/)
and [Cloudflare Containers](https://developers.cloudflare.com/containers/platform-details/limits/).

## Cost and automation scorecard

Scale: implementation cost 1 is trivial and 5 is research-heavy; automation
outlook 1 is predominantly manual and 5 is suitable for unattended schedules.

| Path                                                 |           Cost | Automation outlook | Decision                                                                                                                                                   |
| ---------------------------------------------------- | -------------: | -----------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual official CSV download + Kogane import         |            2/5 |                2/5 | **Implement first.** Reliable, official, bounded, and no private API coupling.                                                                             |
| Android UI automation of CSV request/status/download |            4/5 |                3/5 | Consider after manual cadence is proven. Requires a persistent physical-device agent, async notification/status handling, and strict read-only navigation. |
| `mnie`-style current balance replay                  |            4/5 |                3/5 | Prototype next. Easy server call after session issuance, but token/header acquisition, refresh, binding, subtype coverage, and expiry are open gates.      |
| Current Android transaction/detail/point API replay  |            5/5 |                3/5 | High potential, but endpoint families, pagination, retention, schemas, and integrity controls need APK/live capture work.                                  |
| Official OPA wallet balance                          | 5/5 onboarding | 5/5 after approval | Keep as a future inquiry. Stable official JSON, but approval and allowlist overhead are disproportionate and it does not replace transaction export.       |
| Old unofficial web BFF clients                       |            5/5 |                1/5 | Reject as an implementation base. Useful only as historical endpoint/schema evidence.                                                                      |

Overall PayPay source rating:

- **Initial transaction collector:** cost **2/5**, manual but dependable.
- **Complete unattended collector:** cost **4–5/5**, with medium confidence it
  can be split into a physical-Android issuer and cloud replay consumer.
- **Best near-term coverage:** official CSV plus separate current wallet and
  limited-time-point snapshots.

## Recommended implementation sequence

1. On the user's existing official PayPay app, manually request two
   non-overlapping small CSV ranges and one repeated range. Verify UTF-8,
   inclusive/exclusive boundaries, deterministic transaction numbers,
   duplicate behavior, and whether the exact 13 documented columns match the
   current file. Keep the raw CSV; do not put account data in Git.
2. Add a local `ingest-file --source paypay` path that stores the original CSV
   before parsing. Preserve all columns and unknown values. Deduplicate by raw
   object hash first and transaction number only at the observation layer.
3. Record redacted screenshots or manual field names for the Wallet breakdown,
   limited-time expiry tab, expired-points list, and one transaction detail.
   This defines the data missing from CSV without capturing identifiers.
4. Extract the current official Play-installed Android package/splits and run
   the bounded static-analysis checklist above. Do not attempt a login or a
   mutating call during static analysis.
5. With the user operating the existing physical Android session, capture one
   read-only wallet request, one history page, one detail, one point-expiry
   page, and the CSV request/status/download sequence. Redact authorization,
   phone, device, and integrity fields before retaining schemas.
6. Test the `mnie` wallet call locally with an ephemeral token envelope, then
   test the same envelope once from the intended replay runtime. Stop on
   401/403 or app-session invalidation; do not attempt password/SMS login from
   the collector.
7. Decide independently whether balance replay and history replay pass their
   gates. It is acceptable to automate current balance while leaving CSV and
   point expiry manual.
8. Ask PayPay whether a read-only `get_balance` OPA client can be approved for
   personal finance use only if the app-token path proves too fragile. Do not
   build OPA infrastructure before approval is confirmed.

Kuebiko is not the primary capture tool for this source because the consumer
data UI is app-first. It remains useful if an app action hands off to a normal
browser or when testing the documented OPA web authorization flow, but a Chrome
capture must not be treated as an Android-app capture.

## Open questions / acceptance gates

- [ ] Confirm the current Android API origin and whether it uses CloudFront,
      another CDN/WAF, certificate pinning, or explicit attestation.
- [ ] Confirm whether the current wallet response contains type-level Money,
      Money (salary), Money Lite, ordinary point, and limited-time point values,
      beyond the three fields exposed by `mnie`.
- [ ] Measure app-list and detail pagination, the oldest accessible ordinary
      transaction, and the oldest accessible expired limited-time point.
- [ ] Confirm whether CSV range endpoints are inclusive and whether amended
      refunds replace or add rows across repeated exports.
- [ ] Confirm the CSV request/status/download API and whether physical-device
      UI automation can download without opening any mutating surface.
- [ ] Measure access-token and app-header lifetime, refresh behavior, concurrent
      session behavior, and whether a read-only replay affects the app session.
- [ ] Test local, Cloudflare, and fixed Japanese egress with the same valid
      replay envelope before attributing a failure to geography or WAF.
- [ ] Confirm whether PayPay would approve OPA `get_balance` for this non-
      merchant, read-only personal-finance use case.

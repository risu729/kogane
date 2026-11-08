# JAL Pay / JAL Mileage Bank source assessment

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26

## 1. Scope and boundaries

Separate the following read-only ledgers under the same JMB membership.

- **JAL Pay**: top-up balance, JAL Payポイント (JAL Pay points), payments, top-ups, cancellations/refunds, usage statements
- **JAL Mileage Bank (JMB)**: mileage balance, accrual/redemption records, lot expiry, Life Status displays
- **JALファミリークラブ (JAL Family Club) / JALカード家族プログラム (JAL Card Family Program)**: relationship between family mileage pooling schemes and personal accounts
- **Reservations/flight tickets/JALカード (JAL Card) billing/JAL Global WALLET foreign currency/ATM**: separate sources/ledgers

Do not make payments, top-ups, miles → JAL Pay points conversions, award redemptions, reservations/cancellations,
family registrations, or profile/authentication settings changes. Do not store JMB numbers, wallet/card/device
IDs, names, reservations, tokens, cookies, OTPs, passkey material, or actual balances/amounts; do not bypass security controls.

## 2. Research method and official URLs

- Checked official JAL Web/FAQ, JAL Pay/JMB app listings, and family schemes as primary sources.
- Observed unauthenticated public pages/headers; no account login, app launch, or actual data retrieval.
- Searched GitHub by package ID, Global WALLET host, and JAL Pay/JMB terms for public consumer transport implementations.
- Specified APK/JS decompilation and runtime observation during owner operation as next experiments.

Main official URLs:

- [JAL Pay](https://www.jal.co.jp/jp/ja/jmb/jalpay/)
- [Balance inquiry](https://www.jal.co.jp/jp/ja/jmb/jalpay/pay/usage/balance-inquiry/)
- [Top-ups](https://www.jal.co.jp/jp/ja/jmb/jalpay/pay/usage/charge/)
- [Usage history FAQ](https://faq-jp.jal.co.jp/ja/s/article/jdsp000000R0000000030482jmb)
- [Top-up balance expiry FAQ](https://faq-jp.jal.co.jp/ja/s/article/jdsp000000R0000000030211jmb)
- [JAL Pay points expiry FAQ](https://faq-jp.jal.co.jp/ja/s/article/jdsp000000R0000000030245jmb)
- [JMB usage guide](https://www.jal.co.jp/jp/ja/jmb/index08.html)
- [JMB passkey](https://www.jal.co.jp/jp/ja/jmb/jmb-login/passkey/)
- [JMB one-time password](https://www.jal.co.jp/jp/ja/jmb/jmb-login/otp/)
- [JAL Family Club](https://www.jal.co.jp/jp/ja/jalmile/jfc/)
- [JAL Card Family Program](https://www.jal.co.jp/jp/ja/jalcard/function/jfp.html)
- [JMB/JAL Pay Android app](https://play.google.com/store/apps/details?id=com.jalglobalwallet.jgw&hl=ja)
- [JAL reservation app](https://play.google.com/store/apps/details?id=jp.co.jal.dom&hl=ja)

## 3. Official routes and data scope

| Route                                   | Read scope                                                             | Granularity/state                                                           | Period/count/export                                                        | Tradeoff                                                               |
| --------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| JMB app / JAL Pay card surface          | Top-up balance, JAL Pay points, usage statements, accrued miles        | Wallet events; distinguish payments/top-ups/refunds/points                  | Official fixed periods/counts not established publicly; CSV/PDF unverified | Primary JAL Pay route, device-bound                                    |
| JAL Pay `利用明細` ("usage statements") | Payment/top-up and other details                                       | Displayed from JMB app card surface; pending/settled terminology unverified | In-app; pagination/filters/exports unverified                              | Authoritative, but adjacent writes                                     |
| JMB Web                                 | Mileage total, accrual/redemption records, expiry buckets, Life Status | Lots/events                                                                 | Filters/row limits/CSV/PDF not verified live                               | Browser bootstrap/replay candidate                                     |
| JMB app                                 | Mileage total/expiry, membership card, JAL Pay                         | Mobile summary/detail                                                       | Export unverified                                                          | Wallet/mileage in same app, separate ledgers                           |
| Family Club / Card Family Program       | Family pool usable for awards                                          | Relationship retaining personal account ownership/expiry                    | Not a full family history export                                           | Do not conflate domestic/overseas residence/card conditions            |
| Global WALLET member Web                | Legacy/related wallet management screens                               | Current relationship to JAL Pay unverified                                  | Login page exists                                                          | Do not make primary; verify boundary live                              |
| JAL reservation app/Web                 | Reservations, boarding, tickets                                        | Booking ledger                                                              | Separate source                                                            | May support mileage accrual evidence, not authoritative JMB statements |
| JAL Card member site                    | Pending/confirmed card statements/billing                              | Issuer ledger                                                               | Issuer source                                                              | Keep separate from JAL Pay/JMB                                         |

### JAL Pay

Official FAQ directs history checks through `利用明細` on the JAL Pay card surface at JMB app home.
Public information does not establish history retention, maximum rows, pagination, or CSV/PDF/printing;
verify as schemas in the current app.

JAL Pay has ordinary top-up balances and JAL Pay points added through mileage exchange/campaigns etc., with
different expiry. Top-up balances expire five years from the last increase/decrease. Mileage-top-up-derived
points expire at the end of the month 13 months later, counting the starting month; campaigns etc. use expiry
under each award's conditions. Separate buckets, change dates, expiry, and sources in addition to totals.

Official state names/timestamps for payment authorization, sales confirmation, cancellation, refund, and
top-up success/failure are unverified. Do not infer pending/settled from usage statements and balance changes
alone. Top-ups from JAL Pay to external wallets etc. are payment/transfer-equivalent writes; do not execute them for verification.

### JMB / family

Ordinary JMB miles generally expire at month-end 36 months after boarding/use; exceptions include 60 months
for accrual during JMB elite/elite plus periods. Do not calculate uniform expiry from member attributes;
use lot expiry displayed on Web/app as authoritative. Required schemas: accrual date, use date, service/type,
change, balance, expiry, status.

JAL Family Club and JAL Card Family Program differ in eligibility/residence/card conditions. Neither permanently
transfers family members' flight miles into one personal account; they pool personal accounts at eligible award
use. Retain each member's history/expiry/ownership; model pool membership and redemption allocation as separate relationships.

## 4. Authentication, MFA, passkeys, and Bitwarden

JMB officially offers passkeys and one-time passwords alongside password login. OTP destinations depend on
email/SMS settings; JAL Pay initial setup also has SMS authentication. Exact RP IDs, WebAuthn extensions,
allowed credentials, OTP triggers, trusted devices, app biometrics/PINs, and session/token lifetimes are not verified live.

Bitwarden may store WebAuthn passkeys, but whether this JMB credential exists there, matches JAL's live RP ID,
or works for app/device login is unverified. Keep vaults/passwords/passkey private keys/OTPs/device IDs out of cloud.
Bootstrap in the owner's browser/device; encrypt only source-scoped read sessions for replay. Stop automation
on passkeys/OTP/recovery/account locks. Do not change authentication settings or register new passkeys.

## 5. WAF / JS / APK / deobfuscation

WSL observations on 2026-08-26: public JAL Pay/passkey pages on `www.jal.co.jp` returned HTTP 403,
`Server: AkamaiGHost`. JAL FAQ is a public Salesforce Experience/Lightning app; Global WALLET member Web
set F5 BIG-IP cookies and redirected to login. These are edge facts for each public path, not proof of
JAL Pay app API vendor/policy.

Unauthenticated JS was established only as JAL public bundles and Salesforce Aura/Lightning. Even during static
analysis of routes/config/XHR/fetch/GraphQL/source maps, do not imitate/bypass Bot cookies/fingerprints/challenges.
Do not mistake FAQ Aura actions for private consumer APIs.

JMB/JAL Pay Android package: `com.jalglobalwallet.jgw`; reservation app: `jp.co.jal.dom`. Obtain base/split
APKs from owned devices/legitimate Play; verify signatures/versions/hashes, then use aapt2/apkanalyzer,
JADX/apktool, native strings/readelf to examine manifests, hosts/paths, JSON/protobuf, token storage,
WebView, pinning/attestation. Correlate R8 obfuscation through resources, Retrofit/OkHttp annotations,
call graphs, and runtime metadata without fabricated mappings.

Observe hosts/paths/methods/statuses, header names, and redacted schemas once while the owner opens existing
balances/history. Classify payment/top-up/point conversion/award/booking/family/profile endpoints as denied
by name only. If pinning/attestation hides them, do not remove it or hook around it; record the observation barrier.

## 6. Third-party transport/auth

GitHub searches by package ID, JAL Pay/API, and Global WALLET member host found no public consumer balance/history
client, SDK wrapper, or session/login implementation. Package ID results were app inventories etc., not
transport evidence. This is negative evidence at search time, not proof of nonexistence.

JAL flight/award search, travel reservations, corporate/partner APIs, and card statement clients are separate
data families; do not repurpose them as personal JMB/JAL Pay consumer APIs. Establish concrete transport/auth
through official APK static analysis and redacted owner-operated observations. Without public implementations,
do not probe guessed hosts/paths.

## 7. Read/write isolation

- Allowlist only observed balance, history list/detail, mileage balance/accrual/redemption reads.
- Deny JAL Pay pay/top-up/withdraw/point conversion, payment sources, card/Google Pay registration.
- Deny JMB award exchange, booking, cancellation, family enrollment, profile/passkey/OTP settings.
- Login bootstrap POST is a separate owner-operated boundary. Give collectors no generic POST/arbitrary URLs/write-scope tokens.
- Fix hosts/paths/queries/content-types/schemas. Stop on unknown redirects/deep links/intents.
- Do not emit raw responses/tokens/JMB numbers/merchants/bookings/actual amounts to logs, traces, crash dumps, or CI.
- Stop on 401/403/409/429, Akamai challenges, OTP, schema/version drift, device/integrity requirements.

## 8. Runtime suitability

| Runtime                 | Suitability                    | Assessment                                                                         |
| ----------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| Owner browser/device    | Best                           | Passkey/OTP/SMS bootstrap, official displays, redacted observation                 |
| Local WSL               | Suitable                       | APK/JS/DOM parsers, sanitized artifact processing                                  |
| Cloudflare Workers      | Low to conditional             | Possible for proven GET/token replay; Akamai/passkey/device binding challenges     |
| Cloudflare Containers   | Conditional                    | Can isolate full browser/parser, no mobile trust                                   |
| OCI container           | Conditional                    | Replay tests with digest pinning, secret store, read-only FS, egress allowlist     |
| Kubernetes              | Excessive                      | CronJob/Secret/NetworkPolicy possible, but excessive cost for one member           |
| Physical Android device | Essential for JAL Pay research | Legitimate app/device state; routine UI automation fragile due to updates/write UI |

## 9. PR #5 common A-E / cost

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper, 5 = device-bound/adversarial

| Route                                       |       Level | Cost | Assessment                                                      |
| ------------------------------------------- | ----------: | ---: | --------------------------------------------------------------- |
| Manual JMB Web/app checks/sanitized capture |           E |  1-2 | Safe; official export/periods unverified                        |
| JAL Pay app manual capture                  |           E |    2 | Can read balance buckets/history; outside-app export unverified |
| JMB browser bootstrap + read replay         | C candidate |    4 | Passkeys/OTP/Akamai/sessions unverified                         |
| JAL Pay app bootstrap + API replay          | C candidate |    5 | Transport/token/device binding unverified                       |
| Full app UI automation                      |           D |    5 | Devices/SMS/biometrics, updates, write UI                       |
| Documented consumer API                     |  No A route |    5 | No public official API                                          |

Overall **D/cost 5**; safe default **E/cost 1-2**. Update JAL Pay to C if read APIs and renewable scoped
sessions are demonstrated; to a B candidate if stability is also established.

## 10. Read-only live verification / stop conditions

1. Check only official domains/packages/versions/signers and login/passkey/OTP/SMS triggers. Owner enters secrets.
2. In JAL Pay, check top-up balance/point buckets/expiry, history types/statuses, earliest date, counts, pagination, details, exports.
3. If existing cancellations/refunds/failures exist, record only status names. Do not create payments/top-ups/exchanges.
4. On JMB Web, check totals, expiry lots, accrual/redemption columns, period filters, pagination, row limits, CSV/PDF controls.
5. For Family Club/Card Family Program, check only member counts, pool displays, relationship to personal accounts. Do not enter registration/awards.
6. Statically analyze legitimate split APKs/public JS, separately tabulating read/write hosts/paths/tokens.
7. Observe redacted network metadata once while the owner opens existing history. Stop on unknown/write candidates.
8. Try replay candidates once each: same device → local host → OCI. If device/integrity-bound, abandon cloud use and return to manual routes.

Stop: payment/top-up/point conversion/award/booking/cancellation/family/profile operations, OTP/recovery,
PIN/biometrics, Bot challenges, pinning/attestation, unknown hosts/paths, POST/PUT/PATCH/DELETE (except owner
login), 401/403/409/429, account locks, PII redaction failure, schema drift. Do not disable security controls.

## 11. Facts, hypotheses, and unverified items

**Established facts:** JAL Pay usage statements within JMB app; five-year top-up balance expiry; mileage-derived
points expire at month-end 13 months later; ordinary JMB 36 months and elite etc. 60-month exceptions;
family pooling schemes; JMB passkeys/OTP/JAL Pay SMS; public Akamai/Salesforce/F5 routes; no public client found.

**Hypotheses:** Internal app balance/history read transport and pagination exist, but hosts/paths/schemas/tokens
are unverified. Model family pools as relationships without double counting individual member events.

**Unverified:** JAL Pay history periods/counts/exports, all pending/settled states, API/token renewal/device binding/
pinning/attestation, JMB statement periods/counts/official exports, Bitwarden credential compatibility,
family redemption allocation, Global WALLET member Web/current JAL Pay scope, Web/app schema consistency.

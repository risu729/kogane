# Opal / Transport for NSW source assessment

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26

## 1. Scope and ledger boundaries

Separate two Transport for NSW ledgers:

- **Opal card/account**: per-card stored-value balances, pending balances, taps/trips, top-ups, reversals, adjustments,
  balance transfers, etc.
- **Contactless payment activity / Transport Connect**: trips paid with bank cards or Apple Pay/Google Pay device
  tokens, fares, benefits/discounts, daily bank card charges

Multi-card Opal accounts enumerate cards, but balances/activity remain per card. Contactless cards have no
Opal stored-value balance and differ from unregistered-card lookup using Opal numbers/security codes. Physical
cards/digital wallets may be separate tokens even for the same bank card; do not merge by PAN suffixes/timing alone.

No top-up/auto top-up, card linking/registration/activation/blocking, balance transfer, fare adjustment/refund,
nickname/payment/profile/security settings changes. Save no card/account/payment/device IDs, PANs, security
codes, CVVs, names, itineraries, locations, tokens, cookies, secret questions/answers, actual balances/amounts;
no security-control bypass.

## 2. Research method and official URLs

- Checked official Transport for NSW guides/terms/privacy/app listings as primary sources.
- Read-only static observation of unauthenticated login HTML, public Angular bundles, response headers.
- Compared public third-party clients through GitHub current hosts/paths/package ID/legacy clients searches.
- No account login, owner card/app operation, actual data retrieval, APK acquisition/decompilation, authenticated network observations.

Main official URLs:

- [Opal card balance and activity](https://transportnsw.info/tickets-fares/opal/manage-your-card/opal-card-balance-activity)
- [Register your Opal card](https://transportnsw.info/tickets-fares/opal/manage-your-card/register-your-opal-card)
- [Manage your Opal card](https://transportnsw.info/tickets-fares/opal/manage-your-card)
- [Opal login](https://transportnsw.info/tickets-fares/opal-login)
- [Top up your Opal card](https://transportnsw.info/tickets-fares/opal/top-up-your-opal-card)
- [Transfer balance and block a card](https://transportnsw.info/tickets-fares/opal/manage-your-card/transfer-balance-block-card)
- [Opal refunds and fare adjustments](https://transportnsw.info/tickets-fares/opal/manage-your-card/opal-refunds-fare-adjustments)
- [Opal terms of use](https://transportnsw.info/tickets-fares/opal/opal-terms-of-use)
- [Opal refund and balance transfer policy](https://transportnsw.info/document/2081/opal-refund-balance-transfer-policy.pdf)
- [Opal Travel app](https://transportnsw.info/plan/transport-apps/opal-travel-app)
- [Opal Travel app terms](https://transportnsw.info/ota-terms)
- [Opal Travel app help centre](https://transportnsw.info/plan-0/instructions-planning-guides/opal-travel-app-help-centre)
- [Official Android app](https://play.google.com/store/apps/details?id=au.com.opal.travel)
- [Protect your personal information](https://transportnsw.info/tickets-fares/opal/protect-your-personal-information)
- [Contactless payments](https://transportnsw.info/tickets-fares/contactless-payments)
- [Contactless payment activity](https://transportnsw.info/tickets-fares/contactless-payments/contactless-payment-activity)
- [Help checking contactless activity](https://transportnsw.info/tickets-fares/contactless-payments/help-checking-your-contactless-activity)
- [Contactless reimbursements](https://transportnsw.info/tickets-opal/opal/contactless-payments/contactless-reimbursements)
- [Opal Privacy Policy](https://transportnsw.info/document/2107/Opal%20Privacy%20Policy_0.pdf)

## 3. Official routes, enumeration, granularity, periods, exports

| Route                        | Read scope                                                              | Granularity/state                                 | Period/count/export                                                           | Tradeoff                                                                                |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Registered Opal Web          | Multiple account cards, states/nicknames/balances/pending/activity      | Per-card trips/top-ups/reversals/adjustments etc. | Up to 18 months/card; official downloads, format unestablished publicly       | Broadest official Web, adjacent writes                                                  |
| Unregistered Opal Web        | One card balance/activity                                               | Recent trips/top-ups/reversals                    | Latest 10                                                                     | No account, but needs 16-digit card/four-digit security code; unsuitable for automation |
| Opal Travel app              | Linked cards/balances/activity/top-up-auto top-up/contactless activity  | Separate card/contactless summaries/details       | Periods/counts/download formats unverified in public listings                 | Official mobile entry, adjacent writes                                                  |
| Transport Connect            | Registered physical/digital payment card trips/fares/benefits-discounts | Contactless trips/payment information             | Up to 18 months/download; CSV/PDF formats unestablished publicly              | Separate account/ledger from stored-value Opal                                          |
| Unregistered contactless Web | Recent payment-card trips                                               | Mode/tap-on-off datetimes/fares                   | Generally 10; privacy policy says latest settlement day or 10, whichever more | PAN/expiry/CVV and $1 preauthorization each access; excluded from live checks           |
| Bank statements              | Settled contactless charges                                             | Daily aggregate 04:00–03:59 next day              | Issuer retention/exports                                                      | Daily charges, not individual trips/Opal activity substitute                            |

### Opal card/account

Official guidance allows up to 18 months per registered card of travel/payment history viewing/download.
Unregistered: latest 10 activities (trips/top-ups/reversals). Activities include trips/top-ups/adjustments;
online balances/activity may lag up to 48 hours. Delay does not necessarily mean failure/pre-settlement.

Public Web card models include `SmartcardId`, `CardNickName`, `CardTypeDescription`, `CardState`, `SVBalance`,
`SVPending`, `PendingBalanceActivation`, `LastSeenDateTime`, `CardExpiryDate`, auto top-up information, etc.
Account `SmartcardDetails` enumerates cards; details return one card's state. Do not store raw card IDs/nicknames;
convert to source-local opaque keys. May display auto top-up settings, never change them.

Public activity models include amounts, start/end datetimes, transaction types, journey types/modes,
origins/destinations, activity IDs, full fares/discounts, fare-cap/off-peak/reward flags, etc. UI filters trips,
top-ups, incomplete journeys. Established displayed types: trips/manual-auto top-ups/reversals/adjustments/
balance transfers/OpalPay/card block-cancellation-expiry etc. Current bundle display classes, not guaranteed full backend enums.

Forgotten taps lead to default fares/unknown endpoints. Do not fill `incomplete` into ordinary trips; preserve
missing locations. Online top-ups become ready in about 15–60 minutes, applied to cards by tapping within 60 days.
Keep online/pending/card balances/payment authorizations distinct. Reversals/adjustments/refunds/transfers
are separate events, not overwrites of originals.

Current Web requests selected months/latest seven days with `nr=500` for registered cards; limits unregistered
to `nr=10` even with broad dates. 500 is observed UI per-request limit, not total 18-month limit. Designed for
`HasMoreResults`/offset pagination, but >500 paging not verified live. Official download CSV/PDF/print formats,
columns/limits also unverified; help mentioning download does not establish CSV.

### Boundary with contactless journeys

Transport Connect displays/downloads up to 18 months of trip details (dates/times/locations/benefits-discounts)
and payments. Unregistered lookup generally latest 10, requesting PAN/expiry/CVV and potentially $1 pending
authorization each access; not for read-only live verification.

Contactless bank billing aggregates journeys daily 04:00–03:59 next day. Trips and bank-settled daily charges
are not one-to-one. Reimbursements have separate later states: approved credit may offset next fares, or
bank refunds may occur later, sometimes absent from activity. Do not join payment card/device token, Opal card,
and bank statement ledgers by amount/time alone.

## 4. Authentication, MFA, passkeys, and Bitwarden

Facts from public login/current bundles on 2026-08-26:

- Registered username/password to `POST /api/opal/login`; successful responses include `access_token`, `expires_in`.
- Unregistered card number/security code to `POST /api/opal/opal-login`.
- Frontend sends `Authorization: Bearer ...`, stores account/token in `sessionStorage` `opal-account`, expiry in
  `opal-session`; logout `DELETE /api/opal/logout`.
- Public login distinguishes 401, account-lock-equivalent 423, reCAPTCHA-failure etc. 403.
- Password recovery uses card/security codes/usernames/secret questions-answers/new passwords; write/recovery flow.
- No `passkey`, `webauthn`, `PublicKeyCredential` in current public bundles; official pages did not establish MFA,
  passkeys, trusted-device/device-binding specifications.

Last point does not prove absence of MFA/passkeys. Authenticated risk challenges/app biometrics/device
registration/token refresh-revocation/session lifetime unverified. On login/OTP/recovery/locks/reCAPTCHA,
return to owner's browser; collector must not retry.

[Official Bitwarden](https://bitwarden.com/help/auto-fill-browser/) browser autofill may assist owner username/
password input. Credential existence/actual compatibility unverified; no basis for exporting card/security codes,
secret answers, bearer tokens from vault to collector. Passkey relationship remains inapplicable/unverified
until official WebAuthn support established.

## 5. WAF / CDN / anti-bot / public JS

Anonymous read-only observations on 2026-08-26: `transportnsw.info/tickets-fares/opal-login` HTTP 200,
`Server: Apache`, CloudFront `Via`/`X-Cache`; frontend bundles `/opal-view/runtime.js`, `polyfills.js`,
`vendor.js`, `main.js`. Legacy `https://www.opal.com.au/` returned 403, `/_Incapsula_Resource` references,
`visid_incap_*`/`incap_ses_*` names, establishing Imperva Incapsula. No cookie values recorded.

Public edge observations do not establish all authenticated/app API/bot policies. Public bundles show login/
payment reCAPTCHA. Do not imitate/bypass CloudFront/Imperva/reCAPTCHA cookies/fingerprints/challenges;
stop on 403/423/429/challenges/unexpected redirects. No concrete Akamai evidence found; do not infer Akamai WAF.

Public JS static analysis is reverse engineering: format minified symbols, cross-check route literals/methods/
serializer fields/pagination/token stores with call sites. Record private source maps/obfuscation/WAF barriers
accurately as failed analysis; do not repeatedly probe guessed endpoints.

## 6. Established Web transport and read/write isolation

Read routes established by comparing current public bundles/third-party clients:

| Method/path                                                                                                       | Purpose                        | Established response outline                  |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------- |
| `GET /api/opal/api/customer/smartcards/`                                                                          | Account cards                  | `SmartcardDetails`                            |
| `GET /api/opal/api/smartcard/details/{cardId}`                                                                    | One card balance/state/details | `SVBalance`, `SVPending`, etc.                |
| `GET /api/opal/api/smartcard/activity/{cardId}?start={offset}&nr={count}&from=YYYY-MM-DD&to=YYYY-MM-DD&sort=desc` | Card activity                  | `HasMoreResults`, `SmartcardActivityDetail[]` |

Undocumented consumer Web APIs, no official compatibility/terms/rate-limit/token-refresh guarantees.
Login POST is owner bootstrap; read allowlists get no generic POST capability.

Explicitly denied write/control routes found in same bundles:

- Smartcard top-up/register/activate/hotlist-block/balance transfer/nickname changes
- Auto top-up/payment token-BPOINT/profile-security-password-recovery
- Fare adjustment/refund requests/card linking/other unknown POST-PUT-PATCH-DELETE

Exclude even GETs for available top-up amounts etc., closely tied to write UI. Fix host/method/path patterns/
queries/content-types/response schemas, no redirects. Emit no raw responses/card-account-activity IDs/locations/
itineraries/actual amounts/tokens to logs/traces/crash dumps/CI. Stop without saving on schema drift/unknown fields.

## 7. APK / deobfuscation / read-only runtime observation

Official Android package `au.com.opal.travel`. No APK obtained; infer no version/signers/app hosts/token
stores/pinning/device-integrity metadata from public listings. Next obtain base/splits from legitimate Play
installation on owner devices. Official app terms restrict decompilation/reverse engineering except where
inapplicable under law. Before execution check applicable terms/legal exceptions/authority over owned copies;
limit to permitted interoperability/read-only research.

1. Obtain base/splits with `adb shell pm path au.com.opal.travel`/`adb pull`; record package/version/hashes/signers.
2. Use `apksigner`, `aapt2`/`apkanalyzer` for manifest/SDK/exported components/deep links/network config.
3. Use JADX/apktool, resources/DEX strings, Retrofit/OkHttp annotations, JSON/protobuf, WebView bridges, native
   `strings`/`readelf` to classify read-write hosts/paths/methods/pagination/token renewal-storage/device-integrity metadata.
4. Trace R8 etc. through resource IDs/call graphs/serializer fields/runtime stacks, recording symbol recovery confidence.
5. Observe one owner-operated existing card/activity or contactless activity read through standard diagnostics/explicit proxy:
   hosts/paths/methods/status/header names/redacted keys-types only. No top-up/auto-top-up/card-management/refund controls.
6. If pinning/root-jailbreak/Play Integrity/device attestation prevents observation, record barriers without removal/hooks/bypass.

Reverse engineering itself is in scope. No security-control bypass; proceed to collector candidates only
if reads can be mechanically isolated from writes.

## 8. Third-party transport/auth

Concrete current-family implementation [wallarug/opal-exporter](https://github.com/wallarug/opal-exporter/blob/a9a1797a7f9abf5aa005c3001fbd120ba03983fa/py/export.py)
manually configures browser-obtained bearer tokens, HTTPS GETs `transportnsw.info/api/opal/api/customer/smartcards/`
and card activity monthly with `nr=500`, writes CSV. Independent current route/pagination evidence, but no
renewal/login; emits card numbers/status/nicknames, so do not adopt unchanged. Repository license metadata
`NOASSERTION`, last push 2024-04-20. Transport evidence only; no code import without verified licenses/permission.

[cyclotron3k/opal_card_api](https://github.com/cyclotron3k/opal_card_api), [dsymonds/opal](https://github.com/dsymonds/opal),
[tbasse/opaler](https://github.com/tbasse/opaler) form-POST usernames/passwords to legacy `www.opal.com.au`,
read `/registered/...` HTML/JSON with cookies. Current official frontend bearer API/anonymous legacy Imperva
403 make these stale evidence only. Direct password/cookie custody and Transport for NSW warnings against
sharing personal information outside approved sites/apps also rule them out for deployment.

Metadata: `opal_card_api` MIT (last push 2020-03-09), `dsymonds/opal` Apache-2.0 (2015-10-02), `opaler` MIT
(2023-01-06). Usable licenses do not guarantee protocol currency/safety.

Generic package inventories/physical-card readers are not online account transport evidence. No public official
consumer API/SDK, OAuth delegation, scoped read tokens, or public token-renewing clients established.

## 9. Runtime suitability

| Runtime               | Suitability           | Assessment                                                                         |
| --------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| Owner browser/device  | Best                  | Official UI/downloads/owner bootstrap/redacted network observation                 |
| Local WSL             | Suitable              | Public JS/APK static analysis, sanitized parsers/manual exports                    |
| Cloudflare Workers    | Conditional           | Proven bearer GET replay lightweight, unsuitable password login/WAF/refresh-reauth |
| Cloudflare Containers | Conditional           | Browser bootstrap/parser isolation, no mobile device trust                         |
| OCI container         | Conditional           | Web replay tests with digest pinning/secrets/read-only FS/egress allowlists        |
| Kubernetes            | Excessive             | CronJob/Secret/NetworkPolicy possible, excessive operations for one Opal collector |
| Physical Android      | Suitable app research | Legitimate app/device state; routine UI automation fragile from writes/updates     |

No passwords/card security codes in Workers. Consider GET replay only after safe renewal of owner-browser
source-scoped/short-lived/read-only-equivalent sessions is demonstrated. Use Containers/OCI for full browsers,
Android for app-only research; defer K8s until operating many sources together.

## 10. PR #5 common A-E / cost

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper, 5 = device-bound/adversarial

| Route                                                |       Level | Cost | Assessment                                                         |
| ---------------------------------------------------- | ----------: | ---: | ------------------------------------------------------------------ |
| Registered Opal official download + sanitized import |           E |    1 | Up to 18 months; formats/automation suitability unverified         |
| Manual unregistered latest-10 Opal capture           |           E |    1 | Small; card/security codes make cloud unsuitable                   |
| Opal Web bearer GET replay                           | C candidate |    3 | Concrete read APIs, renewal/stability/terms unknown                |
| Opal Travel app bootstrap + read replay              | C candidate |    4 | Package only established, APK/hosts/tokens/device metadata unknown |
| Full browser/app UI automation                       |           D |  4-5 | Adjacent writes/WAF-reCAPTCHA/UI-app updates fragile               |
| Transport Connect manual download                    |           E |  1-2 | Separate contactless ledger, up to 18 months, formats unknown      |
| Transport Connect headless replay                    | C candidate |    4 | Auth/APIs/tokens/device-card mapping unknown                       |
| Documented scheduled consumer API                    |  No A route |    5 | No public official API/OAuth/scoped tokens established             |

Overall **C candidate/cost 3**; safe default **E/cost 1**. Current Web structured GETs concrete, but not B
until renewable sessions/rate limits/schema stability/terms demonstrated. Evaluate contactless independently
as another collector.

## 11. Read-only live verification / stop conditions

1. Check official domains/packages/versions/signers. Owner inputs credentials; save no tokens/card/security codes.
2. Registered Web: check card enumeration/types-states/balances-pending/activity columns-filters/oldest month/month
   boundaries/>500 pagination/download controls/actual formats-columns. No actual values in notes/captures.
3. Read only naturally existing trips/top-ups/reversals/adjustments/incomplete/default-fare events. Create no test events.
4. If existing delayed events exist, observe only state names within 48 hours; no new top-ups/taps.
5. Transport Connect only existing registered accounts: physical/digital cards/trips-details/max periods/formats.
   Do not open unregistered forms that may cause $1 authorizations.
6. Bank comparison: redacted daily aggregates only, no PAN/device tokens/locations/amounts.
7. Statically analyze legitimate splits/public JS, separately tabulating read-write hosts/paths/tokens/device-integrity metadata.
8. Observe network metadata once while owner opens existing balances/activity. Stop at unknown/write candidates.
9. Known GET replay once each on owner device/local host; 401/403/423/429/WAF challenges/schema drift → manual.

Stop: top-up/auto top-up/card register-link-activate-block-transfer/fare adjustment-refund/payment-profile-security
changes/password recovery/OTP-MFA-reCAPTCHA-locks/unregistered contactless $1 authorizations/Bot challenges/
pinning-attestation/unknown hosts-paths-redirects/POST-PUT-PATCH-DELETE (except owner login bootstrap)/
401-403-409-423-429/PII redaction failure/unexpected schema-app version drift. Do not disable security controls.

## 12. Facts, hypotheses, and unverified items

**Established facts:** Registered 18-month view/download, unregistered card/contactless latest 10, up-to-48-hour
reflection delays, multi-card enumeration, balance-pending-activity models, Web bearer login/three read GETs,
activity offsets/`nr`/date ranges, CloudFront/legacy Imperva, contactless daily aggregates/separate ledgers,
official Android package, current third-party exporter/legacy clients.

**Hypotheses:** Current bearer sessions may safely replay restricted GETs after owner-browser bootstrap.
App likely has equally/more structured reads. Bitwarden autofill may assist username/password bootstrap.
None demonstrated live.

**Unverified:** Official CSV/PDF/other formats/columns/limits; >500 pagination; all activity enums/official
pending-settled states; token lifetimes/refresh/revocation; MFA/passkeys/trusted devices; app versions/signers/
APIs/schemas/pinning/integrity; Transport Connect auth/APIs/device-token mapping; third-party terms/rate limits;
Cloudflare/OCI replay suitability; stable deduplication keys.

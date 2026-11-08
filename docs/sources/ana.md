# ANA Pay / ANA Mileage Club source assessment

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26

## 1. Scope and prohibitions

Separate the following ledgers even under the same ANA Mileage Club (AMC) membership.

- **ANA Pay**: prepaid balance, top-ups, Visa/iD and other payments, cancellations/refunds, usage history
- **AMC**: balances by mileage account group, accrual/redemption statements, individual expiry dates, Premium Points, etc.
- **ANAカードファミリーマイル (ANA Card Family Miles)**: the scheme boundary pooling family members' personal accounts at award redemption
- **Reservations/flight tickets/ANA SKY コイン (ANA SKY COINS)/ANA card billing**: separate sources; do not conflate with balances/statements

Do not make payments, top-ups, mileage-to-ANA Pay conversions, award redemptions, reservations,
cancellations, family registrations, or profile/authentication settings changes. Do not store AMC numbers,
wallet/device IDs, names, reservations, tokens, cookies, OTPs, passkey material, or actual balances/amounts;
do not bypass security controls.

## 2. Research method and official URLs

- Prioritized official ANA/ANA X pages/FAQs and Google Play.
- Observed public web pages/headers/JS entry points requiring no authentication from WSL; did not log in to accounts.
- Searched public GitHub implementations by package ID, ANA Pay host, and AMC statement URL, inspecting transport/schema in code.
- Did not retrieve/decompile APKs or capture the owner's data at runtime. Specified next experiments.

Main primary sources:

- [ANA Pay](https://www.ana.co.jp/ja/jp/amc/ana-pay/)
- [ANA Pay top-ups](https://www.ana.co.jp/ja/jp/amc/ana-pay/usage/charge/)
- [ANA Pay usage history FAQ](https://faq.ana-x.co.jp/faq/anapay/web/knowledge731.html)
- [ANA Pay balance expiry FAQ](https://faq.ana-x.co.jp/faq/anapay/web/knowledge729.html)
- [How to check miles](https://www.ana.co.jp/ja/jp/amc/check/)
- [Mileage expiry](https://www.ana.co.jp/ja/jp/amc/valid/)
- [AMC two-step verification](https://www.ana.co.jp/ja/my/amc/about-amc-two-steps-verification/)
- [One-time passwords](https://www.ana.co.jp/ja/jp/amc/news/info/2022/amc_login_detail.html)
- [ANA Card Family Miles](https://www.ana.co.jp/ja/jp/amc/anacard/familymile/)
- [ANA Mileage Club Android app](https://play.google.com/store/apps/details?id=jp.co.ana.anamile&hl=ja)
- [ANA travel app](https://play.google.com/store/apps/details?id=jp.co.ana.android.tabidachi)

## 3. Official routes, granularity, periods, and exports

| Route                               | Read scope                                                        | Granularity/state                                                    | Period/count/export                                                                              | Tradeoff                                                              |
| ----------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| ANA Mileage Club app / ANA Pay home | ANA Pay balance, usage history, top-ups, payments                 | Wallet events, including cancellations/refunds/cashback              | Generally 12 months; iOS maximum 999 rows, Android all history. Cannot view outside app or print | Official authoritative record, but device-bound                       |
| Candidate ANA Pay internal read API | Balance, registered source status, history                        | JSON events, pageNumber/pageSize                                     | Public implementations paginate; not an official API                                             | Headless candidate, but substantial device ID/token boundary          |
| AMC Web                             | Group balances, accrual/redemption records, expiry, PP, SKY COINS | Accrual/redemption units; separate limited-use/limited-period groups | Selectable periods/row limits in live UI unverified; official CSV/PDF unverified                 | DOM/export candidate after browser bootstrap                          |
| AMC app                             | Miles/expiry/PP, ANA Pay entry, digital membership card           | Mobile summary/detail                                                | Export unverified                                                                                | Convenient integrated account display; costly UI automation           |
| Official notifications/email        | Accrual/expiry and other notifications                            | Event notifications, not a ledger                                    | Not comprehensive                                                                                | Supplementary evidence only                                           |
| ANA Card Family Miles               | Family amount poolable at award use                               | Pool retaining individual account ownership/expiry                   | Not a full family history export                                                                 | Do not mix family statements into the prime member's personal account |

### ANA Pay

The official FAQ says top-ups and payments can be checked in `利用履歴` ("usage history") on home,
generally for 12 months after use: up to 999 rows on iOS and all usage history on Android. Depending on timing,
older than 12 months may be visible; do not treat this as a retention guarantee. Printing and viewing outside
the app are unavailable. Monthly top-up amounts include refunds for purchase cancellations and campaign
cashback, so do not interpret a `チャージ` ("top-up") display solely as external funding inflow.

ANA Pay balance expires 48 months from the month following its last use or top-up. Moving AMC miles to
ANA Pay creates a separate wallet balance/expiry, so treat the pre-conversion AMC event, post-conversion
ANA Pay top-up, and payment as separate events. Official pending/settled field names are unverified.
Do not infer authorization, sales confirmation, cancellation, refund, or cashback from balance differences alone.

### AMC miles

AMC account groups 1–4 differ in available awards and expiry. The official general rule gives ordinary miles
until the end of the month 36 months after accrual, but use each group/lot's expiry as authoritative for
limited-use/limited-period miles and exceptions. Required schema includes accrual date, use date, statement
type, change, balance after use, and scheduled expiry month/group, in addition to totals.

Family Miles is not a shared wallet permanently transferring family members' mileage ownership: it pools
registered family members' personal accounts when applying for eligible awards. Each person's accrual,
expiry, and redemption statements remain in their AMC source. Do not add and store the whole family's miles
in the prime member's balance; represent pool membership and allocation at award use as separate relationships.

## 4. Authentication, MFA, passkeys, and Bitwarden

AMC Web is based on AMC number or similar identifiers and Web password; official guidance describes
two-step verification sending a one-time password to registered email for some services. OTP screens,
trusted-device/session lifetimes, session handoff to the ANA Pay app, and refresh policies have not been
verified live. No official source establishing passkey support was found; do not assert support or non-support.

Bitwarden can store Web passwords, but does not replace email OTP, app biometric/device ID, or ANA Pay
wallet ID. The existence of a Bitwarden item/passkey for this account has not been checked either.
Do not put vaults, email sessions, OTPs, device IDs, or refresh tokens in the cloud. Bootstrap in the owner's
browser/app; use an encrypted source-scoped envelope only if a reusable read-only session is established.
Stop on OTP, identity verification, account locks, or password change requests.

## 5. WAF / JS / APK / deobfuscation

Public `www.ana.co.jp` returned 200 from WSL and set `_abck`/`bm_sz` cookies, evidence of Akamai Bot Manager
at the edge. The old AMC gateway `cam.ana.co.jp` had `Server: AkamaiNetStorage`. These are facts about the
public web route; the ANA Pay API need not use the same WAF/policy. FAQ GET and HEAD responses differed,
showing client/method differences.

Public Web JS consists of large bundles including navigation, login gateways, and analytics; pre-authentication
static analysis alone did not establish member read APIs. Examine source maps, routes/config, XHR/fetch,
and GraphQL/REST keys read-only. Do not imitate or bypass challenge tokens, Bot Manager cookie generation,
or fingerprints.

The main Android package is `jp.co.ana.anamile` for ANA Mileage Club/ANA Pay. Travel reservation app
`jp.co.ana.android.tabidachi` is a separate package focused on reservations/boarding; do not mix it with
ANA Pay/AMC sources. Obtain split APKs from an owned device or legitimate Play flow; verify signature/version/hash,
then use aapt2/apkanalyzer, JADX/apktool, and native strings/readelf to examine manifests, hosts/paths,
JSON/protobuf, token stores, WebView, and pinning/attestation. Cross-check R8 obfuscation against resources,
Retrofit/Alamofire-equivalent schemas, call graphs, and runtime metadata; do not fabricate mappings.

For one dynamic observation while the owner opens existing balances/history, record only hosts/paths/methods/statuses,
header names, and redacted keys. Classify payment/top-up/conversion/reservation endpoints as denied by name only;
do not construct payloads. If pinning/attestation prevents observation, do not remove it or hook around it;
record the barrier as the result.

## 6. Public third-party client transport/auth

### ANA Pay: `dvcrn/pocketsmith-anapay` / `moneymoney-anapay-extension`

- [pocketsmith-anapay](https://github.com/dvcrn/pocketsmith-anapay)
- [moneymoney-anapay-extension](https://github.com/dvcrn/moneymoney-anapay-extension)

Both implementations use `https://teikei1.api.mkpst.com`. They send `anaWalletId` and `deviceId` as JSON to
`POST /ana/accounts/login`, receiving access/refresh tokens, scope, expiry, etc. They then use Bearer tokens
with `GET /accounts?balanceReferenceFlag=1&nfcStatusReferenceFlag=1` for balances/registered source/NFC/eKYC
status and `GET /salesDetails?pageSize=N&pageNumber=N&historyType=&settlementType=` for paged history.
History schema includes saleDatetime, settlementType, dealType, descriptionType, shopName, amount,
wallet settlement number/sub-number, point conversion amount, etc.

This is concrete transport prior art, not an officially documented API. The public Go implementation may
print account responses to stdout, leaking PII/secrets, and no clear license was found; do not adopt its code.
Login is an authentication POST, but protect wallet/device IDs like passwords, and do not give the collector
an unchanged token with write scope. Actual refresh token update endpoint/rotation, device binding,
current app compatibility, and pinning are unverified.

### AMC: `tuckn/userscript-ana-mile-csv-export`

The [repository](https://github.com/tuckn/userscript-ana-mile-csv-export) reads DOM such as `#meisaitable`
on logged-in `cam.ana.co.jp/psz/amcj/jsp/renew/mile/reference.jsp`, downloading displayed statements locally
as BOM-prefixed CSV. It implements no network login/API, relying on the ambient browser session.
Updated in 2026 as well, it is useful current DOM evidence, but its license could not be verified;
do not import the code. Form submissions equivalent to writes to change displayed periods, and
pagination across all periods, require separate live verification.

Do not repurpose flight search/reservation or partner/corporate APIs as personal AMC mileage/ANA Pay consumer ledger APIs.

## 7. Read/write isolation

- ANA Pay allowlist candidates are only Bearer-authenticated `GET /accounts` and `GET /salesDetails`. Login bootstrap is a separate boundary on the owner's device.
- Pin the host to `teikei1.api.mkpst.com`; verify path/query schemas and response content-type. No arbitrary URLs/generic POST.
- Deny payment source registration, charge, pay, refund requests, mile conversion, NFC registration, eKYC, and profile/device operations.
- AMC permits only balance/record inquiry GETs or observed reads. Deny award redemption, reservations, family registration, transfers, and password changes.
- Do not emit raw responses, wallet/device IDs, tokens, AMC numbers, store names, reservations, or actual amounts to logs/traces/crash dumps.
- Stop on 401/403/409/429, OTP, Bot challenges, schema/version/host differences, or tokens with only write scope.

## 8. Runtime suitability

| Runtime                      | Suitability                    | Assessment                                                                                                   |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Local browser / owner device | Best                           | OTP/device bootstrap, official displays, redacted observation                                                |
| Local WSL                    | Suitable                       | APK/JS/DOM parsers, encrypted artifact processing                                                            |
| Cloudflare Workers           | Conditional                    | Possible for proven ANA Pay GET/AMC replay; bootstrap, Akamai, and device ID/token management are challenges |
| Cloudflare Containers        | Suitable                       | Can isolate browser/parser, but has no device trust                                                          |
| OCI container                | Suitable                       | Good for replay experiments with digest pinning, secret store, read-only FS, and egress allowlist            |
| Kubernetes                   | Excessive                      | CronJob/Secret/NetworkPolicy possible, but costly for a single account                                       |
| Physical Android device      | Essential for ANA Pay research | Legitimate app/device state; routine UI automation is fragile due to updates, biometrics, and write UI       |

## 9. PR #5 common A-E / cost

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper, 5 = device-bound/adversarial

| Route                                                    |       Level | Cost | Assessment                                                                     |
| -------------------------------------------------------- | ----------: | ---: | ------------------------------------------------------------------------------ |
| Export displayed AMC statements as userscript/manual CSV |           E |  1-2 | Safe initial route; display periods/retention unverified                       |
| Manual ANA Pay app history capture                       |           E |    2 | 12 months and platform row limits; no official export                          |
| ANA Pay local bootstrap + GET replay                     | C candidate |    4 | Concrete endpoints/schemas; token renewal/device binding unverified            |
| AMC browser bootstrap + DOM/read replay                  |           C |  3-4 | Current DOM implementation exists; OTP/Akamai/session lifetimes are challenges |
| ANA Pay/AMC app UI automation                            |           D |    5 | Devices, biometrics, frequent updates, adjacent writes                         |
| Documented consumer API                                  |  No A route |    5 | No public official API/export                                                  |

Overall **C candidate/cost 4**. Safe initial routes are E/cost 1-2 for AMC and E/cost 2 for ANA Pay.
Reassess as a B candidate if ANA Pay read API renewal and scope/device binding can be demonstrated.

## 10. Read-only live verification / stop conditions

1. Check only official domains/packages/versions/signers, login methods, and 2FA triggers. The owner enters passwords/OTPs; do not record them.
2. In ANA Pay, record only schemas: balance fields, expiry, history types/statuses, 12-month boundary, counts, details, cancellation/refund/cashback displays.
3. Check iOS/Android differences only on owned devices; do not create new transactions. Recheck that export outside the app is unavailable in the current version.
4. On AMC Web, check group balances, lot expiry, accrual/redemption columns, period filters, pagination, row limits, and CSV/PDF controls.
5. For Family Miles, check only member count, pool display, and relationship to personal balances; do not enter registration/award redemption screens.
6. Statically analyze legitimate split APKs/public JS, tabulating read/write endpoints separately from token lifecycles.
7. Observe redacted metadata once while the owner opens existing history. Do not send anything beyond the two ANA Pay GET candidates; stop otherwise.
8. Replay one read each in order: same-device session → same local host → OCI. Even after verifying the renewal
   endpoint schema, do not execute it automatically; first measure lifetime using token expiry as the stop condition.

Immediate stop: payment/top-up/conversion/award/reservation/cancellation/family/settings operations,
OTP/recovery, PIN/biometrics, Bot challenges, pinning/attestation, unknown hosts/paths,
POST/PUT/PATCH/DELETE (except owner login), 401/403/409/429, account locks, PII redaction failure,
or response schema drift. Return to manual routes without bypassing controls.

## 11. Facts, hypotheses, and unverified items

**Established facts:** ANA Pay offers 12 months, iOS 999 rows/Android all rows, no viewing outside the app/printing,
and 48-month balance expiry. AMC provides group balances/expiry and two-step verification. Family Miles
pools family miles at award use. Akamai Web edge. Public implementations show ANA Pay Bearer JSON GET/pagination
and AMC DOM → CSV transport.

**Hypotheses:** ANA Pay's two GETs may fit a read collector, but public implementations alone cannot guarantee
stability, legitimate scope, or current compatibility. The AMC family pool should be represented as a relationship
avoiding double counting of individual account events.

**Unverified:** All ANA Pay pending/settled states; current API version; refresh rotation; device/integrity/pinning;
AMC statement periods/counts/official export; session lifetimes; passkey/Bitwarden compatibility;
family redemption allocation; and consistency between Web/app schemas.

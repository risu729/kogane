# WESTER / J-WEST / Wesmo! source assessment

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26

## 1. Scope and ledger boundaries

Separate these read-only ledgers sharing WESTER IDs/navigation.

- **WESTERポイント (WESTER Points)**: `基本` ("basic"), `期間・用途限定` ("limited-period/use"), `チャージ専用` ("top-up-only") balances, accrual/use, expiry
- **Wesmo!**: `残高（出金可）` ("withdrawable balance"), `残高（出金不可）` ("non-withdrawable balance"), payments/top-ups/transfers-receipts/withdrawals/cancellations etc.
- **J-WESTカード (J-WEST Card)**: issuer pending/confirmed usage/billing/refunds/family-additional statements
- **ICOCA**: SF balances/rail-retail use/top-ups/commuter passes/ICOCA-use points
- **e5489, tabiwa etc.**: reservation/ticket ledgers; may support points accrual evidence, not collected here

No payments/top-ups/transfers-receipts/withdrawals/points use-exchange-ICOCA top-up/reservations/card-account
additions/eKYC/profile-authentication settings. Save no WESTER/ICOCA/card/device IDs, names, merchants,
tokens/cookies/OTPs/passkey material/actual balances-amounts; no security-control bypass.

J-WEST statements are not points history. Refer to separate MyJCB for JCB, MUFG Card/My Digital Connect for
Visa/Mastercard; do not duplicate protocols here. Future repository references:
[MyJCB family](./myjcb.md), [MUFG Card](./mufg-card.md).

## 2. Research method and official URLs

- Official JR West portals/terms/guides/app listings as primary sources.
- Read-only unauthenticated public pages/headers/DNS CNAMEs/login HTML-JS.
- GitHub package/auth-host/WESTER-Wesmo searches for public third-party clients.
- No account login/owner app launches/actual retrieval/APK acquisition-decompilation/network interception.

Main official URLs:

- [WESTER Points](https://wester.jr-odekake.net/point/)
- [WESTER Points terms](https://wester.jr-odekake.net/terms/point-kiyaku/)
- [Top-up-only points terms](https://wester.jr-odekake.net/terms/chargepoint-kiyaku/)
- [Member support/login](https://wester.jr-odekake.net/member/entrylog/)
- [Web registration/migration](https://wester.jr-odekake.net/service/member/)
- [WESTER Android app](https://play.google.com/store/apps/details?id=jp.co.westjr.wester&hl=ja)
- [J-WEST billing statements](https://wester.jr-odekake.net/j-west/support/meisai/)
- [Wesmo!](https://wester.jr-odekake.net/wesmo/)
- [Wesmo! app guide](https://wester.jr-odekake.net/wesmo/user/guide/)
- [Wesmo! registration](https://wester.jr-odekake.net/wesmo/user/guide/register/)
- [Wesmo! top-ups](https://wester.jr-odekake.net/wesmo/user/guide/charge/)
- [Wesmo! transfers/receipts](https://wester.jr-odekake.net/wesmo/user/guide/send/)
- [Wesmo! member terms](https://wester.jr-odekake.net/assets/pdf/wesmo/terms-member01.pdf)
- [Wesmo! Payment Services Act disclosure](https://wester.jr-odekake.net/assets/pdf/wesmo/money-policy01.pdf)
- [Wesmo! Android app](https://play.google.com/store/apps/details?id=jp.co.westjr.wesmo&hl=ja)
- [Top up ICOCA from WESTER Points](https://wester.jr-odekake.net/point/store-use/use-icoca/)
- [Mobile ICOCA balances/history](https://www.jr-odekake.net/icoca/mobileicoca/use/history/)

## 3. Official routes, granularity, periods, exports

| Route                        | Read scope                                                                                          | Granularity/state                          | Period/count/export                                                                                                               | Tradeoff                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| WESTER portal member support | Points type balances/accrual-use/expiry/linked ICOCA points                                         | Points events/expiry buckets               | Ordinary points retention/limits/pagination unestablished publicly; CSV/PDF unverified                                            | Web bootstrap/replay candidate; cross-service points authority |
| WESTER app                   | Points balances/use/campaigns/card ICOCA balances/ICOCA app-e5489 links                             | Mobile summary/detail                      | Periods/counts/exports unknown                                                                                                    | Broad entry with writes/reservations                           |
| Wesmo! app                   | Withdrawable/non-withdrawable balances/payments/top-ups/send-receive/withdrawals/points use-accrual | Wallet events/transfer-link-request states | Retention/limits/pagination/CSV-PDF unknown                                                                                       | Primary Wesmo! route; device-bound/MFA                         |
| J-WEST issuer Web            | Card usage/billing/refunds/family-additional                                                        | Issuer authorization/billing events        | PDF etc. in MyJCB/MDC                                                                                                             | Separate credentials/source from WESTER                        |
| ICOCA app/member Web         | SF/rail-retail-top-up history                                                                       | ICOCA events                               | Member Web 26 weeks from previous day, maximum 100; statement/receipt PDFs from today through first day of month one year earlier | Separate ICOCA source, not WESTER points                       |
| Ticket machines              | ICOCA SF/ICOCA-use points                                                                           | Recent device-card events/monthly points   | SF normally 20, staff up to 50, within 26 weeks; points previous six months from last month view/print                            | No cloud collection, manual evidence                           |

### WESTER Points

Officially three types:

| Type               | Expiry                                                  | Main uses/collection considerations                                         |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| Basic              | End of fiscal year after accrual fiscal year (March 31) | Stores/Web/eligible products/ICOCA top-ups etc.; retain fiscal-year buckets |
| Limited-period/use | Per campaign/award                                      | Infer no common expiry; retain displayed expiry/use scope per event/lot     |
| Top-up-only        | None                                                    | ICOCA only, per-ICOCA eligible-use histories; differs from ordinary points  |

Official FAQ directs Wesmo! payment points accrual/use checks to Wesmo! app, cross-service histories to WESTER
portal. Same payment may appear in wallet/points; do not join by timestamps/merchants/amounts until
`source_event_id` equivalent established.

Top-up-only terms specify monthly awards/eligible use for previous six months from last month through member
support/ICOCA app/machines. ICOCA-use points coverage only, not total WESTER retention. Ordinary/limited points
periods/columns/pagination/exports need live checks.

### Wesmo!

Separate withdrawable/non-withdrawable buckets. After identity verification, bank/Seven Bank ATM top-ups
withdrawable; credit-card top-ups/received non-withdrawable balances non-withdrawable. Official terms give no
balance expiry. Totals alone lose transfer/withdrawal eligibility.

Terms permit balance/history on balance inquiry; official campaigns use app-history datetimes. Minimum candidate
schema `occurred_at/type/status/amount/balance_after/counterparty_or_merchant/
funding_bucket/point_delta` is a design hypothesis for live UI/API verification, not publicly established columns.

Transfer links last 48 hours, request links two weeks. Cancellable pre-receipt/confirmed post-receipt states;
do not book link creation as settled transfers. Payment authorization/sales/cancellation/refund/top-up failure-
cancellation official status names unknown. Infer no settlement from balance differences. History periods/
counts/filters/pagination/CSV-PDF-print also unknown.

### J-WEST / ICOCA boundaries

J-WEST billing/statements belong to issuer brand services: JCB MyJCB, Visa/Mastercard MDC (old guidance MUFG
Card Web). Officially separate from WESTER credentials. Awarded WESTER points do not replace statements;
one card event can yield multiple points events/later corrections.

WESTER card ICOCA balance is a convenience view. ICOCA SF/commuter/PDF in ICOCA app/member Web; ICOCA-use
points on WESTER are separate events. Points → ICOCA top-up creates points use/ICOCA inflow, a write not
performed here. Wesmo!/ICOCA are separate wallets; do not substitute balances.

## 4. Authentication, MFA, passkeys, and Bitwarden

Public login facts on 2026-08-26:

- `wester.jr-odekake.net/member/entrylog/` leads to `https://auth.westjr.co.jp/web/v1/login`.
- Password `POST /web/v1/login/do_login`; passkey `POST /web/v1/login/do_login_passkey`, same-origin CSRF forms,
  not account read APIs.
- Public HTML/JS: WebAuthn conditional mediation, `userVerification: required`, RP `auth.westjr.co.jp`;
  save no challenges/credentials/assertions.
- Old J-WEST migration uses email OTP; ordinary OTP triggers/trusted devices/lifetimes/renewal-revocation unverified.

Wesmo! bases on WESTER ID/password, registration email OTP (new IDs), phone verification, possible login OTP.
Official MFA/registered-phone outgoing-call verification/other-device re-verification explicit. After 2025-12-24
updates, app-start passcode/biometrics optional; does not establish removal of device binding. eKYC is write/
enrollment for withdrawable balances etc., not collector bootstrap.

[Official Bitwarden](https://bitwarden.com/help/auto-fill-browser/) supports browser WebAuthn passkeys, thus
a candidate WESTER provider. Credential existence/RP agreement/conditional UI/Wesmo! WebView-native compatibility
unknown. Compatibility hypothesis, no basis for vault/password/private passkeys/OTPs in collectors. Bootstrap
on owner browser/device; stop automation at OTP/passkeys/recovery/locks.

## 5. WAF / Akamai / public JS

Read-only observations on 2026-08-26: `wester.jr-odekake.net`/`auth.westjr.co.jp` CNAME to
`san-www.westjr.co.jp.edgekey.net` then `*.akamaiedge.net`, establishing Akamai. Public portal 200,
`Server: nginx`, anonymous `XSRF-TOKEN`/`wester_session` names; login `x-azure-ref`. Public edge/origin-chain
evidence, not Wesmo! app hosts/vendors/bot policies. No public GET challenge, no authenticated guarantee.

Public portal/Wesmo! JS mainly static navigation/UI/analytics, no balance/history endpoints found. Login JS
shows browser WebAuthn assertions/form POSTs. Further public JS/maps static analysis in scope, no Akamai
cookie/fingerprint/challenge imitation/bypass or repeated 401/403/429/challenge probes for discovery.

## 6. APK / deobfuscation / read-only runtime observation

Official packages: WESTER `jp.co.westjr.wester`, Wesmo! `jp.co.westjr.wesmo`. APKs not obtained; no inferred
account hosts/paths/schemas/tokens from listings. Next legitimate owner-device/Play base-split acquisition,
record package/version/signers/hashes, then:

1. `adb shell pm path`/`adb pull`, `apksigner`/`aapt2`/`apkanalyzer` manifests/signers/SDKs/exported components/
   deep links/network config.
2. JADX/apktool/resources-DEX strings/Retrofit-OkHttp annotations/protobuf-JSON/WebView/native `strings`/`readelf`
   for hosts/paths/methods/token stores-renewal/pagination/device-integrity metadata.
3. Follow R8 through resources/call graphs/serializer fields/runtime stacks-metadata; no fabricated mappings/symbols,
   record deobfuscation confidence.
4. One owner-operated existing balance/history read: standard diagnostics/explicit proxy, hosts/paths/methods/statuses/
   header names/redacted keys-types; no payment/top-up/send/points-use/booking controls.
5. Record barriers without removal/hooks/bypass if pinning/Play Integrity/root-emulator rejection prevents observation.

Reverse engineering in scope, not security bypass. Collector candidates only when read/write routes mechanically separable.

## 7. Third-party transport/auth

GitHub package/auth-host/WESTER-Wesmo-API searches found no public points/consumer wallet balance-history client,
SDK wrapper, or token renewal. Package hits advertising filters/inventories, not transport; no Wesmo! package
hits. Negative evidence as of 2026-08-26, not proof of nonexistence.

Only concrete public implementation found:
[asapoka/userscripts WESTER login userscript](https://github.com/asapoka/userscripts/blob/1371b4987a74ac6f4efb341386d10a4c948c9351/odekake.net/WESTER-login-westjr.co.jp.user.js),
fills credentials/clicks on `auth.westjr.co.jp/web/v1/login*`; UI automation, not balances/history/renewal/read
client. Source credential literals, so do not adopt.

Established consumer auth only official HTTPS forms + CSRF + passwords/WebAuthn. Points/Wesmo! read
hosts/paths/methods/schemas/app tokens/refresh/device keys/integrity unknown. Do not probe guessed paths due to missing clients.

## 8. Read/write isolation

- Only observed points balances/history/expiry, Wesmo! balances/history lists-details allowlisted.
- J-WEST/ICOCA-e5489 separate collectors, not followed with this session.
- Deny points use-exchange-ICOCA top-up, Wesmo! pay/top-up/send-receive-withdraw, bank/card registration/eKYC/limits.
- Deny booking/purchase/cancellation/profile/email-phone-passkey-biometric settings/termination.
- Login POST separate owner bootstrap; no generic POST/arbitrary URLs/deep links-intents/write tokens in collectors.
- Fix hosts/paths/methods/queries/content-types/schemas/redirects; deny suspected side effects even on GET.
- No raw responses/tokens/IDs/cards/ICOCA/phones/merchants/counterparties/actual amounts in logs/traces/dumps/CI.
- Stop 401/403/409/429/Akamai challenges/OTP-passkeys-recovery/unknown redirects/schema-app drift/
  device-integrity requirements/PII redaction failures.

## 9. Runtime suitability

| Runtime               | Suitability               | Assessment                                                                     |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| Owner browser/device  | Best                      | Passkeys/OTP/outgoing calls/bootstrap/official UI/redacted observation         |
| Local WSL             | Suitable                  | Public JS/APK static analysis/sanitized DOM-schema parsers                     |
| Cloudflare Workers    | Low to conditional        | Proven GET-token replay lightweight, unsuitable WebAuthn/Akamai/device binding |
| Cloudflare Containers | Conditional               | Browser/parser isolation, no Android trust                                     |
| OCI container         | Conditional               | Replay tests with digest pinning/secrets/read-only FS/egress allowlists        |
| Kubernetes            | Excessive                 | CronJob/Secret/NetworkPolicy, excessive operations for one member              |
| Physical Android      | Essential Wesmo! research | Legitimate state; routine UI fragile from updates/adjacent writes              |

Do not move credentials/bootstrap to Workers; consider only demonstrated renewal of source-scoped short-lived
read-only-equivalent owner-device sessions. Containers/OCI for full browsers, Android for app-only research;
defer K8s until multiple sources.

## 10. PR #5 common A-E / cost

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper, 5 = device-bound/adversarial

| Route                                      |       Level | Cost | Assessment                                                |
| ------------------------------------------ | ----------: | ---: | --------------------------------------------------------- |
| WESTER portal/app manual sanitized capture |           E |  1-2 | Safe, retention/exports unknown                           |
| Wesmo! manual balance/history              |           E |    2 | Official primary, retain buckets; external export unknown |
| WESTER browser bootstrap + read replay     | C candidate |    4 | Public login transport established; reads/renewal unknown |
| WESTER app bootstrap + API replay          | C candidate |    5 | APK/hosts/tokens/device metadata unknown                  |
| Wesmo! app bootstrap + API replay          | C candidate |    5 | MFA/outgoing calls/other-device reauth/device binding     |
| Full app UI automation                     |           D |    5 | Adjacent writes/app updates/device authentication fragile |
| Documented consumer/export API             |  No A route |    5 | No public official API/CSV-PDF export established         |

Overall **D/cost 5**; safe default **E/cost 1-2**. Stable WESTER reads/renewable scoped sessions could promote
C to B candidate; Wesmo! remains C candidate until device/integrity independence verified.

## 11. Read-only live verification / stop conditions

1. Check only official domains/packages/versions/signers/login RP/OTP-phone triggers; owner enters secrets, no storage.
2. Portal: three balance types/lot expiry/history columns/oldest dates/filters/counts/pagination/details/CSV-PDF controls.
3. App: same-point display differences/ICOCA convenience views only, no points use/coupons/campaign entry/reservations.
4. Wesmo!: withdrawable/non-withdrawable buckets/history types-statuses-timestamps/oldest dates/counts/pagination/details/exports.
5. Only naturally existing transfer links/cancellations/refunds/failures status names; no new events.
6. J-WEST statements through brand sources, ICOCA through ICOCA; design only deduplication keys with points events.
7. Statically analyze legitimate splits/public JS, separately tabulating read-write hosts/paths/tokens/device-integrity.
8. One owner-operated existing balance/history network metadata observation; stop at unknown/write candidates.
9. Replay candidates once each on same device/local host; 401/403/429 or device-integrity binding → abandon cloud, manual.

Stop payment/top-up/send-receive-withdraw/points-use/ICOCA-top-up/booking-cancellation/bank-card-eKYC-profile
settings/OTP-passkeys-recovery/outgoing-call requests/Bot challenges/pinning-attestation/unknown hosts-paths-
redirects/POST-PUT-PATCH-DELETE (except owner bootstrap)/401-403-409-429/locks/PII failures/schema drift.
Do not disable security controls.

## 12. Facts, hypotheses, and unverified items

**Established facts:** Three points types/expiry; two Wesmo! balances/history screens; transfer-request link
expiry/cancellation states; Wesmo! MFA/outgoing calls/other-device reauth; WebAuthn RP/login POST; Akamai;
J-WEST issuer boundaries; separate ICOCA retention/exports; no public read clients.

**Hypotheses:** Internal WESTER/Wesmo! structured balance/history reads/pagination. Bitwarden candidate
WESTER Web provider; public login sessions may replay safely into reads, unproven.

**Unverified:** Ordinary/limited points retention/counts/exports; Wesmo! periods/counts/exports/all statuses;
points-wallet hosts/paths/schemas/pagination/token renewal-revocation/device keys/pinning-integrity/Bitwarden
compatibility/app-portal schema consistency/event deduplication keys/Cloudflare-OCI replay suitability.

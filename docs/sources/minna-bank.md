# みんなの銀行 (Minna Bank) primary research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26

## Conclusion

For Kogane personal account data, the safe first step is **deposit transaction statement PDF manually issued
from the official smartphone app**, without an aggregator as initial route. Official FAQs say personal statements
are viewed in app and deposit statements can be exported as PDF for up to one year at a time. No personal CSV
found. Ordinary deposits (Wallet), savings deposits (Saving / Box) balances, debit usage posted in ordinary
deposits, transfers/account transfers/deposits/withdrawals are collection candidates.

Minna Bank describes smartphone-only operation; no Web banking for ordinary personal balances/statements was
found. This does not mean every technical surface is app-only. The bank provides formal REST/JSON BaaS APIs
to partners; Accounts API covers balances/deposit-withdrawal statements. Public Money Forward ME Web linking
also uses browser ID/password entry and a four-digit Web code entered in the official app for authorization.
The accurate distinction: **direct personal UI is app-only; partner read routes use API + Web/app authorization**.

Initial assessment below uses common levels from `docs/source-research.md`.

| Route                                            | Level                   | Cost (1-5) | Current assessment                                                                                                                         |
| ------------------------------------------------ | ----------------------- | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Manually save official app deposit statement PDF | **E**                   |    **1-2** | Safe default. Save monthly/yearly; ingest with local parser                                                                                |
| Official BaaS Accounts API                       | **A (institutionally)** |    **4-5** | Suitable headless, but requires partner review/contracts/mTLS client certificates; no personal collector self-enrollment                   |
| Official Android app UI automation               | **D**                   |      **5** | One registered device, device-specific information, biometrics/passwords, SMS device authentication; likely needs resident physical device |
| Read-only replay of app-bootstrapped sessions    | **C (candidate)**       |      **4** | Technically plausible from API-first/Apigee architecture, but endpoints/tokens/device-IP binding/pinning unverified                        |
| Stable private read API client                   | **B**                   |          — | No current evidence or public clients found                                                                                                |

**Current source rating: E / cost 1-2**. Switch to A only with a formal BaaS contract. Reassess C if APK/device
read-only verification establishes reusable sessions/display APIs. Public information alone establishes neither B nor C.

## Research scope and safety boundaries

- Only Minna Bank's official personal app, public personal information, official public BaaS information.
- Corporate internet banking is a separate product; do not mix it into personal-account feasibility judgments.
- Aggregators such as Money Forward are only public operational examples of official API transport/consent flows,
  not initial Kogane collection routes.
- No login, account linking, PDF issuance, app installation, or APK acquisition performed.
- No account numbers, user IDs, balances, statement bodies, names, phone numbers, email addresses, secrets,
  tokens, cookies, device identifiers obtained/recorded.
- No transfers/account transfers/Box movements/debit/loans/Cover/points exchanges/settings changes/API consent
  grants/revocations performed.

## Official entry points and app-only boundary

| Entry                                                                                                                                                                                                       | Established use                                       | Assessment                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| [Official service site](https://www.minna-no-ginko.com/)                                                                                                                                                    | Product descriptions, user guides, official app links | Public information, not personal balance/statement login                |
| [Official Google Play (`com.MinnaNoGinko.bankapp`)](https://play.google.com/store/apps/details?id=com.MinnaNoGinko.bankapp&hl=ja)                                                                           | Legitimate Android distribution                       | Main personal channel; observed update 2026-07-22, 1 million+ downloads |
| [Official App Store (`id1521392854`)](https://apps.apple.com/jp/app/id1521392854)                                                                                                                           | Legitimate iPhone distribution                        | Main personal channel; iPhone-only listing                              |
| [Supported devices/models](https://cs-faq.minna-no-ginko.com/faq/show/613)                                                                                                                                  | iOS 15+ / Android 8+                                  | Smartphones; tablets may not work normally                              |
| [Smartphone-only FAQ](https://cs-faq.minna-no-ginko.com/faq/show/148)                                                                                                                                       | Tablet treatment                                      | Explicitly describes app as smartphone-only                             |
| [Multiple-device FAQ](https://cs-faq.minna-no-ginko.com/faq/show/147)                                                                                                                                       | Registrable device count                              | Only one usable smartphone                                              |
| [BaaS API list](https://baas.minna-no-ginko.com/service/api/list/)                                                                                                                                          | Partner REST/HTTPS/JSON APIs                          | Not personal self-service APIs                                          |
| [Money Forward ME linking procedure](https://support.me.moneyforward.com/hc/ja/articles/12172814934425-%E3%81%BF%E3%82%93%E3%81%AA%E3%81%AE%E9%8A%80%E8%A1%8C%E3%81%AE%E9%80%A3%E6%90%BA%E6%96%B9%E6%B3%95) | Operational read API authorization example            | App-to-app, or PC Web + four-digit code + official app approval         |

Official home says `スマホひとつでお金のすべてが完結` ("everything about money completed with one smartphone");
official FAQs specify smartphone-only/one device. This establishes app-only for **direct personal channels**.

Money Forward public procedures have two routes:

1. Start linking in Money Forward ME app; transition to Minna Bank app for login/consent.
2. Start from Money Forward PC Web, enter ID/password on Minna Bank's site, then enter its four-digit code
   in the official app to complete.

The latter authorizes third-party API linking, not Web banking for direct balance/statement viewing.
Do not conclude no Web exists at all or data cannot be read outside the app.

## Collection targets

### Deposit balances

Official FAQs explicitly specify:

- Wallet screen: ordinary deposit balance.
- Banking screen: ordinary deposits plus Saving / Box savings deposit balances.
- Boxes are virtual accounts linked to savings accounts, maximum 20.

Evidence:

- [Checking current deposit balances](https://cs-faq.minna-no-ginko.com/faq/show/707)
- [What Box accounts are](https://cs-faq.minna-no-ginko.com/faq/show/312)
- [Official Box service](https://www.minna-no-ginko.com/service/box/)

Observe Wallet / Saving / each Box as separate `source_account` candidates. Box names are free user input
and may be PII. Retrieve no names/balances in this research. Even live, do not log individual names; retain
only `box_count` and structural yes/no.

### Deposit/withdrawal statements and granularity

Granularity established by official FAQs:

| Item                            | Public specification                                         |
| ------------------------------- | ------------------------------------------------------------ |
| Transactions                    | Transfers, account transfers, deposits, withdrawals, etc.    |
| Statement fields                | Transaction datetime, amount                                 |
| Selectable period per operation | Within one year                                              |
| Rows per display                | Maximum 1,000                                                |
| Multiple years                  | Split into within-one-year display/output periods            |
| Deposit statement export        | PDF from personal app                                        |
| CSV / OFX / QIF                 | Not established in public personal information               |
| Single transfer evidence        | PDF issuable from the relevant transfer withdrawal statement |

Evidence:

- [Statement contents, one year, 1,000-entry limit](https://cs-faq.minna-no-ginko.com/faq/show/708)
- [Deposit statement PDF, up to one year per operation](https://cs-faq.minna-no-ginko.com/faq/show/669)
- [Transfer statement PDF](https://cs-faq.minna-no-ginko.com/faq/show/670)

A separate transfer-only FAQ states no display-period limit, but maximum 1,000 entries per operation.
Read this as distinguishing past viewability from per-retrieval limits, not all history in one operation.
Unlimited earliest dates for all transaction types and page/cursor behavior beyond 1,000 in a period are unverified.

- [Past transfers: no overall period limit, 1,000 per operation](https://cs-faq.minna-no-ginko.com/faq/show/299)

Public FAQs alone do not establish PDF columns, post-transaction balances, descriptions, counterparties,
provider transaction IDs, page counts, text layers, encryption, or Wallet / Saving / Box separation in PDFs.
These require live verification.

### Debit

Minna Bank debit is virtual debit issued at account opening; spending immediately debits ordinary deposits
and appears in their statements. Official FAQ describes filtering ordinary statements by `デビット` ("debit").
MyJCB is for campaign registration; use the official app for usage statements etc.

- [Debit overview/immediate reflection](https://cs-faq.minna-no-ginko.com/faq/show/457)
- [Checking debit statements](https://cs-faq.minna-no-ginko.com/faq/show/441)
- [Official app, not MyJCB, for statements](https://cs-faq.minna-no-ginko.com/faq/show/381)

Initial PDF importers likely can ingest ordinary-deposit debit postings. Verify actual PDF merchant names,
authorization/confirmation, foreign currencies/rates, extra debits, cancellation/refund fields. No debit-specific CSV/PDF established.

### Cashback, points, and Record

Debit rewards are **cash cashback**, not points balances: ordinary members 0.2%, Premium members 1%, credited
to ordinary deposits. Kogane does not separately count reward points; treat as provider-reported ordinary
deposit inflow observations, interpreting as debit cashback only when descriptions are verified.

- [Official cashback FAQ](https://cs-faq.minna-no-ginko.com/faq/show/372)

Official Record is a PFM aggregating Minna Bank deposits, other banks' deposits, loans, cards, securities,
pensions, cryptoassets, e-money, etc. The official 2024 comparison excludes points from Record linking while
including them in comparison household accounting apps. Partner services such as DMM may award external
points; do not treat them as a general Minna Bank-specific points balance.

- [Record user guide](https://www.minna-no-ginko.com/guide/record/)
- [Record scope](https://cs-faq.minna-no-ginko.com/faq/show/246)
- [Official Record comparison](https://www.minna-no-ginko.com/service/record/column/asset-app/)

Record is an aggregator developed with Money Forward; do not use as initial source. Including third-party
assets from Record mixes Minna Bank's direct claims with aggregator values, violating Kogane source boundaries.

### Formal Accounts API scope

Official public Accounts API material describes reading balances, deposit/withdrawal statements, account
holders/numbers/types, financial institution/branch codes/names. FAQs explicitly state linkage includes
authenticated ordinary deposits and linked savings deposit balances/statements etc.

- [API developer portal release/API list](https://corporate.minna-no-ginko.com/information/corporate/2024/06/20/544/)
- [API-linked information scope](https://cs-faq.minna-no-ginko.com/faq/show/77)
- [API service terms](https://corporate.minna-no-ginko.com/collaboration/term-of-api/)

This resembles Kogane's balance/statement requirements. But developer portal applications/bank reviews and
partner mTLS certificates are required. No public self-service route for personal account token issuance established.

## Authentication, device binding, biometrics, passkeys, and Bitwarden

### Established facts

- Personal app login uses registered login ID, password (or biometrics), and registered smartphone-specific
  information.
- Only one usable smartphone.
- Logout disables biometric login settings; next login needs ID/password.
- New-device migration requires ID/password plus registered-phone SMS code device authentication.
- Official FAQs recommend Android screen locks/iPhone device passcodes for safe use.

Evidence:

- [Personal app login authentication](https://cs-faq.minna-no-ginko.com/faq/show/638)
- [Biometric settings/logout disablement](https://cs-faq.minna-no-ginko.com/faq/show/157)
- [Phone migration/SMS device authentication](https://cs-faq.minna-no-ginko.com/faq/show/701)
- [No multiple devices](https://cs-faq.minna-no-ginko.com/faq/show/147)
- [15 safe-use rules](https://corporate.minna-no-ginko.com/for-safebanking/safety-measures/)

### Passkeys

Public personal app FAQs/store listings did not establish passkeys/WebAuthn/FIDO credentials. Official
corporate internet banking uses passkeys, but is a separate product; do not extrapolate to the personal app.

- [Corporate internet banking passkey terms](https://corporate.minna-no-ginko.com/term-of-use/business/)

Unconditionally stating Minna Bank supports passkeys is therefore wrong. Publicly described personal app
biometric login substitutes device biometrics for ID/password login; equivalence to synced passkeys is unverified.

### Bitwarden

**Fact:** Minna Bank uses ID/password. No official material found establishing Bitwarden, Android Autofill,
iOS Password AutoFill, third-party passkey manager support.

**Hypothesis:** If standard app login fields allow Autofill, Bitwarden may store/enter ID/password. Secure
text fields, app Autofill settings, screen capture restrictions, or replacement of device authentication are
unverified. Do not expect Bitwarden to replace SMS, device-specific information, or biometrics.

Kogane does not assume automated Bitwarden credential input. If needed, limit it to human bootstrap on
the registered device; give no vault master password, bank password, or SMS code to collectors/Cloudflare.

## Transport, API gateways, Akamai / anti-bot

### Established facts

- Formal BaaS APIs use REST, HTTPS, JSON.
- Authorization: FAPI 1.0 Advanced, profile `FAPI Adv. OP w/MTLS, JARM`.
- Token issuance/use requires mTLS client certificates, binding access tokens to certificates.
- Uses PKCE, signed authorization requests/responses, OAuth 2.0 / OpenID Connect.
- A public session including bank staff describes Authlete authorization and Google Cloud Apigee API gateways.
- A 2021 bank-wide system diagram lists Akamai, Apigee, Firebase, Authlete as frontend authentication/security components.
- Anonymous DNS checks on 2026-08-26: `www.minna-no-ginko.com`, `corporate.minna-no-ginko.com`,
  `baas.minna-no-ginko.com` each CNAME to `*.edgekey.net` → `*.akamaiedge.net`.

Evidence:

- [BaaS API connection requirements](https://baas.minna-no-ginko.com/service/api/list/)
- [FAPI authorization policy](https://corporate.minna-no-ginko.com/collaboration/policy-of-api/)
- [Authlete customer story](https://www.authlete.com/ja/customer-stories-jp/minnabank)
- [API platform session including Minna Bank staff](https://www.authlete.com/ja/resources/videos-jp/20231212-03)
- [2021 bank system overview](https://jba-web.jp/cms/wp-content/uploads/2021/07/%E6%96%B0%E3%81%97%E3%81%84%E9%8A%80%E8%A1%8C%E6%B0%B8%E5%90%89%E6%A7%98_20210713_JBA%E5%AE%9A%E4%BE%8B%E4%BC%9A.pdf)

### Unverified / do not assert

- Specific Akamai products (App & API Protector, Bot Manager, Account Protector, etc.).
- Shared Akamai properties/policies between public sites/mobile APIs.
- Per-login/token/balance/statement endpoint WAF/bot scores/rate limits.
- Mobile API hosts, certificate pinning, Play Integrity, root/emulator detection, attestation.
- Access/refresh tokens, device keys, cookie formats/lifetimes/reuse conditions.

Akamai edge use is established; anonymous public GET success/failure alone does not characterize mobile
login anti-bot. Do not guess endpoints, probe with credentials, or explore rate limits.

## Public third-party implementations

### Operational example: Money Forward ME

Money Forward announced it was the first PFM officially API-linked with Minna Bank, retrieving balances/
deposit-withdrawal statements without entrusting bank IDs/passwords to Money Forward.

- Transport: REST / HTTPS / JSON.
- Authorization: FAPI 1.0 Advanced, OAuth 2.0 / OIDC, PKCE, JARM.
- Client authentication: mTLS; access tokens bound to client certificates.
- User consent: mobile app-to-app, or start on PC Web and enter a four-digit code in the official app.
- Resources: Accounts API balances/deposit-withdrawal statements.
- Implementers: contracted/reviewed electronic payment service providers/partners, not generally distributed SDKs/personal clients.

Evidence:

- [Formal Minna Bank/Money Forward API linking](https://corp.moneyforward.com/news/release/service/20221108-mf-press/)
- [Money Forward ME linking operations](https://support.me.moneyforward.com/hc/ja/articles/12172814934425-%E3%81%BF%E3%82%93%E3%81%AA%E3%81%AE%E9%8A%80%E8%A1%8C%E3%81%AE%E9%80%A3%E6%90%BA%E6%96%B9%E6%B3%95)
- [Minna Bank API provision model](https://baas.minna-no-ginko.com/service/api/)

### Public code search results

GitHub code/repository searches on 2026-08-26 for `com.MinnaNoGinko.bankapp`, `minna-no-ginko.com`,
and `みんなの銀行 API` ("Minna Bank API") found no working unofficial balance/statement clients/scrapers.

These discovered public JSONs are not implementations.

- [`not-a-bank/open-banking-tracker-data`](https://github.com/not-a-bank/open-banking-tracker-data/blob/2fa27580debf22652720e486af9315ca0c932db1/data/account-providers/minna-no-ginko.json): provider catalog; empty API endpoints/specifications, not reflecting the current official developer portal.
- [`emadomedher/skyline-api-library`](https://github.com/emadomedher/skyline-api-library/blob/deb3c87b6d83435d6e916551b161a540409d318c/profiles/minna-no-ginko/profile.json): metadata placeholder `authType: api-key`, contradicting official FAPI/mTLS; no client code.
- [`2factorauth/twofactorauth`](https://github.com/2factorauth/twofactorauth/blob/6ab81bf8d423957d1495ce4ac5dbc2d933773532/entries/m/minna-no-ginko.com.json): domain directory entry, not authentication transport implementation.

No public code does not prove no internal APIs. Official API-first architecture establishes mobile API
existence, but concrete endpoints/auth/sessions remain unverified until APK/live traffic inspection.

## Future Android APK acquisition and static analysis

Official Android package: `com.MinnaNoGinko.bankapp`. No bank-distributed standalone APK found; legitimate
route is Google Play. Future static analysis order:

1. Install official app from Google Play on a user-owned non-root device.
2. Obtain identical legitimate delivery as split APKs from user-owned devices/Play delivery. Do not trust third-party mirrors.
3. Save package name, versionName/versionCode, split SHA-256s, signing certificate digests; compare with Play listing.
   APK itself is not confidential, but keep extraction locations access-controlled.
4. Check manifest, SDKs, permissions, components, signatures with `apkanalyzer` / `aapt2` / `apksigner`.
5. Use **static analysis only** with `jadx` / `apktool` / MobSF to inspect network security config, API hosts/paths,
   deep links, OAuth redirect URIs, data models, User-Agent, pinning/attestation libraries.
6. If Flutter etc. yields little Java/Kotlin decompilation information, examine assets, native libraries, Dart snapshot
   strings. Do not make successful deobfuscation/authentication bypass acceptance criteria.
7. Check endpoint candidates only through anonymous DNS/TLS and official public metadata; send no credentialed requests.

Static analysis aims to **narrow hosts, schemas, device binding to observe in read-only live verification**,
not break protections to log in. Record/stop on certificate pinning/Play Integrity/root detection;
no Frida hooks, patches, signature replacement, attestation bypass.

## Runtime suitability

| Platform                           | Suitability                           | Assessment                                                                                                                                  |
| ---------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Registered physical Android device | **Best (bootstrap / manual capture)** | Official one-smartphone, SMS, screen lock, biometric requirements; initial PDF export/structure checks                                      |
| Local Android emulator             | Low to conditional                    | Phone/SMS, device binding, Play Integrity/Services, root/emulator checks unverified; not assumed a physical device substitute               |
| Cloudflare Workers                 | Technical candidate for formal APIs   | Outbound mTLS certificate bindings may fit contracted REST/JSON BaaS clients; cannot bootstrap personal app login                           |
| Cloudflare Containers              | Replay PoC candidate                  | Linux/amd64 browsers/tooling, but no Android phone/SIM/SMS/biometrics/registered devices. Consider only after proven session replay         |
| OCI VM / Kubernetes                | Replay / Android lab candidate        | Control persistent volumes, egress, browsers, ADB, self-hosted emulators; no device auth/attestation guarantee. Start with physical Android |
| Hosted Android device farm         | Low                                   | Ephemeral devices, phone numbers, device reputation, bringing secrets are problems; do not make a permanent issuer for bank login           |

Workers outbound mTLS presents client certificates through certificate binding `fetch()`. Good protocol fit
for formal APIs, assuming a bank partnership issuing credentials/certificates. Cloudflare documents a 520
limitation when destinations are Cloudflare-proxied zones; check actual bank hosts once endpoints are disclosed.

- [Cloudflare Workers mTLS binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/)
- [Cloudflare Containers Linux/amd64 runtime](https://developers.cloudflare.com/containers/platform-details/architecture/)

Recommended order: registered Android manual PDF → APK static analysis → device metadata-only network
observation → session replay feasibility → OCI/k8s or Container PoC. Workers is first choice for contracted
BaaS, not private mobile session bootstrap.

## Recommended implementation

### Phase 1: manual PDF + local importer (E / cost 1-2)

1. User divides history into non-overlapping windows of one year or less in official app on registered device.
2. User saves deposit statement PDFs into encrypted local intake folders.
3. Importer retains only raw byte SHA-256, issued period, acquisition time as metadata.
4. Parser prefers text layers, using local OCR only for image PDFs.
5. Observe only actual PDF columns: Wallet / Saving / Box, transaction datetime, amounts, descriptions,
   post-transaction balances, etc. Do not infer missing columns.
6. Shorten/reissue windows hitting 1,000 entries. No automated operation.

No personal values recorded in this research means no transcription into research documents. Future production
Kogane intake uses only explicitly user-selected encrypted raw evidence stores; no actual data in logs, PRs,
test fixtures, telemetry.

### Phase 2: app metadata / read API feasibility (D → C assessment)

1. Legitimately obtain APKs, verify signatures/hashes, analyze statically.
2. User manually logs in on registered device. Collectors handle no IDs/passwords/SMS/biometrics.
3. If ordinary OS VPN capture/Android Studio tooling works, record only host, method, status,
   MIME, time. Save no headers/bodies/queries/tokens.
4. Separate balance/statement reads from transfer/Box move/settings writes by host/path/method.
   Exclude write endpoints from allowlists.
5. Stop if certificate pinning rejects capture. No bypass.
6. Test once whether read-only session envelope export/replay is possible through official features or
   ordinary OS/browser storage only. End on 401/403/login redirect; do not retry credential login.

### Phase 3: formal API (A only if contracting is possible)

Implement Accounts API only after legitimate bank developer portal review/contracts. Limit scopes to
balances/deposit-withdrawal statements; do not register Payments/update APIs. Store mTLS private keys as scoped
secrets; log no tokens/raw financial payloads.

## Read-only live verification

Perform with user present, registered device, low frequency; no personal values in research records.

1. Check Google Play package, version, signing certificate.
2. While logged out, recheck absence of personal browser login/statement viewers.
3. User manually logs in on device; record password/biometric/SMS occurrence as yes/no only.
4. Check only Wallet / Saving / Box screen hierarchy and existence of balances/statements. Record no names/amounts/counts.
5. Check only structure of statement filter start/end dates, one-year constraints, displays beyond 1,000 entries.
6. Confirm debit filtering is part of ordinary statements; check pending/posted/refund/FX state label existence.
7. Check PDF export options, accounts, periods, formats, text layers, page headers, column names.
   Do not paste actual PDF contents into PRs, chat, screenshots, HARs.
8. Check existing history for both sides of Saving / Box transfers in PDFs. Do not create transfers.
9. Check whether unmodified host/method/status/MIME-only metadata capture works.
10. Check session persistence once each after app/device restart. Do not log out.

Success is not merely logging in; all must hold:

- No writes, transfers, account transfers, Box movements, consent/settings changes.
- No personal values/secrets in research artifacts/logs.
- Can structurally explain PDF periods/counts/columns and API/UI scope.
- Can safely separate read/write endpoints or determine separation is impossible.
- No automated login retries even if retrieval must repeat.

## Stop conditions

Stop immediately on any of:

- SMS, biometrics, ATM PIN, identity verification, phone/video confirmation requests without immediate manual user handling.
- 401, 403, 429, Akamai challenge / Access Denied, maintenance, account lock warnings.
- New-device registration, old-device unlinking, logout, password reset, phone changes requested.
- Confirmations for transfers/account transfers/Box movements/debit/loans/Cover/A2A payments/consent grants-revocations/settings saves.
- Request/response bodies, Authorization/Cookie, tokens, account numbers, balances, statements, PII enter captures/logs.
- Certificate pinning/attestation/root-emulator detection rejects ordinary observation.
- Second automated attempt using the same credential/authentication request becomes necessary.
- Need to send requests with undetermined endpoints, HTTP methods, read-only semantics.

After stopping, do not automatically try workarounds, fingerprint spoofing, pinning bypass, root, hooks,
APK patches, token replay.

## Unverified items

- All personal deposit statement PDF columns, text layers, encryption, layouts, maximum pages/rows.
- Whether PDFs include only ordinary deposits or Saving / Box together/separately.
- Earliest app dates, pagination/cursors beyond 1,000, effective retention for all transaction types.
- Debit pending/posted/cancellation/refund/foreign currency/exchange/merchant descriptor granularity.
- Cashback deposit descriptions and provider ID links to debit transactions.
- Mobile API hosts/paths/schemas, access/refresh tokens, session lifetimes, device/IP/UA binding.
- Certificate pinning, Play Integrity, root/emulator detection, hardware-backed keys.
- Personal app Android/iOS Autofill permission and Bitwarden ID/password input.
- Personal app passkey/WebAuthn support; corporate passkeys are no evidence of personal support.
- Specific Akamai WAF/bot products and mobile API/login endpoint policies.
- Whether personal Kogane use passes API developer portal review, costs, certificate
  lifecycles, rate limits, consent/token validity.
- Whether Workers outbound mTLS can connect to actual bank API hostnames.
- Whether read-only sessions can move to/reuse on OCI/k8s/Cloudflare Containers.

Do not fill gaps by guessing; update after APK static analysis and user-attended read-only live verification.

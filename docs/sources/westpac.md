# Westpac Australia source research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

- Research date: 2026-08-26 (Australia/Sydney)
- Scope: **Westpac Australia (`Westpac` brand) only**
- Method: read-only official public Web/login/hash-identified JavaScript formatting-static analysis, unauthenticated Chrome runtime metadata, official app/Play/Digital Asset Links, public Westpac CDR Product API, Australian government CDR sites, Consumer Data Standards, public DNS/HTTP. No account login, consent, OTP sending, transactions, settings changes, personal report retrieval.

## Scope and safety boundaries

Westpac Australia only. Do not treat other Group brands/apps/Online Banking/CDR endpoints as Westpac
implementations. Validate `brand == "Westpac"` even in public Product API results; exclude other brands.

Retrieve/record no account numbers/Customer IDs/names/addresses/balances/transactions/account-transaction IDs/
cookies/access-refresh tokens/passwords/OTPs/private keys/certificates. Exclude payments/transfers/PayID/card
controls/time-deposit renewal-cancellation/loan-card-account changes/CDR consent creation-change-revocation.
Public JS/APK static analysis and owner-operated read-only method/host/path/status/content-type/schema-key
metadata observations in scope; no security-control bypass.

## Conclusion

1. **Current safe default: manual export (E / Cost 1)**. Online Banking exports up to three years of history as CSV/QBO/QIF/OFX;
   eligible statements up to seven years PDF. Automated collectors safely ingest only user-local files.
2. **Official customer machine-to-machine route: CDR (A / Cost 5)**, not personal-script Customer ID/password APIs.
   Requires ADR accreditation/Register onboarding/conformance/PKI-mTLS/OAuth-OIDC consent, institutional requirements the largest barrier.
3. **Public Product API: A / Cost 1**, fits Workers but only product reference information, no accounts/balances/transactions.
4. **Do not postpone private transport research because CDR/exports exist**. Current public login JS/unauthenticated runtime
   established EAM bootstrap/anonymous sessions/authentication POST/anti-forgery-device telemetry/pending-posted UI models.
   Authenticated reads/JSON unknown, not B; separately proceed to owner-operated read-only observations.

## 1. Product/account enumeration and balance/transaction states

### Public Product API categories

Westpac publishes unauthenticated REST Product APIs, listing transaction/savings/time deposits/cards/mortgages/
personal loans. Read-only `GET` on 2026-08-26 accepted `x-v: 5`, returned 64 Westpac products/three pages.
Snapshot categories below; counts may change.

| CDR `productCategory`        | Count | Treatment                                           |
| ---------------------------- | ----: | --------------------------------------------------- |
| `TRANS_AND_SAVINGS_ACCOUNTS` |    17 | Transaction / savings                               |
| `TERM_DEPOSITS`              |     4 | Term deposits                                       |
| `CRED_AND_CHRG_CARDS`        |    13 | Credit / charge cards                               |
| `RESIDENTIAL_MORTGAGES`      |    11 | Home loans / mortgages                              |
| `PERS_LOANS`                 |     3 | Personal loans                                      |
| `BUSINESS_LOANS`             |     6 | Westpac products, not personal collector priorities |
| `MARGIN_LOANS`               |     3 | Same                                                |
| `OVERDRAFTS`                 |     2 | Same                                                |
| `LEASES`                     |     2 | Same                                                |
| `REGULATED_TRUST_ACCOUNTS`   |     3 | Same                                                |

Public Product API `GET https://digital-api.westpac.com.au/cds-au/v1/banking/products`. Official description:
HTTP GET/REST/CDR, no security headers. Observed standard `page`/`page-size` and `x-v` required.
[Westpac Product API](https://www.westpac.com.au/about-westpac/innovation/open-banking/product-api/) /
[CDR standards](https://consumerdatastandardsaustralia.github.io/standards/)

### Authenticated scope

- Terms allow Accounts on one screen, balances/available transaction details. [Online Banking Terms and Conditions](https://www.westpac.com.au/personal-banking/online-banking/support-faqs/terms-conditions/)
- Official access table lists personal transaction/savings/time deposits/home loans/credit cards; insurance/trading/car finance may not appear. [Manage account access](https://www.westpac.com.au/personal-banking/online-banking/making-the-most/manage-access/)
- Product/CDR schemas include personal loans, but no verification of loan enumeration on a specific user's authenticated home page here.
- CDR `Get Accounts` returns `accountId`, `displayName`, `nickname`, `maskedNumber`, `productCategory`, `productName`, etc., distinguishing `TRANS_AND_SAVINGS_ACCOUNTS`, `TERM_DEPOSITS`, `CRED_AND_CHRG_CARDS`, `RESIDENTIAL_MORTGAGES`, `PERS_LOANS`, etc. Consent-covered customer data, not called here. [CDR Banking APIs](https://consumerdatastandardsaustralia.github.io/standards/)

### Balances and pending / posted

- Web/app searches include historical balances. [Transaction history](https://www.westpac.com.au/personal-banking/online-banking/making-the-most/transaction-history/)
- Card payments remain `pending` awaiting merchant confirmation, normally processed within five business days, sometimes longer; held against available funds. [What is a pending transaction?](https://www.westpac.com.au/faq/pt-what-is-pending-transaction/) / [How is my balance affected?](https://www.westpac.com.au/faq/pt-balance-affected/)
- FAQ says credit-card pending affects account balances on processing; debit-card pending affects balances beforehand. Separate `current/ledger` from `available`.
- CDR balance fields `currentBalance`, `availableBalance`, `creditLimit`, `amortisedLimit` vary by product; transactions contain `status` (`PENDING`/posted data), amounts/currencies/descriptions-references/execution-posting-value datetimes/merchants-MCC. Reconcile pending with later posted rather than finalizing. [CDR standards](https://consumerdatastandardsaustralia.github.io/standards/)

## 2. Statement granularity, periods, counts, exports

| Surface                                | Period/count                                                                     | Format/granularity                                                                          | Status                                                |
| -------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Online Banking / Westpac App search    | Up to three years                                                                | Date/description/amount/debit-credit/historical balance searches                            | Officially established                                |
| Current card transactions              | Past 100 days                                                                    | Card balances/transactions                                                                  | Official; separate from all-account three-year search |
| Desktop export                         | Within three years; no public rows/export limit                                  | CSV/QBO/QIF/OFX; QBO-OFX single account only                                                | Official                                              |
| App recent downloads                   | Select account/period                                                            | Download available, exact app formats publicly unverified                                   | Official                                              |
| eStatements                            | Eligible accounts up to seven years                                              | PDF view-print-download; selected savings-transaction/mortgage/card etc., some excluded     | Official                                              |
| Proof of Balance / Transactions Report | 30/90/120 days, since last statement, custom up to 12 months                     | PDF with names/addresses/account numbers/current balances etc.                              | Official, no research fixtures                        |
| CDR transactions                       | Default 90 days without `oldest-time`; explicit periods depend on consent/holder | JSON, default page 1/page-size 25, date/amount/text filters/pending-posted/merchant details | Standard established; no Westpac customer call        |

Desktop `Overview > Exports and reports > Transactions`, select accounts/dates/formats; official FAQ says
same personal/business procedure. [Export detailed transaction history](https://www.westpac.com.au/faq/business-how-export-detailed-transaction-history/) /
[Export file types](https://www.westpac.com.au/business-banking/online-banking/support-faqs/export-files/)

CSV columns/encoding/timezone/pending inclusion/stable IDs/row limits/closed-account exports publicly unknown.
Even live, retain no downloaded contents in Git/logs/test fixtures.

Statements: [Account statements and information](https://www.westpac.com.au/personal-banking/services/banking-services/account-statements-and-info/) /
[eStatements](https://www.westpac.com.au/personal-banking/online-banking/making-the-most/estatements/) /
[Proof of balance](https://www.westpac.com.au/personal-banking/online-banking/making-the-most/proof-of-balance/)

OFX/QIF are user-directed exports, not evidence of a permanent personal OFX Direct Connect endpoint.
QBO is file format, not QuickBooks credential delegation.

## 3. Authentication, MFA, devices, passkeys, and Bitwarden

### Established facts

- Public login `Customer ID`/`Password`, `Remember customer ID`; warns against remembering on shared devices. [Login](https://banking.westpac.com.au/)
- Protect Security Code is one-time code on registered SMS/app notifications/SecurID devices, potentially sign-in/new payees/international payments/limits-contact-password changes etc. [Security Devices](https://www.westpac.com.au/security/protect-yourself-and-your-business/security-devices/)
- `Security Code via the App` requires personal profiles/compatible app/push notifications/valid SMS Code status; app-only activation.
- Initial app Customer ID/password then four-digit passcode/Face ID/fingerprint/password-only. Biometrics/passcodes stored on-device, not Westpac. [Secure ways to sign into the Westpac App](https://www.westpac.com.au/personal-banking/online-banking/making-the-most/quick-signin/)
- CDR redirects ADR → Westpac, authorizes Customer Number/Protect SMS OTP, no Online Banking password/SecurID OTP. One-time or up to 12 months, dashboard revocation. [Westpac Open Banking](https://www.westpac.com.au/about-westpac/innovation/open-banking/)
- Public security tips generally recommend password vaults/managers. [Consumer FAQ](https://www.westpac.com.au/content/dam/public/wbc/documents/pdf/help/disaster/covid-19_consumer_faq.pdf)

### Separate hypotheses/unverified

- `Remember customer ID` stores identifiers, not established trusted-device/MFA bypass.
- App notifications/biometrics involve device state; private cryptographic binding/attestation/pinning/refresh binding unknown.
- No official public WebAuthn/passkeys established; **unverified, not unsupported**.
- No Bitwarden-specific compatibility table. Ordinary autofill technically plausible/untested, not replacement for OTPs/app notifications/enrollment/CDR keys. Owner-only managers; no master passwords/item contents to collectors.

## 4. CDN / WAF / Akamai / anti-bot

Read-only unauthenticated DNS/headers/login HTML-JS/runtime request metadata on 2026-08-26; no submits,
credentials, OTP sending.

| Host                         | Observation                                                                                 | Limits                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `www.westpac.com.au`         | CloudFront DNS/`server: CloudFront`                                                         | Public CDN established, WAF unknown                            |
| `banking.westpac.com.au`     | `*.akamaiedge.net`, `x-aka-grn`, login redirect                                             | Akamai edge established, WAF/Bot Manager configuration unknown |
| `digital-api.westpac.com.au` | CloudFront/API Gateway headers; root 403 `MissingAuthenticationToken`, product GET succeeds | API entry established, WAF unknown                             |

Login lands `https://banking.westpac.com.au/wbc/banking/handler?TAM_OP=login`, IBM Security Verify Access/
WebSEAL-style `TAM_OP`, `PD-S-SESSION-ID` (`Secure; HttpOnly`), load-balancer cookies. Loads AppDynamics,
BioCatch facade (`wup-2ffe60ee.westpac.com.au/client/v3.1/web/wup`, `log-2ffe60ee.westpac.com.au/api/v1/sendLogs`),
browser/device fingerprints. BioCatch exposes `setCustomerSessionId`, `changeContext`, `flush`, native bridges;
credential POST alone cannot recreate session/device context.

Akamai CDN alone does not establish WAF/Bot Manager. No unauthenticated CAPTCHA, but explicit BioCatch/
fingerprints, no proof adaptive challenges/rate limits absent. Stop without bypass at challenges/403-429/
CAPTCHA/abnormal redirects/lock warnings.

## 5. Roles of official app / Web

- Official Android `org.westpac.bank`, iOS `299111811` linked from official Web. [Westpac App](https://www.westpac.com.au/personal-banking/online-banking/mobile-app/) / [Google Play](https://play.google.com/store/apps/details?id=org.westpac.bank) / [Apple App Store](https://apps.apple.com/au/app/westpac/id299111811)
- Public Play showed developer `Westpac Banking Corporation`, updated 2026-08-19; current `versionName`/`versionCode` not retrievable unauthenticated. Review versions do not establish latest distribution.
- `banking.westpac.com.au/.well-known/assetlinks.json` delegates `handle_all_urls`/`get_login_creds` to `org.westpac.bank`, signer SHA-256 `C7:BB:40:3D:21:49:4E:70:2D:27:C1:18:4D:91:74:1E:2E:5B:50:A5:2E:7A:9A:B3:34:B4:1A:A3:D2:D7:65:D6`. Primary domain/signer evidence, not local APK identity verification. [Digital Asset Links](https://banking.westpac.com.au/.well-known/assetlinks.json)
- Web/app share balances/history-search/statements/proof reports/card-time deposit management; allowlist reads only amid many writes.
- Desktop CSV/QBO/QIF/OFX formats/dates/accounts explicit, clearest manual retrieval.
- App Smart Search/biometric-passcode/Security Code notifications/Digital Cards/local features. Exclude app-only security enrollment/Digital Cards.
- Public `NativeJSInterface.min.js` lists `/app/native/connect`, `/app/native/settings/signIn`, `/app/native/addressbook`, `/app/native/atmLocator`, plus payment/funds transfer routes: native shell/Web bridging evidence. Do not call write routes including the latter two.
- No official Play splits in workspace or connected Android/ADB, so device/account Play split sets unavailable without mirrors. Manifest/split DEX/hosts-schemas/network config/pinning-integrity unknown; acquisition barriers do not make RE a non-goal. Legitimate procedure below is next experiment.

## 6. Concrete third-party client transport / auth

### First-party private Web transport (established publicly)

- `GET /wbc/banking/handler?TAM_OP=login` issues login HTML/anonymous sessions.
- Post-load `GET /eam/servlet/getEamInterfaceData` returns `inputRestrictions`, `reference`, `operations`, `keymap`.
  Names establish bootstrap of expiring `reference.token`/GUID, public keymaps-algorithms, allowed operations/submit URIs; values not saved.
- Login `POST /eam/servlet/AuthenticateHttpServlet`, model `username`, `password`, `token`, `halgm`, `brand`.
  No POST/failed attempts/OTP initiation.
- Hash-identified current JS (`core` SHA-256 `0d78dd24f17888c09cfa8cbb6381cc4a4c1581382037ee969f88aa2265d2c2cf`)
  formatted with Prettier contains `RequestVerificationToken`, `LtpaToken`, browser-device fingerprints,
  `/secure/banking/accounts/getsummarystartpage`; no support for bearer-cookie replay alone.
- Posted detail SSO uses `AccountGlobalId`, `TransactionPostedDate`, `TransactionPostedId`; pending separate
  `lwc_pending_transaction_detail_settings`. Shared load-more models `state`, `pageSize`, current offset,
  `newResults`, `totalRecordsCount`, `moreResultsAvailable`. Do not assert transaction JSON pagination schemas.
- Authenticated account/transaction hosts-paths/methods/JSON/renewal-expiry/pending-posted keys unknown.
  Separate public UI models from authenticated API contracts.

### Public Product API

- HTTPS REST `GET`, JSON/CDR envelopes/`x-v`/pagination.
- Officially no security headers/customer consent/credentials.
- Product references only; no accounts/balances/transactions.
- Public comparator demos/community catalogs enumerate endpoints, not personal authenticated clients.
  [CDS product comparator demo](https://github.com/ConsumerDataStandardsAustralia/product-comparator-demo) /
  [Australian Open Banking Data Database](https://github.com/LukePrior/Australian-Open-Banking-Data-Database)

### CDR consumer data

- Transport mTLS to resource servers; standards use mTLS for transaction security/holder-of-key, not OAuth TLS-client authentication.
- Client authentication: ADR software `private_key_jwt`, signed JWT/JWKS/one-time `jti`, post-Dynamic Client Registration `client_id`.
- Consumer authorization: OAuth/OIDC authorization-code/PAR/PKCE (`S256`)/JARM-FAPI; Westpac Customer Number/SMS OTP.
- Accounts `bank:accounts.basic:read`, balances/details matching scopes, transactions `bank:transactions:read`;
  minimize secret/PII access-refresh tokens/account IDs. [Consumer Data Standards](https://consumerdatastandardsaustralia.github.io/standards/)

GitHub found product catalogs/demos, no maintained safe reproduction of current personal private transport/auth.
Absence does not stop RE, but scripted Customer ID/password POST/cookie replay is not a verified working client.

### File import

Local reading of explicitly user-exported CSV/QBO/QIF/OFX/PDF is a third-party integration. Export FAQs also
mention bank feeds, but providers/protocols/scopes unknown; no initial aggregator route.

## 7. CDR consumer access and accreditation

Westpac describes itself as Data Holder/ADR; third-party collectors separately need CDR participant status.
[Westpac Open Banking](https://www.westpac.com.au/about-westpac/innovation/open-banking/)

Separate from personal first-party sign-in. No exchange of Customer ID/password/Web sessions for CDR bearer
tokens; requires CDR software products/redirect URIs/PKI/consent lifecycles. Westpac's ADR status does not
accredit personal scripts.

Current ACCC guidance requires at least:

- Fit and proper persons/organizations
- Controls against misuse/loss/unauthorized access etc.
- Rules-compliant internal/relevant external dispute resolution
- Adequate insurance for breach consumer losses
- Australian service address
- Post-accreditation Register onboarding/conformance

[Become an accredited data recipient](https://www.cdr.gov.au/for-providers/become-accredited-data-recipient)

Technical/operational needs: consent dashboards-withdrawal/receipts/CDR policies/data minimization/records-
reporting/security/PKI/software registration/CTS/production endpoints-CSR-register activation.
[IT requirements](https://www.cdr.gov.au/for-providers/it-requirements-data-recipients) /
[Legal obligations](https://www.cdr.gov.au/for-providers/legal-obligations-data-recipients) /
[Onboarding](https://www.cdr.gov.au/for-providers/on-boarding-for-data-recipients) /
[Data recipient user journey](https://www.cdr.gov.au/for-providers/data-recipient-user-journey)

Separate costs: government checklist says **currently no accreditation application fee**; hosted sandbox/mock
tooling free. Third-party assurance/security/insurance/AFCA-disputes/legal/production infrastructure/certificate-
key operations/reporting still cost, no government total. Sponsor/representative fees contract-specific,
no public fixed price. [Accreditation checklist](https://www.cdr.gov.au/sites/default/files/2024-12/CDR-accreditation-checklist-published-28-April-2023.pdf) /
[Participant tooling](https://www.cdr.gov.au/for-providers/participant-tooling)

No apparent exemption for own-data-only. Sponsored accreditation requires unrestricted sponsors; affiliates
cannot directly collect from holders. Representatives contract with/remain under unrestricted principals.
All differ from personal sign-in. [Accreditation guidelines](https://www.cdr.gov.au/sites/default/files/2025-08/CDR-accreditation-guidelines-version-6-published-26-August-2025.pdf) /
[Representatives](https://www.cdr.gov.au/sites/default/files/2024-12/CDR-representatives-fact-sheet-published-20-December-2024.pdf)

## 8. Workers / Containers / OCI / Kubernetes suitability

| Runtime                | Public Product API                                     | CDR consumer data                                                                                                                                                                              | Web/app automation                                              |
| ---------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Cloudflare Workers     | **Suitable**, small stateless `fetch` + Cron collector | **Technical candidate, institutional requirements unmet**; outbound mTLS/JWT-WebCrypto possible, but CDR certificates/DCR/callback/rotation/conformance not demonstrated with Westpac/Registry | **Unsuitable** stateful browsers/devices/interactive MFA/Akamai |
| Cloudflare Containers  | Excessive                                              | **Candidate**, Linux/amd64 full runtime for libraries/PKI, accreditation separate                                                                                                              | Browsers do not solve safety/terms/MFA                          |
| Portable OCI container | Suitable but excessive                                 | **High suitability**, portable crypto/certificates/callback/audits-rotation                                                                                                                    | Technically possible, not recommended production                |
| Kubernetes             | Excessive at small scale                               | **Suitable organizational ADR**, CronJob/Deployment/secrets/network/audits-rollouts                                                                                                            | Not recommended device-bound interactive flows                  |

Workers officially supports outbound mTLS/scheduled handlers. [Workers mTLS](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/) /
[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/). Containers run Dockerfiles/
supported registry images on Linux/amd64. [Containers](https://developers.cloudflare.com/containers/get-started/) /
[Image management](https://developers.cloudflare.com/containers/platform-details/image-management/).
OCI is portable images; CronJob standard repeated Jobs. [OCI Image Spec](https://specs.opencontainers.org/image-spec/) /
[Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)

Workers CDR suitability is **inference from capabilities**, not demonstrated Westpac/Registry interoperability.
No certificates/keys in source/plain environments/logs.

## 9. PR #5 common automation level / cost

Use only common PR #5 definitions.

- **A** — direct documented/export API suitable for scheduled headless use
- **B** — stable read-only internal API with renewable or reusable session
- **C** — browser/app bootstrap plus headless replay is plausible
- **D** — full browser/device automation is probably required
- **E** — manual capture remains the safe default
- **Cost 1–5** — 1 small wrapper, 5 device-bound or adversarial automation

| Route                           | Level | Cost | Evidence                                                                                             |
| ------------------------------- | ----- | ---: | ---------------------------------------------------------------------------------------------------- |
| Public Product API              | A     |    1 | Documented anonymous GET, product references only                                                    |
| User CSV/QBO/QIF/OFX/PDF ingest | E     |    1 | Manual capture, small parser                                                                         |
| Accredited CDR                  | A     |    5 | Documented headless, accreditation/PKI/consent/compliance required                                   |
| Authenticated private replay    | C     |    4 | EAM/anonymous sessions/secure start/pending-posted models established; reads/schemas/renewal unknown |
| Full Web automation             | D     |    4 | Interactive login-MFA-Akamai/adjacent writes                                                         |
| Official app/device automation  | D     |    5 | Biometrics/passcodes/push/device state/app enrollment/updates                                        |

No current `B`: public private-transport evidence, no authenticated reads/renewable-reusable proof. Main
recommendation E/Cost 1 manual imports, A/Cost 5 CDR only organizational investment justified. This does not
end first-party RE; CDR does not change private route ratings. [Kogane PR #5](https://github.com/risu729/kogane/pull/5)

## 10. Read-only live verification plan / stop conditions

### Staged plan

1. **Completed public static/runtime**: Product API/login unauthenticated once, temporary URL/hash JS/Prettier,
   route-token-device-pending-page strings/call sites; runtime methods-hosts-paths-status-content-types only, no cookies/tokens/bodies.
2. **Next legitimate Play splits**: ordinary owner Android install `org.westpac.bank`; enumerate `adb shell pm path org.westpac.bank`,
   `adb pull` all splits to isolated temporary storage outside Git. Record only `adb shell dumpsys package org.westpac.bank`
   `versionName`/`versionCode`. APKs have no user data, still outside Git.
3. **Next APK provenance/static**: compare `apksigner verify --print-certs base.apk` with official assetlinks,
   all split hashes; `apkanalyzer manifest print`/`apktool d` manifest-components-permissions-deep links-`networkSecurityConfig`;
   all splits into `jadx --deobf`. Search hosts/paths/schemas/token renewal-storage/device binding/`CertificatePinner`-
   TrustManager/config/Play Integrity-SafetyNet-App Check/root-emulators; absence not proof, examine reflection/native too.
4. **Next owner Web reads**: owner enters credentials/OTP without revealing values; Overview/history only.
   DevTools/CDP extracts methods/hosts/value-free path templates/status-content-types/JSON keys-types/pagination keys/
   renewal event names. Immediately discard headers/cookies/query-body values/account-transaction IDs.
   Compare existing natural pending/posted schemas-status-linkage only, no fixture transactions.
5. **Next owner app reads**: during ordinary balance/history viewing, OS Inspector/local VPN metadata DNS-SNI/
   methods-hosts-paths-status-content-types only. No CA addition/pinning removal/root/integrity hooks.
   TLS-hidden schemas are barriers, stop at static call-site comparison.
6. **Manual export**: user checks formats/periods in normal UI; synthetic parser fixtures. If actual dry run
   needed, outside Git counts/periods/duplicates only, no row/value retention-display.
7. **CDR**: no live connection before ADR/legal basis/Westpac onboarding/certificate lifecycles. Then free sandbox/
   mocks/minimal scopes/short consents/reads first.

### Immediate stop conditions

- Asked to enter/retrieve/display passwords/OTPs-Security Codes/Customer IDs/account-transaction IDs/balances/statements/cookies-tokens/private keys-certificates
- SMS/push sending/security devices/app notification/passkey-biometric/device enrollment starts
- Payment/transfer/PayID/new payee/card lock-PIN-limits-Digital Card/time renewal-withdrawal/loan-account-card-profile-contact settings
- CDR consent creation/extension/scopes-account selection/revocation-withdrawal needed
- CAPTCHA/bot challenges/403-429/rate limits/locks/abnormal redirects/terms-warnings
- Non-established GET/read endpoints/private undocumented endpoints/other-brand data mixed
- PII in reports/exports might enter Git/logs/fixtures/remote storage

No retries/bypass/alternate endpoints after stop; return UI to owner. No write discovery calls.

## Facts, hypotheses, unverified items

### Facts

- Three-year transaction search/export; eligible PDFs seven years.
- CSV/QBO/QIF/OFX desktop, QBO-OFX single account.
- Public Product GET; customer CDR accredited OAuth/OIDC + mTLS + `private_key_jwt`.
- Customer ID/password login, conditional Security Codes.
- App biometrics/passcodes device-local.
- Public CloudFront/login Akamai/digital CloudFront-API Gateway.
- Login EAM config GET/auth POST separation, anonymous sessions/bootstrap tokens-keymaps/anti-forgery/device-BioCatch.
- Current JS posted identifiers/pending-only events/shared state-page-size-offset load-more.
- Official assetlinks package/signer fingerprints.
- No current accreditation fee, sandbox-tooling free; separate assurance/insurance/compliance/infrastructure etc. costs.

### Hypotheses

- Worker CDR primitives possible, no demonstrated production compatibility.
- Bitwarden autofill plausible, official compatibility/policy/behavior unverified.

### Unverified

- Actual authenticated account/product enumeration/loan display/closed-dormant accounts
- CSV columns/encoding/timezones/limits/pending/stable IDs
- Authenticated hosts/paths/schemas/transaction pagination/TTLs-renewal/pending-posted keys
- Current Play split versions/measured signers/manifests/app APIs/device binding-attestation-pinning-integrity
- Passkeys/WebAuthn/Bitwarden
- Login/CDR WAF-Bot Manager/challenges
- App recent download formats/bank feed providers-protocols
- Westpac/chosen ADR-sponsored onboarding/contracts/costs

## Main primary sources

- [Westpac Online Banking](https://www.westpac.com.au/personal-banking/online-banking/)
- [Online Banking Terms and Conditions](https://www.westpac.com.au/personal-banking/online-banking/support-faqs/terms-conditions/)
- [Transaction history](https://www.westpac.com.au/personal-banking/online-banking/making-the-most/transaction-history/)
- [Westpac App](https://www.westpac.com.au/personal-banking/online-banking/mobile-app/)
- [Google Play: Westpac](https://play.google.com/store/apps/details?id=org.westpac.bank)
- [Westpac Digital Asset Links](https://banking.westpac.com.au/.well-known/assetlinks.json)
- [Westpac current public core JavaScript](https://banking.westpac.com.au/wbc/banking/scripts/desktop/core/0001combined.js.2c0b10581aa4d83fdd40ef304ba8c872d9491ae4.js)
- [Westpac BioCatch facade](https://www.ui.westpac.com.au/cdnasset/biocatch/wp-fns-facade.min.js)
- [Westpac NativeJS bridge](https://www.ui.westpac.com.au/cdnasset/nativebridge/NativeJSInterface.min.js)
- [Security Devices](https://www.westpac.com.au/security/protect-yourself-and-your-business/security-devices/)
- [Westpac Open Banking](https://www.westpac.com.au/about-westpac/innovation/open-banking/)
- [Westpac Product API](https://www.westpac.com.au/about-westpac/innovation/open-banking/product-api/)
- [Consumer Data Standards](https://consumerdatastandardsaustralia.github.io/standards/)
- [Consumer Data Right provider guidance](https://www.cdr.gov.au/for-providers)
- [CDR accreditation checklist](https://www.cdr.gov.au/sites/default/files/2024-12/CDR-accreditation-checklist-published-28-April-2023.pdf)
- [CDR participant tooling](https://www.cdr.gov.au/for-providers/participant-tooling)

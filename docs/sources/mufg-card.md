# MUFG card family / My Digital Connect source research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26 (public information); live verification not performed.

## 1. Scope and prohibitions

This record covers cards issued/operated by 三菱UFJニコス (Mitsubishi UFJ NICOS) whose card face or official
guidance establishes `My Digital Connect` (MDC). Bank account 三菱UFJダイレクト (MUFG Direct), JCB-issued
cards' MyJCB, NICOS-brand Net Branch are separate authentication/data sources.

Inventory candidates follow. Do not identify products unverified in inventory as user-held cards based only
on public information.

| Inventory candidate                     | Candidate authoritative billing/usage statements | Candidate authoritative rewards         | Live checks                                                 |
| --------------------------------------- | ------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------- |
| 三菱UFJカード (MUFG Card)               | MDC                                              | MDC グローバルポイント (Global Points)  | Card brand/MDC mark/per-card login IDs                      |
| JALカード (JAL Card, MUFG-issued)       | MDC                                              | JMB (miles absent from card statements) | Visa / Mastercard / TOKYU POINT ClubQ etc., issuer/MDC mark |
| J-WESTカード (J-WEST Card, MUFG-issued) | MDC                                              | WESTER                                  | Visa/Mastercard; JCB uses MyJCB, out of scope               |

JAL/J-WEST authoritative billing/rewards differ. MDC billing does not fully replace JMB miles/WESTER points.

Allowed: existing displays/confirmed-pending statements/points inquiries/existing PDF-CSV retrieval,
read-only observation on user-controlled devices/accounts. No payment method changes, あとdeリボ (later revolving
conversion)/installments, early repayment, cash advances/card loans, limit changes, points exchanges,
card/additional card applications, registered information changes, WEB statement/3-D Secure registration-removal.
Keep account/card/member numbers, names, birth year-month, phone/email, cookies/tokens, actual balances/bills
out of artifacts/logs/HARs/screenshots/commits. No security-control bypass.

## 2. Methods and strength of evidence

- Prioritized official Mitsubishi UFJ NICOS/JAL Card/JR West pages/FAQs/app store listings.
- Used December 2025 old-service integration pages to distinguish old DC/MUFG Card WEB services from MDC.
- Searched public GitHub code by current hosts/app packages/service names.
- Sent HEAD requests to logged-out public URLs on 2026-08-26, observing only CDN/WAF response headers; no login/challenge triggering/load tests.
- No authenticated screens/actual CSV-PDF/app traffic/APKs obtained. Screen descriptions limited to official guides,
  transport to next-stage verification plans; separate hypotheses from facts.

## 3. Official surfaces and card identification

### 3.1 My Digital Connect and old services

Established facts:

- [MDC eligibility FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=383) covers old MUFG/DC cards with MDC marks, including affiliated cards. Company-settlement corporate cards/some ETC-only cards excluded.
- [DC Web integration](https://www.integration.cr.mufg.jp/dccardfc/webservice/): old DC Web merged into MDC on 2025-12-09. Old services were customer-based around primary members; MDC IDs are per card, including primary/family members.
- [Old MUFG Card WEB integration](https://www.integration.cr.mufg.jp/mubank/webservice/): bank combined cash-credit cards also moved to MDC; old MUFG Direct SSO ended. Separate bank/MDC logins.
- [Service selection](https://www.cr.mufg.jp/member/support/webs/change/index.html): old MUFG/DC with MDC marks use MDC; NICOS brand uses separate Net Branch.
- [Per-card ID FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=396): cannot consolidate cards under one MDC ID; each needs its own. Generally IDs survive switching/reissuance, some products need re-registration
  ([card additions](https://faq.cr.mufg.jp/mufgcard/detail?id=221), [switching/reissuance](https://faq.cr.mufg.jp/mufgcard/detail?id=2421)).
- [Family FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=395): family members may register MDC themselves using primary member registered phone during registration. Official app generally personal primary members only, excluding family/corporate/some cards
  ([app eligibility](https://faq.cr.mufg.jp/mufgcard/detail?id=3859)).

Do not assume one account card-list retrieval. Safe inventory separately tracks user-confirmed card display
names/issuers/brands/MDC marks/primary-family status/billing inclusion without numbers. Primary statements may
aggregate family/ETC/additional cards; use `利用者` ("user") fields for attribution only if available, avoiding
double counting separate statements.

### 3.2 Affiliated brand differences

- [J-WEST statements](https://wester.jr-odekake.net/j-west/support/meisai/): Visa/Mastercard MDC, JCB MyJCB; primary statements include family/ETC/additional usage. WESTER/MDC IDs separate.
- [J-WEST authentication](https://wester.jr-odekake.net/j-west/support/ec_secure/) also separates Visa-Mastercard/JCB registration.
- [JAL Card FAQ](https://jalcardfaq.jal.co.jp/--68fb5e92c8b75b4a1de3daef): JAL Visa/Mastercard/TOKYU POINT ClubQ statements in NICOS/MDC, family usage visible from primary account. [JAL/DC integration](https://www.integration.cr.mufg.jp/dcjalcard/) shows old DC Web/App → MDC.
- JAL Card [shopping miles guidance](https://jalcard.jal.co.jp/sp/merit/shopping.html): check accrued miles in MyJALCARD; card statements show no miles/points counts.

MDC Mastercard/Visa/JCB and American Express have separate official login entry points. NICOS issuance
alone does not establish shared URL/DOM/transport across brands.

## 4. Balances, statements, export scope

MDC handles per-card billing/usage/available credit/points, not deposits. [MDC screen guide](https://www.cr.mufg.jp/mufgcard/contact/guide/detail_inquiry/index.html)
and FAQs establish:

| Data                   | Granularity/state                   | Established fields                                                                                                     | Constraints                                                                                   |
| ---------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Confirmed billing      | Monthly bills/usage rows            | Payment date, billed amount, payment account display, user, usage date, merchant, payment classification/count, amount | Do not collect account displays/actual amounts; anonymize card-user identifiers to local keys |
| Pending                | Usage rows after sales data arrival | Usage date, merchant, payment classification, amount, etc.                                                             | Not instant; display gaps may occur between closing and confirmation                          |
| Refund/cancellation    | Negative confirmed rows etc.        | Merchant, adjustments, points adjustments                                                                              | Pending cancellation timing/original transaction machine links unverified                     |
| Installments/revolving | Rows/monthly payment breakdowns     | Current payment, total payment, fees, etc.                                                                             | PC/mobile differences; payment method changes prohibited writes                               |
| Available credit       | Current value                       | Credit limits/availability                                                                                             | Not asset balance; separately decide collection need                                          |
| Global Points          | Primary-member balances/awards      | Accrual/balances, exchange paths on supported cards                                                                    | Does not replace JMB/WESTER; exchanges are writes                                             |

[Statement reflection FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=236): display follows merchant sales data,
so timing varies. Between monthly closing on the 15th and billing confirmation around the 21st, entries may
temporarily disappear from pending lists. Old DC `速報` ("preliminary report") corresponds to MDC `未確定分`
("pending portion") ([post-integration FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=4537)). Rather than overwriting
pending with posted, reconcile duplicates by retrieval datetime/state/amount/merchant/use date; do not equate disappearance with deletion.

[Cancellation/refund FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=3616): negative refunds/points deductions
in statements. [Installment FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=4046) shows current payment/total/fees,
recommends PC for full details. Public material alone does not establish merchant normalization, cancellation/
original IDs, authorization times, currency-exchange CSV columns.

### 4.1 Periods, counts, PDF/CSV

- Current [statement saving FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=2212&site=NIX1EXYK)/guide allow past 15 months PDF/CSV. Mobile PDF only, PC for CSV. Older periods cannot be redownloaded; local retention needed.
- [Old MUFG integration](https://www.integration.cr.mufg.jp/mubank/webservice/) and [official MDC app](https://apps.apple.com/jp/app/%EF%BD%8D%EF%BD%83%E3%82%A2%E3%83%97%E3%83%AA/id1530905195) say maximum 16 months. May be 16 displayed months including current versus past 15, but public material alone cannot establish this.
- Three above `www.integration.cr.mufg.jp` links retain content in official search results, but 2026-08-26 reachability checks had TLS certificate hostname mismatches. Treat as migration-time primary material; prefer current MDC FAQs/guides/live display operationally.
- Official public material insufficiently establishes rows per page, maximum rows, exact CSV headers/encoding, confirmed-month versus multi-month PDF/CSV scope. Live checks required.

Store monthly originals encrypted, indexing only file hashes/card pseudonyms/billing months/retrieval times/
source URLs-formats. Redact account number fragments/names etc. before ingestion or isolate originals outside
app processing areas.

## 5. Points

[Global Points terms](https://www.cr.mufg.jp/member/rule/mufgcard/globalpoint.html): supported cards show
accrual/balances on statements/MDC; post-closing changes appear in later months. Ordinary points expire
24 months from accrual month, Platinum etc. 36 months, owned by primary members.

Separate authoritative sources by card product:

- MUFG Card Global Points: candidate read-only MDC inquiry.
- JAL Card: MDC billing, JMB authoritative miles; infer no miles history from MDC.
- J-WEST Visa/Mastercard: MDC billing, WESTER points. Even when linking WESTER IDs,
  separate credentials/sources.

Points exchange/product applications/e-gift issuance are not reads, excluded from automation.

## 6. Authentication, MFA, passkeys, and Bitwarden

### 6.1 Established facts

- MDC Web uses per-card ID/password plus birth year/month or last four registered-phone digits
  ([login trouble guidance](https://www.cr.mufg.jp/mufgcard/contact/unable_to_login/index.html),
  [extra verification FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=4069)); PII/knowledge factors.
- Initial app login uses MDC ID/password/registered birth year-month
  ([initial login FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=4088)); afterwards app passcodes/device biometrics
  ([biometrics FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=4018)).
- EMV 3-D Secure online purchases use email/SMS OTPs, replacing old ID/password methods since November 2024
  ([3-D Secure FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=4146)); card payment identity checks, not established as ordinary MDC login MFA.
- No official MDC Web/app passkey/WebAuthn support found. App biometrics described as local unlock, not established server passkeys.

### 6.2 Relationship with Bitwarden (separate hypotheses)

Bitwarden generally offers [browser autofill](https://bitwarden.com/help/auto-fill-browser/),
[custom fields](https://bitwarden.com/help/custom-fields/), [Android autofill](https://bitwarden.com/help/auto-fill-android/).
These suggest technical feasibility of MDC ID/password help and per-card URI/item separation, not official MDC
integration. Android also cannot handle custom fields.

Birth year-month/last phone digits in custom fields might help Web input, but store PII and combine extra
knowledge factors with passwords in one vault item. This trades convenience against defensive separation;
not required/default for implementation. Even if DOM names are known, record no values in HAR/logs/screenshots.
No discovered passkeys does not prove Bitwarden incompatibility.

Session lifetimes/refresh tokens/cookie reuse/concurrent logins/IP-device binding/ordinary-login OTP triggers unverified.

## 7. CDN, WAF, anti-bot

Logged-out HEAD observations on 2026-08-26:

| Public entry                | Observation                                                        | Conclusions/limits                                                        |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `www.cr.mufg.jp/mufgcard/`  | `200`, `Via: ...cloudfront.net`, `X-Cache`, `X-Amz-Cf-*`           | Public pages via Amazon CloudFront; authenticated architecture unverified |
| `faq.cr.mufg.jp/mufgcard/`  | `200`, `Server: Apache`                                            | Public FAQ response, no proof of absent WAF                               |
| `www2.cr.mufg.jp/newsplus/` | `200`, `Server: nginx`, `PHPSESSID`, `X-PUBLIS-Status`, CloudFront | Dynamic sessions/redirects; save no cookie values                         |

No Cloudflare/Akamai-specific headers observed in this scope, but CDN headers alone do not establish WAF
products or bot detection presence/absence. Post-login origins, JS challenges, fingerprints, rate limits,
device/IP reputation unverified. No intentional challenges/CAPTCHA bypass/rate-limit probing/header-spoofing bypass.

## 8. Roles of official app, APK, and Web

- [Official MDC app guidance](https://www.cr.mufg.jp/mufgcard/service/other/app/002/index.html) lists monthly payments/statements/points/available credit; adjacent payment changes/points exchange writes.
- Official Android links identify `jp.mufg.cr.app4` ([Google Play](https://play.google.com/store/apps/details?id=jp.mufg.cr.app4)); iOS via [App Store](https://apps.apple.com/jp/app/%EF%BD%8D%EF%BD%83%E3%82%A2%E3%83%97%E3%83%AA/id1530905195). No official standalone APK found.
- PC Web provides CSV, suited to confirmed/pending/report checks. App suits daily inquiries/notifications/
  passcode-biometric unlock but excludes family/corporate/some cards; official CSV still requires PC.

APK/app/JS/traffic analysis is not a non-goal. When official documents/read-only Web observations lack transport/
fields, next stages may statically analyze legitimate Google Play binaries on user-controlled devices and
observe read-only owner sessions dynamically. No redistributed APKs/modified apps/pinning-attestation-CAPTCHA
bypass/secret extraction-persistence/writes.

## 9. Public third-party implementations and transport/auth

GitHub code searches on 2026-08-26 for `My Digital Connect`, `jp.mufg.cr.app4`, `www2.cr.mufg.jp/newsplus`,
`mufg card scraper`, etc. identified no public client implementing current personal MDC authentication/statements.
Not proof of nonexistence.

Discovered [GoodLight999/otoku-checker](https://github.com/GoodLight999/otoku-checker/tree/149fd492139b7e4272ac65695bc20241b502614e)
GETs public MUFG points benefit pages with Python `requests.Session.get`/browser-like headers and extracts
HTML through BeautifulSoup/trafilatura. Unauthenticated public content only, no personal statements, no repository
license shown. No personal-account transport/code reuse evidence, but concrete public `www.cr.mufg.jp` HTTP-client response example.

Established personal transport/auth remains UI/public-header evidence: TLS Web/app, per-card IDs/passwords,
extra knowledge checks, apparent session cookies. JSON/GraphQL/form POST, endpoints, CSRF, device binding,
token renewal unverified.

### 9.1 Read-only transport discovery when information is insufficient

1. **Official Web static observation:** record logged-out public HTML/JS URLs, form actions, CSP, asset manifests,
   not authenticated URLs/secrets. Public source maps may indicate read-only schema names. No private-resource access bypass.
2. **Authenticated Web dynamic observation:** in user-controlled browser DevTools, only permitted statement list/detail/
   PDF/CSV reads. Allowlist methods/origins/path templates/content-types/statuses/request-response field names.
   Redact cookies/Authorization/CSRF values/card-member numbers/accounts/amounts/merchants/PII before capture/storage.
   Secret-scan and manually review sanitized HARs before sharing.
3. **Official app static analysis:** legitimate APK manifests/packages/min SDK/network config/libraries/host-path
   strings/protobuf-OpenAPI-equivalent types. Verify signatures/binary hashes, no repository binaries.
   Obfuscation adds unknowns; removal/control bypass is not the goal.
4. **Official app dynamic observation:** only read screens on user-controlled devices/emulators using ordinary
   OS-permitted network/debug observability. Stop at required pinning/root-attestation/anti-tamper bypass,
   return to UI automation. Persist no tokens/PII/actual values.
5. **Reproducibility assessment:** known read endpoints are not public APIs. Enumerate read/write endpoints/scopes,
   consider one isolated read-only replay. Reject headless replay if renewal requires writes/OTP/resets/bypass,
   or reads/writes cannot be separated with the same credential.

This is a safe research order for transport missing from official information, not a ban on analysis.

## 10. Read/write isolation

Minimal allowlist:

- Login/existing session checks (excluding lock/reset/re-registration)
- Per-card confirmed/pending statement lists/details
- Existing monthly PDF/CSV downloads
- Supported card points balances/award histories/available credit, only if needed

Denylist:

- Payment classification changes, later revolving/installment conversion, early repayment, payment amount changes
- Cash advances/card loans/limit-credit changes
- Points exchange/product-gift applications/campaign entries
- Card/ETC/family-additional card/insurance applications
- Name/address/phone/email/account/PIN/password/notification etc. settings
- WEB statements/3-D Secure registration-removal, ID reset, card reissuance/suspension

Internal APIs may allow reads/writes with one session credential. Combine origin+path+schema allowlists,
egress proxies, dry-run, response content-type/size limits; do not rely on HTTP method. Stop without actions
if destinations show `申込` ("apply"), `変更` ("change"), `確定` ("confirm"), `交換` ("exchange"), `借入` ("borrow"), etc.

## 11. Runtime suitability

| Runtime                 | Suitability                                                  | Reason                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers      | High for manual export receipt/parsing, low for direct login | [Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) supports HTTP ingestion; isolates unsuitable for retaining per-card browser sessions/extra checks/download UI                         |
| Cloudflare Browser Run  | Web UI automation candidate                                  | [Browser Run](https://developers.cloudflare.com/browser-run/) offers Playwright/Puppeteer/CDP/session reuse; financial-session/PII cloud placement decisions, per-card logins, extra checks, mixed writes remain |
| Cloudflare Containers   | Headless browser/analysis worker candidate                   | [Containers](https://developers.cloudflare.com/containers/) run full filesystems/arbitrary runtimes/OCI images; need separate secret delivery/profiles/region-IP/sleep-restart/auditing designs                  |
| General OCI container   | Suitable                                                     | Reproducible Playwright/PDF-CSV parsers/sanitizers; exclude credentials/profiles from images, use short-lived secret mounts/encrypted volumes                                                                    |
| Kubernetes              | Suitable for many sources, excessive for initial MUFG alone  | CronJob/NetworkPolicy/read-only FS/Secret CSI/audits; clear per-card jobs/egress allowlists but high operations cost                                                                                             |
| User-controlled devices | Best initial live/app observation                            | Existing legitimate app/browser/manual extra verification without exporting secrets; not fully unattended                                                                                                        |

Initially manually obtain monthly CSV/PDF on user devices, pass to Workers/OCI read-only parsers. Add user-device
or isolated OCI/Browser Run browser jobs only after Web transport isolation is proven. If only app transport
has sufficient granularity, reassess costs as UI/device automation.

## 12. Automation levels A-E and implementation cost

Use only common PR #5 definitions.

- **A**: documented/export APIs for scheduled headless use
- **B**: stable read-only internal APIs/renewable-reusable sessions
- **C**: promising headless replay after browser/app bootstrap
- **D**: full browser/device automation required
- **E**: manual capture is safe default

| Option                                        | Level       | Cost (1-5) | Assessment                                                                                                             |
| --------------------------------------------- | ----------- | ---------: | ---------------------------------------------------------------------------------------------------------------------- |
| Manual PC monthly CSV/PDF export into parsers | E           |        1-2 | Officially offered, recommended first implementation; per-card logins/file redaction may make 2                        |
| Per-card read-only MDC Web browser automation | D           |          4 | IDs/extra checks/multiple cards/state transitions/mixed writes/session-WAF unknown; CSV likely feasible                |
| Observed read endpoint bootstrap + replay     | C candidate |        4-5 | Endpoints/sessions unknown, not B; needs separated scopes/credential renewal                                           |
| Official app UI/device automation             | D           |          5 | Excludes family/some cards; device biometrics-passcodes/writes/transport-attestation unknown; do not choose before Web |

**Overall: D, cost 4. Safe initial route: E, cost 1-2.** No documented personal API/stable observed internal
read API, so not A/B. Update to C if future static/dynamic evidence proves transport/read-write isolation.

## 13. Read-only live verification plan and stop conditions

### Phase 0: manual inventory (no secrets/numbers)

1. For each candidate check only display name/issuer/brand/MDC mark/primary-family status/rewards authority
   (MDC/JMB/WESTER).
2. Count per-card ID existence without recording IDs; check family/ETC/additional inclusion in primary statements,
   preventing duplicate retrieval.
3. Exclude J-WEST JCB/MyJCB, NICOS/Net Branch, MUFG bank accounts.

### Phase 1: one read-only Web verification

1. Login normally in user-controlled browser; give automation logs no IDs/passwords/birth year-month/last phone digits.
2. Check confirmed/pending displayed months/month selector counts/rows per page/pagination/users/merchants/refund
   negatives/installment breakdowns as schemas without actual values.
3. Count oldest/latest months to resolve past 15 versus maximum 16.
4. For one existing month, not dummy generation, check PDF/CSV controls/single-bulk scope/MIME/
   filename patterns/encoding/headers/row limits on-device. Share no contents.
5. Before DevTools, enable Section 9.1 redaction; retain only read method/path templates/field names, no writes.

### Phase 2: app/transport (if Web insufficient)

1. Obtain signed Google Play `jp.mufg.cr.app4` from user devices; record only package/version/
   signing certificates/hashes.
2. Check candidate hosts/schemas statically, separately from Phase 1 Web hosts.
3. One session of standard read-screen dynamic observation; stop if pinning/attestation/anti-tamper bypass needed.
4. Organize read-write endpoints/scopes/session renewal/rate responses; reproduce only safe reads, minimum one
   attempt. Do not promote to B without established tokens/scopes lacking write capability.

### Immediate stop

- OTP/3-D Secure, CAPTCHA, extra identity verification, ID reset, account/card locks, re-registration requested
- Navigation to payment/borrowing/exchange/application/change/confirmation submission pages, or inseparable read-write endpoints
- Need for security-control/certificate pinning/attestation/anti-tamper bypass
- Unredacted cookies/tokens/card-member-account numbers/PII/amounts/merchants in HAR/logs/screenshots/downloads
- 403/429/abnormal redirects-challenges/access denial/explicit terms-robots prohibitions/unexpected origins
- Reproduction not established idempotent reads, or method/path/schema outside allowlists

On stopping, no retries/other IPs/header spoofing/other-device bypass; return to manual CSV/PDF.

## 14. Established facts, hypotheses, and unverified items

### Established facts

- MDC IDs per eligible card; family Web registration allowed, narrower app eligibility.
- Official confirmed/pending statements/PDF-CSV/merchants-users-payment classifications etc.; smartphone PDF
  only, PC for CSV.
- Refund negatives/installment fees-totals; pending depends on merchant sales data arrival.
- Ordinary Web login ID/password plus birth year-month/last phone digits; app passcode/biometrics after setup;
  3-D Secure OTP is payment authentication.
- Public CloudFront observed; official app `jp.mufg.cr.app4`.
- JAL/J-WEST billing authority separate from miles/points authority.

### Hypotheses (verify live)

- Maximum 16 months/past 15 months may differ by current-month inclusion.
- Bitwarden can assist MDC credentials; storing extra check values weakens defensive separation.
- Read replay may work after browser bootstrap, but sessions/write scopes unverified;
  remains a C candidate.

### Unverified

- Owner cards/brands/primary-family-additional relationships (record no values)
- Exact CSV schemas/encoding, PDF-CSV single-month scope, pagination/row limits/original refund links
- Foreign currency/conversion/fee columns, merchant IDs, authorization-sales timestamps, stable pending IDs
- Web/app endpoints/protocols/CSRF-tokens/session lifetimes-renewal/device-IP binding/ordinary-login MFA
- Passkeys/WebAuthn/authenticated WAF-anti-bot/app pinning-attestation
- Current public personal MDC clients/licenses

## 15. Main official links

- [My Digital Connect](https://www.cr.mufg.jp/mufgcard/)
- [MDC eligibility](https://faq.cr.mufg.jp/mufgcard/detail?id=383)
- [Statement inquiry guide](https://www.cr.mufg.jp/mufgcard/contact/guide/detail_inquiry/index.html)
- [Statement PDF/CSV and periods](https://faq.cr.mufg.jp/mufgcard/detail?id=2212&site=NIX1EXYK)
- [Per-card MDC IDs](https://faq.cr.mufg.jp/mufgcard/detail?id=396)
- [Family MDC registration](https://faq.cr.mufg.jp/mufgcard/detail?id=395)
- [Old DC Web integration](https://www.integration.cr.mufg.jp/dccardfc/webservice/)
- [Old MUFG Card WEB integration](https://www.integration.cr.mufg.jp/mubank/webservice/)
- [MDC app](https://www.cr.mufg.jp/mufgcard/service/other/app/002/index.html)
- [J-WEST statement guidance](https://wester.jr-odekake.net/j-west/support/meisai/)
- [JAL Card statement FAQ](https://jalcardfaq.jal.co.jp/--68fb5e92c8b75b4a1de3daef)

# Epos / Epos Visa Prepaid family research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

- Research date: 2026-08-26 (Australia/Sydney)
- Scope: エポスカード (Epos Card), エポスVisaプリペイドカード (Epos Visa Prepaid Card), エポスNet (Epos Net), エポスアプリ (Epos app), and additional cards included in the same statements
- Out of scope: other issuers' cards, external aggregators as initial data sources, payment processor/merchant services
- Safety conditions: public information and passive public host observations only. Did not obtain/record member IDs, card numbers, security codes, names, contact details, actual balances/usage amounts, cookie values, passwords, or OTPs. Performed no writes such as payments, top-ups, refunds, revolving/installment changes, points use, card settings, or personal information changes.

## Conclusion

For credit card history, PC Epos Net's `月別ご利用履歴照会` ("monthly usage history inquiry") offers the most
information and longest retention, exporting monthly PDF/CSV from March 2006 onward. The invoice-equivalent
`ご利用代金明細書` ("card usage statement") is PDF; payment results are viewable/printable for the past 12 months.
The app excels at pending notifications, monthly graphs, categorization, and viewing the past 24 months of
statements, but official material does not describe bulk CSV export.

Epos Visa Prepaid current balances and month-selected usage history are available in Epos Net/app, but public
primary sources do not specify maximum retention, row limits, or CSV/PDF export. Do not assume inclusion
in the same CSV as credit cards.

Initial implementation: **E / cost 1–2** (owner-manually-obtained PC credit CSV/PDF + local parsing).
Safe default for prepaid/points: **E / cost 2** manual recording. No official API established. As a next stage,
read-only static analysis of public Web JavaScript/legitimately obtained official APKs and dynamic observation
of communication metadata in owner-operated sessions are worthwhile as **C candidates / cost 3–4**.
Do not perform transactions/writes, retain secrets/PII, or bypass authentication/WAF/certificate pinning or other security controls.

## 1. Family and data ownership boundaries

### Primary member's credit card

- Epos Net handles expected payments, usage history, payment history, available credit, cash advance statements, points, etc.
- Credit cards have no deposit balance; collect available credit, expected billing, and usage/payment history. Available credit is restored after Epos confirms the bank's debit result, not immediately after the payment date.

### Family

- エポスファミリーゴールド (Epos Family Gold) is not a conventional dependent family card. Each person has an independent Epos Gold Card, credit limit, statements, and debit account.
- Only the cardholder can view individual usage. Do not treat it as a route for the representative to retrieve family members' personal statements.
- Family registrants can check `現在の家族合計利用金額` ("current total family usage amount") in app/Epos Net, but this is an aggregate, not individual transaction statements.

### Additional cards

- エポスETCカード (Epos ETC Card): one per parent card. Usage enters the same statements as parent-card shopping, etc.; Epos cannot issue ETC-only statements. Arrival depends on the road operator, roughly three weeks after use.
- エポスバーチャルカード (Epos Virtual Card) is added to a parent card, with available credit set within its limit; usage is billed together with the parent card.
- Epos Visa Prepaid is for the member alone, with balance/usage history inquiry paths separate from credit statements.

Primary sources:

- [Epos Net features](https://www.eposcard.co.jp/eposnet/index.html)
- [Inquiry/registration menu](https://www.eposcard.co.jp/eposnetuse/index.html)
- [Family Gold ownership/statement boundaries](https://www.eposcard.co.jp/family_gold/index.html)
- [Only cardholders can view individual family usage](https://faq.eposcard.co.jp/faq/show/1625)
- [ETC cards](https://www.eposcard.co.jp/eposcard/etc_use.html)
- [ETC-only statements unavailable](https://faq.eposcard.co.jp/faq/show/3418)
- [Virtual cards](https://www.eposcard.co.jp/virtual/index_01.html)
- [Visa Prepaid](https://www.eposcard.co.jp/prepaid/index.html)

## 2. Granularity, periods, exports, and tradeoffs by route

| Route                                                  | Granularity/state                                                                                                                                     |                                           Published period | Export                                             | Tradeoff                                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------: | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| PC Epos Net `月別ご利用履歴` ("monthly usage history") | Usage date, location, amount, payment classification, first payment month. Refunds show cancellation date and negative amount in original usage month |                                          March 2006 onward | PDF / CSV                                          | Longest, structured; requires month selection and differs semantically from early pending notifications |
| Epos Net `ご利用代金明細書`                            | Usage date, merchant, amount, payment count, current payment amount, revolving/installments                                                           | App FAQ says past 24 months; separate Web limit unverified | PDF                                                | Invoice-equivalent, includes payment count, but not CSV                                                 |
| Epos Net/app `支払履歴` ("payment history")            | Payment date, amount, method and breakdown                                                                                                            |                                             Past 12 months | PC printing; no official CSV/PDF description       | Good for checking actual payment, shorter retention than usage history                                  |
| Epos app `お支払照会` ("payment inquiry")              | Pending notifications, confirmed statements, monthly graphs, categories, payment change paths                                                         |            Statements 24 months; payment history 12 months | Screen/PDF viewing; no CSV description             | Timely and readable, but adjacent writes and weak structured export                                     |
| Visa Prepaid balance                                   | Current available balance                                                                                                                             |                                              Current value | No official export description                     | Good for immediate status, not historical snapshots                                                     |
| Visa Prepaid usage history                             | History by year/month; merchant data normally reflected in 2–14 days                                                                                  |                       Maximum past period/count unverified | No official CSV/PDF description                    | Separate from credit history; needs manual transcription or later transport research                    |
| エポスポイント (Epos Points)                           | Current balance, points nearing expiry, availability date                                                                                             |                 Ordinary points: two years from award date | No official export/full-history period description | Enough for expiry monitoring, no machine retrieval specification for changes ledger                     |

PC PDF/CSV fields/formats are also explicit in Epos Card's own personal information disclosure guidance.
Public information cannot establish maximum CSV rows, page sizes, encoding, filenames, stability of repeat
retrieval in the same month, or complete prepaid history columns.

Primary sources:

- [Usage statement/history periods and formats](https://faq.eposcard.co.jp/faq/show/90)
- [Statement fields/output formats in official disclosure guidance](https://www.eposcard.co.jp/pdf/release_application.pdf)
- [Past 24 months of statements in app](https://faq.eposcard.co.jp/faq/show/3607)
- [Past 12 months of payment history](https://faq.eposcard.co.jp/faq/show/3505)
- [Prepaid history inquiry route](https://faq.eposcard.co.jp/faq/show/809)

## 3. Pending, confirmed, refunds, and installments

### Credit

- App `未確定` ("pending") means official usage information has not arrived from the merchant and billing is unconfirmed. Normally 2–14 days after notification, official information arrives, the pending display disappears, and the merchant name appears.
- Usage notifications may arrive even for an attempted use and do not mean billing confirmation. Do not double count notifications, pending statements, and confirmed statements as the same event.
- For payment on the 27th, usage from the previous month's 28th through current month's 27th is confirmed on the following month's 6th, paid on the 27th. For payment on the 4th, usage from the previous month's 5th through current month's 4th is confirmed on the current month's 11th, paid on the following month's 4th. Usage data arriving after confirmation enters the next bill.
- Refund/cancellation data may take about 1–4 weeks to arrive. Selecting the original usage month in monthly history displays the cancellation date in remarks and a negative usage amount. Arrival after closing may lead to a refund after an initial debit.
- Card usage statements include payment count, current payment amount, revolving/installments. Later installment/revolving changes are possible after official data arrives until the change deadline, but are writes; do not execute them from research screens.

### Visa Prepaid

- Generally deducted from balance immediately at use, but online shipment processing, communication conditions, foreign exchange, etc. may cause delays/amount changes.
- Hotel/rental deposits or small validity checks may temporarily cause duplicate/excess deductions, refunded immediately to at most 45 days later, leaving only the final amount.
- Returns/cancellations affect balance when merchant cancellation data arrives. Do not assume the same state machine as credit pending displays.
- Card balance expiry is the expiry printed on the card; user-convenience refunds are unavailable.

Primary sources:

- [App pending display](https://faq.eposcard.co.jp/faq/show/2690)
- [Usage notification does not mean billing confirmation](https://faq.eposcard.co.jp/faq/show/2679)
- [Statement reflection, closing/confirmation dates](https://faq.eposcard.co.jp/faq/show/138)
- [Credit refund displays](https://faq.eposcard.co.jp/faq/show/2429)
- [Conditions for later installment/revolving changes](https://faq.eposcard.co.jp/faq/show/3629)
- [Prepaid immediate deduction, deposits, refunds](https://www.eposcard.co.jp/prepaid/index.html)
- [Prepaid return balance reflection](https://faq.eposcard.co.jp/faq/show/828)

## 4. Epos Points and expiry

- Ordinary points last two years from accrual, through the day before the accrual date two years later. Those expiring soonest are used first.
- If points expire within three months, Epos Net/app displays an extension operation allowing all points to be extended to 24 months later. Extension is a write; do not execute it.
- Gold/Platinum Epos Points have no expiry. Expiry conditions on membership termination/loss of eligibility etc. remain.
- Epos Net displays balances and points nearing expiry. Accrual dates depend on payment dates; delayed merchant sales data also delays accrual.
- Points can move to Visa Prepaid, but top-up is a prohibited write. 0.5% of prepaid spending is credited as cashback to card balance in the middle of the following month.

Primary sources:

- [Points accrual dates, expiry, and inquiry](https://www.eposcard.co.jp/point/use.html)
- [Current points terms](https://www.eposcard.co.jp/rule/rule_point.html)
- [Points expiry FAQ](https://faq.eposcard.co.jp/faq/show/53)

## 5. Authentication, MFA, passkeys, and Bitwarden

### Established facts

- Ordinary Epos Net login requires Epos Net ID and password. The login ID is not an email address.
- Risk-based extra checks may require the three-digit security code on the card back. This is secret; do not pass it to automation.
- An optional service emails on every Epos Net/app login. Official FAQ says notifications also occur when linked household accounting services etc. log in to Epos Net irregularly.
- After initial Epos Net ID/password entry, the app offers Face ID, biometrics, and automatic login on supported devices. After changing phones, reinstall; extra authentication may be requested at login.
- Visa Secure 3-D Secure 2.0 is for online **payments**, sending an eight-digit SMS OTP to the registered phone when needed, valid two minutes. Do not conflate this with ordinary Epos Net login MFA.

### Passkeys / Bitwarden

As of 2026-08-26, official sites/FAQs/login screens did not establish Epos Net WebAuthn/passkey support.
App Face ID is convenient device login, but public material alone does not equate it with synced passkeys/FIDO2 credentials.

Bitwarden generally supports URI-based ID/password autofill and passkey storage. Epos-specific official
compatibility is unverified, as are Epos passkeys. If used, strictly match official HTTPS hosts; exclude
card numbers, security codes, and SMS OTPs from storage/autofill.

Unverified: ordinary-login extra authentication decisions, session TTL, refresh mechanisms, device trust lifetimes,
app token storage, device attestation, and certificate pinning.

Primary sources:

- [Official login screen](https://www.eposcard.co.jp/memberservice/pc/login/login_certify_advertised.do)
- [Additional security code at login](https://faq.eposcard.co.jp/faq/show/1709)
- [Login notifications and linked services](https://faq.eposcard.co.jp/faq/show/844)
- [Initial Face ID registration](https://faq.eposcard.co.jp/faq/show/2443)
- [Authentication after changing phones](https://faq.eposcard.co.jp/faq/show/2485)
- [Visa Secure 3-D Secure 2.0](https://faq.eposcard.co.jp/faq/show/3408)
- [SMS OTP](https://faq.eposcard.co.jp/faq/show/1547)
- [Bitwarden URI match](https://bitwarden.com/help/uri-match-detection/)
- [Bitwarden autofill/passkey](https://bitwarden.com/help/auto-fill-browser/)

## 6. Passive CDN / WAF / anti-bot observations

Performed only DNS and HEAD/GET on public URLs on 2026-08-26. Did not save cookie values.

- `www.eposcard.co.jp` CNAMEs resolve to `www.eposcard.co.jp.edgekey.net`, then `*.akamaiedge.net`, establishing Akamai edge delivery.
- Observed `Akamai-GRN`, `_abck`, `ak_bmsc`, and `bm_sz` cookie names on public home/login pages. Official Akamai material describes `edgekey.net` as an Akamai edge hostname and gives examples of Bot Manager cookies distinguishing humans/automation.
- Responses behind the static home page also indicated Amazon S3/CloudFront; login was Apache/JSESSIONID-based. These are passive observations, not a definitive origin architecture.
- `faq.eposcard.co.jp` CNAMEs to a separate FAQ platform; do not assume the same protection/session as the member site.
- Akamai use and bot-protection signals are established; product names such as Kona Site Defender, WAF rules, bot scores, rate limits, and challenge conditions are unverified. No challenge on public screens does not establish none after authentication.

Primary sources:

- [Akamai edge hostname explanation](https://techdocs.akamai.com/property-mgr/docs/key-concepts-terms)
- [Akamai Bot Manager cookie example](https://techdocs.akamai.com/identity-cloud/docs/hosted-login-cookies-and-local-storage-1)

## 7. Official app / APK / Web

- Official Android package: `jp.co.eposcard.epossupportapp`; iOS App Store ID: `1489130153`. App use requires Epos Net registration.
- Web excels at long-term monthly history, PDF/CSV, and payment/points/prepaid inquiries, but also hosts change procedures.
- The app excels at instant notifications, pending displays, graphs, categories, statements, and points/prepaid paths, but also hosts write UI for payment method changes.

The following read-only analyses are allowed as a next stage to clarify unknown official transport.

1. Record hashes of APKs legitimately obtained from official stores; statically inspect Manifest, permissions, exported components, network security config, public strings, endpoint hostnames, schema/model names, and certificate pinning configuration presence.
2. Statically inspect public Web JavaScript bundle URLs/hashes, source map availability, endpoint strings, read/write route names, and CSRF/session processing.
3. In an owner-operated test session, use DevTools or normal device proxy settings to dynamically observe only HTTP method, hostname, path template, content type, status, and calling screen. Save no request/response bodies, cookies, tokens, card/member numbers, or actual values.
4. If TLS/pinning etc. prevents observation, stop there; do not disable, hook, root, or otherwise bypass security controls.

Primary sources:

- [Official app guidance](https://www.eposcard.co.jp/appli/index.html)
- [Official Google Play listing](https://play.google.com/store/apps/details?id=jp.co.eposcard.epossupportapp)
- [Official Apple App Store listing](https://apps.apple.com/jp/app/%E3%82%A8%E3%83%9D%E3%82%B9%E3%82%A2%E3%83%97%E3%83%AA/id1489130153)

## 8. Public API / third-party client transport and auth

- No customer-facing documented public API, API key, OAuth, or read-only scope was established on official sites.
- Official FAQ says linked household accounting services etc. may log in to Epos Net irregularly. This indicates at least some session-login integrations, but does not publish credential custodians, MFA handling, endpoints, or contracted API availability.
- GitHub searches by official host, login path, Android package, and service names found no maintained public client or concrete authentication implementation. Phishing lists, bookmarks, and mere links were not counted as clients.
- Thus no reproducible third-party transport/auth currently exists. The next experiment is identifying first-party Web/app read transport through the static/dynamic observations above. Even if private specifications are identified, separately evaluate terms, technical stability, and write isolation.

## 9. Read / write isolation

### Safe default

Give parsers no authenticated network capability after manual CSV/PDF export. Inputs read-only, no outbound
communication, originals outside Git; logs retain only column names, counts, and periods, never values.

### Screen allowlist

- `お支払予定額照会` ("expected payment inquiry"), `月別ご利用履歴照会`, `お支払履歴照会` ("payment history inquiry"), `ご利用代金明細書照会` ("card usage statement inquiry")
- `利用可能額照会` ("available credit inquiry"), `ポイント照会` ("points inquiry")
- Visa Prepaid `残高照会` ("balance inquiry"), `利用履歴照会` ("usage history inquiry")
- `ファミリー合計利用金額` ("total family usage amount"; not individual statements)

### denylist

Prohibit as writes: payments, top-ups, points use/transfer/extension, revolving/installment changes,
`いつでもリボ` ("automatic revolving payments"), cash advances, repayment, card applications/suspension/reissuance,
available credit changes, virtual card settings, prepaid PIN, notification settings, address/account/ID/password changes.

### Isolation conditions after transport identification

- Map UI operations to network calls; allowlist read endpoint candidates by host + method + path template.
- Do not automatically treat `GET` as safe; confirm no side effects from official behavior or synthetic/empty data. Fix the operation type in bodies even when reads use POST.
- Initially observe without replay. If replaying, start with one explicit read, low frequency, same user, no response value retention.
- Explicitly deny write hosts/paths/actions. Do not log CSRF tokens/session credentials; label strong isolation unachieved unless read-only credentials/scopes are found.

## 10. Workers / Containers / OCI / Kubernetes suitability

- **Local CLI / OCI: suitable.** Pin CSV/PDF parsers as OCI images, with read-only input, no network, non-root, fixed digest. Smallest setup for one user.
- **Cloudflare Workers: technically possible for export parsing; premature for automated retrieval.** Scheduled handlers exist, but no official API/read-only credentials. No need to send financial PII to cloud, so default local. Reassess if a documented read-only API appears.
- **Cloudflare Containers: can run static analysis/browser-dependent processing, but do not solve authentication/bot/write isolation.** Usable for reproducible public APK/JS static analysis; do not input actual personal data.
- **Cloudflare Browser Run: technically supports browser operations/CDP.** Candidate for reproducing read-only observations; stop at Akamai challenges/extra authentication without bypassing. Authenticated scheduled retrieval only after safety boundary verification.
- **Kubernetes: excessive for one user.** CronJob, Secret, NetworkPolicy fit organizational offline processing of many exports, but introducing a cluster does not solve API/authentication problems.

Primary infrastructure sources:

- [Cloudflare Workers Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/get-started/)
- [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/)
- [OCI Image Specification](https://specs.opencontainers.org/image-spec/)
- [Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)

## 11. PR #5 common A–E / cost

Use only the common scale from [PR #5](https://github.com/risu729/kogane/pull/5).

- A: direct documented export/API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable sessions
- C: headless replay after browser/app bootstrap is realistic
- D: full browser/device automation probably required
- E: manual capture is the safe default
- Cost 1: small wrapper through cost 5: device-bound/adversarial automation

| Route                                             |                     Level / cost | Assessment                                                                   |
| ------------------------------------------------- | -------------------------------: | ---------------------------------------------------------------------------- |
| Manual monthly credit CSV/PDF export              |                      **E / 1–2** | Long-term, official, structured; monthly selection/manual retrieval required |
| Billing PDF / payment history printing            |                        **E / 1** | Easy, but parsing cost/retention differ from CSV                             |
| Manual prepaid balance/history and points capture |                        **E / 2** | Official export unknown; manual value masking needed                         |
| Public JS/APK static analysis                     | **Research for C candidate / 3** | Can clarify endpoint/auth/write boundaries without actual data               |
| Dynamic owner-session observation/replay          |              **C candidate / 4** | Akamai, extra authentication, sessions, mixed writes; stage from observation |
| Full app automation                               |                        **D / 5** | Device-bound; prove read-only boundaries first                               |
| Official read-only API                            |         Unassessed (A candidate) | Specification currently unverified                                           |

## 12. Read-only live verification and stop conditions

### Next experiments

1. User manually logs in to PC Epos Net; researcher checks only menu names, year/month selectors, and export buttons. Do not display/photograph/record actual values.
2. User manually saves one agreed month of CSV/PDF outside Git in a temporary area. Mask values immediately; check only headers, encoding, date format, payment classifications, and refund row representation. Do not commit originals.
3. On prepaid screens, check only year/month selectors and history column names; do not record balance/statement values. Check for CSV/PDF buttons without entering top-up paths.
4. Statically analyze hash-pinned official APKs/public JS, making candidate host/path and read/write classifications. Secrets, deobfuscation keys, and personal data are out of scope.
5. If needed, observe only communication metadata in DevTools/normal proxy during owner operation. Save no raw HAR, bodies, header values, cookies/tokens; retain only screen operation → method/path template mappings.
6. Verify local parsers/deduplication with synthetic fixtures. Prepare notifications, pending, confirmed, cancellation negative amounts as separate states; do not copy actual usage.

### Immediate stop conditions

- Researcher needs to enter/store IDs, passwords, card numbers, security codes, SMS OTPs, sessions/cookies/tokens, PII, or actual values.
- CAPTCHA, Akamai challenges, 403, 429, access restrictions, login failure/lock warnings. No repeated attempts/bypass.
- Security-control bypass becomes necessary: TLS interception, certificate pinning disablement, root/jailbreak, hooks, WAF bypass, etc.
- Writes needed for payments, top-ups, refunds, points use, revolving/installments, cash advances, card/personal/account/authentication/notification settings.
- Reads/writes cannot be distinguished in transport and absence of side effects cannot be confirmed.
- Actual values/secrets in export/traffic captures might remain in logs/Git/cloud before masking.

After stopping, return to established manual CSV/PDF or screen capture; record unknowns as unknown.

## 13. Facts, hypotheses, and unverified items

### Facts

- PC monthly history: March 2006 onward, PDF/CSV. Payment history: 12 months; app statements: 24 months.
- Credit pending, confirmed, and cancellation negative amounts have officially described distinct displays.
- Prepaid balances/history have separate paths; generally immediate deduction, with delays/corrections/refunds.
- Ordinary points: two years; Gold/Platinum: no expiry.
- Web uses ID/password and conditional card security codes; app uses biometrics/automatic login after initial login; payments use Visa Secure SMS OTP.
- Passively observed Akamai edge and bot-protection cookie names.

### Hypotheses

- Public Web/app have authenticated HTTP transport, so static/dynamic analysis likely can identify read routes.
- Official household accounting integration descriptions establish session-based linking, but third parties may not be able to reproduce it safely.
- Monthly CSV appears the most stable collector input, but schema stability has not been verified on live samples.

### Unverified

- Public/contracted APIs, OAuth, read-only scopes.
- Complete CSV schemas, encoding, maximum rows, pagination, common transaction IDs, pending row inclusion.
- Prepaid history maximum periods/counts/columns, CSV/PDF export, refund representation.
- Points change history periods/exports.
- Session/token lifecycle, device binding, passkeys, app pinning/attestation.
- Family aggregate update frequency/exports.
- Concrete Akamai WAF/Bot Manager settings and rate limits.

# 京都銀行 (Bank of Kyoto) bank account source research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26 (public information and read-only HTTP observations of unauthenticated official sites)

## Conclusion

- Currently the safest, cheapest initial route is **CSV/PDF manually exported by the user from `京銀スマート通帳` ("Kyogin Smart Passbook") in 京銀アプリ (Kyogin app)**, up to 1,000 entries. Public material establishes ordinary/savings deposit inquiry in Web 京銀ダイレクトバンキング (Kyogin Direct Banking) from, at most, the first day of the second preceding month through the inquiry date.
- The main long-term candidate is the official Open API outsourced to NTT DATA. Bank of Kyoto explicitly includes ordinary, savings, time, installment time, foreign-currency ordinary, foreign-currency time deposits, and investment trusts in personal read API scope. Direct connection requires contracting/review as an electronic payment service provider; it is not a public API personal Kogane can use without a contract.
- Unofficial authenticated HTML replay and Android UI automation are strongly affected by authentication state, OTP device migration, dynamic hidden state, additional authentication, and site changes. Reverse engineering remains in scope. Public login JS was statically formatted/deobfuscated; owner-operated read-only runtime metadata observation and official Play split static analysis were specified as next experiments. Adoption as a production collector depends on demonstrating read/write separation and session renewal from those results.
- `www.kyotobank.co.jp` is delivered by Akamai. No CAPTCHA or explicit bot challenge was observed on the unauthenticated personal Web banking login at `www.parasol.anser.ne.jp`. This does not establish absence of anti-bot after login.
- **Card usage statements for 京銀 JCB デビット (Kyogin JCB Debit), 京都カードネオ (Kyoto Card Neo), etc. are outside this document, belonging to a separate MyJCB family PR.** Bank-side account debit entries for debit use/card payments may be retained as bank transaction observations, but must not be identified with merchant-level card statements.
- Common assessment: currently available manual CSV **E / cost 1**, unverified read replay after authenticated browser bootstrap **C / cost 4**, Android device automation **D / cost 5**, direct contracted API **A / cost 5**. Static analysis is a research stage determining C/D feasibility, not itself a collector automation level.

## Research safety boundaries

This research checked public pages, official FAQs/store listings, NTT DATA public API specifications,
unauthenticated login screens, and JavaScript publicly loaded by those screens. Public JS was decoded,
formatted, and statically unpacked by packer string substitution; unknown code was not executed with `eval`.
No login, account inquiry, export, OTP issuance, linking consent, or transaction was performed. No secrets
or PII were retrieved/recorded: account numbers/IDs, balances, transaction statements, member numbers,
passwords, OTPs, cookies/tokens, names, email, phone numbers, etc.

Reverse engineering, deobfuscation, and owner-operated read-only runtime tracing are research subjects.
Prohibited: write endpoint/transaction calls, saving secrets/PII/response bodies, and security-control bypass
such as disabling certificate pinning, hiding root/integrity detection, attestation spoofing, or repacking/re-signing.

## 1. Enumerable accounts and products

### Official Open API scope (explicitly listed by Bank of Kyoto)

Bank of Kyoto's [policy on cooperation with electronic payment service providers](https://www.kyotobank.co.jp/api/policy/)
lists personal subscriber API scope as follows.

| Function                             | Scope                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Balance inquiry                      | Ordinary deposits, savings deposits, time deposits, installment time deposits, foreign-currency ordinary deposits, investment trusts |
| Deposit/withdrawal statement inquiry | Ordinary deposits, savings deposits, foreign-currency ordinary deposits                                                              |
| Time deposit detail inquiry          | Time deposits, installment time deposits, foreign-currency time deposits                                                             |

For cash card holders' API requiring no advance registration, only ordinary deposit balances,
deposit/withdrawal statements, and transfers between same-name accounts are listed. Kogane does not use transaction APIs.

### Scope available in Kyogin Direct Banking / Kyogin app

- [Kyogin Direct Banking services](https://www.kyotobank.co.jp/kojin/directb/service/) separately list ordinary/savings deposit balances/statements, time/installment time deposits, foreign-currency ordinary/time deposits, investment trusts, personal loans, and card loans.
- Investment trusts have holdings, investment profit/loss, transaction history, withholding/refunds, and distribution history; treat them as a separate observation family from bank deposit transactions.
- [Kyogin app financial services](https://www.kyotobank.co.jp/kojin/kyoginapp/banking/) provide account balances/statements, Smart Passbook, time deposits, foreign-currency deposits, investment trusts, card loans, etc.
- `振替` ("account transfer") between ordinary/savings accounts, foreign exchange trading, time deposit placement/cancellation, investment trust trading, and loan borrowing/repayment are write transactions outside collector scope.

### Card boundary

- Merchant-level use, cancellation, sales confirmation, and billing statements for Kyogin JCB Debit/Kyoto Card Neo belong to a **separate MyJCB family PR**.
- Bank of Kyoto account withdrawals labeled `JCB デビット` ("JCB Debit"), `カード代金` ("card payments"), etc. are account debit observations displayed by the bank. Reconcile later with card-side observations; do not double count as card purchases.
- Do not invent merchants, card statement IDs, or confirmation dates from bank descriptions alone.

## 2. Statement granularity, periods, counts, and exports

### Ordinary/savings deposits (Web)

- The official service page and [FAQ K-000740](https://faq.kyotobank.co.jp/faq.asp?faqno=K-000740) give ordinary/savings deposit inquiry as, at most, the first day of the second preceding month through the inquiry date.
- Printing is the output route established from public Web material. Authenticated screens have not been checked for CSV/PDF downloads; do not assert their absence.
- According to [FAQ K-000685](https://faq.kyotobank.co.jp/faq.asp?faqno=K-000685), paid transaction statement applications at branches/in the app can specify dates within the preceding 10 years from the day before the request. This is an issuance application, not instant download; a read-only collector must not execute it.

### Kyogin Smart Passbook (app)

- [FAQ K-001734](https://faq.kyotobank.co.jp/faq.asp?faqno=K-001734) and [FAQ K-000938](https://faq.kyotobank.co.jp/faq.asp?faqno=K-000938) explicitly allow export of up to **1,000 recorded deposit/withdrawal entries** as CSV or PDF. Cover-only output is also possible.
- [FAQ K-000773](https://faq.kyotobank.co.jp/faq.asp?faqno=K-000773) says `通帳記帳` ("passbook recording") can redisplay up to 1,000 entries on a new device after changing phones.
- 1,000 is a storage/display row limit, not a guaranteed date range. Save CSV regularly as raw evidence with content hash, retrieval datetime, and source ID.
- CSV column names, encoding, and exact date/amount/balance/description schemas remain unverified until a synthetic sample without personal information or a user-explicitly-provided redacted sample is available.

### Foreign currency, time deposits, and investment trusts

- Foreign-currency ordinary deposits offer deposit/withdrawal statements; foreign-currency time deposits offer placement details. Initially after registering one's foreign-currency ordinary account, up to 6 months are available; coverage later expands to up to 13 months ([services](https://www.kyotobank.co.jp/kojin/directb/service/#content_service04)).
- Time/installment time deposits show `保有明細` ("holdings details"); separate their schema from ordinary deposit/withdrawal statements.
- Treat investment trust holdings/profit-loss/transaction history as separate endpoints/observations; do not mix valuations into deposit balances.

### Public NTT DATA AnserParaSOL API limits (not necessarily Bank of Kyoto-specific settings)

Bank of Kyoto explicitly outsources its API system to NTT DATA; its official personal Web login is also
AnserParaSOL. The [public NTT DATA AnserParaSOL API v1.10 specification](https://portal.opencanvas.ne.jp/wp-content/uploads/2026/02/ParaSOL-APISpec_v1.10.yaml)
includes the following transaction statement features.

- Transaction ID, state (normal/cancelled/missing number), transaction date, value date, transaction contents, deposit/withdrawal classification, amount, post-transaction balance, applied foreign exchange rate/handling, description, customer number.
- JSON, single response (`has_next=false`), specification maximum `count` of 9,999 entries.
- `date_from` / `date_to` selection. Online specification maximum is one year, but within one month is recommended; offline periods differ by financial institution.

These are shared platform specifications, not guarantees of Bank of Kyoto commercial settings, returned fields,
or actual limits. The previously described Web/app/foreign-currency coverage is what bank-specific public information establishes.

## 3. Authentication, OTP, devices, passkeys, and Bitwarden

### Established facts

- [Security measures](https://www.kyotobank.co.jp/kojin/directb/security/) use member number or branch/account number and login password, adding a secret phrase according to environment risk. Identity checks also use one-time passwords and registered phone number authentication.
- [One-time passwords](https://www.kyotobank.co.jp/kojin/directb/security/onetimepass.html) appear in Kyogin app or a dedicated OTP app, updating every 60 seconds. OTP is mandatory for one-off transfers, private-sector Pay-easy, Kotora transfers, address/phone changes, card/passbook reissuance, etc.
- Initial Kyogin app OTP setup authenticates through [My Number card signature certificate + NFC reading, or a call from the registered phone number](https://www.kyotobank.co.jp/kojin/directb/security/onetime_sp.html).
- The dedicated OTP app's biometric login combines device biometrics and OTP, allowing omission of member/account number and login password entry. This is an app feature; it is not described as WebAuthn passkeys.
- [FAQ K-000773](https://faq.kyotobank.co.jp/faq.asp?faqno=K-000773) says a new phone requires app/OTP registration and the old device becomes unusable. After starting OTP on the new phone, one-off transfers etc. require a 120-hour wait. This can be regarded as effective device binding.
- Bank of Kyoto explicitly instructs users not to save passwords etc. on smartphones, PCs, tablets, cloud servers, or network services.

### Separate unverified items and hypotheses

- **Passkeys:** Searching the official site/FAQ for `パスキー` ("passkey") did not establish support. WebAuthn registration/authentication ceremonies have not been observed; record publicly unverified rather than unsupported. App biometrics do not equal passkeys.
- **Bitwarden:** Login HTML has ordinary text/password fields, so autofill appears technically possible, but actual behavior is unverified. It also conflicts with the bank's explicit storage prohibition; Kogane's design does not recommend storing member/account numbers/login passwords in Bitwarden. OTP is a proprietary bank-app token; no evidence supports moving its seed to Bitwarden TOTP.
- **Device fingerprint:** It is established that unusual smartphone/PC/network environments are analyzed together to require secret phrases, but concrete fingerprint attributes and persistent cookie specifications are unpublished.

## 4. WAF / Akamai / anti-bot

Read-only observations on 2026-08-26:

- `www.kyotobank.co.jp` reached Akamai edge through `edgekey.net` → `akamaiedge.net` CNAMEs. Responses also included `AWSALB` / `AWSALBCORS` cookies, consistent with an AWS load balancer at origin.
- Ordinary GET to the [official site](https://www.kyotobank.co.jp/) returned 200. No Akamai Bot Manager sensor endpoints, challenge cookies, or CAPTCHA were observed on this public page. Akamai DNS alone does not establish WAF/Bot Manager enablement.
- The [unauthenticated Kyogin Direct Banking entry](https://www.parasol.anser.ne.jp/ib/index.do?PT=BS&CCT0080=0158) returned 200 from Apache with `Cache-Control: no-store`. Its public login form uses dynamic hidden state and POST to `BLI001Dispatch`. No CAPTCHA/explicit bot challenge observed in unauthenticated GETs.
- Login form `inputFrm013` uses `POST /ib/BLI001Dispatch?ServerID=RSRA0402&B=0158&PT=BS`, sending member number or branch/account type/account number, password, dynamic state, and `USERPREFS`. Public `prefs.js` collects browser, language, cookie availability, platform, screen, timezone, plugins/fonts, etc. to generate `USERPREFS`. There is no implementation basis for reusing only cookies and User-Agent.
- Public `acsionDetecker.js` loads `https://fp-js.detecker.com/v1/fp.js` as NTT DATA ACSiON Detecker integration, binding device fingerprint processing to login submission. `cafisBrain.js` loads `https://distribute.cafisbrain.com/cafisbrainriskcollector.js`, passing CAFIS Brain device token information to hidden fields.
- The PWC bundle loaded from `https://www.bank01.parasol.anser.ne.jp/` was packed; its string dictionary was statically expanded and formatted. Confirmed additional loading of timestamped `js/r.js`, retrieval of public keys for RSA encryption of login IDs and storage in bank-code-scoped `localStorage`, DOM/form/script/action metadata, hook/injection detection, risk result submission, and processing potentially reflecting returned tokens in hidden inputs/cookies. This is login protection, not an account read API; values/keys/tokens were not saved.
- Authenticated replay therefore requires observing at least dynamic state, risk collector-issued values, browser fingerprints, PWC public-key state, and session/cookie lifetimes/update order. Current evidence does not establish which are required for session/device binding or whether they update on each read request.
- Additional authentication/locks may occur after login, at unusual frequency, on failures, or in different environments. Successful public GETs do not establish automation feasibility.

## 5. Roles of official APKs, apps, and Web

| Surface              | Established role                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Collector perspective                                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Official Android app | Google Play package [`jp.co.kyoto.bankingappli`](https://play.google.com/store/apps/details?id=jp.co.kyoto.bankingappli&hl=ja&gl=JP), linked from the bank's [official app page](https://www.kyotobank.co.jp/kojin/kyoginapp/). Play metadata obtained on 2026-08-26: version **10.0.0**, update date **2026-02-19**, developer **THE BANK OF KYOTO, LTD.**. Provides account inquiries, Smart Passbook, CSV/PDF, transfers, OTP, account opening, My Number/NFC, smartphone ATM, etc. | Official manual CSV/PDF outlet. Use static/runtime analysis to distinguish native/WebView, read transport, local history storage, and export schemas. Do not touch OTP/device registration or other write surfaces |
| Official iOS app     | App Store ID [`1211133839`](https://apps.apple.com/jp/app/id1211133839)                                                                                                                                                                                                                                                                                                                                                                                                                | Same user-facing role as Android; not an automated collector runtime                                                                                                                                               |
| Web                  | [Kyogin Direct Banking](https://www.kyotobank.co.jp/kojin/directb/) leads to NTT DATA AnserParaSOL for accounts/statements/transactions                                                                                                                                                                                                                                                                                                                                                | CSV not established publicly; short-term inquiries and printing established. Unofficial HTML replay is fragile                                                                                                     |
| Official Open API    | JSON accounts/balances/statements/time deposits/investment trusts etc. for contracted electronic payment service providers                                                                                                                                                                                                                                                                                                                                                             | Most structured, but requires contract/review                                                                                                                                                                      |

### Official Android artifact acquisition status and reproduction procedure

Bank of Kyoto does not distribute APK files directly; Google Play is the official Android source. The research
environment lacked Android SDK/`adb`, `apkanalyzer`/`aapt2`/`apksigner`, `jadx`/`apktool`, and a connected owner
device, preventing legitimate acquisition of Play-delivered base/split APKs. Thus **signer fingerprints,
manifest, split composition, network security config, actual hosts, and pinning/integrity implementations
are undetermined**. Third-party APK mirror artifacts were not treated as official.

Reproduce without breaking the owner's existing registration:

1. Install/update Play `jp.co.kyoto.bankingappli` through the bank's official link on a compatible, non-root owner Android device. If OTP is registered, do not clear app data, reinstall, or migrate devices.
2. With owner consent, temporarily enable USB debugging; record only versionName/versionCode, installer, and split names from `adb shell dumpsys package jp.co.kyoto.bankingappli`. Pull base/splits returned by `adb shell pm path ...` into a private workspace only if ordinary device permissions allow it.
3. Check SHA-256 for all splits and signer digests via `apksigner verify --print-certs`, pairing them with package/version/installer. Keep binaries, certificates, and personal device information out of Git/CI; document only non-secret metadata and verification datetime.
4. Stop if pull is denied, the app stops, or OTP/device registration reset is requested. Do not use root, backup exploits, repack/re-sign, mirror substitution, or detection bypass.

### Static analysis after acquisition

- Check manifest permissions, exported components/deep links, `debuggable`/`profileable`, backup, FileProvider, NFC/biometrics/Keystore, native libraries, and network security config.
- Extract host/path templates, WebView, OkHttp/Retrofit and other clients, JSON/protobuf schemas, session issuance/renewal, and candidate cookie/bearer token storage from strings/call graphs. Do not handle actual secret/token values.
- Determine where Smart Passbook long-term history is kept (Room/SQLite/SQLCipher/DataStore etc.), with which account namespace/sync cursor/migration, and whether the 1,000-entry limit is in UI, local DB, or server.
- Check CSV/PDF renderers, encoding, MIME types, share intents/FileProvider, and column schemas. First establish what code/static resources reveal without generating/saving exports.
- Look for **candidates** for certificate pinning, root/debug/emulator detection, and Play Integrity/attestation. Public third-party [GrapheneOS compatibility report #928](https://github.com/PrivSec-dev/banking-apps-compat-report/issues/928) reports version 10.0.0/build 2026032000 works normally with no Play Integrity API, but this is one user's report, not static/traffic evidence; keep it unverified.

### Web and app read coverage

| Read target                                                 | Web                                                                                                       | App                                                      | Unverified                                                       |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| Ordinary/savings balances and deposit/withdrawal statements | Supported; public period is first day of second preceding month through today; printing available         | Supported; Smart Passbook maximum 1,000 entries, CSV/PDF | Web CSV/PDF/counts; app date periods/schemas                     |
| Historical ordinary/savings statements                      | Immediate inquiry limited to the above short period; paid 10-year statements require an application/write | Re-record up to 1,000 entries after changing devices     | Whether 1,000 is a server retrieval limit or local storage limit |
| Foreign-currency ordinary/time deposits                     | Supported; ordinary initially up to 6 months, later up to 13                                              | Officially described as supported                        | App periods/exports; native/API/WebView distinction              |
| Time/installment time deposits/investment trusts/loans      | Separate read surfaces; investment trust balances/profit-loss/history etc.                                | Each service officially described                        | Same transport or WebView navigation; export availability        |

### Owner-operated read-only runtime metadata observation

The owner operates the official app with existing working registration, limited to **displaying** account lists,
balances, statements, Smart Passbook, and export controls. If Android Studio Network Inspector can attach normally,
or ordinary proxy/PCAP/logcat can observe, immediately redact and record only method, origin, path template,
status, content-type, call order, and response schema field names. Do not save bodies, cookies/headers, tokens,
account IDs, or values. Even without `profileable`, metadata-only hooks on network clients, WebView navigation,
and DB-open using Frida/Objection etc. may be tested if the official unmodified app operates normally on the owner's device.

Stop on pinning, root/integrity/debug detection, app termination, extra authentication, or device re-registration.
Do not add CAs, disable pinning, hide root, spoof attestation, or repack/re-sign. Do not replay requests until
write/read side effects are classified; do not call write endpoints even after classification.

## 6. Concrete third-party client transport / auth

Bank of Kyoto's [API contracting party list](https://www.kyotobank.co.jp/api/agreement/api.html) includes
マネーフォワード (Money Forward), くふうカンパニー (Kufu Company), ソリマチ (Sorimachi), freee,
弥生 (Yayoi), SBI ビジネス・ソリューションズ (SBI Business Solutions), マネーツリー (Moneytree),
ミロク情報サービス (Miroku Jyoho Service), エメラダ (Emerada), TKC, and TIS. This is primary evidence
that the bank officially provides API connections.

Published AnserParaSOL v1.10 transport/auth:

1. Send users to bank authentication/consent through HTTPS `GET /parasol/v1/banks/{bank_code}/oauth/auth` with `response_type=code`, `client_id`, `redirect_uri`, `state`, and `scope=accounts`.
2. Send the redirected authorization code to `POST .../oauth/token`. Token endpoint uses client HTTP Basic authentication, `application/x-www-form-urlencoded` body, and `authorization_code` / `refresh_token` grants.
3. Data API uses `Authorization: Bearer ...`, JSON responses, and `GET .../accounts`, `GET .../accounts/{account_id}`, `GET .../accounts/{account_id}/transactions`, `GET .../term_deposits`, etc.
4. Returns access token validity seconds and refresh token expiry. `auto_manual_mode` distinguishes automatic renewal from user-operated renewal.
5. [Moneytree user guidance](https://help.getmoneytree.com/ja/articles/3701696-%E9%8A%80%E8%A1%8Capi%E3%81%AE%E5%88%A9%E7%94%A8%E6%96%B9%E6%B3%95%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6) likewise describes sending users to the bank Web, entering credentials there, and authorizing linking. It is not a method of passing bank passwords to a third party's own collector.

Caution: hosts in the public YAML are samples; Bank of Kyoto commercial API URLs, client credentials,
selectable scopes, and refresh periods are established by post-contract material.

GitHub code search on 2026-08-26 combining bank code `0158`, package, `BLI001Dispatch`, and ParaSOL hosts
found no bank-specific OSS client retrieving Bank of Kyoto statements. The discovered
[`asahi-shinkumi-auth-num-inputter`](https://github.com/icchi-h/asahi-shinkumi-auth-num-inputter) is an extension
entering specified user-number digits for another institution on the same `BLI001Dispatch` from Chrome storage,
not a balance/statement transport, Bank of Kyoto session, or export implementation. It illustrates third-party
code operating ParaSOL DOM, but does not establish stable Bank of Kyoto authentication replay. The GrapheneOS
report is a user app compatibility report, not a client implementation. Store-search spiders and bank code lists
are not account clients either.

## 7. Workers / Containers / OCI / Kubernetes suitability

| Method                               | Workers                                               | Cloudflare Containers                                                                               | OCI/Kubernetes                                                                              | Assessment                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Manual CSV/PDF → upload/import       | ◎ Suitable for upload API, R2, D1, parsers            | Unnecessary                                                                                         | Unnecessary                                                                                 | Keep authentication out of cloud; initial approach                                                                         |
| Contracted official Open API         | ○ HTTPS/OAuth/JSON fit                                | Usually unnecessary                                                                                 | Usually unnecessary                                                                         | Isolate client secrets/refresh tokens as source-scoped secrets. Confirm mTLS, fixed IP, HSM requirements after contracting |
| AnserParaSOL HTML browser automation | × Requires DOM browser and interactive authentication | △ Playwright possible, but profiles/OTP/extra authentication/risk collectors/maintenance are costly | △ Technically possible, operationally excessive                                             | Static JS researched; next observe owner-local-browser read-only bootstrap/replay boundary                                 |
| Android static/runtime research      | ×                                                     | × Legitimate splits and owner device required                                                       | △ Local Android toolchain containers can help, but device operations cannot move to cluster | Binary jadx/apktool etc. can run in containers/OCI; owner physical Android is first runtime candidate                      |
| Android UI automation                | ×                                                     | ×–△ Emulator, NFC/biometrics/device binding/integrity are barriers                                  | △ Emulators possible but high risk                                                          | D/cost 5; reassess only if read API replay remains infeasible after static/runtime evidence                                |

OCI/Kubernetes can run long-lived browsers/emulators and persistent volumes, but this establishes executability,
not suitability. Moving personal bank authentication secrets to an always-on cluster costs more and exposes
more attack surface than its benefits.

## 8. Automation assessment A–E / cost 1–5

Common assessment: A=documented/export API for scheduled headless use; B=stable read-only internal API with
renewable/reusable session; C=headless replay after browser/app bootstrap; D=full browser/device UI automation;
E=manual capture as safe default. Cost: 1=small, 5=contract/high maintenance/high risk.

| Candidate                                                                          | Automation | Cost | Assessment                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ---------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manually export Smart Passbook CSV to local importer                               | E          | 1    | Immediate recommendation; regularly save up to 1,000 entries                                                                                               |
| Passive metadata capture of manual Web/app viewing (excluding bodies/auth headers) | E          | 2    | Endpoint/schema discovery; immediately redact to method/origin/path template/status/field names                                                            |
| Kogane legitimately uses an official API provided by a contracted provider         | A          | 3    | Depends on vendor re-provided API, cost, and terms. Do not make an aggregator the initial route                                                            |
| Directly contracted Bank of Kyoto AnserParaSOL API                                 | A          | 5    | Best transport; registration/review/contracts as an electronic payment service provider are barriers for a personal project                                |
| Authenticated AnserParaSOL read replay                                             | C          | 4    | Need to check dynamic state, fingerprint/ACSiON/CAFIS Brain/PWC, secret phrases, OTP, session renewal, and UI changes. D if full browser operations remain |
| Read-only Android app transport replay after owner bootstrap                       | C          | 4    | No static/runtime evidence yet; C is not established without renewable/reusable sessions and read endpoints                                                |
| Full Android app device/UI automation                                              | D          | 5    | Requires maintenance for device binding, NFC/biometrics, OTP, store updates, integrity/pinning candidates. Research subject, not safe default              |

## 9. Read-only live verification plan and stop conditions

### Permitted verification

1. User checks official URLs/certificates and logs in themselves. Agent receives no secrets.
2. On Web in an ordinary browser, record only method, origin, path template, status, content-type, redirect/call order, hidden field names, cookie names/attributes per navigation before/after login. Exclude values, request/response bodies, cookies/tokens, and account IDs from DevTools saves/HARs. Check issuance/renewal order of `S`/`USERPREFS`, ACSiON, CAFIS Brain, and PWC seen in public JS, and whether read navigation uses POST.
3. On Android, first obtain legitimate splits and analyze statically as above; on the owner's registered device, operate only displays of account lists/balances/statements/Smart Passbook/export controls. Network/DB/WebView hooks are metadata-only; save no app bodies/local DB/screenshots.
4. For each Web/app read surface, record only names/nullability of fields for pending/posted, cancellation/correction, post-transaction balance, description, and page/cursor/date/count. If schema samples with values are needed, use synthetic fixtures or separately user-prepared fully redacted samples.
5. Do not execute exports in this research; check control labels, formats, and UI maximum counts/periods. Build CSV parsers using public FAQs and synthetic fixtures; actual schemas remain provisional until redacted samples are available.
6. Before an official API contract, use only public simulators/specifications; do not guess Bank of Kyoto commercial endpoints.

### Immediate stop

- Screens asking the agent to enter/display/send login IDs, account numbers, passwords, secret phrases, OTPs, My Number passwords, cookies, authorization codes, access/refresh tokens.
- OTP activation/deactivation, device re-registration, app account registration, external service linking consent, Smart Passbook switching.
- Confirmation screens or writes for transfers/account transfers, Pay-easy, Kotora, foreign-currency/time deposit/investment trust/loan transactions, address changes, reissuance, paid transaction statements, etc.
- CAPTCHA, Akamai/other challenges, additional secret phrases, lock/failure-count warnings, unusual-environment warnings. Do not bypass/retry.
- Android certificate pinning, root/debug/emulator/integrity detection, extra device registration, OTP reset, app data clear/reinstall requests. Do not proceed to CA addition, pinning disablement, root hiding, attestation spoofing, repack/re-sign.
- Semantically unknown POSTs. AnserParaSOL may use POST for read-only navigation; stop until screen wording and operation meaning are clear, rather than relying on HTTP method alone.
- Risk of retaining PII/balances/statements in captures, console, logs, Git, CI artifacts, or R2/D1.

## Unverified items

- Authenticated Web CSV/PDF downloads, rows per display, exact HTML/JSON read navigation transport, and lifetimes/renewal conditions of sessions/cookies/state/risk tokens.
- Smart Passbook CSV columns, encoding, line endings, duplicate IDs, cancellation/correction representation, post-transaction balances.
- Bank of Kyoto commercial Open API hosts, bank-specific statement periods/counts, returned optional fields, refresh token periods, IP allowlist/mTLS requirements, pricing.
- Passkey/WebAuthn support; not established on public sites/FAQs.
- Logged-in WAF/anti-bot/rate limits and Akamai security modules beyond CDN. Public JS established ACSiON/CAFIS Brain/PWC, but each value's binding/renewal is unverified.
- Kyogin app 10.0.0 signer fingerprints, splits/manifest, hosts/paths/schemas, local long-history storage, session issuance/renewal, certificate pinning, integrity/attestation. Not analyzed because no official standalone APK, Play-installed owner device, or Android toolchain was available. The above `dumpsys`/`pm path`/all-split pull/`apksigner`/jadx/runtime metadata observation is the next concrete experiment.
- Web/app read coverage differences, especially whether foreign-currency/time deposits/investment trusts/loans use native APIs, embedded WebViews, or external browsers; app CSV/PDF schemas/MIME/renderers.

## Main primary sources

- [Bank of Kyoto: Kyogin Direct Banking services](https://www.kyotobank.co.jp/kojin/directb/service/)
- [Bank of Kyoto: Kyogin app financial services](https://www.kyotobank.co.jp/kojin/kyoginapp/banking/)
- [Bank of Kyoto: Kyogin app (official Play link)](https://www.kyotobank.co.jp/kojin/kyoginapp/)
- [Google Play: Kyogin app](https://play.google.com/store/apps/details?id=jp.co.kyoto.bankingappli&hl=ja&gl=JP)
- [Bank of Kyoto: security measures](https://www.kyotobank.co.jp/kojin/directb/security/)
- [Bank of Kyoto: one-time passwords](https://www.kyotobank.co.jp/kojin/directb/security/onetimepass.html)
- [Bank of Kyoto: API cooperation policy/features](https://www.kyotobank.co.jp/api/policy/)
- [Bank of Kyoto: contracted electronic payment service providers](https://www.kyotobank.co.jp/api/agreement/api.html)
- [NTT DATA OpenCanvas: AnserParaSOL API list](https://portal.opencanvas.ne.jp/api/parasolapilist/)
- [NTT DATA OpenCanvas: AnserParaSOL API v1.10 OpenAPI](https://portal.opencanvas.ne.jp/wp-content/uploads/2026/02/ParaSOL-APISpec_v1.10.yaml)
- [GrapheneOS banking-apps compatibility report: Kyogin app #928 (third-party observation)](https://github.com/PrivSec-dev/banking-apps-compat-report/issues/928)

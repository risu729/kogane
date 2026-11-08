# 三井住友銀行 (Sumitomo Mitsui Banking Corporation): the bank-account side of SMBCダイレクト (SMBC Direct) / Olive

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26; follow-up: 2026-08-31; implementation verification: 2026-09-01

This document records the initial research and follow-up. For implementation status, give precedence to “Kogane Workers PoC live result (2026-09-01)” below and the [current PoC README](../../services/collector-smbc-direct/README.md). The documentation consolidation on 2026-09-05 checked consistency with existing implementation and verification records. It did not log in to the bank again or collect data.

## Conclusion

- **The recommended source is the official SMBCダイレクト (SMBC Direct) website**. For the ordinary-deposit MVP, the shortest route is to call the forms and JSON endpoints used internally by the official website, read-only.
- **Olive is not a separate banking API**. Its bank-account side is a package that includes SMBCダイレクト and Web通帳 (Web passbook); use the SMBCダイレクト account list and statements as authoritative rather than Olive-specific screens.
- `provider-smbc-direct` in `pnsk-lab/mnie` implements app-approved login, balance, date-range transaction statements, and session reuse for one ordinary-deposit account. Drawing on this research, Kogane has implemented a Worker PoC that isolates the necessary reads without making `mnie` a runtime dependency.
- In the real-account follow-up on 2026-08-31, ordinary WSL `fetch` and a cookie jar alone successfully handled login after Safety Pass approval, one account’s JPY balance, 14 statement rows and deposit/withdrawal totals for 2026-08-01 through 08-31, and logout. Neither a browser nor TLS fingerprint spoofing was needed. The two earlier failures were timing issues from calling `finished2fa` before approval completed, not Akamai, service hours, or rejected credentials.
- The Worker PoC on 2026-09-01 verified collection of 93/93 months through TAMIA and resumption through renewed QR approval after expiry midway. Ordinary Workers egress returned `ERRINFO` under the same conditions, so do not generalize local success to ordinary Workers egress.
- Contracts registered for SMBCセーフティパス (SMBC Safety Pass) require biometric authentication on the registered device **for every login**. The current automation outlook is therefore **collection after human QR/app approval can be automated; login again after expiry requires a person**.
- Safety Pass includes bank acceptance of registration, the association between the subscriber number and registered device, and deregistration/expiry state. Static analysis of the Android 12.8.0 candidate confirmed an implementation that generates an EC private key in `AndroidKeyStore` with the contract ID as its alias, then signs each server challenge after biometric authentication through `BiometricPrompt.CryptoObject`. There is no private-key export, and copying profile/app data cannot migrate it.
- Akamai edge use was confirmed for login-side `direct.smbc.co.jp` and transaction-side `direct3.smbc.co.jp`. Bot Manager-style protection is also likely, but the specific WAF policy and decision conditions on authenticated endpoints remain unconfirmed.
- An official personal-account API exists, but it serves contracted electronic payment intermediary providers. No public route was found for an individual developer to issue a token directly for their own account. This project avoids aggregators and does not adopt it.
- The existing Money Forward ME account checked as an auxiliary route already had API links for SMBC yen and foreign currency. Using its existing Bitwarden passkey obtained through `bw get item` in WSL, browserless Money Forward ID login and authenticated `/me` retrieval succeeded. The policy of avoiding aggregators remains, but a working fallback exists if fully unattended operation takes priority.

Overall assessment: **ordinary-deposit MVP implementation cost 3/5; robust implementation covering multiple account types 4/5; outlook for fully unattended login 1/5; automated collection after human approval 4/5**.

## Scope and non-goals

The scope is limited to routes that read the owner’s 三井住友銀行 accounts through the official website or app.

- In scope: SMBCダイレクト, 三井住友銀行アプリ (SMBC banking app), and the **bank-account side** of Olive accounts
- Candidate data: account list, balances, transaction statements, and deposit details for time deposits, foreign currency, and similar products
- Non-goals: Vpass, Oliveフレキシブルペイ (Olive Flexible Pay) card statements, links to other banks or securities, bank transfers, account transfers, settings changes, and aggregation through electronic payment intermediary providers
- Safety boundary: read-only. Do not even navigate to transfer-related screens unnecessary for collection, such as recipients or transfer-fee calculations. Static analysis of official split APKs/public JS, runtime metadata observation while the owner operates the unmodified official app, and evaluation of the difficulty of reproducing an independent client are in scope; secret extraction, credential/signature/attestation forgery, and pinning/integrity bypass are not

The initial research on 2026-08-26 did not log in or obtain an APK. The follow-up on 2026-08-31 performed read-only login with the owner’s Safety Pass approval, balance retrieval, one month of statements, deposit/withdrawal totals, and logout, and statically analyzed a third-party redistributed APK candidate offline. Credentials, cookies, challenges, authenticated HTML, balances, statement contents, deposit/withdrawal total values, account numbers, names, and other personal data were neither saved nor committed. APKs and JADX artifacts are retained only in a private archive; this repository contains only sanitized conclusions.

## Research method

1. Checked 三井住友銀行’s official website, official FAQs, and official Google Play listing. Rechecked the package, developer, and update date on Google Play’s public surface.
2. On 2026-08-26, read unauthenticated DNS/HTTP headers, public login HTML, and versioned JavaScript, formatted them with Prettier, and examined route/session/form-token/Caulis/RSA-AES support assets. No login POST was made.
3. Searched public clients through GitHub Code Search and reviewed `pnsk-lab/mnie` at commit `c87e65c0a04c03c560962f8ead6e77415fb841f4`.
4. Treated old Selenium/Mechanize implementations only as references to historically available routes, not evidence of current operation.

## Official entry points and collection granularity

### SMBCダイレクト Web

- Entry: [SMBCダイレクト](https://www.smbc.co.jp/kojin/direct/) → [Web login](https://direct.smbc.co.jp/aib/aibgsjsw5001.jsp)
- Login ID: branch number and ordinary-deposit account number, or subscriber number, together with the login PIN
- Account list: displays ordinary, savings, current, time-deposit, foreign-currency, investment-trust, mortgage, and other accounts registered for the service. [Official account-inquiry help](https://www.smbc.co.jp/direct/sousa/help_kouza/4.html)
- Deposits and withdrawals appear in balances/statements immediately after they are reflected in the account. [Official balance/statement help](https://www.smbc.co.jp/smartphone/help/help_kouza/10.html)
- Web通帳 transaction statements can be downloaded as CSV. **三井住友銀行アプリ has no CSV download function**. [Official FAQ](https://qa.smbc.co.jp/faq/show/720?site_domain=default)

### 三井住友銀行アプリ

- Official Android app: [Google Play](https://play.google.com/store/apps/details?id=jp.co.smbc.direct), package `jp.co.smbc.direct`
- The official client exposes some SMBCダイレクト functions through a native UI, combining account lists, balances, transaction statements, SMBCセーフティパス, and one-time passwords. [Official feature list](https://www.smbc.co.jp/kojin/spaplli/directapp/)
- The app supports balance inquiries for ordinary, savings, current, time-deposit, installment-savings, foreign-currency ordinary, personal foreign-currency time-deposit, investment-trust, employee asset-formation savings, and card-loan accounts. Transaction statements explicitly cover ordinary, savings, current, and card-loan accounts.
- The app is convenient for a person’s everyday checks, but device binding, biometric authentication, and restrictions on rooted devices and USB debugging make it unsuitable as the primary route for server automation.

### Difference from Olive

An Olive account is a package combining ordinary deposits or balance-tiered-interest ordinary deposits, SMBCダイレクト, Web通帳, SMBC ID, Oliveフレキシブルペイ, and other services. Bank-account balances and transaction statements appear in SMBCダイレクト and 三井住友銀行アプリ, so there is no reason to implement a separate Olive-specific protocol for bank-account collection. [Official SMBCダイレクト guide](https://www.smbc.co.jp/kojin/direct/)

SMBCダイレクト displays eligible Olive ordinary deposits as `残高別普通` (“balance-tiered ordinary deposit”), `残高別普通（総合）` (“balance-tiered ordinary deposit, comprehensive account”), and similar labels. [Official account-inquiry help](https://www.smbc.co.jp/direct/sousa/help_kouza/4.html) Kogane needs stable account IDs derived from branch, account, and account-type codes rather than display names.

## Statement granularity and history periods

The displayed scope differs between normal service hours and the restricted period from Sunday 21:00 to Monday 07:00. During the restricted period, only ordinary, savings, current, and card-loan accounts as of Sunday 21:00 are shown, covering up to 2 months/300 rows from the first day of the previous month. [Official service hours](https://www.smbc.co.jp/kojin/direct/jikan/)

| Account type                        | Collection granularity                                                                                                                    | Normal history/limit                                                   | Notes                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Ordinary deposit / Web通帳          | Current balance, date, deposit/withdrawal amount, description, post-transaction balance                                                   | From 2019-01-01. Up to 30 years, 2,000 rows per inquiry                | All rows can be collected by splitting into shorter periods. Without a range, only the current and previous months       |
| Ordinary deposit / paper passbook   | Same as above                                                                                                                             | From the first day 24 months ago. Up to 25 months, 300 rows            | Earlier records are issued at a branch for a fee                                                                         |
| Savings / current / card loan       | Balance, transaction statements                                                                                                           | Current FAQ: from the first day of the previous month                  | Older account-inquiry help also says 30 years for Web通帳 savings in a comprehensive account; needs a real-account check |
| Foreign-currency ordinary deposit   | Current balance by currency, date, deposits/withdrawals, description, post-transaction balance, and applicable rate under some conditions | From the first day 3 months ago through today; up to 4 months/300 rows | CSV available. Counterparty/product information may be omitted for cross-currency transfers or foreign remittances       |
| Time deposits / installment savings | Account balance, deposit details, installment-savings details                                                                             | No uniform history-retention period found in public help               | Best modeled as deposit lots/maturity information rather than transaction-event rows                                     |
| Investment trusts                   | Balances/transaction statements                                                                                                           | From the first day of the same month in the previous year              | Outside this research’s implementation scope, but may appear in the account list                                         |

The main basis for these periods is the [official FAQ](https://qa.smbc.co.jp/faq/show/1468?site_domain=default) published on 2026-01-15. Foreign-currency granularity and limits come from the [official foreign-currency transaction-statement help](https://www.smbc.co.jp/direct/sousa/help_gaikatorihiki/49.html); time deposits from the [official service list](https://www.smbc.co.jp/direct/sousa/help_teiki/2.html).

The granularity expected from ordinary-deposit CSV/internal JSON is ample for household-finance data, but descriptions are bank display strings and do not necessarily contain complete structured information about transfer counterparties or purchased products. Save raw responses and displayed descriptions unchanged; normalize downstream.

## Authentication and sessions

### SMBCセーフティパス

- Registering SMBCセーフティパス makes biometric authentication on the registered device mandatory at login.
- In the app on that registered device, biometric authentication starts when the app opens.
- From a PC or another device’s website, scan the QR code with the registered device, perform two approvals and biometric authentication in the app, then complete the operation in the original browser.
- Login from any device other than the registered device requires the registered device **every time**. [Official login procedure](https://www.smbc.co.jp/kojin/direct/securi/safetypass/login/)
- Initial registration/deregistration uses SMS, identity-document reading, and similar steps. SMS is not authentication used for each normal scheduled collection. [Official registration procedure](https://www.smbc.co.jp/kojin/direct/securi/safetypass/touroku/)
- Changing phones or the device’s biometric information requires deregistration and re-registration. [Official phone-change procedure](https://www.smbc.co.jp/kojin/direct/securi/safetypass/kishuhenko/)

The traditional one-time password cannot be combined with SMBCセーフティパス and is mainly for important transactions such as bank transfers. Deregistering Safety Pass to favor credential-only read login is not recommended: it reduces security and has no guarantee of continued use under the current specification.

### Official Safety Pass registration/expiry specification

The following can be established from the official procedures and [SMBCダイレクト terms of use](https://www.smbc.co.jp/kojin/direct/pdf/directkitei.pdf?version=260401).

- Registration starts in 三井住友銀行アプリ and completes after agreement to the terms, on-device biometric authentication, and identity verification. Verification options are SMS (roughly 2 minutes) or IC reading of a My Number card/driver’s license plus a facial photo (roughly 5 minutes). [Official registration procedure](https://www.smbc.co.jp/kojin/direct/securi/safetypass/touroku/)
- The bank accepts the application and associates the SMBCダイレクト subscriber number with the device used to register. Biometric information is neither sent to the bank nor stored on its server. Matching uses the device’s biometric authentication function.
- Login on the registered device uses its biometric authentication. On a PC/other device, open the browser’s QR code or app link on the registered device; the owner checks and approves the displayed contents and authenticates biometrically, then completes login in the original browser. [Official login procedure](https://www.smbc.co.jp/kojin/direct/securi/safetypass/login/)
- Changing phones requires deregistration on the old device and re-registration on the new one. If the old device is unavailable, use the official deregistration procedure with identity verification from the new device. [Official phone-change procedure](https://www.smbc.co.jp/kojin/direct/securi/safetypass/kishuhenko/)
- Changing device biometrics such as Face ID/Touch ID also requires deregistration and re-registration. [Official biometric-change procedure](https://www.smbc.co.jp/kojin/direct/securi/safetypass/seitaihenko/)
- If the registered device is available, deregister in the app; this forces logout. Otherwise, deregistration routes use identity-document IC reading and a facial photo (roughly 5 minutes), document images/SMS/facial photo (roughly 5 business days), or SMS (roughly 5 minutes). After SMS deregistration, some functions such as bank transfers are restricted for about 1 week. [Official deregistration procedure](https://www.smbc.co.jp/kojin/direct/securi/safetypass/kaijyo/)

Safety Pass is therefore an authentication mechanism comprising at least **bank-accepted registration, the association between subscriber number and registered device, and deregistration/expiry state**, rather than merely a local biometric screen. Deregistration/re-registration changes settings and is not performed in this research or read-only implementation verification.

### Safety Pass internals: static analysis on 2026-08-31

#### Confirmed facts

- The terms explicitly state that biometric matching happens on the device and biometric information itself is neither sent to nor stored by the bank.
- The bank has state managing acceptance of applications, subscriber-number/registered-device associations, and deregistration/expiry.
- For PC/other-device login, the user checks information displayed on the registered device and approves through the bank’s prescribed procedure and biometric authentication.
- In `mnie`’s public code, the website-generated `userId`, `confirmationNumber`, and `createdTime` are passed to the `smbcdirectapp:///biometrics/ADBA` deep link; the Web completion step follows approval in the official app.
- The official listing explicitly says devices with a history of rooting may not work correctly and the Android app will not launch with USB debugging enabled.
- The Android 12.8.0 candidate contains `BioPreConfirmationREQ/RES`, `BioLoginREQ`, and `BCATA01/02/03`, which make up the current QR approval and biometric-login flow.
- `NewBioLoginApprovalFragment` receives a server challenge, calls `BiometricUseCase.doSignature`, and passes the signed data to the result API.
- `BiometricUseCase` generates an EC signing key in `AndroidKeyStore` with the contract ID as its alias and exports only the public key. There is no private-key export operation.
- The key requires user authentication; the reconstructed call for Android 11 onward corresponds to `setUserAuthenticationParameters(0, BIOMETRIC_STRONG)`. The signing `Signature` is passed to `BiometricPrompt.CryptoObject`, and the challenge is signed after successful biometric authentication.
- Deletion/re-registration paths also exist for changes to biometric enrollment and key invalidation. Copying app data, a browser profile, or just the public key to another device/server therefore cannot reproduce approval.
- The app also includes separate Transmit Security pre/post login, attestation payloads, and root detection. An emulator approach must handle the device-integrity layer as well as the biometric UI and is no shortcut to moving this to Workers/Containers.

Unconfirmed points are whether the key is hardware-backed by TEE/StrongBox, the canonicalization and algorithm of signed data, the server-side public-key registration payload, strict challenge expiry/one-time use, and conditions applying Transmit attestation. These refine the binding details rather than determine whether an independent client can be fully unattended.

### Initial design and further research: boundaries for supporting legitimate approval and studying reproduction

The initial research recommended an **orchestrator supporting legitimate session issuance through the unmodified official app and the owner’s approval**. QR display, continuation after approval, encrypted session storage, and resumption after expiry are implemented in the Worker PoC; the following records the design at that time and the boundary for further research.

1. Initiate a normal login request to the official website.
2. Display the bank-issued QR/deep link, expiry, and target login to the user unchanged.
3. The user checks the displayed contents in the official app on the registered device, authenticates biometrically, and approves.
4. Poll completion at the bank-prescribed interval and receive only the legitimately issued Web session after approval.
5. Store the session encrypted and use it only for allowlisted balance/statement read endpoints. Request human approval again on expiry.

This approach does not automatically enter biometric authentication, extract registered-device credentials, forge/replay challenges, bypass device attestation, or register/deregister Safety Pass. **Implementing** those is prohibited, but studying the standard APIs, signed data, device binding, session handoff, and difficulty of reproducing an independent client through the official APK and normal runtime is not prohibited.

Future research separates facts, inferences, and gaps as follows.

| Topic                 | Current facts                                                        | Next checks                                                                                             | Implication for difficulty                                                                                             |
| --------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Biometrics            | Biometric matching happens on the device                             | Call sites such as `BiometricPrompt`/CryptoObject                                                       | Reproducing the UI is relatively easy if only standard APIs are involved, but key-use conditions remain                |
| Credentials/keys      | The bank associates the subscriber number with the registered device | Keystore aliases, key generation/import support, hardware-backed/StrongBox, server registration payload | Non-exportable keys or required existing server registration make migration to another client difficult                |
| Challenge/signature   | Deep link contains `userId`, `confirmationNumber`, `createdTime`     | Nonce, canonicalization, signature algorithm, expiry, one-shot/replay handling                          | Even with a public challenge, transport imitation alone is insufficient if the registered key’s signature is mandatory |
| App-to-Web handoff    | Web completion/JSESSIONID change after official-app approval         | Poll endpoint, approval-state schema, session rotation/cookie scope                                     | An owner-approval orchestrator may work; fully unattended operation is a separate matter                               |
| Integrity/attestation | Official listing restricts rooting history/USB debugging             | Play Integrity/SafetyNet/custom SDK, where attestation is attached to requests                          | Server-required attestation makes an independent client difficult                                                      |
| Pinning               | Unconfirmed                                                          | Manifest network config, OkHttp/Cronet/WebView/native trust code                                        | Presence can be checked even if pinning exists. Do not disable it; fall back to metadata observation                   |

#### Staged verification plan

| Stage                                                 | Content                                                                                                                                                                                  | Expected cost | Risk        | Success criterion                                                                                                      | Stop/fallback conditions                                                                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------: | ----------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Model documentation/public code as state machines  | Diagram registered/unregistered state, challenge issuance, awaiting approval, session issuance, and expiry from official procedures, terms, and `mnie`                                   |           1/5 | Low         | Can explain Web/app responsibilities, unknowns, and the read-only boundary                                             | None. No personal information used                                                                                                                            |
| 1. Static analysis of a signature-verified APK        | Inventory manifest, deep links, exported components, hosts, network security config, obfuscation/native libraries, Keystore APIs, and references to Play Integrity/App Attest-style SDKs |         2–3/5 | Low–medium  | Identify component/protection “candidates” and update facts/inferences                                                 | Signature/provenance cannot be checked against Play distribution, or private-key/token extraction becomes necessary                                           |
| 2. Black-box observation on a normal physical device  | The owner operates the unmodified official app, logging in only to their own account. Record deep-link transitions, displays, times, expiry, retries, and before/after session issuance  |           3/5 | Medium      | Reproduce challenge lifetime, awaiting-approval state, and session transition without settings changes or transactions | Registration/deregistration, biometric-settings changes, or navigation to transfer/settings screens becomes necessary                                         |
| 3. Kuebiko/passive proxy observation                  | Observe DNS/TLS destinations and request timing; examine HTTP sequence only if the app normally accepts user CAs                                                                         |         3–4/5 | Medium      | Understand request order from login challenge to session issuance                                                      | Stop when blocked by pinning/integrity/anti-debug. Do not proceed to disabling pinning, hooks, root, Frida, trust-manager modification, or attestation bypass |
| 4. Legitimate-approval orchestrator                   | QR/deep-link display, user notification, bounded polling, encrypted post-approval session storage, read-endpoint execution                                                               |           3/5 | Low–medium  | Obtain a session only after owner approval in the unmodified official app and read only balances/statements            | Unattended operation proves to require credential extraction, challenge replay/forgery, or protection bypass                                                  |
| Independent-client reproduction difficulty assessment | Evaluate standardization/device binding of registered credentials, signed challenges, attestation, and session handoff from actual artifacts                                             |         4–5/5 | Medium–high | Classify standard mechanisms, server-bound state, and nonportable elements with evidence                               | When secret extraction, forgery, or pinning/integrity/attestation bypass becomes necessary, record observations without implementing it                       |

APK static analysis reveals declared components, strings/hosts, SDK references, network security settings, Keystore API usage, and similar details; it does not reveal hardware-backed private keys, actual bank-side registration state, or server risk rules. With obfuscation, the mere presence of references must not establish which method is adopted.

Physical-device observation and Kuebiko/passive proxies can investigate app lifecycle, deep-link routing, destinations, request order, and session changes before/after approval. This is limited to normal devices, the unmodified app, owner operation, and read-only login. If certificate pinning prevents viewing contents, record that result and stop. Do not adopt methods amounting to device forgery/modification prohibited by the terms, third-party approval, or approval without checking the displayed contents.

Operational implementation succeeds when it **reliably receives a legitimately issued session and safely hands it to reads while retaining human approval in the official app**. Research has a separate success criterion: explain which of server-bound keys, attestation, pinning, and session issuance use standard mechanisms, which bind to the device/bank registration, and which authority and experiments are missing for independent-client reproduction. Confirmed binding does not end research; record it as evidence of difficulty without bypassing it.

### Session reuse

`mnie` can export/import authenticated cookies and top-page form state, and update form tokens by navigating to the account list. This strongly supports multiple collections within a session approved once. The following remain unconfirmed.

- Server-side session lifetime when idle
- Maximum lifetime with keep-alive
- Reauthentication conditions after changes to IP, TLS fingerprint, User-Agent, or region
- Reuse across dates, after container restarts, or through shared egress such as Cloudflare

The official site explicitly says SMBCダイレクト may be suspended for `本来想定された利用形態と異なる極端な利用` (“extreme use differing from the originally intended usage”). Avoid continuous keep-alive; assume infrequent synchronization and human reapproval after natural expiry. [Official SMBCダイレクト guide](https://www.smbc.co.jp/kojin/direct/)

The initial proposal envisioned a minimal session capsule excluding authenticated top HTML, but the current PoC’s `export()` returns cookies and the top-page HTML/URL needed for continuation, encrypted with AES-256-GCM and stored in a Durable Object. The login PIN is excluded from the session and read from a Worker secret; authenticated HTML and cookies are not exposed in logs or public responses. Operations within one session are serialized; on expiry, partial results are saved and resumed after new QR approval. On completion, official logout runs and the stored session is deleted. Reducing HTML to minimal form state remains an additional design task, not an implemented feature. Continuous keep-alive is not performed.

## Akamai / anti-bot

### Confirmed facts

Unauthenticated observations on 2026-08-26 confirmed the following.

- `direct.smbc.co.jp` and `direct3.smbc.co.jp` each resolved through `*.edgekey.net` to `*.akamaiedge.net`.
- `https://direct.smbc.co.jp/aib/aibgsjsw5001.jsp` returned HTTP 200 to a single GET with an ordinary browser User-Agent.
- The response included `X-Akamai-Transformed` and `AKAMAI` headers and `_abck`/`bm_sz` cookies.
- The public login HTML was Shift_JIS; a single unauthenticated GET displayed no JavaScript challenge or CAPTCHA.
- Public login issues `JSESSIONID` (`Secure; HttpOnly`), `DIRECTUUID`, and hidden `_TOKEN`/`_FORMID`/`_FRAMEID`, using `/loginlogout/LLDLDILnextPreTS` as a login pre-step. Cookie/token values were not saved.
- The login page loads [Caulis](https://static.fraud-alert.net/Caulis.smbc_v2.min.js); that asset includes `p.fraud-alert.net`/`sb.fraud-alert.net`, a local session ID, and CORS/XHR sending. It also dynamically loads public [RSA](https://ib.smbc.co.jp/js/rsa.js), [AES](https://ib.smbc.co.jp/js/aes.js), and [password-loader](https://ib.smbc.co.jp/js/pwcload.js) assets from `ib.smbc.co.jp`. Session, anti-bot/risk, and credential protection exist as separate layers before Safety Pass.
- In the real-account follow-up on 2026-08-31, login after Safety Pass approval succeeded from WSL/Linux with only Node-style ordinary `fetch`, a cookie jar, and a Linux Chrome-style User-Agent. One account was authenticated; its current JPY balance was retrieved, and 14 date-range statement rows for 2026-08-01 through 08-31 and separate deposit/withdrawal totals could be parsed as numbers. Official logout also succeeded at the end. Actual amounts, statement contents, and account identifiers were not recorded.
- The two earlier attempts failed at completion after QR approval because the call equivalent to `finished2fa` preceded completion of approval on the registered device. The same HTTP client passed on retry after waiting for completed approval, so these failures are not evidence of Akamai decisions, normal service hours, or credential rejection. Implementation needs bounded polling that retains the awaiting-approval state or an explicit user completion action, rather than a fixed sleep.
- These follow-ups used no browser execution, Akamai sensor generation, TLS fingerprint spoofing, or residential egress.

Akamai CDN/edge use is therefore confirmed. Akamai provides Bot Manager mechanisms that identify automated requests using cookies and browser telemetry. [Akamai Bot Management docs](https://techdocs.akamai.com/security-ctr/docs/dimensions-new)

### Inferences and unknowns

- The combination of `_abck` and `bm_sz` makes it likely that Akamai Bot Manager or related automation detection is enabled.
- However, specific WAF/Bot Manager actions on login POSTs or authenticated AJAX, rate limits, and data-center IP evaluation cannot be established externally.
- Failure through ordinary Workers egress and success through TAMIA were verified in the PoC below. Other Containers/OCI egress, long-term decisions, and reactions to IP/session migration remain unconfirmed.

## APK and static analysis

The official public distribution route is Google Play; no standalone APK distributed directly by the bank website was found. The [official Play page](https://play.google.com/store/apps/details?id=jp.co.smbc.direct) displayed package `jp.co.smbc.direct`, developer `SUMITOMO MITSUI BANKING CORPORATION`, and update date 2026-08-12.

On 2026-08-31, a third-party APKPure redistribution candidate for 12.8.0 (`versionCode 593`) was obtained and statically analyzed without execution. The base, ARM64, and MDPI splits verified with v2/v3 signatures from the same SMBC signer. Google source-stamp metadata existed but was not verified by local `apksig`; byte identity with the current Google Play distribution remains unconfirmed. Retain this provenance limitation and do not treat it as an official artifact for execution.

JADX 1.5.6 processed 28,925 classes with 514 errors and generated 34,920 source files. Safety Pass DTOs, QR approval fragments, Keystore/BiometricPrompt signing use cases, Transmit Security pre/post login, attestation payloads, and root detection were readable. apktool 2.7.0-dirty produced extensive errors decoding the target SDK 36 resource table and was stopped; its partial tree was not retained as an artifact.

The candidate XAPK, split hashes, signer, reconstruction/reanalysis procedures, and JADX output are saved under `android/smbc/12.8.0/` in private `risu729/android-app-decompiled`. They contain no credentials, authenticated traffic, or account data. The next provenance improvement is to `adb pull` the Play-distributed splits from the owned device and compare version, hashes, and signer with the candidate.

## 3rd party client

### Assessment of `pnsk-lab/mnie`

Reviewed: [`provider-smbc-direct/src/index.ts` at `c87e65c`](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-smbc-direct/src/index.ts)

Implementation:

1. GET the public login page and extract the form’s frame ID, tokens, and similar fields.
2. POST the branch number, account number, and login PIN to the SMBC Direct form and decode the Shift_JIS response.
3. Build a `smbcdirectapp:///biometrics/ADBA` deep link/QR from `userId`, `confirmationNumber`, and `createdTime` in the response.
4. After user approval in the official app, POST completion and check that `JSESSIONID` changes.
5. Maintain the top page’s `_TOKEN`, `_FORMID`, and cookie jar, and call the official website’s internal AJAX.

Currently obtainable:

- The one ordinary-deposit account used for login
- Current JPY balance
- Transaction statements for arbitrary start/end dates
- Statement ID, date, deposit/withdrawal amount, post-transaction balance, description, and deposit/withdrawal type
- Total deposits and total withdrawals within the period
- Authenticated-session export/import and refresh by navigating to the account list

Limitations and points to fix in Kogane:

- Fixed to one ordinary-deposit account and default account-type code `2206` observed in a HAR; multiple accounts, time deposits, and foreign currency are unsupported.
- `getAccounts()` synthesizes one account from login credentials instead of parsing the actual account list.
- Session export contains **the login PIN, cookies, and authenticated top HTML**. Kogane must exclude the PIN from sessions, encrypt stored cookies/form state, and exclude authentication data and HTML hidden fields from logs/raw evidence.
- Transfer-recipient lookup and fee calculation are implemented but unnecessary for this collector. Remove transfer-related capabilities and routes from the build or allowlist.
- No dedicated provider tests were found; site-change detection and parser tests with fixed fixtures need to be added.
- A browser-style User-Agent is hard-coded, so long-term operation needs monitoring of Akamai decisions and site updates.

### Other public implementations

| Implementation                                                                                                                                                                      | Last relevant update | Method                                                                             | Assessment                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`yokwe/yokwe-root`](https://github.com/yokwe/yokwe-root/blob/70f8602122b5618480cd52d5b8c16ed0777b8860/yokwe-finance/src/main/java/yokwe/finance/account/smbc/UpdateAssetSMBC.java) | 2025-05-14           | Selenium/Safari, 60-second wait for additional authentication, official CSV saving | Reference close to the current UI. Coarse authentication-completion polling and heavy for server operation |
| [`t-bucchi/accagg`](https://github.com/t-bucchi/accagg/blob/d28e0ec153b478ea1edf384c9b108a0c91faf027/accagg/bank/smbc.py)                                                           | 2019-09-23           | Selenium/Firefox, ordinary-deposit CSV                                             | Predates SMBCセーフティパス. Selectors and login method are obsolete                                       |
| [`shinichy/get_statement`](https://github.com/shinichy/get_statement/blob/6f9730162d72eb9d14fa950767fdbcc8836676c1/get_statement.py)                                                | 2018-12-01           | Selenium/Chrome, previous-month CSV                                                | Historical route confirmation only                                                                         |
| [`kkosuge/bank_job`](https://github.com/kkosuge/bank_job/blob/0908e082d4c196a0fc8335351855874eb88b1549/lib/bank_job/strategies/bank_job_smbc.rb)                                    | 2014-03-03           | Mechanize, HTML table parsing                                                      | Unusable for the current method                                                                            |

GitHub Code Search found no public implementation of the current `TPALTOPAjaxSavingBalance` and `LLDLDILnextPreTS` other than `mnie`. In practice, `mnie` therefore has current reuse value; the others are design references for a CSV fallback.

### Kogane Workers PoC live result (2026-09-01)

The necessary read-only login, yen ordinary-deposit balance, monthly statements, and logout were isolated into `services/collector-smbc-direct` without a runtime dependency on `mnie`. Cloudflare Access protects the UI; QR challenges and authenticated sessions are stored AES-256-GCM-encrypted in a Durable Object; raw Shift_JIS JSON, normalized JSON, and manifests are stored in private R2. Start/end dates are not accepted from clients: it always scans monthly from Web通帳’s earliest date, 2019-01-01, through the execution day in Japan time.

Comparison changing only egress, with the same code and credentials:

| Egress                                                              | Login pre-step                              | Decision                             |
| ------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------ |
| Ordinary Workers `fetch()`                                          | HTTP 200 but SMBC `ERRINFO` form            | Cannot reach a Safety Pass challenge |
| VPC-binding `fetch()` directly specifying the existing TAMIA Tunnel | `BCATBCA` form and Safety Pass QR generated | Adopted                              |

Only `direct.smbc.co.jp` and `direct3.smbc.co.jp` are fixed in an exact code allowlist and passed to `TAMIA.fetch()`. Arbitrary hosts, client-specified destinations, Tailscale, hostname routes, Containers, and Browser Rendering are not used. This routes ordinary Workers TLS/HTTP fingerprints through a residential connection rather than being an opaque TCP bridge preserving Chrome’s fingerprint, but was sufficient for this SMBC Direct HTTP flow.

On the real account, the first Safety Pass session lost the `TPALTOP` form at 48/93 months and became partial after 3 bounded retries. The 48 collected months, 188 statements, and 98 artifacts remained in R2. After new QR approval, collection resumed from month 49 with the same Run ID and artifact set; the final R2 manifest confirmed the following.

- status `success`
- 93/93 monthly chunks (2019-01-01 through 2026-09-01)
- 1,069 transactions
- 188 data artifacts + manifest
- failure code 0
- official logout success

Do not therefore assume one Safety Pass approval always completes the equivalent of 30 years. Preserve partial state and resume uncollected months after the next manual QR approval. On resumption, do not retrieve or overwrite existing month objects; set final status to success only after every chunk completes.

## Official API and avoiding aggregators

三井住友銀行 has API infrastructure for personal accounts providing ordinary-account balances/statements, time deposits, foreign currency, bonds, points, mortgages, and more. Connections are limited to electronic payment intermediary providers contracted with the bank and meeting its connection standards. [Official integration policy](https://www.smbc.co.jp/collaboration/)

Contracted parties as of 2026-03-31 included Moneytree, Money Forward, freee, and Zaim. [Official contracted-party list](https://www.smbc.co.jp/collaboration/keiyakunaiyou.html) Technically this is the most stable route, but it conflicts with this project’s policy of “avoiding aggregators where possible and using official websites/apps directly as sources.” No public self-service API for individual developers was found, so it is excluded in the current phase.

## Real-account verification of Money Forward ME API integration (2026-08-31)

### Role

This project prioritizes direct collection from official websites/apps, but Money Forward ME, a contracted electronic payment intermediary provider, was checked using the owner’s existing free account as a comparison/auxiliary route while SMBCセーフティパス makes renewed login require a person. Money Forward’s official support explicitly lists 三井住友銀行 as an example of **API integration**, rather than scraping.

Read-only observation of the owner’s logged-in dedicated Kuebiko Chrome profile confirmed the following. Account numbers, balances, statements, names, email addresses, cookies, CSRF tokens, and WebAuthn challenge/credential values were neither saved nor committed.

- The 三井住友銀行 integration was healthy; yen `残高別普通` and `外貨` (“foreign currency”) appeared as two account types under the same bank integration. Thus at least current balances and deposits/withdrawals imported into Money Forward can be read for both yen and foreign currency through a single integration.
- The same free account also had `三井住友カード (VpassID)` (“Sumitomo Mitsui Card, VpassID”) registered separately from 三井住友銀行. Olive debit withdrawals may appear as bank-side deposits/withdrawals, but this verification did not test whether the Vpass integration provides card granularity such as merchant names or sales-finalization state; bank API integration alone is not treated as satisfying Olive debit statements.
- Free membership permits 4 integrations; this existing account was using all 4 displayed integrations. If Kogane uses Money Forward as an auxiliary route, it will not adopt a design that deletes existing integrations to add services.
- Free members can view the past 1 year on screen. On linking, Money Forward obtains the period available for inquiry at the financial institution/API and aims to retain older collected data as far as possible, but it cannot be displayed while remaining a free member. Starting regular raw storage in Kogane early has value.
- Free membership does not provide bulk refresh or increased refresh frequency. Individual refresh buttons were displayed, but no refresh request was executed in this verification. Before using it as the authoritative source for daily collection, actual Money Forward automatic-refresh frequency must be measured and the last-retrieval time as of Kogane collection must be saved in the manifest.

### Confirmed Kogane PoC results

On 2026-08-31, browserless read-only Money Forward ME collection completed from both local WSL and Cloudflare Workers. Authentication used only an existing passkey in the Bitwarden vault; the Money Forward ID master password, Bitwarden master password, `BW_SESSION`, and browser cookies were not stored in the runtime.

- Bitwarden contained 2 existing passkey candidates with RP ID `id.moneyforward.com`. Both succeed at WebAuthn assertion signature verification and Money Forward ID session issuance, so signature success alone cannot identify the target ME household.
- After the OAuth transition to Money Forward ME, selecting the `active` account-selector candidate and checking access to `/accounts` and account details identified only the 1 candidate corresponding to the actual ME household. Selection uses this end-to-end reachability check, not item names or candidate order.
- With the correct existing passkey, both local and Workers collection obtained 4 account details, 48 monthly fragments covering the most recent 12 months for each of the 4 accounts, and a manifest: 53 artifacts total, with 0 failures.
- Workers creates a new Money Forward ID/ME session on every run and saves retrieved raw HTML to private R2. Public responses return only counts and the manifest key. The R2 manifest was checked for byte counts and SHA-256 of all 53 artifacts and matching hashes after retrieving sample objects again.
- The temporary Kogane-specific passkey added during verification was removed from Money Forward ID after logging in again with the existing Bitwarden passkey. Temporary private keys on Windows/WSL were also deleted; the current PoC and Worker Secret derive from the existing Bitwarden passkey.

This demonstration does not mean Money Forward ME offers an official personal export API. Kogane is a PoC observing Money Forward’s private Web interface read-only, treated as a fallback affected by route/HTML changes, usage terms, and refresh delays at linked sources.

### Data missing or weakened through Money Forward

Actual screens and collection artifacts confirmed account balances normalized into Money Forward, general deposit/withdrawal rows, and Vpass-side billing/usage rows. The following cannot be obtained at parity with official SMBC/Vpass raw statements, or their completeness cannot be guaranteed.

| Target                          | Missing or unguaranteed data                                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SMBC yen deposits               | Post-transaction balance, bank transaction/reference ID, value date, structured transfer-counterparty information, official CSV or bank-API raw bytes                                                                                  |
| SMBC foreign currency           | Official granularity retaining original-currency amount, currency, applicable rate, and post-transaction foreign-currency balance together                                                                                             |
| SMBC time deposits etc.         | Product-specific details such as deposit lots and maturity dates. Successful retrieval of 4 accounts here does not guarantee Money Forward completely retrieves all account types/history                                              |
| Vpass                           | In-use/sales-finalized/billing-finalized state, single/installment/revolving payment and installment count, billing month, payment date, invoice-level grouping, cancellation/refund links to original transactions                    |
| Vpass overseas usage            | Original-currency amount, original currency, conversion rate, authorization/sales ID, merchant country/category                                                                                                                        |
| Vpass supplementary information | Points and source-specific fields that official statements may contain                                                                                                                                                                 |
| Olive debit                     | Bank integration may show withdrawal amounts but lacks merchant granularity. Even if Vpass integration displays general descriptions/amounts, completeness, finalization state, and agreement with official details are not guaranteed |
| Common                          | Latest data not yet refreshed/pending at the linked source, initial-backfill completeness, exact time each statement was obtained from the linked source                                                                               |

Free membership adds limits of 4 integrations, 1 year of on-screen history, no bulk refresh, and no increased refresh frequency. The Money Forward route is therefore limited to an auxiliary route accumulating frequent snapshots without human Safety Pass approval, rather than replacing the official source as authoritative.

Official evidence:

- [How to register financial-service accounts](https://support.me.moneyforward.com/hc/ja/articles/13480029279897-%E9%87%91%E8%9E%8D%E9%96%A2%E9%80%A3%E3%82%B5%E3%83%BC%E3%83%93%E3%82%B9%E5%8F%A3%E5%BA%A7%E3%81%AE%E7%99%BB%E9%8C%B2%E6%96%B9%E6%B3%95): lists 三井住友銀行 as an API-integration example
- [Features by plan](https://support.me.moneyforward.com/hc/ja/articles/900004382283-%E3%83%97%E3%83%AC%E3%83%9F%E3%82%A2%E3%83%A0%E3%82%B5%E3%83%BC%E3%83%93%E3%82%B9-%E3%82%B3%E3%83%BC%E3%82%B9%E5%88%A5%E5%AF%BE%E5%BF%9C%E6%A9%9F%E8%83%BD%E4%B8%80%E8%A6%A7): free members: past 1 year, up to 4 integrations. Premium: unlimited periods/integration counts
- [Data viewing period](https://support.me.moneyforward.com/hc/ja/articles/900004413423-%E3%83%87%E3%83%BC%E3%82%BF%E3%81%AE%E9%96%B2%E8%A6%A7%E5%8F%AF%E8%83%BD%E6%9C%9F%E9%96%93%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6%E6%95%99%E3%81%88%E3%81%A6%E3%81%8F%E3%81%A0%E3%81%95%E3%81%84): initially obtains the period available at the linked source and retains older retrieved data

### Money Forward ID authentication and reproducing the Bitwarden passkey

Cross-checking Kuebiko capture, Bitwarden CLI 2026.8.0 on WSL, and official Bitwarden client source confirmed the following. `bw get item` decrypts and returns a login item’s `fido2Credentials`; this existing credential included `credentialId`, a PKCS#8 P-256 private key, RP ID, user handle, counter, and similar fields. The values themselves, vault session, master password, cookies, challenges, and assertions were neither saved nor committed.

- Both the WebAuthn RP ID and registration target are `id.moneyforward.com`; this is not a domain mismatch.
- Deleting/recreating a passkey in Bitwarden changed the credential ID in `allowCredentials` returned by Money Forward’s `POST /webauthn/assertion/options` for email-specified login. Re-registration was therefore reflected on Money Forward’s side.
- Assertion options have `userVerification: required` and a 120-second timeout. `allowCredentials` was empty for discoverable login from the passkey button and limited to 1 entry after email-address entry.
- Bitwarden/Chrome did not send a WebAuthn assertion to Money Forward even after recreation. The same Kuebiko profile’s Bitwarden passkey succeeded on another RP, however, so the remaining problem is at the Money Forward credential presentation/selection boundary, not globally disabled WebAuthn.
- A Google OIDC account was linked, and login succeeded through `POST /auth/google`, Google consent/account chooser, `GET /auth/google/callback`, and Money Forward ME’s `/auth/mfid` callback. This is a valid human-assisted fallback, but the design does not copy a Google session into Workers.
- Direct CDP in Chrome 153 successfully added a temporary CTAP2.1 virtual authenticator, listed credentials (initially 0), and removed it. New registration of a Kogane-specific credential was unnecessary: the existing Bitwarden credential could be used directly.

#### Browserless-login demonstration

On 2026-08-31, new-session login succeeded with only a WSL/Linux Python HTTP client and the existing Bitwarden passkey, without Chrome, the Bitwarden extension, or Google OAuth.

1. Use `GET /sign_in` to obtain an anonymous-session cookie and CSRF token.
2. Send `{"userIdentifier":{},"authenticationContext":"sign_in"}` to `POST /webauthn/assertion/options` to obtain a discoverable-login challenge. Observed options were a 43-character base64url challenge, `userVerification: required`, timeout 120 seconds, and `allowCredentials: []`. If RP ID is omitted, use origin host `id.moneyforward.com`.
3. Generate `clientDataJSON` with `type: webauthn.get`, the obtained challenge, origin `https://id.moneyforward.com`, and `crossOrigin: false`.
4. Generate authenticator data from `SHA-256(rpId)`, UP/UV/BE/BS flags, and the credential counter; sign `authenticatorData || SHA-256(clientDataJSON)` using ECDSA/SHA-256 with the stored P-256 private key. Convert the signature to ASN.1 DER.
5. Send `authenticatorResponse`, `authenticationContext: sign_in`, and an empty `returnUrl` to `POST /webauthn/assertion`.
6. Retain the session cookie returned on success in the same jar.

Initially, putting Bitwarden’s stored 36-character `credentialId` directly into WebAuthn JSON’s `id`/`rawId` produced HTTP 401 and `notFoundWebauthnCredentialId`. Bitwarden stores a UUID when creating the credential, converts it to a raw 16-byte UUID for assertions, and base64url-encodes it. Matching official [`parseCredentialId`](https://github.com/bitwarden/clients/blob/main/libs/common/src/platform/services/fido2/credential-id-utils.ts) and [`generateAuthData`/`generateSignature`](https://github.com/bitwarden/clients/blob/main/libs/common/src/platform/services/fido2/fido2-authenticator.service.ts) made `POST /webauthn/assertion` return HTTP 200 and `redirectPath`. `GET /me` with the same cookie jar also returned HTTP 200, while an unauthenticated control jar returned HTTP 302 to `/sign_in`, establishing successful session issuance.

This result shows Money Forward ID authentication needs no browser profile, extension UI, or preservation of Chrome fingerprints. Only credential material and an ordinary cookie/CSRF jar are required; the master password need not be placed in a serverless runtime. Use the following production boundary.

- Run `bw get item` with the vault unlocked in local WSL and sync only the target credential’s `credentialId`, `keyValue`, `userHandle`, counter, and RP ID to Kogane secrets. Do not send the whole-vault `data.json`, `BW_SESSION`, or master password.
- In Workers, import the PKCS#8 P-256 key into Web Crypto for signing and convert its P1363 signature to ASN.1 DER. Make raw 16-byte conversion of UUID credential IDs Bitwarden-compatible too.
- A new cookie jar can be created for each run, so neither Bitwarden nor Money Forward sessions are persisted. Perform passkey login before each daily collection; request credential resynchronization only on failure.
- For secret rotation, the user explicitly runs the local synchronization CLI immediately after recreating the passkey in Bitwarden. Do not mix challenges, assertions, Money Forward cookies, or retrieved financial data into the secret-sync path.

Workers Web Crypto assertion generation, OAuth transition to Money Forward ME, 4 account details including SMBC/Vpass, and monthly scans for the most recent 12 months were demonstrated in the PoC above. Remaining checks are Money Forward’s actual refresh frequency for free members, the backfill boundary of the collected 1 year, and route/HTML change detection in long-term operation.

## Runtime suitability

| Environment                            | Suitability | Reason                                                                                                                                                                                       |
| -------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User’s local device                    | 5/5         | Easy QR/deep-link approval and close to normal residential/mobile connectivity. Best for the initial demonstration                                                                           |
| OCI VM / single container              | 4/5         | Easy to provide fixed egress, Node/Bun, and encrypted storage. Approval URL/QR must be returned safely to the user                                                                           |
| OCI Kubernetes                         | 3/5         | CronJobs and Secret management are available but excessive for a single personal account. Design must preserve egress/session storage across Pod rescheduling                                |
| Cloudflare Containers                  | 4/5         | Current Node/Bun-compatible code is easy to host. Waiting for human approval and session persistence need a separate state store                                                             |
| Cloudflare Workers + TAMIA VPC binding | 5/5         | Node compatibility, Shift_JIS, cookie jar, encrypted DO, R2, Access, and resume after renewed QR approval completed on a real account. Ordinary Workers egress alone produces SMBC `ERRINFO` |

The adopted PoC uses Cloudflare Workers + the existing TAMIA VPC binding. Collection is serialized to 1 Access identity, 1 Durable Object, and 1 execution; multiple runs do not use the same session concurrently. The A/B result of ordinary Workers egress failure and TAMIA success fixes only the 2 SMBC hosts to TAMIA.

## Layer A raw-evidence ingestion (2026-09-05)

Historical record: the private outbox bucket and the strict importer into
`kogane-ingest` described here were retired on 2026-09-13
([legacy retirement](../legacy-retirement.md)). The backfill collector now
writes its runs into the shared `DATA` bucket
([below](#shared-data-bucket-u09-2026-09-11)).

A strict importer into central `kogane-ingest` was implemented while retaining private R2 as a durable outbox. Before creating central state, it validates the manifest, balance/transactions raw Shift_JIS JSON and normalized JSON, the failure complement, complete prefix inventory, exact metadata, native checksums (when present), and recalculated SHA-256. It cross-checks balances, periods, statements, and totals between raw and normalized data too, failing closed on unknown fields or unexplained missing/additional objects.

The central canonical source is the existing registry’s `smbc-bank`, not `smbc-direct`. Only dedicated credential `collector-r2-smbc-direct` is allowed this producer/source route; storage origins use reviewed templates and irreversible fingerprints rather than storing specific object keys. Large historical runs pin the complete inventory and continue 10 artifacts at a time; resubmitting the same manifest converges idempotently. No writes/deletes to source R2, GitHub Actions cron, Queue, or additional scheduled triggers are used.

A read-only audit checked 1 terminal manifest and 189 objects, with 94 raw and 94 normalized data artifacts. Prefixes, sizes, metadata, content types, declared checksums, and recalculated checksums all matched. Every real R2 object passed through the final validator, including immediate defer without creating central state. Bodies, financial values, object keys, individual hashes, and authentication values were not recorded.

### Layer B observation route (2026-09-07)

Layer B reads only cross-checked `balance-normalized` and
`transactions-normalized`. Raw Shift_JIS JSON remains provider evidence,
but has no parser assigned, to avoid double-counting the same balances/statements.
Yen ordinary-deposit balances become JPY `account_balance`; monthly statements become posted
transactions with provider IDs. Signs come only from explicit credit/debit, not descriptions;
post-transaction balances, periods, and deposit/withdrawal totals are retained with provenance.

Strictly validate real dates/times, monthly ranges, provider order, ID uniqueness, count limits, safe integers,
and agreement with statement totals, without ambiguous corrections. When recollection returns the same provider ID,
collapse only the current view to the latest entry; retain append-only evidence.
The production R2 read-only canary scanned 189 objects and 1 successful manifest, fully parsing
1,069 transactions and 1 balance from 94 normalized artifacts. The 94 raw partners were
intentionally outside Layer B; no bodies, object keys, hashes, or financial values were output,
and no R2 writes/deletes were performed.

## Cost and automation outlook

| Option                                                                                                                         |  Implementation cost | Automation level                                                        | Data scope                                                                            | Decision                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------: | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Isolate reads based on `mnie` research                                                                                         |                  3/5 | Initial/renewed login requires a person; automatic after authentication | Ordinary-deposit balance/date-range statements                                        | **Worker PoC implemented**. No `mnie` runtime dependency                                                                               |
| Legitimate Safety Pass approval orchestrator                                                                                   |                  3/5 | Biometric approval and completion after QR display require a person     | Authenticated Web session                                                             | **Worker PoC implemented**. Official app unchanged                                                                                     |
| Retrieve official CSV through a Web browser                                                                                    |                  3/5 | App approval requires a person; automatic thereafter                    | Web通帳 ordinary deposits, foreign currency, and other screen-supported account types | Useful for cross-checking/fallback                                                                                                     |
| Extend internal Web protocol to multiple accounts, foreign currency, and time deposits                                         |                  4/5 | Automatic after authentication                                          | Account list, multiple account types, deposit lots                                    | After the ordinary-deposit MVP                                                                                                         |
| UI automation of the official app                                                                                              |                  5/5 | Biometrics require a person; device maintenance also required           | General app displays                                                                  | Not recommended                                                                                                                        |
| Deregister Safety Pass through official procedures                                                                             |                  1/5 | Fully unattended while credential login remains available               | Scope readable on the Web                                                             | Only direct fully unattended option, but an explicit security downgrade and settings change. Not adopted by default                    |
| Copy Safety Pass registered device/profile                                                                                     |          5/5 or more | Not viable                                                              | Authentication mechanism                                                              | Keystore private key is non-exportable and biometrics are required every time. **Not adopted**                                         |
| Dedicated Android emulator                                                                                                     |          5/5 or more | Biometrics/attestation prevent unattended operation                     | General app displays                                                                  | Keystore, BiometricPrompt, Transmit attestation, and root detection prevent a serverless route                                         |
| Contracted aggregator API                                                                                                      | 1/5 on Kogane’s side | High                                                                    | Broad                                                                                 | Not adopted by policy                                                                                                                  |
| Existing Money Forward passkey + SMBC API integration                                                                          |                  2/5 | Fully unattended login demonstrated                                     | Yen/foreign-currency balances/statements already obtained by Money Forward            | Not authoritative, but a working fallback without Safety Pass                                                                          |
| Official personal external-integration token                                                                                   | 1/5 on Kogane’s side | High                                                                    | Balances/statements etc.                                                              | Ideal mechanism, but production connections are limited to contracted electronic payment intermediary providers. No self-service token |
| [LINE balance inquiry](https://www.smbc.co.jp/sns/line/service.html)                                                           |                  2/5 | Unattended for a period after initial linking                           | Public specification: primary account, most recent 1 week/up to 100 rows              | Auxiliary candidate after live confirmation of current availability. Insufficient for a full ledger/backfill                           |
| [Balance inquiry with branch/account/cash-card PIN](https://direct3.smbc.co.jp/aib/aibgsjsw1k12.jsp)                           |                  1/5 | High                                                                    | Current balance only                                                                  | Restricted for some users; no statements. Not adopted because it increases stored PINs                                                 |
| Import [email/push notifications](https://www.smbc.co.jp/kojin/direct/service/resources/pdf/goriyou_tebiki.pdf?version=260601) |                  2/5 | High                                                                    | Some events such as incoming transfers and scheduled debits                           | Limited to an auxiliary source because Global Service/SMBC Debit etc. are excluded                                                     |

## Initial research recommendations and post-implementation checks

The following is the design policy through 2026-08-31. The read client, QR approval, encrypted session, monthly raw storage, and resume after expiry are implemented. Independent comparison with CSV, long-term operation, and extension to multiple account types remain to be checked.

1. Isolate a **read-only** SMBCダイレクト client for Kogane based on `mnie`’s ordinary-deposit flow.
2. Read login credentials from Secret Manager each time. Exclude the login PIN from session artifacts.
3. Display the QR/deep link to the user and poll for completed approval in the official 三井住友銀行アプリ. When approval is required, use `interaction_required` rather than treating collection as failed.
4. Allowlist only the account list, ordinary-deposit balance, and date-range statements. Do not implement bank-transfer/account-transfer/recipient/fee screens.
5. Retrieve official CSV for the same period and compare counts, deposit/withdrawal totals, and ending balance. Save raw official JSON/CSV, collection time, and target period as evidence.
6. Reuse server-side sessions infrequently, without continuous keep-alive. Reapprove on expiry.
7. After ordinary deposits are stable, add top-page account-list parsing, multiple accounts, foreign currency, and time-deposit details in separate PRs.

If fully unattended operation is mandatory, there are effectively 2 options: the user explicitly deregisters Safety Pass, or changes policy to use a contracted aggregator. The former is a settings change/security downgrade; the latter introduces third-party dependence. Under current policy, **treat human approval as an infrequent interaction and automate synchronization between approvals through session reuse**.

## Historical initial verification plan

The following is the verification plan as of 2026-08-31, not a list of unstarted work. Client isolation and collection in items 1/3 were subsequently verified by the 93-month backfill. For current rerun procedures, see the PoC README; collect from the earliest date through the execution day without client-specified periods.

1. Rerun the confirmed 1-month statement collection in a Kogane isolated client and use fixtures too to verify stability of the state machine waiting for completed Safety Pass approval and parser results for 14 rows/deposit-withdrawal totals.
2. Manually retrieve just 1 month of Web通帳 CSV and check columns, encoding, presence of a statement-ID equivalent, descriptions, and balance granularity.
3. Port only the confirmed login, Safety Pass polling, balance, and statements into the Kogane isolated client. Do not depend on or reuse the `mnie` package; exclude transfer-related routes.
4. Compare JSON and official CSV counts, deposit totals, withdrawal totals, and period-end balance.
5. Measure export/import validity without keep-alive after 15 minutes, 1 hour, and the following day. On detected expiry, fall back to a renewed-login request.
6. Create separate new sessions locally and on OCI and record Akamai HTTP 403/429, challenges, added cookies, and expiry on IP changes. Do not test by moving sessions between environments.
7. If the account list contains account types other than ordinary deposits, record only account-type names and masked identifiers, then investigate foreign-currency/time-deposit read endpoints in the next dedicated PR.
8. Obtain Play-distributed splits legitimately from the owned device and compare version/hash/signer with the 12.8.0 candidate. Static analysis of the third-party candidate itself is complete.
9. Observe read-only runtime metadata only while the owner performs an existing Safety Pass login in the unmodified official app; record the order of challenge issuance, app approval, Web polling, and session rotation without values. Do not navigate to write endpoints, registration/deregistration, or transaction approval.
10. Use static/runtime results to classify each component as “reproducible with standard Android APIs,” “bound to bank registration or a non-exportable key,” “bound by server attestation,” or “unknown,” and list the legitimate experiments needed next. Do not proceed to bypass experiments.

## Unknowns

- Current session idle/absolute-time limits, and whether expiry at 48 months depends on time, request count, or another condition
- 429 responses, additional authentication, and session lifetime during long-term daily incremental collection through TAMIA
- Routes and identification for multiple accounts/different account types when removing the fixed default account-type code `2206`. Collection for 1 ordinary-deposit account is confirmed
- Internal endpoint returning the actual multiple service-account list, and stable account identifiers
- Time-deposit/installment-savings deposit-lot fields and history-retention periods
- Exact currency, decimal-place, applicable-rate, and post-transaction-balance schema of foreign-currency CSV/internal JSON
- Actual behavior of Web通帳 savings-deposit history periods, which differ between the current FAQ and older help
- Byte/hash identity between the official Play distribution and third-party 12.8.0 candidate
- Whether the Safety Pass EC key is TEE/StrongBox hardware-backed, and the bank-side public-key registration payload
- Challenge-response signature algorithm/canonicalization, expiry, one-time use, replay prevention, and key rotation
- Conditions applying Transmit Security attestation and presence of additional layers such as Google Play Integrity

## Temporary verification artifact cleanup record (as of 2026-08-31)

The following records the end of the initial local follow-up; it does not mean the current Worker has no R2, encrypted sessions, or Secrets. Current deletion targets need rechecking; do not include running Workers or shared TAMIA resources in a blanket cleanup.

- Temporary clones and authenticated sessions disappeared when the verification process ended; no reusable cookies or credentials were left behind.
- Only the SVG rendering an expired Safety Pass QR remains as a temporary artifact. Its embedded challenge has expired, but track it for deletion in the same list as cleanup of verification Cloudflare Worker/R2 resources.

## Shared DATA bucket (U09, 2026-09-11)

The backfill collector does not read `COLLECTION_TARGET` and does not call the
importer. The switch and the importer were retired on 2026-09-13
(`docs/collection.md`). The Durable Object finishes a backfill run by
re-reading artifacts staged in `DATA`, verifying each against the manifest,
and writing the `terminal-v1` manifest last — one terminal per backfill run,
whether it succeeded, ended partial or failed. There is no cron: a person
starts the run behind Cloudflare Access with an approved QR challenge. This
is the one bounded exception to "stored once": because the chunks span
alarms, the finish re-reads the staging prefix inside `DATA`;
`docs/collection.md` records the bound and the U15 removal path.

The Durable Object now also keeps two session generation ids: `sessionRef`, the
live generation rotated on every approved sign-in, and `runSessionRef`, the
generation that opened the current run and which a resume keeps. The terminal
carries `runSessionRef` as `acquisitionSessionRef`; the SMBC credential, the
encrypted session envelope, the challenge state and the page cookies never
leave Durable Object state.

Because this source has no unattended re-authentication, any run that does not
reach `success` needs a person to approve a new challenge: its terminal reports
`waitingForHuman`, a lost session maps to `human_required_approval`, and
`/api/status` reports the same signal.

The artifact/role table and the run-size limit are in
[`docs/collection.md`](../collection.md#smbc-direct-kogane-smbc-direct-backfill-poc).

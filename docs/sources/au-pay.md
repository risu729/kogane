# au PAY API family research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

- Research date: 2026-08-26 (Australia/Sydney)
- Scope: read displays of personal au PAY balances, code/online/prepaid payments, top-ups, transfers/receipts/withdrawals, and boundaries with au PAY（auかんたん決済） (au PAY Easy Payment) and Ponta points accessible through the same au ID.
- Out of scope: au PAY for BIZ, the au PAY マーケット (au PAY Market) purchase ledger, au PAY スマートローン (au PAY Smart Loan), auじぶん銀行 (au Jibun Bank) accounts, Suica, and the au PAY カード (au PAY Card) credit ledger. These remain separate sources even when displayed in the app.
- Constraints: used only logged-out official public information, public HTTP responses, and public code. Did not retrieve/store actual au IDs, phone numbers, Ponta member IDs, balances, amounts, merchants, transfer recipients, card/bank information, cookies, tokens, OTPs, etc. No logged-in live verification performed.

## Conclusion

au PAY is not entirely app-only. The official [au PAY site](https://wallet.auone.jp/) provides users linked to
au/UQ mobile/povo1.0 subscriptions with monthly histories/details for au PAY balances and au PAY Easy Payment,
and PC download of `全てのサービスの明細` ("statements for all services"). Official guidance says au IDs
not meeting these conditions can check history only in the app; balance breakdowns, transfers/receipts/withdrawals,
and Ponta displays also lean toward the app.

Official download is not a scheduled headless API. Public descriptions alone do not establish extensions,
internal files, columns, covered periods, or maximum rows. Current login involves au ID SMS/email two-step
verification, WebAuthn/FIDO-based fingerprint/face authentication, KDDI CAPTCHA, and device/network conditions.
The overall safe default is **E, cost 1 (manual download/import)**. If read/export transport can be identified
from an existing browser session for a Web-eligible user, **C candidate, cost 3**; the app route for users
ineligible for Web is **D, cost 4**.

Separate Ponta and au PAY Card ledgers. Ponta is a reward ledger for points balances, ordinary/Market-limited
points, accrual/use, and expiry; au PAY Card is a credit ledger for confirmed/pending usage, billing, and
CSV/PDF. Link card-funded au PAY top-ups as card-side outflows and wallet-side inflows through reconciliation
links; do not double count them as shopping.

## Official surfaces and scope

- The [official history FAQ](https://www.au.com/support/faq/details/00/0000/000001/pg00000150/) says both app and eligible users' Web can switch monthly between `au PAY 残高` ("au PAY balance") and `au PAY（auかんたん決済）`, displaying details for each row.
- The [au PAY special terms](https://wallet.auone.jp/contents/lp/terms/aupay.html) treat payment datetime, merchant/store name, payment amount, top-up records, and payment status as usage history. Minimum model: `occurred_at / ledger / type / merchant_label / amount / status / balance_after? / source_reference?`. The last two fields' existence has not been verified live.
- The [official balance explanation](https://wallet.auone.jp/contents/pc/guide/moneytransfer.html) separates `au PAY マネーライト` ("au PAY Money Lite") for payments from `au PAY マネー` ("au PAY Money") for payments/transfers/withdrawals. Even after identity verification, top-ups from combined telecom billing, credit cards, and gift cards become Money Lite. Keep the two as separate snapshot fields if displayed.
- App read candidates: balance/breakdown, code/online/prepaid use, top-ups, transfers/receipts, withdrawals, refunds/adjustments, and au PAY Easy Payment. Payments, top-ups, transfers, withdrawals, and receipt QR/URL creation are writes; do not execute them.
- [App Store](https://apps.apple.com/jp/app/id862800897) and [Google Play](https://play.google.com/store/apps/details?id=jp.auone.wallet) aggregate balance, usage history, Ponta, au PAY Card information, and au PAY Easy Payment information in one UI. Android package: `jp.auone.wallet`. One screen does not establish a shared backend/ledger.

| Route                               | Established reads                                                                                    | Constraints/treatment                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| au PAY app                          | Balance, history, breakdown, points, card overview, Easy Payment, transfer destination history, etc. | Identity verification/device state depending on feature; adjacent write UI. App-only for Web-ineligible users |
| au PAY Web                          | Monthly wallet/easy-payment histories/details                                                        | Only au/UQ mobile/povo1.0 subscribers; not app-only for eligible users                                        |
| PC download                         | `全てのサービスの明細`                                                                               | PC browser; public description only says to select the desired file within an Excel file                      |
| au Ponta ポータル (au Ponta portal) | Points balance, expiry, accrual/use, ordinary/limited switching                                      | Separate reward ledger, not a wallet export                                                                   |
| au PAY Card member site/app         | Card billing/usage statements, available credit, PDF/CSV                                             | Separate credit source                                                                                        |

Do not store phone numbers/subscription information to determine Web eligibility. Represent whether the official
Web displays history in its existing state as a boolean capability; branch to the app route if shown as ineligible.

## Statement states, granularity, periods, counts, and exports

- The official FAQ says merchant names may temporarily appear as `ブランドプリペイド加盟店` ("brand prepaid merchant"), changing to the actual store name about 14 business days after payment. Cancellations may leave the provisional name unchanged. Upsert merchant labels as mutable attributes, not immutable IDs.
- Current-month au PAY Easy Payment statements are before billing confirmation and may differ from actual billed amounts. Separate `provisional` snapshots from confirmed `settled` ones.
- The [prepaid cancellation FAQ](https://www.au.com/support/faq/details/00/0000/000002/pg00000280/) describes refunds when cancellation information arrives, and automatic cancellation/refund 45 days after payment even if it has not arrived. The [double refund FAQ](https://www.au.com/support/faq/details/00/0000/000033/pg00003316/) also describes temporary double refunds and another debit up to 10 days later. Make refund/adjustment/reversal independent events.
- Merchant enrichment, cancellations, and adjustments may occur after payment completion under the terms; `completed` does not mean `immutable`.
- Whether source transaction IDs are exposed is unknown. Without one, use a provisional key of ledger, datetime, signed amount, type, and ordinal within the month; do not create another row when a merchant label changes. Do not automatically merge ambiguous matches.
- In addition to the latest 6 months, the app can display older history through `もっと見る` ("see more"), but maximum coverage is not published. Fixed Web retention, monthly row limits, pagination, and rate limits are also unverified.
- Official PC download exists, but the FAQ says only `エクセルファイルの中で希望のファイルを選択` ("select the desired file within the Excel file"). Do not assert CSV/XLSX/ZIP, file counts, encoding, columns, periods, zero-row months, or row limits; call it `Excel-compatible download (exact format unknown)`.
- Personal wallet PDF/OFX was not found. au PAY Card PDF/CSV and merchant au PAY for BIZ CSV are out of scope.
- Retrieve the latest 45 days as well as monthly differences to reflect merchant enrichment, cancellations, and double-refund adjustments. Reread pending Easy Payment entries after billing confirmation too.

## Boundary with Ponta points

- The [Ponta history FAQ](https://www.au.com/support/faq/details/00/0000/000001/pg00000122/) displays accrual/use history in the app/au Ponta portal, switching between ordinary `Pontaポイント` ("Ponta points") and `Pontaポイント（au PAY マーケット限定）` ("Ponta points limited to au PAY Market"). Use reward events, not embedded wallet rows.
- The [official Ponta explanation](https://www.au.com/payment/point/) gives ordinary Ponta expiry as one year from last accrual or use. The [expiry FAQ](https://www.au.com/support/faq/details/00/0000/000001/pg00000198/) lists exceptions where some accruals, such as monthly points, do not extend expiry. Do not infer extension per event; separate current expiry snapshots from official category rules.
- Market-limited points may expire differently per award lot. The [official terms](https://www.au.com/payment/point/regulation-point/) also specify individual notification, or the end of the month 12 months after the award month when not notified. Do not add them to ordinary points.
- Accrual from au PAY payments and Ponta-to-wallet top-ups are corresponding events in two ledgers. Ponta use/exchange/balance top-up are writes; do not call them. Without a common reference, do not automatically join by datetime/amount alone.
- Ponta history periods, counts, downloads, and inclusion in the wallet PC download are unverified.

## Boundary with au PAY Card

- The [official card FAQ](https://www.au.com/support/faq/details/00/0000/000026/pg00002672/) says the dedicated site/app can display/download the past 14 months; the [card FAQ](https://qa.kddi-fs.com/faq/show/20736?category_id=75&site_domain=1) explicitly lists PC PDF/CSV. Separate specification from wallet download.
- Expected/confirmed card billing amounts in the au PAY app are summaries. The card source is authoritative for merchant statements, pending/settled, installments/revolving payments, refunds, and CSV/PDF.
- Card → wallet top-up is a reconciliation pair of card funding transaction and wallet top-up event, not wallet/card purchase.
- Even if Easy Payment is card-funded, do not duplicate the product ledger and card billing. Support links among references and billing-month differences for My au/KDDI料金 (KDDI charges), Easy Payment, and card billing.

## Authentication, MFA, devices, passkeys, and Bitwarden

### Established facts

- [au ID two-step verification](https://www.au.com/au-id/auth-two-factor/) applies SMS one-time URLs or SMS/email six-digit codes in addition to ID/password depending on circumstances. Hand off to the owner without automated retrieval/forwarding.
- [Fingerprint/face authentication](https://www.au.com/au-id/auth-biometric/) uses WebAuthn/FIDO and allows registration of up to 10 smartphones per au ID. Configuration disables password login; other devices use QR cross-device login with a registered smartphone, or the owner temporarily enables password login. The latter is a settings change; the collector does not do it.
- Official guidance requires Bluetooth for cross-device flow; in Apple environments credentials may be usable on another compatible device. It also uses the error `利用可能なパスキーがありません` ("no available passkeys"). Test passkey/WebAuthn credential device/provider boundaries rather than treating it as app unlock alone.
- Unauthenticated login HTML on 2026-08-26 included `fidoDeviceEnableFlg`, `fidoAuthDeviceEnableFlg`, WebAuthn checks, and KDDI CAPTCHA (`kcaptcha-nc.kddi.com`). Password forms use `connect.auone.jp`. The wallet issues Laravel CSRF cookies/sessions and redirects; authenticated cookie names/lifetimes are unknown.
- The [app privacy disclosure](https://wallet.auone.jp/contents/sp/aupay/android/privacy_policy.html) lists transmission of encrypted au IDs, authentication cookies, Android IDs, device-specific information, operation history, Ponta IDs, etc. Do not assume app sessions are simple bearer tokens.

### Separating facts and hypotheses

- **Fact**: KDDI does not explicitly list Bitwarden as a supported provider. Official material describes device biometrics, OS/browser, QR, and possible credential use in Apple environments.
- **Hypothesis**: Bitwarden autofill is likely usable if password login is enabled, but does not replace MFA, CAPTCHA, or device/network checks.
- **Hypothesis**: Bitwarden passkeys may work if the OS/browser permits third-party passkey providers. au ID device registration, Wi-Fi-off/au-network conditions, QR/Bluetooth, and in-app browser compatibility are unverified. Do not record support as established.
- Do not register/unregister passkeys/biometrics, register devices, temporarily enable password login, or change MFA destinations. Downgrade to D/E if existing authentication cannot bootstrap.

## Edge, WAF, anti-bot, and public Web/JS

- Unauthenticated observations on 2026-08-26 showed `wallet.auone.jp` using Apache/Laravel behind CloudFront (`Via`, `X-Cache`, `X-Amz-Cf-*`), `aupay.wallet.auone.jp` using CloudFront/S3, and public store search API using CloudFront and AWS API Gateway (`x-amz-apigw-id`). Not evidence of account API architecture.
- `id.auone.jp` uses nginx/JSESSIONID. The `connect.auone.jp` login page includes password forms, WebAuthn/FIDO flags, device environment collection JS, and a KDDI CAPTCHA loader. WAF product names/Akamai were not established; CloudFront alone does not establish AWS WAF.
- `wallet.auone.jp/robots.txt` did not return a blanket disallow, but this is not permission for authenticated automated retrieval.
- Public `api.aupay.wallet.auone.jp/store-search` is merchant search, not a personal account API. Do not use it for A/B ratings.
- Do not bypass 403/429, CAPTCHA, risk, unknown integrity checks, or device registration. Public JS formatting/deobfuscation, static examination of form/redirect/cookie attributes, and owner-operated read-only observation are in scope.

## Public third-party client transport/auth

### outerguy/ofxproxy (historical evidence)

[outerguy/ofxproxy](https://github.com/outerguy/ofxproxy/blob/89e0d8a08537897d628bc46ddf862452d39ee2df/server/auwallet.inc)
is a 2014--2017 AGPL-3.0 implementation for au WALLET Web; its last relevant commit is
[2017-11-25](https://github.com/outerguy/ofxproxy/commit/8952173918cbaba941fbe1831061055f46e9e4d0).
It is not a current client, but makes the historical transport concrete.

1. HTTP/1.1 GET wallet home; form POST login form hidden inputs and au ID/password.
2. Follow redirects, carrying an allowlist of cookies such as `JSESSIONID`, `BIGipServer...`, and `DVCK/DTKT/VTKT/ACST`.
3. On detecting `2段階認証` ("two-step verification") HTML, store method/URI/body/cookies as a temporary session and return for human input. There was also an optional path reusing `DVCK` as a device/risk token.
4. Parse balance/menu/prepaid history HTML; POST current/previous-month `download_form`; obtain CSV from historical `history_print.html`.
5. Parse top-up history from separate accordion HTML, combine it with shopping CSV, and generate OFX on the third-party side. Not an official OFX endpoint.
6. Finally GET the logout link.

It handles credentials/session cookies itself, has not been updated since 2017, and does not establish
support for current CloudFront/Laravel, WebAuthn, KDDI CAPTCHA, current downloads, transfers/Ponta/Easy Payment.
Do not reuse field/path/cookie names as current contracts. No modern public account client was found.

### APK-derived evidence and public API

- [Tabbed-out public analysis](https://github.com/beerphilipp/tabbed-out/blob/3ada3bb1fc317cdf9a442a52445614ee5a8b7cff/analysis/results/jp.auone.wallet.res.json) shows KDDI `OidcCustomTabsHelper` and Custom Tabs launch calls in multiple 2024 `jp.auone.wallet` APKs. OIDC/browser bootstrap candidate; token endpoint/scope/refresh/read host/schema unknown.
- A [public store search implementation](https://github.com/STREAM-inc/NetHarvest-Scripts/blob/8c0d021c9ef1720c92960672b7464a63364176a0/sites/service/aupay_japan.py) uses public `store-search` as unauthenticated JSON, separate from personal wallet transport.
- No current third-party account client, renewable/reusable session, or read API schema found. No evidence for B.

## Legitimate APK/JS static analysis and read-only dynamic observation

This host had no ADB or controlled physical Android device; legitimate Play split APKs were not obtained.
Do not substitute third-party mirrors or assert manifests/hosts/pinning/integrity.

1. On a controlled device's Google Play, verify developer/package as KDDI / `jp.auone.wallet`; install/update normally.
2. Enumerate base/split paths with `adb shell pm path jp.auone.wallet` and pull. Do not redistribute; retain only SHA-256, version, split names, signing certificate, and acquisition datetime in an evidence manifest.
3. Use `apksigner`, `apkanalyzer`/`aapt2` to check signer, SDKs, permissions, exported components, deep links, providers/services/receivers, backup/debuggable, and `networkSecurityConfig`.
4. Use `jadx --deobf` and resource/native strings to identify KDDI OIDC helpers, official hosts, WebView/Custom Tabs, OkHttp/Retrofit and similar clients, request/response models, Room/SQLite, wallet/Ponta/card/Easy Payment feature splits, and session renewal. Deobfuscation itself is in scope.
5. Record existence/call sites of network config, TrustManager/hostname verifier, CertificatePinner, Play Integrity/attestation, and root/hook detection. Do not disable them or alter return values.

One read-only trace during ordinary owner operation is also in scope:

- With profiler/Network Inspector, filtered logcat, or attachable no-op hooks, observe only class/method, host, HTTP method, path template, status, content-type, hashes of schema field names, and token/cookie attributes/lifetimes.
- Use an owner-controlled proxy only if normal app settings trust user-installed CAs. If pinning rejects it, do not bypass; return to DNS/SNI/TLS timing and static call graphs.
- Only ordinary reads of balances, history, breakdowns, Ponta history, and transfer history. Do not enter payment codes, QR scanning, top-up, send/withdraw, points use, or settings.
- Do not save HARs/pcaps/screenshots/raw logs/bodies/headers; redact to route/schema metadata on the spot and discard.
- For Web JS, check only login → au ID → password/WebAuthn → MFA/risk → wallet return, CSRF/cookie rotation, and download method/path/content-type. Do not obtain/reproduce CAPTCHA tokens, credentials, or cookie/body values.

## Read/write isolation

Read-only allowlist:

- Existing session validation, balance/breakdown snapshots
- Wallet/Easy Payment history lists/details
- Displays of existing top-up/send/receive/withdraw/refund/adjustment history
- Ponta balances, expiry, ordinary/limited history
- Generalized au PAY Card billing summaries (authoritative record is a separate source)
- Official PC download (after transport verification), logout

Prohibited operations:

- Payment code/QR generation/presentation, bill scanning, online payments, purchases
- Manual/auto top-up, adding top-up methods, top-ups from Ponta
- Send, receipt QR/URL creation, withdraw, adding recipients, address book use
- Ponta use/exchange/investment, campaign entry
- Card payments, installment/revolving payment and other changes
- Identity verification, bank/card links, auto-charge, limits, notifications, personal information, device, passkey/MFA/password settings changes

Do not determine reads/writes by HTTP method alone. Login/export POSTs are read candidates, but allowlist
origin/path, field names/types, CSRF/session, and expected redirects/content-types; do not automatically follow
unexpected redirects. Reject semantically unverified POST/PUT/PATCH/DELETE, GraphQL mutations, and app RPCs.

## Runtime suitability

| Environment                        | Suitability                               | Reason                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare Workers (fetch)         | Low to conditional                        | Suitable for export parsing/reconciliation, but cannot bootstrap WebAuthn/MFA/CAPTCHA/devices. Keep cookies/tokens/PII out of KV/logs                                                                                                                                                            |
| Cloudflare Browser Run             | Conditional                               | [Session reuse](https://developers.cloudflare.com/browser-run/features/reuse-sessions/) and [storage state](https://developers.cloudflare.com/browser-run/playwright/) are C candidates; official docs say it is identified as a bot, and it does not solve CAPTCHA/passkey/QR/device conditions |
| Cloudflare Containers              | Conditionally suitable                    | [Official architecture](https://developers.cloudflare.com/containers/platform-details/architecture/) is Linux/amd64 VMs. Can package browser/parser, but MFA/passkeys, session persistence, and region/IP changes are separate problems                                                          |
| OCI image                          | Suitable                                  | Digest-pin using [OCI spec](https://github.com/opencontainers/image-spec/blob/main/spec.md). Do not bake secrets/sessions into images/env; use runtime store, tmpfs, egress allowlists                                                                                                           |
| Kubernetes                         | Excessive but suitable                    | [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/) can duplicate/miss runs: use idempotency, `Forbid`, digest pinning, read-only FS, NetworkPolicy, one account/Pod                                                                                                 |
| Controlled physical Android device | Best for research, costly for routine use | Needed to check legitimate APK, OIDC/hosts/schemas, breakdown/transfer/Ponta routes. UI automation is D/cost 4--5 due to devices, passkey/Integrity, and adjacent write UI                                                                                                                       |

## Assessment under the common rubric

Use the definitions in PR #5 `docs/source-research.md` unchanged.

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper, 5 = device-bound/adversarial

| Route                                                                        |        Level |  Cost | Assessment                                                                                        |
| ---------------------------------------------------------------------------- | -----------: | ----: | ------------------------------------------------------------------------------------------------- |
| Manually download official statements on PC and import offline               |        **E** | **1** | Safest; verify exact format/retention/schema live                                                 |
| History/export replay from existing session with a Web-eligible subscription |  C candidate |     3 | Reads after bootstrap plausible; MFA/WebAuthn/CAPTCHA, renewal, and download transport unverified |
| Web screen UI automation                                                     |            D |     4 | Depends on DOM/JS/login protection, mutable merchants, write UI                                   |
| App reads for Web-ineligible accounts                                        |            D |     4 | Requires full device/app transport or UI automation                                               |
| au Ponta portal balance/history                                              |  C candidate |     3 | Web exists; no official scheduled API/export                                                      |
| Public store search API                                                      | Out of scope |     1 | Excluded from assessment because it does not retrieve personal financial ledgers                  |
| Safe family default                                                          |        **E** | **1** | Manual export is established; subscription-specific research candidates are C/D                   |

A does not fit: no documented scheduled API for personal wallets. B does not fit: no evidence of current
read APIs, renewal/reuse, or schema stability. Do not rely on historical ofxproxy/public store-search.

## Read-only live verification plan

1. Check official origins (`wallet.auone.jp` / `aupay.auone.jp` / `connect.auone.jp`), TLS, and Web history capability as booleans only.
2. Owner logs in using existing methods. Hand off SMS URLs/codes, email codes, passkeys/biometrics/PINs, QR/Bluetooth, CAPTCHA/risk without automated input.
3. Check only existence of total balance/breakdown fields. Do not record amounts, au IDs, phones, KYC, or funding details.
4. Check wallet/Easy Payment tabs, month selectors, beyond 6 months, detail fields, provisional merchants, and refund/adjustment states/types as types.
5. Owner presses PC download once; check method/path template, content-type/Content-Disposition, extension, container file list, column name hashes/types, encoding, covered period, and zero-row behavior. Discard immediately in tmpfs.
6. In Ponta, check only ordinary/limited, balance, expiry, accrual/use, and pending points boundaries. Do not enter use/exchange/top-up.
7. Check only that card summaries navigate to separate deep links/sessions. Card statements are a separate source.
8. Check only entry points and read/detail routes for existing send/receive/withdraw history. Do not enter new recipients, QR/URL, amount input, or confirmation.
9. Observe redacted metadata only in DevTools: login redirects, CSRF cookie attributes, wallet return, and read/detail/download methods/paths/schemas. Do not save values.
10. Observe validation, idle/absolute timeouts, cookie rotation, and silent renewal by reconnecting in the same browser within a short period. Do not replay login after expiry.
11. Once legitimate APKs are obtained, statically analyze signer/manifest/hosts/schemas/pinning/integrity and perform no-op tracing of ordinary reads. Stop without bypassing attach/proxy rejection.
12. Log out officially; discard temporary files/profiles/sessions/raw traces.

### Stop conditions

- CTA/confirmation for payment, top-up, send/receive QR, withdraw, Ponta use/exchange, card payment, application, or settings changes
- OTP/SMS URLs, passkeys/biometrics/PINs, QR/Bluetooth, CAPTCHA, risk, identity verification, device/network registration
- Temporary password login enablement, passkey/MFA changes, terms agreement/KYC updates
- Non-allowlisted POST/PUT/PATCH/DELETE, GraphQL mutations, app RPCs, cross-origin redirects, unknown downloads
- 401/403/409/423/429, locks, fraud detection, restriction warnings, consecutive login failures
- Unknown DOM/export/schema/status/ledger boundaries, missing rows, ambiguous reconciliation
- PII, actual balances/amounts/merchants/transfer recipients/cards/banks, cookies/tokens/OTPs emitted to logs/traces/screenshots
- Need for root/debuggable/return value modification or pinning/attestation/CAPTCHA/anti-hook/WAF bypass

## Unverified items

- Actual account Web eligibility; differences in Web/app wallet/Easy Payment, breakdown, and send/receive/withdraw read coverage.
- Exact wallet download format, internal files, columns, encoding, periods, rows, pagination, zero-row behavior, and Ponta inclusion.
- Maximum app/Web retention, transaction IDs, balance-after, complete status set, actual cancellation/double-refund adjustment displays.
- Authenticated cookies/tokens, idle/absolute timeouts, renewal/reuse, UA/device/IP/network binding, logout invalidation.
- Bitwarden autofill/passkey compatibility with Web, QR cross-device, and in-app browsers.
- Account read hosts/transport/auth scopes/CSRF/schemas, app/Web commonality. Public store-search is unrelated.
- Current APK version/signing certificate, manifest, deep links, network config, hosts, local schemas, pinning/Integrity/anti-hook.
- WAF/bot products behind CloudFront. AWS WAF/Akamai and similar products unverified.
- Ponta retention/counts/exports, expiry exception categories, limited points lot schema.
- Deep link/session boundary between card summaries and dedicated card sources; public reconciliation reference for the same top-up.

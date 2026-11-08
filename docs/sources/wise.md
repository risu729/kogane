# Wise personal-account direct-retrieval research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26

## 1. Scope and conclusion

This record covers **Wise personal accounts (personal profiles)** only. Wise Business, contracted Wise Platform partners, and authorized Open Banking AISP/TPPs are comparisons only, to avoid mistaking them for routes available to every personal-account holder. Do not use aggregators for initial retrieval.

Conclusions follow.

- The currently confirmed safe initial route for personal accounts is statement export from official Web/app.
- What current official developer material calls a Personal API Token is **Wise Business-only**, not a self-service personal-account token.
- Wise Platform OAuth 2.0 is for contracted partners and requires client ID/secret, Developer Hub, and mTLS. No public OAuth app-registration route was confirmed for individuals reading only their own accounts.
- The current safe rating is therefore **automation level E, implementation cost 1** (manual export/local import). This does not justify deferring personal Web/app internal-transport research. Public login JavaScript was statically analyzed; authenticated personal read transport and official Play split APKs remain next read-only validation targets.
- Browser replay is a C/D candidate at cost 4, but involves Cloudflare bot protection, reauthentication, passkeys/2-step verification. Do not make it the default until exact read routes and session renewal are confirmed.
- Only organizations able to obtain contracted read-only OAuth or Open Banking AISP `accounts` scope are A candidates; personal-account holders cannot start this route alone.

No balances, transaction contents, account/card identifiers, PII such as names/addresses, cookies, tokens, OTPs, or passkeys were retrieved or recorded. No transfers, currency exchange, deposits/withdrawals, card operations, or settings changes were performed.

## 2. Research method

- Prioritized Wise Help Centre, Wise Platform API docs, and official store listings.
- Read only public pre-login pages and HTTP response headers.
- Retrieved the Next.js build and JavaScript chunks served by `/login` on 2026-08-26 from the official origin, took SHA-256 hashes, formatted with Prettier 3.9.6, and statically traced strings/call sites. No bundles/artifacts were saved to the repository. Public source maps returned 403.
- Checked existing Chrome tabs; none was authenticated to Wise. No login, MFA, account navigation, or runtime traces involving personal data were performed.
- Checked package/version in official Google Play. This environment lacked a controlled Android device for legitimate split-APK acquisition and an Android analysis toolchain; no third-party APK mirrors were used.
- Used public GitHub implementations only to check transport/auth and read/write boundaries.
- Do not infer undocumented personal-account API availability from the existence of API schemas.
- Count limits, session lifetimes, internal-API stability, and other items without public evidence remain unconfirmed.

## 3. Objects visible in official Web/app

### 3.1 Main account, currency balances, and jars

Wise allows one personal account per person, containing a main account, multiple currencies, and optional jars/groups. Personal-account coverage varies by region.

- The main account holds multiple currencies for holding, receiving, sending, conversion, and card payments.
- A Jar stores the same or different currencies separately from the main account. It is not the normal source for card payments/Direct Debits, but can send money or move it to the main account.
- The official Platform model uses `STANDARD` for ordinary currency balances and `SAVINGS` for Jars. There is one `STANDARD` per currency, while multiple `SAVINGS` can share a currency.
- The Balance API schema includes `amount` (available), `reservedAmount` (reserved), `cashAmount`, `totalWorth`, `investmentState`, and `visible`.

Official personal-account descriptions:

- https://wise.com/help/articles/2897226/what-is-a-wise-account
- https://wise.com/help/articles/2897234/getting-started-with-your-wise-account
- https://wise.com/help/articles/2978074/what-are-jars-and-how-can-i-keep-money-in-them
- https://docs.wise.com/guides/product/accounts/balance-accounts

### 3.2 Assets (Interest / Stocks)

Interest and Stocks depend on supported regions/currencies. They hold a currency or Jar in something other than Cash and are not available to every personal account.

- Web/app shows total returns, realized/unrealized gains/losses, and fund performance.
- Standard/accounting PDF statements include `Earnings since start`.
- Holdings statements show units and valuations on a specified date.
- Daily unit-price revaluation is not cash movement and may not be automatically recorded as an ordinary accounting transaction.
- Platform Balances may be displayed with `investmentState` such as `INVESTED`, but official guidance requires treating anything other than `NOT_INVESTED` as unavailable for API operations.

Facts about personal Assets:

- https://wise.com/help/articles/B9ZPY1rj6TlzvVOhtonFo/understanding-how-your-money-is-performing-when-you-hold-it-as-stocks
- https://wise.com/help/articles/4Mo9V7MyXos6scM7xvhg15/licences-and-regulators-when-holding-money-as-interest-and-stocks
- https://docs.wise.com/api-reference/balance/tag

### 3.3 Cards

Official Web/app Cards and Activity show physical/digital cards, card usage, and pending status. The official Android package is `com.transferwise.android`. Do not use APKs outside official stores as the initial route.

The Platform card-transaction model distinguishes the following.

- `IN_PROGRESS`: authorized, not captured (UI pending).
- `COMPLETED`: captured/settled.
- `DECLINED`, `CANCELLED`, `UNKNOWN`.
- Reserved amounts not collected by merchants are normally released after 7 days; pre-authorisations take up to 30 days. Exceptionally, a merchant may capture late after `CANCELLED`, transitioning to `COMPLETED`.
- API refunds are separate `REFUND` transactions rather than overwriting original rows.

Personal-account UI explanations of pending/completed:

- https://wise.com/help/articles/2935784/my-wise-card-transaction-is-still-pending
- https://wise.com/help/articles/2977995/i-need-to-reverse-or-dispute-a-card-transaction
- https://docs.wise.com/guides/product/issue-cards/card-transaction
- https://play.google.com/store/apps/details?id=com.transferwise.android

### 3.4 Conversion, exchange rates, and fees

- Personal-account currency conversions normally appear within seconds; Wise says it applies the mid-market rate and currency-pair-specific conversion fees.
- Without balance in a card payment's currency, available balances may be converted automatically.
- Platform statement JSON has transaction-level `exchangeDetails` and `totalFees`.
- Web/app currency statements allow fee display, and a separate annual Statement of Fees exists.
- Assets fund-unit revaluation is not a cash transaction, so ordinary statements alone do not fully represent daily unrealized gains/losses. Combine holdings/Assets statements.

- https://wise.com/help/articles/2596980/how-can-i-convert-money
- https://wise.com/help/articles/2893489/fees-for-holding-receiving-and-spending-money

## 4. Statements, periods, counts, and export

### 4.1 Currency/Jar statements

Official Web/app statements cover currencies and Jars.

| Item             | Confirmed result                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| Period           | Maximum 365 days per file; split the full period into at most 365-day intervals                |
| Contents         | All transactions within Wise currency accounts, including hidden activity                      |
| Excluded         | Use Transactions export for all transfers including external payment methods                   |
| Web formats      | PDF, XLSX, CSV, MT940, QIF, CAMT.053 version 10                                                |
| App formats      | PDF, CSV, XLSX                                                                                 |
| Multiple targets | Web/Android can select multiple currencies/Jars together; large exports use zip or email links |
| Fees             | Accounting statements can display fees separately                                              |
| Reauthentication | Official guidance requires a Wise password when confirming download                            |
| Count            | No public row limit confirmed                                                                  |

Official evidence:

- https://wise.com/help/articles/2736049/how-do-i-download-a-statement

### 4.2 Transactions export

Web Transactions can list, search, filter, and download transfers for up to 365 days. The mobile app does not provide transfer-list downloads.

Filters are date, recipient, transfer type, status, direction, card, category, and currency. Formats are CSV/PDF. No public count limits or pagination units were confirmed.

- https://wise.com/help/articles/2489458/how-do-i-download-a-list-of-my-transfers

### 4.3 Fee statements and Assets

- Statement of Fees covers previous calendar years; eligible years since account opening can be selected.
- Fees are grouped by currency. Currently unavailable to US-based customers.
- Assets gains/losses are excluded from Statement of Fees.
- Currency statements themselves can display fees.

- https://wise.com/help/articles/6UgnJEesw6frs2o6lXEnwD/how-do-i-get-a-statement-of-the-fees-ive-paid

### 4.4 Platform API granularity (separate from availability)

Balance-statement endpoints used with contracted user tokens, etc. return deposits, withdrawals, conversions, card transactions, and fees in JSON/CSV/PDF/XLSX/CAMT.053/MT940/QIF.

- Maximum interval is 469 days.
- JSON transactions have `type`, timestamp, `amount`, `totalFees`, `details`, `exchangeDetails`, `runningBalance`, and `referenceNumber`.
- Per-response count limits/pagination were not confirmed in public material.
- UK/EEA statements may require SCA. Official guidance says additional authentication is normally once every 90 days; viewing statements in Web/app also counts as authentication.

Card Transactions V4 is a separate partner API.

- Only card transactions from the past 90 days.
- `pageSize` 10–100, default 20, `lastId` cursor.
- Lists are descending by ID. Single retrieval can include unaggregated debit/credit movements.

- https://docs.wise.com/guides/product/accounts/balance-accounts
- https://docs.wise.com/api-reference/balance-statement/tag
- https://docs.wise.com/api-reference/card-transaction/cardtransactiongetv4

Schemas representing personal profiles do not establish self-service token issuance for personal-account holders.

## 5. Authentication, personal tokens, and OAuth

### 5.1 Web/app identity authentication

Confirmed methods follow.

- Email + password is the fallback when passkeys cannot be used.
- 2-step verification supports passkeys, Wise app notifications, authenticator-app TOTP, SMS, and conditionally voice calls/WhatsApp.
- Official guidance says SMS cannot be completely removed from current verification methods.
- New devices may require additional challenges.
- Statement downloads explicitly require reentering the Wise password.
- The app handles notifications/biometrics; Web can manage the same security settings.

Static analysis of the public login build confirmed the following. These are **identity/auth transport**, not personal balance/transaction APIs.

- Axios defaults pair the `XSRF-TOKEN` cookie with the `X-XSRF-TOKEN` header.
- Login uses `POST /gateway/v2/login`; passkeys/OTT use `/gateway/v1/one-time-token/...`; Web device challenges use `/v1/device/web/challenge`.
- Password, TOTP, push, phone, and passkey OTT-challenge routes coexist in the same login app.
- Fixed client markers in the bundle identify the public app itself, not personal bearer/session tokens. Do not treat their values as collector credentials.
- Personal session-cookie/token issuance formats, renewal routes, lifetimes, and device binding cannot be established from the pre-login bundle alone.

- https://wise.com/help/articles/2932125/how-do-i-add-change-or-remove-my-step-verification-settings
- https://wise.com/help/articles/2951949/i-cant-use-my-step-verification-method

### 5.2 Passkeys and Bitwarden

**Confirmed:** Wise supports WebAuthn passkeys for login and 2-step approval. Once configured, passkeys become the default 2-step method and can approve actions requiring 2-step verification. Wise's example storage providers are Apple iCloud, Google Password Manager, and 1Password.

- https://wise.com/help/articles/4OTG2Z93XXyaurUviZRg5O/how-can-i-use-a-passkey

**Confirmed:** Bitwarden's browser extension supports storing/using general WebAuthn passkeys and autofilling normal login/password/TOTP.

- https://bitwarden.com/help/auto-fill-browser/
- https://bitwarden.com/help/autosave-from-browser-extensions/

**Inference:** Bitwarden passkeys are likely to work because Wise uses standard WebAuthn flows. However, official Wise articles do not explicitly name Bitwarden as compatible storage, and this combination has not been tested live on a personal account. Do not claim official Wise support for Bitwarden. Do not assume headless automation can operate extension popups or passkey prompts.

### 5.3 What Personal API Token actually means

Current official material explicitly states the following.

- Tokens cover **your own Wise Business account**.
- Issue them under the Business profile's `Connect and manage apps > API tokens`.
- Use bearer tokens in the `Authorization` header; valid until revoked.
- Endpoint scope is limited to quotes, recipients, transfers, batches, transfer events, etc.
- Balance statements do not support personal tokens except for Business accounts based in the US/Canada/Australia/New Zealand/Singapore/Malaysia.

- https://docs.wise.com/guides/developer/auth-and-security/personal-api-token

Do not infer issuance for Wise **personal accounts** from the name alone. Prioritize current access guidance/issuance procedures even when generic Help Centre material or older third-party READMEs mention personal customers/APIs.

### 5.4 OAuth 2.0 and Open Banking

Wise Platform OAuth is not consumer app registration.

- Requires a partnership agreement, Developer Hub-issued client ID/secret, redirect URL, and mTLS setup.
- User access tokens last 12 hours; refresh tokens up to 20 years. Refresh invalidates the old access token and may rotate refresh tokens.
- Credential scope depends on the contracted integration model.

Wise Open Banking offers authorized AISP/TPPs a read-only model for balances/transactions under `accounts` scope, but requires regulation, registration, mTLS, and consent. It is not a replacement for a personal API key.

- https://docs.wise.com/guides/developer/auth-and-security
- https://docs.wise.com/guides/developer/auth-and-security/oauth-2-setup
- https://docs.wise.com/guides/developer/auth-and-security/user-access-token
- https://docs.wise.com/guides/developer/open-banking

## 6. CDN, WAF, and anti-bot

Public pre-login responses were checked on 2026-08-26.

### Confirmed facts

- `wise.com` and `api.wise.com` resolved to Cloudflare edge addresses.
- Web/API responses returned `server: cloudflare`, `cf-ray`, and `cf-cache-status`.
- Web/API returned `__cf_bm`. Official Cloudflare material associates it with Bot Management or Bot Fight Mode protection; responses alone do not establish which product/plan.
- Login-page CSP/HTML referenced `challenges.cloudflare.com`, Turnstile, reCAPTCHA, and Sardine/Moscwise fraud/device signals.
- API GET without a bearer token returned 401 and no authenticated data.
- Wise's privacy notice describes fraud detection using behavioral biometrics such as website/app interactions, typing cadence, keystrokes, touch, and mouse behavior.

- https://wise.com/login
- https://api.wise.com/
- https://wise.com/imaginary-v2/images/6840ab5cd14bcca9f98307cf7cb689c5-PersonalCustomerPrivacyNoticev.3-31March2025%28EN%29.pdf
- https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/
- https://developers.cloudflare.com/turnstile/reference/content-security-policy/

### Unconfirmed/inferred

- Conditions triggering Turnstile/reCAPTCHA in normal login are unconfirmed.
- Bot Management versus Bot Fight Mode, bot scores, rate rules, account-takeover rules, and IP-reputation thresholds are unconfirmed.
- Internal/mobile API origins, device binding, and certificate pinning are unconfirmed.
- Do not implement evasion of Cloudflare/fraud-provider detection.

## 7. App and Web roles

| Surface      | Read use                                                           | Export                                                         | Authentication role                                       |
| ------------ | ------------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------- |
| Web          | Home, balances, Jars/Assets, Cards, Activity, Transactions         | Best for all formats, transfer lists, multiple currencies/Jars | Passkey/password, security settings, download password    |
| App          | Same account state, immediate notifications, card status, Activity | PDF/CSV/XLSX; no transfer-list downloads                       | Trusted-device notifications, biometrics, passkeys/2-step |
| Platform API | Balance/statement/card data within contracted scope                | JSON and statement formats                                     | Bearer OAuth/personal Business token; sometimes SCA/mTLS  |

Web exports have the broadest collection coverage; the app suits notifications/2-step and spot checks.

### 7.1 Static inventory of current Web JavaScript

The build ID retrieved from official `/login` on 2026-08-26 was `login-app_main_7d8f91a`. Entry was `pages/login-6024adb12c070424.js`; the main app chunk was `_app-335f04025d26a9b1.js` (acquisition SHA-256 `d9a1c9f84d347f66630eda0d5cc288921bc7cca54e257f5c21f9700b9ceda0f1`). Formatting/string tracing confirmed section 5.1 identity routes, XSRF configuration, and passkey/OTT/device challenges. The minified file's source map returned 403 at the official origin, so only public bundles were analyzed.

Unauthenticated GETs to `/home`, `/activity`, `/transactions`, `/balances`, and `/your-account` all redirected to `/login?redirectUrl=...`; the login build manifest serves only login/account-recovery routes. Thus, failure to find personal balance/activity chunks or read endpoints in this artifact does not prove absence; the evidence boundary is that another app/bootstrap is served after authentication.

- https://wise.com/login

### 7.2 Personal read-route targets and recipient exclusion

Treat public Platform APIs and personal internal APIs separately; do not apply the former's paths/schemas to the latter. Map requests from each following UI operation in authenticated passive traces.

| UI read                 | Required schema                                                          | Excluded                                                  |
| ----------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- |
| Home                    | Currency balance, reserved/available, Jar, Assets presence               | Profile/account IDs, names, addresses                     |
| Activity list/detail    | Stable-ID presence, timestamp, amount/currency, status, type, pagination | Counterparty names, account numbers, references/free text |
| Card pending/completed  | Authorization/posted/cancelled/refund, reserved versus settled           | Card numbers/tokens, detailed merchant locations          |
| Conversion/fee display  | Source/target amounts/currencies, rates, fees, same-event linkage        | Quote/conversion creation requests                        |
| Statement/transfer list | Period, format, reads of generated documents                             | Recipient-filter values, actual PDF/CSV data              |

Recipient list/create/edit routes are excluded; do not access `recipient`/`beneficiary`-specific paths. Even if Activity responses include counterparties, schema-allowlist only needed transaction states and discard names, bank details, messages/references. Do not assume pending/posted are separate records; verify stable IDs/state transitions before modeling reserved/settled.

Initially consider only `GET` requests naturally generated by passive page loads. Even if reads use GraphQL/RPC `POST`, do not infer safety from method names or call them. Exact paths, query keys, pagination, fee/FX fields, and session/renewal remain unconfirmed without authenticated traces.

### 7.3 Official Android split-APK provenance and static analysis

The official Google Play listing showed package `com.transferwise.android`, version `9.38.0` as of 2026-08-26 (updated 2026-08-24). This environment had Docker only, without `adb`, `apksigner`, `bundletool`, `jadx`, `apktool`, `aapt2`, `apkanalyzer`, or MobSF. No legitimate Play-installed artifact was available on a controlled device, so versionCode, split inventory, SHA-256, signer-certificate digest, manifest, and hosts/paths/schemas were not obtained.

- https://play.google.com/store/apps/details?id=com.transferwise.android

After installing/updating the official app from Google Play on a user-controlled device, retrieve every split as follows rather than using third-party mirrors. Do not open device account data; use temporary storage outside the repository.

```bash
PKG=com.transferwise.android
OUT="$(mktemp -d)/$PKG"
mkdir -p "$OUT"
adb shell dumpsys package "$PKG" \
  | rg 'versionName|versionCode|firstInstallTime|lastUpdateTime|signingInfo'
adb shell pm path "$PKG" | tee "$OUT/package-paths.txt"
while IFS= read -r line; do
  remote=${line#package:}
  adb pull "$remote" "$OUT/$(basename "$remote")"
done < "$OUT/package-paths.txt"
sha256sum "$OUT"/*.apk
for apk in "$OUT"/*.apk; do
  apksigner verify --verbose --print-certs "$apk"
done
jadx -d "$OUT/jadx" "$OUT"/*.apk
apktool d -f "$OUT/base.apk" -o "$OUT/apktool-base"
apkanalyzer manifest print "$OUT/base.apk" > "$OUT/AndroidManifest.xml"
rg -a -n \
  'https?://|wss://|api|gateway|balance|activity|transaction|statement|fee|exchange|recipient|okhttp|retrofit|webview|cookie|session|token|keystore|biometric|integrity|attestation|certificate|pin' \
  "$OUT/jadx" "$OUT/apktool-base"
```

First verify matching package/versionCode and signer digests across all splits, and pass code/config splits as well as base to `jadx`. Inventory manifest exported components, app/deep links, network security config, WebView/native clients, protobuf/JSON schemas, session storage/renewal, Android Keystore/biometrics, Play Integrity/attestation, and certificate-pinning candidates. Deobfuscation/call-graph tracing is in scope; **bypassing** integrity/pinning/root/debugger detection is not. Submit to MobSF only in a local container pinned by version/digest; do not upload APKs to public cloud scanners.

### 7.4 User-operated read-only runtime metadata observation

For Web, after the user completes normal login/MFA, reload current Home and Activity through DevTools/CDP. Aggregate only method, host, ID-templated paths, query **key names**, status, content-type, and schema keys in memory. Do not save headers, cookies, tokens, request/response bodies, amounts, IDs, or counterparties. This was not performed because no existing Chrome tab had Wise.

For Android, while the user opens Home/Activity in the unmodified official app, observe DNS/SNI/IP and, only where available within OS trust, method/host/path and process/thread call sites. If communication metadata is unavailable, stop at TLS handshake/host. Runtime tracing of URL construction with Frida or similar is in scope, but do not hook tokens/headers/bodies or disable pinning/integrity. Do not assume matching Web/app hosts, paths, schemas, or session issuance/renewal.

## 8. Official samples and public third-party clients

### 8.1 Official Wise samples

Wise publishes Next.js OAuth-connect/SCA samples rather than a general SDK. Wise API calls run server-side rather than in the browser client, with bearer tokens in `Authorization`. The SCA sample handles `x-2fa-approval`/result headers. These examples require partnership credentials and do not issue personal-account tokens.

- https://github.com/transferwise/wise-platform-samples
- https://github.com/transferwise/wise-platform-samples/tree/a7d09f2695b13adbe21fe0b0cb8ae603b983f0a8

### 8.2 Hillpro/WiseApi.Client

Unofficial MIT-licensed .NET 10 client, checked at commit `b759e1430351f0348778fdb3e313cc5db5733ac5`.

- `HttpClient` plus delegating handlers add `Authorization: Bearer` to all requests.
- Production uses `https://api.wise.com`; sandbox uses `https://api.wise-sandbox.com`.
- Alongside GET profiles/multi-currency accounts/balances/rates, **the same client includes write endpoints** for balance creation/deletion, quotes, conversions/movements.
- Implements OAuth client credentials, authorization codes, registration codes, and refresh tokens.
- Statements, cards, recipients, and transfers are deferred at this commit.
- README claims personal tokens work for personal/small-business users, conflicting with current Wise official Business-only issuance procedures. Prioritize official material.

- https://github.com/Hillpro/WiseApi.Client
- https://github.com/Hillpro/WiseApi.Client/blob/b759e1430351f0348778fdb3e313cc5db5733ac5/src/WiseApi.Client/Http/Handlers/AuthenticationHandler.cs
- https://github.com/Hillpro/WiseApi.Client/blob/b759e1430351f0348778fdb3e313cc5db5733ac5/src/WiseApi.Client/Services/BalancesApi.cs

### 8.3 fightmegg/transferwise

Old MIT-licensed Node.js client using `node-fetch`, bearer tokens, legacy host `https://api.transferwise.com`, and legacy `/borderless-accounts?profileId=...`. The last confirmed default-branch commit was `3515c1ea9500ab869c5333b6d3210b04f418d477` (2020-12-03); do not use it as the current collector's foundation.

- https://github.com/fightmegg/transferwise/tree/3515c1ea9500ab869c5333b6d3210b04f418d477

## 9. Read-only scopes and write-endpoint isolation

### Current personal-account position

No read-only API tokens/scopes issuable by personal-account holders were confirmed. A design assuming safety merely from storing a read-only-scoped token therefore does not currently hold.

Collectors validating personal internal transport must be completely separate from public Platform clients. Initial inventory observes only requests naturally generated by the user's normal UI operations, enforcing the following.

- Allowlist candidates are only `GET` on confirmed hosts and paths corresponding to Home balances, Activity list/detail, card status, and existing statement metadata. Do not replay unconfirmed paths.
- Initially reject all `POST`/`PUT`/`PATCH`/`DELETE`, including GraphQL/RPC that appears read-only.
- Reject recipient/beneficiary, quote, conversion, transfer, funding, card-control, Jar-movement, and profile/security/notification-settings paths regardless of method.
- Do not follow redirects automatically; reassess host/path/method. Stop for 401/403/SCA/OTT/429 without replaying session refresh, MFA, or device challenges.
- Extract only allowlisted balance/transaction/status/fee/FX fields in memory. Never emit IDs, counterparties, references, account/card details, or cookies/tokens to logs/artifacts.

Session/token issuance and renewal are unconfirmed. Do not equate login-bundle XSRF/OTT routes with personal-data bearer credentials. Assess session replay using only credential **types and presence of renewal events**, without saving actual Set-Cookie/Authorization values.

### If contracted APIs become available

Use a small adapter like the following, rather than exposing the entire Wise client library to read-only collectors.

Allowlist candidates:

- `GET /v2/profiles` (do not persist PII after selecting the personal profile).
- `GET /v4/profiles/{profileId}/balances?types=STANDARD,SAVINGS`.
- `GET /v1/profiles/{profileId}/balance-statements/{balanceId}/statement.*`.
- Card-transaction GET only if needed; do not store card identifiers.

Mandatory denials:

- All HTTP `POST`, `PUT`, `PATCH`, `DELETE`.
- `/transfers`, `/recipients`, `/quotes`, `/balance-movements`.
- Balance/card creation/deletion/status, PIN, spending permissions.
- Funding, conversion, sending, direct debit, webhook subscriptions.

Implementation requirements:

- Allowlist host/method/path through an egress proxy; recheck redirect destinations.
- Store tokens/refresh tokens in a secrets manager, never logs/URLs/artifacts.
- Schema-validate responses; exclude profile/card/account identifiers and PII from collector logs.
- Where provider-enforced read-only scope exists, such as Open Banking `accounts`, use it alongside the application allowlist.
- Hand off or stop when SCA/OTT is required; do not bypass automatically.

## 10. Runtime suitability

| Runtime                   | Suitability                    | Reason                                                                                                              |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers        | Conditional                    | Lightweight for authorized bearer REST GETs; no personal-account token and cannot perform passkey/browser login     |
| Cloudflare Containers     | C/D experiments only           | Full browsers possible; Cloudflare egress, ephemeral disk, bot protection, reauthentication are instability factors |
| Ordinary OCI container    | First C/D experiment candidate | Easier management of Playwright, pinned browser builds, and locally encrypted sessions                              |
| Kubernetes                | Unsuitable                     | Operationally excessive for one personal account; distributed IPs/sessions may worsen fraud decisions               |
| Local interactive browser | Best for live validation       | User completes passkey/2-step/password reentry and checks UI state                                                  |

Workers can handle REST GET through V8 isolates/Fetch API, but do not put sessions in global state. If contracted OAuth requires mTLS, Workers mTLS bindings are candidates; however, client-certificate requests to Cloudflare-proxied origins have restrictions, so validate against actual Wise mTLS hosts beforehand.

Containers offer outbound host allowlists and Worker-side credential injection, but disk resets on sleep/restart. Do not persist browser profiles on container disks.

- https://developers.cloudflare.com/workers/reference/how-workers-works/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/
- https://developers.cloudflare.com/containers/platform-details/architecture/
- https://developers.cloudflare.com/containers/platform-details/outbound-traffic/

## 11. Automation levels and costs

Use only PR #5's common definitions.

- **A**: official documented/export API suitable for scheduled headless operation.
- **B**: stable read-only internal API with renewable/reusable sessions.
- **C**: headless replay seems possible after browser/app bootstrap.
- **D**: full browser/device automation required.
- **E**: manual capture is the safe default.
- Cost ranges from 1 (small wrapper) to 5 (device-bound/adversarial automation).

### Current assessment

| Route                         | Level       |  Cost | Assessment                                                                        |
| ----------------------------- | ----------- | ----: | --------------------------------------------------------------------------------- |
| Manual Web/app export         | **E**       | **1** | Recommended; official, broad formats, 365-day chunks                              |
| Personal self-service API     | —           |     — | No token/OAuth issuance route confirmed                                           |
| Contracted OAuth/Open Banking | A           |   3–5 | Technically best, with partnership/regulatory cost; outside personal MVP          |
| Authenticated Web replay      | C candidate |     4 | Public login transport confirmed; personal read paths/session renewal unconfirmed |
| Full browser automation       | D           |     4 | Cloudflare/fraud signals, passkeys/2-step, password reentry                       |
| Official Android app replay   | D candidate |     5 | Split APK/transport/device binding/pinning/integrity unconfirmed                  |

Use **E / cost 1 as the source record's representative rating**.

## 12. Read-only live validation

### Completed in public state only

- Current official Help/API documentation wording and URLs.
- DNS/response headers for `wise.com`, login, and `api.wise.com`.
- Unauthenticated API returns 401 without data.
- Current login Next.js bundle acquisition, hashing, formatting, identity/XSRF/OTT/device-challenge call sites.
- Unauthenticated personal UI routes redirect to login and do not serve personal read chunks.
- Official Play package/version/update date and the barrier of unavailable legitimate split APKs/toolchain.
- No Wise among open Chrome tabs; no login/runtime trace started.
- Public repository commits, licenses, transport/auth/write surfaces.

### Next checks with the user present

Check only screen presence, formats, and schemas without recording values.

1. Confirm no API-token menu in the personal profile; do not switch to Business.
2. Reload Home once, mapping balance/Jar/Assets/card types only to their read requests' method/host/template path/status/pagination keys/schema keys.
3. Open one Activity list/detail each; confirm **presence only** of pending/posted/cancelled/refund, stable IDs, and fee/FX fields. Do not navigate to recipient filters/lists/settings.
4. Record only session credential types, renewal events, and new-device challenge presence. Do not record cookie/header/token values, retain long-lived sessions to measure lifetime, or manually replay refresh requests.
5. Check the 365-day limit, currency/Jar, formats, and fee-separate option on Statement creation screens.
6. Check Transactions filters/CSV-PDF options. Download only on explicit user instruction.
7. In Security settings, check only currently available method names; no additions/deletions/default changes.
8. Browser DevTools records only request method/host/template path/status/schema keys; no headers/bodies/cookies/tokens/IDs/amounts/transaction contents.
9. Check all official Play app splits and signer/versionCode through section 7.3; inventory static host/path/schema/session/device/integrity/pinning candidates. Limit runtime to section 7.4 metadata.
10. If export samples are needed, use fully sanitized header-only samples created locally by the user. Do not place actual transaction files in the repository/issues.

### Stop conditions

Stop immediately on any of the following.

- UI/API leading to sending, conversion, deposits/withdrawals, recipient creation, Jar movement, Assets trades, card freeze/status/PIN, or profile/security changes.
- Passkey/API-token/2-step-method creation, deletion, reset, or default changes.
- Exposure of OTPs, passwords, passkeys, recovery codes, tokens, cookies, card/account identifiers, or PII in chat/logs/traces.
- CAPTCHA, Turnstile, reCAPTCHA, account restrictions, fraud warnings, device verification.
- 403 SCA, 401 reauthentication, 429, unexpected redirects, or unexpected non-GET requests. Do not execute apparently read-only GraphQL/RPC `POST` until safety is proven.
- Cloudflare/fraud-control bypass, stealth, or fingerprint spoofing becomes necessary.
- Disabling pinning/integrity/root/debugger detection or hooking secrets/headers/bodies becomes necessary.
- Export becomes email delivery and would send externally without explicit user action.

The user completes login/2-step directly in official UI; the agent receives no secrets. Do not retry repeatedly after failure; recheck current account state before ending.

## 13. Confirmed, inferred, and unconfirmed

### Confirmed

- Personal-account Web/app can export currency/Jar statements in 365-day intervals.
- Web supports PDF/XLSX/CSV/MT940/QIF/CAMT.053; app supports PDF/CSV/XLSX.
- Transactions CSV/PDF download is Web-only, up to 365 days.
- Pending/completed distinctions and reserved-funds models exist.
- Wise offers passkeys and app/TOTP/SMS and other 2-step verification.
- Current Personal API Tokens are for Business accounts.
- Platform OAuth/Open Banking require partnership/mTLS, etc.
- Cloudflare edge, `__cf_bm`, and public challenge/fraud dependencies exist.
- Current public login builds have identity routes for XSRF cookies/headers and login/OTT/passkey/device challenges, but unauthenticated builds lack personal balance/activity routes.
- Official Android package is `com.transferwise.android`; observed official-listing version is 9.38.0.
- Public clients implement bearer HTTPS REST; some include write endpoints.

### Inferences

- Standard WebAuthn makes Bitwarden passkey compatibility likely, but it is unconfirmed in Wise's official compatibility list.
- Read-only internal-API replay after browser bootstrap may be technically possible.
- OCI browsers make fixed sessions/egress easier than Cloudflare Containers.

### Unconfirmed

- Regions/legacy accounts exceptionally providing personal-account read-only API tokens/OAuth.
- All Web CSV/XLSX columns, encoding, row limits, stable IDs for the same transaction.
- When pending card transactions enter statements and later finalization/cancellation differences.
- Assets holdings-statement formats across personal-account regions and API unit/cost-basis coverage.
- Export distinctions among multiple physical/digital cards and card-filter identification.
- Authenticated Web/mobile hosts, endpoints, pagination, session/refresh lifetimes.
- Legitimate Play split-APK versionCode, hashes, signer, manifest, hosts/paths/schemas.
- Web/app transport differences, device binding, mobile TLS pinning, Play Integrity/App Attest use.
- Cloudflare challenge/fraud-rule trigger conditions.
- Official support for the Wise/Bitwarden combination.

Do not rate the personal-account collector API level A/B until these are confirmed.

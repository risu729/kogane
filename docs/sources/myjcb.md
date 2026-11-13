<a id="myjcb-カードファミリー調査"></a>

# MyJCB card-family research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

- Research date: 2026-08-26 (Australia/Sydney)
- Scope: personal cards accessible through the same MyJCB/related backends, chiefly JCB W, リクルートカード（JCB） (Recruit Card JCB), みずほ JCB デビット (Mizuho JCB Debit), 京銀 JCB デビット (Kyoto Bank JCB Debit) in the current inventory.
- Excluded: Visa/Mastercard Recruit, JCB-branded cards unsupported by MyJCB, bank-account transactions themselves, card applications/payments/settings and other writes.
- Research limits: initial 2026-08-26 research used only logged-out official public information/responses/code. On 2026-08-31, the user normally passkey-logged into the first MyJCB ID in dedicated Kuebiko Chrome; sanitized read routes/response schemas/formats were added. No actual account/MyJCB IDs, card numbers, names, balances, usage amounts, merchants, Cookies, WebAuthn assertions, OTPs, or security phrases were saved to Git/public docs.

<a id="結論"></a>

## Conclusion

MyJCB is not app-only; Web provides core statements, available amounts, points, and card information. Finalized monthly statements download as PDF/CSV/OFX for up to 15 months; screens including unfinalized data cover up to 17 months. Unfinalized statements cannot be exported until finalization around the 24th monthly. No published fixed maximum row count was found.

Multiple cards are not cards added to one account. Each has a MyJCB ID; only permitted combinations switch through `おまとめログイン` (combined login). Primary-member statements group family/ETC/QUICPay additional-card usage by card, while family IDs cannot combine or download PDF/CSV. Separate root cards corresponding to MyJCB IDs from additional cards within their statements.

No official account/statement API is public. A third-party implementation updated in 2026 isolates dynamic login-protection JavaScript, POSTs ID/password forms, and reuses Cookies/User-Agent for JCB debit HTML GETs. This establishes feasibility, but unofficial HTML, dynamic protection, security phrases/OTPs/passkeys, and issuer differences give common **C, cost 4**. Safe default is manual finalized export **E, cost 1**. Full-app UI is **D, cost 5**, but official-APK static analysis/deobfuscation and user-operated read-only runtime/communication tracing remain useful for transport/issuer boundaries, not categorically excluded.

<a id="公式サーフェスとカード列挙"></a>

## Official surfaces and card enumeration

<a id="myjcb-webアプリ"></a>

### MyJCB Web/app

- [Official MyJCB guidance](https://www.jcb.co.jp/myjcb/) confirms Web statements, usage/available amounts, points/card information, and per-card ID registration. Apps add biometrics/passcodes, push, J/Secure app authentication; retrieval is not app-only.
- [MyJCB features](https://www.jcb.co.jp/myjcb/feature/index.html) includes statements, available amounts, points, family/ETC/QUICPay information. Adjacent payment-method changes, cash advances, limits, additional cards, point exchanges are writes; collectors must not crawl whole menus.
- [MyJCB app](https://www.jcb.co.jp/myjcb/app/) supports amount/date/keyword searches, family/ETC filtering, combined-card switching. Official Android package [`jp.co.jcb.my`](https://play.google.com/store/apps/details?id=jp.co.jcb.my); iOS [App Store ID 1097001344](https://apps.apple.com/jp/app/myjcb/id1097001344). Public Play requires OTP alongside initial ID/password; official guidance currently supports Android 11+.
- [Eligible MyJCB cards](https://www.jcb.co.jp/myjcb/pop/available-card-list.html) generally begin 354, 355, 3573, with some debit/partner/corporate exclusions. Do not collect numbers to classify eligibility; check existing MyJCB displays/issuers.

<a id="idルートカード追加カード"></a>

### IDs, root cards, and additional cards

- [Combined login](https://www.jcb.co.jp/myjcb/pop/omatome-login.html) switches another ID's card display after login without reauthentication. Each ID/password remains; statements/available amounts remain per card.
- Family cards cannot combine. JCB Group pairs generally qualify, but debit combinations are restricted to same-issuer debit/credit or JCB-issued credit. Do not assume cross-issuer debits such as Mizuho/Kyoto can combine. Security/contract decisions may prevent switching.
- Primary-member [statement guidance](https://www.jcb.co.jp/usage/structure/check/index.html) displays number/name/member/subtotals per card, ETC per card, multiple QUICPay per product. Embedded QUICPay may appear in parent-card descriptions.
- [Official family-card guidance](https://www.jcb.co.jp/ordercard/family_card/family_card.html) combines family usage in the primary payment account/statements. Do not duplicate family IDs as roots; use primary-statement `ご利用者` (user)/card categories as subcard boundaries.
- Storage IDs are local UUIDs. No MyJCB IDs/card numbers/last four digits/names as keys/logs/metrics. Allowlist only generic product names such as `JCB W`; discard personalized labels.

<a id="対象カード別の経路と発行会社差"></a>

## Card routes and issuer differences

| Card                    | Primary statements                                                                              | Additional cards/payment                                                       | Points/benefits                                                                                                                                                                                                    | Combined-login caveat                                                                                                                                                          | Recommended retrieval                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| JCB W                   | MyJCB Web/app                                                                                   | Credit; family/ETC/QUICPay within parent statements                            | [JCB W](https://www.jcb.co.jp/ordercard/kojin_card/os_card_w2.html) gives 2 J-POINT per 200 yen; balances/expiry in MyJCB/finalized statements                                                                     | JCB-issued root ID; numberless initial registration/number checks need app, statements accessible on Web                                                                       | Monthly finalized CSV/OFX; Web unfinalized only if needed |
| リクルートカード（JCB） | [Recruit Card guide](https://recruit-card.jp/guide/) → JCB member pages/MyJCB                   | Family use combines in primary statements                                      | Normal 1.2%; [official JCB points guidance](https://www.jcb.co.jp/myjcb/pop/recruit-point.html) says リクルートポイント (Recruit Points) differ from J-POINT, balance on Recruit My Page; MyJCB alone insufficient | JCB only; Visa/Mastercard separate backend. JCB-issued candidate, existing combination needs live check                                                                        | Statements MyJCB; points separate connection              |
| みずほ JCB デビット     | MyJCB or [Mizuho Wallet](https://www.faq.mizuhobank.co.jp/faq/show/3774?site_domain=default)    | Immediate debit/single payment; up to 8 family cards combine in parent account | [Official Mizuho](https://www.mizuhobank.co.jp/jcbdebit/info/index.html) gives 0.2–0.4% account cashback by usage tier, not J-POINT; Wallet shows next rate                                                        | Different from Mizuho **Smart Debit**, explicitly excluded from combined login/passkeys, etc.; do not generalize to ordinary JCB Debit                                         | MyJCB debit/difference statements; bank balances excluded |
| 京銀 JCB デビット       | [Official Kyoto Bank](https://www.kyotobank.co.jp/kojin/jcbdebit/) → MyJCB (bank app deep link) | Immediate debit/single payment; family cards, no ETC                           | 1 J-POINT per 200 yen, MyJCB inquiry; Oki Doki→J-POINT in 2026                                                                                                                                                     | Kyoto is on [JCB Group list](https://www.jcb.co.jp/pop/group-list.html), but MyJCB bank-balance display explicitly excludes Kyoto Bank/京銀カードサービス (Kyoto Card Service) | MyJCB debit/difference statements; bank balances excluded |

Do not infer issuers from card names. The user checks card-back/generic MyJCB issuer displays without recording values. Enumerate existing combined cards read-only; collectors never add unconfigured cards.

<a id="明細の状態粒度期間export"></a>

## Statement status, granularity, periods, and export

<a id="クレジット明細"></a>

### Credit statements

- [Official extended-inquiry guidance](https://www.jcb.co.jp/release/myjcb-statement.html) covers 1–2 unfinalized plus 1–15 finalized months, up to 17. Registration timing/no usage/card changes may limit to 7–15.
- [Statement guidance](https://www.jcb.co.jp/usage/structure/check/index.html) gives finalized PDF/CSV/OFX up to 15 months; unfinalized downloads only after monthly finalization around the 24th. Screens reflect merchant sales received by JCB; delays can shift into later months.
- [CSV caveats](https://www.jcb.co.jp/processing/share/csv.html): primary members/monthly billing/finalized only. Revolving/installments include monthly payment and new usage amounts; generally reflect changes/corrections through previous-day 20:00. Merchant strings may truncate/garble.
- Fixed official row maxima unconfirmed. Do not assume limits; one billing month per acquisition, validate EOF/totals/HTTP completion. Save finalized files monthly because older-than-15-month reacquisition is unavailable.
- Minimum fields: use date, user/card category, merchant, amount, payment method, descriptions/remarks. Overseas adds local amounts/rates/conversion dates; installments count; revolving/cash advances types. Limits, outstanding usage, next-12-month installment schedules are separate snapshots, not transaction rows.
- Cancellations/refunds need not merely overwrite originals. [Official examples](https://www.jcb.co.jp/usage/structure/check/index.html) show negative cancellation rows alongside `お支払済み分 ご返金額` (refund for paid amounts). Do not deduplicate by merchant alone; combine root/subcard, status, date, amount, payment type, description, same-month ordinal.
- Unfinalized data is mutable snapshots promoted to finalized; do not overwrite unfinalized/finalized rows under one permanent ID. Preserve reconciliation results.

<a id="デビット明細"></a>

### Debit statements

- Immediate holds/debits may later change through settlement/cancellations/FX. [JCB Debit model terms](https://www.jcb.co.jp/apl/pdf/guest/entry/agree/member/jcb_meigin_db_P1.pdf) specify refunds where settled sales are below holds and later refunds after merchant cancellations.
- Besides ordinary details, MyJCB has `JCB デビット差額取引分・その他ご利用明細` (JCB Debit difference transactions/other usage). See Mizuho [statement guide](https://www.jcb.co.jp/myjcb/pop/offlinedebit_meisai_mizuhobk.html) and Kyoto [usage guide](https://www.kyotobank.co.jp/kojin/jcbdebit/pdf/jcbdebit_guide.pdf).
- 2026 public-code HTML columns: ordinary `ご利用者／お振替日／ご利用先など／お振替金額／摘要／承認番号` (user/debit date/merchant/debit amount/description/authorization); differences `ご利用者／差額発生日／ご利用先など／差額／摘要／お取引結果／承認番号` (user/difference date/merchant/difference/description/result/authorization). Third-party observations, not official schemas.
- Treating difference rows other than `銀行振替済` (bank transfer completed) as in-progress/excluded from permanent transactions is conservative, but the official full status set is unknown. Stop on unknown values until anonymized live read-only status validation.

<a id="認証mfa端末passkeybitwarden"></a>

## Authentication, MFA, devices, passkeys, and Bitwarden

<a id="確認済み事実"></a>

### Confirmed facts

- Standard Web uses per-card MyJCB ID/password. [Registration guidance](https://www.jcb.co.jp/myjcb/how-to-use/) specifies 6–20 characters; unusual environments may require [`秘密の合い言葉`](https://www.jcb.co.jp/myjcb/pop/secret-qa.html) (secret security phrase). Forgotten phrases have registered SMS/email MyJCB OTP routes.
- Initial app login adds OTP. Later fingerprints/faces/app passcodes are app easy login, not equivalent to Web passkeys.
- [MyJCB passkey](https://www.jcb.co.jp/myjcb/how-to-use/passkey/) works on Web/app using device biometrics/PIN/pattern. Registration disables ID/password login for that ID. Other devices use QR scanning with passkey-holding devices, sometimes Bluetooth. Enrollment may require OTP/identity-document photos.
- Eligibility includes 354 personal credit, conditional 355, 357 personal debit and JCB Group/some partners. Mizuho Smart Debit explicitly excluded; ordinary Mizuho JCB Debit not categorically excluded.
- Biometrics are not sent/saved to MyJCB; keys can stay on-device or cloud-sync. Official examples are iCloud Keychain/Google Password Manager. Long inactivity may remove passkeys; MyJCB removal leaves device keys.
- J/Secure OTP/app auth is online-purchase 3-D Secure, distinct from read-only collector login.

Per-card passkey boundaries follow. Do not acquire numbers; ultimately confirm existing screens offer passkeys.

| Card                    | Official-condition relationship                                                                | Current assessment                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| JCB W                   | Consistent with 354 personal/JCB-issued credit eligibility                                     | Candidate; check existing ID offering                        |
| リクルートカード（JCB） | Eligible if JCB-issued/number-contract conditions met                                          | Product name insufficient; Visa/Mastercard entirely separate |
| みずほ JCB デビット     | Consistent with 357 personal debit; exclusion names Mizuho Smart Debit, not ordinary JCB Debit | Candidate; issuer screens unconfirmed                        |
| 京銀 JCB デビット       | 357 personal debit/Kyoto on JCB issuer list, no explicit exclusion                             | Candidate; issuer screens unconfirmed                        |

Passkey-enrolled IDs cannot password-login, potentially excluding Okura's flow. If only one combined ID uses passkeys, validate root/switch-target/reauthentication combinations live without generalizing.

<a id="bitwarden-と自動化に関する確認結果"></a>

### Bitwarden and automation findings

- **Official:** JCB neither supports nor rejects Bitwarden, naming only Apple/Google examples.
- **Live:** for the first ID, one Bitwarden CLI discoverable passkey (matching RP, counter 0) temporarily injected into a Chrome CDP virtual authenticator produced WebAuthn assertions and reached mypage on Cloudflare Browser Run. This is that ID/time's interoperability, not all issuers/QR cross-device/app WebViews.
- **Inference:** ordinary browser autocomplete makes Bitwarden ID/password autofill likely, but enrolled IDs disable password login; it is not a headless secret-injection alternative.
- Collectors never enroll/remove passkeys, reset passwords, or change OTP destinations. Respect existing user-chosen auth; stop when human operation is required.

<a id="passkey内部通信とbrowser境界2026-08-31-live"></a>

### Passkey internal transport and browser boundary (2026-08-31 live)

Successful Browser Run login showed same-origin dynamic communication without values: `PasskeyLogin`, `loginRouteId` to `userLoginPasskeyServiceStatusCommunication.html`, NNL Apps SDK 9.2.0, opaque `result` to `userLoginPasskeyAuthCheckCommunication.html`, then mypage GET. All 200, dynamic MIME `text/html`. No challenges/assertions/`result`/cookies/headers/queries saved.

The confirmed contract is not direct standard WebAuthn JSON API. Removing browsers requires independently reproducing official NNL SDK `result` envelopes and server-side state/cookies; Workers P-256 signing alone is insufficient. Current PoC uses Browser Run only for login bootstrap, extracting cookies/User-Agent before closing after mypage, then ordinary Worker fetch for menus/details/`detailPastJson`/exports. This handoff/private R2 succeeded in a first-ID live run.

Browserless operation is not ruled out, but capture alone does not classify `result` as JSON/JWT/ciphertext. Implement by (1) privately correlating NNL versions, WebAuthn requests/responses, `result`, cookies/relay state across successes; (2) comparing challenge-dependent versus fixed envelopes/integrity/transaction-SDK metadata/extensions/risk signals; (3) porting standard WebAuthn to Workers Web Crypto with byte-exact tests; (4) independently implementing only observed NNL/JCB serialization/state machines. Never infer `clientDataJSON`, RP hashes, UP/UV/BE/BS, counters, extensions, ES256 representations merely from identical keys.

Keep direct clients separate from browser bootstrap modes; test fresh challenges, single use, replay rejection, RP/origin mismatch, expiry, consecutive Cron, NNL drift. Fail closed for unknown SDKs/responses/redirects/step-up; no same-run browser fallback duplicating auth. Reuse existing post-mypage cookie jars/read allowlists/statement clients/R2. Remove Browser bindings separately only after card/period/artifact parity. No analysis challenges/assertions/cookies/`result`/statement values in public repo/Worker logs/R2. Detailed sequence/done-when is in `services/collector-myjcb/README.md`.

<a id="web-保護wafakamai"></a>

## Web protection, WAF, and Akamai

- On 2026-08-26, unauthenticated HEAD/DNS for public `www.jcb.co.jp` showed Cloudflare CNAME/IP, `server: cloudflare`, `cf-ray`. Public edge evidence, not login-backend authentication.
- `my.jcb.co.jp/Login` uses another IP/`server: nginx`. Public GET on 2026-08-26 returned `200`, Windows-31J HTML, form `POST /iss-pc/member/user_manage/Login`, static `userId`, `password`, `screenId=0102001`, `loginRouteId=0102001`. Passkey JS loads from the same anonymous HTML.
- HTML first loads `/apl/login-prot.js?init`. Observed init was about 22 KB, `no-cache/no-store`, `X-Ion-Hop: 1`, `Via: 1.1 google`, JCB cookie; it loaded `/apl/login-prot.js?async...` with temporary query seed. Async about 303 KB. No actual seeds/cookies/generated fields recorded.
- Public init is consistent with instrumenting target-origin/path POSTs and handling submission after async initialization. Okura retrieves both/cookies in one HTTP session and executes in limited DOM to obtain actions/bodies/cookie updates. Only at least six dynamic field types were verified; no fixed field-name/value contract.
- **Akamai unconfirmed.** Public `www` is Cloudflare; auth-host evidence is insufficient for Akamai. Do not infer F5/Shape/Akamai from `X-Ion-Hop`/dynamic cookies alone.
- Scripts/cookies/headers/redirects/step-up can change. Stop rather than bypass 403/429/challenges/form drift. Public formatting/deobfuscation/static control-flow-DOM-API dependencies are allowed, never for modifying bot decisions/disabling controls.

<a id="公開-third-party-client-の具体的実装"></a>

## Concrete public third-party clients

<a id="現行に近い実装"></a>

### Near-current implementation

- AGPL-3.0 [youseiushida/Okura](https://github.com/youseiushida/Okura) research main was [`afc6057f`](https://github.com/youseiushida/Okura/commit/afc6057fba78b5bfd6364654548fbfd91c76692a) (2026-08-25). Deno/TypeScript JCB adapter defaults to `https://my.jcb.co.jp`.
- Evidence: [`login.ts`](https://github.com/youseiushida/Okura/blob/afc6057fba78b5bfd6364654548fbfd91c76692a/app/internal/adapter/jcb/login.ts), [`protection_runtime.js`](https://github.com/youseiushida/Okura/blob/afc6057fba78b5bfd6364654548fbfd91c76692a/app/internal/adapter/jcb/protection_runtime.js), [`authentication.ts`](https://github.com/youseiushida/Okura/blob/afc6057fba78b5bfd6364654548fbfd91c76692a/app/internal/adapter/jcb/authentication.ts), [`adapter.ts`](https://github.com/youseiushida/Okura/blob/afc6057fba78b5bfd6364654548fbfd91c76692a/app/internal/adapter/jcb/adapter.ts).
- Transport/auth:
  1. `GET /Login`.
  2. Extract same-origin `/apl/login-prot.js?init...`; retrieve with same jar/browser User-Agent.
  3. Retrieve dynamically indicated `/apl/login-prot.js?async...` in same session.
  4. Execute both in a Deno `none`-permission Worker using Node `vm`/limited DOM: `navigator.userAgent`, screen, Web Crypto, document cookies, form/events; no host network/file/env permissions.
  5. Recover submitted `userId`, `password`, `screenId`, `loginRouteId`, at least six dynamic fields/cookie updates. Verify same-origin login action/unchanged credentials.
  6. `POST /iss-pc/member/user_manage/Login` (`application/x-www-form-urlencoded`) with Origin/Referer/same generated User-Agent; reject non-mypage responses.
  7. Validate session with `GET /iss-pc/member/mypage/mypage.html` logout/debit-detail links.
  8. Only after validation capture/restore cookie name/value/domain/path/expiry/security with User-Agent; revalidate mypage after restore, distinguishing expired/unexpected/403.
  9. `GET /iss-pc/member/debit/details/debitDetailMenu.html?link_id=myj_main_debitDetailMenu`, then `GET /iss-pc/member/debit/details/debitDetail.html?seq=N`; parse 15 HTML cycles.
- **Debit-only**: no JCB W/Recruit credit, finalized CSV/PDF/OFX, combined-ID switching, passkeys/security phrases/OTP. No official guarantee/all-issuer compatibility inference.
- Validator requires logout and `toNaviDebitDetailMenu`, rejecting valid credit-only sessions; not a general credit validator. Protection also uses `node:vm`/handwritten DOM shim beyond Deno isolation. [Cloudflare Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#non-functional-stub-modules) calls `node:vm` importable but nonfunctional. It cannot port unchanged to plain Workers; this PoC executes official pages in Browser Run, considering Containers only if needed.
- No refresh/renew endpoint. Restore only while cookie+User-Agent valid; expiry requires fresh login. Dynamic protection fields are not established CSRF; post-login hidden/local state is not snapshotted.

<a id="古い実装"></a>

### Old implementations

- [takeruko/gas-myjcb-detail-checker](https://github.com/takeruko/gas-myjcb-detail-checker) (2015) directly POSTs ID/password, reuses Set-Cookie for monthly PDF/CSV through Apps Script. Predates protection, inactive/no license shown; link-editor-public files make reuse prohibited.
- [swdyh/add-to-zaim](https://github.com/swdyh/add-to-zaim) (2013) Chrome extension extracts date/amount/merchant by XPath from authenticated DOM; not API, no current DOM compatibility.
- These consistently use cookie HTML/export/DOM rather than public APIs.

<a id="readexportおまとめ切替の-transport-候補"></a>

### Candidate read/export/combined-switch transport

| Function                                    | Concrete candidate                                                                                    | Confidence/next checks                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Debit read                                  | Okura `debitDetailMenu.html?link_id=...` → `debitDetail.html?seq=N`                                   | Current public code; live success on Mizuho/Kyoto issuers and IDs without a passkey unconfirmed                            |
| Credit read                                 | `/iss-pc/member/details_inquiry/detailMenu.html?link_id=...` → `detail.html?detailMonth=N&output=web` | User GET confirmed 2026-08-31; initial HTML `0..8`, past API only account-available `9..17`                                |
| Past-month availability                     | `POST /iss-pc/general_json/member/details_inquiry/detailPastJson.json`                                | `detailAPI.js`/user operation confirm JSON-RPC; stop on missing hidden discriminator/API failure, no blind scanning        |
| PDF export                                  | `/iss-pc/member/details_inquiry/detailDbPdf.html?detailMonth=N&output=pdf`                            | Finalized GET/`%PDF-1.4` confirmed 2026-08-31; `detailNewspdf.html` is notice, not statement                               |
| CSV export                                  | `detail.html?detailMonth=N&output=csv`                                                                | GET, Windows-31J/CP932, exact 12-column header after metadata confirmed 2026-08-31                                         |
| OFX export                                  | `detail.html?detailMonth=N&output=money`                                                              | GET/OFX 1.x credit-card group confirmed 2026-08-31                                                                         |
| Combined-card enumeration                   | Mypage `ID切替` (switch ID) → card-display switch screen                                              | Official UI confirmed; inspect routes/generic issuers-types only, no names/IDs/numbers saved                               |
| Existing combined-ID switch                 | Existing card-select action                                                                           | Candidate session current-card-context change, not financial trade; one replay only after method/hidden/CSRF/return checks |
| Combined enrollment/removal/default display | Settings screen                                                                                       | Write; never call even if transport discovered                                                                             |

Credit read/export contracts were reconfirmed on 2026-08-31 for one first-ID moment. Inspect links/schemas/controls for every other issuer/ID. Use only `detailMonth` values present in HTML/availability APIs; save no card selectors/financial values publicly.

<a id="csrf-と-session-renewal-の確認点"></a>

### CSRF and renewal checks

- Protection generates at least six dynamic login fields, with unpublished purposes; do not assume CSRF/bot/integrity classification.
- Current credit CSV/PDF/OFX are GET. For unknown POSTs such as switching, inspect only hidden/header/cookie **presence, hashed names, lengths, rotation timing**, no values. Stop GET replay if tokens are shared with state-changing actions.
- Snapshot only after auth validation, always paired with User-Agent. Okura's fixed Chrome 140 will age; verify it matches protection-generating browser/approved UA live.
- Check Expires/Max-Age, idle/absolute timeouts, switching rotation, logout invalidation as metadata. Long-lived protection cookies do not establish authenticated lifetime.
- No refresh/renew endpoint found; no assumed silent renewal. Expiry uses user-assisted reauth. Never try password replay on passkey IDs; assess existing browser/app session capture only.

<a id="公式-apk-の入手静的解析runtime-tracing"></a>

## Official APK acquisition, static analysis, and runtime tracing

[Official Google Play listing](https://play.google.com/store/apps/details?id=jp.co.jcb.my) shows `jp.co.jcb.my`, official JCB, updated 2026-07-27, version 3.11.1. Anonymous Play delivery returned HTTP 429 locally/on OCI; no authenticated emulator or owner Android connected, so no legitimate current 3.11.1 splits/bundles acquired.

For reproducible static research, on 2026-08-31 acquired mirror 3.9.0 (versionCode 3901, 20 splits) through `apkeep 1.0.0` APKPure, saving artifacts/hashes/certificates/JADX-apktool/procedures privately. All splits matched package/versionCode/signer and passed Google Source Stamp verification. Still mirror provenance, without independent current official 3.11.1 signer comparison; not the same established trust chain/implementation. Never reproduce private artifacts/certificates/decompiled code in public Kogane.

3.9.0 findings:

- JADX 1.5.6 produced 18,085 source/2,758 resource files, exit 3/177 method errors, but readable app/API interfaces.
- Apktool 3.0.3 produced 22,195 files, exit 0; 80 base-only split-resource warnings.
- Two ordinary DEX files; no encrypted-DEX decryption/runtime dumps needed.
- Native Retrofit/OkHttp/Moshi JSON client, not WebView wrapper; historical primary `https://imad.jcb.co.jp/v1/`. Interfaces for latest/monthly credit, debit, points, notifications, card switching/security; monthly detail takes year-month. Retention/authenticated schemas untested.
- Passkey/FIDO uses Nok Nok SDK/AndroidX Credential Manager with separate registration/auth endpoints. Packaged defaults can handle server-requested Play Integrity, keystore attestation, jailbreak risk, location, Wi-Fi SSID, in-call, metrics, credential providers; actual MyJCB server requests unobserved.
- Production security config uses system CAs/no cleartext. No static OkHttp `CertificatePinner`/production trust-all path found; dynamic/native checks/current 3.11.1 unconfirmed.
- `libsigner.so` belongs to Adjust analytics, not proof of MyJCB API signing.

App JSON remains a worthwhile separate fallback if Web fails; year-month credit may support backfill. Prioritize Web Browser Run with existing Bitwarden passkeys; proceed to app APIs only if Web passkey/session modes fail. No scheduled-app feasibility claim before user-operated validation of bootstrap/server FIDO-Integrity/session renewal/schemas/retention.

Next legitimate-current-artifact experiment:

1. Check official Play developer/package and install/update on managed Android.
2. Read-only `adb shell pm path jp.co.jcb.my`; pull base/splits to owner-authorized analysis hosts. Evidence manifests contain only APKs/signing certificates/split SHA-256/versionName-versionCode/acquisition times.
3. `apksigner verify --print-certs`, `apkanalyzer manifest print`/`aapt2 dump` check signatures, SDKs, permissions, exported components/deep links/providers-services-receivers, `android:networkSecurityConfig`, debuggable/backup.
4. `jadx --deobf`, resources/native symbols-strings give readable local class names and identify official hosts/WebViews/transports/models/Room-SQLite/export/issuer flags. Deobfuscation itself permitted.
5. Record `CertificatePinner`/TrustManager/hostname verifiers, `network_security_config.xml`, Play Integrity/attestation/root-hook detection **presence/call sites**. No disabling/return modification/detection bypass.

One user-operated read-only tracing session is also in scope.

- If legitimate apps accept Android Studio profiler/Network Inspector attachment, observe only process/thread/class/method, host/method/path template/status/content-type and schema-field hashes.
- Attachable Java/native hooks record only read-call argument/return **types, lengths, field names**, no values or changed returns/control flow. Stop if root/debug modifications/anti-hook-Integrity bypass is needed.
- Only normal user-CA trust permits owner-proxy redacted HTTPS metadata. If pinning rejects, return to DNS/SNI/IP/TLS timing/static graphs without bypass.
- Normally retain no logcat/crash dumps/screenshots/HAR-pcap/analytics exports because they may contain secrets/PII/statements. Redact route/schema metadata immediately and discard raw traces.

Static/no-op tracing identifies Web/app hosts/schemas/issuers, passkey bootstrap/switching/read-export. Without writes/bypasses, Web availability alone does not make this research poor value.

<a id="readwrite-隔離"></a>

## Read/write isolation

Allow only existing-session validation, card-display lists, statements, points/history, available/outstanding snapshots, official exports, temporary display switches among existing combined cards. Allowlist method/form action/field names/expected response/page classes as well as URLs because writes are adjacent.

Prohibited:

- Combined enrollment/removal/default-card changes
- MyJチェック (MyJ Check) enrollment/removal
- Revolving/installment/skip changes, early repayment, payment changes, cash advances
- Limits, card locks, notifications, address/phone/email changes
- Family/ETC/QUICPay applications/cancellations, card switching/reissuance
- Points exchange, MyJCB Pay, campaign registration, J/Secure purchases
- Passkey enrollment/removal, password reset, OTP issuance except explicit user-operated read-only login continuation

Methods alone do not classify effects. Login/export/existing-display-switch POSTs may be read-workflow candidates only after user-observed origins/paths/field allowlists/CSRF-state/expected redirects-responses/no-follow behavior, isolated in separate components. Separate routes from combined **settings** changes. Reject unclassified POST/PUT/PATCH/DELETE.

<a id="実行環境適性"></a>

## Runtime suitability

| Environment                     | Suitability                   | Reason                                                                                                                                                                                                                                                           |
| ------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers (fetch only) | Conditional                   | Legacy replay/finalized exports possible, but protection requires Node VM/Worker-like limited DOM; cannot complete security phrases/OTP/passkeys. No financial sessions in edge KV/logs                                                                          |
| Cloudflare Browser Run          | Conditional                   | [session reuse](https://developers.cloudflare.com/browser-run/features/reuse-sessions/)/Durable Objects, Playwright-Puppeteer, human interaction suit C; idle expiry, shared-cookie isolation, passkey-QR/PII risks. Not first choice beyond anonymous dev tests |
| Cloudflare Containers           | Suitable                      | [Official Containers](https://developers.cloudflare.com/containers/) supports Linux/amd64 runtimes/filesystems, Deno/Node parsers, isolated workers/browsers; lifecycle-crossing sessions need encrypted external storage                                        |
| OCI container                   | Suitable                      | Digest-pinned parser/browser images; no secrets baked into images/env, use runtime stores/tmpfs/egress allowlists                                                                                                                                                |
| Kubernetes                      | Excessive but suitable        | [Kubernetes image](https://kubernetes.io/docs/concepts/containers/images/) supports digest pinning, Secrets, NetworkPolicy, CronJob, dedicated namespaces; high cost for few cards. Prefer rootless/read-only/ephemeral/one connection per Pod                   |
| Managed Android                 | Good research; costly full UI | Legitimate APK/static/tracing/passkey-issuer checks; steady UI is D/cost 5 for device constraints, drift, attestation, adjacent writes                                                                                                                           |

Never put sessions/cookies/OTPs/statement values in logs/traces/crash dumps/analytics on any cloud. Tags use minimum generic issuer/product names.

<a id="共通-rubric-による評価"></a>

## Common-rubric assessment

Use PR #5 `docs/source-research.md` definitions unchanged.

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper, 5 = device-bound/adversarial

| Route                                                | Level |  Cost | Assessment                                                                     |
| ---------------------------------------------------- | ----: | ----: | ------------------------------------------------------------------------------ |
| Human monthly finalized PDF/CSV/OFX/offline import   |     E |     1 | Official/manual/safest; monthly retention for 15-month limit                   |
| Automated finalized export from existing Web session |     C |     3 | Plausible bootstrap/replay; live export/switch checks needed                   |
| Unfinalized credit HTML (JCB W/Recruit JCB)          |     C |     4 | No export, mutable DOM, switching/step-up/protection                           |
| Mizuho/Kyoto debit HTML/difference details           |     C |     4 | Concrete public transport; issuer/passkey/step-up unconfirmed                  |
| Recruit points/history                               |     C |     4 | Recruit session, separate source/implementation                                |
| MyJCB/bank-app UI                                    |     D |     5 | OTP/biometrics-passkeys/devices/versions/writes                                |
| MyJCB family default                                 | **C** | **4** | Concrete plausible Web bootstrap/replay, not API; operational default E/cost 1 |

No A without public APIs; no B because unofficial HTML/dynamic protection is not stable internal API. Downgrade individual passkey/unknown-challenge/unsupported-issuer connections to D/E where C fails.

Public-JS/APK analysis/redacted user tracing are experiments evaluating C, not acquisition routes with separate levels. Without proven transport/session stability they do not change source ratings.

<a id="read-only-live-検証計画"></a>

## Read-only live-validation plan

One interactive session without saved values. Initially read existing user state, not test fixtures, saving no screens/HAR/HTML/logs.

1. Check official `my.jcb.co.jp`, not `www`, TLS/login screen/auth method only.
2. User logs in through existing method; hand off OTP/security phrases/passkey-QR rather than autofill.
3. Check combined generic products/issuers/switchability only; no spoken/recorded IDs/numbers/names/amounts. No additions.
4. Check root primary/family/ETC/QUICPay boundaries/subtotals; reflect only anonymous `root/subcard/type` schemas.
5. Check unfinalized/finalized month counts, PDF/CSV/OFX controls, family-ID download denial. Save one temporary file only, validate column names/encoding/row-count types, then delete.
6. Check debit ordinary/difference sections, status sets, negative refunds, authorization-number presence as types; values stay in memory.
7. Confirm JCB W J-POINT/Recruit separate points/Mizuho cashback/Kyoto J-POINT sources; no exchange/use screens.
8. Observe login HTML→`login-prot.js?init`→`?async`→form POST. Aggregate hashes/sizes/methods/origin-path/status/Content-Type/cookie-name hashes-attributes/User-Agent match; no seeds/dynamic fields/bodies/cookie values.
9. User performs credit read, PDF-CSV-OFX, debit read, existing combined-ID switch once each. Inspect methods/path templates/parameter names-types/token presence-rotation/response types/cookie rotation; no combined settings.
10. Brief reconnect without closing session; validate mypage/same card. Record only observed idle/absolute/refresh/silent-renewal facts; re-login on expiry.
11. With legitimate managed-device APKs, statically inspect signatures/manifests/network configs/hosts/schemas/pinning-integrity call sites, then no-op hooks/profilers for types/routes only. Stop on rejected attachment/pinning/attestation.
12. Explicit official logout ends read-only session; discard temporary files/profiles/cookie snapshots/raw traces other than APKs.

<a id="stop-条件"></a>

### Stop conditions

Stop automation immediately for any of these.

- OTP/security phrases/passkey biometrics-PIN/QR/identity documents/CAPTCHA/risk challenges
- New registration/terms/passkey changes/password resets/device enrollment
- Payment/application/limit/lock/points/campaign write CTAs/confirmations
- Unexpected POST/PUT/PATCH/DELETE, cross-origin redirects, unknown downloads
- 401/403/409/423/429, lock/fraud/access warnings, consecutive login failure
- Unknown DOM/CSV schemas, issuers, switching rules, debit statuses
- Risk of PII/card numbers/amounts/merchants/cookies/tokens/OTPs entering logs/traces/screenshots
- Uncertain retry effects risking duplicate writes/accounts
- Root/debug modifications, pinning-attestation-anti-hook bypass, changed returns, or decrypted raw-traffic retention needed for APK/runtime observation

<a id="未確認事項"></a>

## Unconfirmed items

- The exact issuer shown for each card in the real inventory, and the combined-login switching graph currently set up among JCB W, Recruit JCB, Mizuho JCB Debit and Kyoto Bank JCB Debit.
- Whether Mizuho JCB Debit and Kyoto Bank JCB Debit actually offer passkeys, and whether a Bitwarden passkey works on the Web and in the app.
- Cross-issuer `details_inquiry`/DOM/export schemas, post-login TTL/timeouts/renewal/existing-switch transport.
- Card-specific export columns, OFX fitid, maxima, zero-month responses; first-ID CSV encoding/12 headers confirmed.
- Complete official debit-difference statuses and issuer-specific negatives/cancellations/cashback.
- Whether the public Okura implementation succeeds in production for each issuer and for IDs without a registered passkey; recent code alone is not proof of live success.
- Auth-host WAF/bot vendors; public `www` Cloudflare confirmed, `my` products/Akamai unknown.
- Private 3.9.0 mirror static analysis complete, but official 3.11.1 certificates/manifests/hosts/network config/schemas/pinning-Integrity unconfirmed. Also untested: 3.9.0 runtime headers/cookies/server FIDO extensions/login-OTP-passkey/authenticated schemas.

## Worker PoC (2026-08-31)

Status as of 2026-08-31. The Worker (`kogane-myjcb-collector-poc`) has since
been deployed; production runs are recorded in the later sections (for example
[amendment (h)](#同じ-page-を示す複数の-position-と月として読まれたスキップ払い-page2026-09-29adr-0005-の-amendment-h)).

Added independent Workers PoC in `services/collector-myjcb`, reusing neither `mnie` nor Okura source. The Worker itself is **undeployed/auth-untested**, with no real credentials supplied. Meanwhile user Kuebiko sessions established first-ID passkey/read/export routes; only routes/field names/DOM/formats informed implementation. No raw credentials/assertions/cookies/statements/acquired files/hashes committed.

Two stages:

1. Only `login-protection.ts` uses Browser Run for official `/Login` and in-page `login-prot.js`. Fill only named `userId`/`password` within `form[name=loginForm]`; check method/origin/path before submit. Passkeys/OTPs/security phrases/CAPTCHA/Access Denied become `human-required` without retries.
2. After known mypage, move full jar/same User-Agent into memory; normal Worker `fetch` performs strict read allowlists for credit menus/details/past-month JSON-RPC/CSV-PDF-OFX/debit menus-details. Close browser in per-connection `finally`.

No `eval` of downloaded arbitrary JS in Workers or handwritten protection port. Browser Run executes official scripts; no Container currently. Reconsider minimal login Containers only if Browser Run alone fails environment checks while the same official flow reliably succeeds in Container Chrome.

<a id="kuebikoで確認したlogin境界"></a>

### Kuebiko-confirmed login boundary

- URL `https://my.jcb.co.jp/Login`; password `POST /iss-pc/member/user_manage/Login`; named `userId`, `password`, `screenId`, `loginRouteId`, `un`, `pcSpScreenSwitchUrl`.
- Rendered unnamed text/password decoys mean never select by type/index.
- `/apl/login-prot.js?init`, per-load seeded `?async`, versioned passkey/NNL assets loaded; no hardcoded sources/versions/seeds.
- Passkeys are normal initial options, not challenges merely by text. First-ID flow: `POST /iss-pc/member/user_manage/PasskeyLogin` (200), `POST .../userLoginPasskeyServiceStatusCommunication.html` (200), `POST .../userLoginPasskeyAuthCheckCommunication.html` (200), `POST .../userPasskeyLoginRelay.html` (302), `GET /iss-pc/member/mypage/mypage.html` (200). Assertions exist only in private captures.
- Cookies mix stable app names, `rp1..rp33`, random-looking per-session names. Handle complete jars/attributes but save no names in discovery/manifests/logs because they correlate telemetry.
- First ID uses passkeys, so password-only unattended flows cannot cover all. On 2026-08-31, matched Bitwarden export/CDP WebAuthn and added `passkey` mode injecting P-256 PKCS#8, credential IDs/handles into temporary Browser Run authenticators. Permit only counter=0/discoverable/JCB RP; no keys/assertions/cookies in artifacts/logs. Live Worker auth untested.

<a id="kuebikoで確認したクレジットreadexport"></a>

### Kuebiko-confirmed credit reads/exports

- Initial `detailMenu.html?link_id=...`, details `detail.html?detailMonth=N&output=web`; first-ID HTML enumerated `0..8`. Positions 7/8 are payment schedules, not months (credit-menu group section below).
- `detailAPI.js` reads `input:hidden[name=generalJsonShikibetuId]`, JSON-RPC POSTs `application/json` to `detailPastJson.json`. Fields `jsonrpc`, `method`, `params`, `id`; `method=execute`, `params=[{generalJsonShikibetuId}]`, ID `0301006`+two-digit counter (initial `030100601`). Response `result.errId`, `errMessage`, `detailPastJsonInfo[]`; items `detailAvailableFlag`, `detailMonth`, `payAmount`, `payAmountDispFlag`, `settlementYM`. Stop missing discriminator/failure, no guessed `0..17` scans.
- Of nine past-month `detailMonth=9..17` candidates, first ID had only `10`/`13` available; add only `detailAvailableFlag=true` to initial months.
- `detailReplaceJson.json` request `generalJsonShikibetuId`, `simeYmd`, `payAmount`; response `changeOperationLimitDate`, `detailInquiryURL`, `fixFlag`, `newestFlag`, `payAmount`, `payAmountDispFlag`, `payHowChangeEnableFlag`, `settlementDate`. UI/payment metadata unnecessary for ledgers, excluded.
- **JSON/HTML boundary:** user capture found no transaction-row JSON endpoint. `detailPastJson` gives months, `detailReplaceJson` UI/payment metadata; unfinalized rows live in server-rendered HTML. Prefer official finalized CSV, but unexportable pending requires HTML. First-connection successful Worker had 11 details/6 ledgers/0 export links-artifacts, making HTML necessary for that ID. Optimize by JSON availability, prefer finalized CSV/PDF/OFX offers, HTML otherwise, not blind all-month scraping.
- Pending `detailMonth=0` has no exports; parse `.detail-list-01` `.head`/repeated `.content`. Summary `ご利用日` (use date), `ご利用先など` (merchant)/`支払区分` (payment type), `ご利用金額` (usage amount); expanded `今回のお支払い金額` (current payment amount), `摘要`, `今回回数` (current installment), `備考` (remarks), `訂正サイン` (correction marker).
- Finalized HTML shares ledgers; summary `ご利用日`, `ご利用先など`/`支払区分`, `今回のお支払い金額`; expanded `ご利用金額`, `摘要`, `今回回数`, `備考`, `訂正サイン`; comparable to CSV/OFX.
- Finalized pages have one `<h1>カードご利用代金明細(確定分)</h1>` (card payment statement, finalized). Counts-only production evidence found exactly one on every `credit-detail-01.html`. Position 1 is latest closed statement even without exports; see [statement-state determination](#明細状態の判定2026-09-24).
- Finalized GET exports: `detailDbPdf.html?...&output=pdf`, `detail.html?...&output=csv`, `detail.html?...&output=money`. CP932 CSV has metadata then exact headers `ご利用者`, `カテゴリ` (category), `ご利用日`, `ご利用先など`, `ご利用金額(￥)` (usage amount, yen), `支払区分`, `今回回数`, `訂正サイン`, `お支払い金額(￥)` (payment amount, yen), `国内／海外` (domestic/overseas), `摘要`, `備考`. PDF `%PDF-1.4`; OFX 1.x `CREDITCARDMSGSRSV1`/`CCSTMTRS`/`BANKTRANLIST`/`LEDGERBAL`. Exclude notice `detailNewspdf.html`.
- `/iss-pc/member/detailsinvoice/detailsInvoiceList.html` is separate invoicing, without those first-ID export controls; not the same statement route.

<a id="credentialr2schedulerの境界"></a>

### Credentials, R2, and scheduling boundaries

Separate credential/session/results/R2 namespaces per ID through independent `connections[]`; no assumption combined login covers all. Small fallback `MYJCB_CONNECTIONS_JSON`; [Workers limit](https://developers.cloudflare.com/workers/platform/limits/) is 5 KB per secret/variable, so also implemented `MYJCB_CONNECTION_SECRET_NAMES`/per-connection `MYJCB_ACCOUNT_<NAME>_JSON`.

Full jars may exceed 5 KB, so `session` mode is limited-size PoC. Proposed local sync CLI encrypts envelopes client-side with AES-GCM in private R2, keeping small wrapping keys in secrets; unimplemented here, >5 KB sessions are blockers.

Append-only sanitized captures/normalized ledgers/manifests at `raw/myjcb/YYYY/MM/DD/<run-id>/<connection-id>/...`. No login/mypage/protection sources/credentials/protected bodies/cookie values. Strip/replace active-embedded elements, event/data/navigation/form attrs, values/textareas, token-session attrs, 16-digit card numbers before storing HTML. Normalize runtime errors to typed codes/fixed messages. Discovery stores cookie counts, not names.

The `raw/myjcb/YYYY/MM/DD/<run-id>/<connection-id>/...` layout was the
private bucket's, retired on 2026-09-13. Runs are now written to the shared
`DATA` bucket as content-addressed `objects/<2hex>/<sha256>` objects with the
`terminal-v1` manifest last at `runs/myjcb/<runId>/terminal.json`; the
importer described next was retired with it
([U09 below](#共通-data-r2-への切替-u09), [legacy retirement](../legacy-retirement.md)).

Layer A central ingestion in `services/collector-r2-importer` leaves source R2 unchanged, validating manifests/prefixes/metadata/checksums/HTML-past-JSON-ledger-discovery meaning before central state. Existing HTML receives `myjcb-central-sanitized-v2` to exclude active/token/navigation surfaces; central manifests replace free failures/blockers with fixed codes, never copy source free text. Fix inventories for up to 16 connections, transfer 5 artifacts per HMAC continuation, resume safely. Migration `0011` separates credentials/routes/source aliases/storage policy. Private audit on 2026-09-05 found 22 manifests/142 objects without public bodies/values/keys/hashes. Final validation accepted all 22, transformed all 72 HTMLs. Observed datasets only credit menus/past-month JSON/details/parsed ledgers/discovery; reject CSV/PDF/OFX/debit artifacts and declared failures until audited structures/contracts/negative tests exist.

Same-manifest backfill retries are central-idempotent; separate collector run IDs remain separate. Six successful R2 runs had different payload fingerprints, no basis to merge collection runs by content deduplication. Known Cron/manual overlaps require collector locks; raw ingestion does not alter schedules.

## Layer B observation parser (2026-09-07)

Of five centrally normalized datasets, only `credit-ledger`/`credit-past-months` create financial observations. Strictly validate `credit-menu`/`credit-detail`/`discovery` without emission to avoid HTML/ledger duplication. No guessed CSV/PDF/OFX/debit parsers without successful observed R2 artifacts.

`credit-ledger` crosschecks manifest connection/filename/state/period/payload. Observed dates contain internal spaces; payment types/amounts appear in summary cells 2/3. Normalize whitespace then strictly validate dates/amounts as Layer A, requiring exactly one exact JPY value among 2/3. Provider positive usage increases debt/negative refunds; explicitly invert to negative spending/positive inflows. Preserve raw rows, chosen cells, signs, period/state/detail origin in `extra`. Stable fingerprints/occurrence order preserve repeated rows; no missing placeholders. Current view selects latest successful finalized artifact per payment month and latest unfinalized per payment month only if also latest at its position, avoiding cross-run duplicates/disappeared pending (see [pending slots](#未確定明細のslot2026-09-26)).

Observed payment types (2026-09-24, production D1 counts only): `1回払` (single payment) appears with merchants in combined `ご利用先など／支払区分` (merchant/payment type), `summaryCells[1]`, across all CORE rows (48 confirmed/514 unconfirmed); no `N回払` (N payments), `分割` (installments), `リボ` (revolving), `ボーナス` (bonus), `キャッシング` (cash advance). Parser-selected `_kogane.paymentTypeCellIndex` copied to `description` instead holds a two-character screen label, not payment type. Evidence already contains values, so no parser release; read model `packages/read-model/src/card-usage.ts` `payment_type` reads `summaryCells[1]`. Purchase recognition accepts only all-one installment counts such as `1回払` without excluded terms ([single payment, per source](../economic-events.md#single-payment-per-source)). Combined cells contain merchants, so rules read without storing/logging.

`credit-past-months` requires JSON-RPC, at most 18 items, unique months. Only available/displayed `payAmount` becomes `credit_statement_payment_amount`, a provider monthly payment amount, not cash balance. Never invent zero for hidden/unavailable. Absolute `settlementYM` normalizes year-month `asOf` without dates; Layer A relative fallback `detailMonth-N` stays warning/no `asOf`. Current balances first select latest complete artifact then minimum `detailMonth`, so mixed/empty latest snapshots leave no stale current values.

Do not resolve `detailMonth-N` during collection ([`docs/observations.md`](../observations.md#relative-period-labels-are-resolved-from-the-capture-time)). Store provider labels unchanged. Calendar months are later reader/processor interpretations from artifact `fetched_at` Asia/Tokyo plus relative index, version `relative-statement-period-v1`. For capture date `d` day 1–15, `P0` is `d`'s month+1; day 16 onward month+2 (15th cutoff/next-month payment). `detailMonth-0`=`P0`, `detailMonth-1`=`P0 − 1`, payment months `YYYY-MM` like `card_statement_facts.period`; `N ≥ 2` unresolved/null. The 16th switch follows published JCB cutoff/finalization, but unvalidated without day-12–30 captures. Counts-only first-connection captures showed all `detailMonth-0`/`detailMonth-1` use dates in `P0`/`P0 − 1` billing periods across both sides of month boundaries; absolute API labels `N = 10, 13` were `P0 − 8`/`P0 − 11`. Menu/past positions are not uniform offsets; positions 2–8 had no rows to locate. The same aggregate found exportless `detailMonth=1` marked `unconfirmed` despite `カードご利用代金明細(確定分)`, rejected by statement parsers as contradictory (known collector mismatch). Rows thus remained pending without statement facts; old current views kept only one unconfirmed connection ledger (now [pending slots](#未確定明細のslot2026-09-26)).

Checked-in canary read-only audited 184 source objects/24 manifests, success 8/failed 16, all Layer A strict; every successful artifact chose exactly one Layer B route and parsed. Aggregates: 181 transactions/16 statement metrics, nonempty ledgers/displayed past months, no multiple connections observed. No object keys/hashes/bodies/connection-account IDs/merchants/dates/financial values/secrets output/saved/committed; no R2 writes/deletes.

Daily collection is the Processor's alarm job `myjcb` (06:00 JST, `0 21 * * *`
in `config/alarm-jobs.json`), which calls the Worker's private
`ScheduledCollection` entrypoint; since
[#430](https://github.com/risu729/kogane/pull/430) (2026-10-05) the Worker has
no Cron trigger, and GitHub Actions cron is not used. Starting a collection over
public HTTP is retired: every request other than health, `POST /trigger`
included, answers 404, and the private RPC remains
([ADR 0069](../adr/0069-collector-admin-retirement.md)). At the PoC stage there
was no lock against overlapping scheduled and manual runs, and a Durable Object
lock or Queue serialization was a requirement before deploy and merge. Today
every run, alarm or operations request, holds the source's execution lease in
`SCHEDULE_DB` (`withCollectionLease`, `services/collector-myjcb/src/worker.ts`),
so two runs of `myjcb` do not overlap ([schedules](../schedules.md)).

Implementation/stops/R2/cleanup/synthetic tests/unknowns are consolidated in `services/collector-myjcb/README.md`. Public AGPL prior-art observations distinguish PR #24 research Okura `afc6057fba78b5bfd6364654548fbfd91c76692a` from PoC comparison `bbf11e032aba4a380009508e91954361a3f9d658`, using only protocol checks.

<a id="明細状態の判定2026-09-24"></a>

## Determining statement state (2026-09-24)

The former collector determined monthly statement state from the presence of export links. Months with `detailMonth<=1` and no export link were `unconfirmed`; all others were `confirmed`. No month in the investigated connection has an export link, so the latest closed statement at position 1 was always recorded as `unconfirmed`. Because this page has an `(確定分)` ("confirmed portion") h1, `myjcb-credit-statement-total@1.0.1` marked every position-1 page `parser_rejected` for contradicting the manifest. Its ledger rows were also saved as `unconfirmed`, and card purchase recognition treated the closed bill as an `authorized` (pending) purchase.

The collector determines state from the page itself (`creditStatementState` in `services/collector-myjcb/src/parsers.ts`). The page indicates state in two places: h1 `カードご利用代金明細(確定分)` ("card payment statement, confirmed portion") and the ledger-header amount label (`今回のお支払い金額` ("current payment amount") for confirmed, `ご利用金額` ("usage amount") for unconfirmed; the fourth entry in parser `CONFIRMED_HEADERS`/`UNCONFIRMED_HEADERS`).

Only the `(確定分)` h1 is the page's own assertion that it is a closed statement. H1, ledger rows, and amount labels are read in one place, `readMyJcbStatementPage` in `packages/domain/src/myjcb-statement-page.ts`, shared by the collector and statement-total parser (`myjcb-credit-statement-total`, from 1.1.0). Only the collector adds position rules.

| `(確定分)` h1 | Ledger                                                     | Recorded state                                                                                                                                                                                 |
| ------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1             | Amount label `今回のお支払い金額` / absent                 | `confirmed`                                                                                                                                                                                    |
| 1             | Amount label `ご利用金額`                                  | `confirmed` if proven by the page; otherwise stop (`credit-statement-state`, [amendment (d)](#確定分の見出しとご利用金額のheader2026-09-27adr-0005-の-amendment-d). Unobserved, amendment (f)) |
| Absent        | No ledger                                                  | `unknown`                                                                                                                                                                                      |
| Absent        | Ledger without rows (regardless of labels)                 | `unknown` (no ledger artifact created)                                                                                                                                                         |
| Absent        | Rows present, amount label `ご利用金額`                    | Position 1: `unconfirmed`; position 2 onward: `unknown`                                                                                                                                        |
| Absent        | Rows present, amount label `今回のお支払い金額` / absent   | Position 1: stop; position 2 onward: `unknown`                                                                                                                                                 |
| 2 or more     | Any                                                        | Stop                                                                                                                                                                                           |
| Any           | Both labels in one header, or disagreement between ledgers | Stop                                                                                                                                                                                           |

`detailMonth=0` is always `unconfirmed`. Stop if position 0's page indicates confirmation. Save only HTML as evidence for `unknown` pages, without creating ledger artifacts. Production evidence explains why pages without h1 at position 2 onward do not stop collection (read-only count aggregates only; no values recorded). Positions 7 and 8 fetched in each run had ledgers with no h1 and 0 rows (manifest `confirmed`; `myjcb-credit-statement-total@1.0.1` produced `statement_total_not_confirmed` in all 12 runs). Stopping on them would stop every daily run. Saving them as `unconfirmed` placed them after position 0 in the same run; in the read model at that time, an empty capture occupied the connection's single unconfirmed snapshot slot, making position 0's pending rows non-current. All closed statements pass through position 1 and have h1 there (12 of 12 runs in production evidence). Position 1 therefore stops on pages with confirmed-label rows but no h1. One older page, however, does not stop the daily run. Stop/`unknown` logs contain only h1 count, ledger count, row count, and label codes, never page bodies.

Export links are not grounds for state. However, stop if a page that is not a confirmed statement has export links, because exports are recorded as `confirmed`. Headers of ledgers with rows must display the complete header set (4 labels) for that state. This makes the ledger artifact's `headers` page-confirmed facts. From the first run after the fix, position 1 is saved as `confirmed`; its ledger also retains `ご利用金額`, which could not be read with unconfirmed labels.

Do not rewrite existing captures' raw evidence or manifests. Correct interpretation with versioned parsers.

- Statement total (`myjcb-credit-statement-total@1.1.0`): reads state from the page and records manifest state as `_kogane.manifestStatementState` for comparison. When manifest/page disagree on confirmation, emit warning `statement_state_differs_from_manifest` (no warning for differences between `unconfirmed` and `unknown`). Fail only for page-internal contradictions (2 or more h1 elements, both labels in one header, disagreement between ledgers, h1 with unconfirmed headers; from 1.2.0, only unconfirmed headers not proven by the page), not for manifest-only differences. As in 1.0.1, pages without h1 emit no total. Position-1 pages marked `parser_rejected` by 1.0.1 publish totals with exact payment dates through repair-lane reparsing or bounded replay. The 1.0.1 error runs remain as history.
- Ledger (`myjcb-credit-ledger@1.1.2`): version bump only from the shared module's digest change, without behavior changes. The parser sees only one artifact. `state` in `credit-ledger-NN.json` is the collector's judgment; `headers` were also written from that judgment and contain no page evidence. Because confirmed pages were read with unconfirmed labels, `ご利用金額` was not saved either. The read model also uses append-only `observation_artifact_metadata.statement_state` written by the manifest for snapshot classification. The parser therefore cannot correct row state. Existing position-1 rows remain `unconfirmed` as the collector's statement at that time.
- Existing rows become non-current on the fixed collector's first successful run. At that time, unconfirmed captures of a connection shared one snapshot slot, whose latest capture subsequently became position 0 (current rules: [unconfirmed statement slots](#未確定明細のslot2026-09-26)); the sole exception is position 1 showing `ご利用金額` rows without h1, which is unobserved in production evidence. The same statement is collected again at position 1 as `confirmed` in a separate slot (`detailMonth-1`). Previously, positions 0/1 competed for the same slot and only one could be current. The purchase lane retires non-current `authorized` events to `unknown` and recognizes confirmed rows as `captured` in new events. Because state is included in the fingerprint/external ID, this does not revise the same event. Retired `unknown` events have no legs, preventing double counting of the same purchase.

Release notes and reparsing procedures are in "MyJCB statement state from the page (statement parser 1.1.0)" in `docs/observations.md`.

<a id="明細の月2026-09-26"></a>

## Statement month (2026-09-26)

The provider places the latest closed statement at position 1 and moves it to position 2 when the next statement closes. The collector recorded periods for months not labeled by the past-month API as `detailMonth-N` (position). Because period enters ledger-row fingerprints, hence external IDs/card-purchase recognition keys, the same statement's rows acquired new keys every month and the purchase lane retired/re-recognized the same purchases. The read model also assigned confirmed captures to period-specific slots, allowing the same statement to be current in both position-1 and position-2 slots (double counting).

The collector uses the month stated by the confirmed statement page as period (`creditStatementPeriod` in `services/collector-myjcb/src/parsers.ts`). Confirmed pages have an `(確定分)` h1 and state their payment month through `<h2>YYYY年M月お支払い分のカードご利用明細</h2>` ("card statement for payment in year YYYY, month M") or payment-date form `<h2>YYYY年M月D日(曜)お支払い分のカードご利用明細</h2>` ("card statement for payment on year YYYY, month M, day D, weekday") (the same h2 read by `myjcb-credit-statement-total`; see "Statement headings with payment dates" below). The collector records that month as `YYYY-MM` in detail, ledger, and export periods. Position remains in artifact keys and ledger `detailMonth`. This records the absolute month asserted by the page itself, rather than resolving relative labels at collection time.

- Months labeled by the past-month API continue to use `settlementYM` verbatim. If the page also states a month, it must match or collection stops (`credit-statement-period`).
- Other confirmed pages stop if they state no month or more than one month (`credit-statement-period`). The statement parser rejects the same page too.
- Unconfirmed pages state no month and remain `detailMonth-N`. `unknown` pages likewise state no month and, from amendment (h), have no period written (see "Multiple positions showing the same page" below).
- Stop logs contain only `detailMonth`, the count of stated months, and presence of an API label, not the month itself.

The ledger parser is unchanged (no version bump). The same statement's rows have the same external ID at every position. The read model assigns confirmed-capture slots by statement (payment month) (`myjcbStatementMonth` in `packages/read-model/src/sql.ts`). Absolute periods (`YYYY-MM`, `YYYYMM`, `YYYY年M月お支払い分` ("payment in year YYYY, month M")) use that month; `detailMonth-0`/`detailMonth-1` use a month resolved from `fetched_at` by `relative-statement-period-v1`. Captures of one statement enter one slot, and only the latest is current. Confirmed `detailMonth-N` (N ≥ 2) without an applicable rule names a position, not a statement, and is not current.

On deployment, statements recorded as confirmed with `detailMonth-1` (captures since #248) are replaced by the first capture stating their month. Their recognized rows are retired once and recognized once with new keys, without double counting. Pending rows, API-labeled months, and subsequent month keys are unchanged. Deploy the processor (read model) with or before the collector. Design comparisons (read-model-only keys, parser release, collector) and rationale are in "MyJCB statements keep their identity when their position moves" in `docs/observations.md`.

<a id="未確定明細のslot2026-09-26"></a>

## Unconfirmed statement slots (2026-09-26)

Between closing on the 15th and confirmation (around the 24th), the provider displays two unconfirmed statements. Position 0 is the cycle still accepting usage; position 1 is the closed but unconfirmed cycle. The collector records them as `unconfirmed` with `detailMonth-0`/`detailMonth-1`, respectively. The former read model put all unconfirmed captures of a connection in one snapshot slot, so only the newer of the two was current. The other statement's pending rows were absent from lists/recognition; whenever publication order of the two captures switched, the purchase lane retired/re-recognized events without new information.

The read model also partitions unconfirmed captures by statement (payment month) ([ADR 0016](../adr/0016-myjcb-pending-statement-slots.md), `myjcbStatementSlot` and `MYJCB_LEDGER_SNAPSHOT_CTES` in `packages/read-model/src/sql.ts`). The slot is the payment month derived from `fetched_at` through `relative-statement-period-v1` (`detailMonth-0` = `P0`, `detailMonth-1` = `P0 − 1`), in a state-specific partition. Unconfirmed/confirmed captures of the same statement are separate partitions of the same month. An unconfirmed capture is current only if it is that month's latest unconfirmed capture and the latest ledger capture at that position (artifact key `<connection>/credit-ledger-NN.json`), regardless of state.

- Both unconfirmed statements from the same day are current; a later capture replaces only its own statement.
- When a statement is confirmed and position 1 is collected as `confirmed`, the unconfirmed capture becomes non-current in the same read. They cannot both be current. State is part of the external ID, so the purchase lane retires the pending event once and recognizes the confirmed row once as `captured`.
- Two captures of one position cannot both be current, regardless of months assigned by the rule. Even if the switch on the 16th (unverified) is wrong, captures of the same position on the 15th/16th cannot make the same statement current twice. However, month alone links different positions. If the switch date is wrong and position 1 is published before position 0 on the day the statement moves to position 1, position 0's last capture and position 1's new capture fall in different months, making the same statement current twice until position 0 is published again (the reverse hides the statement for the same delay). Unconfirmed captures between the two switch dates are partitioned under the wrong month.
- Across different connections resolving to one account, pending rows must also come from the account's latest run at that position (card usage step 3). A replaced connection's unconfirmed captures cannot remain current alongside the new connection's captures.

Recognition keys do not change (the key is the row's external ID). An unconfirmed statement moving from position 0 to position 1 gets a new key once on the 16th because labels enter row fingerprints. This is a known limitation unchanged here. Stored evidence/labels are not rewritten; no migration is needed. On deployment, if position 1 is unconfirmed in the latest capture, position 0's pending rows become current and recognized. Tests are in `packages/read-model/test/card-usage.test.ts` ("two pending MyJCB statements are two slots") and `services/processor/test/myjcb-statement-identity.test.ts`.

<a id="共通-data-r2-への切替-u09"></a>

## Switch to shared DATA R2 (U09)

The collector does not read `COLLECTION_TARGET`. Its only destination is the shared bucket
`kogane-raw-evidence` (binding `DATA`). The switch and importer were
retired on 2026-09-13 (`docs/collection.md`). Runs are saved through `packages/collection`,
writing terminal manifests last. Stored HTML consists of bytes already processed by the collector's
`redactedStatementHtml`, rechecked before saving against the same redaction invariants as central storage.
Connections are separate terminal units; human-required is
recorded only as unit state, without logging in again. For artifact/role mappings,
see the relevant section of `docs/collection.md`.

<a id="口座名義2026-09-27adr-0029-の-amendment-2"></a>

### Account holder names (2026-09-27, ADR 0029 amendment 2)

Confirmed statement pages have a `カード情報` ("card information") table (vertical th/td); its account-holder row is the holder's name partially masked with `*` by the provider. Stored pages retain this row as displayed by the provider ([ADR 0029 amendment 2](../adr/0029-data-classification-and-unkeyed-identity.md#amendment-2-2026-09-27-person-names-are-kept-in-stored-evidence)). `redactedStatementHtml` performs only sanitization (removing elements such as scripts, URL/session/credential attributes, and card numbers); `assertRedactedHtml` does not inspect account-holder cells. The terminal redaction step is `myjcb-sanitizer` v3.

History: from the merge of [#333](https://github.com/risu729/kogane/pull/333) until amendment 2, account-holder `td` contents were replaced with `[redacted:name]`, page manifest entries had `redactedFieldCount`, and the step was `myjcb-sanitizer` v2. Pages saved in that interval retain the marker unchanged (append-only; names were not retained). Pages saved before #333 contain account-holder names.

<a id="共通-data-r2-の-manifest-と明細メタデータ2026-09-26adr-0025"></a>

### Shared DATA R2 manifests and statement metadata (2026-09-26, ADR 0025)

The processor metadata extractor (`services/processor/src/metadata-extractors/myjcb.ts`) reads statement state/period used by ledger/statement-page parsers from the run's collector manifest. Terminals lack these fields. Importer-era central manifests had `connectionId` and `filename` per artifact; the extractor located entries by those two fields. Manifest entries written by the collector to the shared bucket have only `dataset`, `key` (`objects/<2 hex>/<sha256>`), `mediaType`, `sha256`, `bytes`, and `statementState`/`period` when recorded. Consequently, all shared-R2 runs failed parsing with `manifest_artifact_mismatch`.

The extractor reads both shapes. The importer shape (a manifest with any entry carrying `connectionId` or `filename`) retains name-based lookup and unchanged behavior, verified by a differential test pinning the pre-change extractor. For the shared shape, find entries naming the artifact's same digest, size, and content-addressed key, then use their `statementState`/`period`. The connection is the artifact-key prefix and must occur in manifest `connections`. If multiple entries contain the same bytes, use them only if all values agree; otherwise stop with `manifest_artifact_ambiguous`. Do not infer values from positions/names.

Shared-shape manifests lack the importer shape's `connectionId`, `filename`, and `ordinal`. The extractor outputs none of these in either shape. Connections/positions continue to come from artifact keys. Entry `mediaType` (with parameters) is unused, so `credit-menu.html` still does not reach the parser (ADR 0022).

Before ADR 0026, the collector also wrote successful connections' unit coverage as `partial` (because cards display only part of their statement history). Registration made this unit outcome `partial`, and the run became `partial` in `observation_fetch_runs`. It was ineligible for parsing under either run scope or `unit-independent-v1`, stopping as `not_eligible` before reaching the metadata extractor. The next section resolves this.

<a id="connection-の-unit-coverage2026-09-26adr-0026"></a>

### Connection unit coverage (2026-09-26, ADR 0026)

Unit coverage means "did this unit retrieve everything this run attempted to collect without gaps?" It makes no claim about the card's entire history. Run `coverageStatus` carries the history claim and remains `partial` even for successful runs (registration records it without deriving outcome).

Write successful connections' units as `complete`. A successful connection has obtained all months enumerated by the credit menu and past-month response, saving each month's redacted page and every ledger created from a page stating its state. Exports offered by pages are recorded, not retrieved (amendment (b) below). Pages with `unknown` state save only HTML under the rules (ADR 0005); this is not missing data. However, if an `unknown` page has ledger rows (a page without a heading and with rows at position 2 onward), the rows exist only in HTML and no parser reads them. That month is not completely retrieved, so `collectCredit` counts it and `collectConnection` reports the connection as `partial`. The unit becomes `partial` with `collector_partial`, and the run becomes `partial` even without failures. Failures in months, exports, or parsing are handled as in the next section. The plan does not expand `partial` units.

Registration turns `complete` units into unit outcome `success`, as in the importer era. Successful runs become `success` in `observation_fetch_runs`, create parse jobs, and parse end-to-end (`services/processor/test/myjcb-shared-r2.test.ts`).

Limitation: `complete` assumes one `detail.html?detailMonth=N&output=web` contains every row for that month. Row limits/pagination remain unconfirmed (unknowns above); the collector does not compare page rows against page-stated totals. This is the same unknown that keeps GLOBAL PASS `partial`, but MyJCB has recorded connections as `success` since the importer era and all previous parsing assumes this. Record it as an assumption, not an observation.

Limitation: terminals written before ADR 0026 cannot change, and processor eligibility rules are not relaxed, so those runs remain `partial`/`not_eligible` and unparsed. ADR 0022 contract v2 does not change this (unit outcomes derive from the same terminal). MyJCB statements are snapshots visible again on the next collection, so confirmed statements for months still displayed by the card are recovered in the first successful run after ADR 0026. What is lost is the unconfirmed-only history during that interval: unconfirmed rows disappearing before later collection (cancellation or pre-confirmation changes) enter no parsed run. Importer-collected data stays current until the first eligible run (ADR 0014).

<a id="connection-の停止と取得済みの月2026-09-27adr-0005-の-amendment"></a>

### Connection stops and captured months (2026-09-27, ADR 0005 amendment)

Previously, failure in monthly fetching, state determination, ledger parsing, or export discarded the whole connection. It left no artifacts; the terminal said only `collector_failed`, the collector manifest only `collector-failure`. The stage of stopping and months already retrieved appeared only in expiring Worker logs, not stored evidence.

The current collector retrieves months individually in ascending `detailMonth` order. Each month is saved whole or not at all, joining the connection's artifacts only after page, ledger, and exports are all readable. Failure in monthly fetching, state determination, statement month, ledger parsing, or export stops the connection at that month ([ADR 0005 amendment](../adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-a-stop-ends-the-connection-and-keeps-its-captured-months)). Credit menu, past-month response, earlier months, and `discovery.json` are saved; nothing later is read (neither later months nor debit). The connection becomes `partial`; its unit becomes `partial` with a stop-stage code. The collector-manifest connection records `stopCode`, `stopPosition` (stopped `detailMonth`), and `capturedMonthCount` (saved months); failures contain only `{ connectionId, operation: "collect", code, position }`.

Stop codes form a closed list (`CONNECTION_STOP_CODES` in `services/collector-myjcb/src/types.ts`).

| Code                                                       | Stage                                                             | Saved data                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| `human_required`                                           | Human interaction required                                        | None (unit `unknown`)                            |
| `login`                                                    | Login, passkey, session restoration                               | None                                             |
| `discovery`                                                | Card enumeration on mypage                                        | None                                             |
| `credit_menu`, `credit_first_detail`, `credit_past_months` | Credit menu, first statement page (discriminator), past-month API | None                                             |
| `credit_menu_group_unrecognized`                           | Credit-menu heading matches none of the three observed headings   | None                                             |
| `month_fetch`, `month_parse`                               | Fetching/reading a monthly page                                   | Months before the stopped month (unit `partial`) |
| `credit_statement_state`, `credit_statement_period`        | State contradiction, statement month                              | Same as above                                    |
| `credit_page_repeated`                                     | Same page as an earlier position with different state/period      | Same as above (that page is not saved)           |
| `ledger_parse`                                             | Ledger headers, row cells                                         | Same as above                                    |
| `export_fetch`                                             | CSV/PDF/OFX retrieval/validation                                  | Same as above                                    |
| `debit`                                                    | Debit statements                                                  | None (shared bucket rejects debit)               |
| `no_route`                                                 | Neither credit nor debit on mypage                                | None                                             |
| `unclassified`                                             | Error without a stated stage                                      | None                                             |

Each stop condition (`StopConditionCode`) maps to one stage through the `connectionStopCode` `Record`. New conditions cannot compile without a stage. Manifest connections/failures are reconstructed solely from closed fields; out-of-list codes (`manifest_stop_code_invalid`) and positions other than `detailMonth` (`manifest_stop_position_invalid`) reject the plan. Error messages, HTTP bodies, provider wording, and amounts are neither saved nor logged. Stop log `myjcb-credit-month-failed` emits only `detailMonth`, condition code, stop code, and saved-month count.

If every connection in a run saves nothing, the run is `failed` and writes only a terminal, as before. Units are still written, leaving each connection's stop code in the terminal. Registration still only records the run as `provider_run_failed`, without sealing. If all stopped connections stopped at the same stage, the run's `safeErrorCode` is that stop code (the same treatment as `human_required`).

Registration/eligibility are unchanged. A `partial` unit with a stop code becomes unit report `failed`; the run is `partial` in `observation_fetch_runs`, and parse jobs are `not_eligible`. Captured months are catalogued/sealed but not parsed. The change preserves evidence and causes.

Limitation: earlier terminals remain `collector_failed` without retained months (terminals cannot change). Stop codes indicate only collector-side stages, not provider intent.

`export_fetch` cannot occur in the current Worker because it no longer retrieves exports, as described below (it occurs only with `collectCredit` option `exports: "fetch"`). On `credit_statement_state`, `credit_statement_period`, or `ledger_parse` stops, also save the stopped month's page (below).

<a id="ledger-header-の三種export-link停止した-page2026-09-27adr-0005-の-amendment-b"></a>

### Three ledger headers, export links, and stopped pages (2026-09-27, ADR 0005 amendment (b))

On 2026-09-27, the owner's agent investigated only the structure of one connection's live pages (element counts, header labels, link shapes; no values recorded). The menu has 9 links for `detailMonth` 0..8.

| `detailMonth` | Ledger             | Header labels                                                                                                                        | Export links                  | Collector handling                              |
| ------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ----------------------------------------------- |
| 0             | Present, with rows | `ご利用日 / ご利用先など / 支払区分 / ご利用金額` ("usage date / merchant etc. / payment category / usage amount")                   | None                          | `unconfirmed`, create ledger                    |
| 1, 2          | Present, with rows | `ご利用日 / ご利用先など / 支払区分 / 今回のお支払い金額` ("usage date / merchant etc. / payment category / current payment amount") | PDF, CSV, OFX (relative href) | `confirmed`, create ledger, record exports only |
| 3–6           | Absent             | —                                                                                                                                    | None                          | `unknown`, page only                            |
| 7             | Present, empty     | `ご利用日 / ご利用先など / 支払区分 / ご利用金額`                                                                                    | None                          | `unknown`, page only (no missing data)          |
| 8             | Present, empty     | `ご利用日 / ご利用先など お支払日 / 今後のお支払い金額` ("usage date / merchant etc., payment date / future payment amount")         | None                          | `unknown`, page only (no missing data)          |

The fourth label in confirmed months (1, 2) is split by `br` as `今回の<br class="pc-none">お支払い金額` on every stored confirmed page (round 5, 2026-09-28; amendment (f) below). "Empty" at positions 7/8 means exactly one `content` row whose `item-cell` contains exactly one `div.cell.w-100per` with `ご利用明細はございません。` ("there are no statement details").

The second structural investigation that day (round 4) established that positions 7/8 are not months. All 9 menu links say `明細を見る` ("view statement"), in DOM order 0, 1, 7, 8, 2, 3, 4, 5, 6. Month names are in the same box's heading, not links. Positions 0/1 are under h2 `最新のご利用明細` ("latest statements"), 2–6 under `過去の明細` ("past statements"); these are months. Positions 7/8 are under h2 `ボーナス#回払い・ショッピングスキップ払い` ("bonus # installment payments / shopping skip payments"): 7 is a bonus-payment schedule page, 8 a shopping-skip-payment schedule page (no month name in the box). Position 8 has h1 `ショッピングスキップ払いご利用明細(未確定分)` ("shopping skip payment statement, unconfirmed portion"). Every page's ledger is a `div.detail-list-01` grid, not `<table>` (the collector also does not depend on `<table>`). The third header's live `div.head` has 3 cells, with `ご利用先など` and `お支払日` on two lines in the second cell. The initial investigation described this as 4 labels.

At amendment (b), the collector counted `detailMonth` positions without distinguishing months from payment-schedule pages. Positions 7/8 were also fetched/saved as months, counted in `periodCount`/`capturedMonthCount`, and put in `unreadMonths` if unread. The current collector distinguishes them by menu headings ("Credit-menu groups and payment-schedule pages," amendment (c), below). Periods are relative labels `detailMonth-7`/`detailMonth-8`, which no reader resolves to calendar months (only `detailMonth-0` and `-1` are resolved).

**Export links.** Confirmed months have `detailDbPdf.html?output=pdf`, `detail.html?output=csv`, and `detail.html?output=money` as relative hrefs without `detailMonth` (the month is the page containing the link). Former `discoverCreditExports` resolved hrefs against only the origin, producing `/detail.html`, so they never matched. This bug made every stored run record 0 exports; "the investigated connection has no export link in any month" (statement-state determination above) was incorrect. Resolution now uses the detail page's own URL (`https://my.jcb.co.jp/iss-pc/member/details_inquiry/detail.html`), treating relative, `./`, root-relative, and absolute hrefs alike. Count links on the MyJCB origin with export paths (`detail.html` or `detailDbPdf.html` under `/iss-pc/member/details_inquiry/`) and `output` (`csv`, `money`, `pdf`). Links without `detailMonth`, as observed, are exports for their containing page's month. Links naming `detailMonth` count only if they name exactly that month (previously `Number(null)` made monthless links belong to month 0, uncounted in other months).

The Worker does not retrieve discovered exports. The shared bucket rejects `credit-csv`/`credit-pdf`/`credit-ofx` (`artifact_dataset_unobserved`), so retrieving them would make every run containing confirmed months fail at planning, without writing a terminal. Instead, record only `exportOffers: [{ position, kinds }]` (kinds `csv`, `pdf`, `ofx`) in the collector-manifest connection. Offers do not make units `partial`. The rule stopping on export links in non-confirmed pages (`credit_statement_state`) is unchanged; fixing discovery made it work on live pages too.

**Third header.** `ご利用日 / ご利用先など お支払日 / 今後のお支払い金額` contains neither of the two amount labels read. It was observed only on shopping-skip-payment schedule pages, so its code is `scheduled_payments_page`. Row meaning is unconfirmed, so do not read it as a statement (ADR 0004). A header is this type if its whitespace-stripped text contains all of `ご利用日`, `ご利用先など`, `お支払日`, `今後のお支払い金額` and none of `支払区分`, `今回のお支払い金額`, `ご利用金額` (`scheduledLedgerRowCount`). Comparison is not per cell, so both observed 3-cell and 4-cell shapes are read alike (neither reads rows).

- With rows, mark that position "retrieved but unread" at any position. Check before reading state; save the page as `unknown` evidence (without period from amendment (h)), create no ledger, retrieve no exports, and proceed to the next month. Previously, position 0 stopped at `ledger_parse` for lacking the full unconfirmed header set; position 1 without a heading stopped at `credit_statement_state`; any position with a heading stopped at `ledger_parse` for lacking the full confirmed set. Only position 2 onward without headings proceeded without reading rows that stated no state (now `rows_unstated`).
- Do not read the entire month even if another ledger exists on the same page.
- If empty, nothing is missing; read as before (as observed at position 8).
- As before, stop on rows with a header matching none of the three types.
- If a month-position page has rows with this header, the connection is `partial` and the run is not parsed. Whether those rows also appear in monthly statements is unobserved, so treat them as missing (INV05). Menu-designated payment-schedule positions are not months and are outside this rule (amendment (c) below).

Write unread months as `unreadMonths: [{ position, code }]` in the manifest connection. Codes form the closed list `UNREAD_MONTH_CODES`: `scheduled_payments_page` (third header) and `rows_unstated` (rows on pages stating no state at position 2 onward; previously counted but unnamed). A connection with unread months becomes `partial`. If every unread month is `scheduled_payments_page` and the connection did not stop, unit `safeErrorCode` is `scheduled_payments_page`; otherwise it remains `collector_partial`. Do not write manifest `failures` (this is not a stop). Log `myjcb-credit-month-unread` emits only position/code. Registration/eligibility are unchanged: unit report `failed`, run `partial`/`not_eligible`; unread pages are catalogued/sealed, but no parser reads them.

**Stopped pages.** On `credit_statement_state`, `credit_statement_period`, or `ledger_parse` stops, redact the stopped month's page and save it as `credit-detail` (state `unknown`, no ledger/export; no period from amendment (h)). Redaction removes scripts/attributes but retains body text, including the `カード情報` table after the ledger, as in other stored statement pages. `capturedMonthCount` remains the number of earlier months, while `stopPosition` identifies this page's month. Stop logs add `stopPageKept`. Pages that could not be read as statement pages (`month_parse`) remain unsaved.

**Menu first.** Fetching `detail.html?detailMonth=N` without first visiting `detailMenu.html` was observed to return a different page (h1 `カードご利用明細一覧` ("card statement list"), no ledger); visiting the menu first returned the statement page. `collectCredit` reads `detailMenu.html` once in the same session, then the first month, past-month API, and remaining months. This existing order is pinned by tests.

**Communication-error pages.** Consecutive fetches were observed to return a `通信エラーが発生しました` ("a communication error occurred") page (count and release conditions unknown). It is recorded as a provider stop, but the collector does not identify it. Its structure was not recorded, nor is it known whether normal pages also contain the wording (for example in hidden dialogs); a detection rule would be a guess. If returned as the first statement page, it lacks the discriminator and stops before months (`credit_first_detail`); if returned in later months, it is saved as an `unknown` month without a ledger and treated as having no missing data.

Limitations:

- Runs on 2026-09-25 and 09-26 stopped at position 1 with `credit-ledger-headers`, retaining no artifacts (before the first amendment). Live position 1 on 09-27 had the confirmed shape and should pass. Position-1 page shape varies by time or session; the page that night was not retained, so the cause cannot be checked. A position-1 page saved by an earlier run (only label counts examined in round 4) had the `(確定分)` heading but no `今回のお支払い金額` anywhere, only `ご利用金額`. This ADR's rules stop on this shape with rows (a confirmed ledger must display the full confirmed header set, `ledger_parse`), making it the most likely but unconfirmed cause. The stopped page will be saved on the next identical stop. **Correction (2026-09-28, amendment (f)):** these counts were a string-matching error. `ご利用金額` labels each row's expanded section (`item-more`); `今回のお支払い金額` counted 0 because the head label was split by `br`. The cause was collector header matching (amendment (f) below).
- The third header's row meaning, export contents (checked on 2026-08-31, not saved), and whether the menu must be reread for each month remain unconfirmed.

<a id="credit-menu-の-group-と支払予定-page2026-09-27adr-0005-の-amendment-c"></a>

### Credit-menu groups and payment-schedule pages (2026-09-27, ADR 0005 amendment (c))

Round 4's structural investigation established that the credit menu's (`detailMenu.html`) 9 links sit in card boxes under three headings (round 4 recorded three `h2` elements, but round 9 found the payment-schedule heading to be `h3`; amendment (j) below). All links say `明細を見る` and contain no month name, so only headings distinguish months from payment-schedule pages.

| Heading (compare after removing whitespace)  | Observed positions | Collector handling                                                                                               |
| -------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `最新のご利用明細`                           | 0, 1               | Months. Included in unit coverage                                                                                |
| `過去の明細`                                 | 2–6                | Months. Included in unit coverage                                                                                |
| `ボーナス#回払い・ショッピングスキップ払い`  | 7, 8               | Payment-schedule pages. Save them; read only shopping-skip-payment pages (amendment (e)). Excluded from coverage |
| Any other heading, or links before a heading | —                  | Stop before the first month with `credit_menu_group_unrecognized`                                                |

`#` represents digits, whose values were not recorded. The collector accepts one or more half-width/full-width digits and requires all other characters to match exactly. A link belongs to the last preceding `h2` or `h3` in document order (from amendment (j); previously only `h2`). Count only links to `/iss-pc/member/details_inquiry/detail.html` with `detailMonth` (1–2 digits), resolving against the menu URL (relative, root-relative, and absolute hrefs alike). Also stop if one position occurs in both groups. Stop log `myjcb-credit-menu-groups` emits only link counts, not heading text.

- **Months:** read month-group positions and positions made available by the past-month API as before. `periodCount` and `capturedMonthCount` count only months. If the past-month API makes a payment-schedule position available (unobserved), stop with `credit_past_months` without deciding either way.
- **Payment-schedule pages:** fetch once each in ascending order after the final month; regardless of displayed contents, redact and save the whole page as `credit-schedule-NN.html` (dataset `credit-schedule`, state `unknown`, period `detailMonth-N`). Do not read rows, state, or links. Because the filename is not `credit-detail-NN.html`, registration assigns no parser dataset: catalogue/seal only, no parse job. (From amendment (e), only pages whose h1 denotes shopping skip payments are saved as `credit-skip-payment-NN.html` and read by a parser; see below.) Collector-manifest connections record `schedulePages: [{ position, code }]` (code `scheduled_payments_page` = saved; `schedule_page_fetch` = fetch/decode failed, nothing saved) and `schedulePageCount` (saved count). Fetch failure is not a stop and enters neither `failures` nor `unreadMonths`. Log `myjcb-credit-schedule-page-failed` emits only position/code. Connections stopped at a month do not read payment-schedule pages.
- **Coverage:** reading every month whole makes the connection `success` and unit `complete`, even if payment-schedule pages contain rows or fail to fetch. Previously, any rows at position 8 made the unit `partial`, and no MyJCB run was parsed.

Limitations: payment-schedule row meaning is unconfirmed; at amendment (c), no parser read these rows (amendment (e) reads shopping-skip-payment pages as a separate dataset). Position 7 (bonus payments) has not been observed with rows. Menu redaction removes `href`, so stored menus cannot identify which links belong to which positions. A changed heading stops the connection before the first month, saving nothing until the new heading is observed/recorded.

<a id="確定分の見出しとご利用金額のheader2026-09-27adr-0005-の-amendment-d"></a>

### Confirmed headings and usage-amount headers (2026-09-27, ADR 0005 amendment (d))

**Correction (2026-09-28, amendment (f)):** the next paragraph's observation was a string-matching error. Every stored confirmed page has head `今回の<br class="pc-none">お支払い金額`; no confirmed page with head `ご利用金額` was observed (an unobserved shape under ADR 0004). This section's acceptance rule remains in code, but no production page has passed it. Removing it would change the shared module (`myjcb-statement-page.ts`) digest and require new releases/reparsing of all four MyJCB parsers without changing any observations. Remove it when next releasing MyJCB parsers for another reason.

Round 4's structural investigation (label counts only, no values) found that a position-1 page saved by an earlier run had the full unconfirmed header set (`ご利用日 / ご利用先など / 支払区分 / ご利用金額`) under an `(確定分)` heading, with `今回のお支払い金額` occurring 0 times. Live at the same position that day, the header was confirmed. Which labels appear varies by night/session for unknown reasons. The page itself displays its total through dt `YYYY年M月D日(曜)お支払い金額合計` ("total payment amount on year YYYY, month M, day D, weekday") and dd `#,###円` ("#,### yen") in `div.detail-box-price-01 dl`.

The fourth label identifies the summary amount: `今回のお支払い金額` means that statement's payment amount; `ご利用金額` means usage amount. The two differ for installment, revolving, and bonus rows, so the label alone cannot make `ご利用金額` a payment amount. The owner therefore decided to accept it only when proven by the page itself (`usageHeader` in `readMyJcbStatementPage`).

| Header combination          | Condition                                                           | State                                | Stored ledger headers                      | Row amount                                                       |
| --------------------------- | ------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------- |
| h1 and `今回のお支払い金額` | None                                                                | `confirmed`                          | Confirmed set                              | `今回のお支払い金額` (`current-statement-payment`)               |
| h1 and `ご利用金額`         | Every row is single payment and row sum equals total payment amount | `confirmed`                          | Unconfirmed set (as displayed by the page) | `ご利用金額` (`confirmed-usage`). No row payment amount recorded |
| h1 and `ご利用金額`         | Above not satisfied                                                 | Stop (`credit-statement-state`)      | —                                          | —                                                                |
| No h1, `ご利用金額`         | None                                                                | As before (position 1 `unconfirmed`) | Unconfirmed set                            | `ご利用金額` (`unconfirmed-usage`)                               |

- **Payment category.** Read row payment categories from the combined `ご利用先など／支払区分` ("merchant etc. / payment category") cell in `summaryCells[1]`, using the same rules as card purchase recognition (`myjcbSinglePayment` in `packages/domain/src/myjcb-amounts.ts`). At least one payment count must appear, all must be 1, and none of `分割` ("installments"), `リボ` ("revolving"), `ボーナス` ("bonus"), or `キャッシング` ("cash advance") may occur. Forms are `1回払` (all production rows), `1回払い`, `一回払い` (all "single payment"), and full-width digits; no new labels are added. Reject with `usage_header_payment_type_unproven` for nonmatching rows, cells lacking payment categories, empty cells, or rows unreadable as 4 cells.
- **Total.** The row amount is the one of the third/fourth cells readable as exact yen (same reading as the ledger parser). Sum exactly with `sumQuantities` and compare with the page's single `…お支払い金額合計` ("…total payment amount"). Reject with `usage_header_total_missing` if total is absent, multiple, or unreadable; use `usage_header_total_mismatch` if row amounts are unreadable or the sum differs. Add refund rows with their signs. A ledger without rows proves only total 0.
- **Row location.** All rows must be in the first `detail-list-01`. That is the only ledger saved by the collector; rows in another `detail-list-01` reject with `usage_header_rows_outside_first_ledger` even if totals match, preventing publication of a total with rows missing from the saved ledger. A second ledger without rows has no effect. Check this before payment categories/totals.
- Refusal reasons are closed codes (`USAGE_HEADER_REFUSALS`), emitted as `usageHeader` in stop logs. Log neither amounts nor provider strings.
- `myjcb-credit-ledger@1.2.0` reads these ledger amounts as usage (`usageAmountText`), without recording `paymentAmountText`. Card purchase recognition requires equal usage/payment amounts, so these rows are excluded with `payment_split_unknown` and unused in pending-to-posted matching. The statement payment amount is the page total, published by `myjcb-credit-statement-total@1.2.0` with `statementStateBasis: "page-heading-usage-total-proof"` and `ledgerAmountLabel: "ご利用金額"`. Pages with confirmed headers are recorded as in 1.1.0.
- Limitation: whether a stored page's second `detail-list-01` is part of the statement is unknown. Ledger artifacts still retain only the first ledger; rows in the second leave the page unproven and stop as before. ADR 0005 amendment (d) explains why row payment amounts are not treated as usage amounts. Expanded labels on this page were counted only, not read per row. This shape is a likely but unconfirmed cause of the 2026-09-25/26 stops.

<a id="ショッピングスキップ払いの支払予定2026-09-27adr-0005-の-amendment-e"></a>

### Shopping-skip-payment schedules (2026-09-27, ADR 0005 amendment (e))

Round 4 found position 8 had h1 `ショッピングスキップ払いご利用明細(未確定分)`, heading `YYYY年M月D日(曜)時点のショッピングスキップ払いご利用明細(YYYY年M月以降のお支払い分)` ("shopping skip payment statement as of year YYYY, month M, day D, weekday; payments from year YYYY, month M onward"), one `div.detail-list-01` (`div.head` with 3 cells: `ご利用日` / one cell with `ご利用先など` and `お支払日` on 2 lines / `今後のお支払い金額`), and 2 body rows. Body-cell contents/counts were not recorded. The owner decided to read only this page, observed with rows, as its own dataset.

- **Filename.** The collector examines only payment-schedule h1 (`schedulePageKind`). With exactly one h1 matching `ショッピングスキップ払いご利用明細(未確定分)` after whitespace removal, save as `credit-skip-payment-NN.html`; otherwise (bonus pages, absent/duplicate headings, full-width parentheses, etc.), retain `credit-schedule-NN.html`. From amendment (j), bonus-payment h1 is recognized as kind `bonus`, but its filename remains `credit-schedule-NN.html`. Manifest, codes, and coverage are unchanged.
- **Registration.** Only `credit-skip-payment-NN.html` gets dataset `credit-schedule`. `credit-schedule-NN.html` has no dataset and creates no parse job.
- **Parser.** `myjcb-skip-payment-schedule@0.1.2` (amendments (f)/(k), same observations as 0.1.0) reads only the observed shape: h1; an as-of heading when rows exist (one, valid calendar date/month); at most one ledger with rows; head with the observed 3 cells; ledger children consisting only of head followed by `content` rows (reject other nested rows rather than reading them as an empty ledger); each row with one 3-cell `item-cell`, the middle cell having exactly 2 lines (first merchant etc., second payment date); dates `YYYY/MM/DD`; exact-yen amounts. Body layout was not recorded, so only the head's layout is read. Reject other shapes with closed codes (`SKIP_PAYMENT_SCHEDULE_PARSER_CODES`); messages contain only the code. A ledger without rows means 0 rows, not failure. An empty ledger must have exactly one `content` row matching the observed empty row: one `item-cell` containing one `div.cell.w-100per`, with whitespace-stripped text `ご利用明細はございません。`; or that `item-cell` wrapped in one `div` lacking reader classes. Both shapes use `div` at every level, whitespace-stripped text consists solely of that wording, and the cell has no children (amendment (k)). An empty row alongside other rows rejects as the unobserved combination `schedule_row_shape_unobserved`. Because the kind is declared outside `types.ts`, the processor checks `scheduled_payment` rows before writing (`scheduledPaymentRows`: rows from other parsers, undeclared keys, invalid calendar dates, noncanonical integer amounts, etc. become `parse_contract_invalid`).
- **Observations.** Each row enters `scheduled_payment_observations` (migration 0061, append-only) as a `scheduled_payment` observation: usage date, payment date (`due_date`), future payment amount (exact integer decimal string, displayed sign), merchant etc. (`counterparty`), page as-of date, and in `extra_json` the displayed cells and month of `YYYY年M月以降のお支払い分` ("payments from year YYYY, month M onward"). External IDs use displayed-cell fingerprints and occurrence order, excluding as-of date.
- **Readers.** These are neither transactions nor balances; read paths, card purchase recognition, settlement candidates, and identity do not read this table. No double counting (INV06).

Limitations: what row amounts represent (one payment or remaining balance), and whether payments appear in later statement months, are unconfirmed; do not match them against statements/payments. Read models, APIs, and UI do not display them yet. Skip pages saved before this change remain unread `credit-schedule-NN.html`. Different body layouts (per-row expanded lists, 4 cells, payment date in a separate cell, etc.) make the first production parse fail with `schedule_row_shape_unobserved`; issue a new release after structural-only investigation. Do not read position 7 (bonus payments) until observed with rows (ADR 0004).

<a id="ledger-header-の改行と空の支払予定-page2026-09-28adr-0005-の-amendment-f"></a>

### Ledger-header line breaks and empty payment-schedule pages (2026-09-28, ADR 0005 amendment (f))

Round 5's structural investigation (stored R2 objects read only for structure/counts, no values recorded) and collector stop logs established the following.

| Page                                                 | h1                                                                                                                     | Head (3 cells)                                                                      | Body                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Confirmed month (all 8 stored pages)                 | `カードご利用代金明細(確定分)`                                                                                         | `ご利用日` / `ご利用先など` + `支払区分` / `今回の<br class="pc-none">お支払い金額` | 4-cell rows (date, 2 middle lines, amount, toggle button), all with `item-more` |
| Unconfirmed month (position 0)                       | `…(未確定分)` ("…unconfirmed portion")                                                                                 | `ご利用日` / `ご利用先など` + `支払区分` / `ご利用金額` (no `br`)                   | Same shape as confirmed months                                                  |
| Bonus payments (position 7, identical for 12 nights) | `ボーナス#回払いご利用代金明細(未確定分)` ("bonus # installment payment statement, unconfirmed portion"; # is 1 digit) | `ご利用日` / `ご利用先など` + `支払区分` / `ご利用金額`                             | Empty row only                                                                  |
| Shopping skip payments (position 8, 12 nights)       | `ショッピングスキップ払いご利用明細(未確定分)`                                                                         | `ご利用日` / `ご利用先など` + `お支払日` / `今後のお支払い金額`                     | Empty row only                                                                  |

The middle cell contains two `span.row` elements. Empty rows are `div.content > div.item-cell > div.cell.w-100per` with `ご利用明細はございません。`, without `item-more`. Confirmed-month pages contain only one `detail-list-01`; one of the two occurrences of that string in HTML is the class of the show-all button (`ul.list-btn-double.js-toggle-detail-list-01`).

- **Stop cause.** Runs on three nights, 2026-09-25–27 (UTC), stopped at position 1 with `ledger_parse` (`credit-ledger-headers`). Collector `nodeText` joins child nodes with whitespace, reading the confirmed-month header as `今回の お支払い金額` ("current payment amount," with a separating space), which did not contain `今回のお支払い金額`. The collector now compares labels (ledger headers, menu/statement-month h2) as strings with all whitespace removed (`compactText`). Shared page reading (`readMyJcbStatementPage`) and `myjcb-credit-statement-total` already removed whitespace, so they read the same page as confirmed. Differences other than whitespace still stop. Because `nodeText` inserts spaces at element boundaries, removing them also allows labels split across elements (including adjacent head cells) to match, as in shared page reading. Cell values remain saved as whitespace-joined strings.
- **Empty payment-schedule pages.** `myjcb-skip-payment-schedule@0.1.1` reads a ledger containing only the empty row above as 0 rows. Collector row counting (`scheduledLedgerRowCount`) likewise excludes empty rows. Bonus-payment pages remain unobserved with rows, so save them as unread `credit-schedule-07.html` as before.
- **Release.** `myjcb-skip-payment-schedule` 0.1.0 is already registered in production `parser_releases` (no parse runs); migration 0028 rejects changed digests at the same version, so use 0.1.1. The four MyJCB parser digests are unchanged.

Limitations: body text of shopping-skip-payment pages with rows was not saved and remains unobserved (amendment (e)). Pages mixing data/empty rows are unobserved (and rejected if encountered).

<a id="支払日つきの明細見出し2026-09-28adr-0005-の-amendment-g"></a>

### Statement headings with payment dates (2026-09-28, ADR 0005 amendment (g))

The first nightly run after amendment (f) (2026-09-28 21:01Z) stopped at position 1 with `credit_statement_period`. Round 5's structural investigation (no values recorded) found confirmed-month h2 `YYYY年MM月DD日(曜)お支払い分のカードご利用明細`, with a payment date and one parenthesized weekday character before `お支払い分` ("for payment"). Bonus-payment h2 has the same dated shape. The collector/statement-total parser read only `YYYY年M月お支払い分のカードご利用明細`, so they read the page as stating no month and stopped at position 1, which lacked a past-month API label. Earlier stored confirmed pages have the undated form (all 24 `ok` parses by `myjcb-credit-statement-total@1.2.0` passed this form). Both forms have been observed.

- **Reading.** Collector/parser share `readMyJcbStatementHeading` in `packages/domain/src/myjcb-statement-heading.ts`. An h2 is a heading only if its whitespace-stripped text exactly matches the undated form or `YYYY年M月D日(W)お支払い分のカードご利用明細` (W is one of `月火水木金土日` ("Monday through Sunday"), with ASCII parentheses). As with the page total label `YYYY年M月D日(曜)お支払い金額合計`, do not apply NFKC. Month must be 1–12 and day must exist in that month. Validate weekday shape only, not agreement with the date. Full-width parentheses, other weekday forms, and other wording are not headings; confirmed pages stop as before.
- **Collector.** Record the heading month as `YYYY-MM` period, not its date. Stop on two headings (including a dated/undated pair).
- **Statement total (`myjcb-credit-statement-total@1.3.0`).** For dated headings, fail parsing if the heading date differs from the total's payment date. Record undated-heading pages as in 1.2.0.
- **Release.** All four MyJCB parsers share `packages/parsers/src/parsers/myjcb.ts`, so the other three change only their digests: `myjcb-credit-ledger@1.2.1`, `myjcb-credit-past-month-balances@1.1.4`, `myjcb-canonical-evidence-boundary@1.1.4`. Observations are unchanged. Amendment (d)'s unobserved route remains in this release.

Limitations: do not read bonus-payment pages' dated h2 (pages remain `credit-schedule-07.html`). The collector compares heading dates against nothing. **Correction (2026-10-04, amendment (j)):** menu reading actually made position 7 a month, so bonus-payment pages were saved as `credit-detail-07.html` and read by the statement parser (without totals). See amendment (j) below.

<a id="同じ-page-を示す複数の-position-と月として読まれたスキップ払い-page2026-09-29adr-0005-の-amendment-h"></a>

### Multiple positions showing the same page and skip-payment pages read as months (2026-09-29, ADR 0005 amendment (h))

The first nightly run after amendment (g) (collection run 561, fetch run 908, 2026-09-29 21:03Z) read all months, with unit `success` and all 5 ledgers parsed. Production was read only with aggregate queries (counts, in-SQL digest comparisons, closed codes, position numbers; no values recorded).

- **Four positions, one page.** The 11 `credit-detail-NN.html` artifacts had 8 distinct digests; positions 3, 4, 5, 6 were the same byte-identical object. `myjcb-credit-statement-total@1.3.0` produced `manifest_artifact_ambiguous` `error` results on these 4 artifacts (4 artifacts × 3 attempts = 12; the other 7 pages were `ok`). Shared-R2 manifests identify pages by bytes (ADR 0025). The collector read each page as `unknown` (neither `(確定分)` heading nor rows) but wrote a position label (`settlementYM ?? detailMonth-N`) as period. The 4 entries for identical bytes therefore had conflicting periods, and the extractor stopped without selecting one.
- **The provider shows the same page.** In the earlier 12 runs (fetch runs 215–719; importer-shaped manifests named entries by filename, avoiding ambiguity), positions 2–6 were one object in every run (60 artifacts, one digest across 12 runs, state `unknown`, period each position's label). In run 908, position 2 became a separate confirmed statement, leaving group 3–6: only the position receiving the moved closed statement left the group. The collector fetched each position after the menu in the same session with its own `detailMonth`; positions read after the group in the same run (7, 8, 11, 14) were distinct pages, with 11/14 confirmed statements with ledgers. Round 4 recorded positions 3–6 without ledgers; menu `過去の明細` boxes said `… お支払い分 #円` ("…payment portion, # yen") or `ご請求はありません` ("there is no bill"). This is therefore a provider page for past positions without bills, not a collector-navigation error; the page itself states no month.
- **Skip-payment pages were read as months.** No MyJCB `credit-schedule-NN.html`/`credit-skip-payment-NN.html` was registered (0 rows). Run 908 saved positions 7/8 as `credit-detail-07.html`/`credit-detail-08.html` (months), with neither `credit-schedule` dataset nor `myjcb-skip-payment-schedule` parse runs. Both were read as `unknown` without rows, keeping unit `success`; the statement parser recorded `statement_total_not_confirmed` for both. Position 8 had different digests in all 13 stored runs (skip-payment pages' as-of headings contain dates); position 7 had one digest in the earlier 12 runs (bonus page, amendment (f)). The deployed Worker included `readCreditMenuGroups`; neither menu-group reading nor overlap checks with the past-month API stopped. Thus either that night's menu placed links 7/8 under a month heading (for example, a payment-schedule heading other than `h2` put them under the preceding `最新のご利用明細` in observed DOM order 0, 1, 7, 8, 2–6), or the menu omitted 7/8 and the past-month API made them available. Stored menus lack `href`, and manifest/past-month response bytes were not read from R2, so which occurred is unknown.

The collector records only what pages state (`collectCredit`).

- **No period on `unknown` pages.** Manifest entries for `credit-detail` recorded as `unknown` (months without state, unread months, stopped pages retained) have no `period`. Positions remain in artifact keys; past-month API labels remain in `credit-past-months.json`. State-bearing page periods (unconfirmed `detailMonth-0`/`-1`, confirmed stated month or past-month API label) and ledgers are unchanged. Nothing reads `unknown` page periods (read models read only ledgers; statement parsers compare periods only on confirmed pages). The same bytes state the same thing at any position, so the extractor reads them unchanged.
- **One page states one thing.** Within a connection, a monthly page with the same redacted bytes as a page saved at an earlier position must have the same state/period. If they differ (for example the same unconfirmed page at positions 0/1 creating two unconfirmed statements; unobserved), stop there with `credit_page_repeated` (condition `credit-page-repeated`) without saving that page. Save earlier months. Logs emit only position/code.
- **Skip-payment pages at month positions.** Check `schedulePageKind` (amendment (e)) before reading monthly page state. If exactly one h1 matches observed `ショッピングスキップ払いご利用明細(未確定分)`, save as `credit-skip-payment-NN.html` (dataset `credit-schedule`, state `unknown`, period `detailMonth-N`), like menu-designated schedule pages; write `scheduled_payments_page` in `schedulePages` and count in `schedulePageCount`. It is not a month and enters neither `periodCount`, `capturedMonthCount`, nor `unreadMonths`. Log `myjcb-credit-month-schedule-page` emits only position/code. `schedulePages` is ascending by position; on stops, it includes schedule pages found at earlier month positions (menu-designated schedule positions remain unread after a stop).
- **Unchanged.** Metadata extractor, menu reading, bonus-payment pages (still `unknown` months in `credit-detail` at month positions; made schedule pages by amendment (j)), and all parsers. Stored runs are not rewritten. Run 908's 12 `error` results remain history (the manifest is fixed evidence; reparsing gives the same result).

Limitations and observations requested from the owner's agent (structure/counts/booleans only; no values recorded):

1. Run 908's saved `credit-detail-03.html` (03–06 share bytes): h1 count and whether each h1 is `カードご利用明細一覧`, `カードご利用代金明細(確定分)`, or other. Presence of `ご請求はありません`, `通信エラーが発生しました`, and `ご利用明細はございません` ("there are no statement details," without the final full stop) in body text (booleans). `detail-list-01` count. H2 count and presence of an h2 shape read by `readMyJcbStatementHeading` (boolean). This distinguishes no-bill and communication-error pages.
2. Run 908's saved `credit-past-months.json`: `detailPastJsonInfo` count; presence of items for `detailMonth` 7/8 and, if present, their `detailAvailableFlag`/`payAmountDispFlag` (booleans).
3. Live `detailMenu.html`: for each `detail.html?detailMonth=N` link, N; which of the three observed headings the last preceding `h2` in document order matches (code only, no text recorded); and tag name of the heading element in the link's box (`h2`, `h3`, `p`, etc.). Whether the payment-schedule box heading is `h2`.

If 1 is a communication-error page, decide a recognition rule (amendment (b)'s limitation). If 2/3 identify how 7/8 became months, fix menu reading. **Answer (2026-10-04, round 9, amendment (j)):** 1 was a no-bill page stating no month, not a communication-error page. In 3, the payment-schedule heading was `h3`; reading only `h2` placed 7/8 under `最新のご利用明細`. See amendment (j) below.

Duplicate checks cover only monthly `credit-detail` pages. Payment-schedule entries carry position labels as periods (`myjcb-skip-payment-schedule` compares them with keys), so storing the same skip-page bytes at two positions (two month positions, or a month position plus a menu-designated schedule position) yields two periods; the extractor rejects both with `manifest_artifact_ambiguous`. This is unobserved (position-8 digests differ across stored runs).

<a id="最初に保存されたスキップ払い-page-の拒否2026-10-02adr-0005-の-amendment-i"></a>

### Rejection of the first stored skip-payment page (2026-10-02, ADR 0005 amendment (i))

The first nightly run after amendment (h) (collection run 612, fetch run 956, 2026-10-02 21:00Z) was `success` with 19 artifacts; `myjcb-credit-statement-total@1.3.0` was `ok` on all 10 pages. The first `credit-schedule` artifact (`credit-skip-payment-08.html` at month position 8) was registered; `myjcb-skip-payment-schedule@0.1.1` produced a `parser_rejected` `error` (1 parse run, job `failed`, no `parse_issues`). Production was read only through aggregate queries.

- **Metadata matches parser requirements.** Key shape, state `unknown`, period matching key `detailMonth-N` (both metadata projection and artifact row), media type, run `success`. Month-position/menu routes write the same entry through the same function (`schedulePageArtifact`). This is not a collector mismatch.
- **HTML boundaries passed before.** Parser boundary checks are verbatim identical to statement-parser checks, which passed all 15 earlier position-8 pages (the same page saved as a month before amendment (h)).
- **It is an empty page.** Its size is within 2 bytes of each of those 15 pages (identical to 3); round 5 recorded them as empty pages.

Thus some reader structural check rejected the stored empty page (`schedule_head_unobserved`, `schedule_row_shape_unobserved`, or `schedule_as_of_invalid`/`schedule_ledger_ambiguous` if the empty row was not accepted). Which one is in the R2 bytes, unread in this change. Parser, collector, and extractor are unchanged (ADR 0004).

Counts-only replay also selects MyJCB, passes the latest completed (`ok`/`absent`) metadata projection's state/period from the extractor release read by the processor (`active_releases` row, or `legacy-metadata-v1` if absent) to the parser, and outputs skip-page structure: h1 count, as-of-heading count, children of each `detail-list-01`, head children/whether the three cells match expectations, and structure/count of each `content` row. Tags use a closed list, classes only those read by the reader; no text/attribute values are output.

Observation requested from the owner (one execution; output only codes, booleans, counts, closed names):

```sh
mise exec -- bun services/processor/scripts/replay-diagnostics.ts myjcb-skip-payment-schedule 1
```

Ask the owner to share output `category.reason` (closed code) and `shape` lines verbatim. Use them to write the next amendment aligning the reader to the observed shape (`myjcb-skip-payment-schedule` 0.1.2 and parser-release migration). Until then, no skip-payment `scheduled_payment` observations exist. Months are unaffected.

<a id="menu-の-h3-見出しとボーナス払い-page2026-10-04adr-0005-の-amendment-j"></a>

### Menu h3 headings and bonus-payment pages (2026-10-04, ADR 0005 amendment (j))

The owner's live research (round 9: shapes, counts, fixed wording, booleans only; no values recorded) and production aggregate queries (round 7) resolved amendment (h)'s two questions.

- **Menu headings.** Two h1s (logo and `hdg-H1` `カードご利用明細一覧`, card statement list), five h2s, four h3s. Nine `detail.html?detailMonth=N` links in DOM order 0, 1, 7, 8, 2, 3, 4, 5, 6, all `明細を見る` (view details). Heading document order: `h2.hdg-H2` `最新のご利用明細` (latest usage), **`h3.hdg-H3` `ボーナス#回払い・ショッピングスキップ払い`** (bonus # installments/shopping skip payments; # is a number), `h2.hdg-H2` `過去の明細` (past statements), then lower-page guidance `h2`/`h3` after every link. Each box has preceding `p.hdg`. Using only the last `h2` groups 7/8 under latest usage as months, matching fetch run 908's `credit-detail-07/08.html`.
- **Bonus page (position 7).** `h1.hdg-H1` is `ボーナス#回払いご利用代金明細(未確定分)` (bonus # installment statement, unfinalized; # numeric). Three h2s, one `hdg-H2` exactly `YYYY年M月D日(曜)お支払い分のカードご利用明細` (dated payment-month statement), amendment (g)'s dated heading. One `detail-list-01`, three tables, `ご利用明細はございません` (no usage details), one `form` (method `get`, action `/iss-pc/member/details_inquiry/detail.html`, no hidden inputs). H2 alone cannot distinguish a monthly statement.
- **Shopping skip page (position 8).** H1 `ショッピングスキップ払いご利用明細(未確定分)` (shopping skip details, unfinalized); `hdg-H2` has `YYYY年M月D日(曜)時点のショッピングスキップ払いご利用明細(YYYY年M月以降のお支払い分)` (as-of shopping skip details for payments from the stated month), not the dated-statement heading. One `detail-list-01`, two tables, no-usage wording; same form shape as position 7.
- **No-bill pages (3–6).** Identical bytes/SHA-256, no month element. `h1.hdg-H1` `カードご利用代金明細` (card payment statement), without `(確定分)` (finalized), not the statement-list title; body `当該月の請求はございません` (no billing that month). Zero h2s, no `detail-list-01`, tables, forms. None of `ご請求はありません` (no billing), `通信エラーが発生しました` (communication error), `ご利用明細はございません`. HTTP 200/no redirect. This identical content caused 60 `error` cases of `manifest_artifact_ambiguous` at 03–06 in runs 908/921/940; after (h), all 10 pages in run 956 were `done`.

Collector/statement-parser changes:

- **Menu.** `readCreditMenuGroups` assigns each link to the last preceding `h2` or `h3`. Same three headings/comparison: strip whitespace, # accepts ASCII/fullwidth digit sequences, exact otherwise, both levels. Links before headings, beneath other `h2`/`h3`, or positions in both groups still stop with `credit_menu_group_unrecognized`, count-only logs. Later guidance headings do not affect links. All-`h2` shapes recorded in (c) yield the same groups.
- **Bonus h1.** `myjcbSchedulePageHeadingKind` in `packages/domain/src/myjcb-schedule-page-kind.ts` returns `skip-payment` first for amendment (e)'s exactly-one skip h1; otherwise `bonus` for exactly one whitespace-stripped h1 matching `ボーナス[0-9０-９]+回払いご利用代金明細\(未確定分\)`, else `unobserved`. A separate module avoids changing `myjcb-skip-payment-schedule` digest. Collector `schedulePageKind` reads it.
- **Collector.** Save `bonus` as `credit-schedule-NN.html` (dataset `credit-schedule`, state `unknown`, period `detailMonth-N`). Registration gives that filename no parser dataset, so none reads it (ADR 0004). Schedule positions are unchanged. At month positions, save before reading state like (h)'s skip pages; write `scheduled_payments_page` in `schedulePages`, count in `schedulePageCount`, exclude from `periodCount`, `capturedMonthCount`, `unreadMonths`. Log `myjcb-credit-month-schedule-page` position/code only.
- **Statement total (`myjcb-credit-statement-total@1.4.0`).** After HTML-boundary checks, before state, h1 kinds `skip-payment`/`bonus` yield observation-free `ok` and closed warning `schedule_page_not_statement`, regardless of h2, finalized h1, or totals. Other pages read as 1.3.0. Avoid `error` because `error` runs do not replace older `ok` runs.
- **Release.** Four MyJCB parsers share `myjcb.ts`; only digests change for `myjcb-credit-ledger@1.2.2`, `myjcb-credit-past-month-balances@1.1.5`, `myjcb-canonical-evidence-boundary@1.1.5`. `myjcb-skip-payment-schedule@0.1.1` digest unchanged. Processor self-registers deployed `parser_releases`; no version-pinning migration, so none added, as in 1.3.0.
- **No-bill pages.** Unchanged: no finalized h1/ledger means `unknown`; both 1.3.0/1.4.0 give observation-free `ok`/`statement_total_not_confirmed`. No zero-yen total (INV05). Collector stores each as periodless `unknown`, per (h).

Production impact, as a limitation: every stored `credit-detail-07.html` is a bonus page registered as a month: 12 runs 215–719 with position 7, run 908, later runs until this deployment, including run 956's 10 details; 921/940 were not counted per position. Pre-(h) `credit-detail-08.html` skip pages are likewise monthly artifacts. All received observation-free `ok`/`statement_total_not_confirmed` in 1.3.0 from 2026-09-29 (earlier versions before that), without totals because no finalized h1. However, published interpretation was as statements, with only the h1 rule separating bonus dated h2 from totals. Deployment rewrites nothing. Repair reparses stored pages at 1.4.0; those `ok` runs (`schedule_page_not_statement`) replace artifact 1.3.0 `ok` pointers through `publishBatch`. Read-model observations are unchanged, absent in both. Fixed-manifest `manifest_artifact_ambiguous` artifacts in 908/921/940 still fail in 1.4.0. Affected artifact count was not measured.

Limits: round 9 is one connection/one night. Changed schedule-heading levels or guidance moving before links stop the connection before its first month without guessing. Bonus pages with rows remain unobserved. No custom no-bill recognition: absent finalized h1/ledger simply means `unknown`.

<a id="一段深い空の行2026-10-08adr-0005-の-amendment-k"></a>

### One-level-deeper empty rows (2026-10-08, ADR 0005 amendment (k))

The owner identified/read one skip page from the 2026-10-06 nightly run by SHA-256/size (artifact 11644, rejected by `myjcb-skip-payment-schedule@0.1.1` as `schedule_row_shape_unobserved`), sharing only structures/counts/booleans. No strings, values, or provider classes were shared or recorded here.

- **Page.** Exactly one skip h1, one `detail-list-01` containing only `div.head` then `content` rows; observed three-cell head, already known empty-page shape.
- **Row.** One `content`: `div.content > div > div.item-cell > div.cell.w-100per`. The intermediate `div` has none of reader classes `detail-list-01`, `head`, `content`, `item-cell`, `cell`, `w-100per`. Every level has exactly one child; cell has none. At every level row→cell, whitespace-stripped text is exactly `ご利用明細はございません。` (no usage details). This is (f)'s empty row one level deeper; 0.1.1 required direct-child `item-cell`, counted/rejected it as data.
- **Parser (`myjcb-skip-payment-schedule@0.1.2`).** `isEmptyLedgerRow` now accepts this shape. Same (f) rule: zero rows only for a single `content`; beside other rows or duplicated, reject `schedule_row_shape_unobserved`. Reject two-plus `div` wrappers, reader classes on wrappers, other children/text/wording, cell children, wrapped data rows. In either shape reject non-`div` row/wrapper/`item-cell`/cell, extra text at any level, or child elements in the cell. Observed shapes are all `div` showing wording only; 0.1.1 had allowed arbitrary elements for unwrapped row/`item-cell`, adjacent text, and cell children. Data rows still require unwrapped three-cell `item-cell`. No new codes or changed observations versus 0.1.1. Use existing reader helpers `children`, `hasClass`, `text`, `compact`, no new module/dependency.
- **Release.** Reader enters four statement-parser digests through (j)'s `myjcb-schedule-page-kind.ts`; only digests change for `myjcb-credit-ledger@1.2.3`, `myjcb-credit-past-month-balances@1.1.6`, `myjcb-credit-statement-total@1.4.1`, `myjcb-canonical-evidence-boundary@1.1.6`, reading every page as before. Processor self-registers releases; no migration.
- **Collector.** Unchanged: shared statement reading already searches all descendant `item-cell` depths and counted zero; h1 determines storage.

Deployment rewrites nothing. Repair with five new releases makes this skip shape observation-free `ok`; statement artifacts' identical-observation `ok` runs replace older runs. Counts were not measured.

Limits: one page only; other stored skips, including (i)'s first, were not checked. Unknown whether round 5 omitted this `div` wrapper or pages later changed. Other shapes still refuse; populated pages remain unobserved. Production replay/deployment were not verified in this change.

<a id="カード情報引落口座2026-09-27adr-0032-の-amendment"></a>

## Card information (debit account) (2026-09-27, ADR 0032 amendment)

Round 4 counts/structure only: finalized `detail.html?detailMonth=N` and position-8 skip pages have no `カード・お振替情報` (card/debit-transfer information) heading. Debit accounts appear after the grid under `h3.hdg-H3` `カード情報` (card information), in `div.detail-lyt-02.border-01 > div.col-01 > table.table-data`, a vertical th/td table. Rows: `カード名称` (card name), `カード発行会社` (issuer), `金融機関名` (bank name), `支店名` (branch name, no number), `科目・口座番号` (account type/number) shaped `普通 ####\*\*\*` (ordinary, space, **first** four digits, remaining `*`), `口座名義` (partially `*`-masked holder). Stored redacted `credit-detail-NN.html` retains the same table.

- Read: `readMyJcbCardInformation` (`packages/domain/src/myjcb-card-information.ts`) reads only bank/branch/type/first four/`*` count, not card-name/holder values because no consumer exists. Stored HTML preserves displayed holder, ADR 0029 amendment 2. Find by h1–h6 `カード情報`, following first table/th labels, not classes; other shapes refuse closed codes.
- Store: processor `card_debit_account_sweep` rereads R2 pages with published `myjcb-credit-statement-total`, adding one append-only `card_debit_account_statement` (migration 0060) per card/raw object/reader version.
- Use: evidence attached only to settlement candidates; no changes to facts/eligibility/approval ([card-settlements.md](../card-settlements.md#provider-stated-debit-accounts)).
- Collector unchanged; already redacted HTML needs no collector reading.

## J-POINT

Authenticated structural observation on 2026-10-10 confirmed a read-only JSON-RPC point response for the currently selected supported JCB W connection. The response has jsonrpc=2.0, echoed string id, result.errId/result.errMessage strings, and pointJsonInfo with pointHyoujiTanniName and normalPointInfo/specialPointInfo/totalPointInfo. Each point container has string point/expirePoint/expirePointDate and boolean pointDispFlag/expirePointDispFlag. Observed unit label is `ポイント` (points). The DOM labels are `保有ポイント` (held points) / `累計` (cumulative) / `通常ポイント` (regular points) / `ボーナスポイント` (bonus points). A private exact-integer structural check established that the displayed total equals the normal-plus-bonus components and that the displayed expiring portion does not exceed the total; no private values, identifiers or dates are recorded here.

The response uses grouped integer point strings and Japanese full expiry dates with weekday suffix. Display flags control observation: false does not mean zero, no expiry, or an empty entire holding. Only one total balance is emitted. Provider fields are preserved; the expiry quantity/date is normalized as a generic non-additive holding-subset display associated with that total's exact source fact. Normal/special labels are not mapped to confirmed bucket kinds. The total remains unclassified, and its full balance has no observedExpiry; READ displays the subset separately under ADR 0068. No remainder, history, lot identity, calendar expiry rule, or policy-calculated deadline is inferred.

This is a supported response contract for one confirmed current connection, not proof that all MyJCB cards share the programme. Root-card switching, unsupported card programmes and J-POINT activity/history remain outside the contract. Public programme terms are not a calculation rule for an unobserved holding. Missing/unreadable values remain typed missing/unknown. The synthetic point fixtures mirror the observed structure with unrelated values.

Acquisition is limited to the active card whose public `JCBカードW` (JCB Card W) token appears in one `SPAN.txt` immediately under `P.user-stage`. Private label adornments are excluded from the gate. Browser inspection verified the token/tag structure and adornment lengths; a separate boundary-category inspection timed out. Changed or unsupported boundaries therefore fail closed and can remain unsupported. No card switch is attempted.

The collector reads points only after statement-history collection finishes without a stop outcome. It makes one fixed POST to the observed pointJson route, without query parameters, redirects or retries. It bounds the request at 30 seconds and the response stream at 1 MiB and validates JSON-RPC schema and echoed request ID before retaining private R2 evidence. The closed `jpointCode` distinguishes collected, unsupported, stopped and unavailable; the independent reward unit exists only for eligible products. Unavailable/stopped remain unknown and do not alter history coverage. Authentication structure and synthetic tests establish this implementation's basis; they do not prove a collector run against the provider or a post-deployment live capture.

## J-POINT history and statement-file observation, 2026-11-09/10

An owner-authenticated, read-only session exposed
`GET /iss-pc/member/point/pointInquiry.html?link_id=myj_main_pointInquiry`,
which linked `GET /iss-pc/member/point/pointHistoryInquiry.html`.
The inquiry/history pages were server-rendered HTML; no history JSON request
or pagination control was observed. Recruit's point-inquiry links went to the
error page and are not treated as J-POINT support. Root-card switching remains
outside this collector path.

The **raw HTTP response** contains three
`.tab-panel > .js-scrollable-tbl > table` elements, each with THEAD/TBODY
and the same 27 acquisition rows. This count is an observation, not a retention
constant. The live DOM's `.js-scrollable-tbl-head/body` wrappers and toggle
buttons are JavaScript additions and are not parser selectors.

- Overview headers: `獲得月（支払月） / 獲得ポイント / 使用済ポイント /
  失効ポイント / ポイント残高`. Date TD `.sp-fnt10px` contains direct
  YYYY/MM/DD text, `br.sp-block`, then a SPAN with payment M/D or a dash.
  The four numeric TDs are plain text with `num sp-fnt10px`; the last also
  carries the provider's point-history balance classes.
- Detail headers: `獲得月（支払月） / 当月獲得ポイント合計 / 詳細`.
  The second TD contains `div.inner` with the total and
  `div.js-toggle-content > dl.detail` with DT/DD pairs for
  `通常獲得ポイント / 優遇ポイント / ボーナスポイント`.
  All 27 totals and 81 component DDs were plain signed ASCII integer text,
  without commas, suffixes or empty values. All 27 displayed totals matched
  the exact sum of their three displayed components. The raw third
  `td.js-toggle-item` contains `開く` as text, not a generated button.
- Expiry headers: `獲得月（支払月） / 失効予定ポイント / 失効予定月 /
  ステータス`. Quantity, month and status cells are plain text. Every
  quantity matched the corresponding overview remaining quantity. Expiry was
  YYYY/MM or `-`; missing months had explicitly zero remaining points.
  Observed row statuses were `-` and `有効`. The same UI documents
  `集計中 / 期限迫る / 当月失効`, but populated rows in those states were
  not observed. No independent grand-total marker was found on this page.

The UI explains that used points are displayed as a monthly negative activity,
while deductions consume the earliest-expiry acquisition buckets. Consequently
monthly earned/used/expired quantities do not reconstruct a row's remaining
quantity. They are retained separately. Acquisition YYYY/MM/DD, payment M/D,
expiry YYYY/MM and capture time have distinct roles.

The collector reuses the existing run's J-POINT JSON total, validates the exact
sum of remaining quantities and cross-checks all three tabs before publishing
`myjcb-jpoint-history` measures. It keeps sanitized inquiry/history HTML and
normalized JSON under an independently sealed history unit. Month-only expiry
stays month-granularity; no expiry day or usage year is invented. Unknown
shapes/statuses or mismatched values leave that unit unavailable, preserving
its captured evidence.

Current reward holdings select complete acquisition membership only when its
total and the newest total revision belong to the same capture and every
bucket has been promoted. A newer total with missing/failed history selects
that current total and reports a stale/unavailable history gap. Older history
remains dated evidence. The total and acquisition buckets are never added.
See [ADR 0107](../adr/0107-myjcb-point-history-and-document-boundary.md).

The credit menu offered positions in the existing month/schedule groups.
Its past-month POST, JSON-RPC `execute` with
`params: [{ generalJsonShikibetuId }]`, offered additional sparse positions
12 and 15. The existing h2 month / h3 bonus-skip schedule distinction is
unchanged: positions 7/8 are not reinterpreted as statement months. The walk
reads the union of provider-offered month positions; missing indices are not
invented or mapped to calendar months.

An explicitly confirmed detail at `detail.html?detailMonth=1&output=web`
offered same-month relative PDF, CSV and OFX links:
`detailDbPdf.html?detailMonth=1&output=pdf`,
`detail.html?detailMonth=1&output=csv` and
`detail.html?detailMonth=1&output=money`. The unconfirmed position 0 offered
none. A separate newsletter also had PDF-labelled text, so only actual
statement hrefs qualify.

The browser blocked the observed download before an HTTP response. No file
bytes, media type or CSV/PDF/OFX schema is verified; the restriction was not
bypassed. Files remain unfetched. The sanitized manifest records the closed
`documentCode: statement_export_bytes_unverified`, while confirmed HTML and offered kinds
are retained. Document coverage remains not collected and #1251 stays open for file
verification/storage and live reader validation.

## Debit statements and registered display alternatives (2026-11-10)

Authenticated owner-machine Chrome observation, read routes only, for
[#1239](https://github.com/risu729/kogane/issues/1239). The MyPage ID-switch
modal offered four registered alternatives beside the original credit card:
one Recruit credit card and three debit cards, including Mizuho. This confirms
reachable display alternatives; it does not inspect or alter connection secrets.

- List request: `POST /iss-pc/member/common/pluralIdChangeAjaxMypage.html`,
  no body. Modal `.modal-wrap` contains `a[onclick]` calling
  `idSwitchLogin('0')` through `idSwitchLogin('3')`.
- Selection: `POST /iss-pc/member/common/pluralIdChangeRedirect.html` with
  fields `ajaxResult`, `isListEmpty`, `errorMessage`, `sosalogId`, `smpFlg`,
  `listNum`; then `POST /iss-pc/member/user_manage/userSwitchingIdLogin.html`
  with `transitionId`; then `GET /iss-pc/member/user_manage/userLoginForward.html`
  to MyPage. Field values and card identities remain private. This sequence
  alone does not establish a durable cross-run card identity or a complete
  relay response schema.
- Debit menu: `GET /iss-pc/member/debit/details/debitDetailMenu.html` with
  `link_id=myj_main_debitDetailMenu` (navigation also offers
  `myj_nav_debitDetailMenu`). Latest detail is `debitDetail.html?seq=0`;
  past menu options offer `seq=1..14`, and detail `select#seq[name=seq]`
  offers `0..14`. The UI states fifteen months, updated around the sixteenth.
- Ordinary desktop section: `ご利用明細内訳（お振替済分）`, with headers
  `ご利用者 / お振替日 / ご利用先など / お振替金額 / 摘要 / 承認番号`.
- Difference desktop section: `ご利用明細内訳（差額・お振替未済分）`, with
  headers `ご利用者 / 差額発生日 / ご利用先など / 差額 / 摘要 / お取引結果 / 承認番号`.
  The observed status is `銀行振替済`. Dates use `YYYY/MM/DD`; amounts are
  signed integer/comma strings. One ordinary row and one negative difference
  shared their approval number and merchant. Neither row may be dropped or
  rewritten into a payment. `.pc-disp` and `.sp-disp` repeat the same display;
  the reader uses desktop tables only.
- Mizuho's observed empty ordinary page uses `p.comment` with exact pattern
  `[YYYY年M月D日 ～ YYYY年M月D日分]のご利用代金明細はございません`.
  The selected option names `YYYY年M月D日～YYYY年M月D日分`. Zero is admitted
  only when those periods match; absent tables alone establish no zero.
- Separate difference/other route:
  `GET /iss-pc/member/debit/od_details/debitOdDetailMenu.html`, then form
  `GET /iss-pc/member/debit/od_details/debitOdDetail.html` with `seq=1..14`
  and `inquiry=照会`, encoded by the official form as Shift_JIS
  `%8F%C6%89%EF`. All fourteen observed responses explicitly said
  `選択された月のご請求はございません。`. On the observed Mizuho page the
  marker is `div.main > div.main-header > h1.heading01-01`, with no
  `p.comment`. This does not erase differences in
  ordinary detail tables. Nonempty `od_details` schemas remain unobserved.
  Both menus use `select#seq[name=seq]` with options `1..14` and may include
  an empty placeholder. The ordinary menu has one real latest-detail href
  `/iss-pc/member/debit/details/debitDetail.html?seq=0`. No latest `seq=0`
  link was observed on the empty other-statement menu, so none is invented.
- Ordinary detail offered `debitDetailPdf.html?seq=N` and
  `debitDetailCsv.html?seq=N`. The visible CSV click reached Chrome
  `ERR_BLOCKED_BY_CLIENT`; no export bytes or signatures were verified.

No private dates, amounts, merchant names, account identifiers, session fields,
credentials or raw provider HTML are recorded here. Synthetic tests mirror
only these structures. See [ADR 0101](../adr/0101-myjcb-debit-statements.md).

## Original credit statement exports observed on 2026-11-12

This supersedes the earlier credit-download blocker above. Normal owner-machine
browser clicks on two credit displays downloaded CSV, PDF and OFX files. A
fresh network trace around the linked credit display's confirmed statement
witnessed exactly these read requests (the menu was initialized first):

| Format | GET path and exact query                                                   | HTTP Content-Type                 |
| ------ | -------------------------------------------------------------------------- | --------------------------------- |
| CSV    | `/iss-pc/member/details_inquiry/detail.html?detailMonth=2&output=csv`      | `text/csv;charset=Windows-31j`    |
| PDF    | `/iss-pc/member/details_inquiry/detailDbPdf.html?detailMonth=2&output=pdf` | `application/pdf`                 |
| OFX    | `/iss-pc/member/details_inquiry/detail.html?detailMonth=2&output=money`    | `application/x-ofx;charset=UTF-8` |

Each returned HTTP 200 and `Content-Disposition: attachment;filename=...`.
The original filenames remain private. The browser's subsequent
`net::ERR_ABORTED` accompanied a completed normal download; it is not a file
failure. The integer selector is an offered position, never a calendar month.
Actual links contained exactly `detailMonth` and `output`. Relative links
without a month remain historical recorded offers and do not authorize the
new file-fetch path.

CSV bytes decode as CP932 without a UTF-8 BOM and use CRLF. A nonempty metadata
preamble precedes the exact ordered twelve-column header: `ご利用者`,
`カテゴリ`, `ご利用日`, `ご利用先など`, `ご利用金額(￥)`, `支払区分`,
`今回回数`, `訂正サイン`, `お支払い金額(￥)`, `国内／海外`, `摘要`, `備考`.
The header has no additional trailing empty column. Preamble fields, row counts,
amount/date lexical forms and reconciliation totals were not classified.
PDF has the `%PDF-1.4` prefix and a trailing `%%EOF` after whitespace trimming;
no text or page layout was inspected. OFX is UTF-8 without BOM, uses LF and
ends with `</OFX>` plus a newline. Its public headers are `OFXHEADER:100`,
`DATA:OFXSGML`, `VERSION:102`, `SECURITY:NONE`, `ENCODING:UTF-8`,
`CHARSET:CSUNICODE`, `COMPRESSION:NONE`. It contains the credit-card statement
containers; SGML leaf tags need not close. No financial values or row semantics
are established by this envelope observation.

The collector now archives validated offered credit exports as original bytes,
with immutable content-addressed objects and stable connection/payment-month/
format provenance. It walks all offered statement positions, including sparse
past positions, on every scheduled run. It neither invents fifteen positions
nor assumes all retained pages offer all formats. Files have separate terminal
units: a malformed/missing file leaves its unit unavailable while healthy files
and financial pages survive. Authentication, redirect or rate-limit denial
still stops subsequent provider reads. A document metadata parser emits only
an evidence claim; CSV/OFX transactions and PDF text are not published again.
File month metadata comes from the validated statement page, not file contents.

A bounded follow-up visited each linked Kyoto/MUFG/Mizuho debit display's
actual latest `seq=0` and one older offered Kyoto period. These pages explicitly
reported no details and offered no file controls. This does not establish
absence across all retained periods. Debit export response bytes remain
unverified; credit envelope contracts are not applied to debit. Durable
root-card switching, scheduled production capture, a complete fifteen-month
archive and live parser validation remain unproved. The document catalogue
therefore stays partial and [issue 1251](https://github.com/risu729/kogane/issues/1251)
remains open.

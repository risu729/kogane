# Rakuten Card / Rakuten Point / Rakuten Cash source research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26 (public information/logged-out public endpoints); live verification not performed.

## 1. Scope and prohibitions

Personal 楽天カード (Rakuten Card), 楽天ポイント (Rakuten Points), 楽天キャッシュ (Rakuten Cash).
Separate authoritative billing in member 楽天 e-NAVI (Rakuten e-NAVI), points/Cash history in 楽天 PointClub
(Rakuten PointClub), current Cash/daily use in 楽天ペイ (Rakuten Pay) app. Exclude 楽天銀行 (Rakuten Bank),
楽天証券 (Rakuten Securities), 楽天 Edy (Rakuten Edy), 楽天市場 (Rakuten Ichiba) order history, merchant Pay,
corporate services.

Allow existing balances/confirmed-pending statements/points-Cash history/expiry/existing PDF-CSV viewing-retrieval
and read-only static/dynamic observation on user-controlled devices/accounts. No payments/top-ups/send-receive/
withdrawals/points use-exchange-investment/revolving-installment changes/campaign entry/card applications/
registration-notification-authentication settings writes.

No account/card/member numbers/names/birthdates/phones/emails/cookies/OTPs/private passkeys/sessions-tokens/
actual balances-bills-merchants in artifacts/HARs/screenshots/logs/commits. Legitimate app/public JS deobfuscation,
static analysis/runtime tracing/traffic metadata in scope, not pinning/device integrity-attestation/WAF-CAPTCHA/
rate-limit bypass.

## 2. Methods and strength of evidence

- Official Card/PointClub/Cash/Pay/楽天 ID (Rakuten ID)/Google Play primary sources; no aggregators even for discovery/evidence.
- Low-frequency logged-out public status/header/redirect observations on 2026-08-26;
  no authentication/challenge triggering/load tests/credentials.
- Read concrete GitHub commits for transport/auth/DOM; no live third-party current-operation verification.
- No Play APK/splits obtained; package/version/provenance only official listings, private APIs next experiments.
- Distinguish **facts**, **hypotheses/design decisions**, **unverified**.

## 3. Authoritative sources and route tradeoffs

| Asset/record       | Candidate authority                     | Main reads            | Strength                                                            | Gaps/risks                                                                    |
| ------------------ | --------------------------------------- | --------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Card billing/usage | e-NAVI                                  | PC Web/Card app       | Confirmed PC CSV/PDF, family/ETC by user                            | Notices pending/incomplete, app payment adjustment writes                     |
| Points             | PointClub                               | Web/app               | Separate ordinary/limited, available/pending, expiry/change history | No public official CSV/PDF; one-year history                                  |
| Cash               | PointClub history + Pay current balance | PointClub Web/Pay app | Point-Cash state histories/Pay current balances                     | Pay tightly coupled to payment/top-up/send/withdraw; official CSV/PDF unknown |

App `総保有ポイント` ("total held points") does not replace PointClub points/Cash ledgers. Nor reconstruct
card statements from points. Card files/PointClub history/Pay balance are separate timestamped source records,
reconciled downstream.

## 4. Rakuten Card / e-NAVI

### 4.1 Cards, primary/family members, ETC identification

Facts:

- [Multiple-card FAQ](https://support.rakuten-card.jp/faq/show/27896?site_domain=guest): switch displayed cards/per-card statements; unregistered may need registration.
- [e-NAVI registration FAQ](https://support.rakuten-card.jp/faq/show/136?site_domain=guest): family members use own Rakuten IDs/passwords, not primary IDs. ETC cannot register alone; usage included in linked parent.
- [Family statement FAQ](https://support.rakuten-card.jp/faq/show/124165?site_domain=guest): primary sees family-inclusive statements/`利用者` ("user"); family only own use.
- [ETC FAQ](https://support.rakuten-card.jp/faq/show/226?site_domain=guest): may take two weeks–one month to reach e-NAVI; use ETC inquiry service before then.
- [WEB statements](https://www.rakuten-card.co.jp/service/bill/): per-family/ETC print/download.

Design:

- Primary already includes family/ETC; naive primary/family CSV union double counts. Primary billing authoritative,
  users/card types attribution only.
- No last-four digits as repository keys. Manually confirm display names/products/primary-family-ETC/inclusion,
  map to local random source keys.
- ETC lag not necessarily missing. Additional ETC source needs separate reconciliation key/deduplication verification.

### 4.2 Confirmed, pending, cancellations/refunds, installments/revolving

| State                          | Official granularity                                                    | Interpretation                                         |
| ------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| Notifications/preliminary      | App amounts/use datetimes etc.                                          | Not formal statements, merchant may be absent          |
| Awaiting sales data            | Notices before merchant data                                            | May take two-plus days from notice to statement        |
| Expected billing/confirmed     | Use dates/merchants/users/payment methods/amounts                       | Merchant delivery dependent, no immediate completeness |
| Cancellation/refund/adjustment | Cancellations/refunds/`金額調整あり` ("amount adjustment present") etc. | Stable original links publicly unknown                 |
| Installment/bonus              | First month original/current bill, subsequent current bill              | Separate principal/monthly bills/fees                  |

[Notice FAQ](https://support.rakuten-card.jp/faq/show/5535?site_domain=guest)/
[notice-statement difference](https://support.rakuten-card.jp/faq/show/179048?site_domain=guest): not confirmed
until Card receives sales data, then formal expected billing including merchants.
[Cancellation/refund FAQ](https://support.rakuten-card.jp/faq/show/15916?site_domain=guest) distinguishes cancellations/
refunds/tax refunds/adjustments, varying arrival. [Installment FAQ](https://support.rakuten-card.jp/faq/show/199797?site_domain=guest)
describes different first/subsequent `利用金額` ("usage amount")/`当月請求額` ("current month bill").

No destructive pending/notice → posted overwrite. Timestamp/source-state each snapshot; reconcile by use dates/
amounts/users/normalized merchant candidates. Disappearance not cancellation; provisional until confirmed/
adjustment rows appear. Public material does not establish authorization IDs/original-refund links/timestamps/
all original foreign amount-rate columns.

### 4.3 Periods, counts, CSV/PDF

- [Past statements FAQ](https://support.rakuten-card.jp/faq/show/4184?site_domain=guest): 15 confirmed months,
  no 16-plus-month view; save CSV/PDF regularly.
- Same FAQ/[WEB statements](https://www.rakuten-card.co.jp/service/bill/) provide PDF/CSV; CSV PC e-NAVI only,
  PDF PC/smartphone.
- [CSV cautions](https://www.rakuten-card.co.jp/e-navi/p/rc/e-navi/statement/popup2.html): per confirmed month,
  one statement may span two rows. Excludes revolving fees/payment counts/current payments/carryover balances;
  merchants may truncate.
- [Download FAQ](https://support.rakuten-card.jp/faq/show/2385?site_domain=guest): current PDF generally from 12th,
  apps also use e-NAVI PDF paths.

Tradeoffs:

- **CSV**: easy machine processing, best initial monthly archives; explicitly parse two-row records/truncated merchants/
  missing revolving-installment breakdowns. Rows ≠ transactions. Official guidance may require UTF-8 conversion.
- **PDF**: faithful invoice, evidence for omitted breakdowns; difficult extraction/table recovery,
  possible names/payment accounts. Isolate originals encrypted.
- **Screens/notices**: early pending detection, no established exports/incomplete fields, not monthly CSV substitute.

Rows/page/month limits/pagination/full CSV headers-encoding/two-row links/exact FX-refund columns unknown publicly; live checks.

## 5. Rakuten Point / PointClub

### 5.1 Ordinary, limited, pending, expiry

[Points rules](https://point.rakuten.co.jp/guidance/rule/): ordinary expiry one year including accrual month,
extended by ordinary accrual within period; limited accrual does not extend. Separates `獲得予定` ("pending accrual")/
`利用可能` ("available"); total displays relate to available points/Cash.

[Terms](https://point.rakuten.co.jp/guidance/terms/)/[definitions](https://point.rakuten.co.jp/guidance/definition/):
limited points individual expiry, earliest used first; cancellation returns may fail if expired by return time.

Retain at least:

- Ordinary available balances/displayed expiry
- Limited expiry buckets by date
- Pending accrual/expected availability/status
- Change ledger: accrual/use/expiry/cancellation/exchange-investment acceptance-processing-cancellation-completion etc.
- Cash separate asset type, not points balances

Refresh expiry per snapshot; ordinary extensions do not mean permanent per-lot expiry. All available expiry
buckets, not just nearest limited date.

### 5.2 History granularity, periods, exports

[History guide](https://point.rakuten.co.jp/guidance/historycheck/?l-id=point_nav_historycheck_sp): PointClub
shows points/Cash, period-target filters/sorting. Fields: reflection dates/services/contents/states-changes/remarks;
contents may expose stores/items/prices/campaign-service descriptions. Points include use/accrual/expiry/
cancellation/exchange acceptance-processing-cancellation-completion/investment states.

Official **past one year**. No public official CSV/PDF/API/maximum-page counts established; do not assert
no official export. For longer retention, first monthly read-only manual capture/audited local exporter.

[Official app](https://point.rakuten.co.jp/guidance/app/) suits current-pending/history/expiry notices, but
lotteries/campaigns/investment writes too. Web history table more observable candidate for full ledger extraction.

## 6. Rakuten Cash / Rakuten Pay

[Cash rules](https://cash.rakuten.co.jp/Guidance/GuidanceCashRule/) direct to PointClub history;
[guide](https://point.rakuten.co.jp/guidance/historycheck/?l-id=point_nav_historycheck_sp) lists top-ups/send
(processing-completed)/receipt decline/send cancellation return/withdrawal application-completion-cancellation.
Store asset=`rakuten_cash`/state, not just signed amounts.

[Pay Cash guide](https://pay.rakuten.co.jp/guide/cash/): current Cash balance in app; writes payment/top-up/
send-receive/withdraw adjacent, no navigation beyond balance. [Terms](https://cash.rakuten.co.jp/Guidance/GuidanceCashAgreement/)
define 基本型 (basic)/プレミアム型 (premium), ten-year expiry from balance change. Verify separate display/
PointClub asset-state live.

Public history one year; Cash-specific CSV/PDF/API unverified. Do not reconstruct correct all-time balances
from current Pay plus historical changes due to out-of-window events/cancellations.

## 7. Authentication, MFA, passkeys, and Bitwarden

### 7.1 Established facts

- [ID/password FAQ](https://support.rakuten-card.jp/faq/show/186?site_domain=guest): Rakuten ID/password;
  `第2パスワード` ("second password") for some procedures, no reset/settings writes.
- [ID FAQ](https://support.rakuten-card.jp/faq/show/41365?site_domain=guest): with multiple IDs, use card-application-linked ID.
- [Email verification FAQ](https://support.rakuten-card.jp/faq/show/192408?site_domain=guest): login may send code to registered email;
  triggers/always-required status unpublished.
- [OTP FAQ](https://support.rakuten-card.jp/faq/show/169605?site_domain=guest): SMS OTP occasions, ordinary-login/sensitive-write
  boundary not established publicly.
- [App biometrics FAQ](https://support.rakuten-card.jp/faq/show/10507?site_domain=guest): Face ID/fingerprints app login-unlock,
  not established WebAuthn passkeys.
- [3D Secure FAQ](https://support.rakuten-card.jp/faq/show/127259?site_domain=guest): online purchase SMS, not ordinary e-NAVI/PointClub MFA.
- [Pay setup](https://pay.rakuten.co.jp/guide/howtouse/): IDs/passwords/outgoing-phone verification;
  [Pay passkeys](https://pay.rakuten.co.jp/topics/fido2/): FIDO2 replaces passwords, creation email code,
  shared across supporting Rakuten ID services.
- Anonymous PointClub history on 2026-08-26 redirected 302 to `login.account.rakuten.com/sso/authorize`,
  `client_id=point_club_web`, `scope=openid profile`, `response_type=code`.
  [OIDC discovery](https://login.account.rakuten.com/.well-known/openid-configuration) lists auth/token/userinfo/JWKS,
  code/refresh/device-code/token-exchange/PKCE S256 etc.

Discovery establishes identity transport, not financial read APIs/scopes, reuse of `point_club_web` credentials/
tokens, or same e-NAVI/Pay sessions.

### 7.2 Passkeys / Bitwarden (facts versus hypotheses)

Pay passkeys officially established; e-NAVI/PointClub acceptance not checked. Shared across supporting services
does not guarantee each relying service. Card app biometrics not passkey evidence.

Bitwarden generally offers [browser autofill](https://bitwarden.com/help/auto-fill-browser/),
[Android autofill](https://bitwarden.com/help/auto-fill-android/), [passkey storage](https://bitwarden.com/help/storing-passkeys/).
Rakuten credentials/provider use plausible, no official specific integration/compatibility. Official cloud-sync
examples Apple/Google/Microsoft, no explicit Bitwarden.

Do not consolidate ID/password/second password/email-SMS OTP/phone into one item/runtime. No private passkeys
in exports/HAR/logs. OTP/manual approval → human handoff, no retries.

Unknown lifetimes/per-client refresh issuance/concurrency/device-IP binding/email-SMS frequency/app keys/
e-NAVI-PointClub passkeys.

## 8. CDN, WAF, anti-bot

Low-frequency logged-out observations on 2026-08-26:

| Public entry                          | Result                                                  | Conclusions/limits                                                   |
| ------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| `www.rakuten-card.co.jp/`             | `403` including browser-like UA; `X-Akamai-Transformed` | Akamai public entry; authenticated decisions/products-scores unknown |
| `support.rakuten-card.jp/`            | `200`, `Server: nginx`                                  | FAQ responses, not necessarily same auth protection                  |
| `point.rakuten.co.jp/`                | `200`, `Server: Apache`, HSTS/CSP                       | Public PointClub; history 302 to OIDC                                |
| `pay.rakuten.co.jp/`                  | `200`, `Server: Apache`, HSTS/CSP                       | Public Pay, app API/WAF unknown                                      |
| `cash.rakuten.co.jp/`                 | `200`, `Server: nginx`, HSTS/CSP                        | Public Cash, balance-history auth unknown                            |
| `login.account.rakuten.com` discovery | `200`, `Server: istio-envoy`                            | Metadata available, auth/login defenses unevaluated                  |

Card-root 403 gives no basis for bare Worker `fetch()`/curl e-NAVI collectors, but not proof browser denial,
all-surface Akamai, or specific cookie/header success. No Cloudflare headers, not proof of absent Cloudflare/WAF.

No intentional challenge/CAPTCHA; stop 401/403/429/challenge-interstitial/auth loops. No cookie synthesis/
fingerprints/CAPTCHA solving/rate probing/pinning-attestation bypass.

## 9. Official Web/app/APK and public implementations

### 9.1 Official app/Web roles

| App                                                                                                   | Google Play package                       | Version from Play on 2026-08-26 | Main reads                                                                        |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| [Rakuten Card](https://play.google.com/store/apps/details?id=jp.co.rakuten.kc.rakutencardapp.android) | `jp.co.rakuten.kc.rakutencardapp.android` | `7.76.0`                        | Billing/statements/notices/available credit/total points, adjacent payment writes |
| [Rakuten PointClub](https://play.google.com/store/apps/details?id=jp.co.rakuten.pointclub.android)    | `jp.co.rakuten.pointclub.android`         | `6.6.0`                         | Balances/history/pending/expiry, adjacent accrual-investment-campaign             |
| [Rakuten Pay](https://play.google.com/store/apps/details?id=jp.co.rakuten.pay)                        | `jp.co.rakuten.pay`                       | `9.17.0`                        | Current Point/Cash, central payment-top-up-send-withdraw writes                   |

Versions change; record package/versionCode-versionName/time/SHA-256/signer per artifact. No standalone APK
found; environment lacked legitimate Play Android/`adb`/`apksigner`/`jadx`/`apktool`/MobSF/authenticated binary
retrieval. No redistributed sites that weaken provenance.

Web suits Card CSV/PDF/PointClub table extraction. App suits notifications/device-bound auth/current balances/
app-only transport checks, but close writes/device-binary dependence. Official exports/Web before UI automation.

### 9.2 Next legitimate split APK experiment

After legitimate Play installation on user Android, do per package. Keep binaries/analysis outside repository
in encrypted temporary storage, not shared.

```bash
PKG=jp.co.rakuten.kc.rakutencardapp.android  # For PointClub/Pay, use the package from the table above
adb shell dumpsys package "$PKG" | grep -E 'version(Name|Code)|firstInstallTime|lastUpdateTime'
adb shell pm path "$PKG"
# adb pull the base.apk and all split_config*.apk found above, one at a time
sha256sum artifact/*.apk
apksigner verify --verbose --print-certs artifact/base.apk
jadx -d jadx-out artifact/*.apk
apktool d -f artifact/base.apk -o apktool-out
rg -a -n 'https?://|wss://|retrofit|okhttp|graphql|grpc|protobuf|oauth|dpop|bearer|cookie|pin|certificate|integrity|attestation|safetynet' jadx-out apktool-out
```

- Check matching signer digests across splits; provenance only package/version/signer/hashes.
  Commit no APK/decompiled code.
- Enumerate manifest/network config/host-path constants/Retrofit-OkHttp-gRPC-GraphQL-protobuf/
  session-token types/renewal calls/Integrity-attestation-pinning candidates.
- R8/ProGuard deobfuscation/string decryption/runtime tracing allowed for read host/schema discovery,
  no secret output/integrity-pinning bypass hooks.
- MobSF local static only, no automated dynamics/third-party cloud uploads/redistribution.

### 9.3 Concrete public third-party transport/auth

1. [mrkn/rakuten_card `fetch_latest.rb`](https://github.com/mrkn/rakuten_card/blob/91083b4943db9bb24f9b82afd906a2b206bbecf8/bin/fetch_latest.rb)
   (2016, no license shown): Ruby Capybara/PhantomJS-Poltergeist follows e-NAVI from `http://rakuten-card.co.jp`,
   fills `u`/`p` from env/interactive password, extracts first five cells in `#latestSortForm`/`#nextLatestSortForm`.
   No JSON/MFA/multi-card/CSV-PDF; HTTP/old DOM not current transport reuse evidence.
2. [woinary/scraping_rakuten_point_py](https://github.com/woinary/scraping_rakuten_point_py/blob/97e43c267d13a82b2419deb803229aad20a0012a/scraping_rakuten_point.py)
   (2022): Selenium/Chrome history login from local `.config`, `tr.get`/`tr.use`/`NEXT` DOM,
   dates/services/contents/ordinary-limited/changes/remarks → UTF-8 BOM CSV. Plaintext credentials/fixed selectors/
   no MFA-passkeys, not production.
3. [yuki-gu/ExportRakutenPointHistory](https://github.com/yuki-gu/ExportRakutenPointHistory/blob/ee5f61fc235ee9fb12ed0839cc6db4ea1ac6fb6d/main.js)
   (2026, MIT): logged-in bookmarklet, same-origin `fetch(next href)` all `NEXT` pages/DOMParser `tr.get`-`tr.use`,
   local UTF-8 BOM CSV, no credentials/tokens. README injection of mutable GitHub Pages scripts into authenticated
   origin is supply-chain risk; adoption needs audited commit-pinned local bundle/PointClub-only egress.
   Live-check Cash states beyond `get/use`.

HTML/session-cookie examples, not official APIs/app transport/current e-NAVI/financial identity scopes.
Concrete C evidence for possible current PointClub same-origin GET/HTML pagination.

### 9.4 Read-only dynamic observation

1. **Web**: ordinary user-browser login; only card switch/one confirmed month/pending list/one PointClub page/
   Pay-Cash balances. Allowlist origins/methods/path templates/status-content-types/field names.
2. **Sanitization**: remove cookies/Authorization-CSRF-OTP/query-body values/card-member IDs/amounts-merchants-PII
   before/immediately after capture. No default HAR; synthetic field-name schemas if needed. No sharing before scanning/manual review.
3. **App metadata**: proxy without body-secrets only if ordinary app trusts user CAs. Stop at rejection/pinning/
   integrity-attestation, no patches-hooks. Encrypted DNS/SNI/IP/timing-only observations also valid.
4. **Runtime tracing**: legitimate app URL builders/serializer types/read calls allowed, no tokens/cookies/keys/
   OTPs/PII-values; no integrity-pinning modification or write triggering.
5. **Replay gate**: one isolated idempotent read only after method/path/schema/session reproducibility established.
   Inseparable login-refresh/read-write scopes → not B, return browser/device/manual.

## 10. Read/write isolation

Minimal allowlist:

- Existing sessions/ordinary login excluding reset-registration-settings
- e-NAVI card display switches/confirmed-pending lists-details/existing downloads
- PointClub ordinary-limited-pending points/expiry buckets/history
- Pay existing Point/Cash balances/PointClub Cash history

Denylist:

- Card payments/later revolving-installments/payment amount-account-limit changes/cash advances
- Pay codes/payments/Cash top-ups/send-receive/withdraw/Suica-Edy
- Points use-exchange-investment/interest-increase modes/campaign-lottery-mission entry
- Card-family-ETC applications/loss suspension/reissuance/3D Secure-WEB statements-notifications-authentication settings
- ID/password/passkey/second-password/contact registration-resets-changes

Assume same credentials can read/write; not HTTP method alone. Combine origin+method+path+request-schema,
egress proxies/read-only selectors/download content-type-size limits. Even read/query `POST` disallowed until
static/dynamic verification. Stop without actions at `支払う` ("pay"), `変更` ("change"), `申込` ("apply"),
`チャージ` ("top up"), `送る` ("send"), `受け取る` ("receive"), `出金` ("withdraw"), `交換` ("exchange"),
`運用` ("invest"), `エントリー` ("enter") on destinations/buttons.

## 11. Workers / Browser Run / Containers / OCI / Kubernetes suitability

| Runtime                | Suitability                               | Reason                                                                                                                                                               |
| ---------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers     | High export receipt/parsing, low login    | [Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) downloads/parser orchestration; unsuitable Akamai/interactive MFA/profiles/APK-toolchains |
| Cloudflare Browser Run | e-NAVI/PointClub C-D experiment candidate | [Browser Run](https://developers.cloudflare.com/browser-run/) sessions/CDP; financial cloud sessions-PII/Akamai/human OTP/writes require separate solutions          |
| Cloudflare Containers  | Browser/analysis candidate                | [Containers](https://developers.cloudflare.com/containers/) full FS/runtimes/OCI; paid/secrets/profiles/egress-reputation/audits                                     |
| General OCI            | Good CSV-PDF-HTML/replay                  | Pin Playwright/sanitizers/parsers/scanners; ordinary containers cannot reproduce legitimate Android identity                                                         |
| Kubernetes             | Many sources, excessive initial Rakuten   | CronJob/NetworkPolicy/read-only FS/Secret CSI/audits/source jobs, no MFA-Akamai-binding solution                                                                     |
| User PC/Android        | Best initial live/static-dynamic          | Legitimate apps/browser/human MFA/Play provenance, easier no secret export; not fully unattended                                                                     |

Initially manually export PC card CSV/PDF, audited owner-local PointClub one-year capture; only parsers/
sanitizers on Workers/OCI. Add Browser Run/Containers after proven transport/reuse/isolation. Pay's high
write proximity makes beyond-balance spot-check automation last.

## 12. Automation levels A-E and implementation cost

Use only common PR #5 definitions.

- **A**: documented/export APIs for scheduled headless use
- **B**: stable read-only internal APIs/renewable-reusable sessions
- **C**: promising browser/app bootstrap then headless replay
- **D**: full browser/device automation required
- **E**: manual capture safe default

| Route                                      | Level       | Cost (1-5) | Assessment                                                                |
| ------------------------------------------ | ----------- | ---------: | ------------------------------------------------------------------------- |
| Manual monthly e-NAVI PC CSV/PDF           | E           |          1 | Official/safest/15-month rolling archive, PDF fills CSV gaps              |
| Manual/audited local PointClub bookmarklet | E           |        1-2 | Official export unknown, one-year/pagination/Cash states need live checks |
| Full e-NAVI/PointClub browser automation   | D           |          4 | Shared IDs/MFA/Akamai/multi-card/writes/sessions unknown                  |
| Observed Web reads bootstrap + replay      | C candidate |          4 | PointClub OIDC/HTML examples, renewal/scopes/e-NAVI unproven              |
| App replay/UI automation                   | D           |          5 | Play artifacts/binding/integrity-pinning/proximity/scopes unknown         |
| Manual current Cash spot checks            | E           |          1 | Pay read screens only, history in PointClub                               |

**Overall E (C candidate), cost 1-2 (replay research 4, app/device 5).** Official monthly card export not scheduled
API, so not A. Point/Cash no established official exports/APIs; whole-family safe default manual. Same-origin
HTML/OIDC support C candidates, not B without stable renewable read-only sessions.

## 13. Read-only live verification plan

### Phase 0: inventory (no numbers/values)

1. Record only e-NAVI card counts/types/primary-family/ETC inclusion.
2. Count family accounts, no IDs/names/suffixes.
3. Check PointClub ordinary-limited-pending-Cash display presence, Pay basic-premium only.

### Phase 1: one official export/UI check

1. Ordinary owner-PC login/human challenges; no secrets/OTP to automation.
2. e-NAVI months/rows-pagination/users-ETC/notices-pending-posted/cancellations-refunds/installments-revolving/FX
   **field names/states** only, no values.
3. Separate synthetic rows; record only headers/encoding/two-row structure/PDF text/monthly units/filenames.
   Isolate actual files encrypted, no commits.
4. PointClub one-year filters/pagination/page counts/ordinary-limited/expiry/pending/all Cash states;
   check official download buttons too.
5. Pay Point/Cash/basic-premium only, no payments/top-ups/send/withdraw.

### Phase 2: transport/RE (if Phase 1 insufficient)

1. Public HTML-JS/manifests-maps/forms/CSP/OIDC hosts-paths-schema names, no private resource/map bypass.
2. Authenticated card lists/month-list-detail-download/PointClub histories-balances-expiry/Cash reads
   → redacted method/path/field-name maps.
3. Legitimate splits/signatures as above; analyze three packages independently, separate shared identity/card-point-cash hosts.
4. Existing read session replay once; stop 401/403/429/login redirects/OTP/device-integrity/unexpected write method-path,
   no automated login retries.
5. Reassess C/B only after two independent stable schemas/pagination/deduplication/renewals with egress write denial.

## 14. Stop conditions

Immediately stop run/discard or encrypt-isolate cookies/sessions/artifacts on:

- CAPTCHA/Akamai-denial/401-403-429/loops/locks
- Password-passkey-OTP resets-registration-changes/phone re-registration/additional identity checks
- Payment/revolving-installment/top-up/send-receive/withdraw/exchange-investment/application-entry-settings confirmations
- Potential unknown `POST/PUT/PATCH/DELETE` or paths/schemas without read-only verification
- Secrets/PII/values retained in logs/HAR/screenshots/traces, or unverified redaction
- User CA/debugger rejection requiring pinning-integrity-attestation bypass
- APK signer/package/version/provenance mismatch or only third-party APK availability
- Cycling pagination/unresolved month-user duplication/official count mismatch
- Terms/robots/guidance changes or source owner instructions to stop automation

No credential retries/fingerprint-cookie synthesis/bypass afterwards; manual exports/spot checks.

## 15. Established conclusions, hypotheses, unverified items

### Established

- Confirmed 15 months e-NAVI PC CSV/PDF; monthly confirmed CSV with two-row records/truncated merchants/
  missing revolving breakdowns.
- Primary includes family/ETC, family own-only; naive union doubles.
- PointClub ordinary-limited-pending-expiry/Point-Cash history, publicly one year.
- Pay current Cash and payment-top-up-send-withdraw writes coexist.
- History redirects identity OIDC code; public identity scopes, no financial APIs/scopes.
- Public Card Akamai/403; three official package/versions in Play, no APK/signature/transport artifacts.
- Public bookmarklet same-origin HTML `fetch` pagination, not official API.

### Hypotheses/design

- Safest initial monthly card files/local PointClub/Pay spot checks.
- PointClub browser-bootstrapped HTML C candidate; renewal/Cash coverage need live proof.
- Internal e-NAVI/app JSON possible, not established in this material/artifacts.

### Unverified

- e-NAVI/PointClub passkeys/Bitwarden/MFA/renewal/device binding
- e-NAVI pagination/limits/full CSV/encoding/original-refund links/FX/pending exports
- PointClub-Cash buttons/limits/page sizes/all states/expiry schemas
- Three app signers/splits/hosts-paths-schemas/tokens-renewal/integrity-pinning/Web differences
- Authenticated e-NAVI Akamai decisions/Worker-Browser Run-Container acceptance

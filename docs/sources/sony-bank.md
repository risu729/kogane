# ソニー銀行 (Sony Bank): initial official Web/app assessment

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

- Research date: 2026-08-26 (Australia/Sydney)
- Scope: personal Sony Bank accounts only
- Excluded: other banks, securities firms, household-finance/asset-management aggregators, transfers/account transfers/trades/deposits/cancellations/settings changes

## Conclusion

- **Use official Web and CSV as authoritative records**. Official yen ordinary deposits provide `過去すべて` (all past) transactions and ordinary-deposit CSV downloads. Foreign-currency CSVs span all currencies across ordinary/time deposits and 為替リンク預金（外貨スタート型） (FX-linked deposits, foreign-currency start), with contract numbers, descriptions, inflows/outflows, post-transaction balances, applied rates, yen equivalents, and special-agreement rates. These are first candidates for initial backfill/incremental collection.
- Official balance coverage is broad: yen ordinary/time/installment-time, foreign ordinary/time, 円定期 plus+ (Yen Time Deposit plus+), FX-linked deposits, investment trusts, FX, Sony Bank GATE, home/card loans through Web/apps or contracted read APIs. Ledgers mainly cover yen/foreign ordinary deposits; model time/structured products by contract/deposit lot as well as totals.
- Normal Web login uses three-digit branch number, seven-digit account number, and password. Smartphone authentication, physical-token OTP, and `合い言葉` (security phrase) authenticate important transactions, not passkeys/WebAuthn. No official material, current UI, or public bundle confirmed passkeys. Bitwarden may fill ordinary branch/account/password credentials; storage in Bitwarden alone does not establish passkeys.
- Current Web is a Next.js SPA after the 2025-05-06 update, sending JSON to same-origin `/custom-web00` BFF. Public assets reveal headers, payload structure, CSRF/revision/event-hash interceptors. The initial build's login-path literal was not reconfirmed after a same-day rebuild; establish current transport at runtime. Old `o2o.moneykit.net` HTML scrapers no longer resolve in DNS and cannot run unchanged.
- Public observations on 2026-08-26 showed Amazon CloudFront for `sonybank.jp`, S3 static screens, AWS BFF trace headers, and no Akamai. Login explicitly loads PhishWall/Caulis device-information scripts; bank guidance describes firewalls, continuous monitoring, automatic logout. AWS WAF association, bot scores, and headless/datacenter decisions are not established publicly.
- Two official apps exist. `ソニー銀行 アプリ` (Sony Bank App) covers all-product balances/authentication/transactions; `Sony Bank WALLET アプリ` (Sony Bank WALLET App) focuses on yen/foreign ordinary balances, Visa debit history, card settings. Play package/version pairs were `net.moneykit.SonyBankApp`/`8.02.00`, `net.moneykit.sbw`/`12.04.00`. The main app's renewal announcement starting that day conflicts with listing dates, leaving staged-rollout/metadata-delay version gaps unresolved. Analyze Web bundles/legitimate split APKs in parallel, without requiring Web gaps first.
- Current overall rating is **implementation cost 4/5, automation level C**. Start low-frequency normal-Chrome login/official CSV downloads, considering JSON replay only after captured current BFF read endpoints. Persistent-profile local/OCI/Cloudflare Containers suit this better than Workers alone.

## Scope, safety boundaries, and method

Only direct read-only retrieval of the user's own accounts through bank Web/apps is covered, with these absolute conditions.

- Do not retrieve/record/commit account IDs, branch/account numbers, names, addresses, emails, phones, actual balances/transactions, passwords, OTPs, security phrases, cookies, tokens, or device keys.
- No transfers/account transfers, FX trades, time deposits/cancellations, fund/FX orders, loan operations, certificate applications, information-sharing consent, auth-method changes, app re-registration, notification/card settings.
- Do not touch `メモを編集` (edit memo) on read screens; memo registration is a write.
- Stop on login failure, 401/403/429, challenges, additional authentication, terms consent, registration checks, app approval, CAPTCHA, or lock signs, without automatic retries.

This research made no fresh authenticated-account login, checking public official pages/login entrypoints, official JavaScript/configs, Google Play, and public GitHub code. Follow-up rechecked the 2026-08-26 current Next.js build, Play package/version/update metadata, and workspace APK/tool availability. No values, including invented ones, were entered. Public headers were checked with HEAD/GET only; no account data/auth cookies acquired.

Source priority:

1. Official Sony Bank Web/help/terms/served assets
2. Official Google Play listings linked by the bank
3. Commit-pinned public third-party code only as implementation references
4. No aggregator initial routes; use only comparison material for official API coverage

## Official routes and retrieval targets

| Route                                                                                                 | Read targets                                                                                                        | Role                                                         |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [Sony Bank Web](https://sonybank.jp/) / [current login](https://sonybank.jp/pages/db/dbca0100/input/) | All-product balances, yen passbook, foreign/time/structured balances/history, funds, FX, loans, electronic delivery | Primary; save official CSV/screens                           |
| [Yen deposits/passbook](https://sonybank.jp/products/yen/)                                            | All past yen ordinary transactions, ordinary-deposit CSV                                                            | First MVP/backfill candidate                                 |
| [Foreign transaction CSV](https://sonybank.jp/products/fc/39.html)                                    | All-currency ordinary/time/FX-linked foreign-start flows                                                            | Primary foreign artifact                                     |
| [Foreign gains/losses](https://sonybank.jp/tool/fc/40.html)                                           | Product/currency valuations, past 2-year realized gains/losses, inception-to-current aggregates                     | Separate official calculations; phase 2 if needed            |
| [ソニー銀行 アプリ](https://sonybank.jp/tool/app/sb/)                                                 | All-product balances, foreign ordinary transactions, transfers, OTP, inquiries                                      | Auth assistance/manual checking; no transactions             |
| [Sony Bank WALLET アプリ](https://sonybank.jp/tool/app/sbw/)                                          | Yen/foreign ordinary balances, currency history, Visa debit usage                                                   | Debit/ordinary manual fallback                               |
| [Information-linking service](https://sonybank.jp/services/api/)                                      | Balances/statements/rates to contracted outside providers                                                           | Stable official API, but aggregator route excluded initially |
| [Read-API policy](https://sonybank.jp/stpl/161.html)                                                  | Deposit/fund/FX/GATE/loan balances/passbooks                                                                        | Eligible-company contract, not personal self-service token   |

### Balance/account coverage

Combining [official app displays](https://sonybank.jp/tool/app/banking/01.html) and [official read-API list](https://sonybank.jp/stpl/161.html) establishes at least the following.

| Product                                      | Balance granularity                                                                  | History/details                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 円普通預金 (yen ordinary deposits)           | Current account balance, sometimes including unsettled yen for foreign remittances   | Passbook/CSV, all past transactions                                            |
| 円定期預金 (yen time deposits)               | Yen totals and contract/deposit details                                              | Principal, term, maturity, rate lots, not transaction ledgers                  |
| 積み立て定期預金 (installment time deposits) | Plans/contracts/balances; app rates are weighted deposit averages                    | Validate plan/deposit relationships live                                       |
| 外貨普通預金 (foreign ordinary deposits)     | Native balance per currency, sometimes including unsettled amounts                   | Per-currency history/cross-currency CSV                                        |
| 外貨定期預金 (foreign time deposits)         | Currency/contract; yen conversions at current/reserved rates are reference values    | Cross-product CSV separates principal/interest for maturity/early cancellation |
| 円定期 plus+                                 | Contracts including unsettled amounts                                                | Separate from ordinary ledger; appears from 0:00 on deposit date               |
| 為替リンク預金 (FX-linked deposits)          | Yen/foreign start, currency/contract; conditional reference yen conversions          | Foreign-start covered in cross-product CSV; separate special rate              |
| 投資信託 (investment trusts)                 | Yen/foreign denomination, account category, fund, units, base price, valuation/gains | Transaction CSV/electronic documents; separate post-deposit-MVP collector      |
| FX                                           | Effective margin, unrealized gains/losses, positions/deposits/transactions           | Separate trading system, outside deposit collector                             |
| Sony Bank GATE                               | Application funds for open offerings, invested balance                               | Separate product/offer-redemption lifecycle                                    |
| Home/purpose/card loans                      | Contract balances/repayment schedules                                                | Liabilities without netting assets; product-specific PDFs                      |

App totals include unsettled yen/foreign/structured-deposit/fund amounts but exclude effective FX margin. Separate native amount/currency, official reference yen conversions, unsettled amounts, valuation time. Yen equivalents are not book costs/execution rates.

Contracted read APIs officially enumerate yen ordinary balances/passbooks, yen time/installment time, foreign ordinary balances/passbooks, foreign time, FX/interest rates, plus+, FX-linked deposits, FX, funds, GATE, home/card loan balances. Strong coverage evidence, but bank-approved eligible-company contracts are required, not immediate public Kogane API access.

## Statement granularity, periods, counts, and export

### Yen ordinary deposits

[Official yen-deposit guidance](https://sonybank.jp/products/yen/) explicitly states:

- Web `通帳` (passbook), rather than paper, provides **all past** transactions.
- `普通預金取引履歴` (ordinary-deposit transaction history) downloads as CSV.
- [Passbook help](https://sonybank.jp/guide/bankbook/01.html) supports either/both start/end dates, inflow/outflow, ascending/descending order, keywords.
- Keywords search descriptions, user-entered transaction memos, and transfer EDI information.

Public material does not specify per-screen/download maxima, page size, same-day ordering, encoding, or full CSV columns. A third-party parser as of 2025-05-18 reads `取引日` (transaction date), `摘要` (description), `引出額` (withdrawal), `預入額` (deposit), `差引残高` (resulting balance) as Shift_JIS. This does not guarantee 2026 schemas; reconfirm with live fixtures.

Passbook memos allow 40 characters but are writes, never edited by collectors. Whether memos/EDI appear in CSV or only HTML remains for live validation.

### Foreign ordinary/time/FX-linked deposits

[Official foreign transaction CSV specifications](https://sonybank.jp/products/fc/39.html) provide oldest-first combined downloads across currencies/products, including internal transfers, with nine fields.

1. `お取引日` (transaction date)
2. `契約番号` (contract number)
3. `摘要`
4. `入金額（外貨）` (foreign-currency inflow)
5. `出金額（外貨）` (foreign-currency outflow)
6. `取引後残高（外貨）` (post-transaction foreign balance)
7. `適用 rate` (applied rate, TTS/TTB/TTM)
8. `取引円換算額` (transaction yen equivalent)
9. `特約 rate` (special-agreement rate)

Maturity/early cancellations separate principal/interest. Internal movements such as foreign ordinary→time deposits are recorded; do not mistake them for external income/expense.

Foreign-product `取引履歴` (transaction history) is created on completion, while cross-product CSV details arise when transfers to other products complete. Unsettled foreign funds/MMFs/offering-type foreign time/FX-linked deposits may cause balance differences. Preserve artifact types/times; temporary mismatch does not establish missing data.

[Foreign gains/losses](https://sonybank.jp/tool/fc/40.html) displays past 2-year realized gains/losses and inception-to-latest FX/interest aggregates. These are separate official tax/valuation calculation artifacts, not cash ledgers.

### CSV, PDF, and statements

| Artifact                               | Period/scope                                                  | Machine readability                                  | Use                              |
| -------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------- |
| Yen passbook HTML                      | All since account opening                                     | DOM/BFF; count/pages unconfirmed                     | Current checks, memos/EDI        |
| Yen ordinary CSV                       | Official download; all-history single export needs live check | High; 2025 example Shift_JIS/5 main columns          | Primary ledger                   |
| Cross-product foreign CSV              | All-currency ordinary/time/FX-linked foreign-start flows      | High; official 9 fields                              | Primary FX/deposit ledger        |
| Foreign gains/losses totals            | 2-year realized, inception-to-current aggregate details       | HTML/CSV availability needs live check               | Official gains/losses comparison |
| Fund transaction CSV                   | Officially exists                                             | High; account category/acquisition unit prices, etc. | Dedicated fund collector         |
| Electronic documents                   | Foreign deposits/funds/GATE/FX, etc.                          | PDF                                                  | Audit/reference                  |
| Ordinary balance certificate/statement | Specified dates/periods; application/fees/mail                | Paper/procedure artifact                             | Excluded from automation         |

Ordinary-passbook PDF downloads were not confirmed publicly. Certificate/statement applications involve external writes, fee debits, and mail; read-only collectors must never apply. Product-specific PDFs are allowed only when clearly viewing/downloading.

## Authentication, passkeys, and Bitwarden

### Confirmed facts

- The [official login guide](https://sonybank.jp/guide/support/howtologin/) specifies branch/account numbers and passwords up to 32 characters. Current UI on 2026-08-26 also has three fields; public bundles zero-pad numbers to three/seven digits and JSON POST them.
- [Official authentication guidance](https://sonybank.jp/guide/auth/) lists smartphone auth, physical-token OTP, security phrases for important transactions. All still require separate Web login passwords, etc.
- [Smartphone authentication](https://sonybank.jp/guide/auth/01.html) uses six-digit app OTP and transaction signatures with app-specific keys for transfer contents. One device per account; initial registration uses initial Web login, cash card, and sometimes registered-phone SMS.
- Web transfers notify the app; users verify recipient/account/amount and execute. This is a write boundary; Kogane requests no notification and performs no app execution.
- The 2026-08-26 renewal requires re-registration/SMS, removing pattern auth, balance trends, some filtering, and notification history. Older versions remain briefly usable but notifications stop.
- Official pages/current assets did not reveal WebAuthn, FIDO2, passkeys, or `PublicKeyCredential`.

### Distinguish Bitwarden from passkeys

| Situation                                                  | Assessment                              |
| ---------------------------------------------------------- | --------------------------------------- |
| Bitwarden fills branch/account/password                    | Password manager, not passkey           |
| Browser WebAuthn prompt/assertion with RP-bound credential | Passkey, unconfirmed at Sony Bank       |
| Biometrics/PIN opens app displaying six-digit OTP          | Local unlock + OTP, not passkey         |
| App verifies/signs transfer contents                       | Transaction auth, not Web-login passkey |

Do not open Bitwarden vault contents. In live validation, visually check only extension credential types/WebAuthn-dialog presence with the user. Never capture/log/pass values through environment variables, session envelopes, or Git. Do not infer passkeys merely from Bitwarden storage against public facts.

### Login versus additional authentication

Ordinary balance/statement login likely needs only passwords, but risk-based step-up conditions are unpublished. Stop automation for:

- OTP, security phrases, cash-card manufacturing numbers, SMS, voice codes, app registration/re-registration
- `お客さま情報の確認/変更` (customer-information confirmation/change), terms/electronic-delivery consent, auth-method changes
- Navigation to transfers/account transfers/trades/deposits/cancellations/limits/card-notification settings

Do not store unnecessary OTPs/security phrases as collector secrets.

## Current Web transport and sessions

Unauthenticated public assets on 2026-08-26 establish this login composition.

- `sonybank.jp/pages/db/...` is a Next.js SPA; S3-origin HTML/JS through CloudFront.
- [`core.js`](https://sonybank.jp/pages/config/core.js) sets BFF base `/custom-web00` and auth-provider header `FBaaS-Provider-Key: CustomAuth`.
- Initial login bundles showed `POST /custom-web00/dbca/cust-web/to-customers/login`; same-day follow-up rebuild did not expose the literal in shared chunks, leaving current runtime transport unconfirmed.
- JSON payload has `requestBizHdCommon.screenId = DBCA0100I1f`, `eventId = DBCA0100I1fE15`, and data `branchNum`, `accountNum`, `loginPwd`.
- Axios interceptors add CSRF, locale, `FBaaS-SS: db`, `FBaaS-Revision: revision-<current>`, and event hashes. Check revision through public JSON; screen transitions/timeouts/errors depend on BFF responses.
- Initial public revision on 2026-08-26 was 691, changing with deployment. Use served values, never hardcode.
- Credential-free BFF HEAD returned 401, CloudFront `Error from cloudfront`, and `x-amzn-trace-id`: normal unauthenticated behavior establishing endpoint availability only.

Because passwords are in JSON bodies, BFF replay must not retain auth bodies/headers/Caulis telemetry as raw evidence. Allowlist only authenticated-response read endpoints; exclude writes from source and runtime egress allowlists.

Cookie names, idle/absolute lifetime, concurrency, IP/UA binding, logout invalidation, export/import are unconfirmed. Local/session storage and cookies alone may omit required Caulis/PhishWall state.

### 2026-08-26 public Web/BFF follow-up

Around 11:03 AEST that day, login HTML referenced Next build `swtv76wAOANOG8i6C3jrC`. The 423-byte route chunk loaded module `00Lr` from shared chunks. Shared `5c38...c01c91f...js` SHA-256 was `5c0170415f29dd83649446e0f4e0bd1eabb1bbef34a645f74fc159378667f950`, public-asset provenance, not APK/auth-session hashes. Source maps returned HTTP 403; no bypass.

Current public-bundle session bootstrap:

1. Unauthenticated event `DBCA5700C1fE99` initializes CSRF; response `bff-csrf` becomes later `BFF-CSRF` headers.
2. Login passes `DBCA0100I1fE15`/branch/account/password to action `DBCA185AF`; Caulis loads with submit state.
3. Public models include `accountInfo[]`, `customerLoginResFlg`, name fields, `integratedId`, `maUniqueId`, etc.; PII/identifiers excluded from capture.
4. Authenticated current-user action `DBBA505AF` reads wrapper header `fbaas-login-info` as `loginId`. LocalStorage `loginStat=1` is cross-screen display state, not credentials/reusable tokens.
5. Actual session cookies/headers, `Secure`/`HttpOnly`/`SameSite`, rotation, logout invalidation are not exposed and remain unconfirmed.

The earlier `/custom-web00/dbca/cust-web/to-customers/login` is a strong transport candidate, but same-day rebuilt chunks did not reconfirm its literal; do not infer/probe API IDs. Establish current transport from user-operated runtime host/path/method/status and header **names only**. Public bundles contain yen/foreign/card-home-loan transaction-group IDs/broad models, not proof of read URLs/pagination/session scope.

## CDN, WAF, anti-bot / anti-fraud

### Confirmed facts

- On 2026-08-26, `sonybank.jp` returned CloudFront IPs; public HTML had `Server: AmazonS3`, `Via: ...cloudfront.net`, `x-amz-cf-*`.
- Unauthenticated BFF responses also passed CloudFront with AWS `x-amzn-trace-id`.
- [Official security guidance](https://sonybank.jp/guide/securityinfo/07.html) specifies firewalls, 24/365 monitoring, TLS, timed automatic logout, phishing detection.
- [`env.js`](https://sonybank.jp/pages/config/env.js) publicly configures seven PhishWall scripts, Caulis `static.fraud-alert.net`/`p.fraud-alert.net`, site ID, `sonybank.jp` cookie domain, login-specific `Caulis.snbk_v3.min.js`.
- Login invokes Caulis hooks on submit; this is SPA JavaScript/BFF headers/fraud telemetry, not simple HTML forms.

### Unconfirmed/inferred

- No current Akamai DNS/headers/scripts/cookies observed. This does not exclude historical/other-product hosts, but there is no basis to label current Sony Web login Akamai.
- Headers cannot establish AWS WAF/Bot Control associations. Observing CloudFront is separate from WAF adoption.
- Caulis device data, risk scores, cookies, bank rules, headless/datacenter/cloud-IP decisions remain unconfirmed. Config strongly suggests anti-fraud use, not specific bot behavior.
- PhishWall establishes user protection/fraud measures, not proof of automation blocking.

Use official supported browsers/normal profiles initially. Do not assume bare Worker `fetch()` reproduces login; measure low-frequency success/failure with the same profile/UA/egress. Never bypass 401/403/429/challenges.

### 2026-08-30 user-authorized live replay and Workers execution

Following that staged policy on the user's real account established browserless current read-only login. After observing one successful Kuebiko Chrome flow, a fresh `.NET HttpClient` without Chrome cookies completed all these with 200.

1. `GET /pages/db/dbca0100/input/`
2. `POST /custom-web00/dbca/csrf-token/get` retrieves `BFF-CSRF`/`FSID`
3. Send `FBaaS-Provider-Key: CustomAuth`, screen/event headers, branch/account/password to `POST /custom-web00/dbca/cust-web/to-customers/login`
4. `POST /custom-web00/dcba/cust-web/gross-balance/acq`
5. `POST /custom-web00/eaba/cust-web/ordinary-deposit-transaction-histories`
6. Pager and `POST /custom-web00/eaba/ordinary-deposit-transaction-histories/csv/load`

No UA, `sec-*`, Origin, Referer, TLS impersonation, Caulis/PhishWall telemetry was added. Reads replayed using only Cookies, `BFF-CSRF`, `FBaaS-Message-Locale`, `FBaaS-Request-Biz-Hd-Common`, `FBaaS-Revision`, `FBaaS-SS`, `FBaaS-URI`. `FBaaS-Provider-Key` is static public `core.js` configuration, not device-assessment tokens. Fetch `/pages/config/revisions/<area>/revision.json` each time, without pinning revisions.

Porting to standard Cloudflare Worker `fetch()` also succeeded through Cloudflare egress for fresh login, total balances, nonempty yen history, and official CSV. Raw responses went to private R2 `kogane-sony-bank-collector-poc` by date/run; no login responses/Cookie values/CSRF/passwords saved. Thus current Sony Web collection needs no Container, Browser Rendering, Chrome profile, or Akamai workaround.

Sending optional `depositAndWithdrawalSg` as empty string caused 422 `FCB00010`. Omitting undefined fields as UI does returned 200. Do not fill optional fields with empty strings.

## Sony Bank WALLET usage history

Visa debit details are a separate external-card-system SSO route from bank BFF, not another ordinary-deposit dataset.

- [Product specifications](https://sonybank.jp/products/sbw/03.html) give Web retention of 15 months.
- Dated `確定日` (finalization date) means finalized; `未確定` (unfinalized) means merchant sales data not received.
- Use/cancellation/finalization/finalization-cancellation may be separate rows or original rows replaced by finalized ones. Merchant names may change; not an append-only ledger.
- [WALLET app](https://sonybank.jp/tool/app/sbw/) describes current-month use, past-year monthly trends, one-off/recurring breakdowns, recurring details, per-card family debit use.
- Dedicated Visa debit CSV/PDF unconfirmed in public official material. Ordinary yen/foreign CSV aids reconciliation but does not fully replace finalization dates/statuses/remarks/card IDs/replacement relationships.

Current public-bundle direct usage-details flow:

```text
screenId: JADA160AC5f
eventId:  JADA160AC5fE01
POST /custom-web00/jada/debit-sso/login-usage-dtl-inq
data: branchNum, accountNum,
      debitSSOTransactionType="10", serviceId="DAYA070Ao", buttonId="021"
```

Response `debitSsoBinDat` is temporary SSO data, not transactions. Browsers submit it as hidden `MessageCheck` to `POST https://igw.sonybank.jp/vcfb/vcfb02001`. Normal-menu `POST /custom-web00/jada/debit-sso/login` goes to the same external entrypoint.

On 2026-08-31, captured user operation in Kuebiko, then replayed with a normal HTTP client without Chrome Cookies. Bank-issued temporary SSO data sent to `igw.sonybank.jp` returned auto-submit HTML with ASCII hidden `r01`/`cc`; POSTing to `dc.sonybank.jp/p/sLogin/RW13F2010101` returned `利用明細照会` (usage-details inquiry) 200. Linux Bun/standard Worker `fetch()` suffice without Chrome profiles/browser runtimes.

The card platform is Shift_JIS HTML, not JSON, with this structure.

- Last 15 months appear as 15 `W131301.referenceDate` options.
- Month switching is Nablarch POST `RW1313010201`, returning whole monthly HTML.
- Lists include `お取引日`, `ご利用通貨・金額` (usage currency/amount), `お取引通貨・金額` (transaction currency/amount), `換算レート` (conversion rate), `海外取引経費` (overseas transaction charges), `現地手数料` (local fees), `お取引内容` (transaction contents), `承認番号` (authorization number), `確定日`, `備考` (remarks); no separate detail endpoint.
- `RW1313010301` is a monthly-PDF GET form; current PoC saves HTML only.
- Public `/js/W131301.js` rejects a second month search within 10 seconds. Actual-account rapid scans reached 403; all 15 months succeeded at 10.25-second intervals.
- No temporary SSO, `r01`, `cc`, Cookies/JSESSIONID, hidden values in R2. Strip `;jsessionid` and blank hidden values before saving monthly HTML privately.

The same capture confirmed ordinary-deposit screen `/pages/ea/eaba0600/`, with JPY plus USD/EUR/GBP/AUD/NZD/CAD/CHF/HKD/ZAR/SEK. Initial `/eaba/cust-web/ordinary-deposit-transaction-histories`, subsequent `/eaba/cust-web/ordinary-deposit-transaction-histories-pager`, CSV `/eaba/ordinary-deposit-transaction-histories/csv/load`; groups of 3 starting 1/4/7..., even 20-month ranges returned 200. Actual-account smoke test for 2025-01-01–2026-08-31 produced 102 artifacts, including 57 foreign artifacts/15 WALLET months; zero residual sessions/hidden values before storage. No transaction values recorded in documentation.

Same-day production Worker validation scanned 2025-09-01–2026-08-31, saving 34 artifacts including 10 yen rows, 6 foreign rows/11 pages, and 15 WALLET months, failure 0. Reread monthly HTML from R2 to confirm Japanese titles, no JSESSIONID/nonempty hidden values/MessageCheck. CSV generation for zero-transaction currencies such as EUR sometimes returned 500 only through Cloudflare egress; omit empty CSVs while retaining balances/empty history JSON. Save CSVs for currencies with transactions.

### 2026-09-04 production validation of central raw-evidence migration

Scanned all 120 source-R2 listing pages and ingested 11 manifests. D1 showed 2 old v1/9 current v2 runs, all 11 sealed, 0 unsealed. Replaying the same 11 from the start left counts at 11, confirming exact sealed-run replay idempotence. One old-v1 source/central content-addressed object matched SHA-256/byte counts. No bodies, hashes, balances, or statement values in outputs/docs.

Currently operator-run backfills send staged inventories in groups of 10 objects, then seal. Source R2 remains a durable outbox without deletion. Future reconcilers use manifest events/periodic repair scans to automate the same idempotent contract.

Historical record: the backfill script, the importer, the outbox reconciler
Queue and the source bucket `kogane-sony-bank-collector-poc` were retired on
2026-09-13, after the bucket's objects were copied to `DATA` and verified
([legacy retirement](../legacy-retirement.md)). The collector writes each run once, into `DATA`
([U09 below](#switch-to-shared-data-r2-u09)), and its daily run is the Processor's
alarm job `sony-bank` (06:00 JST, `0 21 * * *` in `config/alarm-jobs.json`).

## Official APKs/apps and Web roles

### Official distribution

- Sony Bank App Android package:
  [`net.moneykit.SonyBankApp`](https://play.google.com/store/apps/details?id=net.moneykit.SonyBankApp)
- Sony Bank WALLET App Android package:
  [`net.moneykit.sbw`](https://play.google.com/store/apps/details?id=net.moneykit.sbw)
- Both official pages link Google Play/App Store; Play developer is SONY BANK INCORPORATED. Rooted/otherwise improperly modified devices are unsupported.
- No direct official standalone APK download confirmed. Third-party Play split/bundle mirrors lose provenance and are not Kogane inputs.

### Play package/version/provenance follow-up

Reacquired official bank→Play links and public Play metadata; displayed versions do not yet establish device-delivered artifacts.

| App               | Package                    | Public Play version/update                  | Provenance assessment                                                           |
| ----------------- | -------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| ソニー銀行 アプリ | `net.moneykit.SonyBankApp` | `8.02.00` / 2026-03-27 (English JP listing) | Direct bank link/developer `SONY BANK INCORPORATED`; gap with August 26 renewal |
| Sony Bank WALLET  | `net.moneykit.sbw`         | `12.04.00` / 2026-08-18                     | Direct bank link/developer `SONY BANK INCORPORATED`                             |

Renewal notices explicitly scheduled a re-registration-requiring version for 2026-08-26, while that day's public Play metadata still showed March `8.02.00`. Official environments still listed Android 9–16 with a 2025-10-17 update, while renewal guidance said Android 12–16. Public information cannot distinguish staged rollout, region/device compatibility, caching, or metadata delay. Do not call `8.02.00` the renewed build; read actual device-delivered `versionCode/versionName` from manifests.

No `.apk`/`.apks`/`.aab`/`.xapk` existed in the workspace; WSL lacked `adb`, `apksigner`, `aapt2`, `apkanalyzer`, JADX, apktool, bundletool. Thus no manifest/DEX/native libraries were analyzed here. Do not route around this through mirrors/private Play-download endpoints; record barriers/reproduction below.

### Legitimate split-APK acquisition/comparison

Perform **immediately after** official Google Play installation/update on the user's Android.

1. Locally record device/PC times, Play-account region, model/ABI/Android version, official listing URL. No account emails, Android serials, Advertising IDs.
2. Install official SDK Android Platform Tools; list base/split paths with `adb shell pm path <package>`. `adb pull` `net.moneykit.SonyBankApp`/`net.moneykit.sbw` into separate directories, retaining original filenames/pull times.
3. `sha256sum` each APK; `apksigner verify --verbose --print-certs` checks matching split signers. Save only signer-certificate digest, package, versionCode/versionName, base/split filenames.
4. Read metadata with `apkanalyzer manifest application-id/version-name/version-code/min-sdk/target-sdk` and `aapt2 dump badging/xmltree`. Only installation artifacts without bank-account/device identifiers are in scope.
5. Repeat after updates, comparing signer continuity, split sets, versions. Retain both public Play/device versions if they differ; do not overwrite either.
6. Do not upload APKs/decompilations/runtime captures to Git/CI/cloud. Retain temporarily in owner-controlled encrypted local storage; repository contains only hashes, versions, sanitized findings.

Normalize unnecessary random installation-directory segments returned by `pm path`. Do not re-sign/repack/patch APKs, use root/emulators or alternate-region acquisition to deceive Play Integrity/license checks.

### Manifest/static-analysis targets

| Item                  | Concrete checks                                                                                               | Current status                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Package/provenance    | Package/version/splits/signers matching Play listing/update                                                   | Listing only; no artifacts                                                    |
| Components            | Exported activities/services/receivers/providers, permissions, intent filters, App/deep links                 | Unconfirmed                                                                   |
| Transport             | Network security config, cleartext flags, host/path literals, Retrofit/OkHttp, WebView bridges, JSON/protobuf | Unconfirmed                                                                   |
| Session issuance      | Login/register models, cookies/tokens/key aliases, refresh/rotation/logout, app→Web SSO                       | Unconfirmed                                                                   |
| Device binding        | Keystore/key aliases, device IDs, SMS/cash-card enrollment, one-device-per-account enforcement                | Official one-device rule/re-registration/SMS confirmed; mechanisms unknown    |
| Integrity/anti-tamper | Play Integrity/SafetyNet/App Check, root/hook/debug/emulator checks, runtime/native protection                | Official root/analysis/tamper defenses stated; vendors/mechanisms unconfirmed |
| TLS/pinning           | Network config, `CertificatePinner`/TrustKit, native trust stores, pins/backups                               | Unconfirmed; proxy failure alone does not establish cause                     |
| Web fraud tools       | `fraud-alert.net`/Caulis, `dd.sonybank.jp`/PhishWall, WebView asset/cookie sharing                            | Web confirmed; app adoption unconfirmed                                       |
| Read/write routes     | Methods/paths/schemas for balances/history/list/detail versus pay/transfer/trade/card settings                | Unconfirmed; separate tables through static call graphs                       |

Use JADX/apktool resources/DEX call graphs, serializer annotations, native strings/`readelf`; relate R8 names through resource IDs, method signatures, schema fields, call sites. Deobfuscation/runtime tracing are in scope alongside Web research, not deferred until Web gaps. Do not make root/anti-tamper/pinning/integrity removal/hooks success conditions. Record control names, error classes, reachability barriers when observation fails.

### Role separation

| Surface                 | Strength                                                                                      | Automation decision                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Official Web            | All-product screens, old passbooks, CSV, electronic delivery, accessible browser raw evidence | Primary ledger/export, BFF schema baseline                                         |
| ソニー銀行 アプリ       | All balances, OTP, transaction auth, foreign ordinary transactions, transfers, Web shortcuts  | Parallel read/auth/session-handoff research; no transaction UI                     |
| Sony Bank WALLET アプリ | Yen/foreign balances/currency history, past-year debit trends/recurring/family debit          | Primary mobile debit/read-schema evidence; deny settings                           |
| Official read APIs      | Most stable structured reads                                                                  | Contracted electronic payment service providers, not personal Kogane initial route |

The major 2026-08-26 update requires re-registration. Old/new versions coexist that day; public screenshots/old UI are not fixed specifications. Renewal removes trends, pattern login, some yen filtering, notification history, while current Play still describes past-year balance trends. Treat this coverage gap as a version difference; manually compare app/Web CSV at the same time.

Official password-free shortcuts from authenticated main app to Web establish app→Web handoff, not token formats/scopes/reusability. WALLET specializes in yen/foreign ordinary/debit; Web in all products/long CSV. Even with parallel APK/static/runtime research, steady-state primary remains Web/official exports; mobile clarifies missing debit status/schemas, device-bound auth, app→Web boundaries.

### User-operated read-only runtime metadata

1. On verified legitimate-version/signature stock devices, open existing dashboard, yen/foreign balances/history, WALLET existing/recurring debit once each. No actual-value screenshots/logs.
2. Use explicit device proxies/VPNs or standard OS diagnostics for DNS/SNI, host/path/method/status/MIME, header **names**, TLS-chain metadata. Capture filters discard login/register/OTP bodies, tokens/cookies/device IDs/attestation values.
3. Locally redact responses to key names/types/nullability/array-count ranges/pagination fields. No amounts, merchants, dates/locations, card/account/member IDs.
4. Observe one app→Web authenticated read-dashboard transition's hosts/redirect chain/header names, never handoff values.
5. Extract only static write-route method/path patterns, never runtime calls. No FX trades/transfers/ATMs/Google Pay enrollment/card stopping/restriction removal/limits/family settings.
6. If user CAs are rejected, stop at SNI/DNS. Record pinning/root/attestation/anti-tamper as barriers without patch/hook/disabling.

Stop for OTP/transaction auth, SMS/cash-card/app re-registration, writes/unknown controls, 401/403/429, locks, pinning/integrity/root/anti-tamper errors, unexpected hosts/redirects, suspected captured PII/secrets, version/signature mismatches. No retries/bypasses.

## Public third-party implementations

Use third-party code only as transport history, trusting neither credential handling nor current compatibility.

### `mktakuya/puppeteer-sonybank-scraper` (2021)

[commit `3e59a37`](https://github.com/mktakuya/puppeteer-sonybank-scraper/blob/3e59a37d6e339c7d2e6bbba63e1581d983d6d07f/index.js) starts headless Puppeteer in about 40 lines.

1. Opens `https://o2o.moneykit.net/`.
2. Enters environment variables into `input[name=TenNo]`, `KozaNo`, `Password`.
3. Clicks yellow login link; waits navigation/network idle.
4. Strips commas from `#setEnYkinZandaka` text, converting yen ordinary balance to integer.

A browser DOM scraper, not API client; no foreign/time/history/pagination/OTP/fraud handling. Establishes a 2021 password-to-balance design, not success on current hosts/SPA.

### `nakaomote/financial` (2019–2025)

[`sony_download.py`](https://github.com/nakaomote/financial/blob/44e1d43b5c010ee692234777baf9a9fc20be83be/sony_download.py) recreates old HTML through `requests.Session`/BeautifulSoup.

1. GET old `NBG100001G01.html`.
2. Form POST `TenNo`, `KozaNo`, `Password`, screen IDs to `TDGate1/gate/NBW000010`.
3. Parse all response hidden inputs, POST next handoff form.
4. POST start `1900/01/01`/end today to `TDGate000036/gate/NBW000036/YenFutsuRireki.csv` for yen ordinary CSV.

[2025-05-18 commit `44e1d43`](https://github.com/nakaomote/financial/commit/44e1d43b5c010ee692234777baf9a9fc20be83be) handled updated CSV by removing download `__sid` and parsing by header names. Reads Shift_JIS `取引日`, `摘要`, `引出額`, `預入額`, `差引残高`, uses Visa-description suffixes as merchants, and checks previous balance + movements = next balance across consecutive rows.

Valuable transport/date-range/CSV/balance-check examples, but on 2026-08-26 `o2o.moneykit.net` no longer resolved and official login had moved to `sonybank.jp/pages/...`. Never send old endpoints/fields to current systems, bypass DNS, or reuse stored credentials.

### Implications

- Reuse separation of official browser login/read from Puppeteer.
- Reuse raw official CSV retention, header-name parsing, balance-chain checks from Python.
- Do not reuse old URLs/form fields/DOM selectors/HTTP-only login.
- Public bundles reveal current BFF request shapes, but establish authenticated reads through live Kuebiko capture, never guessed probes.

## Execution-environment suitability

| Environment                | Rating | Reason                                                                                                                               |
| -------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------ |
| User's local Chrome        |    5/5 | Safe Bitwarden fill, visible step-up, app handoff, CSV; initial baseline                                                             |
| Local/OCI single container |    4/5 | Easy Playwright/Chrome, persistent profiles, downloads, Shift_JIS, cookie jars; fixed egress/encrypted volumes needed                |
| Cloudflare Container       |    4/5 | Full browser/Node near R2/D1/DO coordination; egress Caulis/risk changes need validation                                             |
| OCI Kubernetes             |    3/5 | CronJobs/Secrets/volumes possible, excessive for one account; fix rescheduling/concurrency/egress/profile volumes                    |
| Cloudflare Workers         |    2/5 | Candidate for authenticated JSON/CSV replay; login telemetry/cookies/CSRF/revision/event hashes/downloads unsuited to isolates alone |

Recommended `Durable Object/cron coordinator -> one active Container -> R2 raw evidence`. Decide login-issuer/read-consumer separation after session export/import validation. One persistent browser from login through download currently minimizes variables. No concurrent cron/manual/delayed runs per source.

OCI versus Containers depends on stable profiles, one active run/source, fixed egress, no secret output, retained downloads, expiry stops, rather than Kubernetes. Defer K8s until many sources/workers need isolation.

## Automation levels A–E and cost 1–5

### Scale

- **A**: direct documented/export API suitable for scheduled headless execution
- **B**: stable read-only internal APIs with renewable/reusable sessions
- **C**: headless reads likely after browser/app bootstrap
- **D**: full browser/device UI automation required
- **E**: manual capture as safe default

Cost 1 means saving/import only; 5 involves contracts, multiple runtimes, mobile/reverse engineering, etc.

| Option                                      |  Cost | Level                 | Scope                                                       | Decision                                                |
| ------------------------------------------- | ----: | --------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| User retrieves official yen/foreign CSV     |   1/5 | E                     | Yen ordinary/cross-product foreign                          | **Adopt immediately**, safest backfill                  |
| Local Chrome password fill/CSV download     |   3/5 | D                     | Yen/foreign CSV/balance screens                             | **MVP recommended**, handoff only on updates/step-up    |
| Current BFF authenticated read replay       |   4/5 | C, B after validation | Accounts/balances/history/lots                              | After Kuebiko capture; login may remain browser         |
| Pure HTTP/Worker password login             |   4/5 | Unvalidated C         | Same                                                        | Telemetry/session unknown; not first choice             |
| Contracted official read APIs               |   5/5 | A                     | Broad official balances/passbooks                           | Eligible-company contract; personal MVP equivalent to E |
| Sony Bank App UI automation                 |   5/5 | D                     | All products/auth                                           | Not recommended: one device, SMS/biometrics, writes     |
| Legitimate 2-app split static/deobfuscation | 3–4/5 | C research            | Manifest/hosts/schemas/sessions/device/integrity candidates | **Parallel with Web**, provenance required              |
| User-operated WALLET read-only metadata     |   4/5 | C candidate           | Debit/yen-foreign ordinary                                  | Separately assess replay after hosts/schemas confirmed  |
| WALLET/full-app UI automation               |   5/5 | D                     | Debit/ordinary/all products                                 | Fragile writes/device binding/updates; not steady-state |
| Aggregator information linking              | 1–2/5 | A                     | Balances/statements, etc.                                   | Official OAuth-like consent, excluded initially         |

Overall **cost 4/5, level C**; yen/foreign CSV-only MVP can fall to 3/5. Reassess authenticated replay as B only after these hold across days/restarts.

- Low-frequency normal login without step-up succeeds
- Restore sessions/profiles from encrypted storage
- Clear read/write endpoint separation
- Stable CloudFront/Caulis acceptance of runtime/egress
- Matching CSV/BFF-DOM counts, inflow/outflow totals, ending balances

## Read-only live-validation plan

Never expose actual-account screen values in reports, terminals, screenshots, or commits. Compare only matching/nonmatching counts/totals/ending balances in local ephemeral processes; output booleans/schema metadata only.

1. Navigate from official top to current login in the user's normal Chrome; check URL/TLS certificates.
2. Check Bitwarden UI item type as ordinary login/password versus passkey. The user fills without displaying/reading aloud/capturing values.
3. Record whether branch/account/password alone completes login or step-up appears.
4. Confirm previous-login time and read-only dashboard after login; no recorded balances.
5. From `商品/残高` (products/balances), check only contracted product-category names and masked-identifier presence. Category counts exclude amounts/contract numbers.
6. Check yen-passbook periods, inflow/outflow, sorting, keywords, pagination/count displays; no memo editing.
7. User downloads a short known-period yen CSV. Locally inspect only filename/MIME/encoding/headers/page-period limits/stable-ID presence; real rows stay within storage.
8. Only with foreign holdings, similarly check nine fields, decimals, currencies, masked contracts, unsettled rows. No FX/time-deposit operations.
9. Exclude auth bodies/headers/fraud telemetry from Kuebiko upload; observe only authenticated-response host/path/MIME/status as allowlist candidates.
10. Locally reconcile same-period CSV/DOM-BFF counts, inflow/outflow totals, ending balances; investigate unsettled/cancelled/timing/boundary differences.
11. Test 15-minute idle, browser restart, next-day sessions in order. Confirm expiry redirects stop normally without automatic credential-login retries.
12. Only after local stability, perform one same-flow OCI/Container test each, fixed egress/UA/profile, recording only 401/403/429/challenge differences.
13. Without waiting for Web stability, acquire two legitimate Play base/split packages; statically check versions/signers/manifests/network config/hosts/schemas/session-device-integrity candidates.
14. Observe one user-operated existing read screen per app, comparing Web BFF/CSV coverage/schemas/handoff. Never operate writes to generate differences.
15. If pinning/integrity/root/anti-tamper hides paths/bodies, report DNS/SNI only; no hooks/repacking/bypasses.

### Stop conditions

End the run immediately and suspend cookie-jar/profile reuse on any of these.

- 401, 403, 429, Access Denied, challenges/CAPTCHA, maintenance/system errors
- Wrong password/OTP/security phrase, locks, resets, auth-method change guidance
- SMS, phone, cash-card manufacturing number, app re-registration, transaction-auth requests
- Unexpected authenticated/unauthenticated URL changes, TLS certificate/host mismatch
- Requests outside read allowlists or transfer/account-transfer/trade/deposit/cancellation/application/change endpoints
- CSV/DOM/BFF schema changes, total/ending-balance mismatches, suspected partial downloads
- Suspected actual account IDs/balances/statements/secrets/PII in logs/captures/PRs
- Concurrent same-generation sessions, expiry, profile corruption

Never resend the same login automatically after failure. Read-check existing authentication, rule out duplicate runs/lock risks, then hand off.

## Recommended implementation order

1. Build local importers for manually retrieved official yen/foreign CSVs, saving raw files by content hash.
2. Create current yen-CSV synthetic structural fixtures, not anonymized real rows. Never put real rows in Git.
3. In parallel acquire both legitimate base/split packages and statically inspect provenance/manifests/hosts/schemas/session-device-integrity-pinning candidates; no Web-gap prerequisite.
4. One source/one active normal-Chrome persistent-profile login/download.
5. Identify authenticated reads from Kuebiko; build path allowlists.
6. One user-operated app read-only metadata observation, comparing Web/CSV coverage/schemas.
7. Reconcile same-period CSV/read JSON-DOM and add read-only BFF replay. Separately assess app replay only after independent device-binding/session-scope proof.
8. After stable yen ordinary, add foreign CSV, time/installment/structured lots, funds in separate modules.
9. After stable local operation over days, move to OCI/Containers. Restrict Workers to coordination/session leases/ingestion; defer login fetch.

## Unconfirmed items

- Current account auth methods and ordinary-balance-login step-up frequency
- Bitwarden ordinary credentials versus passkeys (no value inspection needed)
- Biometric/PIN login after 2026-08-26 renewal and old-version coexistence duration
- Public Play `8.02.00` versus August 26 renewal builds; staged/region/device variants
- Current yen-CSV columns/encoding/quotes/newlines/max periods-counts/stable IDs/same-day order
- Passbook HTML/BFF page sizes/pagination/memo-EDI export
- Foreign CSV earliest retention/max counts/bulk scope/currency precision
- Current yen-time/installment/foreign-time/structured lot fields/ended-contract retention
- Product reads beyond confirmed BFF, idle/absolute session lifetimes
- Caulis/PhishWall effects beyond currently successful password login; telemetry-free Cloudflare succeeds, OCI untested
- CloudFront AWS WAF/Bot Control association; no Akamai observed at current login
- Browser/profile session export/import and concurrency
- Post-SSO WALLET `igw.sonybank.jp` list/detail/pagination APIs, 15-month traversal, stable IDs, family-debit IDs, pending→finalized replacement rules
- Both apps' base/split sets/versionCode/signers/components/permissions/deep links
- App read hosts/paths/methods/schemas/pagination/tokens-cookies-key aliases/refresh/logout
- Main app's one-account/one-device, transaction keys, app→Web SSO device/session binding
- App Caulis/PhishWall, pinning/Play Integrity/attestation/root-anti-tamper vendors/secure storage
- Ordinary ledger PDF downloads (publicly only CSV confirmed)
- Personal contract-free API development environments/specifications (currently assessed unavailable)

## Main references

### Official primary sources

- [Sony Bank Web](https://sonybank.jp/)
- [Login procedure](https://sonybank.jp/guide/support/howtologin/)
- [Sony Bank authentication methods](https://sonybank.jp/guide/auth/)
- [Smartphone authentication](https://sonybank.jp/guide/auth/01.html)
- [Sony Bank security measures](https://sonybank.jp/guide/securityinfo/07.html)
- [Yen deposits/all-history passbook and CSV](https://sonybank.jp/products/yen/)
- [Passbook help](https://sonybank.jp/guide/bankbook/01.html)
- [Foreign transaction CSV fields](https://sonybank.jp/products/fc/39.html)
- [Foreign deposit gains/losses](https://sonybank.jp/tool/fc/40.html)
- [Sony Bank App fields](https://sonybank.jp/tool/app/banking/01.html)
- [Differences between official apps](https://sonybank.jp/inquiry/app/01.html)
- [Sony Bank WALLET App](https://sonybank.jp/tool/app/sbw/)
- [Sony Bank WALLET specifications](https://sonybank.jp/products/sbw/03.html)
- [Visa debit debits/refunds/statuses](https://sonybank.jp/products/sbw/29.html)
- [Official WALLET statement procedure](https://sonybank.jp/campaign/wallet202606/)
- [WALLET direct usage-details link](https://sonybank.jp/pages/ja/jada160a/confirm1/)
- [WALLET SSO confirm4 bundle](https://sonybank.jp/pages/ja/_next/static/chunks/pages/jada160a/confirm4-ff822f4f2d314a11e514.js)
- [WALLET SSO confirm5 bundle](https://sonybank.jp/pages/ja/_next/static/chunks/pages/jada160a/confirm5-1c58728bac0d7c38262f.js)
- [Sony Bank App Google Play](https://play.google.com/store/apps/details?id=net.moneykit.SonyBankApp)
- [Sony Bank WALLET Google Play](https://play.google.com/store/apps/details?id=net.moneykit.sbw)
- [2026-08-26 app renewal](https://sonybank.jp/info/2026/0724-01.html)
- [Supported app environments](https://sonybank.jp/guide/spec/04.html)
- [Smartphone app terms](https://sonybank.jp/stpl/84.html)
- [Information-linking service](https://sonybank.jp/services/api/)
- [Read-API coverage](https://sonybank.jp/stpl/161.html)
- [API partner eligibility criteria](https://sonybank.jp/stpl/162.html)
- [Current Web core config](https://sonybank.jp/pages/config/core.js)
- [Current Web environment/anti-fraud config](https://sonybank.jp/pages/config/env.js)

### Public third-party implementations

- [`mktakuya/puppeteer-sonybank-scraper` commit `3e59a37`](https://github.com/mktakuya/puppeteer-sonybank-scraper/blob/3e59a37d6e339c7d2e6bbba63e1581d983d6d07f/index.js)
- [`nakaomote/financial` `sony_download.py` at `44e1d43`](https://github.com/nakaomote/financial/blob/44e1d43b5c010ee692234777baf9a9fc20be83be/sony_download.py)
- [`nakaomote/financial` 2025 CSV schema update](https://github.com/nakaomote/financial/commit/44e1d43b5c010ee692234777baf9a9fc20be83be)

## History CSV quote recovery (parser 1.0.3)

The shared reader warns about unclosed opening quotes and text after a closing
quote, keeping recovered rows and following rows. A quote-damaged row that fails
Sony's strict value checks is retained as one transaction with verbatim named
cells and dataset-derived account/currency; economics, date, status and identity
remain absent. Normal rows and well-formed multiline fields keep their previous
reading. Header/cardinality drift and invalid undamaged rows still refuse the
artifact. See the [shared CSV recovery boundary](../observations.md#shared-csv-reader-recover-malformed-quotes-without-losing-following-rows).

## Switch to shared DATA R2 (U09)

The collector does not read `COLLECTION_TARGET`. Its only destination is shared
`kogane-raw-evidence` (binding `DATA`). Switching/importer retired on
2026-09-13 (`docs/collection.md`). Runs save through `packages/collection`,
writing terminal manifests last. Saved bytes match those previously sent centrally;
Wallet details are HTML already processed by collector `sanitizeWalletHtml`.
See the relevant `docs/collection.md` sections for artifact/role mappings and
terminal fields.

## 2026-11-08: CSV is the only current deposit transaction history

Owner decision, 2026-11-08 13:29 UTC, with the completeness addition on
2026-11-08 ([issue 1182](https://github.com/risu729/kogane/issues/1182),
[ADR 0092](../adr/0092-sony-history-csv-only.md)): current deposit history
transactions come only from the official CSV. JSON history pages remain
stored evidence; their per-page occurrence identities cannot distinguish
identical rows across pages. JSON also uniquely retains exchange
counter-currency codes `currencyCdSpndl`, `currencyCdStl` and
`otherPrtyCcyCd`; the CSV uniquely retains `参考情報` (reference information). This change does
not promote those codes into a new observation field. JSON after-transaction
balances retain their existing contract.

For each currency/window, the collector requires the logical CSV data-row
count to equal the first JSON page's `countCnt`. Positive JSON history
without matching CSV fails with a closed terminal code; it is never filled
from JSON. Zero history still skips CSV and succeeds, avoiding the previously
observed empty-CSV server failure. Successful JSON and CSV bytes are stored
unchanged. No provider login or production-data inspection was performed for
this implementation.

## 2026-11-09: retained ordinary-deposit history without a start date

Read-only observation in the owner's authenticated local Chrome, through the
normal history controls at `/pages/ea/eaba0600/`. No authentication material,
account identifiers, provider row values or transaction dates were retained.

The currency combobox lists JPY/USD/EUR/GBP/AUD/NZD/CAD/CHF/HKD/ZAR/SEK.
Leaving the start date blank and setting the end to the last finished JST day
(observed request value `2026-11-09`) accepts every currency with HTTP 200 and
an empty `errors` array. The initial history request is POST
`/custom-web00/eaba/cust-web/ordinary-deposit-transaction-histories`:

- private `branchNum` and `accountNum` (values not recorded);
- `currencyCdInq` set to the selected currency;
- no `inquiryStrtdtCat`; `inquiryEnddtCat=2026-11-09`;
- `maximumAcqCnt=3`, `acquisitionStrtCnt=1`, `sortSelect=00002`, `detailDispSg=1`.

The next page is POST
`/custom-web00/eaba/cust-web/ordinary-deposit-transaction-histories-pager`,
with `currencyCd` instead of `currencyCdInq`, the same omitted start and explicit end,
`maximumAcqCnt=3`, `acquisitionStrtCnt=4`, `sortSelect=00002`, `detailDispSg=1`.
JPY, USD and AUD pagination was observed; the remaining currencies each fit
on their first page. No guessed opening date or early-range probe is needed.

The CSV link sends POST
`/custom-web00/eaba/ordinary-deposit-transaction-histories/csv/load`, with
private branch/account identifiers, `currencyCd`, the same omitted start and explicit end,
`sortSelect=00002` and `detailDispSg=1`, without paging keys. Every currency's
CSV returned HTTP 200 `application/octet-stream`. Logical data-row counts
matched the JSON totals for all eleven currencies; quoted framing and field
counts matched. JPY has the existing seven columns (`取引日`, `摘要`, `参考情報`,
`通貨`, `預入額`, `引出額`, `差引残高`); all foreign currencies add `為替レート`.
Only counts and schema were inspected in memory; no private row was copied.

The JSON envelope remains `errors: array`,
`responseBizCommon: {bizResult: string, exceptionRsn: array}`, `countCnt: number`,
`returnCnt: number`, `transactionHistInfo: array`, with the existing transaction
string fields and optional FX fields. `currencyMst` retains 13 entries and
`ordinaryDepAcInfo` 11 entries with existing string fields. First-page array
length and `returnCnt` equal the lesser of total and three.

The scheduled collector preserves the prior monthly requests and also walks
this unbounded-start query for every currency through yesterday. Canonical
filenames contain full retained history; `monthly-*` files retain the monthly
responses as evidence without a parser dataset. The production dataset selector
therefore publishes only the full CSV. Existing external IDs collapse overlap
with earlier monthly runs and repeated retained runs, while retaining distinct
occurrences of truly identical rows (ADR 0092). The Processor passes an explicit
null lower bound only for Sony; its parsers use the Sony-only
`retainedHistoryEnd` field and continue to enforce the end date. Every page and CSV must pass completeness checks. A mismatch, unavailable CSV,
or page limit fails the run with a closed code, rather than claiming zero or
publishing a partial CSV. There is no continuation cursor at the observed size.
This proves the query's entire provider-retained result, not independent
account-opening coverage or deployment of this implementation.

## Realised gains and delivered documents observation (2026-11-10)

### Read-only route evidence

Authenticated local Chrome, read routes only. Public https://sonybank.jp/tool/fc/40.html links 外貨損益状況照会 to `/pages/ea/eada110a/`. Initial POST `/custom-web00/eada/eada110as1g/e10` body private branchNum/accountNum only. HTTP200 JSON response has errors[],responseBizCommon{bizResult:string,exceptionRsn:[]}, returnCnt:number (11), ordinaryDepAcInfo11{accountStat,currencyCd strings}, currencyMst13{currencyNm,currencyCd strings}; assPrftLsAgr:string, assPrftLsInfoCnt:number(0),assPrftLsInfoFcplSi:[] (nonempty unobserved); rliztnPrftLsCy:string,current-year label; cyAgrRliztnPrftLs,cyAgrItrAmt strings; cyCcySepRliztnPrftLsCnt:number(1),cyCcySepRliztnPrftLsFcplSi[{currencyCd,cyRliztnPrftLs,cyItrAmt strings}]; analogous Ly/ly keys for previousyear. totalDtlStartYr/totalDtlEndYr:string are query years2025/2026; totalDtlCnt:number10,totalDtlGrsCnt:number119,totalDtlFcplSi10[{transactionDt,currencyCd,productTpy,abridgmentObj,transactionAmt,applicationExchRt,transactionAfBal,traAvgPurRt,traExchProfLos,interestYenAmt allstrings}]. No actual amounts or transaction dates retained.

UI labels 評価損益/実現損益/集計明細. Realised section states last2years and per-currency 為替差損益/利息など（税引後）/合計. Detail section explicitly says from start of foreign deposit trading through latest; default last2years. Yearqueryinputs totalDtlStartYr_year/totalDtlEndYr_year. UI first page119total,1/12. Nextbutton sends POST `/custom-web00/eada/cust-web/foreign-currency-profit-loss/situation-inquiry/pager-inquiry`, private branchNum/accountNum + totalDtlStartYr=2025,totalDtlEndYr=2026,maxCnt=10,startCnt=11; UI then2/12.

集計明細CSVダウンロード sends POST `/custom-web00/eada/cust-web/foreign-currency-profit-loss/situation-inquiry/download`, private branchNum/accountNum +totalDtlStartYr=2025,totalDtlEndYr=2026. HTTP200octet-stream,119data rows exactly match totalDtlGrsCnt, balancedquotes15cells each. Header: お取り引き日,商品,契約番号,明細番号,通貨,摘要,入金額,出金額,残高,適用レート,取引円換算額,特約レート,為替差損益,平均購入レート,利息円貨額. Do not re-emit cashmovements or recompute profit: parse official profit/interest separately with stable source row identity. Values remain browsermemory only.

Foreign deposit sidebar sideMenu_fc_9_5 電子交付一覧 leads `/pages/aa/dbba1800/`. POST `/custom-web00/dbba/dbba1800s1f/e01` body{} initialresponse errors[],responseBizCommon and searchStartDt/searchEndDt strings (query default1year). Both dates required; blank UI validation refuses without request. Observed fiveyear query2021-11-10→2026-11-10 via ordinary inputs.

POST `/custom-web00/dbba/delive-doc/inquiry/cust` body private branchNum/accountNum +productTyp=01,browseTyp=0,searchStartDt=2021-11-10,searchEndDt=2026-11-10,maxCnt10,startCnt1. Optional deliveryDocTyp=20,deliveryDocItem=000 when explicitly choosing all-products/contract-document; omitting both (default dropdown blank) returned same10. UI count10/page1of1; response extractionAgrCnt10,returnCnt10,deliveryDocInfo10 unique deliveryDocNum numeric IDs, currencyMst13; errors[],responseBizCommon. Each doc row {deliveryDocTyp:string,currencyNm:string,acquisitionDt:string,deliveryDocItem:string,contractDttm:string,depositAmt:string,browseTyp:string,deliveryDocNum:number}. Fixed docType20 matches UI契約締結時交付書面. No nonempty other docType observed. Dropdown product values000all,001foreignordinary,002foreigninstallment,003foreigntime,004foreigntime maturitychange,005BRL opening,006yenplus,007FXlinkedYen,008FXlinkedforeign,009ANA-mileforeigntimeopening,010ANA-milematuritychange,012foreigntimeautoreinvest. Another dropdown only20 available. No nextpage because count=10; pagination>10 not observed.

Click PDFファイル sends POST `/custom-web00/dbba/delivery-documents/pdf-download` {branchNumber:string,accountNumber:string,deliveryDocNum:number}. HTTP200octet-stream,bytes4817 with%PDF- prefix verified inbrowsermemory only. Do not carry depositAmt/private labels into operational metadata. Document identity and bytes must remain privateDATA. No enrollment/settings changes.

Fund public guide https://sonybank.jp/products/fund/24.html says viewing last5years, links read-only電子交付書面閲覧 `/pages/aa/iaca300a/` separately from switch/enrollment link (not clicked). POST `/custom-web00/iaca/iaca300as1f/e01` {accountNum:string,branchNum:string,activityAccountConfFlg:'0'} returned errors[{code:'EIA20107',title:string,sources:[]}],responseBizCommon{bizResult:'8',exceptionRsn:[]}. Visible 投信総合口座を開設していないお客さまはお取引できません。 (fund account not opened). Do not invent fund report schema or equate unavailability to emptyreportlist. Fund-specific5year official guide is not independent proof of foreign-doc retention; currentforeign fiveyear queryaccepted/count10 only.

Follow-up 2026-11-09 23:12 UTC: e10 `rliztnPrftLsCy` and `rliztnPrftLsLy` are plain YYYY strings. The observed detail productTpy code is `1`. currencyMst codes are JPY/USD/EUR/GBP/AUD/NZD/CAD/CHF/HKD/BRL/CNH/ZAR/SEK. Current/previous currency gain and interest fields are plain signed decimal strings (no comma or blank observed); no amounts are recorded. e10 FBaaS-Request-Biz-Hd-Common={screenId:EADA110AS1f,eventId:EADA110AS1fE01}, FBaaS-URI=https://sonybank.jp/pages/ea/eada110a/. Docs inquiry header screenId DBBA1800S1f,eventId DBBA1800S1fE11; PDF eventId DBBA1800S1fE12; URI https://sonybank.jp/pages/aa/dbba1800/. The common header has only screenId/eventId, no area key.

CSV follow-up: download common header screenId EADA110AS1f, eventId EADA110AS1fE12. FBaaS-SS=ea, revision-739 observed. Docs SS=aa/revision-872; public GET https://sonybank.jp/pages/config/revisions/aa/revision.json showed numeric text872. Docs initial e01 common header screenId DBBA1800S1f,eventId DBBA1800S1fE01. Live CSV again119 rows, balancedquotes15cells, Shift_JIS, product label ordinary deposit, alphabetic currency codes. Blank cells occur in deposits/withdrawals/special contract rate; signed gain and comma-formatted yen conversion observed; no private values saved.

### Implemented scope

The scheduled session reads the official current/previous-year summary and validates the complete 15-column detail CSV against its stated count. Each annual currency summary publishes the provider-stated JPY FX gain and after-tax interest as valuation evidence. No cash movement, income recognition or recomputation is produced. Unchanged response bytes are referenced by one artifact per year/unit; snapshots replace that year only, preserving previously collected older years after rollover. Raw detail CSV stays private evidence and has no movement parser. Its length cannot enlarge annual parser output (at most 26 observations per year).

The foreign-deposit document read uses the observed five-year query and downloads the single observed page only when its stated total equals its unique list rows and is at most ten. Larger totals are partial with `document_list_incomplete`; the next-page request has not been observed. PDF bytes must start `%PDF-` and fit the one-MiB bound. The shared DATA writer stores content-addressed objects once; an identical PDF offered in another run references the same bytes, and a changed PDF creates a new hash revision. The private provider list preserves document identities/dates and maps list order to generated ordinal PDF artifact names. No provider filenames or financial fields enter operational metadata. Full foreign-document retention remains unconfirmed, so that separate run is always partial with `document_retention_unconfirmed` after a successful observed query. Fund report schemas remain unsupported after the observed account-unavailable response; no empty fund report list is inferred.

Core deposits/WALLET, realised evidence and documents persist as three terminal runs sharing an acquisition-session reference. Every persisted run ID is returned to the scheduler. An optional failure cannot demote the independently complete core run or annual summary. No public collection window or user control is added.

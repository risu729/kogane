# ドコモSMTBネット銀行 (DOCOMO SMTB Net Bank, formerly 住信SBIネット銀行) primary research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26

## Conclusion

Kogane uses the bank's own website and official Android app as data sources without an aggregator. The most realistic first implementation is **operating the official website with Playwright to retrieve balance pages and official CSVs**. Among public third-party implementations, [`hirano00o/acctf`](https://github.com/hirano00o/acctf/tree/b79008d1b4ceed8eece5a24f61481a2e72216998/acctf/bank/sbi)
is closest to current screens and retrieves primary-account, purpose-specific-account, and SBIハイブリッド預金 (SBI Hybrid Deposit) balances and history through Playwright. However, it deletes official CSVs after retrieval, so Kogane must not adopt it unchanged. Kogane retains CSVs and responses as raw evidence.

Initial assessment:

| Target                                                        | Cost (1-5) | Automation feasibility | Main reason                                                                                  |
| ------------------------------------------------------------- | ---------: | ---------------------- | -------------------------------------------------------------------------------------------- |
| Current primary/purpose-specific/hybrid/yen-foreign balances  |          2 | High after login       | Existing single-page DOM implementation                                                      |
| Ordinary/SBI Hybrid deposit statements                        |          3 | High after login       | Official CSV since January 1 seven years ago, 999 per retrieval; repeat per account/currency |
| Yen/foreign time/structured deposits contract/history         |          4 | Medium                 | Product-specific screens/retention; yen-foreign time history 15 months                       |
| スマプロポイント (Smart Program Points) / dポイント (d POINT) |          4 | Medium                 | Split bank/d POINT CLUB information/retention/granularity                                    |
| Recurring runs with human input                               |          3 | Medium-high            | Easier stability with manual スマート認証NEO (Smart Authentication NEO) approval             |
| Fully unattended cloud                                        |          5 | Low-medium             | Binding/FIDO/approval/lifetimes/Akamai unverified                                            |

Implementation looks feasible, but **safe session reuse is the main risk, rather than balance/history retrieval**.
Do not target direct internal APIs/fully unattended cloud first.

## Research scope and safety boundaries

- Only personal account listed in existing inventory as 住信SBIネット銀行 (Sumishin SBI Net Bank,
  DOCOMO SMTB Net Bank).
- Primary/purpose-specific/SBI Hybrid/yen-foreign/structured deposits/points.
- Exclude SBI証券 (SBI Securities), SBI新生銀行 (SBI Shinsei Bank), NEOBANK partner branches, corporate services.
- Official Web/app sources, no Money Forward/other aggregators.
- No login/transfers/account transfers/points linking/settings changes during research.
- No secrets/account numbers/usernames/personal names/balances retrieved/stored.

Read existing Google Sheet `資産・残高チェックリスト` ("asset/balance checklist") through read-only Drive.
It separately listed primary/purpose-specific/SBI Hybrid/yen time-structured/foreign deposits/points as holdings.
No personal values copied here.

## Current name

On August 3, 2026, the company name changed to **株式会社ドコモSMTBネット銀行 (DOCOMO SMTB Net Bank, Inc.)**.
The personal-service brand is **ドコモの銀行 (DOCOMO's bank)**. Sumishin SBI Net Bank is the former company name; old screen and app labels may remain during the transition.

Evidence:

- [DOCOMO SMTB renaming](https://www.netbk.co.jp/contents/lp/ci/)
- [Company profile](https://tneobank.netbk.co.jp/contents/company/about/organization/)
- [New service brand announcement](https://www.netbk.co.jp/contents/company/press/2026/0709_006011.html)

Use the new company name as the canonical name in implementations, screens, and schemas, retaining the old name as an alias. The filename `sumishin-sbi-bank.md` follows the existing research task's specification.

## Official entry points

| Entry                                                                                                     | Purpose                                          | Automation role                                 |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| [Official Web](https://www.netbk.co.jp/contents/)                                                         | Balances/statements/products/points              | First candidate; long history/CSV-PDF           |
| [Official Android (Play, `jp.co.netbk`)](https://play.google.com/store/apps/details?id=jp.co.netbk&hl=ja) | Balances/statements/biometrics-FIDO/PC approvals | Authenticator/research; defer direct automation |
| [Official app guidance](https://www.netbk.co.jp/contents/lineup/sp-app/netbk/)                            | Features/distribution                            | Bank officially directs to Play/App Store       |
| Official partner API                                                                                      | Balances/statements etc.                         | Not public personal APIs, reject                |

Since 2016, the bank has offered balance and deposit/withdrawal statement read APIs to **partners**, such as electronic payment service providers. However, no public documentation, self-service client registration, or tokens individuals can issue for their own accounts were found. This is not a route for the present implementation, which avoids aggregators.

- [Electronic payment service provider cooperation](https://www.netbk.co.jp/contents/company/sitepolicy/api-policy/)
- [API launch/official Money Forward linking](https://www.netbk.co.jp/contents/company/press/2016/corp_news_20160325.html)

## Available data

### Balances/account structure

The official website's balance inquiry shows balances for each primary and purpose-specific account. Official app guidance also explicitly lists balances and statements for ordinary yen deposits, purpose-specific accounts, ordinary foreign-currency deposits, and SBI Hybrid Deposit as major features.

Purpose-specific accounts are deposit-only categories separate from the primary account, with up to 10 in simultaneous use. They can hold ordinary yen deposits, yen time deposits, ordinary foreign-currency deposits, and foreign-currency time deposits. They have no account number for external transfers and cannot be used for direct ATM or bank-transfer deposits/withdrawals. Account names may be personal information, so encrypt them in raw evidence and exclude them from logs.

SBI Hybrid Deposit is a yen deposit reflected in SBI Securities buying power, but its balances and deposit/withdrawal statements are available from the bank's official website. This research does not use SBI Securities screens or APIs.

Evidence:

- [Ordinary yen balances/statements](https://www.netbk.co.jp/contents/lineup/yen/futsu/)
- [Purpose-specific accounts](https://www.netbk.co.jp/wpl/NBGate/i900500CT/PD/shouhin_moku_01)
- [Maximum 10](https://help.netbk.co.jp/faq_detail.html?id=839)
- [Official app](https://www.netbk.co.jp/contents/lineup/sp-app/netbk/)

### Ordinary/SBI Hybrid deposit statements

| Item                        | Official specification                                                           |
| --------------------------- | -------------------------------------------------------------------------------- |
| Scope                       | Primary/purpose-specific yen-foreign ordinary, SBI Hybrid                        |
| Web retention               | Since January 1 seven years ago                                                  |
| Formats                     | Screens/CSV/PDF                                                                  |
| CSV/PDF per-operation limit | 999; narrow periods if exceeded                                                  |
| Main fields                 | Date/contents/outflow/inflow/post-balance/memo from official screen-CSV examples |
| Lost cases                  | Closed purpose-specific/suspended Hybrid not displayed                           |

Older periods require paid statement applications. Initially retrieve all available history by account/currency/
period, then incremental; automatically shorten windows beyond 999. Expected Shift_JIS from examples/implementations,
so save raw bytes before derived UTF-8.

Evidence:

- [Statement periods](https://help.netbk.co.jp/faq_detail.html?id=831)
- [CSV/PDF maximum 999](https://help.netbk.co.jp/faq_detail.html?id=834)
- [Statement improvements](https://www.netbk.co.jp/contents/company/info/2021/mg_notice_211210_info.html)
- [Statement redesign](https://www.netbk.co.jp/contents/company/info/2024/0612_002662.html)
- [Closed purpose-specific history unavailable](https://help.netbk.co.jp/faq_detail.html?category=87&id=848&page=1)

### Yen/foreign time/structured deposits

Ordinary-deposit statements alone cannot reconstruct contract-level information. Treat each product's balances and transaction history as a separate collector.

| Target               | Granularity                                                                                  | Period/count                                       | Assessment                                     |
| -------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------- |
| Yen time             | Account names/dates/contents/amounts etc.                                                    | History 15 months                                  | Early monthly retention needed                 |
| Foreign time history | Dates/contracts/currencies-periods/new-renewed-matured-cancelled/principal etc.              | 15 months                                          | Per contract; maturity handling changes absent |
| Foreign time orders  | Acceptance numbers-datetimes/currencies-periods/order methods-amounts-rates/execution/status | Since January 1 seven years ago, 200 per operation | Longer, different semantics                    |
| Structured deposits  | Separate balances/history screens                                                            | Public periods/counts unknown                      | Live checks                                    |

Evidence:

- [Yen time](https://www.netbk.co.jp/contents/lineup/yen/teiki/)
- [Yen time history 15 months](https://help.netbk.co.jp/faq_detail.html?id=5792)
- [Foreign time history](https://help.netbk.co.jp/faq_detail.html?id=5467)
- [Foreign time orders](https://help.netbk.co.jp/faq_detail.html?id=5465)
- [Structured balances](https://www.netbk.co.jp/contents/pages/wpl050302/i050302CT/DI05030200?CallerScreen=2)

## Multiple points routes/tradeoffs

dアカウント (d ACCOUNT) linking launched on August 20, 2026. Linking is optional; after linking, Smart Program rewards and similar benefits are awarded as d POINT. Existing Smart Program Points exchanged for d POINT cannot be converted back. However, **d ACCOUNT linking itself can be revoked and linked again**. The existing sheet's phrase `連携は不可逆` ("linking is irreversible") is more accurately read as "exchanging Smart Program Points for d POINT is irreversible". Never change linking status for Kogane research or collection.

| Route                          | Available                                          | History/expiry                                                                                                                                 | Automation tradeoff                                                       |
| ------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Bank home/points history       | Held points/ordinary-limited labels/nearest expiry | Retention unpublished; unlinked ordinary expires March-end second fiscal year after award month, limited per award; nearest expiry up to three | Simplest bank-session-only; live periods/fields needed                    |
| d-linked bank screen           | d balances/bank-derived points                     | Bank retention unknown                                                                                                                         | Snapshots, may omit other origins                                         |
| dポイントクラブ (d POINT CLUB) | All d accrual/use                                  | Up to 13 months including current; reflection/use dates/per-transaction expiry                                                                 | Most granular, separate login/mixed origins; description-ID deduplication |

When d ACCOUNT is linked, save bank-screen evidence of bank-origin point status separately from d POINT CLUB's final ledger for the shared points account. Do not sum the same award twice. Candidate reconciliation keys are `provider`, `source_description`, `use_date`, `reflected_at`, `expires_at`, `amount`, `limited`.
Check on the actual screen whether an official unique ID is provided.

Evidence:

- [d linking launch](https://www.netbk.co.jp/contents/company/press/2026/0820_006233.html)
- [Unlink/relink, irreversible exchange](https://www.netbk.co.jp/contents/lineup/daccount/)
- [Bank points/expiry](https://www.netbk.co.jp/contents/lineup/smartprogram/point/)
- [d history up to 13 months](https://dpoint.docomo.ne.jp/static/guide/faq/PointHyouji/PointHyouji01/)
- [d history fields](https://dpoint.docomo.ne.jp/guide/faq/PointHyouji/PointHyouji03.html)

## Authentication

### Established

- Same username/Web login password for Web/app.
- Smart Authentication NEO registers one smartphone, FIDO-compliant.
- Registration requires the phone number registered with the bank to match the device's phone number, and SMS or phone-call verification.
- Biometrics/six-digit PIN for app login/approval.
- Enabling PC/browser login approval requires registered-phone approval.
- Final approval for PC transfers and similar transactions moves from the authentication-number table to app approval. Read collectors do not navigate to transaction screens.
- Public login JS SPA has same-site `api.`/`authn.` bases, `/auth/v1/request/authentication` etc., JSON headers;
  internal APIs established, private/unguaranteed.

Evidence:

- [Smart Authentication NEO](https://www.netbk.co.jp/contents/lineup/smartauth-neo/)
- [Registration](https://www.netbk.co.jp/contents/lineup/smartauth-neo/register/)
- [PC use](https://www.netbk.co.jp/contents/lineup/smartauth-neo/pc/)
- [QR login](https://www.netbk.co.jp/contents/lineup/smartauth-neo/qrcode-login/)
- [Official app](https://www.netbk.co.jp/contents/lineup/sp-app/netbk/)

### Unverified

- Server authenticated JSESSIONID lifetimes/idle timeout/reuse conditions.
- Whether the login state survives a browser profile restart.
- Whether every collector start needs an approval on the held account with login approval turned on.
- Extra authentication for bank points when d-linked.

Anonymous `AWSALB`/`AWSALBCORS` (seven days), `JSESSIONID` (no persistent expiry) do not establish
authenticated lifetime; cookie expiry alone does not prove validity.

## Akamai / anti-bot

### Established facts

- `www.netbk.co.jp`/`help.netbk.co.jp` DNS to `*.akamaiedge.net`.
- Anonymous HEAD/GET on 2026-08-26: `AKAMAI: <edge IP>`.
- `Server: Apache`, load-balancer `AWSALB`/`AWSALBCORS`.
- Ordinary and `HeadlessChrome` UAs both anonymous login GET 200, no CAPTCHA/Access Denied.
- No anonymous `_abck`, `bm_sz`, `ak_bmsc` observed.

**Use of Akamai edge/CDN is established**. However, Akamai Bot Manager, Account Protector, and additional login-POST-only rules are unconfirmed. Successful public GETs do not prove authentication automation works. Login testing belongs in a separate PR, at low frequency with human assistance and explicit success criteria.

## Android APK and static analysis

The official Android app is listed on Google Play as `jp.co.netbk`, updated 2026-07-24, with over 1 million downloads. The officially supported OS is Android 8.0 or later. The bank directs users to Google Play; no standalone APK download was found on the official site.

- [Google Play](https://play.google.com/store/apps/details?id=jp.co.netbk&hl=ja)
- [Official installation](https://www.netbk.co.jp/contents/lineup/sp-app/netbk/install.html)
- [Supported OS](https://www.netbk.co.jp/contents/lineup/sp-app/os-version.html)

Static analysis useful for:

- API hosts/paths/JSON-Protocol Buffer/app User-Agent.
- FIDO/Smart Authentication NEO/device keys/pinning/Play Integrity-modification detection.
- Shared Web APIs versus app-specific balances/statements.
- App-only points/foreign screens/endpoints/retention.

The public Web bundle already establishes internal APIs, and balance/CSV implementation references exist. APK analysis is therefore phase 2. Obtain split APKs from the user's device or legitimate Play distribution and record signing certificates and hashes. Do not use third-party APK mirrors as trusted sources. Do not clone device bindings or bypass authentication.

## Third-party client code review

| Implementation                                                                                                                                   | Updates/method                            | Bank support                                                                                              | Kogane assessment                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`hirano00o/acctf`](https://github.com/hirano00o/acctf/tree/b79008d1b4ceed8eece5a24f61481a2e72216998)                                            | 2026-05, Python/Playwright                | Official login/DOM balances, primary-Hybrid-purpose history official CSV, since January 1 seven years ago | Strongest reference; `os.remove` CSV/temp dirs after reading, cannot adopt unchanged for raw evidence |
| [`t-bucchi/accagg`](https://github.com/t-bucchi/accagg/blob/3bb5786a84387795ffaa1bdd4f0ab7d22bb72708/accagg/bank/sbinetbank.py)                  | Last 2020, Selenium Firefox/BeautifulSoup | Ordinary including purpose/time DOM pagination                                                            | Models/navigation reference; old-name title/old APIs-selectors, not executable reuse                  |
| [`shinichy/get_statement`](https://github.com/shinichy/get_statement/blob/6f9730162d72eb9d14fa950767fdbcc8836676c1/get_statement.py)             | Last 2018, Selenium Chrome                | `get_sbi_history` old NBGate/fixed CSV                                                                    | Historical endpoints-selectors, no parsing/raw retention/reuse                                        |
| [`azuki774/myscrapers`](https://github.com/azuki774/myscrapers/tree/e58339122eef9273fb2566f0a867057d3219b2f6)                                    | 2026-08                                   | `sbi` is securities, Money Forward aggregator                                                             | Reject for bank, do not confuse names                                                                 |
| [`kuroro-31/stock-ai-api`](https://github.com/kuroro-31/stock-ai-api/blob/661c60d4669f253e855e150c46ab3d2659f8b30c/components/sbi/bank/login.py) | 2023, Selenium                            | Login helper only, no balances/history                                                                    | Little added value                                                                                    |

Within the GitHub code search of Python implementations referencing `www.netbk.co.jp`, no other current HTTP-only bank client was found. `acctf` operates official screens in a browser and downloads CSVs without directly calling internal APIs. This fits the policy of using official sites directly as data sources.

## Recommended implementation

### Phase 1: official Web + CSV

1. Local visible Playwright persistent profile login.
2. User handles NEO approval if required; Kogane does not automate approval.
3. Save authenticated balances, normalize primary/purpose/Hybrid/yen-foreign.
4. Switch accounts/currencies, split earliest available through today into CSV periods.
5. Save raw bytes/retrieval times/screens/account types/currencies/start-end dates/hashes.
6. Normalize official CSV events, do not delete CSV.
7. Gradually add yen-foreign time/structured/points as separate endpoint-screen collectors.

Allowlist all provider operations to read screens and prohibit navigation to transfers, account transfers, cancellations, settings, or d ACCOUNT linking. Record and reject URLs/control IDs and HTTP methods as well as button names.

### Phase 2: restricted internal API use

Trace normal Playwright read operations to identify same-site APIs used for balance and statement display. Promote a display API to a collector only if same-origin `fetch` in the session reproduces the results and raw responses have at least CSV granularity. Do not reimplement login/authentication APIs, bypass FIDO, or use mutation APIs.

### Failure rules

- Stop 401/403/login return/Akamai challenges/awaiting approval.
- No automated password retry.
- Do not discard sessions/already collected raw evidence.
- No automatic workarounds beyond shortening retrieval periods.

## Runtime suitability

| Platform                            | Suitability         | Assessment                                                                                           |
| ----------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| Local Windows/macOS visible browser | Best initial        | Easy real-device NEO/manual intervention; establish reproducibility                                  |
| OCI / Kubernetes CronJob            | Good phase 2 onward | Full Chromium/persistent volumes/fixed NAT/encrypted profiles/CSV; approval/cloud Akamai need checks |
| Cloudflare Containers               | Conditional         | Full Linux/browser better than Workers, still need Akamai/profiles/phone approval/download checks    |
| Cloudflare Browser Run              | PoC                 | CDP/Playwright/manual possible, short sessions unsuitable long-lived issuer                          |
| Ordinary Workers `fetch()`          | Unsuitable          | Initial login/SPA/FIDO-approval/download difficult; restricted consumer only after replay proof      |

Cloudflare Browser Run supports CDP/Playwright with a session keep-alive of 60–600 seconds. This can cover one collection but is insufficient for long-term storage of an authenticated browser profile.

- [Browser Run CDP](https://developers.cloudflare.com/browser-run/cdp/)
- [Playwright](https://developers.cloudflare.com/browser-run/cdp/playwright/)
- [Wrangler sessions](https://developers.cloudflare.com/browser-run/reference/wrangler-commands/)
- [Containers](https://developers.cloudflare.com/containers/)

The recommended order is local visible browser → OCI/k8s short-lived consumer → Cloudflare Container/Browser Run comparison. As in Kogane's existing authenticated-collector design, session issuers and read-only consumers could be separated, but adoption is not decided until session replay is confirmed for this bank.

## Next verification steps

In the next PR, perform only the following in a user-attended read-only session:

1. Ordinary official login, record approval presence/operations.
2. Immediately capture storage state/network HAR excluding secrets.
3. Check only held account/product types in balances.
4. Check primary/purpose/Hybrid/foreign selectors/retention/999 splitting.
5. One-month CSV: hashes/encoding/headers/row schemas, retain raw.
6. Restart/reuse once, no login retries on failure.
7. Bank points columns/earliest month/pagination/nearest expiry.
8. Only then compare same-origin reads/OCI-Cloudflare session imports.

Success requires agreement between raw evidence and normalized results, idempotent retrieval, and never navigating to write screens/APIs; successful login alone is insufficient.

## Unverified items

- Actual purpose/Hybrid/time-foreign-structured holdings.
- Purpose-specific time/foreign hierarchy in current balance screens.
- Structured history periods/limits/CSV.
- Bank points periods/limits/unique IDs/CSV-PDF.
- Authenticated lifetimes/profile reuse/IP-UA binding.
- Extra Akamai Bot Manager login-POST decisions.
- APK obfuscation/pinning/Play Integrity/schemas.
- Login/replay from OCI-k8s/Container/Browser Run egress.

Leave these as next-PR verification items rather than filling research gaps with guesses.

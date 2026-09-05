# Westpac Australia source research

- 調査日: 2026-08-26 (Australia/Sydney)
- 対象: **Westpac Australia (`Westpac` brand) のみ**
- 調査方法: 公式公開 Web、公式ログイン画面とhash付きJavaScriptの整形・静的解析、未認証Chrome runtime metadata、公式 app/Play配布情報とDigital Asset Links、Westpac の公開 CDR Product API、豪州政府 CDR サイト、Consumer Data Standards、公開 DNS/HTTP 応答を read-only で確認した。口座ログイン、consent、OTP 送信、取引、設定変更、個人向け帳票の取得は行っていない。

## スコープと安全境界

この文書は Westpac Australia 専用である。Westpac Group 内の別ブランド、別ブランド用 app / Online Banking / CDR endpoint を Westpac の実装として扱わない。公開 Product API の結果を利用する場合も `brand == "Westpac"` を検証し、別ブランドを取り込まない。

口座番号、Customer ID、氏名、住所、残高、取引内容、account/transaction ID、cookie、access/refresh token、password、OTP、秘密鍵、証明書を取得・記録しない。支払、振込、PayID、card control、term deposit の更新・解約、loan/card/account の変更、CDR consent の作成・変更・取消は対象外である。公開 JavaScript/APK の静的解析と、本人が通常操作する際の method/host/path/status/content-type/schema key 等の read-only metadata 観測は調査対象であるが、security control の回避は行わない。

## 結論

1. **現時点の安全な既定路線は手動 export (E / Cost 1)**。Online Banking は最大 3 年の transaction history を CSV / QBO / QIF / OFX に export でき、eligible statement は最大 7 年の PDF を取得できる。自動 collector は、利用者がローカルに保存したファイルだけを ingest するのが安全である。
2. **顧客データの公式 machine-to-machine 経路は CDR (A / Cost 5)**。ただし personal script が Customer ID/password で直接利用する API ではない。ADR accreditation、Register onboarding、conformance testing、PKI/mTLS、OAuth/OIDC consent flow が必要で、制度面が最大の障壁である。
3. **公開 Product API は A / Cost 1** で Workers に向くが、得られるのは商品参照情報だけで、口座、残高、取引は得られない。
4. **private transport の調査を CDR/export の存在を理由に先送りしない**。今回、現行の公開 login JavaScript と未認証 runtime から EAM bootstrap、匿名 session、認証 POST、anti-forgery/device telemetry、pending/posted UI model までは確認した。認証後の account/transaction route と JSON schema は未確認なので B とはせず、次の本人操作 read-only 観測へ明確に分離する。

## 1. product / account 列挙と balance / transaction 状態

### 公開 Product API で確認できる商品カテゴリ

Westpac は無認証の REST Product API を公開し、transaction/savings accounts、term deposits、credit cards、mortgages、personal loans を例示している。2026-08-26 の read-only `GET` では `x-v: 5` が受理され、Westpac brand の 64 products、3 pages を確認した。カテゴリ別 snapshot は次のとおりで、件数は将来変わり得る。

| CDR `productCategory`        | 件数 | この調査での扱い                                 |
| ---------------------------- | ---: | ------------------------------------------------ |
| `TRANS_AND_SAVINGS_ACCOUNTS` |   17 | transaction / savings                            |
| `TERM_DEPOSITS`              |    4 | term deposit                                     |
| `CRED_AND_CHRG_CARDS`        |   13 | credit / charge card                             |
| `RESIDENTIAL_MORTGAGES`      |   11 | home loan / mortgage                             |
| `PERS_LOANS`                 |    3 | personal loan                                    |
| `BUSINESS_LOANS`             |    6 | Westpac 商品だが personal collector の優先対象外 |
| `MARGIN_LOANS`               |    3 | 同上                                             |
| `OVERDRAFTS`                 |    2 | 同上                                             |
| `LEASES`                     |    2 | 同上                                             |
| `REGULATED_TRUST_ACCOUNTS`   |    3 | 同上                                             |

Public Product API: `GET https://digital-api.westpac.com.au/cds-au/v1/banking/products`。公式説明では HTTP GET、REST、CDR standards 準拠で security header 不要とされる。実測では standard pagination (`page`, `page-size`) と `x-v` version header が必要だった。[Westpac Product API](https://www.westpac.com.au/about-westpac/innovation/open-banking/product-api/) / [CDR standards](https://consumerdatastandardsaustralia.github.io/standards/)

### 認証後に見える範囲

- Online Banking Terms は、1 画面で Accounts を表示し、balance と Online Banking で利用可能な transaction details を確認できるとしている。[Online Banking Terms and Conditions](https://www.westpac.com.au/personal-banking/online-banking/support-faqs/terms-conditions/)
- account access の公式表は personal transaction、savings、term deposit、home loan、credit card を明示する。一方、insurance、trading、car finance は表示されない場合がある。[Manage account access](https://www.westpac.com.au/personal-banking/online-banking/making-the-most/manage-access/)
- Product API/CDR schema には personal loans があるが、今回、特定利用者の authenticated home に loan が列挙されることは確認していない。
- CDR `Get Accounts` は account の `accountId`, `displayName`, `nickname`, `maskedNumber`, `productCategory`, `productName` 等を返し、`TRANS_AND_SAVINGS_ACCOUNTS`, `TERM_DEPOSITS`, `CRED_AND_CHRG_CARDS`, `RESIDENTIAL_MORTGAGES`, `PERS_LOANS` 等を区別する。これらは consent 対象の customer data であり、この調査では呼び出していない。[CDR Banking APIs](https://consumerdatastandardsaustralia.github.io/standards/)

### balance と pending / posted

- Web/app の transaction search は過去の account balance も検索対象にできる。[Transaction history](https://www.westpac.com.au/personal-banking/online-banking/making-the-most/transaction-history/)
- Westpac の説明では card payment は merchant confirmation 待ちの間 `pending` となり、通常 5 business days 以内（それ以上の場合あり）に処理済みになる。pending amount は available funds から一時的に保持される。[What is a pending transaction?](https://www.westpac.com.au/faq/pt-what-is-pending-transaction/) / [How is my balance affected?](https://www.westpac.com.au/faq/pt-balance-affected/)
- credit card の pending amount は処理完了時に account balance に反映され、debit card では processing 前から account balance に反映される、と公式 FAQ は説明している。このため `current/ledger` と `available` を同一視しない。
- CDR balance schema は `currentBalance`, `availableBalance`, `creditLimit`, `amortisedLimit` 等を product に応じて返す。transaction schema は `status` (`PENDING` / posted data)、amount/currency、description/reference、execution/posting/value日時、merchant/MCC 等の粒度を持つ。collector は pending を最終取引として確定せず、後日の posted record と reconcile する。[CDR standards](https://consumerdatastandardsaustralia.github.io/standards/)

## 2. 明細粒度、期間、件数、export

| surface                                         | 期間 / 件数                                                                               | 形式・粒度                                                                                                 | 確認状況                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Online Banking / Westpac App transaction search | 最大 3 年                                                                                 | date、description、amount、debit/credit、過去 balance で検索                                               | 公式確認                                        |
| credit card current transaction view            | 過去 100 日                                                                               | card balance と card transactions                                                                          | 公式確認。全口座の 3 年 search とは別の表示制限 |
| desktop Online Banking export                   | 最大 3 年の範囲内。公開情報に 1 export あたりの件数上限なし                               | CSV / QBO / QIF / OFX。QBO/OFX は 1 account 選択時のみ                                                     | 公式確認                                        |
| Westpac App recent transaction download         | 任意の account と transaction period を選択                                               | download 可能。app 側の format 選択肢は公開説明だけでは未確認                                              | 公式確認                                        |
| eStatements                                     | eligible accounts で最大 7 年                                                             | PDF view / print / download。selected savings/transaction、mortgage、credit card 等。一部 product は非対象 | 公式確認                                        |
| Proof of Balance / Transactions Report          | transaction report は 30/90/120 days、last statement 以降、custom 最大 12 months          | PDF。氏名、住所、口座番号、current balance 等の PII を含む                                                 | 公式確認。研究 fixture にしない                 |
| CDR transactions                                | `oldest-time` 省略時の既定 window は 90 日。明示期間は consent/holder availability に依存 | JSON、default page 1 / page-size 25。date、amount、text filter、pending/posted、merchant detail 等         | 標準確認。Westpac customer call は未実施        |

公式 export 手順は desktop の `Overview > Exports and reports > Transactions` から account/date range/format を選ぶ。personal と business で手順が同じであることも公式 FAQ に記載される。[Export detailed transaction history](https://www.westpac.com.au/faq/business-how-export-detailed-transaction-history/) / [Export file types](https://www.westpac.com.au/business-banking/online-banking/support-faqs/export-files/)

CSV の column schema、encoding、timezone、pending を含むか、同一 transaction の stable key、最大 rows、閉鎖口座の export 可否は公開資料では未確認。live export を行う場合も、download 内容を Git、log、test fixture に残さない。

Statements: [Account statements and information](https://www.westpac.com.au/personal-banking/services/banking-services/account-statements-and-info/) / [eStatements](https://www.westpac.com.au/personal-banking/online-banking/making-the-most/estatements/) / [Proof of balance](https://www.westpac.com.au/personal-banking/online-banking/making-the-most/proof-of-balance/)

OFX/QIF は user-directed file export であり、Westpac が personal OFX Direct Connect の常設 endpoint を公開している証拠ではない。QBO も file format であり、QuickBooks credential delegation を意味しない。

## 3. 認証、MFA、端末、passkey、Bitwarden

### 確認できた事実

- 公開 login 画面は `Customer ID` と `Password` を要求し、`Remember customer ID` を提供する。共有端末では記憶しないよう警告する。[Westpac Online Banking login](https://banking.westpac.com.au/)
- Westpac Protect Security Code は登録済み security device に届く one-time code。SMS、Westpac App notification、SecurID token が列挙され、sign-in、new payee、international payment、limit/contact/password change 等で要求され得る。[Security Devices](https://www.westpac.com.au/security/protect-yourself-and-your-business/security-devices/)
- `Security Code via the App` は personal profile、対応 app version、push notifications、有効な SMS Code status が要件で、app 内でのみ有効化できる。
- app sign-in は Customer ID/password で初期設定し、その後 4-digit passcode、Face ID、fingerprint、password-only を選べる。biometric/passcode 情報は Westpac ではなく端末上に保存される。[Secure ways to sign into the Westpac App](https://www.westpac.com.au/personal-banking/online-banking/making-the-most/quick-signin/)
- CDR consent は ADR から Westpac に redirect され、Westpac Customer Number と Westpac Protect SMS OTP で authorise する。Online Banking password はこの CDR flow に使わず、SecurID token OTP は CDR に使えない。consent は one-time または最大 12 months で、dashboard から revoke できる。[Westpac Open Banking](https://www.westpac.com.au/about-westpac/innovation/open-banking/)
- Westpac の公開 security material は password vault/password manager の利用を一般的な password security tip として挙げる。[Westpac consumer FAQ](https://www.westpac.com.au/content/dam/public/wbc/documents/pdf/help/disaster/covid-19_consumer_faq.pdf)

### 推測と未確認を分離

- `Remember customer ID` は identifier の保存であり、trusted device や MFA bypass であるとは確認できない。
- app notification と端末内 biometric/passcode には端末状態が関与するが、private API の cryptographic device binding、attestation、certificate pinning、refresh-token binding の有無は未確認。
- Westpac の公式公開資料で WebAuthn/passkey 対応を確認できなかった。**非対応と断定せず未確認**とする。
- Bitwarden 固有の公式互換表は見つからない。通常 login の Customer ID/password autofill は技術上可能と思われるが未検証であり、OTP、app notification、device enrolment、CDR client key を Bitwarden で代替できるとはみなさない。password manager 利用は利用者自身に限定し、collector に master password や item 内容を渡さない。

## 4. CDN / WAF / Akamai / anti-bot

2026-08-26 に未認証の DNS、HTTP headers、公開 login HTML/JavaScript と runtime の request metadata を read-only で観測した。login submit、credential入力、OTP送信は行っていない。

| host                         | 観測                                                                                                        | 判定限界                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `www.westpac.com.au`         | DNS は CloudFront distribution、response は `server: CloudFront`                                            | 公開 content CDN は確認。WAF 製品は不明                           |
| `banking.westpac.com.au`     | DNS canonical name は `*.akamaiedge.net`、response に `x-aka-grn`、login handler へ redirect                | Akamai edge 利用は確認。Akamai WAF/Bot Manager の具体構成は未確認 |
| `digital-api.westpac.com.au` | CloudFront、Amazon API Gateway headers。root は 403 `MissingAuthenticationToken`; product route は GET 成功 | API front door を確認。WAF 製品は不明                             |

公開 login は `https://banking.westpac.com.au/wbc/banking/handler?TAM_OP=login` に着地し、IBM Security Verify Access/WebSEAL 系の `TAM_OP` と `PD-S-SESSION-ID` (`Secure; HttpOnly`)、load-balancer cookie を使う。ページは AppDynamics beacon、BioCatch facade (`wup-2ffe60ee.westpac.com.au/client/v3.1/web/wup`, `log-2ffe60ee.westpac.com.au/api/v1/sendLogs`)、browser/device fingerprint code をロードする。BioCatch facade は `setCustomerSessionId`, `changeContext`, `flush` と Native bridge を公開しており、単純な credential POST だけでは session/device context を再現できない。

CDN が Akamai であることだけから WAF/Bot Manager を断定しない。未認証画面で CAPTCHA は観測しなかったが、BioCatch と device fingerprint の存在は明確であり、adaptive challenge/rate limit がない証拠ではない。challenge、403/429、CAPTCHA、異常 redirect、lockout warning が現れたら観測を停止し、bypass を試みない。

## 5. 公式 app / Web の役割

- 公式 app は Android package `org.westpac.bank`、iOS app id `299111811` と公式 Web から案内される。[Westpac App](https://www.westpac.com.au/personal-banking/online-banking/mobile-app/) / [Google Play](https://play.google.com/store/apps/details?id=org.westpac.bank) / [Apple App Store](https://apps.apple.com/au/app/westpac/id299111811)
- Google Play 公開ページは developer `Westpac Banking Corporation`、更新日 2026-08-19 を表示したが、現行 `versionName`/`versionCode` は未認証 HTML から取得できなかった。レビューに現れる version 文字列は配布最新版の証拠にしない。
- `banking.westpac.com.au/.well-known/assetlinks.json` は package `org.westpac.bank` と SHA-256 signing certificate fingerprint `C7:BB:40:3D:21:49:4E:70:2D:27:C1:18:4D:91:74:1E:2E:5B:50:A5:2E:7A:9A:B3:34:B4:1A:A3:D2:D7:65:D6` を `handle_all_urls` / `get_login_creds` の委任先として公開する。これは公式 domain と signer の一次資料だが、手元 APK 自体の同一性検証を代替しない。[Digital Asset Links](https://banking.westpac.com.au/.well-known/assetlinks.json)
- Web と app は account balance、transaction history/search、statement、proof report、card/term deposit 管理を共有する。書込み機能が多いため、collector は read-only route だけを allowlist する。
- desktop Web は CSV/QBO/QIF/OFX export の format/date/account 選択が明記され、手動取得 surface として最も明確。
- app は Smart Search、biometric/passcode sign-in、Security Code notification、Digital Card、device-local features を持つ。app-only security enrolment や Digital Card は collector の対象外。
- 公開 `NativeJSInterface.min.js` は `/app/native/connect`, `/app/native/settings/signIn`, `/app/native/addressbook`, `/app/native/atmLocator` のほか payment/funds-transfer route も列挙する。これは app が native shell と Web surface を橋渡しする証拠であり、後二者を含む write route は呼ばない。
- 既存workspaceに公式 Play split artifactがなく、接続済みAndroid/ADB環境もなかったため、Play が device/account に生成する split set を第三者 mirror なしに取得できなかった。このため manifest、split別DEX、埋込host/schema、network security config、pinning/integrity library は未確認である。取得不能を RE の非目標にはせず、下記の正規取得手順を次実験にする。

## 6. third-party client の具体的 transport / auth

### First-party private Web transport（公開面で確認済み）

- `GET /wbc/banking/handler?TAM_OP=login` が login HTML と匿名 session を発行する。
- page load 後の `GET /eam/servlet/getEamInterfaceData` は `inputRestrictions`, `reference`, `operations`, `keymap` を返す。key names から、expiryを伴う `reference.token`/GUID、公開鍵map/algorithm、許可 operation と submit URI を bootstrap する構造を確認した。値は保存していない。
- login form は `POST /eam/servlet/AuthenticateHttpServlet`。入力 model は `username`, `password`, `token`, `halgm`, `brand` を持つ。POST、失敗試行、OTP開始は行っていない。
- hash付き current JS (`core` SHA-256 `0d78dd24f17888c09cfa8cbb6381cc4a4c1581382037ee969f88aa2265d2c2cf`) を Prettier で整形して調べると、`RequestVerificationToken`, `LtpaToken`, browser/device fingerprint、`/secure/banking/accounts/getsummarystartpage` がある。これらは bearer cookie replay だけの設計を支持しない。
- transaction UI は posted detail の SSO parameter に `AccountGlobalId`, `TransactionPostedDate`, `TransactionPostedId` を使い、pending detail は別 event `lwc_pending_transaction_detail_settings` で扱う。共通 load-more widget は `state`, `pageSize`, current row offset, `newResults`, `totalRecordsCount`, `moreResultsAvailable` を model 化する。ただし、これを transaction JSON endpoint の pagination schema と断定しない。
- 認証後の account/transaction host/path、HTTP method、JSON field、session renewal/expiry、pending-to-posted stable key は未確認。公開資産から確認できた UI model と、認証済み private API contract を分離する。

### Public Product API

- Transport: HTTPS REST `GET`, JSON、CDR response envelope、`x-v`、pagination。
- Auth: 公式説明では security header 不要。customer consent/credential 不要。
- Data: product reference のみ。account/balance/transaction なし。
- Public examples: Consumer Data Standards の product comparator demo や community catalog は product endpoint を列挙するが、authenticated personal banking client ではない。[CDS product comparator demo](https://github.com/ConsumerDataStandardsAustralia/product-comparator-demo) / [Australian Open Banking Data Database](https://github.com/LukePrior/Australian-Open-Banking-Data-Database)

### CDR consumer data

- Transport security: CDR Resource server への mTLS。CDR standard は mTLS を transaction security / holder-of-key に用いる一方、OAuth client authentication method として TLS client auth は使わないと規定する。
- Client authentication: ADR software product の `private_key_jwt`、署名 JWT、JWKS、one-time `jti`。Dynamic Client Registration 後の `client_id` を使う。
- Consumer authorisation: OAuth 2.0 / OIDC authorization-code based flow、PAR、PKCE (`S256`)、JARM/FAPI profile。Westpac 側では Customer Number + SMS OTP を用いる。
- Resource scopes: accounts は `bank:accounts.basic:read`、balances/accounts details は対応 account scopes、transactions は `bank:transactions:read`。access/refresh tokens、account IDs は secrets/PII として保存範囲を最小化する。[Consumer Data Standards](https://consumerdatastandardsaustralia.github.io/standards/)

公開 GitHub 検索では Westpac product catalogs/demo は確認できたが、Westpac personal Online Banking の current private transport/auth を安全に再現する maintained third-party client は確認できなかった。この不在は reverse engineering を止める理由ではないが、Customer ID/password の scripted POST や cookie replay を動作確認済みclientとして扱わない。

### File import

利用者が明示的に export した CSV/QBO/QIF/OFX/PDF をローカル collector が読む経路は third-party integration として成立する。bank feed も公式 export FAQ に記載されるが、provider、protocol、permission scope は未確認なので、本調査では aggregator 経路を初期案にしない。

## 7. CDR consumer access と accreditation

Westpac は Data Holder かつ ADR と説明しているが、第三者 collector が Westpac customer data を取得するには、その collector 側の CDR participant status が別途必要である。[Westpac Open Banking](https://www.westpac.com.au/about-westpac/innovation/open-banking/)

これは個人が Westpac Online Banking/App へ sign in する first-party access と別物である。first-party Customer ID/passwordやWeb sessionを CDR bearer tokenに交換する手段ではなく、CDR側の software product、redirect URI、PKI、consent/authorisation lifecycleを用意する必要がある。逆に、Westpac自身がADRであることも第三者personal scriptにaccreditationを継承させない。

ACCC の現行案内によれば、ADR accreditation には少なくとも以下が必要である。

- fit and proper person/organisation
- misuse/loss/unauthorised access 等から data を守る security controls
- Rules に沿う internal dispute resolution と relevant external dispute resolution scheme
- breach による consumer loss に対応する adequate insurance
- Australian address for service
- accreditation 後の Register onboarding と conformance testing

[Become an accredited data recipient](https://www.cdr.gov.au/for-providers/become-accredited-data-recipient)

技術・運用面では consent dashboard/withdrawal、consent receipt、CDR policy、data minimisation、record keeping/reporting、security controls、PKI certificate arrangements、software product registration、CTS、production endpoints/CSR/register activation が必要になる。[IT requirements](https://www.cdr.gov.au/for-providers/it-requirements-data-recipients) / [Legal obligations](https://www.cdr.gov.au/for-providers/legal-obligations-data-recipients) / [Onboarding](https://www.cdr.gov.au/for-providers/on-boarding-for-data-recipients) / [Data recipient user journey](https://www.cdr.gov.au/for-providers/data-recipient-user-journey)

費用は二層に分ける。政府の accreditation checklist は **accreditation application fee は現在ない** とする。また hosted sandbox と mock tooling は無料である。一方、第三者 assurance、security controls、insurance、AFCA/紛争処理、法務、production infrastructure、証明書/鍵運用、継続報告の実費は残り、政府資料は総額を提示しない。sponsor/CDR representative の commercial fee も契約依存で公開定価ではない。[Accreditation checklist](https://www.cdr.gov.au/sites/default/files/2024-12/CDR-accreditation-checklist-published-28-April-2023.pdf) / [Participant tooling](https://www.cdr.gov.au/for-providers/participant-tooling)

したがって「自分自身のデータだけ」という理由で accreditation を省略できるとは読めない。sponsored accreditation は unrestricted sponsor との arrangement が必要で、affiliate は data holder から直接収集できない。CDR representative は unrestricted principal との契約と同principalの責任下で参加する。いずれも通常の個人口座sign-inとは異なる。[CDR accreditation guidelines](https://www.cdr.gov.au/sites/default/files/2025-08/CDR-accreditation-guidelines-version-6-published-26-August-2025.pdf) / [CDR representatives](https://www.cdr.gov.au/sites/default/files/2024-12/CDR-representatives-fact-sheet-published-20-December-2024.pdf)

## 8. Workers / Containers / OCI / Kubernetes 適性

| runtime                | Public Product API                                                     | CDR consumer data                                                                                                                                                                                                  | Web/app automation                                                              |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Cloudflare Workers     | **適**。`fetch` + Cron Trigger で小さい stateless collector を構成可能 | **技術的候補、制度面未充足**。Workers は outbound mTLS certificate binding を提供し、JWT/WebCrypto を実装できるが、CDR certificates、DCR、callback、key rotation、conformance を Westpac/Registry と実証していない | **不適**。stateful browser/device、interactive MFA、Akamai challenge に向かない |
| Cloudflare Containers  | product API には過剰                                                   | **候補**。Linux/amd64 container と full runtime は CDR client library/PKI運用に向くが、accreditation は別問題                                                                                                      | browser を動かせても安全性・規約・MFA問題は解決しない                           |
| portable OCI container | 適だが過剰                                                             | **適性高**。crypto library、certificate store、callback server、audit/rotation を portable image に封じ込められる                                                                                                  | 技術的に可能でも本番経路として非推奨                                            |
| Kubernetes             | 小規模用途には過剰                                                     | **組織 ADR なら適**。CronJob/Deployment、secret integration、network policy、audit/rollout に向く                                                                                                                  | device-bound interactive flow には非推奨                                        |

Cloudflare Workers は現在 outbound mTLS binding と scheduled handler を公式サポートする。[Workers mTLS](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/) / [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。Cloudflare Containers は Dockerfile または supported registry image を Linux/amd64 で動かせる。[Cloudflare Containers](https://developers.cloudflare.com/containers/get-started/) / [Image management](https://developers.cloudflare.com/containers/platform-details/image-management/)。OCI image は portable image format、Kubernetes CronJob は repeating Job の標準機構である。[OCI Image Spec](https://specs.opencontainers.org/image-spec/) / [Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)

CDRで Workers を採用できるという記述は **platform capability からの推測** であり、Westpac/Registry interoperability の実証ではない。certificate/key を source、plain environment、log に置かない。

## 9. PR #5 共通 automation level / cost

この文書では PR #5 の共通定義だけを使う。

- **A** — direct documented/export API suitable for scheduled headless use
- **B** — stable read-only internal API with renewable or reusable session
- **C** — browser/app bootstrap plus headless replay is plausible
- **D** — full browser/device automation is probably required
- **E** — manual capture remains the safe default
- **Cost 1–5** — 1 は small wrapper、5 は device-bound or adversarial automation

| 経路                                     | Level | Cost | 根拠                                                                                                                      |
| ---------------------------------------- | ----- | ---: | ------------------------------------------------------------------------------------------------------------------------- |
| Public Product API                       | A     |    1 | documented unauthenticated GET。ただし商品参照のみ                                                                        |
| user-exported CSV/QBO/QIF/OFX/PDF ingest | E     |    1 | capture 自体は手動、parser は小さい wrapper                                                                               |
| accredited CDR                           | A     |    5 | documented headless API だが accreditation/PKI/consent/compliance が必要                                                  |
| authenticated private API replay         | C     |    4 | EAM bootstrap、匿名session、secure start route、pending/posted UI model は確認。認証後 read route/schema/renewal は未確認 |
| full Web automation                      | D     |    4 | interactive login/MFA/Akamai、write controls との隣接                                                                     |
| official app/device automation           | D     |    5 | biometric/passcode/push/device state、app-only enrolment、更新追従                                                        |

`B` を付けられる経路は現時点でない。公開面の private transport evidence は得たが、認証後 read API と renewable/reusable session の実証がないためである。主要 recommendation は E/Cost 1 の手動 export ingest、制度投資が正当化できる組織だけ A/Cost 5 の CDR である。ただし、この運用上の推奨は first-party transport RE の打切りを意味しない。CDRの存在は private Web/app 経路のlevel/cost評価を変えない。[kogane PR #5](https://github.com/risu729/kogane/pull/5)

## 10. read-only live verification plan / stop conditions

### 段階的 plan

1. **完了: 公開 Web static/runtime**: Product API に加え、login画面を未認証で1回ロードし、URL/hash付きJSを一時領域に取得、Prettier整形、route/token/device/pending/page modelを文字列とcall-siteで照合した。runtimeはmethod/host/path/status/content-typeだけを取得し、cookie/token/body値は出力・保存していない。
2. **次: 公式 Play split の正規取得**: 利用者所有AndroidでPlayから `org.westpac.bank` を通常install後、隔離したローカル一時領域で `adb shell pm path org.westpac.bank` により全split pathを列挙し、各pathを `adb pull` する。同時に `adb shell dumpsys package org.westpac.bank` の `versionName`/`versionCode` だけを記録する。APKに利用者データは含まれないが、pull先はGit外とする。
3. **次: APK provenance/static**: `apksigner verify --print-certs base.apk` を公式 assetlinks fingerprint と照合し、全splitのSHA-256を記録する。`apkanalyzer manifest print`/`apktool d` でmanifest、component、permission、deep link、`networkSecurityConfig`を確認し、`jadx --deobf` に全splitを同時入力する。host/path/schema候補、token storage/renewal、device binding、`CertificatePinner`/TrustManager/network config、Play Integrity/SafetyNet/App Check/root/emulator検知を検索する。見つからないことを「不存在」とせず、reflection/native libraryも別に確認する。
4. **次: 本人操作 Web read-only metadata**: 利用者がcredential/OTPを自分で入力し、観測者へ値を見せない。Overview と transaction history の表示だけで、DevTools/CDPのrequest/responseから method、host、値を除いたpath template、status、content-type、JSON key/type、pagination key、session refresh event名を抽出する。headers、cookies、query値、request/response body値、account/transaction IDは即時破棄する。pending/postedは既存行が自然に存在する場合のみそれぞれのschema key/status/linkageを比較し、取引を作ってfixtureにしない。
5. **次: 本人操作 app read-only metadata**: 通常端末で残高/履歴画面を開く間だけ、OS提供のNetwork InspectorまたはローカルVPN型metadata observerでDNS/SNI、method、host/path、status、content-typeを記録する。CA追加、pinning解除、root化、hookによるintegrity回避はしない。TLSでschemaが見えなければ、それ自体を観測障壁として記録し、static call-siteとの照合までで止める。
6. **manual export**: 利用者自身が通常UIでformat/date rangeだけを確認し、架空fixtureでparserを作る。実fileのdry runが必要ならGit外で件数/期間/重複集計のみ行い、raw row/valueを保存・表示しない。
7. **CDR**: ADR status、legal basis、Westpac registration/onboarding、certificate lifecycle が揃うまで実接続しない。揃った場合も無料sandbox/mock、最小 scopes、短い consent、read endpoints だけから始める。

### 即時停止条件

- password、OTP/Security Code、Customer ID、account/transaction ID、balance、取引明細、cookie/token、private key/certificate の入力・取得・表示を要求された
- SMS/push code の送信、security device/app notification/passkey/biometric/device enrolment が始まる
- payment、transfer、PayID、new payee、card lock/PIN/limit/digital card、term deposit renewal/withdrawal、loan/account/card/profile/contact setting に遷移した
- CDR consent の作成、延長、scope/account selection、revoke/withdraw が必要になった
- CAPTCHA、bot challenge、403/429、rate-limit、lockout、異常 redirect、利用規約/警告が現れた
- GET/read と断定できない endpoint、undocumented private endpoint、他ブランド data が混在した
- export/report に PII が含まれ、Git/log/fixture/remote storage に残る可能性がある

停止後は retry/bypass/alternate endpoint を試さず、利用者に画面の操作を返す。write API は発見目的でも呼ばない。

## 事実・推測・未確認の一覧

### 事実

- transaction search/export は最大 3 年、eligible PDF statements は最大 7 年。
- desktop export は CSV/QBO/QIF/OFX、QBO/OFX は single-account。
- CDR Product API は公開 GET、customer CDR は accredited ecosystem の OAuth/OIDC + mTLS + `private_key_jwt`。
- normal login は Customer ID/password、Security Code が追加要求される場合がある。
- app biometric/passcode は端末内保存。
- public content は CloudFront、login host は Akamai edge、digital API は CloudFront/API Gateway を観測。
- public login は EAM config GET と authentication POST を分離し、匿名session、bootstrap token/keymap、anti-forgery、device/BioCatch contextを持つ。
- current public JS は posted detail identifierとpending専用UI event、およびstate/page-size/offset型load-more modelを別々に持つ。
- official domainのassetlinksはAndroid packageとsigning certificate fingerprintを公開している。
- CDR accreditation application fee は現在なく、sandbox/toolingも無料だが、assurance/insurance/compliance/infrastructure等の総費用は別途必要である。

### 推測

- Workers で CDR protocol primitives は構成可能。ただし Westpac/Registry との production compatibility は実証していない。
- Bitwarden autofill は通常 login で動作する可能性があるが、公式互換性/ポリシー/実動作は未確認。

### 未確認

- authenticated account/product の実際の列挙、loan の表示範囲、closed/dormant account の扱い
- CSV column schema/encoding/timezone、export row limit、pending の export 有無、stable transaction ID
- 認証後Webのaccount/transaction host/path/schema、transaction固有pagination、session TTL/renewal、pending-to-posted stable key
- official Play splitの現行version、APK signer実測、manifest、app API host/schema、device binding/attestation/certificate pinning/integrity実装
- passkey/WebAuthn、Bitwarden 固有互換性
- login/CDR host の具体的 WAF/Bot Manager policy と challenge trigger
- app recent transaction download の format、bank feed provider/protocol
- Westpac と chosen ADR/sponsored model の onboarding/contract/cost

## 主要一次情報

- [Westpac Online Banking](https://www.westpac.com.au/personal-banking/online-banking/)
- [Online Banking Terms and Conditions](https://www.westpac.com.au/personal-banking/online-banking/support-faqs/terms-conditions/)
- [Transaction history](https://www.westpac.com.au/personal-banking/online-banking/making-the-most/transaction-history/)
- [Westpac App](https://www.westpac.com.au/personal-banking/online-banking/mobile-app/)
- [Google Play: Westpac](https://play.google.com/store/apps/details?id=org.westpac.bank)
- [Westpac Digital Asset Links](https://banking.westpac.com.au/.well-known/assetlinks.json)
- [Westpac current public core JavaScript](https://banking.westpac.com.au/wbc/banking/scripts/desktop/core/0001combined.js.2c0b10581aa4d83fdd40ef304ba8c872d9491ae4.js)
- [Westpac BioCatch facade](https://www.ui.westpac.com.au/cdnasset/biocatch/wp-fns-facade.min.js)
- [Westpac NativeJS bridge](https://www.ui.westpac.com.au/cdnasset/nativebridge/NativeJSInterface.min.js)
- [Security Devices](https://www.westpac.com.au/security/protect-yourself-and-your-business/security-devices/)
- [Westpac Open Banking](https://www.westpac.com.au/about-westpac/innovation/open-banking/)
- [Westpac Product API](https://www.westpac.com.au/about-westpac/innovation/open-banking/product-api/)
- [Consumer Data Standards](https://consumerdatastandardsaustralia.github.io/standards/)
- [Consumer Data Right provider guidance](https://www.cdr.gov.au/for-providers)
- [CDR accreditation checklist](https://www.cdr.gov.au/sites/default/files/2024-12/CDR-accreditation-checklist-published-28-April-2023.pdf)
- [CDR participant tooling](https://www.cdr.gov.au/for-providers/participant-tooling)

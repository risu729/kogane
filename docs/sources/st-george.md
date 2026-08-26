# St.George Bank Australia source research

調査日: 2026-08-26 (Australia/Sydney)

## 結論

St.George Bank の個人口座は **app-only ではない**。公式 Internet Banking と
St.George App の双方で、口座残高、取引履歴、カード、ローン、eStatement、
残高証明・取引一覧 PDF を扱える。App 固有なのは Quick Balance、Spend
Tracker、push 通知、Digital Card、Security Wellbeing Check などであり、残高・
明細収集そのものに Android 実機は必須ではない。

共通 rubric による個人データ収集の主評価は **C / cost 4** とする。2026 年の公開
第三者実装が、利用者がログイン済みの Chrome に CDP で接続して口座カードと残高
DOM を読むところまで実証している。古い Puppeteer 実装には Internet Banking の
日付範囲検索から CSV をダウンロードする具体的実装もある。さらに今回、現行公開
login JavaScript を静的に整形し、dynamic form state、credential 文字置換、device
print、remote-access probe、BioCatch の行動 telemetry/session start・resume・reset を
確認した。ただし、認証後 read route の pagination、banking session renewal、安定 API
は未確認で、adaptive authentication と Akamai 配下の login edge がある。従って B
とはしない。

安全な運用の初期値は、利用者が公式画面から取得した PDF を取り込む **E / cost 1**
である。公開 Product API は **A / cost 1** だが商品情報だけで、個人の残高や明細は
返さない。個人データの CDR API はプロトコルとして **A / cost 5** だが、ACCC の
accreditation/sponsorship、CDR Register onboarding、証明書、conformance、継続的な
security/privacy 運用が必要であり、小規模な自家用 collector の近道ではない。

## 対象と境界

- この文書の対象は **St.George Bank Australia** (`stgeorge.com.au`、公式 Android
  package `org.stgeorge.bank`) だけである。
- St.George は法的には Westpac Banking Corporation の division だが、Westpac
  ブランド本体、BankSA、Bank of Melbourne、RAMS の画面/API/アプリの挙動を
  St.George の根拠として流用しない。
- St.George の Product API ページ本文には「Bank of Melbourne currently offers」
  というテンプレート由来と見られる不整合がある。ここでは St.George の公式ページ、
  `digital-api.stgeorge.com.au`、CDR Register の brand entry、レスポンス中の
  `brand: St. George Bank` を根拠にし、その一文から姉妹ブランドの機能を推定しない。
- Business Banking Online、PayWay、PaymentsPlus、merchant API は別製品である。
  それらの CSV/report/API 機能を個人 Internet Banking の能力に数えない。
- 調査と将来検証は read-only に限る。Customer Access Number (CAN)、security
  number、password、OTP、cookie/token、口座番号、氏名・住所、残高、取引内容を
  取得・保存・ログ出力しない。送金、支払、振替、カード操作、口座設定変更、CDR
  consent の作成・変更・取消は行わない。
- Reverse engineering、公開 JS の整形/deobfuscation、正規 Play split の static analysis、
  本人操作下の read-only runtime metadata tracing は調査対象である。禁止するのは
  write endpoint、秘密/PII/body の保存、certificate pinning 無効化、root/emulator/integrity
  concealment、attestation spoof、repack/re-sign 等の security-control bypass である。

## 公式画面で確認できる対象

| 対象 | 公式に確認できる範囲 | 注意点 |
| --- | --- | --- |
| Transaction / savings | dashboard の残高、recent transactions、transaction history、eStatement、残高証明・取引一覧 | proof PDF は氏名・住所・口座番号・残高を含むため、そのままログへ入れない |
| Debit / credit cards | 残高・明細、pending/confirmed card transaction、credit card eStatement | pending authorisation は確定明細ではない。Digital Card と dynamic CVV は App 固有で収集対象外 |
| Home loans | App の Details / Internet Banking の Account details で rate、term、repayment frequency、balance、Available funds、eStatement | joint/offset 等では eStatement 対象外の場合がある。closed loan statement は online 閲覧不可 |
| Personal loans | App の loan account Details、personal-loan eStatement | 公開説明だけでは web/app の全フィールド粒度は不明 |
| Term deposits | Internet Banking/App で口座を選び、満期通知・更新/払戻指図を管理 | 残高表示の存在は portfolio の一般説明と「select your Term Deposit」から有力だが、個人画面の項目名は live 未確認。満期指図は write なので操作禁止 |
| Product reference data | 公開 CDR Product API に transaction/savings、term deposits、credit cards に加え、実レスポンスでは residential mortgages、personal/business loans 等 | 顧客保有口座、残高、明細ではない |

[Internet Banking](https://www.stgeorge.com.au/online-services/internet-banking) は
balance、recent transactions、transaction history を web/app 共通機能として説明する。
[Mobile Banking](https://www.stgeorge.com.au/online-services/mobile-banking) は App-only
機能を明示しており、基本的な残高・明細は app-only ではない。
[Home loan management](https://www.stgeorge.com.au/personal/home-loans/manage) と
[Term Deposit management](https://www.stgeorge.com.au/personal/bank-accounts/term-deposits/manage-online)
も各口座が web/app に現れることを確認できる。

### Pending と posted の区別

[Pending transactions FAQ](https://www.stgeorge.com.au/online-services/internet-banking/faqs/pending-transactions)
によると、credit/debit card purchase は authorisation 時点で available funds から差し
引かれ、最長 7 日 pending として表示された後、merchant settlement により fully
processed になる。[Look Who's Charging](https://www.stgeorge.com.au/online-services/mobile-banking/look-whos-charging)
は App で confirmed と pending の双方について merchant name、logo、address、phone、
website、map location を表示できる。したがって collector は pending と posted を
同一取引として早期に deduplicate せず、少なくとも `status` と安定した transaction ID
の有無を保持して reconciliation する必要がある。

CDR の transaction schema も `PENDING` / `POSTED` を表現する。`transactionId`、
`isDetailAvailable`、type、description、posting/value/execution time、amount/currency、reference、
merchant name/category 等を持ち、posted では `postingDateTime` が必須である。standard 自体が
pending と後続 posted を相関できる保証はないと明記するため、ID の一致を仮定しない。
response は `links` (self/first/prev/next/last) と `meta.totalRecords` / `totalPages` を持ち、
request の `page` / `page-size` で pagination する。ただし St.George の authenticated CDR
response と、Internet Banking/App の内部 schema は未検証である。

## 明細期間、件数、export

| 経路 | 期間・件数 | 形式 | 確度 |
| --- | --- | --- | --- |
| Internet Banking transaction history | `Last 7 days`、`Last 30 days`、`All`、任意 date range。statement cycle が monthly の場合は最後の statement から 3 か月、quarterly/6-month/yearly の場合は 2 statements 分までが FAQ 上の transaction-history window。1 回に最大 500 transactions、表示件数は 25–500/page | 画面。CSV は公式個人向け説明では未発見 | 期間・500件は公式。CSV は第三者実装のみ |
| App transaction search | date range、description、amount range、debit/credit | 画面 | 公式 |
| Proof of Balance | 現在時点、複数 account 選択可 | St.George letterhead PDF | 公式 |
| Transaction Listing | 30 / 90 / 120 days または custom date range | St.George letterhead PDF | 公式 |
| eStatement | 多くの transaction/savings、credit card、sole home/personal loan。過去 7 年内が online に見つからない場合は archive の可能性。statement frequency は原則 semiannual、要望で monthly/quarterly/semiannual/yearly、loan は 6-month、credit card は monthly 固定 | save/print 可能な statement PDF | 公式 |
| Previous/interim statement request | 1 request 最大 14 statements。7 年全体を 1 document にはできない。interim は前回 statement から request 日まで、通常 next business day。credit card は interim 不可 | eStatement または郵送 | 公式だが request/Confirm は state change のため自動検証禁止 |
| CDR transactions | `oldest-time` / `newest-time`; 省略時は最新日から 90 日。2025-03-04 以後、過去 2 年以内は required consumer data、2 年超 7 年未満は voluntary consumer data | paginated JSON | CDR 標準/現行 ACCC guide。St.George が voluntary range を返すかは未確認 |

[Viewing transactions](https://www.stgeorge.com.au/online-services/internet-banking/view-transactions)、
[Proof of balance / transaction listing](https://www.stgeorge.com.au/online-services/internet-banking/proof-of-balance)、
[Managing accounts FAQ](https://www.stgeorge.com.au/online-services/internet-banking/faqs/managing-accounts-faqs)、
[Internet Banking customisation FAQ](https://www.stgeorge.com.au/online-services/internet-banking/faqs/customisation-faqs)
を根拠とする。

### CSV / OFX / QIF / PDF の結論

- **PDF**: 個人向け公式根拠あり。Proof of Balance、Transaction Listing、eStatement。current
  Play description は App の Services から Proof of Balance、Interest Earned、Transaction Listing
  report を download できると明示する。Internet Banking/App のどちらで各 PDF が取得可能かは
  公式 help ごとに分離し、App の記載だけから Web の同一 coverage を推定しない。
- **CSV**: 現行の公式個人向け help では発見できなかった。ただし 2022 年の公開
  Puppeteer 実装が `#transHistExport` をクリックし、`Date`, `Debit`, `Credit`,
  `Description` 列を parse している。2012 年の Mechanize 実装も
  `exportFileFormat=CSV` を送る。従って web UI に CSV が存在した実装証拠は強いが、
  2026 年時点の現行保証には live read-only 確認が必要である。
- **OFX / QIF**: St.George 個人 Internet Banking の現行公式資料・確認した公開実装の
  どちらにも根拠がない。未対応と断定せず「未確認」とする。
- **CDR JSON**: accredited/sponsored data recipient 向けの structured account/transaction data。
  PDF/CSV/OFX/QIF export ではなく、consumer が download button から直接得る形式でもない。
- Business Banking Online の configurable export、PayWay/PaymentsPlus の CSV は
  別製品なので上記判定に含めない。

## 認証、MFA、device、passkey、Bitwarden

### 確認できた事実

1. Internet/Mobile Banking の登録には card または account number、date of birth、
   登録 phone が必要で、利用者は security number と password を作り CAN を受け取る。
   公式手順は [registration](https://www.stgeorge.com.au/online-services/get-started) にある。
2. 公開 login form と St.George 固有の第三者実装はいずれも CAN/access number、
   security number、Internet password の 3 要素を通常 login に使う。
3. [Secure Code](https://www.stgeorge.com.au/online-services/security-centre/protect-yourself/securecode)
   は登録 mobile number へ SMS OTP を送り、**certain types** of Internet/Mobile
   Banking transactions、payee 作成、設定変更等を認証する。全 login で常に OTP が
   必須とは公式に書かれていない。
4. St.George Secure は adaptive authentication と行動/不審 activity detection を
   用いる。公式 security article は unexpected location の login/transaction で追加の
   Secure Code を求める場合があるとしている。
5. App Quick logon は Face ID、fingerprint、4-digit security number、password。
   初回 setup では bank details を入力する。iOS 15+、Android 10+ 等の制約があり、
   Google Play listing は rooted device では fingerprint quick logon が使えず、機能の
   一部が動かない可能性を記す。
6. CDR authorisation は ADR の consent portal から St.George へ redirect され、CAN と
   Secure Code OTP で本人確認する。CDR access token を個人向けに直接発行する画面ではない。
7. St.George の [data/device security article](https://www.stgeorge.com.au/online-services/security-centre/articles/are-your-data-and-devices-safe)
   は password manager を使う場合も sensitive banking details を保存しないよう助言する。

### 推測と未確認を分ける

- **device binding**: Quick logon enrollment は device-local である可能性が高いが、
  server-side token の device binding、同時登録台数、device attestation の具体方式は
  公開資料から確認できない。生体情報は OS の biometric gate と見るのが自然だが、
  biometric template の保存場所や app token の暗号方式は推測しない。
- **passkey**: St.George が FIDO2/WebAuthn passkey login を提供する公式根拠は見つからない。
  Face ID/fingerprint quick logon を passkey と呼ばない。
- **Bitwarden**: 公式は Bitwarden を名指しで support/deny していない。browser autofill
  の相性も未確認である。一般的な password-manager 助言から「Bitwarden に CAN、security
  number、password を一括保存してよい」とは結論しない。
- **session reuse**: 現行公開実装は既ログイン Chrome session を再利用できることを示すが、
  cookie lifetime、refresh、IP/device binding は不明。cookie/token を collector の
  renewable credential とみなせないため Level B ではない。

### 現行 Web login transport の静的確認

2026-08-26 に [公式 Internet Banking login](https://ibanking.stgeorge.com.au/ibank/loginPage.action)
と、そこから公開ロードされる JavaScript を credential なしで取得した。bundle は
Prettier で静的整形し、未知コードを `eval`/実行していない。動的な値は記録していない。

- login は `POST logonActionSimple.action`。通常の `userId` (CAN/card)、`securityNumber`、
  `password` に加え、`nameId`、`bmNameId`、`bmSessionId`、`statperfid`、`devicePrint`、
  `radRes` 等の hidden field を送る。これらの値を固定値や再利用可能 token とみなさない。
- `logonCrypto.js` は page ごとの AES key で security-number/password 用の置換表を復号し、
  入力文字を置換してから submit する。これは client-side credential obfuscation の実装で
  あって、banking access token や transport encryption の代替ではない。
- `rsa.min.js` の `encode_deviceprint()` が `devicePrint` を生成する。`rdagent.js` は page
  supplied の localhost WebSocket port 群を probe して結果を `radRes` に入れる。後者は
  remote-access software の存在候補を測る anti-fraud signal と整合するが、判定 rule は不明。
- 約 1 MB の `BM_v2_43.js` (public asset version `26E3MR36`) は整形後の class/function 名に
  `BioCatchClient` を含む。`cdApi.setCustomerSessionId(...)` と context `LOGIN_PAGE` を使い、
  internal state として `sid`/customer-session/partner-session/`muid`、server state
  `sts`/`std`/`ott`、request counter を扱う。`startNewSession`、`resumeSession`、
  `ResetSession`、context change、local/session storage (`bmuid`, `cdSrvrState` 等)、
  VM detection、mouse/touch/key telemetry、`/client/v3.1/web/wup` / `/api/v4/wup` path を持つ。
  これは fraud telemetry session であり、口座 read session/token と同一とは証明されない。
- login GET は `LastLoginCookie`、`JSESSIONID`、`PD-S-SESSION-ID` 等を発行する。観測時、
  `LastLoginCookie` は Secure/HttpOnly/SameSite=Strict、`PD-S-SESSION-ID` は Secure/HttpOnly、
  `JSESSIONID` は HttpOnly だった。値は保存していない。未認証で
  `viewAccountPortfolio.html` / `accountDetails.action` を GET すると HTTP 200 の logout
  page が返るため、status code だけで authenticated session を判定できない。

公開 login asset から確定できるのは認証 bootstrap までである。portfolio/transaction の
current route、HTML/JSON transport、banking token、idle/absolute expiry、renewal、pagination、
pending/posted field は認証後 runtime metadata なしでは確定できない。pending/posted の下記
model は公式 UI 説明と CDR standard のもので、Internet Banking internal schema と混同しない。

## 公開 edge、WAF、anti-bot

2026-08-26 に、credential を送らない DNS/HTTP read-only probe を実施した。

| host | 観測 | 結論できること / できないこと |
| --- | --- | --- |
| `www.stgeorge.com.au` | CNAME は `*.cloudfront.net`。response に `via: ...cloudfront.net`、`x-cache`、`x-amz-cf-*` | AWS CloudFront edge。WAF 有無・rule は header だけでは不明 |
| `ibanking.stgeorge.com.au` | CNAME は `*.edgekey.net`。response に `akamai-grn` と `server-timing: ak_p`。未認証 GET/HEAD で `JSESSIONID` と `PD-S-SESSION-ID` cookie 名 | Akamai edge を利用。cookie 値は記録しない。Akamai Bot Manager/WAF の具体製品・policy は未確認 |
| `digital-api.stgeorge.com.au` | CNAME は CloudFront。response に `x-amz-apigw-id` / `x-amzn-requestid`; correct `x-v` 付き Product API と discovery status は 200 | CloudFront + AWS API Gateway。public API の version/header validation はあるが、customer API の gateway/auth topology 全体は未確認 |

公開 Product API への通常 GET と login page の未認証取得では CAPTCHA は観測しなかった。
これは authenticated login automation に challenge がないことを意味しない。公式の adaptive
authentication は location/behaviour に応じた追加確認を示すため、固定 cloud egress からの
headless login を繰り返す設計は避ける。403、429、CAPTCHA、Secure Code、unusual activity
prompt を回避・自動突破しない。

## 公式 mobile app artifact / transport

### Play provenance と current metadata

[St.George 公式 mobile page](https://www.stgeorge.com.au/online-services/mobile-banking) の
Play 導線は package [`org.stgeorge.bank`](https://play.google.com/store/apps/details?id=org.stgeorge.bank&hl=en_AU&gl=AU)
へ直接遷移する。2026-08-26 に公式 Play response から確認した current metadata は title
`St.George Mobile Banking`、developer `St.George Bank`、version **9.52**、updated
**2026-07-07** である。public metadata では versionCode と signer は得られない。

同じ Play metadata では [BankSA `org.banksa.bank`](https://play.google.com/store/apps/details?id=org.banksa.bank&hl=en_AU&gl=AU)
と [Bank of Melbourne `org.bom.bank`](https://play.google.com/store/apps/details?id=org.bom.bank&hl=en_AU&gl=AU) も
9.52 で同日に更新され、公開 Web login の `logonSimple.js?ver=26E3MR36` も三ブランドで
SHA-256 が一致した。これは St.George division brands に共通 release/code line がある強い
証拠だが、authenticated host/schema/session が全て同一である証拠ではない。対して Westpac
本体は別 [package `org.westpac.bank`](https://play.google.com/store/apps/details?id=org.westpac.bank&hl=en_AU&gl=AU)、別 Play release 表示で、
[公式 Web](https://banking.westpac.com.au/) も `banking.westpac.com.au/wbc/banking/...` の
Customer ID/password login である。St.George の
3-field login、`ibanking.stgeorge.com.au/ibank/...` route を Westpac 本体へ、または逆に移植しない。

### 正規 split の取得障壁と再現手順

St.George は standalone APK を公式配布せず、consumer Play delivery は登録済み Android
device/account 向けの app bundle/split である。今回の Windows/WSL 環境には Android SDK/
`adb`、`apkanalyzer`/`aapt2`/`apksigner`、`jadx`/`apktool`、接続済み本人端末がなく、正規
base/split を取得できなかった。このため current 9.52 の signer、versionCode、manifest、
permissions/exported components、host/schema、network config、device binding、pinning、
integrity/attestation は未確定である。third-party APK mirror を current official artifact と
して採用しない。

再現可能な取得・検証手順:

1. 本人所有の対応・非 root Android で公式 St.George page の Play link から 9.52 を
   install/update する。Quick Logon 登録済み端末では app data clear/reinstall/device migration
   を行わない。
2. 本人同意下で USB debugging を一時的に有効化し、`adb shell dumpsys package
   org.stgeorge.bank` から versionName/versionCode、installer、split 名のみを採る。
   `adb shell pm path org.stgeorge.bank` が通常権限で返す全 base/split を private work area
   へ pull する。
3. 全 split の SHA-256 と `apksigner verify --print-certs` の signer digest を確認する。
   binary、certificate、device serial/account metadata は Git/CI に入れない。
4. pull が拒否される、app が停止する、Quick Logon/device re-registration を求める時点で
   停止する。root、backup exploit、repack/re-sign、mirror 代替、検知回避を行わない。

### 取得後の static / runtime 観測

- Manifest の permission、exported component/deep link、backup、`debuggable`/`profileable`、
  network security config、FileProvider、biometric/Keystore、native library を確認する。
- OkHttp/Retrofit/WebView/Custom Tabs 等の transport、host/path template、JSON/protobuf schema、
  session issuance/renewal、pagination/cursor、pending/posted model、token storage、account namespace
  を文字列/call graph から抽出する。実 token/body は扱わない。
- Quick Balance/Quick Logon の device registration token、BiometricPrompt/Keystore gate、push
  registration、Play Integrity/root/debug/emulator/pinning library の **候補** を切り分ける。
- Proof of Balance、Interest Earned、Transaction Listing の renderer/download/share route と
  MIME/schema を確認し、write service/payment/card functions と call graph で分離する。
- 本人の既存登録済み公式 app で account list、balance、transaction search、pending/posted、
  report control の表示だけを操作する。通常 attach 可能な Android Studio Network Inspector、
  standard proxy/PCAP/logcat、または unmodified app が通常動作する範囲の Frida/Objection で、
  method/origin/path template/status/content-type/call order/field 名だけを即時 redaction する。
  body、header/cookie/token、account ID、値、screenshot、DB content は保存しない。

pinning、root/debug/integrity detection、追加認証、device registration、app 停止が出た時点で
停止する。CA install、pinning disable、root hiding、attestation spoof、repack/re-sign をしない。
read/write side effect が分類できるまで replay せず、write endpoint は分類後も呼ばない。

参考となる公開第三者 artifact は限定的である。[Tabbed Out analysis result](https://github.com/beerphilipp/tabbed-out/blob/3ada3bb1fc317cdf9a442a52445614ee5a8b7cff/analysis/results/org.stgeorge.bank.res.json)
は version 不明の `SINGLE_APK` に Android Custom Tabs の利用文字列を確認し、
[GrapheneOS report #570](https://github.com/PrivSec-dev/banking-apps-compat-report/issues/570)
は Play 版 9.44/build 2025010700 が通常動作したと報告する。いずれも current 9.52 の
host、signer、pinning/integrity、banking schema の証拠にはしない。

## 公式 CDR / Open Banking

### 公開 Product API

[St.George Product API](https://www.stgeorge.com.au/online-services/open-banking/product-api)
の base は `https://digital-api.stgeorge.com.au/cds-au/v1/banking/products/`。REST GET、
JSON、Australian Consumer Data Standards 準拠で、security/特別な auth header は不要である。
ただし `x-v` version header は endpoint ごとの version negotiation に必要で、2026-08-26 の
read-only GET は Products が `x-v: 5` で 42 records、Discovery Status が `x-v: 1` で
`OK` を返した。Products の page count は requested `page-size` に依存し、この数は時点値で
固定しない。

政府 CDR Register の St.George Bank brand entry は public/product base URI を
`https://digital-api.stgeorge.com.au` とする。2026-08-26 の Register v2 read-only GET では
brand entry の `lastUpdated` は `2026-08-03T01:12:10Z` だった。公式 DSB product comparator も Register から
base URI を取得し、browser `fetch` の GET に `Accept: application/json`, `x-v`, `x-min-v`
を付け、`/banking/products/{productId}` へ進む。これは customer data transport ではない。

### Customer data の対象と API

[St.George Open Banking](https://www.stgeorge.com.au/online-services/open-banking) と
[St.George error mapping](https://www.stgeorge.com.au/online-services/open-banking/error-mapping)
から、少なくとも accounts、account detail、bulk/specific/account balances、transactions、
transaction detail、direct debits、scheduled payments、payees の CDR API family が確認できる。
CDR standard の covered products には transaction/savings/debit accounts、term deposits、
credit/charge cards、residential/investment home loans、personal loans 等が含まれる。ただし、
account の所有形態、online eligibility、closed status、product classification により実際に
選択できる account は異なる。

2025-03-04 以後の現行 ACCC guide では、過去 2 年以内の transaction data は required、
2 年超 7 年未満は voluntary、closed account data も voluntary である。direct debit の required
範囲は 13 か月。CDR standard の Get Transactions は `oldest-time` と `newest-time`、amount、
text、`page`/`page-size`、paginated links/meta を持ち、省略時は直近 90 日を取得する。
CDR JSON は machine-readable customer-data route であり、Internet Banking CSV や official
report PDF の代替形式ではない。St.George が voluntary な 2–7 年や
closed account を実際に返すかは live ADR test なしでは確定しない。

### Consumer と ADR の要件

- Consumer は Internet Banking 登録が必要。まず ADR の app/site で consent し、St.George
  authorization へ redirect、CAN + Secure Code OTP で本人確認し、共有 account/data を選ぶ。
- consent/authorisation は双方の dashboard で管理でき、St.George 側 Internet Banking から
  revoke できる。joint account は St.George の説明する enable/disable rule に従う。
- 一般 consumer が St.George に直接 CDR API request を出す経路は現在の CDR rules の対象外。
  accredited person が consumer の代わりに request する。
- ADR になるには ACCC accreditation（または sponsor を伴う参加経路）、fit-and-proper、
  information-security controls、internal/external dispute resolution、appropriate insurance、
  Australian address for service、CDR policy/privacy safeguards、records/reporting が必要。
  さらに CDR Register onboarding、PKI certificate agreements、Conformance Test Suite がある。
- transport は CDR Security Profile に従う OAuth 2/OIDC/FAPI family。Data Recipient は CDR
  Register の Software Statement Assertion (signed JWT) を使い Data Holder に Dynamic Client
  Registration し、`private_key_jwt` client authentication、mTLS endpoint、signed requests/
  responses と versioned CDR headers を扱う。単なる CAN/password login の replay ではない。

[CDR Data Standards](https://consumerdatastandardsaustralia.github.io/standards/)、
[ACCC accreditation](https://www.cdr.gov.au/for-providers/become-accredited-data-recipient)、
[IT requirements](https://www.cdr.gov.au/for-providers/it-requirements-data-recipients)、
[current banking data-holder compliance guide](https://www.cdr.gov.au/resources/guides/compliance-guide-data-holders-banking-and-non-bank-lenders-sectors)
を参照。既存 ADR/aggregator は合法的な初期導入候補になり得るが、この調査では公式
St.George route を先に評価し、aggregator の能力を St.George の固有能力として数えていない。

## 公開第三者実装

| 実装 | 時点 | transport / auth / 実装事実 | 評価 |
| --- | --- | --- | --- |
| [tekumara/cashgrab `stgeorge-balances.js`](https://github.com/tekumara/cashgrab/blob/main/src/stgeorge-balances.js) | St.George module の最終 commit 2026-04-05 | localhost:9222 の既存 Chrome に Puppeteer/CDP で接続。利用者が St.George Internet Banking に既にログインしている前提で `viewAccountPortfolio.html` へ移動し、`#acctSummaryList > li` から nickname、BSB、account number、current/available balance を DOM parse。口座カードがなければ login page を開いて手動 login を促す | 既ログイン browser bootstrap + read-only balance の現行に近い実証。現状コードは PII/残高を stdout に出すので、そのまま採用禁止。session renewal や transaction export はない |
| [geofflamrock/ynab-sync St.George package](https://github.com/geofflamrock/ynab-sync/tree/main/packages/st-george-au) | St.George package の最終 commit 2022-12-11、repo push 2023-03-26 | Puppeteer が `loginPage.action` で access number、security number、password を form 入力し portfolio URL を期待。account index から `accountDetails.action`、date range field、search、`#transHistExport` を操作し CSV download。CSV の `Date`, `Debit`, `Credit`, `Description` を YNAB transaction に変換 | CSV と DOM route の具体的 evidence。ただし古く、OTP/adaptive challenge 非対応、credentials を process に渡すため現行 safe design ではない |
| [yec/bankscripts `stgeorge.pl`](https://github.com/yec/bankscripts/blob/master/stgeorge.pl) | 2012-04-23 | Perl `WWW::Mechanize` で `logonForm` に userid/securityNumber/password、account detail form に `exportFileFormat=CSV` を POST | CSV export が古くから存在した歴史的 evidence のみ。URL/HTML/認証が旧式で再利用不可 |
| [CDS product comparator demo](https://github.com/ConsumerDataStandardsAustralia/product-comparator-demo/blob/master/src/store/banking/data/actions.js) | 公開 DSB demo | CDR Register から brand base URI を得て、unauthenticated browser GET に `Accept`, `x-v`, `x-min-v`、pagination と product-detail fetch | St.George Product API でも使える A/cost 1 transport。個人口座データは扱わない |

公開 GitHub code search では、上記以外に St.George 固有の現行 customer-data API client、
renewable token client、APK reverse-engineered protocol を確認できなかった。Westpac ブランド
本体用 client は対象外であり、St.George に転用可能とは扱わない。

## Runtime 適性

| runtime | Product API | CDR ADR client | Internet Banking C route | App/device route |
| --- | --- | --- | --- | --- |
| Cloudflare Workers | 最適。scheduled GET + JSON normalize が容易 | outbound mTLS certificate binding と WebCrypto/JWT は技術的には候補。ただし ADR compliance、key lifecycle、CDR data environment、audit/retention を Workers 単体で満たす設計審査が必要 | 通常 fetch だけでは不可。Browser Run は Puppeteer を提供するが、login bootstrap、session、bank PII、adaptive auth、egress reputation のため第一候補にしない | 不適 |
| Cloudflare Containers | 過剰 | `linux/amd64` image で通常の OAuth/FAPI stack を置けるが compliance は別問題 | Playwright/Puppeteer を OCI image に含められる。永続 browser profile と human bootstrap の安全な受渡しを別途設計 | APK static toolchain は置けるが Play delivery/本人端末/runtime は別 |
| Generic OCI container | 容易 | mTLS、HSM/KMS client、JWT、refresh token、監査 sidecar を組みやすい | browser version pin、stable egress、encrypted ephemeral volume を構成しやすい | jadx/apktool 等の static analysis は適合。runtime は Android 実機 bridge が必要 |
| Kubernetes | 小規模 Product API には過剰 | 最も運用自由度が高く、CronJob、Secrets/KMS、NetworkPolicy、audit/rotation を組める。ただし accreditation cost は下がらない | headful/headless pod と human handoff は可能だが、browser profile を secret と同等に扱う必要 | 実機 farm/ADB を別管理するなら可能だが cost 5 |
| Non-rooted Android real device | 不要 | 不要 | web route があるため不要 | 正規 split、Quick Logon/device binding、app read transport を検証する第一候補。root/emulator bypass はしない |

Cloudflare の現行公式資料では Workers に
[mTLS certificate binding](https://developers.cloudflare.com/workers/wrangler/configuration/#mtls-certificates)、
Browser Run に [Puppeteer sessions](https://developers.cloudflare.com/browser-run/puppeteer/)、
Containers に [linux/amd64 image](https://developers.cloudflare.com/containers/get-started/) と
[managed/external registries](https://developers.cloudflare.com/containers/platform-details/image-management/)
がある。Kubernetes は標準の [container image](https://kubernetes.io/docs/concepts/containers/images/)
を実行できる。いずれも銀行の利用規約、CDR accreditation、anti-fraud challenge を無効化しない。

## 共通 automation rubric

独自定義は使わず、PR #5 の共通定義をそのまま適用する。

- **A** — direct documented/export API suitable for scheduled headless use
- **B** — stable read-only internal API with renewable or reusable session
- **C** — browser/app bootstrap plus headless replay is plausible
- **D** — full browser/device automation is probably required
- **E** — manual capture remains the safe default
- **Cost 1–5** — 1 は small wrapper、5 は device-bound/adversarial

| route | Level | Cost | 判定理由 |
| --- | --- | ---: | --- |
| 個人 balance/transaction の本線 | **C** | **4** | 2026 public code が logged-in Chrome bootstrap + DOM read を実証し、旧 code が CSV export を実装。renewable session は未確認で、adaptive auth/Akamai/selector drift がある |
| App bootstrap 後の read-only transport replay 候補 | **C** | **4** | current split/runtime 未取得。renewable session、read endpoint、pinning/device binding を通常端末観測で確認できた場合だけ成立 |
| 公式 PDF の手動取得と ingestion | **E** | **1** | 公式で安定し安全だが、人が App/Internet Banking から取得する必要がある |
| 公開 Product API | **A** | **1** | documented unauthenticated REST GET。個人残高・明細なし |
| accredited/sponsored CDR participant | **A** | **5** | documented machine-readable API、consented scheduled retrieval に適するが accreditation、PKI/mTLS/FAPI、conformance、security/privacy obligations が重い |
| Android 実機 UI automation | **D** | **5** | biometric/quick logon/device integrity と UI drift を抱える。reverse engineering は調査対象だが、transport replay が成立しなければ full device が必要 |

## Read-only live 検証計画

### Phase 0: 公開・無認証

1. CDR Register の St.George brand entry、Product API `/products` と 1 product detail、
   `/discovery/status` を GET。status/version/pagination/schema だけ記録し、商品全件 snapshot は
   必要時だけ保存する。
2. DNS CNAME と response header の vendor-neutral facts を再確認する。高頻度 probe、path
   enumeration、login POST はしない。
3. GitHub 第三者実装の commit SHA/date と selectors を固定し、実行はしない。公開 login JS
   は hash、asset version、form field/function 名だけを静的整形し、動的値を保存しない。

### Phase 1: 利用者同席の Internet Banking

1. 利用者自身が通常 browser でログインする。collector は CAN/security number/password/
   OTP を入力・取得・保存しない。
2. DevTools protocol で request body/header を capture せず、method、origin、path template、
   status/content-type、redirect/call order、cookie **name/attribute** だけを記録する。
   `viewAccountPortfolio.html` の 200 が portfolio か logout page かを DOM marker で判定する。
3. account portfolio に transaction/savings、card、loan、term deposit の account card が
   存在するかを、値を読まずに DOM role/selector と件数だけ確認する。nickname、BSB、account
   number、balance text は screenshot/log/trace に入れない。
4. 代表 account で current/available balance の **field presence**、pending/posted label、
   date/amount/type filter、最大表示件数 selector を確認する。transaction description、merchant、
   amount、date は記録しない。page/page-size/cursor/total、pending→posted 相関 ID の field presence
   を確認し、Internet Banking が HTML fragment、JSON、form POST のどれを使うか分類する。
5. export menu に CSV が現存するか、PDF reports/eStatements の menu があるかだけ確認する。
   実ファイルは個人データを含むためこの調査では download しない。必要なら別途明示許可を得て
   encrypted temporary location で schema のみ確認し、即時消去する。
6. idle/absolute expiry と normal navigation 中の cookie/session更新は、値を比較せず cookie 名、
   attribute、発行/更新 event の有無だけ観測する。browser を閉じて session を複製せず終了する。
   reusable session を試す場合は別の明示許可、secret store、redaction、失効手順を先に用意する。

### Phase 2: 本人所有 Android

1. 前述の正規 Play split 取得、signer/manifest/static analysis を先に行う。OTP/Quick Logon の
   既存登録状態を変えない。
2. 本人が account list、balance、transaction search、pending/posted、report controls を表示し、
   method/origin/path/status/schema field 名、pagination/session refresh event だけを metadata-only
   capture する。Internet Banking と同じ host/schema か、St.George app 固有 API かを確認する。
3. report download、share、payment/transfer、card/limit/settings は実行しない。Web と app の
   read coverage 差は control/field presence だけで作る。

### Phase 3: CDR

1. Public Product API までに留める。customer-data live test は active ADR/sponsor と CTS 済み
   software product、同意 UX、CDR data environment が揃うまで開始しない。
2. 条件が揃った場合も、最小 scope (`bank:accounts.basic:read`、必要なら
   `bank:transactions:read`) と短い期間から始める。取引内容や残高を研究ログへ残さず、schema、
   pagination、status、latency、token refresh 結果だけを redacted evidence にする。

### Stop conditions

次のいずれかで即停止し、回避や再試行をしない。

- Secure Code/OTP、CAPTCHA、push approval、new-device enrollment、biometric prompt、unusual
  location/activity warning が出た。
- 401/403/429、account lock warning、session invalidation、unexpected redirect が出た。
- 操作対象が transfer/pay、payee、BPAY、scheduled payment、card activation/lock/PIN、limit、
  dispute、contact details、statement delivery preference、term-deposit maturity instruction、CDR
  consent/authorisation change/revoke に入った。
- endpoint/operation の side effect が分類できない POST/PUT/PATCH/DELETE。read-only navigation
  が POST の場合も本人画面と public implementation から副作用なしと確認できるまで replay しない。
  CDR standard の read-only bulk POST も active ADR の正式検証計画なしには送らない。
- PII、account identifier、balance、transaction、cookie/token/OTP が console、trace、HAR、
  screenshot、crash dump に入りそうになった。
- vendor challenge を stealth、fingerprint spoof、proxy rotation、root/emulator concealment、
  certificate pinning bypass で越える必要が生じた。

## 未確認事項

- 2026 年の個人 Internet Banking で CSV export が実際に残っているか、列、encoding、
  pending の含有、1 file の件数上限、credit card/loan/term deposit の対応範囲。
- OFX/QIF export の有無。公式個人向け根拠は発見できなかった。
- portfolio/search の現行 DOM selectors、session idle/absolute lifetime、cookie refresh、
  IP/device binding、Secure Code が read-only login に発火する条件。
- App 9.52 の versionCode/signer、split/manifest、host/path/schema、pagination/pending-posted model、
  Quick Logon の server-side device registration/attestation、登録台数、token storage、pinning/
  integrity、passkey/WebAuthn 対応。Bitwarden autofill の可否。
- St.George CDR が voluntary な 2–7 年、closed account、offline account、全対象 product を
  実際に返す範囲と、St.George 固有の current auth/mtls endpoint metadata。
- Akamai/CloudFront の WAF/bot-management product と具体 rule。公開 header からは断定しない。
- App 内部 transport/API は正規 split と本人端末がないため未確認。前述の `dumpsys`/`pm path`/
  全 split pull/`apksigner`/static analysis/runtime metadata tracing が次の具体的実験であり、
  reverse engineering 自体は対象である。security-control bypass は対象外である。

## 主要 source

- [St.George Internet Banking](https://www.stgeorge.com.au/online-services/internet-banking)
- [St.George Mobile Banking](https://www.stgeorge.com.au/online-services/mobile-banking)
- [Viewing transactions](https://www.stgeorge.com.au/online-services/internet-banking/view-transactions)
- [Pending transactions](https://www.stgeorge.com.au/online-services/internet-banking/faqs/pending-transactions)
- [Proof of balance and transaction listing](https://www.stgeorge.com.au/online-services/internet-banking/proof-of-balance)
- [Managing accounts FAQ](https://www.stgeorge.com.au/online-services/internet-banking/faqs/managing-accounts-faqs)
- [Quick logon](https://www.stgeorge.com.au/online-services/mobile-banking/quick-logon)
- [Secure Code](https://www.stgeorge.com.au/online-services/security-centre/protect-yourself/securecode)
- [St.George Open Banking](https://www.stgeorge.com.au/online-services/open-banking)
- [St.George Product API](https://www.stgeorge.com.au/online-services/open-banking/product-api)
- [St.George CDR error mapping](https://www.stgeorge.com.au/online-services/open-banking/error-mapping)
- [Consumer Data Standards](https://consumerdatastandardsaustralia.github.io/standards/)
- [CDR provider accreditation](https://www.cdr.gov.au/for-providers/become-accredited-data-recipient)
- [CDR IT requirements](https://www.cdr.gov.au/for-providers/it-requirements-data-recipients)
- [ACCC banking/NBL data-holder compliance guide](https://www.cdr.gov.au/resources/guides/compliance-guide-data-holders-banking-and-non-bank-lenders-sectors)
- [Google Play: `org.stgeorge.bank`](https://play.google.com/store/apps/details?id=org.stgeorge.bank)
- [Apple App Store: St.George Mobile Banking](https://apps.apple.com/au/app/st-george-mobile-banking/id294380705)
- [CDR Register: Data Holder Brands Summary API](https://api.cdr.gov.au/cdr-register/v1/banking/data-holders/brands/summary)
- [Tabbed Out: `org.stgeorge.bank` static result（第三者・version 不明）](https://github.com/beerphilipp/tabbed-out/blob/3ada3bb1fc317cdf9a442a52445614ee5a8b7cff/analysis/results/org.stgeorge.bank.res.json)
- [GrapheneOS compatibility report #570（第三者・9.44）](https://github.com/PrivSec-dev/banking-apps-compat-report/issues/570)

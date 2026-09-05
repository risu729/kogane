# Wise 個人口座の直接取得調査

調査日: 2026-08-26

## 1. 対象と結論

この記録の対象は **Wise の個人口座（personal profile）** だけである。
Wise Business、Wise Platform の契約済みパートナー、Open Banking の認可済み
AISP/TPP は、個人口座で誰でも使える経路と誤認しないための比較対象としてのみ扱う。
aggregator は初期取得経路にしない。

結論は次のとおり。

- 個人口座で現在確認できる安全な初期経路は、公式 Web/app からの明細 export。
- 現行の公式開発者資料で「Personal API Token」と呼ばれるものは
  **Wise Business 専用**であり、個人口座向けセルフサービス token ではない。
- Wise Platform の OAuth 2.0 は契約済みパートナー向けで、client ID/secret、
  Developer Hub、mTLS が必要。個人が自分の口座だけを読むための一般公開 OAuth app
  登録経路は確認できない。
- したがって安全な現在値は **自動化レベル E、実装コスト 1**
  （手動 export とローカル import）。これは personal Web/app の内部 transport 調査を
  先送りする理由ではない。公開 login JavaScript の静的解析までは実施し、認証済み
  personal read transport と公式 Play split APK は次の read-only 検証対象として残した。
- ブラウザ replay は C/D 候補、コスト 4 だが、Cloudflare の bot protection、再認証、
  passkey/2-step verification を伴うため、正確な read route と session 更新を確認するまで
  既定にしない。
- 契約により read-only OAuth または Open Banking AISP の `accounts` scope を取得できる
  組織だけは A 候補だが、これは個人口座保有者が単独で開始できる経路ではない。

残高、取引内容、口座・カード識別子、氏名・住所などの PII、cookie、token、OTP、
passkey は取得・記録していない。送金、換金、入出金、カード操作、設定変更も行っていない。

## 2. 調査方法

- Wise Help Centre、Wise Platform API docs、公式ストア掲載を優先した。
- ログイン前の公開ページと HTTP response header だけを読み取り確認した。
- 2026-08-26 の `/login` が配る Next.js build と JavaScript chunk を公式 origin から取得し、
  SHA-256 を取って Prettier 3.9.6 で整形後、文字列と call site を静的に追跡した。repository
  には bundle や artifact を保存していない。公開 source map は 403 だった。
- Chrome の既存タブを確認したが Wise の認証済みタブはなかった。login、MFA、口座画面への
  遷移は行わず、本人データを伴う runtime trace も取得しなかった。
- Google Play の公式掲載で package/version を確認した。正規 split APK を取得できる管理下の
  Android 端末と Android 解析 toolchain はこの環境になく、第三者 APK mirror は使っていない。
- 公開 GitHub 実装は transport/auth と read/write 境界の確認にだけ使った。
- 公式ドキュメントにない個人口座の API 可用性を、API schema の存在から推定しない。
- 件数上限、session 寿命、内部 API の安定性など、公開根拠がないものは未確認とした。

## 3. 公式 Web/app で見える対象

### 3.1 main account、currency balances、jars

Wise 個人口座は一人につき一つで、その中に main account、複数通貨、任意の jars/groups
がある。個人口座の対象範囲は地域によって異なる。

- main account は保有、受取、送金、換金、カード支払の元となる複数通貨を持つ。
- Jar は main account と分離した同一/異通貨の保管単位。カード支払や Direct Debit の
  通常の引落元にはならないが、Jar からの送金や main account への移動は可能。
- 公式 Platform model では通常通貨残高が `STANDARD`、Jar が `SAVINGS`。
  `STANDARD` は通貨ごとに一つ、`SAVINGS` は同じ通貨で複数を持てる。
- API の Balance schema には `amount`（利用可能額）、`reservedAmount`（予約中）、
  `cashAmount`、`totalWorth`、`investmentState`、`visible` がある。

個人口座の公式説明:

- https://wise.com/help/articles/2897226/what-is-a-wise-account
- https://wise.com/help/articles/2897234/getting-started-with-your-wise-account
- https://wise.com/help/articles/2978074/what-are-jars-and-how-can-i-keep-money-in-them
- https://docs.wise.com/guides/product/accounts/balance-accounts

### 3.2 Assets（Interest / Stocks）

Interest と Stocks は提供地域・通貨に依存する。currency または Jar を Cash 以外で
保有する形であり、全個人口座にあるとは限らない。

- Web/app は total returns、実現/未実現損益、fund performance を表示する。
- standard/accounting statement の PDF には `Earnings since start` が入る。
- holdings statement は指定日の unit 数と評価額を示す。
- 日々の unit price の再評価は現金移動ではないため、通常の accounting transaction
  としては自動記録されない場合がある。
- Platform Balance は `investmentState` が `INVESTED` 等でも表示対象になり得るが、
  公式ガイドは `NOT_INVESTED` 以外を API で操作不可として扱うよう求めている。

個人向け Assets の事実:

- https://wise.com/help/articles/B9ZPY1rj6TlzvVOhtonFo/understanding-how-your-money-is-performing-when-you-hold-it-as-stocks
- https://wise.com/help/articles/4Mo9V7MyXos6scM7xvhg15/licences-and-regulators-when-holding-money-as-interest-and-stocks
- https://docs.wise.com/api-reference/balance/tag

### 3.3 Cards

公式 Web/app の Cards と Activity は、物理/デジタルカード、カード利用、pending 状態を
表示する。公式 Android package は `com.transferwise.android`。公式ストア外 APK は
初期経路にしない。

Platform の card transaction model は次を区別する。

- `IN_PROGRESS`: authorization 済み、未 capture（UI の pending に相当）。
- `COMPLETED`: capture/settle 済み。
- `DECLINED`、`CANCELLED`、`UNKNOWN`。
- merchant が回収しない予約額は通常 7 日、pre-authorisation は最大 30 日で解放される。
  ただし `CANCELLED` 後に merchant が遅れて capture し `COMPLETED` へ移る例外がある。
- refund は元明細の上書きではなく別 `REFUND` transaction になる API model。

個人口座 UI の pending/completed の説明:

- https://wise.com/help/articles/2935784/my-wise-card-transaction-is-still-pending
- https://wise.com/help/articles/2977995/i-need-to-reverse-or-dispute-a-card-transaction
- https://docs.wise.com/guides/product/issue-cards/card-transaction
- https://play.google.com/store/apps/details?id=com.transferwise.android

### 3.4 conversion、exchange rate、fees

- 個人口座内の通貨 conversion は通常数秒で反映され、Wise は mid-market rate と
  通貨ペアに応じた conversion fee を適用すると説明する。
- card 支払時に支払通貨の残高がなければ、利用可能な残高から自動 conversion され得る。
- Platform statement の JSON は `exchangeDetails` と `totalFees` を transaction 単位で持つ。
- Web/app の currency statement は fee 表示を選べ、別の年次 Statement of Fees もある。
- Assets は fund unit の再評価が cash transaction ではないため、通常明細だけでは
  日々の評価損益を完全には表さない。holdings/Assets statement を併用する。

- https://wise.com/help/articles/2596980/how-can-i-convert-money
- https://wise.com/help/articles/2893489/fees-for-holding-receiving-and-spending-money

## 4. 明細、期間、件数、export

### 4.1 currency/Jar statements

公式 Web/app の statement は currency と Jar を対象にする。

| 項目     | 確認結果                                                                          |
| -------- | --------------------------------------------------------------------------------- |
| 期間     | 1 ファイル最大 365 日。全期間は 365 日以下に分割する                              |
| 内容     | Wise currency account 内の全取引。hidden activity も含む                          |
| 対象外   | 外部 payment method を含む全 transfer は Transactions export を使う               |
| Web 形式 | PDF、XLSX、CSV、MT940、QIF、CAMT.053 version 10                                   |
| app 形式 | PDF、CSV、XLSX                                                                    |
| 複数対象 | Web と Android は複数 currency/Jar を一括選択。大きい場合は zip またはメール link |
| 手数料   | accounting statement で fee を別表示できる                                        |
| 再認証   | download の確定時に Wise password の入力が必要と公式案内にある                    |
| 件数     | 公開された row 上限は確認できない                                                 |

公式根拠:

- https://wise.com/help/articles/2736049/how-do-i-download-a-statement

### 4.2 Transactions export

Web の Transactions page は最大 365 日の範囲で transfer を一覧、検索、filter、download
できる。mobile app では transfer list download は提供されない。

filter は date、recipient、transfer type、status、direction、card、category、currency。
形式は CSV または PDF。公開された件数上限や pagination 単位は確認できない。

- https://wise.com/help/articles/2489458/how-do-i-download-a-list-of-my-transfers

### 4.3 fee statement と Assets

- Statement of Fees は前年単位で、口座開設以来の対象年を選べる。
- fee は通貨別に分類される。US based customer では現在提供されない。
- Assets の gain/loss は Statement of Fees に含まれない。
- currency statement 自体には fee を表示できる。

- https://wise.com/help/articles/6UgnJEesw6frs2o6lXEnwD/how-do-i-get-a-statement-of-the-fees-ive-paid

### 4.4 Platform API の粒度（可用性とは別）

契約済み user token 等で使う balance statement endpoint は、deposit、withdrawal、
conversion、card transaction、fee を返し、JSON/CSV/PDF/XLSX/CAMT.053/MT940/QIF を
選べる。

- interval は最大 469 日。
- JSON transaction は `type`、timestamp、`amount`、`totalFees`、`details`、
  `exchangeDetails`、`runningBalance`、`referenceNumber` を持つ。
- 一つの statement response 内の件数上限/pagination は公開資料で確認できない。
- UK/EEA は statement が SCA 対象になり得る。公式案内では追加認証は通常 90 日に一度で、
  Web/app で statement を見たことも認証に数えられる。

Card Transactions V4 は別の partner API である。

- 過去 90 日の card transaction のみ。
- `pageSize` は 10–100、default 20、`lastId` cursor。
- list は ID 降順。単一取得で debit/credit の非集約 movement まで得られる。

- https://docs.wise.com/guides/product/accounts/balance-accounts
- https://docs.wise.com/api-reference/balance-statement/tag
- https://docs.wise.com/api-reference/card-transaction/cardtransactiongetv4

これらの schema が personal profile を表現できることと、個人口座保有者が token を
セルフサービス発行できることは別である。

## 5. 認証、personal token、OAuth

### 5.1 Web/app の本人認証

確認できた方式は次のとおり。

- email + password は passkey を使えない場合の fallback。
- 2-step verification は passkey、Wise app notification、authenticator app の TOTP、
  SMS、条件により voice call/WhatsApp。
- SMS は current verification method から完全には削除できないと公式案内にある。
- 新しい device では追加 challenge が必要になり得る。
- statement download は Wise password の再入力が明記されている。
- app は通知・生体認証を担うが、Web も同じ security settings を管理できる。

公開 login build の静的解析では、次を確認した。これらは **identity/auth transport** であり、
personal balance/transaction API ではない。

- Axios の既定は `XSRF-TOKEN` cookie と `X-XSRF-TOKEN` header の組合せを持つ。
- login は `POST /gateway/v2/login`、passkey/OTT は
  `/gateway/v1/one-time-token/...`、Web 端末 challenge は `/v1/device/web/challenge` を使う。
- password、TOTP、push、phone、passkey の OTT challenge route が同じ login app にある。
- bundle にある固定 client marker は公開アプリ自身の識別子であり、個人 bearer/session token
  ではない。値を collector credential として扱わない。
- personal session cookie/token の発行形式、更新 route、寿命、device binding は login 前の
  bundle だけでは確定できない。

- https://wise.com/help/articles/2932125/how-do-i-add-change-or-remove-my-step-verification-settings
- https://wise.com/help/articles/2951949/i-cant-use-my-step-verification-method

### 5.2 Passkey と Bitwarden

**確認事実:** Wise は WebAuthn passkey を login と 2-step approval に使える。
設定後は passkey が default 2-step method になり、2-step が必要な action にも使える。
Wise が例示する保存先は Apple iCloud、Google Password Manager、1Password である。

- https://wise.com/help/articles/4OTG2Z93XXyaurUviZRg5O/how-can-i-use-a-passkey

**確認事実:** Bitwarden browser extension は一般の WebAuthn passkey の保存・利用と、
通常 login/password/TOTP の autofill をサポートする。

- https://bitwarden.com/help/auto-fill-browser/
- https://bitwarden.com/help/autosave-from-browser-extensions/

**推測:** Wise が標準 WebAuthn flow を使うため Bitwarden passkey も動く可能性は高い。
ただし Wise の公式記事は Bitwarden を互換保存先として明記しておらず、この組合せを
個人口座で live 確認していない。したがって「Wise が Bitwarden を公式対応」とは書かない。
また、Bitwarden extension の popup や passkey prompt を headless automation が操作する
前提にも置かない。

### 5.3 「Personal API Token」の実際

現行公式資料は明確に次を記載する。

- token の対象は **自分の Wise Business account**。
- Business profile の `Connect and manage apps > API tokens` で発行する。
- bearer token として `Authorization` header に入れ、revoke まで有効。
- endpoint scope は quote、recipient、transfer、batch、transfer event 等に限定される。
- balance statement は US/Canada/Australia/New Zealand/Singapore/Malaysia based の
  Business account 以外では personal token で非対応。

- https://docs.wise.com/guides/developer/auth-and-security/personal-api-token

よって名称だけを根拠に Wise **個人口座**で発行可能とは判断しない。Help Centre の
一般説明や古い third-party README に personal customer/API の表現があっても、現在の
access guide と発行手順を優先する。

### 5.4 OAuth 2.0 と Open Banking

Wise Platform OAuth は一般消費者向け app registration ではない。

- partnership agreement、Developer Hub で発行される client ID/secret、redirect URL、
  mTLS setup が前提。
- user access token は 12 時間、refresh token は最大 20 年。refresh すると旧 access token
  が失効し、refresh token も rotate し得る。
- credential scope は契約した integration model に依存する。

Wise Open Banking は認可済み AISP/TPP 向けに `accounts` scope の balances/transactions
という read-only model を持つが、規制・登録・mTLS・consent が必要。個人用 API key の
代替ではない。

- https://docs.wise.com/guides/developer/auth-and-security
- https://docs.wise.com/guides/developer/auth-and-security/oauth-2-setup
- https://docs.wise.com/guides/developer/auth-and-security/user-access-token
- https://docs.wise.com/guides/developer/open-banking

## 6. CDN、WAF、anti-bot

2026-08-26 にログイン前の公開 response を確認した。

### 確認事実

- `wise.com` と `api.wise.com` は Cloudflare edge address に解決した。
- Web と API response は `server: cloudflare`、`cf-ray`、`cf-cache-status` を返した。
- Web/API は `__cf_bm` cookie を返した。Cloudflare 公式資料上、これは Bot Management
  または Bot Fight Mode 系の保護で使われる cookie であり、どちらの product/plan かは
  response だけでは確定できない。
- login page の CSP/HTML には `challenges.cloudflare.com`、Turnstile、reCAPTCHA、
  Sardine/Moscwise の fraud/device signals に関係する参照が含まれた。
- bearer token なしの API GET は 401 で、認証 data は返らなかった。
- Wise の privacy notice は website/app interaction、typing cadence、keystroke、touch、
  mouse behavior などの behavioural biometrics を fraud detection に利用すると説明する。

- https://wise.com/login
- https://api.wise.com/
- https://wise.com/imaginary-v2/images/6840ab5cd14bcca9f98307cf7cb689c5-PersonalCustomerPrivacyNoticev.3-31March2025%28EN%29.pdf
- https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/
- https://developers.cloudflare.com/turnstile/reference/content-security-policy/

### 未確認・推測

- Turnstile/reCAPTCHA が通常 login のどの条件で発火するかは未確認。
- Bot Management と Bot Fight Mode のどちらか、bot score、rate rule、account takeover rule、
  IP reputation threshold は未確認。
- internal API と mobile API の origin、device binding、certificate pinning は未確認。
- Cloudflare や fraud provider の検出を回避する実装は行わない。

## 7. app と Web の役割

| Surface      | 読み取り用途                                               | export                                          | 認証上の役割                                              |
| ------------ | ---------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| Web          | Home、balances、Jars/Assets、Cards、Activity、Transactions | 全形式、transfer list、複数 currency/Jar に最適 | passkey/password、security settings、download 時 password |
| app          | 同じ口座状態、即時通知、card 状態、Activity                | PDF/CSV/XLSX。transfer list download は不可     | trusted-device notification、生体、passkey/2-step         |
| Platform API | 契約 scope 内の balance/statement/card data                | JSON と statement formats                       | bearer OAuth/personal Business token、場合により SCA/mTLS |

収集目的では Web export が最も広く、app は notification/2-step と spot check に向く。

### 7.1 現行 Web JavaScript の静的 inventory

2026-08-26 に公式 `/login` から取得した build ID は `login-app_main_7d8f91a`。entry は
`pages/login-6024adb12c070424.js`、主要 app chunk は `_app-335f04025d26a9b1.js`
（取得時 SHA-256 `d9a1c9f84d347f66630eda0d5cc288921bc7cca54e257f5c21f9700b9ceda0f1`）だった。
整形・文字列追跡で 5.1 の identity route、XSRF 設定、passkey/OTT/device challenge を確認した。
minified file が指す source map は公式 origin で 403 だったため、公開 bundle だけを解析した。

`/home`、`/activity`、`/transactions`、`/balances`、`/your-account` の未認証 GET はいずれも
`/login?redirectUrl=...` へ移り、login build manifest は login/account recovery 系 route だけを
配る。したがって、この artifact から personal balance/activity chunk や read endpoint を
見つけられなかったことは「endpoint がない」という証拠ではなく、認証後に別 app/bootstrap が
配られるという証拠境界である。

- https://wise.com/login

### 7.2 personal read route の確認対象と recipient 除外

公開 Platform API と personal internal API は別物として扱う。前者の path/schema を後者へ
当てはめない。認証後の passive trace で次の UI 操作が発生させる request を一つずつ対応付ける。

| UI read                 | 必要な schema                                                          | 取り込まないもの                               |
| ----------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| Home                    | currency balance、reserved/available、Jar、Assets の有無               | profile/account ID、氏名、住所                 |
| Activity 一覧/詳細      | stable ID の有無、timestamp、amount/currency、status、type、pagination | counterparty 名、口座番号、reference/free text |
| card pending/completed  | authorization/posted/cancelled/refund、reserved と settled の差        | card number/token、merchant location の詳細    |
| conversion/fee 表示     | source/target amount/currency、rate、fee、同一 event の関連付け        | quote/conversion の作成 request                |
| statement/transfer list | period、format、生成済み document の read                              | recipient filter 値、PDF/CSV の実データ        |

recipient 一覧・作成・編集 route は収集対象外で、`recipient`/`beneficiary` 専用 path にはアクセス
しない。Activity response に相手情報が同居しても、collector は必要な取引状態だけを schema
allowlist し、名前、bank detail、message/reference を破棄する。pending と posted は別 record と
決め打ちせず、stable ID と状態遷移を確認してから reserved/settled をモデル化する。

初回は passive page load で自然に発生した `GET` だけを候補にする。read が GraphQL/RPC の
`POST` で実装されていても、method 名だけで安全と推定せず呼ばない。正確な path、query key、
pagination、fee/FX field、session/renewal は認証済み trace がない現在は未確認である。

### 7.3 公式 Android split APK の provenance と静的解析

公式 Google Play listing で確認した package は `com.transferwise.android`、2026-08-26 時点の
表示 version は `9.38.0`（2026-08-24 更新）。この調査環境には `adb`、`apksigner`、
`bundletool`、`jadx`、`apktool`、`aapt2`、`apkanalyzer`、MobSF がなく、Docker だけがあった。
また、管理下端末に Play から正規 install 済みの artifact がなかったため、versionCode、split
一覧、SHA-256、signer certificate digest、manifest、host/path/schema は未取得である。

- https://play.google.com/store/apps/details?id=com.transferwise.android

第三者 mirror ではなく、本人管理の Google Play 端末へ公式 app を install/update した後、次の
手順で全 split を取得する。端末の account data は開かず、repository 外の一時領域を使う。

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

全 split の package/versionCode と signer digest の一致を先に検証し、base だけでなく code/config
split も `jadx` へ渡す。manifest の exported component、app/deep link、network security config、
WebView/native client、protobuf/JSON schema、session storage/renewal、Android Keystore/biometric、
Play Integrity/attestation、certificate pinning 候補を inventory 化する。難読化解除と call graph
追跡は対象だが、integrity/pinning/root/debugger 検出の **回避** はしない。MobSF は version/digest
を固定したローカル container にだけ投入し、公開 cloud scanner へ APK を upload しない。

### 7.4 本人操作の read-only runtime metadata 観測

Web は本人が通常 login/MFA を完了した後、DevTools/CDP で現在の Home と Activity を再読込し、
method、host、ID を template 化した path、query **key 名**、status、content-type、schema key だけを
memory 内で集計する。header、cookie、token、request/response body、金額、ID、相手情報は保存しない。
今回、既存 Chrome タブに Wise はなかったため実行していない。

Android は改変していない公式 app で本人が Home/Activity を開く間に、DNS/SNI/IP と、OS trust
の範囲で得られる場合だけ method/host/path、process/thread call site を観測する。通信 metadata
を得られなければ TLS handshake/host までで止める。Frida 等で URL construction を
runtime tracing すること自体は対象だが、token/header/body を hook せず、pinning/integrity を
無効化しない。Web/app の host、path、schema、session issuance/renewal が同じとは仮定しない。

## 8. 公式 sample と公開 third-party client

### 8.1 Wise 公式 sample

Wise は一般用 SDK ではなく、OAuth connect と SCA の Next.js sample を公開している。
Wise API call は browser client ではなく server-side で行い、bearer token を
`Authorization` header に付ける。SCA sample は `x-2fa-approval` / result header を扱う。
これは partnership credential が前提の実装例で、個人口座 token の発行手段ではない。

- repository: https://github.com/transferwise/wise-platform-samples
- 確認 commit: https://github.com/transferwise/wise-platform-samples/tree/a7d09f2695b13adbe21fe0b0cb8ae603b983f0a8

### 8.2 Hillpro/WiseApi.Client

MIT の非公式 .NET 10 client。確認 commit は
`b759e1430351f0348778fdb3e313cc5db5733ac5`。

- `HttpClient` + delegating handler で全 request に `Authorization: Bearer` を付与。
- production は `https://api.wise.com`、sandbox は `https://api.wise-sandbox.com`。
- GET の profiles、multi-currency account、balances、rates に加え、balance create/delete、
  quote、conversion/movement という **write endpoint も同じ client に含む**。
- OAuth client credentials、authorization code、registration code、refresh token を実装。
- statements、cards、recipients、transfers は当該 commit では deferred。
- README は personal token が personal/small business で動くと書くが、現行 Wise 公式資料の
  Business-only 発行手順と不一致。公式資料を優先する。

- https://github.com/Hillpro/WiseApi.Client
- https://github.com/Hillpro/WiseApi.Client/blob/b759e1430351f0348778fdb3e313cc5db5733ac5/src/WiseApi.Client/Http/Handlers/AuthenticationHandler.cs
- https://github.com/Hillpro/WiseApi.Client/blob/b759e1430351f0348778fdb3e313cc5db5733ac5/src/WiseApi.Client/Services/BalancesApi.cs

### 8.3 fightmegg/transferwise

MIT の古い Node.js client。`node-fetch`、bearer token、旧 host
`https://api.transferwise.com`、旧 `/borderless-accounts?profileId=...` を使用する。
最後に確認できた default-branch commit は
`3515c1ea9500ab869c5333b6d3210b04f418d477`（2020-12-03）であり、現行 collector の
基盤にはしない。

- https://github.com/fightmegg/transferwise/tree/3515c1ea9500ab869c5333b6d3210b04f418d477

## 9. read-only scope と write endpoint の隔離

### 個人口座の現在値

個人口座保有者が発行できる read-only API token/scope は確認できない。したがって
「read-only scope の token を保管すれば安全」という設計は現時点では成立しない。

personal internal transport を検証する collector は、公開 Platform client と完全に分ける。
初回 inventory は本人の通常 UI 操作が自然に発生させた request の観測だけとし、次を強制する。

- allowlist 候補は確認済み host 上の `GET` かつ Home balance、Activity list/detail、card
  status、既存 statement metadata に対応した path だけ。未確認 path を再送しない。
- `POST`/`PUT`/`PATCH`/`DELETE` は、read に見える GraphQL/RPC も含め初回は全て拒否する。
- recipient/beneficiary、quote、conversion、transfer、funding、card control、Jar movement、
  profile/security/notification settings の path は method に関係なく拒否する。
- redirect を自動追従せず、host/path/method を再判定する。401/403/SCA/OTT/429 では停止し、
  session refresh、MFA、device challenge を replay しない。
- response から balance/transaction/status/fee/FX の許可 field だけを memory 内で抽出し、
  ID、相手、reference、口座・カード detail、cookie/token を log/artifact に出さない。

session/token issuance と renewal は未確認である。login bundle の XSRF/OTT route を personal
data bearer と同一視せず、session replay 可否は Set-Cookie や Authorization 値そのものを保存
せずに、credential **種別と更新イベントの有無**だけで判定する。

### 契約 API が利用可能になった場合

read-only collector は Wise client library 全体を渡さず、次のような小さい adapter にする。

許可候補:

- `GET /v2/profiles`（personal profile 選択後、PII を永続化しない）。
- `GET /v4/profiles/{profileId}/balances?types=STANDARD,SAVINGS`。
- `GET /v1/profiles/{profileId}/balance-statements/{balanceId}/statement.*`。
- 必要な場合だけ card transaction の GET。カード識別子は保存しない。

強制拒否:

- HTTP `POST`、`PUT`、`PATCH`、`DELETE` の全て。
- `/transfers`、`/recipients`、`/quotes`、`/balance-movements`。
- balance/card の create/delete/status、PIN、spending permission。
- funding、conversion、send、direct debit、webhook subscription。

実装条件:

- egress proxy で host、method、path を allowlist。redirect 先も再検査する。
- token/refresh token は secrets manager に置き、ログ・URL・artifact に出さない。
- response は schema validate し、profile/card/account identifier と PII を collector log から除外。
- Open Banking の `accounts` scope のような provider-enforced read-only scope がある場合は
  それを使い、application allowlist と二重化する。
- SCA/OTT が要求されたら自動回避せず user handoff または停止。

## 10. runtime 適性

| Runtime               | 適性                   | 理由                                                                                          |
| --------------------- | ---------------------- | --------------------------------------------------------------------------------------------- |
| Cloudflare Workers    | 条件付き               | 承認済み bearer REST の GET には軽量。個人口座 token がなく、passkey/browser login は実行不可 |
| Cloudflare Containers | C/D 実験のみ           | full browser を置けるが Cloudflare egress、ephemeral disk、bot protection、再認証が不安定要因 |
| 通常の OCI container  | C/D 実験の第一候補     | Playwright と固定した browser build、local encrypted session を管理しやすい                   |
| Kubernetes            | 不適                   | 単一個人口座では運用面が過剰。IP/session の分散は fraud 判定を悪化させ得る                    |
| ローカル対話 browser  | live validation に最適 | passkey/2-step/password 再入力を本人が行い、UI 状態を確認できる                               |

Workers は V8 isolate と Fetch API で REST GET を扱えるが、global state に session を置かない。
契約 OAuth が mTLS を要求する場合、Cloudflare Workers の mTLS binding は候補になるものの、
Cloudflare に proxy された origin への client certificate request には制約があるため、実際の
Wise mTLS host で事前検証が必要。

Containers は outbound host allowlist と Worker 側での credential injection を使えるが、disk は
sleep/restart で初期化される。browser profile を container disk に永続化しない。

- https://developers.cloudflare.com/workers/reference/how-workers-works/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/
- https://developers.cloudflare.com/containers/platform-details/architecture/
- https://developers.cloudflare.com/containers/platform-details/outbound-traffic/

## 11. 自動化レベルとコスト

PR #5 の共通定義だけを使う。

- **A**: scheduled headless に適した公式 documented/export API。
- **B**: renewable/reusable session の安定した read-only internal API。
- **C**: browser/app bootstrap 後の headless replay が可能そう。
- **D**: full browser/device automation が必要。
- **E**: manual capture が安全な既定。
- cost は 1（小さい wrapper）から 5（device-bound/adversarial automation）。

### 現在の評価

| 経路                     | Level  |  Cost | 判定                                                                     |
| ------------------------ | ------ | ----: | ------------------------------------------------------------------------ |
| Web/app 手動 export      | **E**  | **1** | 推奨。公式、広い形式、365 日 chunk                                       |
| 個人セルフサービス API   | —      |     — | token/OAuth 発行経路を確認できない                                       |
| 契約 OAuth/Open Banking  | A      |   3–5 | 技術的には最良だが partnership/regulatory cost。個人 MVP 対象外          |
| authenticated Web replay | C 候補 |     4 | 公開 login transport は確認、personal read path/session renewal は未確認 |
| full browser automation  | D      |     4 | Cloudflare/fraud signals、passkey/2-step、password 再入力                |
| 公式 Android app replay  | D 候補 |     5 | split APK/transport/device binding/pinning/integrity を未確認            |

**source record の代表値は E / cost 1** とする。

## 12. read-only live 検証

### 公開状態だけで実施済み

- 公式 Help/API docs の現在の wording と URL。
- `wise.com`、login、`api.wise.com` の DNS/response header。
- 未認証 API が 401 で data を返さないこと。
- 現行 login Next.js bundle の取得、hash、整形、identity/XSRF/OTT/device challenge call site。
- personal UI route が未認証では login app へ redirect され、personal read chunk を配らないこと。
- 公式 Play package/version/update date と、正規 split APK/toolchain が未取得である障壁。
- 開いていた Chrome タブに Wise がないこと。login や runtime trace は開始していない。
- 公開 repository の commit、license、transport/auth/write surface。

### 本人同席で次に確認する項目

値を記録せず、画面の有無・形式・schema だけを確認する。

1. 個人 profile に API token menu がないこと。Business profile へ切り替えない。
2. Home を一度再読込し、balance/Jar/Assets/card の種類と、それぞれの read request の
   method/host/template path/status/pagination key/schema key だけを対応付ける。
3. Activity 一覧/詳細を一つずつ開き、pending/posted/cancelled/refund、stable ID、fee/FX field の
   **有無だけ**を確認する。recipient filter/list/settings へ移動しない。
4. session の credential 種別、更新イベント、新規 device challenge の有無だけを記録する。
   cookie/header/token の値、寿命を測るための長時間保持、refresh request の手動再送はしない。
5. Statement 作成画面で 365 日制限、currency/Jar、format、fee-separate option を確認。
6. Transactions の filter と CSV/PDF option を確認。download は本人が明示した場合だけ。
7. Security settings で現在利用可能な method 名だけを確認。追加・削除・default 変更はしない。
8. browser DevTools は request method/host/template path/status と schema key だけを記録し、
   header/body/cookie/token/ID/金額/取引内容を保存しない。
9. 公式 Play app の全 split と signer/versionCode を 7.3 の手順で確認し、static host/path/schema/
   session/device/integrity/pinning 候補を inventory 化する。runtime は 7.4 の metadata に限る。
10. もし export sample が必要なら、本人がローカルで作った完全に sanitized な header-only
    sample を使う。実取引ファイルを repository や issue に置かない。

### stop 条件

次のいずれかで直ちに停止する。

- 送金、換金、入出金、recipient 作成、Jar 移動、Assets 売買、card freeze/status/PIN、
  profile/security 変更へ進む UI または API。
- passkey/API token/2-step method の作成、削除、再設定、default 変更。
- OTP、password、passkey、recovery code、token、cookie、card/account identifier、PII の
  chat/log/trace への露出。
- CAPTCHA、Turnstile、reCAPTCHA、account restriction、fraud warning、device verification。
- 403 SCA、401 再認証、429、想定外 redirect、想定外の non-GET request。read に見える
  GraphQL/RPC `POST` も安全性が証明できるまでは実行しない。
- Cloudflare/fraud control の回避、stealth、fingerprint spoofing が必要になった場合。
- pinning/integrity/root/debugger detection の無効化、hook による秘密/header/body 取得が必要な場合。
- export が email delivery になり、本人の明示操作なしに外部送信を発生させる場合。

login/2-step は本人が公式 UI で直接完了し、agent は秘密を受け取らない。失敗後に連続再試行
せず、現在の account state を再確認してから終了する。

## 13. 確認済み、推測、未確認

### 確認済み

- 個人口座 Web/app は currency/Jar statement を 365 日ずつ export できる。
- Web は PDF/XLSX/CSV/MT940/QIF/CAMT.053、app は PDF/CSV/XLSX。
- Transactions の CSV/PDF download は Web のみで、最大 365 日。
- pending/completed の区別と reserved funds の model がある。
- Wise は passkey、app/TOTP/SMS 等の 2-step verification を提供する。
- 現行 Personal API Token は Business account 用。
- Platform OAuth/Open Banking は partnership/mTLS 等を前提とする。
- Cloudflare edge と `__cf_bm`、challenge/fraud 関連の public dependency がある。
- 現行 public login build は XSRF cookie/header、login/OTT/passkey/device challenge の identity
  route を持つが、personal balance/activity route は未認証 build に含まれない。
- 公式 Android package は `com.transferwise.android`。公式 listing の観測 version は 9.38.0。
- 公開 client は bearer HTTPS REST を実装し、一部は write endpoint も同居させる。

### 推測

- Bitwarden passkey は標準 WebAuthn のため動く可能性が高いが、Wise 公式互換表では未確認。
- browser bootstrap 後の read-only internal API replay は技術的には可能かもしれない。
- OCI browser は Cloudflare Containers より session/egress を固定しやすい。

### 未確認

- 個人口座で read-only API token/OAuth を例外的に提供される地域・legacy account の有無。
- Web CSV/XLSX の全 column、encoding、row 上限、同一 transaction の安定 ID。
- statement に pending card transaction が入る時点と、後日の確定/取消時の差分表現。
- Assets holdings statement の個人口座全地域での形式、API の unit/cost basis coverage。
- 複数 physical/digital card の export 区別と card filter の識別方法。
- authenticated Web/mobile の host、endpoint、pagination、session/refresh lifetime。
- 正規 Play split APK の versionCode、hash、signer、manifest、host/path/schema。
- Web/app transport の差、device binding、mobile TLS pinning、Play Integrity/App Attest の利用。
- Cloudflare challenge/fraud rule の発火条件。
- Wise と Bitwarden の組合せに対する公式サポート可否。

以上が確認できるまでは、個人口座の collector を API level A/B と評価しない。

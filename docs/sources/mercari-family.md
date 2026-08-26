# Mercari / Merpay / Mercoin 個人口座ソース評価・transport 再監査

調査日: 2026-08-26

## スコープと安全境界

本資料は、日本の個人向けメルカリアカウントから直接確認できる次の三系統だけを対象とする。

- メルカリの出品取引、売上金、販売履歴
- メルペイ残高、メルカリポイント、メルペイのクレジット（あと払い・メルカードを含む）の利用履歴
- メルコインが提供する暗号資産の保有・入出金・取引履歴・取引報告書

同じメルカリアカウントと公式アプリから到達できても、運営主体、資産種別、正本となる履歴、帳票を混同しない。特に、本人確認前の「売上金」と本人確認後の「メルペイ残高」、ポイント、クレジット債務、暗号資産、暗号資産取引用の日本円は別フィールドとして保持する。コインチェック連携口座で媒介される暗号資産も、メルコイン自身が扱う BTC / ETH / XRP と同じ台帳だと仮定しない。

アカウントアグリゲータは初期経路にしない。実験は残高・履歴・帳票の読み取りだけに限定し、出品、購入、支払い、チャージ、振込申請、送金、ポイント購入、あと払いの清算、暗号資産の購入・売却・入出金・つみたて、申込、設定変更を行わない。口座 ID、氏名、メール、電話番号、住所、注文・取引 ID、実残高、取引額、暗号資産数量、Cookie、トークン、パスキー、OTP、端末識別子、認証・完全性情報を、ログ、fixture、Issue、PR、コミットへ保存しない。

## 調査方法

メルカリ、メルペイ、メルコインの現行ヘルプと公式 Google Play 掲載を一次情報として使用した。加えて、匿名で取得できる `jp.mercari.com` の現行 HTML、route manifest、JavaScript chunk を一時領域だけに取得し、Prettier で整形して host、path、request/response model、認証・token 更新処理を静的に確認した。source map は代表 chunk で 403 となり取得できなかった。公開面への実行はページと asset の通常の `GET`、WAF 確認の `HEAD` に限り、認証 endpoint、金融 API、write endpoint は呼んでいない。

調査時点の [Mercari Web](https://jp.mercari.com/) release は `1.260824.091703-sha.f2d8bd3`、asset origin は `https://web-jp-assets-v2.mercdn.net` だった。home から参照される JavaScript 39 本を取得し、代表的な SHA-256 は common/auth chunk `36a9b0b446c68407284f35fa72c59cca0b4e91e37fc371076724267d41b403e4`、販売履歴 page chunk `39a3ae59986fe12c7fcc846ef43e080969821c0dfeff832e10423007fbc00790`、残高 page chunk `207a26a01270892dadb3d662e7579cc9688333cfb5ddd668d9a3c8e014b747dd`、ポイント page chunk `f1368dcf0d09dfe7deefc3665370caabb4c50283b3529a48c3cbb29a300a9dcc`、クレジット page chunk `317312e11be2d37a7f3d9dfbba37106dcc33d8008c9972963631bd99bd4f78cc` である。これは再現性のための公開 artifact 識別子であり、安定 API の保証ではない。

利用者のブラウザには今回メルカリ系の既存タブがなかったため、ログインやアカウント画面への遷移は行っていない。正規 Play 導入済み Android 端末も接続されておらず、APK は取得していない。第三者実装は公開ソースを静的に読み、通信先・要求署名・実装範囲を確認した。実値取得、認証済み通信、取引・設定変更は行っていない。

以下では「公式確認事実」「公開面の直接観測」「第三者実装の証拠」「推測・未確認」を分ける。

## 結論

三系統を一括で無人収集する公開個人 API は確認できない。しかし「金融アプリ transport 不明」と一括評価する段階ではない。現行 Web artifact から、メルカリの確定販売、メルペイ残高・売上金・ポイント・クレジット請求概要について、具体的な公式 read route と共通 OIDC / PKCE / DPoP session transport を確認した。これらは認証済み live 検証前なので **C 候補 / cost 4** とし、B へは上げない。メルコインの資産・約定は Web artifact に見つからず、公式アプリ内部 route は未確認のため **D / cost 5** のままである。

自動 collector の実装順位は、(1) 明示的な page size、offset、total count と手数料・利益 field を持つメルカリ確定販売、(2) メルペイの売上金・ポイント・残高 snapshot、(3) メルペイのクレジット月次請求概要、(4) メルコインの live app route とする。一方、会計用の手動 importer は、月内取引と月末残高を含むメルコイン月間取引報告書 CSV が最初でよい。自動化優先順位と、構造化 manual export 優先順位を混同しない。

全体の無人化は引き続き **D / cost 5**。金融データの一部はアプリ中心で、パスキー・SMS・本人確認・サービス別申込があり、公開面には Cloudflare Bot Management Cookie が見える。公開第三者クライアントの匿名検索 DPoP は transport の傍証にはなるが、個人金融 authorization の証拠ではない。

## 正本と対象範囲

| 系統 | 現在値の正本候補 | 履歴の正本候補 | 確定・未確定の境界 |
| --- | --- | --- | --- |
| メルカリ販売 | Web の残高（または売上）画面 | Web の販売履歴と個別取引 | 取引中は売上未確定。通常は取引完了時に販売利益が売上金または残高へ反映される |
| 売上金 | 本人確認前に表示される売上金 | 売上履歴 | 振込申請期限は取得日から 180 日。本人確認後は残高表示へ移行する |
| メルペイ残高 | アプリ「おさいふ＞残高」 | 残高履歴 | 本人確認後の残高には有効期限がない。チャージ、売上反映、支払い、返金等を残高台帳で見る |
| メルカリポイント | アプリ「おさいふ＞ポイント」 | 履歴と有効期限 | 購入ポイントは購入日から 365 日、無償ポイントはキャンペーン別。誤付与取消もあり得る |
| メルペイのクレジット | アプリ「○月の請求」 | 月別請求内訳、毎月の利用状況 | 店舗データ受領前は「処理中」。加盟店から売上データが届き請求が確定するまで変更され得る |
| メルコイン直接取扱 | アプリ「おさいふ＞ビットコイン等」 | 資産別取引履歴、入出金履歴、月間取引報告書 CSV | BTC / ETH / XRP を直接取扱。運用額は保有数量と現在価格による時価評価であり、日本円残高や取得原価とは別 |
| 連携口座暗号資産 | アプリ内の連携口座表示 | 連携口座の取引履歴・取引報告書 | コインチェック社の現物取引をメルコインが媒介する別サービス。資産・報告を直接取扱分と区別する |

公式根拠:

- [販売利益が反映される時点](https://help.jp.mercari.com/guide/articles/95/)
- [商品が売れた後の取引完了まで](https://help.jp.mercari.com/guide/articles/63/)
- [売上金の 180 日の振込申請期限](https://help.jp.mercari.com/guide/articles/96/)
- [本人確認後の売上金・残高表示](https://help.jp.mercari.com/guide/articles/560/)
- [メルペイ残高と本人確認](https://help.jp.mercari.com/guide/articles/551/)
- [ポイントの種類、履歴、有効期限](https://help.jp.mercari.com/guide/articles/40/)
- [クレジット利用履歴の「処理中」](https://help.jp.mercari.com/guide/articles/1234/)
- [暗号資産の直接取扱と連携口座](https://help.jp.mercari.com/guide/articles/1336/)
- [取扱暗号資産一覧](https://help.jp.mercari.com/guide/articles/2036/)
- [暗号資産の運用額・評価損益表示](https://help.jp.mercari.com/guide/articles/1352/)

## 履歴の粒度・期間・エクスポート

### メルカリ販売

公式 Web の「おさいふ＞残高（または売上）＞残高履歴（または売上履歴）」には、販売した商品の取引情報一覧がある。公式ガイドは、販売履歴を iOS / Android アプリでは提供せず、CSV 出力も提供しないと明記し、保存には Web ページの印刷を案内している。PDF は専用帳票ではないが、ブラウザの印刷先を PDF にすれば画面保存できる。

公式ガイドは、一覧の最古日、保持年数、1 ページ件数、総件数上限、ページング仕様を公表していない。したがって「全期間取得可能」とは扱わず、live 検証で最古表示・件数・ページ境界を測る。

- [販売履歴、Web 限定、CSV 非対応](https://help.jp.mercari.com/guide/articles/97/)

### メルペイ残高・ポイント・クレジット

公式アプリの支払手段別履歴は、クレジットが「○月の請求＞内訳を見る」、残高が「残高＞残高履歴」、ポイントが「ポイント＞履歴と有効期限」である。「最近の利用＞毎月のご利用状況」は、ポイント、残高、クレジットを使ったメルカリ・加盟店での買い物を一か月単位でまとめるが、チャージ、返金、売上金反映、振込申請、クレジット利用分の支払出金を含まない。統合表示を完全な台帳として使ってはならない。

紙の利用明細は発行されず、公式案内は画面保存・印刷である。個人向けの残高・ポイント・クレジット履歴について CSV、PDF 帳票、年間利用報告書を提供する一次情報は確認できなかった。保持期間、最古月、ページ件数、総件数上限も公表されていない。おさいふの最近の利用には反映遅延があり得る。

キャンセル時の残高・ポイント返金は通常同時に反映され、各履歴で確認する。クレジットは加盟店から後着したデータで請求・返金表示が変わる場合があるため、`processing` と `settled` を同一行の状態遷移として保存し、初見値を確定値として固定しない。

- [支払手段別・月別の利用履歴と紙明細なし](https://help.jp.mercari.com/guide/articles/578/)
- [月別利用履歴の対象外イベント](https://help.jp.mercari.com/guide/articles/746/)
- [おさいふ画面と履歴反映の時間差](https://help.jp.mercari.com/guide/articles/2037/)
- [残高・ポイント払いの返金履歴と時期](https://help.jp.mercari.com/guide/articles/466/)
- [キャンセル後に加盟店データで再請求される場合](https://help.jp.mercari.com/guide/articles/2093/)

### メルコイン

アプリの取引履歴は資産を選択して確認し、個別詳細には取引種別（購入、つみたて購入、売却、支払いのための売却、受取等）、日時、注文 ID 等がある。ID や実値は収集記録に残さない。別の「チャージ・移した履歴」は、暗号資産取引用日本円の入出金を日付・金額・種別で保持するため、暗号資産売買履歴と分ける。

法令に基づく月間取引報告書は、月内の取引履歴と月末残高を CSV で交付する。取引がない月にも交付され、前月分の作成完了後にメール通知される。アプリから対象月ごとにダウンロードする。退会月と翌月分も交付され、退会後に過去分が必要なら事務局へ依頼できる。

公式の年間損益説明は、1 月から 12 月までの月間 CSV の値を利用者が合算する方法であり、単一の年間 CSV / PDF を示していない。CSV には取引種別、取引ペア、暗号資産数量の増減、約定金額等があり、取引単位の損益計算材料になる。画面履歴の保持期間・件数上限は公表されていないが、月次 CSV があるので表示履歴を長期正本にしない。

- [資産別取引履歴と個別詳細](https://help.jp.mercari.com/guide/articles/1368/)
- [暗号資産取引用日本円の入出金履歴](https://help.jp.mercari.com/guide/articles/1361/)
- [月間取引報告書 CSV、月末残高、退会後の扱い](https://help.jp.mercari.com/guide/articles/1369/)
- [月間 CSV を使う年間損益計算](https://help.jp.mercari.com/guide/articles/1513/)
- [手数料なし・提示価格にスプレッドを含む](https://help.jp.mercari.com/guide/articles/1473/)

## 認証、MFA、パスキー、Bitwarden

### 公式に確認できる事実

- メルカリは 2026-05-29 以降、ログイン方法の更新を段階導入している。パスキー登録済みアカウントではメルカリサービスへのログインにパスキーを使用し、状況により Apple / Google / Facebook / LINE、メールのマジックリンクと SMS の代替経路が案内される。未登録アカウントではメールアドレスまたは電話番号とパスワード等の経路が残る。
- Web の「パスキーでログイン」は QR コードを表示し、メルカリアプリで登録したパスキーを持つスマートフォン等で読み取る方法が案内される。登録端末交換後も、登録済みならパスキー認証が要求される。
- SMS 認証では 6 桁の認証番号を使う。ログインやメルペイ利用時に本人確認を要求されることがある。
- メルコイン利用開始には、メルカリアカウント、パスキー登録、本人確認、サービス申込が必要である。共通ログインは、メルコインの利用資格や台帳がメルカリ販売と同一であることを意味しない。
- メルカリのガイドは「デジタル認証アプリ」による問題をサポート対象外としているが、これは Bitwarden の WebAuthn パスキー対応可否を直接述べたものではない。

公式根拠:

- [ログイン方法アップデート](https://help.jp.mercari.com/guide/articles/1860/)
- [パスキーありのログインと Web QR](https://help.jp.mercari.com/guide/articles/1875/)
- [SMS 6 桁認証とパスキー推奨](https://help.jp.mercari.com/guide/articles/1043/)
- [SMS による本人確認](https://help.jp.mercari.com/guide/articles/687/)
- [機種変更後のパスキー](https://help.jp.mercari.com/guide/articles/243/)
- [メルコインの利用条件](https://help.jp.mercari.com/guide/articles/1336/)

### Bitwarden との関係

Bitwarden は一般にブラウザ拡張から WebAuthn パスキーを保存・使用でき、パスワードや TOTP の自動入力もできる。これは Bitwarden の機能として確認できる事実である。

- [Bitwarden のパスキー・資格情報自動入力](https://bitwarden.com/help/auto-fill-browser/)

一方、メルカリアプリで登録したパスキーが Bitwarden を資格情報プロバイダーとして選べるか、Bitwarden 保存パスキーが公式アプリと Web QR フローの双方で受理されるか、OS・端末に束縛されるかは未確認である。よって「Bitwarden で無人ログイン可能」と推測しない。live 検証では秘密を表示・出力せず、登録済みパスキーのプロバイダー名と、Web ログイン時に選択肢が提示されるかだけを人手で確認する。

## 公式アプリ、APK、Web の役割

日本向け公式 Android アプリは Google Play の package [`com.kouzoh.mercari`](https://play.google.com/store/apps/details?id=com.kouzoh.mercari&hl=ja)、publisher `Mercari, Inc` である。2026-08-26 に公式 Play HTML から確認した current version は `5.217.0`、更新日は 2026-08-21、最低 Android は 8.0 である。同じ package 内にメルカリ、メルペイ、メルコイン機能が集約され、公式掲載は暗号資産取引もメルカリアプリ内と説明する。package が共通でも、販売、決済、暗号資産の台帳・運営主体・read model は別である。

Web は商品閲覧・取引画面に加え、販売履歴の一覧と印刷を提供する。販売履歴は逆にアプリ非対応である。Web ログインはアプリ登録済みパスキーを使う QR フローを持つため、ブラウザ単独のパスワード自動入力だけで全画面へ到達できるとは限らない。

メルカリ配布の standalone APK は確認できず、調査環境には `adb`、`apksigner`、`bundletool`、`jadx`、`apktool`、`aapt2`、`apkanalyzer`、MobSF がなかった。APK mirror は provenance と signer を保証できないため使わない。利用者が Google Play から正規導入した非 root 端末を接続した後、split APK を一時領域へ抽出し、全 split の package、versionCode、signer が一致することを確認する。

```bash
PKG=com.kouzoh.mercari
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
  'https?://|wss://|api|mercari|merpay|mercoin|balance|sales|point|credit|defpay|crypto|asset|order|execution|fill|trade|statement|report|session|token|dpop|okhttp|retrofit|grpc|protobuf|certificate|pin|integrity|attestation|keystore|biometric' \
  "$OUT/jadx" "$OUT/apktool-base"
```

成果物は Git に入れず、manifest の exported component / app link / network security config、host・path、Retrofit/OkHttp または gRPC/protobuf schema、session 発行・更新、keystore/biometric/device binding、certificate pinning、Play Integrity / attestation 候補だけを redacted inventory にする。必要なら local の version 固定 MobSF container で補助解析する。難読化解除・call graph・本人操作の read-only runtime tracing は対象内だが、pinning / integrity / root 検知を迂回して通信本文を復号することは対象外である。

## 公開 Web JavaScript の common auth / session

現行 Web common chunk は、`https://auth.mercari.com` を issuer とする Authorization Code + PKCE (`S256`) を実装する。ブラウザは `X-Platform: web` を付け、`GET /jp/v1/authorize` に `rmode=direct` と `prompt=none` を指定し、返された code を `POST /jp/v1/token` で code verifier、resource host、公開 client ID / scope と交換する。redirect URI は `https://jp.mercari.com/auth/callback` である。これらはコード上の route であり、今回 request は送っていない。

access / ID token と expiration は localStorage の `authTokenData`、sign-in marker は `signIn` に置かれる。DPoP 鍵は WebCrypto で非抽出 P-256 ECDSA 鍵として生成され、IndexedDB database `auth-sdk`、object store `keyPairs`、key `dpop` に保存される。proof は `typ=dpop+jwt`、`alg=ES256` とし、`iat`、random `jti`、`htu`、`htm`、共通 UUID を含む。各 API request に `DPoP`、認証済み request に access token の `Authorization` を付ける。

API client は少なくとも次の三面に分かれる。

| 面 | base / header | 確認した役割 |
| --- | --- | --- |
| Mercari | `https://api.mercari.jp`、`X-Platform: web` | 販売履歴、mypage component、商品・取引 surface |
| Merpay | `https://api.merpay.com`、同じ DPoP / Authorization interceptor | 売上金、ポイント、残高、クレジット請求 |
| Accounts | `https://accounts.mercari.com` | account bootstrap の別 client。金融 read client と同一視しない |

production browser では構成により `https://jp.mercari.com/api` または `/merpay-api` proxy へ書き換える処理もある。401 / 403 では、明示的な passcode / SMS / country error 等を除き、`authorize` の silent flow と token exchange を行って元 request を一度再試行する。これは session renewal の実装確認であり、token lifetime、無人更新の長期安定性、device binding、WAF 許容を live に確認したものではない。

## 台帳別の公式 Web read route

匿名で page shell と page-specific chunk を取得できた `/mypage/sales_history`、`/mypage/balance_details`、`/mypage/point/history`、`/mypage/merpay/smartpayment`、`/mypage/listings/sold` を静的解析した。account response は取得していない。

### Mercari: 確定販売台帳

`GET https://api.mercari.jp/sold_histories/list` は `{year, limit, offset}` を受け、現行 UI は `limit=20`、`offset=(page-1)*20` とする。response は `sold_histories` と `total_count` を持ち、各行から `price`、`sales_fee`、`seller_shipping_fee`、`seller_additional_fee`、`tax_rate`、`sales_profit`、`transaction_finished_at`、`donation_amount` を読む。`item_id`、商品名、thumbnail も返るが、collector では PII / 商品情報として保存・出力しない。

これは transaction 完了後の settled sale と利益台帳であり、出品中・取引中の pending 状態ではない。UI の `/transaction/{itemId}` link や取引操作へは進まない。明示的な pagination と fee / profit schema があるため、自動 collector の第一候補である。

別に Merpay balance 面には次の売上金 read がある。

- `GET https://api.merpay.com/balance/v1/list_sales_histories`: `histories[]` の `type`、`datetime`、`changedAmount`、`title` を表示し、販売時は `mercariExtraInfo.itemId` も含み得る。ID・title は保存しない。
- `GET https://api.merpay.com/balance/v1/list_sales_expiry_dates`: 本人確認前の売上金 expiry を表示する。

現行 Web client はこれらに pagination parameter を渡さず、server retention と暗黙 cap は未確認である。確定販売利益と、残高へ反映された売上金 change event は重複し得るため同一台帳へ二重計上しない。

### Merpay: 残高・ポイント台帳

`GET https://api.mercari.jp/v2/mypage/top/components` は page が生成する `mypageRequestId` を受け、wallet component から `balance.balance`、`hasFundsAccount`、`totalPoint`、`serviceState` を表示する。Mercari Bank 機能が有効な場合の `baasAccountBalance.availableBalance` は別台帳として分離する。この面は feature flag `BRIDGE-77_baas_mypage_web` の影響を受ける。

ポイント面は同じ Merpay session client から次を読む。

- `GET https://api.merpay.com/v1/get_balance`: current balance / point snapshot。
- `GET /v1/list_point_histories`: `results[]` の `id`、`type`、`title`、`datetime`、`changedAmount`。collector は `id` と `title` を保存しない。
- `GET /v1/get_point_history?id=...`: 個別詳細。初期 allowlist では呼ばない。
- `GET /v1/list_point_expiry_dates`: `date`、`amount`、`purchased`。

list に現行 client-side pagination parameter はなく、保持期間・server cap は未確認である。current snapshot、獲得・利用 change event、有効期限 bucket を別 record type にする。同じ module に `/v1/create_point_recharge`、`/v1/create_funds_recharge`、各種限度額・あと払い同意更新があるため、module 単位ではなく route 単位で deny する。

### Merpay: 決済・クレジット請求台帳

現行 Web page は次の read route を持つ。

- `GET https://api.merpay.com/shared/defpay/v1/defer/get_user_status`
- `GET /shared/defpay/v1/check_easypay_terms_updates`
- `GET /defpay/v1/get_easypay_repayment_setting`
- `GET /defpay/v1/get_easypay_convertible_payment_list`
- `GET /defpay/v1/get_repayment_top`

`get_repayment_top` は invoice を返し、UI は `status=DRAFT` を区別し、`useMonth`、`deadlineAt`、`repaymentAmount`、`demandFee`、`lateFee`、`totalEasypayPrincipalAmount`、`totalEasypayFee`、`usingScheduledRepayment` 等を表示する。これは月次 invoice / repayment summary であり、加盟店単位の「処理中→確定→返金」全履歴ではない。公式 Help が示す `処理中` は確認済みだが、その merchant line read route と status schema は今回の Web chunk では特定できなかった。

`calc_easypay_repayment_plan` と applicant condition は ledger 取得に不要なので、GET でも初期 allowlist から除外する。同じ module の `convert_monthly_clear_to_easypay`、`cancel_invoice_repayment`、`initialize_post_pay_user`、`update_easypay_repayment_setting`、`update_easypay_monthly_installments`、`create_invoice_repayment` は厳格 deny とする。

### Mercoin: 資産・注文・約定台帳

現行 public route manifest と取得した Web chunk には、メルコインの資産・注文・約定・月間報告書に対応する金融 route を確認できなかった。従って app-only surface の route 名、host、schema を推測しない。

APK 取得後は、(1) symbol 別 quantity / valuation / cost basis / unrealized P&L の asset snapshot、(2) order ID / status と fill / average price / spread・fee の execution、(3) 暗号資産取引用日本円の funding change event、(4) 月間 report list / download、を別 schema として探索する。注文と約定、直接取扱 BTC / ETH / XRP とコインチェック連携、暗号資産 quantity と日本円評価を混ぜない。read-only runtime では各一覧を本人が一度表示し、method、host、path template、query key 名、status/content-type、response の key 名だけを採取する。

## 公開 API と第三者実装

個人の販売・残高・ポイント・クレジット・暗号資産台帳を取得する、公開・自己申込可能な公式 API は確認できなかった。メルカリShops の GraphQL API と Personal Access Token はショップ事業者用であり、本資料の個人口座ソースではない。メルペイ加盟店向け API も決済受付側の契約 API であり、消費者の個人台帳エクスポートではない。

- [メルカリShops API reference](https://api.mercari-shops.com/docs/index.html)
- [メルペイ加盟店規約のオンライン API](https://www.merpay.com/merchant/terms/)

公開第三者実装 [`take-kun/mercapi`](https://github.com/take-kun/mercapi/tree/9455cf167d4a3eff5674612631a6e88e72424c7f) は、Python `httpx.AsyncClient` から次を行う。

- 起動時に P-256 鍵とランダム UUID を生成する。
- `X-Platform: web` を付け、各 request の URL・method・UUID を ES256 の DPoP JWT に署名する。
- `POST https://api.mercari.jp/v2/entities:search` で商品検索し、page token を扱う。
- `GET /items/get`、`/users/get_profile`、`/items/get_items` で公開商品・出品者情報を読む。

[`marvinody/mercari`](https://github.com/marvinody/mercari/tree/8aa38587a7905d62cadaf4cfb35bb555eefa7d96) も `requests` と ES256 DPoP で公開検索・商品取得を実装する。[`enemy732/mercari-jp-wrapper`](https://github.com/enemy732/mercari-jp-wrapper/tree/bd87146c39c839901ac58f689a16dcba98b018cf) は `accounts.mercari.com` への事前 request で Authorization / DPoP header を得て `api.mercari.jp` の検索へ送る形を示す。

これらは公開商品面の transport / request-signing の具体例であり、ログイン、セッション更新、個人販売履歴、メルペイ、メルコインを実装していない。第三者実装の DPoP 生成成功を、金融データへの認可や長期セッション再利用の証拠にしない。発見した内部 endpoint を片端から呼ぶ探索も行わない。

## WAF・anti-bot の観測

2026-08-26 に WSL から匿名 `HEAD` を行った範囲では、`jp.mercari.com`、`help.jp.mercari.com`、`auth.mercari.com`、`api.mercari.jp`、`accounts.mercari.com` は `server: cloudflare`、`cf-ray`、`__cf_bm` を返した。`__cf_bm` は Cloudflare Bot Management 系 Cookie である。`jp.mercari.com` と help は背後に `via: 1.1 google` も見えた。`api.mercari.jp/v2/entities:search` への method 不一致の匿名 HEAD は Cloudflare 403、auth/accounts の root または未対応 path は 404 だった。

これは「観測した host の edge が Cloudflare であり bot 管理 Cookie を設定した」証拠である。ログイン後の金融 API が同じ policy であること、403 が bot 判定だけを理由とすること、rate limit、challenge 条件、地理制限、端末 attestation、certificate pinning は確認していない。Akamai を示す CNAME、`AkamaiGHost`、拒否マーカーは今回の応答に見つからず、現時点で Akamai 採用を肯定しない。

反復 403 / 429、challenge、CAPTCHA、パスキー再認証、アプリのセッション失効を回避するために IP rotation、fingerprint 偽装、challenge bypass を行わない。

## read / write の隔離

収集器は「同じ API host だから安全」ではなく、意味上の操作を allowlist する。

| 初期 read allowlist 候補 | 禁止 |
| --- | --- |
| `sold_histories/list` の fixed year / limit / offset list | 出品・価格変更・削除、商品・取引 detail |
| `balance/v1/list_sales_histories`、`list_sales_expiry_dates` | チャージ、振込申請、残高移動 |
| `v2/mypage/top/components` の wallet component | 口座・本人確認・限度額・支払設定 |
| `v1/get_balance`、`list_point_histories`、`list_point_expiry_dates` | point / funds recharge、交換、失効回避操作 |
| `defpay/v1/get_repayment_top` の invoice summary | 清算、返済作成・取消、分割変更、同意・自動引落し設定 |
| 既存月間取引報告書の list/download（app route 確認後） | 暗号資産注文・売買・つみたて・入出金 |

HTTP `POST` でも検索のように read-only なものがあり、`GET` でも eligibility 計算や署名 URL 発行等の副作用があり得るため method だけで分類しない。最初は上表の route と response schema だけを許可し、path parameter を持つ detail、未知 route、未知 field、write verb を deny する。各 client は read-only な型だけを別 package にし、同じ process に write method をリンクしない。egress proxy でも host + exact path + method を許可し、redirect 先が allowlist 外なら停止する。

## 実行環境適性

| Runtime | 適性 | 理由 |
| --- | --- | --- |
| Cloudflare Workers | **手動 export 取込には高、認証 bootstrap には低** | Fetch API で通常の HTTP を送れ、CSV/PDF/HTML の受領・正規化に向く。一方、ローカル filesystem や公式 Android アプリを持たず、パスキー QR、SMS、端末状態を生成できない。Cloudflare edge からの replay は別 WAF policy を受け得る |
| Cloudflare Containers | **後処理は中、アプリ自動化は低** | 任意言語・Linux filesystem の処理はできるが、Play 導入済み端末、パスキー、SMS、端末完全性を再現しない。Worker から on-demand 起動される構成も、長期の人間向けアプリ session 保持には不向き |
| OCI VM / 固定 egress | **read-only replay が証明された後は中** | 暗号化 session、常駐 process、固定 egress、ブラウザを管理しやすい。だが公式アプリ境界や bot/端末拘束を解消せず、未確認 endpoint の安定性も上げない |
| Kubernetes | **多数ソース運用には中、初期単独 collector には過剰** | CronJob、secret 分離、network policy、監査に向く。Mercari 一件の手動 export 取込だけなら運用コストが上回る。write route を network / code policy で拒否できる場合に採用価値がある |
| 利用者管理の公式 Android + ブラウザ | **一次確認に最適** | 既存の正規 session と対応パスキーを持つ。人が read-only 画面・既存 CSV を選び、秘密や実値を外へ出さず検証できる |

Cloudflare の現行仕様根拠:

- [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [Workers security model と filesystem 非対応](https://developers.cloudflare.com/workers/reference/security-model/)
- [Cloudflare Containers overview](https://developers.cloudflare.com/containers/)

## PR #5 共通 A–E / cost 評価

共通定義は、A = 公開・文書化 API / export API で scheduled headless、B = 安定した read-only internal API と更新可能 session、C = browser/app bootstrap 後の headless replay、D = full browser/device automation、E = manual capture。cost は 1（小さな wrapper）から 5（端末拘束・対抗的自動化）である。

| 経路 | Level | Cost | 判断 |
| --- | --- | ---: | --- |
| メルカリ確定販売 Web read | **C 候補** | **4** | **自動 collector の第一候補**。exact GET、20 件 page、offset、total count、fee / profit schema、共通 session transport を静的確認。live session 更新・保持期間確認前なので B ではない |
| メルペイ売上金・ポイント・残高 Web read | **C 候補** | **4** | exact GET と schema は確認。pagination / implicit cap、snapshot と event の整合を live 確認する |
| メルペイクレジット請求概要 Web read | **C 候補** | **4–5** | invoice summary の exact GET は確認したが merchant line の processing / settled / refund route は未特定。write 隣接面のため優先度を下げる |
| メルコイン月間 CSV の手動 download + import | **E** | **1** | **manual importer の第一候補**。公式、構造化、月末残高付き。自動 app transport より先に会計正本を作れる |
| メルカリ販売履歴の Web 印刷 + import | **E** | **1–2** | CSV なし。印刷 HTML/PDF の schema drift を許容し、原本を保持する |
| メルペイ各履歴の画面保存 + manual normalization | **E** | **2** | 残高・ポイント・クレジットを別 capture。統合月次画面だけでは不足 |
| メルコイン app internal read | **D** | **5** | package は特定したが APK / route / schema / session / integrity 未取得。資産・注文・約定・report を分離してから C 適性を再評価する |
| 公式 Android UI automation | **D** | **5** | 端末、パスキー、サービス別画面、非同期帳票、誤操作防止が必要 |

総合評価は **D / cost 5**、安全な manual 初期経路は **E / cost 1–2** である。Web read は public 商品検索 client ではなく現行公式金融 page chunk 自身を根拠に C 候補としたが、認証済み一回観測、renewal、retention、schema drift の gate を満たすまでは実装採用せず、B にしない。

## read-only live 検証計画

1. 利用者の既存公式アプリと Web session を使用し、サービス名、画面見出し、表示 field 名だけを記録する。実値、ID、通知本文、メール、QR、Cookie、token は記録しない。今回ブラウザに既存タブがなかったため、まず利用者自身が公式 URL を通常操作で開く。
2. DevTools の sanitized logger は method、host、path template、query key 名、status、content-type、response top-level key 名だけを出力し、header、body、token、ID、金額、商品名、相手先を採取前に捨てる。HAR は保存しない。
3. Web の確定販売を一度表示し、`sold_histories/list` の limit / offset / total count、年境界、最古年、空 page を確認する。個別 `/transaction/{itemId}` と操作 button は開かない。
4. 売上金履歴、ポイント履歴・期限、残高 component、クレジット請求概要を各一度表示し、静的に特定した route と response key が一致するかだけ確認する。`get_point_history`、repayment calculation / applicant condition は初回に呼ばない。
5. アプリで残高履歴、月別利用状況、クレジット請求内訳を閲覧し、Web で未特定の merchant line の `processing / settled / refund` status と route template を確認する。支払・清算導線へは進まない。
6. メルコインで保有資産一覧、資産別取引履歴、注文 / 約定、入出金履歴、取引報告書一覧を本人が順に一度表示する。runtime 観測は host / path / schema metadata だけとし、購入・売却・チャージ画面には進まない。
7. 既に発行済みの月間 CSV 一件だけを利用者が手動 download し、隔離した local 環境で header、encoding、行種別、月末残高行、asset symbol、訂正行の有無を確認する。実データを Git や診断ログに残さない。
8. Web のパスキー login は、登録済み端末で通常の QR 読取を一度観察し、Bitwarden provider が選択肢に現れるかだけ確認する。再登録、削除、パスキー設定変更をしない。
9. session replay は live metadata と明示許可を得た後、local で allowlist GET 一件だけ試す。token や DPoP proof は永続化せず、成功しても cloud へ session を移す前に silent renewal、同時 session、失効、egress / WAF、write egress deny を再審査する。

## 即時 stop 条件

次のいずれかでその経路を停止し、再試行・回避を行わない。

- 出品、購入、支払い、チャージ、送金、振込、清算、暗号資産取引、つみたて、申込、同意、設定保存の確認画面へ遷移した。
- パスキー登録・削除、SMS / OTP 入力、本人確認、口座連携、利用枠変更を要求された。
- request が read-only allowlist 外、または response の意味が不明である。
- 401 / 403 / 429、Cloudflare challenge、CAPTCHA、追加本人確認、異常ログイン通知、アプリ session 失効が発生した。
- certificate pinning、device attestation、root / emulator 拒否を回避する必要が生じた。
- Android の unmodified app で host / path metadata を観測できず、pinning / integrity bypass や秘密 header/body hook が必要になった。
- 実値、PII、ID、秘密が URL、画面、ログ、exception、telemetry に残りそうである。
- 利用履歴の取得が、規約で禁止される自動化・過剰負荷・security control 回避を必要とする。

## 未確認事項 / acceptance gate

- [ ] 販売履歴、残高履歴、ポイント履歴、クレジット請求内訳の最古日・最古月、件数上限、page size。
- [ ] 「処理中」から確定・取消・返金への状態名と、訂正時に同一 ID が更新されるか別行が追加されるか。
- [ ] 月間取引報告書 CSV の全 header、encoding、直接取扱と連携口座の区別、訂正・再発行時の同一性。
- [ ] 取引報告書のアプリ内保持期間。退会後の問い合わせ提供は確認済みだが、在会中に一覧から全月を取得できる保証は未確認。
- [x] 公式 Web の確定販売、売上金、ポイント、残高 component、クレジット請求概要の route と response key（public current JS の静的確認）。
- [x] Web の OIDC Authorization Code + PKCE、DPoP 鍵、Authorization / DPoP interceptor、silent renewal / retry（public current JS の静的確認）。
- [ ] 認証済み Web で上記 route / schema が一致すること、pagination の server 動作、token lifetime、renewal 成功条件、WAF / egress 差。
- [ ] Merpay merchant line の processing / settled / refund read route と状態遷移。
- [ ] 正規 split APK の package / versionCode / signer / manifest / host / schema、mobile session issuance、device binding、certificate pinning、Play Integrity / attestation 候補。
- [ ] メルコイン資産、注文、約定、funding、report list/download の app read route と schema。
- [ ] Mercari app 登録パスキーを Bitwarden provider に保存・利用できるか。一般的 WebAuthn 対応から推定しない。
- [ ] Cloudflare 403 の理由、rate limit、地域・egress 差、認証後 API host の CDN / WAF。
- [ ] 個人口座向け read-only API / data portability route の有無。Shops・加盟店 API は代替にならない。

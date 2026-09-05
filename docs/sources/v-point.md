# V Point / V Point Pay source research

調査日: 2026-08-26（公開情報、ログアウト状態の公開 endpoint、公開 JavaScript、公開第三者実装）

Live追試: 2026-08-31、Kogane Capture Chromeのユーザー口座でVポイントMy Pageへloginし、
`balance_info`、`tpoint_history`、`smfg_point`をread-onlyで検証した。値、加盟店、会員番号、
Cookie、個人情報はrepositoryへ保存していない。PoCは`poc/vpoint-worker/`に置く。
同日のVポイントPay app静的解析と独立Worker設計は`docs/sources/v-point-pay.md`および
`poc/vpoint-pay-worker/`へ分離した。

## 1. 対象範囲と安全境界

この記録の単位は個人向けの V Point と V Point Pay である。V Point サイト/アプリ、V Point Pay
アプリ、Vpass、三井住友銀行アプリ/SMBC ダイレクト/Olive という複数の公式経路を比較する。
V Point と V Point Pay 残高は別資産であり、三井住友カードの請求明細や銀行預金も別台帳である。
V Money、旧 T マネー、PayPay ポイント、ANA マイレージ移行可能ポイント、提携先独自ポイントは、
名称や導線が近くても対象に含めない。

許可するのは、既存残高、通常/有効期限固定/ストア限定ポイント、期限、獲得・利用・失効・交換等の
既存履歴、V Point Pay の既存利用/返金/チャージ履歴の read-only 表示と、ユーザー管理端末での
静的解析、deobfuscation、runtime tracing、通信メタデータ観測である。支払、チャージ、交換、移行、
ID 連携/解除、passkey 登録、認証/通知設定変更、会員情報変更等の write は行わない。

V 会員番号、Yahoo! JAPAN ID、Vpass ID、SMBC ID、電話番号、氏名、生年月日、カード/口座番号、
Cookie、OTP、app passcode、session/token、passkey private key、実残高、実履歴、実加盟店名を、
取得物、HAR、screenshot、log、commit に残さない。WAF/CAPTCHA、rate limit、certificate pinning、
端末 integrity/attestation 等の security control は回避しない。

## 2. 調査方法と証拠の強さ

- V Point、三井住友カード、三井住友銀行、Google Play の公式ページを主な根拠にした。
  aggregator は探索にも根拠にも使っていない。
- 2026-08-26 にログアウト状態で公開 URL の status/header/redirect と、誰でも配信を受けられる
  V Point My Page の JavaScript bundle を低頻度で観測した。認証、credential 入力、challenge 誘発、
  private API replay、負荷試験は行っていない。
- 公開 GitHub 実装は commit を固定して確認した。加えて、ユーザー管理の非公開 Vpass 5.12.0 静的
  解析 snapshot をローカル参照し、transport/auth/schema の型・フィールド名を確認した。後者は
  public third-party client ではなく、公開 URL の根拠にも使わない。snapshot に記載された provenance/
  signature は、今回 APK を再取得・再検証した事実とは分ける。
- VポイントPay APK候補は2026-08-31に別途取得・解析した。binary、通常/復号DEX、decompiler outputは
  private archiveへ保存し、本書のVポイントWeb検証とは証拠境界を分ける。詳細は
  `docs/sources/v-point-pay.md`を参照する。
- 以下では **確認事実**、そこからの **推測/設計判断**、**未確認** を明示的に分ける。

## 3. 台帳の正本と経路別 trade-off

| 資産/記録                                           | 正本候補               | read surface            | 強み                                                                      | 主な欠落/危険                                                                    |
| --------------------------------------------------- | ---------------------- | ----------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 統合後 V Point 残高・通常/固定期限/ストア限定・履歴 | V Point サイト/アプリ  | My Page、V Point アプリ | 期限 bucket と統合後履歴を一箇所で確認。公開 JS に具体的な内部 API/schema | 公式 CSV/PDF は公開資料で未確認。電話認証/passkey/Cloudflare session が絡む      |
| 三井住友カード由来ポイント                          | Vpass                  | Vpass Web/app           | カード側付与、Olive クレジットモード、統合前/未連携の確認                 | 未連携履歴は 1 年かつ 100 件。full history endpoint は静的解析 snapshot で未確認 |
| SMBC/Olive の銀行・デビット由来ポイント             | SMBC アプリ/ダイレクト | V POINT/サービス画面    | 銀行・デビット・銀行プログラムの由来確認                                  | 銀行残高等の対象外 PII が近い。クレジット付与は Vpass が正本候補                 |
| V Point Pay 残高・利用/返金/チャージ                | V Point Pay app        | app home、利用明細      | Pay の現在残高と authorization/settlement/refund の表示                   | 支払/チャージ write と密接。保持期間、件数、export、内部 transport は未確認      |

同じ「Vポイント」表示でも、V Point 台帳と V Point Pay のプリペイド残高を足し合わせない。ポイントを
Pay へ移行するとポイント側の減少と Pay 側の増加という二つの ledger event が生じるため、同一資産の
重複表示でも消費でもない。公開仕様では二つを結ぶ安定 ID を確認できず、金額と時刻だけで自動結合
しない。

推奨 source-of-record は次のとおりである。

1. 統合後の spendable V Point、通常/固定期限/ストア限定の expiry bucket、統合後履歴は V Point
   サイト/アプリ。
2. 三井住友カード/Olive クレジットモードの付与 provenance と旧/未連携履歴は Vpass。
3. SMBC 銀行・Olive デビット/ポイント払いモードの付与 provenance は SMBC 側。ただし銀行口座の
   値は収集しない。
4. V Point Pay 残高、利用、settlement、返金、チャージは V Point Pay app の別台帳。

## 4. V Point の残高、種類、期限、履歴

### 4.1 通常、有効期限固定、ストア限定

[Vポイントサービス利用規約](https://privacy.vpoint.co.jp/terms/point/) による確認事実:

- 通常ポイントは、最後のポイント変動から 1 年で失効する。変動には通常ポイントの獲得/利用/交換
  と、ストア限定ではない有効期限固定ポイントの利用が含まれる。
- 有効期限固定ポイントは個別の期限を持ち、その獲得/利用によって当該期限は延びない。
- ストア限定ポイントの獲得/利用は、通常ポイントの期限を延長しない。
- V Point サイトは、保有ポイントの内訳と期限を表示する。

[有効期限固定ポイント FAQ](https://ssl.help.tsite.jp/faq/show/62773?site_domain=qa-tsite) は、
「ストア限定」と「どこでも使えるが期限固定」の二種類を説明する。利用順は概ねストア限定、
どこでも使える期限固定、通常ポイントで、同種では期限が近いものが先である。
[ストア限定ポイント FAQ](https://ssl.help.tsite.jp/faq/show/43147?site_domain=qa-tsite) は、利用先と
期限が限定され、履歴にも表示されるとする。

保存する最低単位は、`asset=v_point`、`point_type`、利用可能数量、期限日、ストア/アライアンス制限、
`observed_at` である。最短期限だけでなく取得できる全 expiry bucket を snapshot とし、通常ポイント
の動的な期限を恒久 lot の期限と誤解しない。

### 4.2 履歴粒度、期間、件数、export

[My Page の見方](https://ssl.help.tsite.jp/faq/show/35501?site_domain=qa-tsite) と
[確認方法 FAQ](https://ssl.help.tsite.jp/faq/show/42305?site_domain=qa-tsite) による確認事実:

- My Page は総ポイント、通常/有効期限固定の内訳、ストア限定残高と期限を表示する。
- V Point 履歴は **過去 3 年分まで** 表示できる。利用日順/反映日順、期間や種別による絞込、
  明細詳細がある。
- 獲得グラフは月単位で最大 12 か月、年単位で最大 5 年である。ただしストア限定や返品/取消による
  マイナス等を除外するため、台帳の完全な代替ではない。
- V Point サイト/アプリは残高と履歴を確認できる。電話照会は残高だけで、ストア限定を表示しない。

公開 JavaScript と2026-08-31のlive response schemaから確認できた履歴行のフィールドは
`date_reflect`、`date_use`、`point_div`、`store_company`、`store_category`、`store_name`、
`point_type`、`point`、`is_use_mbo`、`store_alliance_name`、`reason` である。
`point_div` は獲得、利用、失効、訂正、取消等、`point_type` は通常、
ストア限定、どこでも使える期限固定を区別する。実値はrepositoryへ記録していない。

公開公式資料には、V Point 履歴の CSV/PDF download、1 page 件数、総件数上限、API、欠番や取消行の
安定 ID を確認できなかった。「export 不可」と断定せず、**公開資料で未確認** とする。3 年を超える
保存が必要なら、まず月次/四半期の read-only capture を検証し、画面の `results.total` と取得行数を
一致させる。

### 4.3 Vpass、ID 連携、SMBC/Olive

[Vpass のポイント履歴 FAQ](https://qa.smbc-card.com/mem/detail?category=61&id=1939&site=4H4A00IO)
による確認事実:

- V会員番号と三井住友カード側を ID 連携済みなら、Vpass/Vpass app から統合後の V Point 履歴へ
  遷移する。2024-04-21 以前の履歴は別表示である。
- 未連携の Vpass 履歴は **過去 1 年以内、最大 100 件**。100 件を超えた分は確認できない。
- 通常のカード利用ポイントは原則として月間利用合計から計算されるため、カード利用 1 件と
  ポイント付与 1 行を機械的に対応づけられない。
- PayPay ポイントへの交換分、ANA マイレージ移行可能ポイント、提携先独自ポイント等は main の
  V Point 表示に含まれない場合がある。

[交換履歴 FAQ](https://qa.smbc-card.com/mem/detail?category=16&id=272&site=4H4A00IO) も、連携済みは
V Point 側、未連携は 1 年/100 件の Vpass 側という分岐を案内する。
[2024 年統合案内](https://www.smbc-card.com/mem/cardinfo/23/cardinfo4010742.jsp) は、ID 連携により
旧 T ポイントと SMBC グループ側ポイントをまとめ、Vpass でも合計表示できるとする。
[連携手順](https://www.smbc-card.com/mem/for_info/vpo_idrenkei.jsp) は V Point Pay/Vpass Web/app での
連携を案内するが、連携・解除は write のため live 検証しない。

[SMBC の履歴 FAQ](https://qa.smbc.co.jp/faq/show/8824?site_domain=default) は、SMBC アプリ/ダイレクトの
`V POINT`/サービスから履歴へ進む経路を示す一方、Olive のクレジットモード/カード利用の付与は
Vpass で確認するよう案内する。付与予定は表示されない。
[Olive 付与タイミング FAQ](https://qa.smbc.co.jp/faq/show/7616?site_domain=default) と
[Vpass 表示 FAQ](https://qa.smbc-card.com/mem/nyukai/detail?category=215&id=2374&site=4H4A00IO) から、
クレジット、デビット、ポイント払いモード、支店/カード、特典名が attribution 候補になる。

設計判断: Vpass/SMBC の表示は V Point 全履歴の代替ではなく、付与 provenance と legacy gap を埋める
補助 source とする。SMBC 画面を読む場合も、預金残高、口座番号、入出金明細は収集対象外にする。

## 5. V Point Pay

### 5.1 残高、利用、authorization/settlement、返金

[V Point Pay の残高説明](https://qa.smbc-card.com/mem/nyukai/detail?category=189&id=1774&site=4H4A00IO)
は、ポイント等からチャージしたプリペイド残高を買い物に使うサービスとする。
[利用明細 FAQ](https://qa.smbc-card.com/mem/nyukai/detail?category=193&id=1810&site=4H4A00IO) は、app home
から利用明細を開く導線を示す。

状態の確認事実:

- [利用額の変更 FAQ](https://qa.smbc-card.com/mem/detail?category=189&id=1806&site=4H4A00IO) によると、
  まず加盟店の利用承認情報で残高が減り、後から加盟店売上額が届くと明細/残高がその確定額へ変わる
  場合がある。最初の表示を posted と断定しない。
- [返金 FAQ](https://qa.smbc-card.com/mem/detail?category=193&id=1805&site=4H4A00IO) によると、返金は
  加盟店情報到着後、通常 1～4 週間程度で、利用明細にはプラス額として表示される。
- [有効期限 FAQ](https://qa.smbc-card.com/mem/detail?category=189&id=1800&site=4H4A00IO) は、初回登録から
  5 年、所定期間内の利用/チャージでそこから 5 年に更新されるとする。古い説明と条件が異なり得る
  ため、実装時は現行 FAQ と app 表示を再確認する。
- [チャージ反映 FAQ](https://qa.smbc-card.com/mem/nyukai/detail?category=189&id=1799&site=4H4A00IO) は、
  ポイント/ギフトからのチャージと、本人確認を要するカード/銀行チャージで反映時期が異なるとする。

モデルは少なくとも `authorization_observed`、`settled`、`refund`、`charge` を分ける。authorization
表示を後から破壊的に上書きせず snapshot とする。公開資料では authorization ID、settlement ID、
原取引と返金の link ID、merchant/currency の完全フィールドを確認できないため、live で schema を
確認するまで金額・日付一致だけで結合しない。

### 5.2 期間、件数、export

公開公式資料には V Point Pay 利用明細の保持期間、CSV/PDF、file export、行の安定 ID を確認できなかった。
後続のAPK解析ではbalance応答の`inquiry_period`を最古月として、`target_month=yyyyMM`で月別JSONを
取得する構造を確認した。固定保持期間を仮定せず、実口座の最古月、authorizationがsettled行へ更新
されるか別行になるか、返金の原取引linkageをlive検証項目とする。

[ポイントチャージ手順](https://qa.smbc-card.com/mem/vptapp/detail?category=189&id=1778) は公式情報だが、
実行はポイント減少/Pay 残高増加を起こす write である。read-only 検証ではチャージ画面へ遷移せず、
既存履歴に現れた行だけを読む。

## 6. 認証、MFA、passkey、Bitwarden

### 6.1 V Point サイト/アプリ

- [ログイン FAQ](https://ssl.help.tsite.jp/faq/show/69477?site_domain=qa-tsite) は、スマートフォンでは
  Yahoo! JAPAN ID を使わず V会員番号で login できる経路と、Yahoo! JAPAN ID 経路を案内する。
- [公式アプリ利用手順](https://web.tsite.jp/pt/howto_app/?mode=PC) は、V会員番号または Yahoo! JAPAN
  ID での登録後、電話発信による本人確認を案内する。
- [passkey FAQ](https://ssl.help.tsite.jp/faq/show/73314?site_domain=qa-tsite) によると、2026-05-18
  時点で V Point サイト/アプリは passkey に対応する。登録には login と電話認証が必要で、現時点の
  対応は iOS、Android/PC は非対応である。これは WebAuthn/FIDO 系 passkey の公式確認である。

電話認証、Yahoo! JAPAN 側の追加認証、passkey 登録/削除が必要になったら人へ handoff する。既存
passkey での login は read の入口になり得るが、新規登録は設定 write のため行わない。

### 6.2 V Point Pay

- [app passcode FAQ](https://qa.smbc-card.com/mem/nyukai/detail?category=194&id=2874&site=4H4A00IO) は、
  カード情報表示や手続に 6 桁 passcode を使う。
- [SMS 認証 FAQ](https://qa.smbc-card.com/mem/nyukai/detail?category=196&id=1770&site=4H4A00IO) は SMS
  認証コードを案内する。
- [再認証 FAQ](https://qa.smbc-card.com/mem/vptapp/detail?category=189&id=1808&site=4H4A00IO) は、長期
  未使用後に電話番号、氏名カナ、生年月日、SMS code、新しい 6 桁 passcode を使う再認証を示す。
- [生体認証 FAQ](https://qa.smbc-card.com/mem/info/detail?id=1776&search=true) の Face ID/Touch ID は
  app passcode の代替/unlock で、V Point Pay の WebAuthn passkey 対応の証拠ではない。

V Point Pay の passkey 対応は今回確認できなかった。app の biometric unlock、SMS、V Point 側の
iOS passkey を同じ認証方式として扱わない。

### 6.3 Vpass / SMBC

[Vpass Web FAQ](https://qa.smbc-card.com/mem/detail?category=216&id=2283&site=4H4A00IO) は、Web は
Vpass ID/password のみを受け付け、SMBC ID は Vpass app のみとする。
[Vpass app login FAQ](https://qa.smbc-card.com/mem/detail?category=177&id=1335&site=4H4A00IO) は、
Vpass ID または SMBC ID/password と optional biometric/自動 login を案内する。
[生体認証 FAQ](https://qa.smbc-card.com/fs/collection/detail?id=991) は app biometric login の説明で、
WebAuthn passkey の確認ではない。三井住友銀行アプリの SMBC Safety Pass 等の端末認証は銀行 route
固有で、V Point 全体の共通 passkey と見なさない。3D Secure の SMS/email OTP は決済時認証であり、
残高照会 login MFA と混同しない。

### 6.4 Bitwarden: 確認と推測

Bitwarden は一般に [browser autofill](https://bitwarden.com/help/auto-fill-browser/)、
[Android autofill](https://bitwarden.com/help/auto-fill-android/)、
[passkey 保存](https://bitwarden.com/help/storing-passkeys/) を提供する。したがって Vpass Web の
ID/password や、対応 OS/browser での passkey provider になり得るという一般論はある。

ただし、V Point が公式に Bitwarden との互換性を明示した情報は確認できない。V Point passkey が
現時点で iOS 限定であること、V Point Pay/Vpass/SMBC app の biometric unlock は passkey ではない
ことから、**Bitwarden で全経路を無人化できるとは推測しない**。ID、電話、氏名/生年月日、app
passcode、OTP を一つの vault item/runtime に集約しない。

未確認: 各 session の寿命/refresh、端末/IP binding、電話/SMS challenge 頻度、Yahoo! JAPAN 側の
MFA 条件、V Point passkey の Bitwarden iOS provider 互換、Pay/Vpass app device key。

## 7. CDN、WAF、anti-bot

2026-08-26 のログアウト状態の低頻度観測:

| 公開入口                                                | 結果                                                                        | 言えること / 言えないこと                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `https://vpoint.net/`                                   | `302` で `https://tsite.jp/`、`Server: nginx`                               | 旧/案内入口の redirect。認証 origin の防御を示さない                       |
| `https://web.tsite.jp/`                                 | `200`、CloudFront の `X-Cache`/`Via`/`X-Amz-Cf-*`                           | 公開コンテンツに CloudFront が介在                                         |
| `https://mypage.tsite.jp/tpoint/?hid=1`                 | `200`、`Server: cloudflare`、`CF-Cache-Status: DYNAMIC`、Sydney の `CF-Ray` | 認証 My Page SPA の front door は Cloudflare。WAF/bot product/score は不明 |
| `https://www.smbc-card.com/mem/index.jsp`               | `403`、`Server: AkamaiGHost`                                                | Vpass 公開入口に Akamai が介在。匿名 curl 403 の理由は未確認               |
| `https://www.smbc-card.com/mem/for_vpointapp/index.jsp` | `403`、`Server: AkamaiGHost`                                                | カード側 V Point app 導線も Akamai。login 後挙動は不明                     |
| `https://qa.smbc-card.com/`                             | `200`、`Server: Apache`                                                     | FAQ は取得可能。Vpass/app API と同じ保護とは限らない                       |
| `https://direct.smbc.co.jp/aib/aibgsjsw5001.jsp`        | `200`、`X-Akamai-Transformed`                                               | SMBC Direct 公開入口で Akamai 介在を確認                                   |

これらは CDN/front-door header の観測であり、WAF の製品設定、bot 判定、app API の防御、login 後の
challenge、Cloudflare/Akamai の全 surface 適用を証明しない。V Point My Page 自体が Cloudflare
fronted なので Cloudflare Worker から必ず通るとも、同一 provider のため特別に通りやすいとも
推測しない。

401/403/429、CAPTCHA/challenge/interstitial、認証 loop、予想外の reauthentication が出たら停止する。
cookie/header 合成による防御回避、browser fingerprint spoofing、CAPTCHA solver、rate-limit 探索、
pinning/integrity bypass を行わない。

## 8. 公式 web/app/APK と first-party transport

### 8.1 公式 app と web の役割

| 公式 app                                                                          | Google Play package    | 2026-08-26 の Play metadata version | 主な read 役割                                                        |
| --------------------------------------------------------------------------------- | ---------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| [V Point](https://play.google.com/store/apps/details?id=jp.co.ccc.Tsite)          | `jp.co.ccc.Tsite`      | `3.7.3`                             | 統合ポイント残高、種類、期限、履歴。獲得/利用/交換等 write 導線も同居 |
| [V Point Pay](https://play.google.com/store/apps/details?id=com.smbc_card.vpoint) | `com.smbc_card.vpoint` | `2.5.0`                             | Pay 残高、利用/settlement/refund/charge。支払/チャージが中心に同居    |
| [Vpass](https://play.google.com/store/apps/details?id=com.smbc_card.vpass)        | `com.smbc_card.vpass`  | `5.12.0`                            | カード由来ポイント/連携状態、Olive credit provenance                  |
| [三井住友銀行](https://play.google.com/store/apps/details?id=jp.co.smbc.direct)   | `jp.co.smbc.direct`    | `12.7.0`                            | SMBC/Olive bank/debit provenance。預金等の対象外データが近い          |

Web は V Point の履歴 pagination/schema と Vpass legacy route の観測に向く。アプリは device-bound
認証、Pay の current ledger、first-party app API の同定に向くが、write との近さが強い。最初から
app UI automation を選ばず、V Point web、既存 Vpass session、最後に Pay/SMBC device の順とする。

version は可変である。artifact ごとに package、versionCode/versionName、取得日時、SHA-256、signer
certificate digest を記録する。公式 standalone APK 配布は確認できない。

### 8.2 V Point My Page の公開 JavaScript

匿名取得できる [V Point My Page SPA](https://mypage.tsite.jp/tpoint/?hid=1) の 2026-08-26 時点の
Nuxt chunk `/_nuxt/64c5c08.js` を静的解析し、次の same-origin first-party transport を確認した。

| method/path                | client が使う request/response schema                                                                                                     | 解釈                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `POST /api/balance_info`   | `status`; `results.common[] {point, expiration, point_type}`; `results.store[] {alliance_name, items[] {point, expiration}}`; `get_month` | 通常/期限固定/ストア限定の残高・期限 bucket                        |
| `POST /api/tpoint_history` | multipart: `page`, `get_graph`, `sort`, 各種 filter, `filter_date`; response `results.total/history/graph`                                | V Point 履歴 pagination と graph。内部名 `tpoint` は legacy naming |
| `POST /api/smfg_point`     | `results.get_point.point_smbc`, `point_smcc`                                                                                              | SMBC bank/card 側のポイント分離表示候補                            |
| `POST /api/tmoney_history` | V Money 履歴                                                                                                                              | **V Point Pay ではないため対象外**                                 |

`tpoint_history` の filter は獲得、利用、取消、失効、移行、訂正、期限延長、再発行、その他と、
利用日/反映日 sort を含む。client は `results.total` と収集行数を比較して pagination する。これは
具体的な read API/schema の強い証拠だが、公開 API ではなく session/cookie 保護された internal API
である。2026-08-31にはユーザー管理browserの通常login sessionから、同一originのread-only requestを
live検証した。renewable session、CSRF、rate limit、schema stability、利用規約上の自動取得可否は
引き続き未確認である。

### 8.3 正規 split APK の次実験

この調査ではV Point/V Point Pay/SMBCのAPKを新規取得しなかった。ユーザー管理AndroidにGoogle Play
から正規installした後、各packageで次を行う。binary/decompiled/decrypted artifactはKoganeのpublic
repositoryへ入れず、既存のprivate Android archive repositoryにprovenanceとともに保存する。

```bash
PKG=jp.co.ccc.Tsite  # com.smbc_card.vpoint / com.smbc_card.vpass / jp.co.smbc.direct に変更
adb shell dumpsys package "$PKG" | grep -E 'version(Name|Code)|firstInstallTime|lastUpdateTime'
adb shell pm path "$PKG"
# 上で得た base.apk と全 split_config*.apk を一つずつ adb pull する
sha256sum artifact/*.apk
apksigner verify --verbose --print-certs artifact/*.apk
jadx -d jadx-out artifact/*.apk
apktool d -f artifact/base.apk -o apktool-out
rg -a -n 'https?://|wss://|retrofit|okhttp|graphql|grpc|protobuf|oauth|bearer|cookie|session|pin|certificate|integrity|attestation|safetynet' jadx-out apktool-out
```

- 全 split の signer digest が一致することを確認し、package/version/signer/hashをpublic provenance
  recordにも残す。APK/decompiled codeはprivate archiveだけへcommitする。
- Manifest、network security config、host/path、Retrofit/OkHttp/gRPC/GraphQL/protobuf schema、session/
  token 更新 call、Play Integrity/attestation/pinning library 候補を列挙する。
- R8/ProGuard、string encryption の deobfuscation、read method の runtime tracing は対象にできる。
  ただし token/cookie/key/PII/実値を log せず、pinning/integrity 判定を変更する hook は作らない。
- MobSF は local static scan に限定し、第三者 cloud upload、自動 dynamic action、binary 再配布をしない。

## 9. 静的解析 artifact と公開 third-party implementation の具体的 transport/auth

### 9.1 ユーザー管理の Vpass 5.12.0 静的解析 snapshot

ユーザー管理の非公開 repository にある Vpass `5.12.0` の JADX/apktool 解析 snapshot を参照した。
この snapshot は public third-party client ではなく、repository/commit/code への link は公開文書に
載せない。transport/schema の事実確認に限定し、APK/decompiled code を再配布・転載しない。snapshot
の metadata にある Google Play 由来/apksigner verified という provenance は、今回こちらで signer を
再検証した事実ではない。再現には、[公式 Google Play listing](https://play.google.com/store/apps/details?id=com.smbc_card.vpass)
からユーザー管理端末へ正規 install し、8.3 の手順で独立に signer/hash を確認する必要がある。

具体的な実装確認:

- `AppService.java` と `FaVpointAPI.java` は Retrofit/OkHttp/Gson による
  `POST https://spap.smbc-card.com/api/v3/fa/Vpoint` を実装する。
  request body は空の `AppRequest` である。
- `AppClient.java` と `BaseClient.java` では、条件付き `Authorization`、`X-App-Version`、
  `X-OS-Version`、app User-Agent、
  JSON content type/cache-control、`X-VappSessionTime`、cookie jar/interceptor が確認できる。
- `FaVpoint.java` と `FaVpointPoint.java` の response model は `cardIdentifyKey`、`pointAccountNumber`、
  `pointIntegration`、`points[] {pointAmount, expirationPoint, pointExpirationDate}` を持つ。ここでは値を
  取得/記録せず、field 名だけを確認した。Realm local cache への保存もある。
- 同 snapshot の protected DEX 解析は Vpass ID/password、永続 device UUID、push token、
  company/timestamp 等を app-layer 暗号 envelope
  にし、login token/cookie/session-time を組み合わせる auth flow を記載する。5.12.0 では RSA OAEP と
  AES-CBC の候補が確認されているが、秘密の取得/復号/replay は行っていない。

`Fa/Vpoint` は Vpass 側の残高/期限 bucket と連携状態を返す具体的 read endpoint である。一方、同じ
`AppService` から V Point の全履歴 endpoint は確認できず、app が web/V Point 側へ遷移する可能性が
ある。static な暗号手順だけでは、現行 device header、cookie、Akamai/session 条件を満たす renewable
client にはならない。これは B ではなく C 候補の材料である。

### 9.2 公開されている旧 Vpass scraper

[hdemon/vpass-scraper](https://github.com/hdemon/vpass-scraper/blob/902e5322e6f94f847742bd70c11d661857a090a4/get_current_state.py)
（2017、license 表示未確認）は Selenium/Chrome で `https://www.smbc-card.com/mem/index.jsp` に Vpass
ID/password を入力し、別画面でカード有効期限/CVV を使ってカード番号を表示する旧 DOM 実装である。
V Point の残高/履歴 client ではなく、sensitive card data を要求し、MFA/Akamai/現行 DOM を扱わない。
本 collector には採用しない。GitHub 検索では、現行 V Point Pay の個人向け read client、公式 public
API/SDK を確認できなかったが、不在を証明するものではない。

## 10. read-only 動的観測

### 10.1 2026-08-31 live検証結果

Kogane Capture Chromeでユーザーが通常loginしたsessionを使い、値を出力せずstatus、schema、件数だけを
観測した。Web画面のV会員番号はmaskされたままだったが、API requestには会員番号fieldがなく、session
だけで以下が成功した。

| endpoint                   | HTTP / application status | liveで確認した範囲                                                                 |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `POST /api/balance_info`   | `200` / `0000`            | `results.get_month/common/store/tmoney`; `common[]`の`point/expiration/point_type` |
| `POST /api/tpoint_history` | `200` / `0000`            | `total=149`; page 1-4各30件、page 5は29件、page 6は0件。全件走査と終端を確認       |
| `POST /api/smfg_point`     | `200` / `0000`            | `point_smbc`, `point_smcc`                                                         |
| `POST /api/rank_info`      | `200` / `0000`            | transportだけ確認。collector対象外                                                 |

履歴requestは`page`、`get_graph=1`、`sort=use`、獲得/利用/取消/失効/移行/訂正/期限延長/
再発行filter、`filter_date=""`のmultipartである。PoCは`results.total`へ達した時点で停止し、空の
終端pageを通常runでは要求しない。匿名sessionでは同じAPIがHTTP 200でもapplication status `0010`を
返すため、HTTP statusだけでlogin成否を判定しない。

このrunではKuebiko本体のrequest artifactにMy Page trafficが残らず、同時にattachされたChrome操作側の
CDPから確認した。複数debugger attachmentの競合が候補だが未確定であり、「Kuebikoに記録がない」ことを
「通信がない」という証拠にはしない。Cookie、会員番号、実残高、履歴値、加盟店、個人情報はrepositoryや
tool outputへ保存していない。

### 10.2 次の動的観測

1. **V Point web**: ユーザー管理 browser で通常 login し、残高/全 expiry bucket と履歴 1 page だけを
   開く。DevTools では origin、method、path template、status、content-type、field 名、pagination
   metadata だけを allowlist 収集する。`/api/balance_info` と `/api/tpoint_history` の request/response
   shape を照合し、値は即時破棄する。
2. **Vpass/SMBC**: 既存 login state がある場合だけポイント画面を開き、連携済み/未連携 route、旧履歴、
   100 件/1 年境界、Olive mode attribution を確認する。ID 連携、銀行口座画面、認証設定へ進まない。
3. **V Point Pay**: home 残高と既存利用明細だけを開き、最古日、page/count、authorization/settlement/
   refund/charge の field 名と state transition を観測する。コード表示、支払、チャージ、交換へ進まない。
4. **sanitization**: Cookie/Authorization/CSRF/OTP、query/body 値、ID、電話/氏名/生年月日、実額、
   merchant を capture 前または直後に削除する。HAR は既定で保存せず、field 名だけの合成 schema を
   作る。secret scanner と手動 review 前に共有しない。
5. **app metadata**: user-installed CA を app が通常受理する場合だけ、body/secret を保存しない local
   proxy で host/method/path/status/content-type を観測する。拒否/pinning/integrity error なら bypass
   せず、DNS/SNI/IP/timing のみへ戻る。
6. **runtime tracing**: URL builder、serializer/model、read method 呼出を対象にできるが、token/cookie/
   crypto key/OTP/PII/実値を log しない。write method の発火や security 判定変更 hook は禁止する。
7. **replay gate**: method/path/schema が明らかに read-only で、既存 session を安全に再利用できる場合
   だけ 1 件の idempotent read を隔離環境で試す。login/refresh と read/write scope を分離できない、
   または MFA/電話認証が再発する場合は B とせず browser/device/manual に戻す。

## 11. read/write 隔離

最小 allowlist:

- 既存 session の通常 login と read-only 再認証（新規登録/reset/設定変更を除外）
- V Point の残高、全 expiry bucket、履歴一覧/詳細、filter/sort/pagination の表示
- Vpass のポイント残高/期限/統合状態/旧履歴と、SMBC/Olive のポイント provenance の表示
- V Point Pay の既存残高、利用、settlement、返金、既存チャージ履歴の表示
- 公式画面に既存 CSV/PDF/export があれば、その既存 file の download

denylist:

- V Point/V Point Pay での支払、コード表示、チャージ、交換、移行、送付、出金、ポイント利用
- V会員番号/Yahoo! JAPAN/Vpass/SMBC ID の連携・解除、ID/会員統合
- passkey 登録/削除、password/passcode reset、電話/SMS/email/生体/通知/端末設定変更
- Olive/カード/銀行の支払、振込、振替、残高移動、口座/カード設定、申込、解約
- campaign/くじ/mission entry、規約同意を伴う新サービス開始

実装では origin + method + path allowlist を使い、既定を deny とする。`GET` だから安全、`POST` だから
write とは決めつけない。実際に V Point の read API は `POST` である。endpoint ごとに response field
と UI action を対応させ、未知 path、redirect、method、content-type では送信前に停止する。

## 12. Workers / Browser Run / Containers / OCI / Kubernetes 適性

- **Cloudflare Workers**: [Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) は外部
  HTTP API 呼出と JSON/HTML parser、schedule、schema normalization に適する。V Point internal API の
  session が人手で安全に bootstrap/renew でき、Cloudflare/Akamai に許容されることを live 証明した後の
  read collector に向く。device-bound app、電話/SMS/passkey、Android runtime には単体で不向き。
- **Cloudflare Browser Run**: [Browser Run の公式説明](https://developers.cloudflare.com/changelog/post/2026-04-15-br-rename/)
  は full browser session、record/replay、human-in-the-loop を提供する。V Point web の C、Vpass Web の
  D 候補だが、remote browser からの login が challenge を増やす可能性があり、秘密を recording に
  残さず、401/403/429/CAPTCHA で停止する必要がある。
- **Cloudflare Containers**: [Containers](https://developers.cloudflare.com/containers/) は任意 runtime、
  filesystem、既存 OCI image、CPU/memory intensive tool を Workers と組み合わせられる。Playwright、
  parser、jadx/apktool 等の隔離 job には Workers より適する。ただし Android device/emulator、Play
  distribution、device attestation、persistent secure session が必要な Pay collector の即時解決ではない。
- **OCI/container runtime**: local/CI の hardened OCI image は browser/parser/decompiler の version 固定、
  read-only filesystem、network allowlist、ephemeral secrets、artifact 非保存に最も実務的である。login
  profile と解析 image を分離する。
- **Kubernetes**: 多数 source の schedule、per-source NetworkPolicy、Secret provider、job isolation、
  retry/observability には向くが、この一 family には運用過剰。OTP/CAPTCHA/unknown write を自動 retry
  しない controller が必要で、Android device farm の security control bypass を正当化しない。

## 13. PR #5 共通の自動化レベル A-E と cost 1-5

共通定義:

- **A**: 公式/documented read-only API または公式 export を定期取得
- **B**: 安定した internal read API と renewable/reusable session を直接利用
- **C**: 人の browser/app login bootstrap 後に headless HTTP/browser replay
- **D**: full browser/device UI automation が継続的に必要
- **E**: 手動 capture/import

| route                               | 現時点の判定                 |    cost | 根拠/昇格条件                                                                                                                                                                  |
| ----------------------------------- | ---------------------------- | ------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V Point web                         | **C 候補**                   | **3-4** | 公開 JS で具体的な same-origin read POST/schema/pagination を確認。session renewal、MFA、Cloudflare、規約、schema stability を live 証明できれば B/3。公式 export/API は未確認 |
| Vpass app のポイント残高            | **C 候補**                   |   **4** | 現行 5.12.0 の host/path/model/auth envelope は具体化したが device/cookie/session/Akamai が必要。全履歴 endpoint は未確認                                                      |
| Vpass/SMBC/Olive web/app provenance | **D**                        |   **4** | 複数 ID、端末認証、legacy/linked route、銀行データ隔離が必要。限定 route の安定 API が確認できれば C                                                                           |
| V Point Pay                         | **D**                        |   **5** | app-only に近く、write と同居。保持期間/schema/transport/session/pinning/integrity は未確認                                                                                    |
| family 全体                         | **D**（ポイント側は C 候補） | **4-5** | Point と Pay を別台帳で完全に取るには device が残る。安全な初期 route は E/1                                                                                                   |

現時点で A は選ばない。公式 CSV/PDF/public personal API が確認できず、V Point web/Vpass endpoint は
internal implementation である。まず E/1 の sanitized sample で schema と二重計上防止を確定し、
V Point web だけを C として限定導入する。Pay を同時に無理に B/C 化しない。

## 14. live 検証チェックリストと stop 条件

read-only live 検証項目:

- [x] V Point My Page の `common`/`store` expiry bucket schemaと総残高API
- [x] 履歴の`results.total`、1 page件数、全page走査、行schema
- [ ] 履歴の利用日/反映日sort、各filter、detail、最古3年境界
- [ ] CSV/PDF/export 導線の有無と、存在する場合の期間、header、encoding、最大件数
- [ ] ID 連携済み/未連携を変更せず識別し、Vpass の旧履歴、1 年/100 件境界を確認
- [ ] Olive credit/debit/point mode と SMBC bank/card provenance label。銀行/カード実値は記録しない
- [ ] V Point Pay の最古表示日、page/count、authorization→settled、返金、既存チャージの表示形態
- [ ] Point→Pay 移行済みの二 ledger event に公開 link ID があるか。値を保存せず field 名だけ確認
- [ ] V Point/Vpass/Pay/SMBC ごとの login/MFA/passkey/biometric、session timeout、human handoff 点
- [ ] My Page/Vpass/Pay app の host/method/path/content-type/schema と read/write route の分離
- [ ] 401/403/429/CAPTCHA 時の retry 無効化、secret/PII redaction、unknown endpoint default deny

即時 stop:

- 支払、チャージ、交換、移行、ID 連携、認証設定変更、キャンペーン参加等の確認/実行 button が出た
- OTP、電話発信、passkey 登録、password/passcode reset、本人確認、規約同意が要求された
- Cookie/token/OTP/ID/電話/氏名/生年月日、実残高/実履歴/加盟店等が log/HAR/screenshot に残り得る
- 401/403/429、CAPTCHA、bot/interstitial、認証 loop、pinning/integrity/attestation error が出た
- unknown origin/path/method、write と read の scope/session が分離できない、想定外 request が発火する
- V Point と V Point Pay、V Money、カード/銀行台帳の asset/source boundary が判定できない

## 15. 結論、推測、未確認

### 確認できたこと

- V Point は通常、どこでも使える有効期限固定、ストア限定を分け、My Page 履歴は最大 3 年である。
  Vpass 未連携履歴は 1 年/100 件という別制限がある。
- V Point Pay は V Point と別のプリペイド台帳で、authorization 後に settled 額へ変わり、返金は
  後日プラス表示され得る。公開資料に保持期間/export は確認できない。
- V Point My Page の公開 JS は、残高・期限 bucket と履歴 pagination の具体的な first-party internal
  POST API/schema を含む。
- 通常login sessionを使ったlive検証で、会員番号をrequestへ渡さず、残高、SMBC内訳、履歴149件の
  全5pageをread-only APIから取得できた。匿名時はHTTP 200/application status `0010`、認証時は`0000`。
- ユーザー管理の Vpass 5.12.0 静的解析 snapshot は `spap.smbc-card.com/api/v3/fa/Vpoint`、
  Retrofit/OkHttp/Gson、header/
  cookie/session-time、残高/期限/連携状態 model を具体化する。
- V Point passkey は公式に確認できるが現時点で iOS 限定。Pay/Vpass/SMBC app の biometric unlock を
  passkey と見なせず、Bitwarden 固有互換も未確認である。
- V Point My Page は Cloudflare、Vpass/SMBC Direct は Akamai の介在を匿名 header で確認した。

### 推測/設計判断

- 統合 V Point の正本は V Point web/app、card/bank provenance は Vpass/SMBC、Pay ledger は V Point
  Pay と分けるのが最も二重計上を防ぎやすい。
- V Point web のread-only replay自体はlive証明できたためC/3のPoCへ進める。Bへの昇格にはrenewable
  sessionの生成・更新を証明する必要がある。family全体はPay deviceが残るためD/4-5と評価する。
- Vpass の `Fa/Vpoint` は残高/期限/連携状態用で、全履歴は V Point web へ委ねる可能性がある。

### 未確認

- 各 surface の公式 CSV/PDF/export、V Point の総件数上限、Pay の保持期間/page/count。
- 履歴/Pay の安定 row ID、原取引と返金、Point→Pay 二台帳を結ぶ link ID。
- V Point internal API の session/CSRF/refresh/rate limit/規約上の扱い、Vpass endpoint の現行 live 応答。
- V Point Pay/SMBC/V Point APK の host/path/schema、pinning/integrity 候補、Pay の app API/WAF。
- Bitwarden と V Point iOS passkey のサービス固有互換、Pay/Vpass の passkey availability。

## 16. 2026-09-05 Layer A raw-evidence実装

V Point web collectorは現在、browserなしのWorkers fetchとEmail Worker再認証で定期収集し、private R2をimmutable outboxとして使う。中央取り込みはcollectorとは別の`collector-r2-v-point` credentialとService Bindingに分離した。manifest v1/v2、prefix inventory、metadata、checksum、JSON schema、pagination、failure complement、collection summary、V Point Pay email reconciliationを全件検証してから、専用の中央runを冪等にsealする。大runは完全inventoryを固定し、HMAC署名済みcontinuationで最大8 artifactずつ転送し、seal後だけR2 scan位置を進める。

terminal run reportの`producerVersion`には固定source契約`vpoint-r2-v3`を使う。Importerのdeploy revisionをimmutable reportへ混ぜないため、異なる`IMPORTER_VERSION`で同じrunを再走査してもreport本文は変化しない。v3ではcollectorがtransport decode後に再encodeしたJSONを`collector_derived/transformed`、自由形式failure textを除いた中央manifestを`collector_manifest/generated`として登録し、中央が補うnullable fieldと空arrayを含むdescriptor hashまで実D1契約へ一致させる。deploy revisionは失敗・incomplete attemptの診断に限って保持する。

実 R2を変更せずに24 manifestを監査し、v1 5件、v2 19件、成功13件、失敗11件、reconciliation参照10件がstrict contractへ適合した。`bun run audit:vpoint-r2`で同じaggregate-only監査を再実行でき、本文、値、object key、個別hash、secretを出力しない。reconciliationは旧3件と現行7件でexact policy文字列が異なるため、観測した2値だけを明示的に受理し、任意文字列への緩和はしていない。candidateは実在history page・実row count内index・`sha256(JSON.stringify(row))`へ束縛し、entry内重複を拒否する。

V Moneyは同一session/APIで取得されるが別の電子マネー台帳である。現時点の監査済みaccountは全runで空pageなので、Layer AのV Point contractは空のV Money観測だけを保存可能とし、非空になった場合はfail closedする。非空履歴を自動帰属させる前に、独立source ID、asset/account境界、parser、reconciliation方針を別PRで設計する。

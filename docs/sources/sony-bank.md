# ソニー銀行: 公式 Web / 公式アプリ一次評価

- 調査日: 2026-08-26（Australia/Sydney）
- 対象: 個人向けソニー銀行口座だけ
- 非対象: 他行、証券会社、家計簿・資産管理 aggregator、振込・振替・売買・
  預入・解約・設定変更

## 結論

- **正本は公式 Web と公式 CSV** とする。円普通預金は公式に「過去すべて」の
  入出金履歴を閲覧でき、普通預金取引履歴を CSV で download できる。外貨は
  全通貨の外貨普通、外貨定期、為替リンク預金（外貨スタート型）をまたぐ入出金
  CSV があり、契約番号、摘要、入出金額、取引後残高、適用レート、円換算額、
  特約レートまで持つ。これらを初期 backfill と差分収集の第一候補にする。
- 残高の公式対象は広い。円普通・円定期・積立定期、外貨普通・外貨定期、
  円定期 plus+、為替リンク預金、投資信託、FX、Sony Bank GATE、住宅ローン、
  カードローンまで、公式 Web / 公式アプリまたは契約先向け参照系 API で残高照会
  対象と確認できる。ただし ledger が公式に用意されるのは主に円普通と外貨普通。
  定期・仕組み預金等は残高合計だけでなく、契約・預入ロットを別モデルで読む。
- Web の通常ログインは店番号3桁、口座番号7桁、ログインパスワードである。
  スマホ認証、物理トークン OTP、合い言葉は「重要な取引」の追加認証であり、
  passkey/WebAuthn ではない。公式資料、現行ログイン UI、公開 bundle のいずれにも
  passkey 対応は確認できなかった。Bitwarden は通常の店番号・口座番号・password
  を fill する候補であって、Bitwarden に保存されていることだけから passkey と
  判定してはならない。
- 現行 Web は 2025-05-06 のサービス更新後の Next.js SPA で、同一 origin の
  `/custom-web00` BFF に JSON を送る。public asset から login endpoint、request
  header、payload 構造、CSRF/revision/event-hash interceptor を確認できる。旧
  `o2o.moneykit.net` の HTML form scraper は現在 DNS 解決せず、そのままは使えない。
- 2026-08-26 の公開観測では `sonybank.jp` は Amazon CloudFront、静的画面は S3、
  BFF は AWS trace header を返した。Akamai は観測していない。一方、ログイン画面は
  PhishWall と Caulis の端末情報送信 script を明示的に読み、銀行も firewall、常時
  監視、自動 logout を案内している。CloudFront に AWS WAF が関連付いているか、
  bot score、headless/datacenter 判定条件は公開情報から確定できない。
- 公式アプリは二つある。`ソニー銀行 アプリ` は全商品の残高と認証・取引、
  `Sony Bank WALLET アプリ` は円/外貨普通預金と Visa debit 履歴・カード設定が
  中心。cloud collector の primary にせず、Web 認証補助と公式値の照合に使う。
  銀行公式の直接 APK 配布は確認できず、第三者 APK mirror は使わない。
- 現段階の総合評価は **実装コスト 4/5、自動化レベル B**。最初は通常 Chrome で
  login と公式 CSV download を低頻度で自動化し、現行 BFF の read endpoint が
  capture で確定した後だけ JSON replay を検討する。Workers 単体より、永続 profile
  を持つ local/OCI/Cloudflare Container が適する。

## スコープ、安全境界、調査方法

本人名義口座を銀行自身の Web / app から直接、読み取り専用で取得する経路だけを
対象とする。次を絶対条件とする。

- 口座 ID、店番号、口座番号、氏名、住所、メール、電話、実残高、取引内容、password、
  OTP、合い言葉、cookie、token、端末鍵を取得・記録・commit しない。
- 振込、振替、外貨売買、定期預入/解約、投信/FX 注文、loan 操作、証明書申込、
  情報連携同意、認証方式変更、app 再登録、通知/カード設定変更を行わない。
- 読み取り画面に `メモを編集` があっても、メモ登録は write なので触らない。
- login 失敗、401/403/429、challenge、追加認証、規約同意、登録情報確認、app 承認、
  CAPTCHA、account lock の兆候が出た時点で止め、自動 retry しない。

今回、認証済み口座へ新規 login せず、公開公式ページ、未認証の公式 login 入口、
公式配信の JavaScript/config、Google Play の公式掲載、公開 GitHub 実装を調べた。
未認証入口には架空値も含めて何も入力していない。公開 header の確認は HEAD/GET
だけであり、口座データや認証 cookie は取得していない。

情報源の優先順位は次の通りである。

1. ソニー銀行の公式 Web、公式 help、公式規約、公式配信 asset
2. ソニー銀行がリンクする Google Play の公式アプリ掲載
3. 実装方式の参考に限って、commit 固定した第三者公開コード
4. aggregator は初期経路にしない。公式 API の対象範囲を知る比較資料としてのみ参照

## 公式経路と取得対象

| 公式経路 | 読み取り対象 | 位置付け |
| --- | --- | --- |
| [ソニー銀行 Web](https://sonybank.jp/) / [現行ログイン](https://sonybank.jp/pages/db/dbca0100/input/) | 全商品残高、円通帳、外貨/定期/仕組み預金の残高・履歴、投信、FX、loan、電子交付 | primary。CSV/公式画面を保存する |
| [円預金・通帳](https://sonybank.jp/products/yen/) | 円普通の過去すべての入出金履歴、普通預金取引履歴 CSV | MVP と backfill の第一候補 |
| [外貨入出金履歴 CSV](https://sonybank.jp/products/fc/39.html) | 全通貨の外貨普通・外貨定期・為替リンク預金（外貨 start）の入出金 | 外貨の primary artifact |
| [外貨損益状況](https://sonybank.jp/tool/fc/40.html) | 商品/通貨別評価損益、直近2年の実現損益、開始から現在までの集計明細 | ledger と別の公式計算結果。必要なら第2段階 |
| [ソニー銀行 アプリ](https://sonybank.jp/tool/app/sb/) | 全商品残高、外貨普通取引、振込、OTP、情報照会 | 認証補助・manual 照合。取引機能は使わない |
| [Sony Bank WALLET アプリ](https://sonybank.jp/tool/app/sbw/) | 円/外貨普通残高、通貨別履歴、Visa debit 利用状況 | debit/普通預金の manual fallback |
| [情報連携サービス](https://sonybank.jp/services/api/) | 契約済み外部事業者へ残高・明細・金利・為替レート | 安定した公式 API だが aggregator 経由のため初期不採用 |
| [参照系 API 方針](https://sonybank.jp/stpl/161.html) | 預金、投信、FX、GATE、loan 等の残高/通帳 | 個人用 self-service token ではなく、適格企業との契約が必要 |

### 残高・口座対象範囲

[公式アプリの表示内容](https://sonybank.jp/tool/app/banking/01.html) と
[公式の参照系 API 一覧](https://sonybank.jp/stpl/161.html) を合わせると、少なくとも
次を公式に列挙できる。

| 商品 | 残高の粒度 | 履歴/明細の扱い |
| --- | --- | --- |
| 円普通預金 | 口座の現在残高。外貨送金の円貨未受渡金を含む場合がある | 通帳/CSV。過去すべての入出金 |
| 円定期預金 | 円預金合計と契約/預入明細 | 取引型 ledger ではなく元金、期間、満期、金利等の lot として取得 |
| 積み立て定期預金 | plan/契約と残高。app 表示金利は預入分の加重平均 | 積立 plan と各預入の関係を live 確認 |
| 外貨普通預金 | 通貨別 native 残高。未受渡金を含む表示がある | 通貨別取引履歴、全通貨横断 CSV |
| 外貨定期預金 | 通貨・契約単位。現在/予約 rate による円換算は参考値 | 横断 CSV では契約番号、元本/利息を分けた満期・中途解約明細 |
| 円定期 plus+ | 契約単位。未受渡金を含む | 円普通 ledger と分離。預入日の0時以降に商品明細へ反映 |
| 為替リンク預金 | 円 start / 外貨 start、通貨・契約単位。円換算は条件付き参考値 | 外貨 start は横断 CSV 対象。特約 rate を別 field に保持 |
| 投資信託 | 円建/外貨建、口座区分、fund、口数、基準価額、評価額/損益 | 取引履歴 CSV と電子交付書面があるが、預金 MVP 後に別 collector |
| FX | 有効証拠金、評価損益、建玉/入出金/取引履歴 | 独立取引 system。預金 collector に混ぜない |
| Sony Bank GATE | 募集中 fund の申込金、投資残高 | 独立商品。募集/償還 lifecycle を別モデル化 |
| 住宅・目的別・カード loan | 契約別残高/返済予定 | asset と相殺せず liability として保存。PDF は商品別に存在 |

アプリの総残高は円預金、外貨預金、仕組み預金、投資信託の未受渡金を含む一方、
FX の有効証拠金は総残高に含めない。native amount/currency、公式の参考円換算、
未受渡金、評価時刻を分離し、円換算値を簿価や約定 rate として扱わない。

契約先向け参照系 API は、円普通残高/通帳、円定期、積立定期、外貨普通残高/通帳、
外貨定期、rate、金利、円定期 plus+、為替リンク預金、FX、投資信託、GATE、住宅 loan、
カード loan の残高を公式に列挙している。これは対象範囲の強い根拠だが、銀行が
適格性を認めた企業との契約が前提で、Kogane が直ちに利用できる public API ではない。

## 明細の粒度、期間、件数、export

### 円普通預金

[円預金の公式案内](https://sonybank.jp/products/yen/) は次を明記している。

- 紙通帳ではなく Web の「通帳」で**過去すべて**の入出金履歴を確認できる。
- 「普通預金取引履歴」は CSV で download できる。
- [通帳 help](https://sonybank.jp/guide/bankbook/01.html) では開始/終了日の片方だけでも
  期間指定でき、入金/出金、昇順/降順、keyword で絞り込める。
- keyword は摘要、利用者が登録した入出金 memo、振込 EDI 情報を検索対象とする。

公式公開資料は1画面/1 download の最大件数、page size、同一日の順序保証、CSV の
文字 code と全 column を公開していない。第三者実装の 2025-05-18 時点の CSV parser
では `取引日`、`摘要`、`引出額`、`預入額`、`差引残高` を読み、Shift_JIS としている。
これは現行 2026 schema の保証ではなく、live fixture で再確認する。

銀行通帳のメモは40文字まで編集可能だが write なので collector は編集しない。
表示上の memo と EDI 情報が CSV に含まれるか、HTML だけかも live 確認事項である。

### 外貨普通・外貨定期・為替リンク預金

[外貨入出金履歴 CSV の公式仕様](https://sonybank.jp/products/fc/39.html) は、全通貨・
対象商品間の振替を含む履歴を古い順に一括 download し、次の9項目を持つ。

1. お取引日
2. 契約番号
3. 摘要
4. 入金額（外貨）
5. 出金額（外貨）
6. 取引後残高（外貨）
7. 適用 rate（TTS/TTB/TTM）
8. 取引円換算額
9. 特約 rate

満期・中途解約は元本と利息を分ける。外貨普通から外貨定期への預入など、商品間
振替も記録されるため、同一資産の内部移動を外部 income/expense と誤認しない。

外貨商品画面の「取引履歴」は取引完了時に作る一方、横断 CSV は他商品への振替
完了時に明細を作る。外貨建投信、外貨 MMF、募集型外貨定期、為替リンク預金の
未受渡中には残高差が出る。artifact type と取得時刻を保存し、瞬間的な不一致を
欠損と断定しない。

[外貨損益状況](https://sonybank.jp/tool/fc/40.html) は、直近2年の実現損益と、取引開始
から直近までの為替差損益/利息の集計明細を表示する。これは cash ledger の代わり
ではなく、銀行公式の tax/評価計算を別 artifact として保存する候補である。

### CSV、PDF、statement の整理

| artifact | 期間/対象 | 機械可読性 | 用途 |
| --- | --- | --- | --- |
| 円通帳 HTML | 口座開設後の過去すべて | DOM/BFF。件数/page 未確認 | 最新照合、memo/EDI |
| 円普通 CSV | 公式に download 可。過去全件を一度に出せるか live 確認 | 高い。2025例は Shift_JIS、5主要列 | primary ledger |
| 外貨横断 CSV | 外貨普通/定期/為替リンク外貨 start の全通貨入出金 | 高い。公式9項目 | primary FX/deposit ledger |
| 外貨損益集計 | 実現損益2年、集計明細は開始から現在 | HTML/CSV可否は live 確認 | 公式損益との照合 |
| 投信取引履歴 CSV | 公式に存在 | 高い。口座区分、取得単価等 | 投信専用 collector |
| 電子交付書面 | 外貨預金、投信、GATE、FX 等 | PDF | audit/reference |
| 通常預金の残高証明/statement | 指定日/期間。申込、手数料、郵送を伴う | 紙/手続 artifact | 自動収集対象外 |

普通預金通帳そのものの PDF download は公開資料で確認できない。残高証明書や
お取引明細書の申込は外部 write、手数料引落、郵送を伴うため、read-only collector
は絶対に申込まない。商品別電子交付 PDF は「閲覧/download」だけが明確な場合に限る。

## 認証、passkey、Bitwarden

### 確認できた事実

- [公式 login guide](https://sonybank.jp/guide/support/howtologin/) は、通常 login に
  店番号、口座番号、32桁以内の login password を入力すると説明する。2026-08-26の
  現行 login UI も3項目で、公開 bundle は3桁/7桁へ zero padding して JSON POST する。
- [公式認証一覧](https://sonybank.jp/guide/auth/) は重要取引用に、スマホ認証、物理
  token OTP、合い言葉の3方式を挙げる。どの方式でも Web 取引には login password
  等が別途必要である。
- [スマホ認証](https://sonybank.jp/guide/auth/01.html) は app 内6桁 OTP と、振込内容を
  app 固有暗号鍵で署名する transaction 認証である。利用端末は1口座1台。初回登録は
  Web 初回 login、cash card、状況により登録電話への SMS を使う。
- Web からの振込は app へ内容を通知し、利用者が振込先・口座・金額を確認して実行する。
  これは write 境界であり、Kogane は通知要求も app 実行も行わない。
- 2026-08-26 の app renewal は再登録/SMS 認証を要求し、pattern 認証、残高推移、
  一部絞込、通知履歴を削除する。旧版は一定期間使えるが通知が止まる。
- 公式 page と現行 login asset の語彙/実装から、WebAuthn、FIDO2、passkey、
  `PublicKeyCredential` は確認できなかった。

### Bitwarden と passkey の区別

| 状況 | 判定 |
| --- | --- |
| Bitwarden が店番号/口座番号/password を fill | password manager 利用。passkey ではない |
| browser が WebAuthn prompt を出し、RP ID に紐づく credential で assertion | passkey。ただしソニー銀行で未確認 |
| app の生体認証/PIN で app を開き6桁 OTP を表示 | app local unlock + OTP。passkey ではない |
| app が振込内容を確認して署名値を作る | transaction 認証。Web login passkey ではない |

Bitwarden vault の中身は開かない。live 検証では extension UI に表示される credential
type と browser の WebAuthn dialog 有無だけを利用者と一緒に目視し、値を capture、
log、environment variable、session envelope、Git に出さない。公開事実と異なる
「Bitwardenにあるからpasskey」という推測は採用しない。

### login と追加認証の境界

残高/明細の通常 login が password のみで完了する見込みは高いが、risk 判定による
step-up 条件は公開されていない。次のいずれかが出たら自動化は止める。

- OTP、合い言葉、cash card 製造番号、SMS、電話音声 code、app 登録/再登録
- `お客さま情報の確認/変更`、規約/電子交付への同意、認証方式変更
- 振込、振替、売買、預入、解約、限度額、カード/通知設定への遷移

読み取りに不要な OTP/合い言葉を collector secret として保管しない。

## 現行 Web の transport と session

2026-08-26 の未認証 public asset から、現在の login flow は次の構成と確認できた。

- `sonybank.jp/pages/db/...` は Next.js SPA。HTML/JS は S3 origin の CloudFront 配信。
- [`core.js`](https://sonybank.jp/pages/config/core.js) は BFF base を
  `/custom-web00`、認証 provider header を `FBaaS-Provider-Key: CustomAuth` と定義する。
- login bundle は `POST /custom-web00/dbca/cust-web/to-customers/login` を使う。
- JSON payload は `requestBizHdCommon.screenId = DBCA0100I1f`、
  `eventId = DBCA0100I1fE15` と、data 内の `branchNum`、`accountNum`、`loginPwd`。
- axios interceptor は CSRF token、locale、`FBaaS-SS: db`、
  `FBaaS-Revision: revision-<current>`、event hash を request に追加する。revision は
  public JSON で更新確認し、画面切替/timeout/error も BFF response に依存する。
- 2026-08-26 の public revision は691だったが deploy のたびに変わる。hard-code せず
  page asset が提供する値を使う。
- credential なしの BFF HEAD は401、CloudFront `Error from cloudfront`、
  `x-amzn-trace-id` を返した。401 は正常な未認証結果で、endpoint availability のみを示す。

ログイン password を JSON body で送る以上、BFF replay を実装する場合も auth request
body、headers、Caulis telemetry は raw evidence として保存しない。認証後 response の
read endpoint だけを allowlist し、write endpoint は source code と runtime egress
allowlist の両方から除外する。

session cookie の名前、idle/absolute lifetime、並行 session、IP/UA binding、logout 時
失効、cookie export/import 可否は未確認。画面遷移の local/session storage と cookie
だけを保存しても、Caulis/PhishWall state が足りない可能性がある。

## CDN、WAF、anti-bot / anti-fraud

### 確認できた事実

- `sonybank.jp` は 2026-08-26 に CloudFront IP を返し、public HTML は
  `Server: AmazonS3`、`Via: ...cloudfront.net`、`x-amz-cf-*` を返した。
- BFF の未認証 response も CloudFront 経由で、AWS `x-amzn-trace-id` があった。
- [公式セキュリティ案内](https://sonybank.jp/guide/securityinfo/07.html) は firewall、
  24時間365日監視、TLS、一定時間での自動 logout、フィッシング検知を明記する。
- [`env.js`](https://sonybank.jp/pages/config/env.js) は login page の PhishWall script
  7本と、Caulis の `static.fraud-alert.net` / `p.fraud-alert.net`、site ID、cookie domain
  `sonybank.jp`、login 専用 `Caulis.snbk_v3.min.js` を公開設定として持つ。
- login component は submit 時に Caulis hook を実行する。単なる HTML form 送信ではなく、
  JavaScript、BFF headers、anti-fraud telemetry を含む SPA flow である。

### 確認できなかったこと / 推測

- 現行経路で Akamai の DNS、header、script、cookie は観測しなかった。旧または別商品
  host での Akamai 利用を否定するものではないが、Sony Bank Web の現行 login を
  Akamai と記述する根拠はない。
- CloudFront distribution に AWS WAF / Bot Control が関連付いているかは header から
  確定できない。CloudFront を観測したことと AWS WAF 採用は別事実である。
- Caulis が送る端末情報、risk score、cookie、bank 側の decision rule、headless 判定、
  datacenter/cloud IP 判定は未確認。公開 config から anti-fraud 用途は強く示唆されるが、
  bot product としての具体的挙動を断定しない。
- PhishWall の存在は利用者保護/不正対策の事実であり、それ自体が browser automation を
  block するという証拠ではない。

従って、最初の login は公式対応 browser と通常 profile で行う。素の Worker `fetch()`
で login を再現できると仮定せず、低頻度、同一 profile、同一 UA/egress で成功/失敗を
測る。401/403/429 や challenge を bypass しない。

## 公式 APK / app と Web の役割

### 公式配布物

- ソニー銀行 アプリ Android package:
  [`net.moneykit.SonyBankApp`](https://play.google.com/store/apps/details?id=net.moneykit.SonyBankApp)
- Sony Bank WALLET アプリ Android package:
  [`net.moneykit.sbw`](https://play.google.com/store/apps/details?id=net.moneykit.sbw)
- 両方ともソニー銀行公式ページから Google Play / App Store へリンクされ、Play 掲載の
  developer は SONY BANK INCORPORATED。root 等の不正改造端末では使えない。
- 公式 site から直接 download する standalone APK は確認できない。Play の split APK/
  bundle を第三者 mirror から取ると provenance を失うため、Kogane の入力にしない。

### 役割分担

| surface | 強み | 自動化上の判断 |
| --- | --- | --- |
| 公式 Web | 全商品の画面、過去通帳、CSV、電子交付。browser から raw evidence を取りやすい | primary |
| ソニー銀行 アプリ | 全商品残高、OTP、transaction 認証、外貨普通取引、振込 | manual auth/照合。取引 UI は触らない |
| Sony Bank WALLET アプリ | 円/外貨普通残高、通貨別履歴、Visa debit の1年推移/継続利用 | debit 補完。設定機能が多く UI 自動化は危険 |
| 公式参照系 API | 最も安定した構造化 read | 契約した電子決済等代行業者向け。個人 Kogane の初期経路ではない |

ソニー銀行 アプリは2026-08-26に大きく更新され、再登録が必要になった。旧/新版が
併存する移行日なので、公開 screenshot や以前の app UI を固定仕様にしない。Web の
CSV と同一時点の app 表示を手動照合し、app transport 解析は Web で欠ける項目が明確に
なった後の別調査とする。certificate pinning、Play Integrity、app attestation、端末鍵
storage は未確認であり、回避しない。

## 公開第三者実装

第三者実装は transport の歴史資料としてのみ使い、credential handling や現行互換性を
信用しない。

### `mktakuya/puppeteer-sonybank-scraper`（2021）

[commit `3e59a37`](https://github.com/mktakuya/puppeteer-sonybank-scraper/blob/3e59a37d6e339c7d2e6bbba63e1581d983d6d07f/index.js)
は Puppeteer を headless 起動し、次を行う約40行の実装だった。

1. `https://o2o.moneykit.net/` を開く。
2. `input[name=TenNo]`、`KozaNo`、`Password` に環境変数を入力。
3. yellow login link を押し、navigation/network idle を待つ。
4. DOM `#setEnYkinZandaka` の文字列から comma を除き、円普通残高を integer 化。

browser DOM scraper であり API client ではない。外貨、定期、明細、pagination、OTP、
anti-fraud は扱わない。2021年当時に password login で残高 DOM へ到達する設計だった
ことは示すが、現行 host/SPA の成功証拠にはならない。

### `nakaomote/financial`（2019–2025）

[`sony_download.py`](https://github.com/nakaomote/financial/blob/44e1d43b5c010ee692234777baf9a9fc20be83be/sony_download.py)
は `requests.Session` と BeautifulSoup で旧 HTML protocol を再現する。

1. 旧 login HTML `NBG100001G01.html` を GET。
2. `TDGate1/gate/NBW000010` へ `TenNo`、`KozaNo`、`Password` と画面 ID 群を form POST。
3. response の全 hidden input を parse し、次の handoff form を POST。
4. `TDGate000036/gate/NBW000036/YenFutsuRireki.csv` に開始 `1900/01/01`、終了=当日を
   POST し、円普通履歴 CSV を取得。

[2025-05-18 commit `44e1d43`](https://github.com/nakaomote/financial/commit/44e1d43b5c010ee692234777baf9a9fc20be83be)
はサービス更新後の CSV 変更に対応し、download request から `__sid` を削除、parser を
header 名参照へ変更した。CSV は Shift_JIS とし、`取引日`、`摘要`、`引出額`、`預入額`、
`差引残高` を読む。Visa debit 摘要の末尾を merchant description として扱い、連続行で
前残高 + 入出金額 = 次残高を検算する。

この実装は transport、date range、CSV 列、残高検算の具体例として価値がある。しかし
2026-08-26 に `o2o.moneykit.net` は DNS 解決せず、公式入口は `sonybank.jp/pages/...`
へ移行している。旧 endpoint/field を現行に送る、DNS を迂回する、保存 credential を
流用することは禁止する。

### 現行実装への含意

- Puppeteer の「公式 browser で login し公式値を読む」という分離は再利用できる。
- Python 実装の「公式 CSV を raw 保存し、header 名で parse、残高連鎖を検算」は再利用
  できる。
- 旧 URL、旧 form field、旧 DOM selector、HTTP-only login は再利用しない。
- 現行 BFF は公開 bundle から request shape が見えるが、authenticated read endpoint は
  live Kuebiko capture で確認し、推測 URL を probe しない。

## 実行環境の適性

| 環境 | 適性 | 理由 |
| --- | ---: | --- |
| 利用者の local Chrome | 5/5 | Bitwarden fill、追加認証の目視、app handoff、CSV download が安全。最初の基準環境 |
| local/OCI 単一 container | 4/5 | Playwright/Chrome、persistent profile、download、Shift_JIS、cookie jar を扱いやすい。固定 egress と暗号化 volume が必要 |
| Cloudflare Container | 4/5 | full browser/Node を載せられる。R2/D1/DO coordinator と近い。Cloudflare egress で Caulis/risk 判定が変わるか要検証 |
| OCI Kubernetes | 3/5 | CronJob/Secret/volume は可能だが個人口座1件には過剰。Pod 再配置、同時実行、egress、profile volume を固定する必要 |
| Cloudflare Workers | 2/5 | 認証後の純粋 JSON/CSV replay なら候補。login は JS telemetry、cookie、CSRF、revision、event hash、download を伴い isolate 単体に不向き |

推奨構成は `Durable Object/cron coordinator -> one active Container -> R2 raw evidence`。
login issuer と read consumer を分けられるかは session export/import 検証後に決める。
現時点では同じ persistent browser profile で login から CSV download まで完結させる方が
変数が少ない。同一 source で cron/manual/遅延 run を並行させない。

OCI と Cloudflare Container の比較で重要なのは Kubernetes の有無ではなく、安定した
browser profile、1 source 1 active run、固定的な egress、secret 非出力、download 保存、
失効時停止である。K8s は多数 source/worker を分離する段階まで導入しない。

## 自動化レベル A–E と実装コスト 1–5

### 評価尺度

- **A**: 初回登録後は原則無人で定期実行できる
- **B**: 通常は無人だが、risk 判定、session 失効、画面更新時に手動復旧があり得る
- **C**: 毎回または頻繁に password manager / app / OTP 等の利用者操作が必要
- **D**: 利用者が公式 CSV/PDF を手動取得し、Kogane は import だけ行う
- **E**: 技術的/契約的に利用不能、または安全境界上実装しない

実装コストは 1=保存/import のみ、5=契約・複数 runtime・mobile/reverse engineering 等を
要するものとする。

| 案 | cost | level | 範囲 | 判断 |
| --- | ---: | --- | --- | --- |
| 利用者が円/外貨 CSV を公式 Web から取得 | 1/5 | D | 円普通、外貨横断 | **即時採用**。最も安全な backfill |
| local Chrome で password fill + CSV download | 3/5 | B | 円/外貨 CSV、残高画面 | **MVP 推奨**。更新/step-up 時だけ handoff |
| 現行 BFF の認証後 read replay | 4/5 | B、検証後A候補 | 口座列挙、残高、明細、lot | Kuebiko capture 後。login は browser のままでもよい |
| password login も pure HTTP/Worker で再現 | 4/5 | 未検証B | 同上 | telemetry/session 要件不明。最初に選ばない |
| 公式契約済み参照系 API | 5/5 | A | 公式一覧の広範な残高/通帳 | 適格企業との契約が必要。個人 MVP はE相当 |
| ソニー銀行 アプリ UI automation | 5/5 | C | 全商品表示、認証 | 1端末制限・SMS/生体・write UI 混在のため非推奨 |
| WALLET app UI automation/APK reverse engineering | 5/5 | C/E | debit/普通預金 | Web/CSV で不足する根拠が出るまで行わない |
| aggregator 情報連携 | 1–2/5 | A | 残高/明細等 | 公式 OAuth-like 同意だが初期経路から除外 |

総合判定は **cost 4/5、level B**。円/外貨 CSV だけの MVP は cost 3/5 まで下げられる。
次の条件を複数日、再起動後も満たせれば、認証後 read replay を A と再評価できる。

- 通常 login が追加認証なしで低頻度に成功する
- session/profile を encrypted storage から復元できる
- read endpoint が write endpoint と明確に分離できる
- CloudFront/Caulis が選定 runtime/egress を安定して受け入れる
- CSV と BFF/DOM の件数、入出金合計、末尾残高が一致する

## read-only live 検証計画

実口座を使う検証では、画面の値を report、terminal、screenshot、commit に出さない。
比較は件数/合計/末尾残高の一致・不一致だけを local ephemeral process 内で行い、出力は
boolean と schema metadata に限定する。

1. 利用者の通常 Chrome で公式 top から current login へ進み、URL と TLS 証明書を確認。
2. Bitwarden の item type が通常 login/password か passkey かを UI 表示だけで確認。
   値は表示/読み上げ/capture せず、利用者に fill してもらう。
3. 通常 login が店番号・口座番号・password のみで完了するか、追加認証が出るかを記録。
4. login 後に前回 login 日時と read-only dashboard であることを確認。表示残高は記録しない。
5. `商品/残高` から、契約のある product category 名と masked identifier の有無だけを確認。
   category ごとの件数を記録する場合も、amount や契約番号は残さない。
6. 円普通通帳で期間、入出金、昇降順、keyword、pagination/件数表示を確認。メモ編集は押さない。
7. 利用者操作で短い既知期間の円普通 CSV を download。file 名、MIME、encoding、header、
   page/期間上限、stable ID 有無だけを local 解析し、実 row は保存先から外へ出さない。
8. 外貨契約がある場合だけ、同様に外貨横断 CSV の9項目、小数桁、currency 表現、契約番号
   masking、未受渡行を確認。外貨売買/定期操作へは進まない。
9. Kuebiko は auth request body/header と anti-fraud telemetry を upload 対象から除外し、
   authenticated response の host/path/MIME/status だけを allowlist 候補として観測する。
10. 同一期間の公式 CSV と read DOM/BFF を local で件数、入金合計、出金合計、末尾残高だけ
    照合し、差があれば未受渡/取消/表示時刻/期間境界を確認する。
11. 無操作15分、browser 再起動、翌日の順に session を検証。失効時は login redirect を
    正常に検知して止まり、credential login を自動 retry しないことを確認する。
12. local 基準が安定した後だけ OCI/Cloudflare Container で1回ずつ同じ read flow を実施。
    egress、UA、profile を固定し、401/403/429/challenge の差だけを記録する。

### stop 条件

次のいずれかでその run を直ちに終了し、cookie jar/profile の再利用を保留する。

- 401、403、429、Access Denied、challenge/CAPTCHA、maintenance、system error
- password/OTP/合い言葉の誤り、account lock、再設定、認証方式変更の案内
- SMS、電話、cash card 製造番号、app 再登録、transaction 認証の要求
- 未認証/認証済み URL の予期しない変化、TLS certificate/host の不一致
- read allowlist 外への request、または振込/振替/売買/預入/解約/申込/変更 endpoint
- CSV/DOM/BFF の schema 変化、合計/末尾残高の不一致、partial download の疑い
- 実口座 ID、残高、明細、secret、PII が log/capture/PR に出た疑い
- 同一 session generation の並行使用、session expiry、profile corruption

失敗後は同じ login を自動再送しない。既存 session の authenticated 状態を読み取りで確認し、
二重実行や lock の可能性を排除してから利用者へ handoff する。

## 推奨実装順

1. 手動取得した公式円/外貨 CSV の local importer を作り、raw file を content hash で保存。
2. 円普通 CSV の現行 schema fixture を実データ匿名化ではなく、構造だけの synthetic fixture
   として作る。実 row を Git に入れない。
3. 通常 Chrome の persistent profile で login と CSV download を1 source 1 active run にする。
4. Kuebiko capture から authenticated read endpoint を特定し、path allowlist を作る。
5. CSV と同一期間の read JSON/DOM を照合し、read-only BFF replay を追加する。
6. 円普通が安定してから外貨横断 CSV、定期/積立/仕組み預金 lot、投信等を別moduleで追加。
7. local で複数日安定後、OCI または Cloudflare Container へ移す。Workers は coordinator、
   session lease、ingestion に限定し、login fetch は後回しにする。

## 未確認事項

- 実口座の現在の認証方式と、通常残高 login での step-up 頻度
- Bitwarden item が通常 credential か passkey か（値は確認不要）
- 2026-08-26 renewal 後の app login が biometric/PIN のどちらで、旧版併存がいつまでか
- 現行円普通 CSV の全 column、encoding、quote/newline、最大期間/件数、stable ID、同日順
- 通帳 HTML/BFF の page size、pagination、memo/EDI の export 可否
- 外貨横断 CSV の保持開始日、最大件数、一括範囲、currency precision
- 円定期、積立定期、外貨定期、仕組み預金の現行 lot field と終了済み契約の保持期間
- current BFF の authenticated read endpoint、response schema、CSRF/cookie/session lifetime
- Caulis/PhishWall が login acceptance に与える条件、Cloudflare/OCI egress の評価
- CloudFront に AWS WAF/Bot Control が関連付くか。Akamai は現行 login で未観測
- session の browser/profile 間 export/import と同時 session の扱い
- 公式 app の certificate pinning、Play Integrity、attestation、端末 secure storage
- 普通預金 ledger の PDF download 有無（公開資料では CSV のみ確認）
- 参照系 API の開発環境/仕様書を個人が契約なしで利用できるか（現状は不可と評価）

## 主要参照

### 公式一次情報

- [ソニー銀行 Web](https://sonybank.jp/)
- [ログイン方法](https://sonybank.jp/guide/support/howtologin/)
- [ソニー銀行の認証方式](https://sonybank.jp/guide/auth/)
- [スマホ認証方式](https://sonybank.jp/guide/auth/01.html)
- [ソニー銀行のセキュリティ対策](https://sonybank.jp/guide/securityinfo/07.html)
- [円預金 / 過去すべての通帳と CSV](https://sonybank.jp/products/yen/)
- [通帳 help](https://sonybank.jp/guide/bankbook/01.html)
- [外貨入出金履歴 CSV の表示内容](https://sonybank.jp/products/fc/39.html)
- [外貨預金 損益状況](https://sonybank.jp/tool/fc/40.html)
- [ソニー銀行 アプリの表示内容](https://sonybank.jp/tool/app/banking/01.html)
- [二つの公式アプリの違い](https://sonybank.jp/inquiry/app/01.html)
- [Sony Bank WALLET アプリ](https://sonybank.jp/tool/app/sbw/)
- [2026-08-26 アプリ renewal](https://sonybank.jp/info/2026/0724-01.html)
- [情報連携サービス](https://sonybank.jp/services/api/)
- [参照系 API の対象一覧](https://sonybank.jp/stpl/161.html)
- [API 接続先の適格性基準](https://sonybank.jp/stpl/162.html)
- [現行 Web core config](https://sonybank.jp/pages/config/core.js)
- [現行 Web environment / anti-fraud config](https://sonybank.jp/pages/config/env.js)

### 公開第三者実装

- [`mktakuya/puppeteer-sonybank-scraper` commit `3e59a37`](https://github.com/mktakuya/puppeteer-sonybank-scraper/blob/3e59a37d6e339c7d2e6bbba63e1581d983d6d07f/index.js)
- [`nakaomote/financial` `sony_download.py` at `44e1d43`](https://github.com/nakaomote/financial/blob/44e1d43b5c010ee692234777baf9a9fc20be83be/sony_download.py)
- [`nakaomote/financial` 2025 CSV schema update](https://github.com/nakaomote/financial/commit/44e1d43b5c010ee692234777baf9a9fc20be83be)

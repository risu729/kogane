# 三菱UFJ銀行（MUFGダイレクト／銀行アプリ）

調査日: 2026-08-26

## 結論

Kogane の一次データ源には、まず **三菱UFJダイレクトのブラウザ版**を使う。
初回はユーザーが MUFGあんしんパスを登録したスマートフォンでログインを承認し、
ログイン後はサービス指定口座の一覧・残高・明細画面と公式 CSV/PDF を保存する。
ブラウザ版は円預金 CSV、外貨普通・貯蓄預金 CSV、Eco通帳の最大25カ月、
取引推移表 PDF の最大10年を同じ契約から取得でき、銀行アプリより出力機能が多い。

完全無人化の見込みは **中**、実装コストは **4/5** と評価する。理由は、銀行のデータ画面そのものは
通常の Web UI として自動操作できる一方、2026年開始の MUFGあんしんパスは登録スマートフォン1台と
生体認証を必須にし、PCなどからのログインも同端末での承認を要求するためである。ユーザーが「passkey」と
呼んでいるものが Bitwarden 同期型 WebAuthn パスキーなのか、公式が案内する FIDO 準拠の銀行アプリ生体認証／
MUFGあんしんパスなのかは、実画面で区別する必要がある。公式資料では Bitwarden 等へ保存できる
WebAuthn パスキーをログイン手段として案内していない。したがって現時点では、Bitwarden はログインパスワードの
安全な受け渡しには使えても、登録スマートフォンの承認を代替しないと扱う。

公開ログインSPAの静的解析により、現行WebはHTML formの直送ではなく、JSON BFF、CSRF cookie/header、
画面ID、端末フィンガープリント、cookie付きセッション延長を使うことまで確認できた。従ってreverse engineeringを
後回しにはせず、公開artifactの静的解析と、本人操作のread-only画面に限定した実通信metadata観測を並行する。
ただし、認証後の残高・明細endpointやsession replay可能性はまだ確定しておらず、公開JSだけから推定しない。

公式の三菱UFJダイレクト API は存在するが、外部サービス会社との契約・同意を前提とする。
個人開発者が自分の本番口座用トークンをセルフサービス発行できる入口は確認できず、Kogane の初期経路にはしない。
Mable は終了済みで、後継 Money Canvas は Moneytree を使って金融機関明細を取得するため、
「銀行公式サイト／公式アプリを直接データ源にする」という本調査の条件にも合わない。

## 調査範囲と非目標

- 対象は個人向け三菱UFJ銀行口座、三菱UFJダイレクト、公式「三菱UFJ銀行」アプリ、旧 Mable と後継の位置付け、
  および個人向けダイレクト API の可否だけである。
- 三菱UFJカード、My Digital Connect、JAL/J-WEST、証券、他行、BizSTATION はデータ源として調査しない。
- 読み取り専用で評価した。振込、振替、定期・外貨取引、口座登録、Eco通帳切替、ポイント申込、設定変更は行っていない。
- 認証済み口座へのログインは行わず、実残高、口座番号、契約番号、氏名、秘密、Cookie、OTP は取得・記録していない。
- 公式ページ、公開ログイン面の HTTP/DNS、Google Play 公開情報、公開 GitHub コードだけを使用した。

## 公式入口

| 経路                          | 入口                                                                                                                                                                                                       | 読み取り可能な主なデータ                                                                                 | 出力／自動化上の位置付け                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 三菱UFJダイレクト（ブラウザ） | [公式トップ](https://direct.bk.mufg.jp/index.html)、[現在のPCログイン画面](https://directg.s.bk.mufg.jp/APL/LGP_P_01/PU/LG_0001/LG_0001_PC01)                                                              | 代表口座とサービス指定口座、残高、円入出金、定期預金明細、外貨預金、取引記録、直近の銀行ポイント加算実績 | **推奨**。CSV/PDF/印刷を持ち、Playwright等の通常ブラウザで観測しやすい。ログインはスマホ承認を要する可能性が高い。                                         |
| 公式「三菱UFJ銀行」アプリ     | [Google Play (`jp.mufg.bk.applisp.app`)](https://play.google.com/store/apps/details?id=jp.mufg.bk.applisp.app&hl=ja)、[公式案内](https://direct.bk.mufg.jp/btm/banking/sp_appli.html)                      | 残高、入出金明細、定期預金、外貨預金等。スマホ版明細は最大200件                                          | 表示確認と認証発行元として重要。ただし円明細の印刷ボタンがなく、公式CSVもPCブラウザ限定。端末紐付け・root検知があり、主収集器には不向き。                  |
| 三菱UFJダイレクト API         | [サービス説明](https://direct.bk.mufg.jp/btm/ser_naiyo/api.html)、[利用規定](https://direct.bk.mufg.jp/btm/kitei/api.html)、[開発者ポータルFAQ](https://developer.portal.bk.mufg.jp/btmu/openapitrial/faq) | 口座情報、入出金明細、定期預金明細等。アクセストークン方式                                               | 公式かつ理想的だが、対象サービス提供会社との連携が前提。体験環境から個人用本番クライアントへ進む公開セルフサービス経路は確認できない。初期コスト **5/5**。 |
| Mable                         | [公式終了案内](https://www.bk.mufg.jp/tsukau/app/lp/mable/moneycanvas/index.html)                                                                                                                          | 旧家計管理・つかいわけ口座操作                                                                           | **2024-03-27終了**。既存ユーザーもアプリは利用不可。収集経路にしない。                                                                                     |
| Money Canvas                  | [Mableとの差分・移行FAQ](https://faq01.bk.mufg.jp/faq/show/4980?site_domain=moneycanvas)、[更新遅延FAQ](https://faq01.bk.mufg.jp/faq/show/4979?site_domain=moneycanvas)                                    | 資産・明細・推移。Mableデータの一部を移行可能                                                            | 銀行提供サービスだが、金融機関明細は Moneytree サービスで取得する。つかいわけ口座操作・各種入出金通知も移行されない。aggregator 回避条件に反する。         |

## 口座列挙と残高

三菱UFJダイレクトのトップは代表口座残高を表示し、ほかの残高は「口座一覧／ほかの口座残高」から確認する。
保有口座が見えない場合は、利用口座（サービス指定口座）への登録が必要である。
この登録自体は設定変更なので、本 PoC では自動実行しない。

[個人向けダイレクト API 利用規定](https://direct.bk.mufg.jp/btm/kitei/api.html) は、
サービス指定口座について連携可能な10種類を公式に列挙している。銀行預金として本調査に関係するのは、
普通預金、貯蓄預金、当座預金、定期預金、外貨普通預金、外貨貯蓄預金、外貨定期預金、財形預金である
（規定には別途マイカードと投資信託も含まれる）。Web画面もサービス指定口座単位で残高・明細を表示する。

- **普通預金／スーパー普通預金（メインバンク プラス）**: スーパー普通預金は優遇機能付きの普通預金であり、
  別の収集経路ではない。代表口座またはサービス指定口座として同じ口座一覧・円明細経路に載る。
- **つかいわけ口座**: [現行規定](https://www.bk.mufg.jp/regulation/tsukaiwake.html) 上、キャッシュカードを発行しない
  普通預金（Eco通帳）で、開設時にサービス指定口座へ自動登録され、登録削除はできない。
  Mable終了後も普通預金として存続する。[取引推移表もダイレクト上で申込可能](https://faq01.bk.mufg.jp/faq/show/5533?site_domain=default) である。
- **円定期預金**: サービス指定口座の口座合計残高と現在の預入明細を全件照会できる。
  [公式ヘルプ](https://directg.s.bk.mufg.jp/refresh/ib_help/yen_teiki.html) はページ送りの存在を明記するが、
  個人向けCSVは案内していない。夜間・休日受付は明細への反映が翌営業日8時頃になる場合がある。
- **外貨普通／貯蓄／定期**: [外貨預金ヘルプ](https://directg.s.bk.mufg.jp/refresh/ib_help/gaika.html) で、
  全保有外貨預金の合計円換算額と各口座残高、口座別明細を取得できる。外貨貯蓄預金では現在の引出可能額も表示される。
  外貨定期は現在保有する全預入明細を表示する。

残高の過去時点系列を口座一覧から直接取得する機能は確認できない。円預金は各取引後残高を明細から再構成し、
定期・外貨はスナップショットを継続保存する必要がある。

## 明細、期間、件数、確定状態

### 円普通・貯蓄等の入出金

[現行ブラウザヘルプ](https://direct.bk.mufg.jp/fw/ib_help/meisai.html) による仕様は以下である。

- 初期表示は代表口座の最近30日。
- Eco通帳は最大25カ月。非Eco通帳は前月1日から当日まで。
- Eco通帳の「取引推移表」は、申込により最大10年の過去明細を PDF で取得できる。
- ブラウザのCSVは **口座単位**、PCのみ。「全取引／入金／出金」は1回200件まで、
  「振込入金」は100件まで。件数超過時は期間を分割して取得する必要がある。
- 画面の取引種別フィルターは全取引、入金、出金、振込入金。スマホアプリの表示上限も最大200件。
- 印刷画面には氏名・店番・口座番号等が含まれるため、Kogane の公開ログやGitには保存しない。
- Eco通帳の任意メモは1明細7文字、最大25カ月だが、メモ変更は書き込みなので収集器は操作しない。

公式は個人向けCSVの列仕様を公開ページ上で詳述していない。現在も更新される第三者の
[Zaim CSV Converter のMUFG行モデル](https://github.com/yukihiko-shinoda/zaim-csv-converter/blob/66b93b514bc12f45c29c349e6a84cc39ad9b1f39/zaimcsvconverter/data/mufg.py)
は、日付、摘要、摘要内容、支払額、入金額、残高、メモ、未記帳フラグ、入出金種別を読み込む。
これは有力なCSV粒度の証拠だが、銀行の現行仕様書ではないため、実ファイルのヘッダーだけを秘密なしで再確認する。

### 円定期・外貨

- 円定期は「履歴」ではなく、現在預け入れている明細と口座合計残高が中心である。個人向けCSVは確認できない。
- 外貨普通・貯蓄の照会期間は口座形式で異なる。通帳式は原則40日、照合表口は40日または220日、
  インターネット支店の無通帳式は原則60日。照会条件と同じ範囲を口座別CSVで取得できる。
- 外貨定期／インターネット外貨定期は現在保有する全明細を表示するが、公式ヘルプは **CSV不可** と明記する。
- 外貨の過去取引・通知物は Eco通知も調査対象になるが、文書種別・保存期間・機械可読性は実契約で未確認。

### 保留・確定の扱い

入出金明細／CSVは口座へ反映された記帳済み取引として扱う。カードのような「保留中明細」フィールドは
公式ヘルプで確認できない。一方、[お取引記録](https://directg.s.bk.mufg.jp/refresh/ib_help/kiroku.html) は
最大6カ月（照会操作は2カ月）、50件/ページで、`受付完了`、`処理中`、`取引完了`、`エラー`、処理予定日を持つ。
`取引完了` 後でも振込先情報相違により後からエラーになる場合があると公式が明記する。

Kogane は次の2系列を混ぜない。

1. 入出金明細／CSV: 口座へ反映済みの ledger evidence。
2. お取引記録: 受付・処理予定・完了・エラーの operational evidence。状態が完了するまで pending として別保存する。

読み取り専用のため、お取引記録を確認しても再実行・取消・振込は行わない。

## ポイント

銀行口座側で直接確認できるのは、主にスーパー普通預金の **メインバンク プラス Pontaポイント** である。
[公式案内](https://www.bk.mufg.jp/kouza/yugu/mb/pointservice/index.html) は、ダイレクトで見えるのは
直近1カ月分の加算ポイントであり、ボタンから PontaWeb（外部サイト）へ移ると説明する。
したがって銀行側だけではPonta総残高・長期履歴の完全なポイント台帳にならない。

公式銀行アプリはカードの利用状況・ポイント照会も掲げるが、
[公式ヘルプ](https://direct.bk.mufg.jp/fw/ib_help/credit_shoukai.html) 上は、登録したカード認証情報を使って
別の会員Web画面へログインし表示する機能である。これは銀行預金データではないため、銀行コレクターは
グローバルポイント等を取得しない。銀行側のPonta直近実績と、別ポイント経路の残高・履歴は異なる source として分離する。

## 認証とセッション

### 確認できた事実

- 通常ログインは代表口座の店番・口座番号または契約番号と、8～16桁のログインパスワード。
- [MUFGあんしんパス](https://direct.bk.mufg.jp/secure/ansnps/index.html) は2026年の公式機能で、
  登録スマートフォン1台と指紋／顔認証を必須にする。登録端末以外のスマホやPCは、ブラウザでパスワード入力後、
  登録スマホでの承認が必要。二次元コードは都度生成され再利用不可。機種変更・アプリ再インストール時は再登録が必要。
- 従来の銀行アプリ生体認証も [FIDO準拠](https://direct.bk.mufg.jp/btm/banking/sp_appli/seitai.html) だが、
  公式は一般の同期型「パスキー」と同一とは説明していない。
- 振込等の資金移動にはアプリまたはカードのワンタイムパスワードが必要。銀行アプリのOTP登録は1契約1台で、
  別端末登録・機種変更で再登録となる。ただし本コレクターは資金移動画面を呼ばない。
- 普段と異なる端末／ネットワーク、本人以外の可能性を検知すると、Eメール6桁OTPやキャッシュカード暗証番号を
  追加要求し、特に高リスクなアクセスは拒否することを
  [公式FAQ](https://faq01.bk.mufg.jp/faq/show/63?site_domain=default) が明記する。

### 未確認

- ログイン済みCookieの正確な寿命、Chrome再起動後の再利用、IP・OS変更後の有効性。
- MUFGあんしんパス承認後に同一セッションをWSL/OCI/Cloudflareへ移送できるか。
- 閲覧だけの再ログインでも毎回スマホ承認が必要か、信頼済みブラウザ状態があるか。
- ユーザーの Bitwarden 内の「passkey」がこの銀行ログイン画面で本当に WebAuthn credential として提示されるか。

秘密は Bitwarden から実行時だけ取り出し、ログ、画像、raw evidence、環境ダンプへ出さない。
認証失敗時に高速再試行せず、手動承認または新セッション発行へ戻る。

## Akamai、WAF、anti-bot

### 確認済み

2026-08-26 の公開DNS確認では `direct.bk.mufg.jp`、`directg.s.bk.mufg.jp`、`entry11.bk.mufg.jp` が
`*.edgekey.net` を経由して `*.akamaiedge.net` へ解決した。従って **Akamai CDN/edge の利用は確定** である。
公開トップとログインHTMLを通常の `curl` で取得したところ200で、明示的なBot Manager cookieやchallengeは観測しなかった。
またログイン面は User-Agent Client Hints を要求し、MUFG公式FAQは端末・ネットワーク環境のリスク分析を明記する。

### 推測・未確認

Akamai Bot Manager/WAF が認証POSTまたはログイン後APIを保護しているかは未確認である。
edgekey/akamaiedge のDNSだけではBot Manager採用を証明できない。資格情報を使った試験は行っておらず、
403、Akamai参照番号、`_abck`、`bm_sz` 等も観測していない。従って設計上はanti-botを想定するが、
Vpass等の別サービスでの挙動をMUFG銀行へ転用しない。

## 公開Web SPA／BFFの静的解析

2026-08-26に[現在のPCログイン画面](https://directg.s.bk.mufg.jp/APL/LGP_P_01/PU/LG_0001/LG_0001_PC01)と、
同HTMLが参照する公開JavaScriptを資格情報なしで取得して静的に確認した。ログインHTML自身に`form`はなく、
Angular SPAが`/APL/LGP_P_01/`をbaseとして起動する。公開configには次の接続先が含まれる。

- login BFF: `https://entry11.bk.mufg.jp/ibg/dfw/APLIN/bff_lgp/v1/ib`
- login後候補: `https://entry11.bk.mufg.jp/ib/dfw/APLAG/bff_go/v1/ib`および
  `https://entry11.bk.mufg.jp/ib/dfw/APLS`
- session延長: `/BFF_LG_1000_01`、framework log: `/BFF_LG_1000_03`

公開login serviceは`/BFF_LG_0001_01`～`05`を定義する。`02`は店番・口座番号・契約番号・
ログインパスワードに加え、`devicePrint`、browser language、timezoneをJSONで送る。
`03`は追加認証区分、カード暗証番号／EメールOTP候補、再度の`devicePrint`を持ち、`04`はQR情報取得、
`05`はout-of-band承認状態確認である。これは**公開コード上のrequest schema候補**であり、各フィールドが
毎回送られる、または現在の契約で必ず要求されることを意味しない。値は取得・記録していない。

共通transportは`drb-CSRF-Token` cookieを`CSRF-Token` headerへ写し、`X-Screen-ID`と
`X-Screen-Event-ID`を付け、`withCredentials`付きPOSTを行う。`drb-ak` cookieがあれば
`X-Trusteer-Rapport: ak=...;`も付ける。session延長BFFはCSRF/header/cookieとsequence値を使う。
公開`encode_deviceprint()`はuser agent、OS/browser、画面、timezone/language、plugin、cookie可否、
proxy timing、任意の位置情報等をまとめ、入力イベント収集器はfocus/blur/key/pasteの回数や長さ等のmetadataを扱う。
symbol/header上はRSA系device-print実装と判断できるが、特定の不正検知製品名やserver側判定は未確認である。

この確認により、ログインBFFの存在、CSRF/session枠組み、端末risk signalは確定した。一方、認証後の
残高・口座列挙・円／定期／外貨明細のendpoint、response schema、pagination、token/cookie寿命は未確認である。
公開assetにはsource map参照を確認できず、認証なしでBFFを呼ぶ必要もない。次段階は本人操作のログイン時に
DevTools/Kuebikoでmethod、origin、path template、status、content type、field **name**だけを観測する。
request/response body、cookie、CSRF、OTP、口座識別子、実値はcapture時点で破棄する。

## Androidアプリ、正規split取得、静的／動的解析

[銀行公式アプリページ](https://direct.bk.mufg.jp/btm/banking/sp_appli.html)のGoogle Playリンクは
package `jp.mufg.bk.applisp.app`を直接指す。2026-08-26に取得した
[Google Play公開ページ](https://play.google.com/store/apps/details?id=jp.mufg.bk.applisp.app&hl=ja&gl=JP)は、
developer `MUFG BANK, LTD.`、version `13.11.0`、更新日2026-08-05、500万件以上ダウンロードを表示した。
銀行公式ページからのリンク、Playのdeveloper、packageの三点をprovenanceとする。銀行サイトからの独立した
公式APK直配布は確認できず、公式導線はGoogle Playである。Play App Bundleの場合はbase APKだけでなく、
端末に配信されたconfiguration/feature split一式が必要になる。

Playの公開説明はroot化履歴のある端末やroot化ツール導入端末で正常動作しない可能性、電話・位置情報権限、
生体認証・OTPを明記する。位置情報は不正アクセス検知精度向上のためで任意とされる。これはintegrity/risk判定の
候補を示すが、Play Integrity、SafetyNet、独自root検知のどれかはartifactなしでは確定しない。

本調査環境にはADB、Android SDK build tools、jadx/apktoolと接続済みの本人所有Android実機がなく、
Google Play認証済み端末から正規artifactを取得できなかった。非公式mirrorはprovenanceを満たさないため使わない。
再現可能な正規取得手順は次の通りである。

1. 本人所有の非root Androidで、上記銀行公式ページからGoogle Playへ進み対象packageをインストールする。
2. 本人の同意の下でUSB debuggingを有効化し、`adb shell dumpsys package jp.mufg.bk.applisp.app`で
   versionName/versionCode、installer、split名を記録する。`adb shell pm path ...`でbase/splitのpathを列挙する。
3. shellから読める場合だけ全base/splitをprivate作業領域へ`adb pull`し、SHA-256と
   `apksigner verify --print-certs`のsignerを記録する。pull不可ならそこで停止し、root化や保護回避をしない。
4. binary、署名以外の端末情報、アカウント情報はGitへ入れず、解析後にprivate artifactの保持要否を再確認する。

正規split一式を取得できた時点で、次を静的に確認する。

- manifestのpermission、exported component、App Links/custom scheme、min/target SDK、backup/debuggable、
  native library、Network Security Config／cleartext設定を列挙する。
- hostname/path文字列、WebView、OkHttp/Retrofit等のtransport、JSON/protobuf等のschema候補を抽出する。
- Android Keystore、BiometricPrompt、FIDO2、MUFGあんしんパス、Play Integrity/SafetyNet、root/debug検知、
  certificate pinningのlibrary/config候補を探す。存在はartifactで確認できたものだけを事実に昇格する。
- 口座一覧・円明細・定期・外貨のreadが公開Webと同じBFF/WebViewか、native専用APIかを切り分ける。

静的解析と並行して、本人操作で残高・口座一覧・各明細を開くread-only runtime tracingを調査対象にする。
まずAndroid Studio Network Inspector（appがprofileableな場合）、標準proxy/PCAP metadata、絞り込んだlogcatを試し、
method、origin、path template、status、content type、呼出順、schema field名だけを残す。Frida/Objection等のhookは、
本人所有端末でappが通常動作する範囲に限り、network client methodやWebView navigationのmetadata観測に使える。
root/debugger/integrity/pinning検知でappが停止した場合は**その時点で停止**し、証明書差替え、pinning無効化、
attestation偽装、root隠蔽等のsecurity-control bypassは行わない。取引系endpointは呼ばず、read/write境界が不明な
requestはreplayしない。静的解析だけで端末鍵、生体認証、セッショントークンを再現できるとは扱わない。

### アプリとWebのread coverage差

公式説明上、両者は残高、入出金明細、円定期、外貨預金を表示できる。Webは円／対象外貨のCSV、印刷、
Eco通帳最大25カ月、取引推移表PDF最大10年を持つ一方、アプリ明細は最大200件で、円CSV・印刷はPC Web限定である。
現在の公開情報から、銀行台帳の履歴・粒度についてアプリだけが持つ優位は確認できない。ただしアプリには
OTP、通知、カード等の別機能が同居するため、runtime観測では銀行口座readだけをallowlistし、カードや取引開始画面を
別source／write境界として除外する。

## 公開クライアントの調査

現行・旧実装をコードで確認した結果、公開例は **ブラウザDOM操作または公式CSV** が中心で、
現行の認証済みinternal JSON APIを直接呼ぶ保守中クライアントは見つからなかった。銀行の公開ログインJSから
JSON BFF transport自体は確認できたが、これは第三者clientでも認証後read endpointでもない。

| 実装                                                                                                                                                        | 最終確認                        | 方式                                                                                                                                                              | 評価                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [4noha/openmoney `plugins/mufg/scraper.py`](https://github.com/4noha/openmoney/blob/7fa001a411549f3b55ec766701dd4c07b45c8c98/plugins/mufg/scraper.py)       | 対象ファイルのcommit 2026-05-09 | Playwrightで現行ログインURLを開き、契約番号・パスワードを入力。MUFGあんしんパスのQRをユーザーへ送り、承認待ち後に円明細画面を月別・最大25カ月、100件単位でDOM解析 | 現行方式の強い参考。完全無人ではなくスマホ承認を明示。残高・外貨・定期・CSV raw evidenceは未充足。 |
| [nakaomote/financial `ufj_download.py`](https://github.com/nakaomote/financial/blob/1565e12aab81c4ac08687e405869f5681ede20ca/ufj_download.py)               | 対象ファイルのcommit 2025-04-20 | headless Seleniumでログインし、円明細CSVをダウンロード                                                                                                            | あんしんパス導入前で、旧画面セレクタを含む。現在動作は未確認。                                     |
| [yusuke1225math2/my-finance `ufj_driver.py`](https://github.com/yusuke1225math2/my-finance/blob/ea552e35974d6c6efbf9936e88800eaf80c9a5ab/ufj/ufj_driver.py) | 対象ファイルのcommit 2024-05-30 | headless Selenium、過去30日CSV                                                                                                                                    | 認証と画面変更に弱い旧例。                                                                         |
| [shinichy/get_statement `get_statement.py`](https://github.com/shinichy/get_statement/blob/6f9730162d72eb9d14fa950767fdbcc8836676c1/get_statement.py)       | 2018-12-01                      | Seleniumで旧画像ボタンを操作しCSV                                                                                                                                 | 歴史資料のみ。                                                                                     |
| [Finance::Bank::JP::MUFG](https://github.com/gitpan/Finance-Bank-JP-MUFG/blob/7a19f150108c58153167eda612ff44f54bee04e0/lib/Finance/Bank/JP/MUFG.pm)         | 2012-10-21                      | `WWW::Mechanize`でHTMLフォーム`_TRANID`を直接POSTし、口座・取引・CSVを解析                                                                                        | ブラウザ不要HTTP clientの先例だが、現行認証・Angular UIよりはるかに古く再利用不可。                |
| [Zaim CSV Converter](https://github.com/yukihiko-shinoda/zaim-csv-converter)                                                                                | repo更新 2026-08-20             | ユーザーが公式Webから落としたCSVをローカル変換                                                                                                                    | CSV parser設計の参考。ログインもinternal APIも扱わない。                                           |

`openmoney` の実例は、MUFG銀行において「ログイン後のWeb画面取得」は現実的だが、あんしんパス承認を
人間ループから外せないことを示す。ログインBFFのrequest shapeは公開JSから一部確定した一方、認証後read BFFと
session replay可否は確定しないため、Kuebikoで本人操作の実通信metadataを受動観測するのが次の最小検証である。

## 実行基盤の適性

| 基盤                         | 適性       | 理由                                                                                                                                                                                  |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Worker（isolate） | 低         | フルChromeもAndroidアプリも動かせない。認証後の単純HTTP APIが特定・再生可能になった場合のcoordinator／ingestには適する。                                                              |
| Cloudflare Container         | 中         | Linux Playwrightは動かせるが、短命コンテナ単体では登録スマホの生体承認を完結できない。まず承認済みセッションのimport/replayが通るかを試す。セッションが再生できる場合のみ収集器候補。 |
| OCI VM／Kubernetes           | 中〜高     | 永続Chrome profile、固定実行環境、長い承認待ちを保ちやすい。完全無人化は保証しないが、スマホ承認を含むbrowser issuerにはContainerより扱いやすい。                                     |
| ローカルの可視Chrome         | 高（初期） | ユーザーが登録スマホで承認しやすく、Bitwardenから秘密を安全に入力でき、Kuebikoで全通信を観測できる。最初のissuer／fallbackにする。                                                    |

推奨分割は、可視Chromeを **session issuer**、短命Linux実行環境を **read-only consumer** とする構成である。
ただしsession replayが通らなければ、OCI等の永続ブラウザでユーザー承認付き半自動収集を採用し、
Cloudflareはraw evidence受信・保存だけに限定する。

## 実装コストと推奨順

| 経路                                                      | コスト (1-5) | 自動化見込み                   | 採否                                                                               |
| --------------------------------------------------------- | -----------: | ------------------------------ | ---------------------------------------------------------------------------------- |
| 手動ブラウザ + 公式CSV/PDF + Kuebiko                      |            2 | 定期操作は手動、取得後処理は高 | **今すぐ採用**。最も正確でraw evidenceを失わない。                                 |
| 可視Playwright + ユーザーのあんしんパス承認 + DOM/CSV     |            4 | 半自動は高、完全無人は低〜中   | **第一PoC**。既存の2026年実装例あり。                                              |
| 承認済みWebセッションのinternal API replay                |  3（発見後） | 成功すれば高                   | **最優先の技術検証**。login BFFは判明、認証後read endpointは未確認。               |
| 公式ダイレクトAPI                                         |            5 | 契約できれば非常に高           | 外部サービス会社としての本番接続条件が重く、当面見送る。                           |
| 正規Android splitの静的解析＋本人操作runtime metadata観測 |            5 | 低〜中                         | **並行調査**。実機／artifactが揃い次第実施し、security controlが妨げた時点で停止。 |
| Money Canvas/Moneytree                                    |            2 | 高                             | aggregator回避条件に反するため不採用。                                             |

## 次の検証手順

1. 可視Chromeで現在のログイン画面を開き、公開JSで確認した`BFF_LG_0001_01`～`05`の呼出順を
   DevTools/Kuebikoで照合する。ユーザーのいう「passkey」が WebAuthn/Bitwarden なのか、MUFGあんしんパスの
   登録スマホ承認なのかをUIとWebAuthnイベントだけで確認し、body、秘密値、cookieは記録しない。
2. ユーザー承認で一度だけログインし、Kuebikoを受動captureにして、代表口座とサービス指定口座の種類だけを列挙する。
   口座番号・名義・残高はマスクし、普通／スーパー普通／つかいわけ／円定期／外貨普通・貯蓄・定期が
   どの画面に出るかだけを記録する。
3. 円明細を短い期間で表示し、公式CSVのヘッダー、文字コード、件数超過時の挙動、ページング、
   画面上のcurrent/pending表現を確認する。実明細ファイルはprivate capture領域にのみ置き、Gitへ入れない。
4. 円定期、外貨普通・貯蓄・定期、Eco通知、取引推移表PDFの各read-only画面を1回ずつ開き、
   response content type、内部API、ページング、更新時刻をcaptureする。取引開始ボタンは押さない。
5. 認証後read BFFのmethod、origin、path template、status、content type、request/responseのfield名、
   paginationだけを記録し、取引／設定と同じendpointまたはside effect不明のrequestはreplay対象から除外する。
6. 収集用に明示承認された場合だけ、ログイン直後のcookie jarを暗号化・source scoped envelopeにし、
   同一マシンの新規profile、WSL、OCIの順で残高トップだけを再生する。401/403/ログインredirect/スマホ再承認要求で
   止め、CSRF/Trusteer/端末printを偽造せず、パスワード再試行もしない。
7. replayが成功した場合のみ、Cloudflare Containerで同じread-only GET/内部APIを1回試す。
   失敗した場合はOCIの永続Chrome issuerへ戻し、anti-bot原因と断定しない。
8. 並行して、本人所有の非root実機へ公式導線からappをインストールし、`dumpsys package`、`pm path`、全splitの
   signer/hashを採る。取得できれば上記静的解析を行い、binaryはGitへ入れない。取得不能ならpermission/errorだけを
   記録して停止し、rootや第三者mirrorへ進まない。
9. 本人操作でappの残高・口座一覧・円／定期／外貨明細を各1回だけ開き、read-only runtime metadataを観測する。
   write画面遷移、秘密／PII保存、request body保存、pinning/integrity回避は禁止する。
10. 認証後read APIが見つからない、またはCSVより情報量が少ない場合は、公式CSV/PDFを定期保存する半自動経路を
    正式ルートとする。アプリ解析結果はcoverage差と将来のtransport実装判断に残す。

## 未確認事項

- 実契約で保有する全口座がサービス指定口座に登録済みか。特に古い円定期・外貨口座。
- 現行個人CSVの正確なヘッダー、文字コード、メモ／未記帳フラグ、1ファイルの改行・ファイル名。
- 円定期・外貨定期の画面フィールド（預入日、満期日、利率、満期取扱、円換算評価等）の完全な一覧。
- 外貨Eco通知の文書種別、PDF/HTML、保存期間、過去明細の欠落有無。
- 入出金CSVとお取引記録の間で、予約取引がいつledgerへ移るか、安定した取引IDがあるか。
- 認証後read BFFのpath、response schema、pagination、rate limit、cookie/token期限。login BFFのCSRF/session枠組みは確認済み。
- MUFGあんしんパスの承認済みセッションを別OS/IPへ安全に再生できるか。
- 認証POSTでAkamai Bot Manager/WAFが作動するか。公開DNSだけでは未確定。
- 正規Android splitのversionCode、signer、manifest、hostname、native/WebView境界、network config、schema。
- Android側の端末鍵／FIDO／あんしんパス、integrity/root/debug検知、certificate pinningの具体的実装。
- 三菱UFJダイレクト API の本番接続契約をKoganeが現実的に取得できるか。

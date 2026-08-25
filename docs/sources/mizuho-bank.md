# みずほ銀行: みずほダイレクト / みずほダイレクトアプリ

調査日: 2026-08-26

## 結論

- **推奨する正本は、公式Webの「みずほダイレクト」**。残高・口座列挙は
  ログイン後HTML、普通・貯蓄・外貨普通の明細は直近3カ月のHTML/PDF/CSVと、
  申込済みなら最大10年の「みずほダイレクト通帳」PDF/CSVを組み合わせる。
- みずほグローバル口座、通常の円/外貨定期、積立定期は普通預金の入出金表と
  同じモデルではない。公式Webの各残高照会画面から、通貨・預入明細・満期・
  金利等を**預入ロット**として取得し、解約・継続履歴は過去1年、受付結果は
  別画面から取得する。
- 公式アプリは継続利用すると端末内に3カ月より前の明細も蓄積し、取引ごとの
  残高も表示する。ただし端末ローカル保存、機種変更時の引継ぎ、生体認証、
  root/改造端末制限がある。クラウド収集の主経路ではなく、**公式Webの認証・
  画面確認と、みずほポイントモールへの入口**として扱う。
- みずほポイントは現行サービスである。公式アプリの `P` マークから銀行の
  「みずほマイレージクラブ専用ページ」へ遷移し、残高、獲得履歴、利用履歴、
  有効期限を確認できる。ただし履歴の保存期間、ページング、機械可読な項目は
  公開資料だけでは分からない。
- 公開ログイン画面は現在もShift_JISのHTMLフォームで、`JSESSIONID`、POST token、
  cookie/JavaScript、クライアント環境値を使う。Akamai edgeと端末fingerprint用
  scriptは確認できた。現在動作する第三者クライアントは見つからず、2011～2021
  年の実装はいずれも旧HTMLフォーム/OFXに依存するため、設計参考に限る。
- ユーザーから「passkeyを使用しBitwardenに保存済み」との情報があるが、みずほ
  銀行の公開仕様と2026-08-26の公開ログイン画面では、ブラウザログインは
  お客さま番号とログインパスワード、必要時の第1暗証番号と案内されている。
  このpasskeyがみずほダイレクト用か、Bitwardenの通常資格情報を指すかは未確認。
  live検証までは、みずほダイレクトがWebAuthn/passkey対応だと仮定しない。

総合評価は、**普通・貯蓄預金MVP 3/5、定期・外貨・グローバル口座・ポイントを
含む完全版 4/5、完全無人ログインの見込み 2/5、既存の公式ブラウザsessionを
使った定期収集 4/5**である。

## スコープと非目標

対象は本人名義のみずほ銀行口座を、銀行の公式Webまたは公式アプリから直接、
読み取り専用で取得する経路に限る。

- 対象: みずほダイレクト、みずほダイレクトアプリ、みずほダイレクト通帳、
  みずほグローバル口座画面、銀行公式のみずほポイントモール
- 取得候補: 口座一覧、現在残高、普通/貯蓄/外貨普通の入出金明細、円/外貨定期・
  積立定期・グローバル口座の預入明細と読み取り可能な履歴、みずほポイント
- 非目標: J-Coin Pay、みずほWallet、Smart Debit、みずほJCBデビット、MyJCB、
  カード会社ポイント、他行、証券、マネーフォワード等のaggregator
- 安全境界: 振込、振替、外貨売買、定期預入・解約、ポイント交換、口座/利用口座
  の追加削除、みずほe-口座/ダイレクト通帳の申込、認証設定変更を行わない

この調査では認証済み口座へログインせず、公開ページ・公開ログイン入口・公開
コードだけを確認した。Bitwarden vaultは開いておらず、秘密、個人識別子、実残高、
認証cookieを保存していない。

## 調査方法

1. みずほ銀行の現行サービスページ、FAQ、規定、操作ガイド、Google Playの公式
   掲載を調べた。
2. 2026-08-26に公開入口だけを未認証で取得し、DNS、HTTP header、ログインHTMLの
   form、cookie属性、配信scriptを確認した。認証要求や架空のお客さま番号入力は
   行っていない。
3. GitHub Code Searchで現行/旧クライアントを探索し、Ruby、Go、Perlの実装を
   commit単位で読み、browser、CSV/OFX、内部HTTP formのどれを使うかを確認した。
4. 公式情報で確認できない項目は、第三者コードから現行仕様へ外挿せず、次のlive
   検証項目とした。

## 公式入口と取得できるデータ

| 公式経路 | 入口 | 読み取りデータ | 自動化上の位置付け |
| --- | --- | --- | --- |
| みずほダイレクト Web | [公式案内](https://www.mizuhobank.co.jp/direct/index.html)、[正規ログインURL案内](https://www.mizuhobank.co.jp/crime/info110520.html) | 利用口座、現在残高、普通/貯蓄/外貨普通/カードローン明細、定期・積立・外貨定期・グローバル口座の残高/預入明細、各種取引結果 | 主経路。desktopでCSV、PDFも取得できる |
| みずほダイレクト通帳 | [公式サービス](https://www.mizuhobank.co.jp/direct/about/service/directpassbook/index.html) | 申込後に保存された普通・貯蓄・外貨普通の古い明細を最大10年 | 構造化backfillの主経路。ただし利用中かどうかだけを確認し、申込はしない |
| みずほダイレクトアプリ | [公式機能](https://www.mizuhobank.co.jp/direct/app/index.html)、[Google Play](https://play.google.com/store/apps/details?id=jp.co.mizuhobank.banking) | 現在残高、入出金明細、取引ごとの残高、端末内履歴、収支レポート、ポイント入口 | 手動確認/認証補助。端末保存と生体認証のためcloud workerには不向き |
| グローバル口座専用画面 | [公式商品ページ](https://www.mizuhobank.co.jp/direct/about/service/global/index.html) | 円定期、6通貨の外貨定期、預入明細、参考円換算、取引結果 | 通常口座一覧だけでなく専用画面を別収集する |
| みずほポイントモール | [公式案内](https://www.mizuhobank.co.jp/mmc/mizuhopointmall/index.html)、[操作ガイド](https://www.mizuhobank.co.jp/mmc/mizuhopointmall/ebook/) | みずほポイント残高、獲得/利用履歴、有効期限、みずほギフト残高/履歴 | 銀行公式だがアプリの`P`マーク起点の別Web surface。第二段階 |
| 個人向け銀行API | [銀行のAPI方針](https://www.mizuhobank.co.jp/company/activity/api/policy/index.html) | REST/JSON/OAuth 2.0で残高・明細APIは整備済み | 契約した電子決済等代行業者向け。自己口座用の公開developer tokenは確認できず、aggregator回避方針により不採用 |

公開ログイン入口の正規URLは
`https://web.ib.mizuhobank.co.jp/servlet/LOGBNK0000000B.do` である。ログイン後は
負荷に応じて `webX.ib.mizuhobank.co.jp` に遷移することが公式にも明記されている。
hostを1つに固定せず、銀行が返すoriginとcookie domainを尊重する必要がある。

## 口座列挙と残高粒度

公式の[残高・入出金明細照会](https://www.mizuhobank.co.jp/direct/about/service/balance.html)
と[利用口座登録FAQ](https://www.faq.mizuhobank.co.jp/faq/show/246?site_domain=default)
から、残高照会・利用口座の対象は次の通りである。

| 口座科目 | 列挙/残高の単位 | 明細の扱い |
| --- | --- | --- |
| 普通預金（総合口座普通を含む） | 店・口座単位の現在残高。代表利用口座と追加利用口座 | 入出金明細、直近download、ダイレクト通帳の対象 |
| 貯蓄預金 | 店・口座単位の現在残高 | 普通預金と同じ入出金/ダイレクト通帳対象 |
| 定期預金（総合口座定期を含む） | 口座合計と預入明細単位 | 現在の預入明細と、解約/継続済み明細を過去1年。取引型ledgerではなくlotとして扱う |
| 積立定期預金（総合口座積立を含む） | 契約/口座と預入明細単位 | 残高・預入明細、取引結果。普通預金CSVだけでは列挙できない |
| 外貨普通預金 | 口座・通貨単位。USD/EUR/GBP/CHF/AUD/NZDをWebで確認可能 | 入出金明細、ダイレクト通帳対象 |
| 外貨定期預金 | 口座・通貨・預入明細単位。Web明細はUSD/EUR/GBP/CHF | AUD/NZDの外貨定期明細はWeb非対応。現在/過去1年の解約・継続明細は対応通貨をlive確認 |
| みずほグローバル口座 | 1つのマルチカレンシー口座内の円定期と6通貨の外貨定期を、通貨・預入明細単位 | 専用残高・結果画面。通常の外貨普通口座とは別商品 |
| 当座預金 | 利用口座登録は可能 | 個人Webでは振込/振替の引出口座としてのみと案内。残高列挙対象には含まれないためread supportは未確認 |
| カードローン | 契約/口座単位 | 残高・入出金明細対象だが本MVPでは除外可能 |

みずほグローバル口座は開設時に自動で利用口座登録される。通常の利用口座追加
画面から追加する対象ではない。また、本人が複数のお客さま番号を持つ場合、公式
アプリは番号を追加して切り替えられる。1回の口座一覧だけを全口座とみなさず、
ユーザーが利用するお客さま番号数をlive検証時に確認する。

グローバル口座は円定期と6通貨の外貨定期を持つ。画面には銀行公示仲値による
参考円換算額が表示されるため、native amount/currencyと参考円換算を分けて保存し、
後者を簿価や約定レートとして扱わない。

## 明細、download、保持期間

### 普通・貯蓄・外貨普通

- 通常のみずほダイレクト入出金明細は、照会日の2カ月前の1日から当日まで
  （実質、当月・前月・前々月）。紙通帳口座では、それより前でも通帳未記帳分を
  表示できる場合がある。
- みずほe-口座で「みずほダイレクト通帳」を申込済みなら、申込月の2カ月前1日
  から照会日の3カ月前月末までを最大10年保存する。申込前の古い期間は遡及しない。
- 直近3カ月とダイレクト通帳は、WebからPDFでdownloadできる。PCブラウザではCSV
  もdownloadできる。アプリ単独のCSVではなく、Web画面を開く経路である。
- ダイレクト通帳の古い明細には取引ごとの残高がない。アプリ/直近明細は取引ごとの
  残高を表示するが、アプリで取得していない古い期間は「残高表示期間外」になる。
- アプリは起動時に前々月1日から現在までの明細を取得して端末へ保存する。毎月継続
  利用すれば4カ月以上前も残るが、3カ月以上起動しない期間には欠落が生じ得る。
  アンインストールや機種変更時に引継ぎをしなければ端末保存分は失われる。
- 公式FAQは表示/downloadの最大件数を公開していない。高頻度口座でのページング、
  1回のPDF/CSV期間上限、CSV文字コード・header・列数はlive fixtureが必要である。

公開HTMLと公式の摘要例から、最低限期待できる表示粒度は取引日、出金/入金、摘要、
直近期間の取引後残高である。前日勘定取引等では同一日内の表示順が前後し得るため、
画面順だけをstable transaction IDにしない。現在のCSVの列仕様は公開資料から確認
できず、第三者の実データsampleもGitへ持ち込まない。

### 定期・積立・外貨・グローバル口座

- 定期/積立/外貨定期は「残高照会」から、現在の口座と預入明細を読む。
- 定期・外貨定期の解約/継続済み明細は原則過去1年。ただしインターネット支店、
  みずほe-口座、リーフ口の解約時利率・利息等は約3カ月になる場合がある。
- 通常の「各種取引の履歴・明細」は、円定期、積立定期、外貨普通が直近18カ月・
  5件、外貨定期は直近5件。これは口座入出金ledgerではなく受付結果である。
- グローバル口座は、口座開設/預入結果を直近18カ月・10件、その他の取引種別を
  各5件確認できる。
- 夜間/休日の外貨普通・外貨定期取引は翌営業日午前まで `受付済` のことがある。
  外貨定期の平日15時以降の口座開設・預入は、残高/明細反映も翌営業日以降になる。

したがって `posted_at` が付いた預金ledgerと、`受付済`/`取引成立` 等の
operation statusを同じ表へ無理に統合しない。普通預金入出金明細に公開上の
pending authorization列はなく、反映済みledgerとみなす。未確定状態が必要なのは、
利用者自身がみずほダイレクトで開始した定期/外貨/グローバル口座取引の結果確認で
ある。Koganeは読み取り専用なので、その状態は既存取引の観測だけに使う。

### 公式artifactの比較

| artifact | 期間/対象 | 粒度 | 推奨用途 |
| --- | --- | --- | --- |
| 直近明細HTML | 約3カ月、普通/貯蓄/外貨普通 | 日付、摘要、入出金、取引後残高 | 増分収集と最新残高 |
| 直近明細PDF | 約3カ月 | 公式表示の保存版。正確な列はlive確認 | audit、CSVとの差分検査 |
| 直近明細CSV（PC） | 約3カ月 | 構造化可能。encoding/header/残高列は未確認 | MVPのprimary transaction artifact |
| ダイレクト通帳PDF/CSV | 申込後の古い期間、最大10年 | 取引ごとの残高なし | backfill、長期audit |
| 定期/外貨/グローバル残高HTML | 現在の預入明細 | 通貨、元金、満期等のlot。exact fields未確認 | current positions |
| 定期/外貨/グローバル結果HTML | 3～18カ月または5/10件 | 受付状況を含むoperation history | lot lifecycleの補完 |
| アプリ端末内履歴 | 起動のたび約3カ月を追加保存 | 取引後残高、収支カテゴリ等 | gap検出/manual fallback。raw DB抽出をMVPにしない |

## みずほポイント

みずほポイントモールは現行の銀行公式サービスで、みずほマイレージクラブ会員が
みずほダイレクトアプリを利用し、利用開始手続きを行うことが条件である。

- アプリhome上部の `P` マークからみずほポイントモールへ遷移する。
- みずほマイレージクラブ専用ページで、みずほポイント残高、獲得履歴、利用履歴
  （みずほギフトへのチャージ時期/数）、みずほギフト残高を確認できる。
- 操作ガイドはポイントの獲得・利用履歴と有効期限内訳、みずほギフトの獲得・利用・
  失効履歴を表示できるとしている。
- みずほポイントの有効期限は付与月の24カ月後の月末23:59まで。規定上は獲得月を
  含む25カ月間で、みずほギフトへチャージしても引き継ぐ。
- みずほダイレクトのブラウザhomeだけから到達できるとは公開資料にない。アプリ起点
  のbank-owned web surfaceとして、残高/銀行明細collectorと別moduleにする。
- 履歴の保存期間、1行の項目、ページング、CSV/PDF export、失効予定のbucket粒度は
  未確認。live画面でDOM/JSONを観測するまで残高だけをMVP候補とする。

この範囲ではJ-Coin、MyJCB、カード会社ポイントへ遷移しない。

## 認証とsession

### Web

公式仕様では通常のブラウザログインは次の構成である。

1. 数字8桁または10桁のお客さま番号。
2. 半角英数字6～32桁のログインパスワード。
3. 通常と異なる環境など、銀行が追加確認を必要と判断した場合は4桁の第1暗証番号。

第2暗証番号、専用ワンタイムパスワード、SMS 5桁、メール方式ワンタイムパスワード
は主に初期登録、アプリ版利用カードの設定、振込等の取引実行に使われる。残高・
明細の通常ログインで毎回必要とは公式FAQに書かれていない。Koganeはwrite画面へ
進まないため、第2暗証番号/OTPをcollectorへ渡さない。

2026-08-26の未認証観測では、ログイン入口は次の性質だった。

- Shift_JIS HTML formから、お客さま番号を別の`webX` hostへPOSTする。
- `JSESSIONID`は`.ib.mizuhobank.co.jp` domain、`Secure`、`HttpOnly`で発行される。
- formはPOST token、form ID、client environment fieldを持ち、cookieなしでは画面間の
  情報引継ぎができない。
- 銀行は自動timeoutを明記するが、idle/absolute lifetimeの分数、並行session、cookie
  再利用、ログアウト時の全session失効は公開していない。

ユーザー申告のBitwarden内資格情報は、live検証時もextension/ユーザー操作で入力し、
値をKogane、ログ、capture、Git、PR、container環境変数へ出さない。公開ログイン画面
にpasskey/WebAuthnの選択肢は見つからなかったため、最初のbounded検証でBitwardenが
通常passwordをfillするのか、WebAuthn promptを出すのかだけを確認する。

### アプリ

- 初回登録は代表利用口座の店番号/口座番号と第1暗証番号を用い、本人情報、SMS認証、
  login設定、6桁のアプリパスワードまたは生体認証を設定する。
- 起動時はアプリパスワードまたは生体認証。Androidは公式FAQ上、顔ではなく指紋認証。
- ご利用カード（アプリ版）は生体/アプリパスワードの後に、取引ごとに変わる第2
  暗証番号を表示する。状況によりSMS追加認証が起こり得るが、read collectionには
  要求しない。
- `キャッシュカード認証（残高照会のみ）` という別modeもあるが、普通/貯蓄だけで
  定期残高を表示できず、一定期間使わないと再登録が必要になる。完全列挙には不適切。

## CDN、WAF、anti-automation

### 確認できた事実

- `www.mizuhobank.co.jp`、`web.ib.mizuhobank.co.jp`、
  `web1.ib.mizuhobank.co.jp` はAkamaiへ解決される。login hostのCNAMEは
  `edgekey.net`、responseには `Akamai-GRN` があった。
- generic command-line requestでは公式`www` pageが `Server: AkamaiGHost` の403を
  返した一方、正規login入口は200を返した。host/pathごとにedge policyが異なる。
- login pageは `directinfo.ib.mizuhobank.co.jp/fp/tags.js` をsession/page ID付きで読み、
  `CLIENT_ENV`を送る。公式案内も「ログイン環境の分析」と、異常環境での第1暗証番号
  step-upを明記している。
- login/application responsesはno-cacheで、HTML form、cookie、JavaScriptが必須である。

### 推測・未確認

- Akamai Bot Managerまたは同等のbot scoreが認証後画面に適用されている可能性は高い
  が、製品名、rule、headless検知条件、datacenter IP判定は確認していない。
- `fp/tags.js`はdevice/browser fingerprintingのためと考えられるが、収集項目、vendor、
  scoreへの使い方は未確認である。
- HTTP clientが正しいtoken/cookie/fieldを再現すれば通るか、実ブラウザのJavaScript
  実行が必須かは未確認。古いscraperがHTTP-onlyだったことは現行の成功根拠にならない。

このため、最初からCloudflare Workersの素の`fetch`でloginを再現するより、通常の
Chromeと銀行が発行したsessionを使い、read endpoint/artifactを段階的に絞る。

## Android APKと静的解析

公式AndroidアプリはGoogle Play package
[`jp.co.mizuhobank.banking`](https://play.google.com/store/apps/details?id=jp.co.mizuhobank.banking)
で、developerはみずほ銀行、100万+ download、2026-07-22更新と掲載されている。
銀行サイトから直接配布する公式APKは見つからず、第三者APK mirrorは来歴を保証できない
ため使わない。

Play掲載と公式FAQで次を確認できる。

- appは残高・明細・収支report・取引機能を持ち、JavaScriptとcookieを必要とする。
- 不正改造端末では正常起動しない可能性がある。
- Android appは明細screenのscreenshotを禁止する。
- 2026-01-31時点の公式対応環境はAndroid 15/16。対応外端末/tabletは保証外。

細かいreverse engineeringは後回しにするが、Play由来split APKを取得し、certificateと
package provenanceを確認した上での静的解析は有用である。最初に調べるのはmanifest、
WebView/deep link、official host allowlist、network security config、pinning/integrity SDK、
local明細DB schema、download handling、API/model class名に限る。難読化解除、root/hook、
pinning回避、生体credential抽出、認証token抽出は行わない。

期待値は**中**である。appがWeb screenへ遷移する科目と、native/local保存する明細の
境界を早く把握できる一方、server schemaとsession issuanceは静的解析だけでは確定
できない。署名済みappを通常端末でblack-box観測する方を優先する。

## 第三者クライアント

現行の公式画面に対応すると確認できたbank-only clientは見つからなかった。

| 実装 | 最終的な機能更新 | 方式 | 現在の扱い |
| --- | --- | --- | --- |
| [`kimoto/mizuho_bank`](https://github.com/kimoto/mizuho_bank) | 2012、MIT | Ruby Mechanize。お客さま番号、password、合言葉で旧HTML formへloginし、残高/明細HTMLをparse | endpoint/UIとも旧式。設計参考のみ |
| [`binzume/gobanking/mizuho`](https://github.com/binzume/gobanking/blob/master/mizuho/mizuho.go) | login/historyの実質更新は2018～2021、repoは2024に依存更新、MIT | Go `net/http`、cookie jar、Shift_JIS、POSTKEY/form ID。残高・日付・摘要・入出金をHTMLからparse | 現行loginに似たform architectureの参考。ただし現在動作する証拠なし。write methodは絶対に再利用しない |
| [`Finance::Bank::JP::Mizuho`](https://github.com/gitpan/Finance-Bank-JP-Mizuho) | 2011 | Perl LWP/cookie。旧口座一覧をparseし、銀行のOFX download endpointを取得 | 現行公式はPDF/CSVのみを案内。OFX routeは廃止済みとみなしliveで期待しない |

共通してbrowser automationではなく、HTML formとcookieを直接送る方式だった。これは
HTTP collectorが理論上可能であることを示すが、旧合言葉、旧page ID、旧OFXを含む。
現行form schemaを新規に観測し、read allowlistから実装し直す必要がある。

## 実行基盤の適性

| 基盤 | 適性 | 理由 |
| --- | --- | --- |
| Kuebiko/通常Chrome + persistent profile | **最適** | Bitwarden/ユーザー操作、step-up、第1暗証番号、download、Akamai/device fingerprintを正規browserで扱える。認証後readだけ自動化しやすい |
| Cloudflare Workers | login collector **低**、orchestrator **高** | cookie付きHTTPとscheduleは可能だが、通常Chrome profile、extension、desktop download、生体操作がない。Akamai/datacenter edgeとの相性も未確認 |
| Cloudflare Containers / Browser Rendering | **中** | Playwrightとpersistent storageを用意できるが、headless/datacenter fingerprint、session persistence、download暗号化が課題。MVPの第1候補ではない |
| OCI VM/Containers | **中～高** | 通常Chrome/Playwright、固定disk、secrets brokerを構成しやすい。bank loginは日本国内利用を前提とするため、region/egressと実利用条件を確認する必要がある |
| OCI Kubernetes | **中** | 定期jobと隔離は容易だが、browser profileをpodに安定保持し、同時loginを避ける設計が必要。1口座MVPには運用過剰 |

銀行の[利用環境](https://www.mizuhobank.co.jp/direct/goriyo/notice/index.html)は、日本国内
利用を前提とすると明記する。海外・不定region・毎回変わるIPからの完全無人loginは
成功率だけでなく、追加認証/利用停止riskの面でも推奨しない。Cloudflare/OCIは
session取得を行う主体ではなく、local/管理下Chrome collectorのschedule、暗号化保存、
通知、normalized data APIに使う方がよい。

## 推奨アーキテクチャ

1. ユーザー管理下の通常Chrome profileで正規ログイン入口を開く。Bitwardenを使う
   場合はユーザー操作/extensionに委ね、資格情報をautomationへ渡さない。
2. 既存sessionが有効なら再利用し、失効時だけ人に再認証を求める。session cookieは
   OS-backed vaultで暗号化し、ログ・D1/KV・Gitへ出さない。
3. read-only allowlistを作る。最初はhome/口座一覧、普通/貯蓄/外貨普通の残高・明細、
   CSV/PDF downloadだけに限定する。
4. CSVをprimary、HTMLをbalance/discovery、PDFをauditとする。CSVにstable IDがなければ、
   source、口座pseudonym、取引日、金額、摘要、同日ordinalから暫定dedupe keyを作り、
   raw artifact hashも保存する。
5. 定期・積立・外貨定期・グローバルは別position collectorで預入lotを取得する。
   write controlのform/actionは呼び出さない。
6. みずほポイントは銀行明細collectorと別session/surfaceとして、`P`マークからの
   正規遷移を観測してから残高・履歴collectorを追加する。
7. Cloudflare/OCI側はschedule、lock、暗号化artifact受領、正規化、監視だけを担当し、
   同一profileの並行実行を禁止する。

## 次のbounded検証

すべて本人名義口座・読み取り専用で行い、値はredactし、field名とshapeだけを記録する。

1. 既存Chrome tab/profileを確認し、正規URLから未認証/認証済み状態を判定する。
2. 公開仕様との呼称差を解消するため、Bitwardenがみずほ画面でpassword fillかpasskey
   promptのどちらを提供するかだけ確認する。secret値は取得しない。
3. ユーザーによるlogin後、session idle/absolute lifetime、再起動後cookie再利用、別IP
   risk step-up、第1暗証番号要求条件を1回ずつ測る。失敗時に繰り返しloginしない。
4. homeの口座rowについて、科目、通貨、masked account identifier、残高、available額、
   複数お客さま番号の有無をsanitized schemaとして記録する。
5. 普通/貯蓄/外貨普通の直近明細を、同じ短い期間でHTML、PDF、CSV各1件downloadし、
   encoding、header、列、順序、件数上限、pagination、取引後残高、pending fieldを比較する。
6. みずほダイレクト通帳を**既に利用中なら**、1カ月だけPDF/CSVを比較する。未申込なら
   設定変更になるため申し込まず、未確認のままとする。
7. 定期、積立、外貨普通/定期、グローバル口座について、存在する科目だけを開き、
   現在lot fieldと履歴/結果画面のfield名・保持範囲を記録する。預入/解約ボタンは押さない。
8. appの`P`マークから公式ポイントページへ入り、origin、session境界、残高、獲得/利用/
   失効予定のrow field、paginationを記録する。チャージ/交換には進まない。
9. public loginと認証後read requestを受動観測し、HTML formかJSON/XHRかを分類する。
   certificate pinningやanti-debugに当たったら回避せず、Chrome collectorへ戻る。
10. 7日間、同じbrowser profileで1日1回、口座一覧と短い明細だけ取得し、Akamai block、
    session expiry、duplicate、欠落、rate limitを評価してMVP方式を確定する。

成功判定は、手動login後に書き込み画面へ入らず、全対象口座のstableなpseudonymous ID、
現在残高、増分明細、公式artifact hashを再現できること。中止条件は、認証設定変更、
OTP/第2暗証番号をreadのために常時要求、root/pinning bypass、繰り返しlock、bank利用停止
の兆候、本人名義外の情報が必要になることである。

## 確認済み、推測、未確認

### 確認済み

- Web残高対象は普通、貯蓄、定期、積立定期、外貨普通、外貨定期、グローバル口座、
  カードローン。入出金対象は普通、貯蓄、外貨普通、カードローン。
- 直近明細は前々月1日以降、ダイレクト通帳は申込後最大10年。PDFとPC用CSVがある。
- 定期/外貨定期の解約・継続履歴は原則1年、グローバル取引結果は18カ月・10/5件。
- appは明細を端末保存し、継続利用で3カ月超を表示するが、gap/機種変更lossがある。
- みずほポイントは現行で、銀行専用pageに残高・獲得/利用履歴・期限がある。
- browser loginはお客さま番号+login password、risk判定時に第1暗証番号。Akamai edge、
  cookie、JavaScript、client environment/fingerprint scriptがある。
- 公式Android packageは`jp.co.mizuhobank.banking`。

### 推測

- 実ブラウザsessionを取得できれば、残高/CSV/PDF downloadは安定して自動化できる
  可能性が高い。
- appはnative storageとWeb screenを混在させ、定期/外貨/pointはWebViewまたは外部
  browserに依存する可能性が高い。
- datacenter/headless trafficはAkamai/銀行risk analysisで追加認証やblockを受けやすい。

### 未確認

- ユーザー申告のpasskeyがみずほダイレクト用か、現在のWebAuthn supportがあるか。
- sessionのidle/absolute lifetime、session portability、並行login、logout invalidation。
- 認証後endpointがHTMLのみか、JSON/XHRを併用するか。current form/page IDs。
- 現行CSV/PDFの列、encoding、1回の期間/件数、pagination、stable transaction ID。
- 全口座科目の画面上のstable identifier、available balance、外貨/定期lotのexact fields。
- 普通預金の未確定明細の有無。公開仕様ではposted ledgerしか確認できない。
- みずほポイント履歴の保存期間、row fields、export、expiry bucket、session境界。
- Bot Manager製品名、pinning、Play Integrity等、appのlocal DB暗号化。

## 主な根拠URL

- [みずほダイレクト](https://www.mizuhobank.co.jp/direct/index.html)
- [残高・入出金明細照会](https://www.mizuhobank.co.jp/direct/about/service/balance.html)
- [入出金明細の照会期間](https://www.faq.mizuhobank.co.jp/faq/show/276?site_domain=default)
- [みずほe-口座・みずほダイレクト通帳](https://www.mizuhobank.co.jp/direct/about/service/directpassbook/index.html)
- [ダイレクト通帳のPDF/CSV download](https://www.faq.mizuhobank.co.jp/faq/show/10039?site_domain=default)
- [アプリの端末内明細保存](https://www.faq.mizuhobank.co.jp/faq/show/7271?site_domain=default)
- [アプリ機種変更時の履歴](https://www.faq.mizuhobank.co.jp/faq/show/12914?site_domain=default)
- [定期預金の解約済み明細](https://www.faq.mizuhobank.co.jp/faq/show/11523?site_domain=default)
- [各種取引結果の期間/件数](https://www.faq.mizuhobank.co.jp/faq/show/10064?site_domain=default)
- [外貨預金](https://www.mizuhobank.co.jp/direct/about/service/gaika.html)
- [外貨普通/定期のWeb対応通貨](https://www.faq.mizuhobank.co.jp/faq/show/5888?site_domain=default)
- [みずほグローバル口座](https://www.mizuhobank.co.jp/direct/about/service/global/index.html)
- [利用口座の登録対象](https://www.faq.mizuhobank.co.jp/faq/show/246?site_domain=default)
- [ブラウザログインの認証要素](https://www.faq.mizuhobank.co.jp/faq/show/10035?site_domain=default)
- [各種暗証番号](https://www.faq.mizuhobank.co.jp/faq/show/10085?site_domain=default)
- [利用環境、cookie、JavaScript](https://www.mizuhobank.co.jp/direct/goriyo/notice/index.html)
- [正規ログインURL](https://www.mizuhobank.co.jp/crime/info110520.html)
- [みずほダイレクトアプリ](https://www.mizuhobank.co.jp/direct/app/index.html)
- [Google Play公式掲載](https://play.google.com/store/apps/details?id=jp.co.mizuhobank.banking)
- [みずほポイントモール](https://www.mizuhobank.co.jp/mmc/mizuhopointmall/index.html)
- [みずほポイント規定](https://www.mizuhobank.co.jp/mmc/regulation/index.html)
- [みずほポイントモール操作ガイド](https://www.mizuhobank.co.jp/mmc/mizuhopointmall/ebook/)
- [個人向け銀行APIの提供範囲](https://www.mizuhobank.co.jp/company/activity/api/policy/index.html)
- [電子決済等代行業者との契約一覧](https://www.mizuhobank.co.jp/company/activity/api/index.html)

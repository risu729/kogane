# ゆうちょ銀行: ゆうちょダイレクト / ゆうちょ通帳アプリ

調査日: 2026-08-26

## 結論

- **Kogane の第一経路は、公式Web「ゆうちょダイレクト」のCSV download** とする。
  総合口座の通常貯金・通常貯蓄貯金は、画面上の現在高・引出可能残高と入出金
  明細を取得できる。CSVには画面にない通し番号と、摘要を分けた「詳細1」「詳細2」
  があり、1ファイル3,000明細、最大10ファイル・30,000明細まで出力できる。
- 明細の期間は口座形態で大きく異なる。通常の有通帳総合口座は最大2か月、振替口座
  は最大15か月、無通帳型総合口座「ゆうちょダイレクト＋（プラス）」は最大20年
  （2021年3月以降）である。`ダイレクト＋`への切替は口座状態を変えるため、
  **Koganeの収集準備として勝手に切り替えない**。既に利用中なら長期backfillに使う。
- 担保定額貯金・担保定期貯金は、通常貯金ledgerとは別に、公式Webまたは通帳
  アプリの「明細情報一覧」から**預入lot**として列挙する。公開資料で預入状況の
  明細照会と取引結果照会は確認できたが、CSV/PDF export、履歴保持期間、exact field
  は確認できない。専用通帳・証書の定額/定期はダイレクトの対象外である。
- ゆうちょ通帳アプリは、通常貯金・通常貯蓄貯金の残高/入出金、担保定額定期の
  預入残高・明細を表示する。ただし初回取得範囲は登録時点等に依存し、Androidの
  機種変更では明細を引き継がない。端末生体・4桁passcode・端末上のFIDO認証に
  依存するので、cloud collectorの主経路ではなく、**公式画面の確認、Web loginの
  人手認証、Webとのcoverage比較**に使う。
- 銀行は参照系APIとして、現在高、入出金、担保定額定期、口座貸越元金、投資信託の
  明細APIを整備済みである。しかし公開developer APIではなく、銀行法上の電子決済等
  代行業者として基準適合・個別契約が必要で、利用者同意も90日ごとの更新が必要で
  ある。公式データ源としては理想的だが、個人用Kogane MVPには実装より契約コストが
  支配的であり、現時点では採用しない。
- `www`、`direct`、`direct3` はDNS CNAMEが `edgekey.net` で、Akamai配信は確認できた。
  `direct`へのgeneric curlはtimeout/HTTP2 errorになった一方、検索crawlerと通常
  browser向け公開ページは到達可能だった。通常Chromeで公開loginだけを観測すると、
  Struts token/eventを持つHTML form、password/app別の`direct1`遷移、FIDO app link/return、
  `directss`等へのsecurity telemetry POSTを確認できた。ただし、この観測だけでAkamai
  Bot ManagerやWAF製品、bot score、headless遮断を確認したとはいえない。
- 2026-08-26の公式Google Play掲載は、通帳アプリ`jp.japanpost.jp_bank.bankbookapp`
  **21.0.0**（2026-04-10更新）、認証アプリ`jp.japanpost.jp_bank.FIDOapp` **18.0.0**
  （2026-04-09更新）だった。正規install端末がなくAPK/split、versionCode、signerは未取得だが、
  split取得、署名検証、deobfuscation、read-only runtime tracingの再現手順を具体化した。
- 現在動作すると確認できた第三者clientは見つからなかった。`kkosuge/bank_job` は
  2014年のMechanizeによるHTML form/合言葉/表parse、`toc/pogact` はSeleniumによる
  旧画面操作である。`shinichy/get_statement` は2018年のSelenium downloaderだが、
  **ゆうちょ銀行を実装していない**。いずれも現行clientのbaseにはせず、旧来の
  HTTP/HTML構造があったことを示す参考に限る。

総合評価は、**月次CSVの半自動収集 2/5、残高・通常明細・担保定額定期を含む
browser collector 3/5、完全無人login 4/5、公式APIの技術実装 2/5・契約を含む導入
5/5**である。自動化見込みは、既存の登録済みbrowser/sessionを使った読み取りで
中～高、毎回の新規loginから完全無人で行う場合は中以下である。

## スコープと非目標

対象は本人名義のゆうちょ銀行口座を、銀行の公式Web、公式アプリまたは銀行自身の
参照系APIから直接、読み取り専用で取得する経路に限る。

- 対象: ゆうちょダイレクト、ゆうちょダイレクト＋、ゆうちょ通帳アプリ、
  ゆうちょ認証アプリ、銀行の参照系API
- 取得候補: 利用口座一覧、現在高、引出可能残高、通常貯金・通常貯蓄貯金・振替口座
  の入出金、担保定額貯金・担保定期貯金の現在明細、公式CSV、通帳イメージ
- 非目標: JP BANKカードWEB/クレジットカード、ゆうちょデビット利用明細、他行、
  証券、ゆうちょPay、Moneytree等のaggregator、振替受払通知票Web照会の法人運用
- 安全境界: 送金、振替、払込み、定額/定期の預入・払戻し、満期時取扱変更、
  自動貸付設定変更、利用口座追加削除、ダイレクト＋への切替、認証設定変更を行わない

この調査では認証済み口座へログインせず、公開ページ、公開login入口、DNS/HTTPの
未認証観測、公開コードだけを確認した。Bitwarden vaultは開いておらず、秘密、
個人識別子、実残高、口座番号、認証cookieを保存していない。

## 調査方法

1. ゆうちょ銀行の現行サービスページ、FAQ、操作ガイド、規定、API方針とGoogle Play
   の公式掲載を確認した。
2. 2026-08-26に公開hostだけを未認証で調べ、DNS CNAME、HTTP応答、公式login手順を
   確認した。通常Chromeでは公開login DOM、読み込まれたJavaScript、host/path/method/statusだけを
   観測し、form submit、login request、架空の口座情報入力、request body保存は行っていない。
3. GitHub Code Searchで現行/旧clientを探索し、commit時点のコードを読み、browser、
   CSV、HTML form、internal HTTPのどれを使っていたかを確認した。
4. 公式情報で確認できない項目は第三者コードから現行仕様へ外挿せず、次の本人による
   bounded live検証へ残した。

## 公式入口とデータ面

| 公式経路 | 入口 | 読み取りデータ | 自動化上の位置付け |
| --- | --- | --- | --- |
| ゆうちょダイレクト Web | [公式案内](https://www.jp-bank.japanpost.jp/direct/pc/dr_pc_index.html)、[login](https://direct.jp-bank.japanpost.jp/tp1web/U010101SCK.do) | 利用口座、現在高、引出可能残高、入出金、入金明細、通帳未記入分、担保定額定期の明細/取引結果 | **主経路**。CSVとHTMLを組み合わせる |
| ゆうちょダイレクト＋ | [公式案内](https://www.jp-bank.japanpost.jp/direct/pc/plus/dr_pc_pl_index.html) | 最大20年の入出金、通帳イメージ、担保定額定期満期通知 | 既に利用中なら長期backfillの最良経路。切替は収集作業では行わない |
| ゆうちょ通帳アプリ | [公式案内](https://www.jp-bank.japanpost.jp/app/app_tsucho.html)、[Google Play](https://play.google.com/store/apps/details?id=jp.japanpost.jp_bank.bankbookapp) | 通常/通常貯蓄の残高・入出金、収支graph、担保定額定期の預入残高/明細 | 端末boundのmanual fallbackとWeb coverage比較 |
| ゆうちょ認証アプリ | [公式案内](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_nshtouroku.html)、[Google Play](https://play.google.com/store/apps/details?id=jp.japanpost.jp_bank.FIDOapp) | 金融データ自体ではなく、FIDO準拠のWeb/app認証 | 人手bootstrap。collectorが模倣しない |
| 参照系API | [公式方針](https://www.jp-bank.japanpost.jp/aboutus/activity/api/abt_act_api_houshin.html) | 現在高、入出金、担保定額定期、口座貸越、投信明細 | runtimeは理想的だが契約済み電子決済等代行業者限定 |
| ゆうID | [日本郵政の連携方針](https://www.post.japanpost.jp/notification/pressrelease/2025/00_honsha/0616_01_01.pdf) | 現時点の銀行明細login入口としては確認できない | グループ共通IDの将来連携。ダイレクトのお客さま番号やFIDO認証と同一視しない |

`ゆうID`は日本郵政グループの共通IDであり、ゆうちょ口座との連携拡大方針は公表
されている。しかし、2026-08-26時点のゆうちょダイレクト/通帳アプリの公式手順は、
お客さま番号、login password、口座情報、キャッシュカード暗証番号、電話確認、
認証アプリを使う。`ゆうID`を残高・明細collectorのlogin credentialにはしない。

## 口座列挙と残高粒度

### Web

ゆうちょダイレクトでは、1つのお客さま番号へ最大10口座を利用口座登録し、まとめて
管理できる。登録自体はwrite operationなのでKoganeは行わず、既に登録済みの口座だけを
列挙する。全口座coverageには、利用口座登録外の本人名義口座がないかをユーザーへ
確認する必要がある。

| 口座/商品 | 列挙・残高の単位 | 明細の扱い |
| --- | --- | --- |
| 通常貯金（総合口座） | 利用口座単位。現在高、うち振替現在高、引出可能残高 | 入出金HTML/CSV。未記帳分照会あり |
| 通常貯蓄貯金 | 利用口座単位。現在高、引出可能残高 | 入出金HTML/CSV。ダイレクト＋への切替対象外 |
| 振替口座 | 利用口座単位の現在高 | 入出金/入金CSVは最大15か月。通常払込みの個別画像は別サービス |
| 担保定額貯金 | 貯金口座と明細/預入lot単位 | 預入状況の明細照会、取引結果照会。CSV/PDFは未確認 |
| 担保定期貯金 | 貯金口座と明細/預入lot単位 | 預入状況、満期時取扱、取引結果。CSV/PDFは未確認 |
| 専用通帳/証書の定額・定期 | 公式FAQ上、ダイレクト対象外 | Web/APIでの列挙可否を期待しない |

現在高画面の公式定義は次の通りである。

- `現在高`: 口座の現在高。貯金担保自動貸付を利用中ならマイナス表示になり得る。
- `うち振替現在高`: 総合口座のみ。オートスウィング基準額を超え、無利子の振替口座
  へ移された部分。
- `引出可能残高`: 総合口座のみ。現在高と貯金担保自動貸付の利用可能額を含む。
- 小切手等の未完了決済と、振替口座の一部払出金は現在高に含まれない。したがって
  `current_balance`と`available_balance`を分け、未完了額を推計して補正しない。

担保定額/定期は普通預金transactionと同じモデルにしない。最低限、source account、
商品種別、明細識別子、預入日、元金、満期/据置、利率、満期時取扱、自動貸付対象を
lot field候補とし、exact fieldはlive画面で確定する。

### 通帳アプリ

- 対象は個人の総合口座（通常貯金・通常貯蓄貯金）。振替口座・法人口座は使えない。
- 同一名義なら最大2口座をアプリへ登録できる。1口座を複数端末へ登録できるが、
  取引時認証は1端末だけで、後から設定した端末が有効になる。
- 通帳アプリ規定上、届出口座情報照会には現在高、入出金、収支graph、担保定額定期
  の明細、口座貸越借入残高が含まれる。
- アプリ再登録までのgapや、ダイレクト再申し込み完了までの明細は取得できないことが
  ある。Android→Androidと別OS間の機種変更では、端末内明細・login認証方法を引き継がない。

## 入出金明細、artifact、保持期間

### 期間と件数

| 対象 | 画面照会期間 | CSV期間 | 件数 |
| --- | --- | --- | --- |
| 有通帳の総合口座（通常/通常貯蓄） | 最大2か月（前月1日から） | 同じ | 画面1回100明細、CSV最大30,000明細 |
| 振替口座 | 最大15か月（14か月前1日から） | 同じ | 画面1回100明細、CSV最大30,000明細 |
| ダイレクト＋ | 最大20年、ただし2021年3月以降 | 同じ | 画面1回100明細、CSV最大30,000明細 |
| 通帳未記入分 | 有通帳総合口座で期間を問わず未記帳分 | CSV対象としては公開資料で明記なし | 30行到達で合算表示 |
| 通帳アプリ | 初回登録/ダイレクト申込/2021年3月の条件で起算日が変わる | app単独CSVは確認できない | 公開上の表示最大件数は未確認 |

ダイレクト利用申込書の処理日以前、Web申込の場合は申込時点以前の明細は照会できない。
ダイレクト＋でも2021年2月以前は最大15か月であり、「20年」は現時点で20年分が既に
存在するという意味ではなく、2021年3月以降を将来最大20年保持する仕様である。

画面は1回100明細で、期間を細かく区切れば続きも確認できる。ただし1日で100明細を
超える場合、画面は直近100件だけになり、超過分を画面では回収できない。CSVにはこの
100件制約がなく、最大30,000件であるため、KoganeはCSVをprimary artifactにする。

### CSV

- 入出金明細は古い日付から順に出力される。
- 3,000明細ごとに1 CSV、最大10 CSV。複数fileをzipで一括downloadできる。
- `入出金明細ID`はbank-wide stable transaction IDではなく、**その出力内の通し番号**
  と公式FAQが説明している。再download間のdedupe keyとして単独使用しない。
- `詳細1`と`詳細2`は、総合口座では画面の「預入/支払内容」を種別と相手名等に分けた
  内容、振替口座では「取扱種別/備考」に相当する。
- 公開guideの古い版は当日・前日分をCSV対象外としている。現行HTML guide/FAQには
  この注意が明確でないため、当日/前日が現行CSVへ含まれるかはlive比較する。
- CSVのencoding、header全列、金額符号、残高列、口座識別子、同日順序の表現は
  公開資料から確定できない。

暫定dedupeは、source、口座pseudonym、取引日、入出金額、詳細1、詳細2、同日ordinal、
artifact hashを用いる。入出金明細IDは同じartifact内の順序確認にだけ使い、bank側の
永続IDとして扱わない。

### 未記帳、合算、保留

- 有通帳総合口座では、期間にかかわらず通帳未記入分を照会できる。
- 未記帳が30行に達すると合算表示になる。合算後はindividual rowを紙通帳や画面から
  復元できない可能性があるので、2か月window内を定期CSV収集する。
- ダイレクト＋と振替口座には「通帳未記入分」照会がない。
- current balanceは小切手等の決済未完了取扱を含まないが、通常の入出金明細に
  card authorizationのような`pending` rowがあるとは公式資料で確認できない。
- 送金や振込は金額と料金が別明細になる。事務処理により取扱日より後に反映され、
  通帳と表示順が異なる場合もある。短いoverlap windowで再取得し、immutableではなく
  source correctionを許容する。

### PDF、通帳画像、電子交付

| artifact | 対象 | 粒度 | Koganeでの扱い |
| --- | --- | --- | --- |
| 入出金CSV | 通常/通常貯蓄/振替、ダイレクト＋ | 構造化row、詳細1/2、出力内ID | primary transaction artifact |
| 入出金HTML | 同上 | current balance、画面上の摘要、直近5/条件指定 | balance/discoveryとCSV検算 |
| 通帳イメージ | ダイレクト＋のみ | 氏名、記号番号、店名/店番、預金種目、口座番号等の表紙image | 口座metadataのmanual evidence。取引明細ではない |
| 振替受払通知票PDF/画像 | 振替口座の通知票/払込票 | 払込人住所・氏名・通信欄等 | 個人の通常貯金MVP外。必要時に別sourceとして扱う |
| 電子交付 | 主に投資信託等の交付書面 | 帳票単位、検索/閲覧 | 通常貯金入出金の代替ではない |

ダイレクト＋の「通帳イメージ」はWeb表示と印刷用画面であり、公式guideはPDF download
とは案内していない。ブラウザ印刷でPDF化はできるが、bank発行のtransaction statement
PDFと誤表記しない。通常貯金/通常貯蓄の入出金について、公式PDF statement exportは
公開資料で確認できなかった。

## 担保定額・定期の明細と履歴

公式Webと通帳アプリでは、総合口座に紐づく担保定額貯金・担保定期貯金について、
次を確認できる。

- 預入状況の確認・変更（明細照会）
- 取引結果照会
- 担保定期の満期時取扱方法
- ダイレクト＋では満期月2か月前の10日前後にメール通知し、message boxで詳細表示

公式操作guideの「明細情報一覧」は、貯金口座/明細ごとに払戻対象を選択する構造である。
これは現在の預入lot列挙に使える強い根拠だが、過去に払戻済みのlotをいつまで取引結果
照会できるか、現在lotと過去operationを一括exportできるかは公開されていない。

また、ダイレクトが扱うのは総合口座の**担保**定額/定期である。専用通帳または証書の
定額/定期を同じWeb coverageに含めない。本人がそれらを保有する場合は、紙/窓口由来の
別sourceであり、本PRの自動化見込みには含めない。

## 認証、端末紐付け、session

### Web login

公式に案内されている経路は次の2つである。

1. **通常login**: 13桁のお客さま番号を4-4-5桁で入力し、8～12桁のlogin passwordを
   入力する。login時2段階認証を有効にし、未登録browserならemail OTPが追加される。
2. **アプリlogin**: お客さま番号を入力してPCにQR codeを表示し、ゆうちょ認証アプリ
   または取引時認証設定済み通帳アプリでQRを読み、生体またはapp passcodeで認証後、
   PCへ戻ってloginする。

email OTPによるlogin時2段階認証では、現在の端末/browserを登録すれば次回からOTPを
省略できる。アプリloginと登録済み端末/browserもemail OTPの対象外である。したがって
persistent Chrome profileは自動化に有利だが、登録状態はbank/session側とbrowser
storageの両方に依存する可能性があり、cookieだけで再現できるとは未確認である。

銀行は一定時間の無操作で自動timeoutすると公表するが、分数、absolute session lifetime、
browser再起動後のcookie再利用、並行session、logoutによる他session失効は公開していない。
session cookieはpasswordと同等のbearer secretとして扱い、ログ、Git、D1/KV/R2の平文、
container imageへ置かない。

### 認証アプリ/通帳アプリ

- 認証はFIDO準拠で、スマートフォンに登録した認証情報を使う。
- 認証アプリの初回登録は、口座登録電話への本人確認code、login password、端末の
  生体情報または6桁app passcodeを使う。1つのお客さま番号は複数端末へ同時登録できず、
  後から登録した端末が有効になる。
- 通帳アプリ初回登録は、口座記号番号、カナ氏名、生年月日、キャッシュカード暗証番号、
  電話番号と5桁確認codeを使う。起動は4桁passcode、Android pattern、または生体認証。
- 通帳アプリは同一口座を複数端末に登録できるが、取引時認証は1端末のみ。
- 通帳アプリに取引時認証を設定すると、認証アプリ/トークンから切り替わり、元へ戻せない
  場合がある。これは重大な設定変更なので、collector検証のために実施しない。

ユーザーの「passkeyを使い、Bitwardenに保存している」という申告は本プロジェクト全体の
文脈としてあるが、ゆうちょの公式手順がいうFIDO認証は**スマートフォン端末に登録した
ゆうちょ認証アプリ/通帳アプリの認証情報**である。Bitwarden WebAuthn passkey loginは
公式手順から確認できない。ゆうちょ用のBitwarden itemが通常のお客さま番号/passwordを
指すのかも未確認なので、live検証までpasskey自動化を仮定しない。

## API

ゆうちょ銀行は公式に次の参照系APIを公表している。

- 現在高照会
- 入出金明細照会
- 担保定額定期明細照会
- 口座貸越元金等照会
- 投資信託明細照会

技術的には、口座・通常ledger・定額定期lotを1つのofficial surfaceから取得できるため、
Koganeの理想形に近い。browser HTML change、CSV download、Akamai edgeを避け、Workersの
`fetch`にも適する。しかし、次の条件がある。

- 銀行法上の電子決済等代行業者で、銀行のsecurity/運用基準に合致すること。
- ゆうちょ銀行とAPI接続の契約を締結すること。個人が自己口座のために発行できる
  developer tokenやsandboxは公開されていない。
- 利用者の「サービス連携に関する同意」は利用開始から90日で終了し、継続には再同意が
  必要である。

よって、APIはaggregatorを使わず銀行を直接data sourceにできるが、Kogane自身が契約主体に
なる必要がある。個人MVPの迂回路ではなく、将来Koganeを正式サービス化する場合の
事業/onboarding trackとして残す。

## Akamai、WAF、anti-automation

### 確認できた事実

- `www.jp-bank.japanpost.jp`、`direct.jp-bank.japanpost.jp`、
  `direct3.jp-bank.japanpost.jp` は2026-08-26のDNSで各 `edgekey.net` CNAMEへ解決され、
  Akamai edge利用を確認した。
- public `www`はgeneric curlへApacheの200を返した。`direct`はHTTP/1.1で20秒無応答timeout、
  HTTP/2でstream errorとなる試行があった。通常browser/crawlerでは公式login pageが取得
  されているため、単純なhost outageではない。
- 銀行はJavaScript/Cookie有効化、画面上buttonによる遷移、正規入口からのloginを要求し、
  browser back/forwardやbookmark直行で手続きが中断/不具合になることがあると案内する。
- 一定時間の無操作でsessionを切断し、複数端末でのアプリ登録とダイレクトloginを並行
  すると安全上の中断errorになる場合がある。
- 公式利用環境は日本国内所在のISPを経由した接続を必要とする。

### 推測・未確認

- `edgekey.net`はAkamai CDNの根拠だが、Akamai App & API Protector、Bot Manager等の
  **特定WAF/anti-bot製品名やpolicyを示さない**。
- curlのtimeout/HTTP2 errorはedge policy、client fingerprint、network相性のどれでも
  起こり得る。これをbot判定確定とは扱わない。
- headless browser、datacenter IP、Cloudflare shared egressがblockされるかは未確認。
- HTML formだけでなく認証後にJSON/internal APIを使うか、TLS/browser fingerprintを
  login判定に使うかは、認証後の受動captureが必要である。

## 公開ゆうちょダイレクトWebのstatic inventory

### login formと遷移transport

2026-08-26に[公式login](https://direct.jp-bank.japanpost.jp/tp1web/U010101SCK.do)を通常Chromeで
未認証表示し、値を読まずにDOM属性と公開JavaScriptだけを確認した。画面はserver-side HTML/Struts
formを維持している。

| 項目 | 公開画面での確認事実 |
| --- | --- |
| 初期document | `GET direct.jp-bank.japanpost.jp/tp1web/U010101SCK.do` |
| form | `submitData`と`simpleTransitionForm`。いずれも初期actionは同じ`U010101SCK.do`、methodは`POST` |
| state/CSRF候補 | hidden `org.apache.struts.taglib.html.TOKEN`と`event`。token値は取得・記録していない |
| お客さま番号 | `okyakusamaBangou1`/`2`/`3`の3 input。value/autofill状態は読んでいない |
| password login | button `U010103`が`event=U010103`を設定し、`POST https://direct1.jp-bank.japanpost.jp/tp1web/pc/U010901BLC.do`へform submit |
| app login | button `U010107`が`event=U010107`を設定し、`POST https://direct1.jp-bank.japanpost.jp/tp1web/pc/U011101BLC.do`へform submit |
| smartphone導線 | `event=U010105`で`https://direct1.jp-bank.japanpost.jp/tp1web/sp/U010101SCK.do`へ遷移 |
| app deep link | 認証appは`fidoap.jp-bank.japanpost.jp/links/fido/...`、通帳appは同hostの`links/banking/...`。いずれも`redirect_uri=https://direct.jp-bank.japanpost.jp/tp1web/pc/U011401BLC.do`と`loginFuriwakeKubun=1`を渡す |

同日の公開画面は「QRコード読み取りによるログインを一時的に停止」と表示し、password loginまたは
スマートフォンからのDirect利用を案内していた。DOM/JavaScriptにapp login routeが残ることは、PCの
QR loginが現在利用可能である証拠ではない。停止解除はlive検証時に公式画面で再確認する。

公開`dcRequest(formName, url, names, values, alreadyClickControl)`は、指定hidden fieldへevent値を
設定し、form actionを引数URLへ置換して`submit()`する。したがって`.do` pathや`POST`だけのallowlistは
read/write隔離にならない。認証後は画面ID、event、exact button label、response画面を組にして、liveで
確認したread操作だけをallowlistにする。

`org.apache.struts.taglib.html.TOKEN`はCSRF/page-state候補だが、これだけからsession発行方式を断定しない。
app flowは`U011401BLC.do`へ戻ることまで確認できたが、FIDO assertion、redirect後のsession cookie、
password/OTP flowとのsession共通性は未確認である。Cookie、token、QR、FIDO `rawdata`は観測対象外とする。

### 公開JavaScript、security/anti-fraud候補

公開loginが実際にloadしたartifactを値なしでhash化した。hashは2026-08-26のsnapshotで、安定API契約を
意味しない。

| artifact | SHA-256 | static inventory |
| --- | --- | --- |
| `cache.../run.js?rv=26051` | `8b3c4673af6cfeb824b14914e9821799f7fbda3bde947ada63833ff2d1154b31` | FIDO app launch helper。`redirect_uri`と`loginFuriwakeKubun`を組み立てる |
| `cache.../dgbaRequestControllerP02.js?rv=26051` | `4d889649c218bde85ab1af95f9779b5cad73578d0033b85027018f4b41c4d647` | 公開pageのrequest/UI controller |
| `directcss.../HcFwEhqexk.js` | `3fca08de3ca3293ea490d557d7bae615f4a09916d36fce2bf06e2f157663f876` | `sendBeacon`/XHR、device/token/AES語を含むloader候補。役割/vendorは未確定 |
| `directacct.../aes.js` | `fc7e184beeda61bf6427938a84560f52348976bb55e807b224eb53930e97ef6a` | 公開AES実装。どのfieldに適用するかは未確認 |
| `directacct.../load.js` | `f8bf373263f5a240e0233345e28bc19c5c56119115d936197d3cc13b3fa8756d` | beacon/XHR、device/token/encrypt/decrypt候補 |
| `directacct.../dl.js` | `8948fc815424bd77a7692f64b2b8e488295dff14ab2963798e22088a74fdec5b` | loader |
| `directss.../ig.json` | `0d7c95ddd386ea08185249944e82fa26ee0965bdd13482b46e42baf09b2733c3` | `pwc_loadpljs`を呼ぶbootstrap script |
| `directss.../js/r.js?ver=21&rev=826202611` | `aaa4679b3b76bfaf83374efe520289d2ccc1752a1c18f20855b9529c2d61cf95` | page ID、FIDO/token、screen/window、localStorage/cookie UUID、public-key encrypt、`dcRequest` hook、XHR/JSONP等のsymbolを持つobfuscated instrumentation候補 |

公開page loadだけで、`/akam/13/198d305`のscript、同originの動的pathへのGET後POST、
`directss.jp-bank.japanpost.jp/d`へのCORS preflight/POSTも発生した。body、header、Cookie、token、
fingerprint値は取得せず、replayもしなかった。Akamai sensorおよび行動/不正検知telemetryの強い候補だが、
各scriptのvendor/product、収集field、判定policyは確認事実から分離する。

### 公開情報で確定できるread coverage

公開loginで確定できたのは認証前のtransportだけである。残高、入出金、CSV、担保定額/定期については
公式guideで画面機能を確認できるが、認証後のread endpoint、event、HTML/JSON schema、CSV生成requestは
公開pageから取得できなかった。`U010901BLC.do`等はlogin遷移であり、残高/明細read endpointとして
再利用しない。本人操作のread-only runtime観測で、値を落として次だけを追加inventoryする。

- page title、form name、event/button label、method、host、path template、status、content-type
- balance/statement/CSV/fixed-deposit画面がHTML navigation、XHR/JSON、downloadのどれか
- session発行/refreshがpassword login、app login、登録済みbrowserでどう異なるか
- 同一endpoint/event familyに送金、払込、定額/定期預入・払戻等のwriteが同居するか

## Android APKと静的解析

### 公式package、version、provenance

2026-08-26に公式Google Play HTMLを直接確認した。

| app | package | version / Play更新日 | read/auth上の役割 |
| --- | --- | --- | --- |
| [ゆうちょ通帳アプリ](https://play.google.com/store/apps/details?id=jp.japanpost.jp_bank.bankbookapp) | `jp.japanpost.jp_bank.bankbookapp` | `21.0.0` / `2026-04-10` | 現在高、入出金、担保定額/定期、最大2口座。取引機能も同居 |
| [ゆうちょ認証アプリ](https://play.google.com/store/apps/details?id=jp.japanpost.jp_bank.FIDOapp) | `jp.japanpost.jp_bank.FIDOapp` | `18.0.0` / `2026-04-09` | 金融dataは持たず、Direct login/取引時の端末FIDO認証 |

銀行siteからのstandalone APK配布は確認できない。第三者mirrorはpackage/version表示だけでも正規splitや
signer provenanceを保証しないため取得元にしない。この環境にはGoogle Playからinstall済みの管理Android、
`adb`、`apksigner`、`bundletool`、`jadx`、`apktool`、`aapt2`、MobSFがなく、binaryは取得できなかった。
DockerだけではPlay entitlement、端末固有split、signing provenanceを作れない。

Play HTMLが確認するのはpackage/versionName/更新日までである。versionCode、base/split構成、signer digest、
APK hash、ABI/density/language split、rollout variantは正規artifact取得後に確定する。

### 正規split APKの取得・署名確認手順

ユーザー管理AndroidへGoogle Playから通常installした後、repository外の暗号化一時領域で実行する。

```bash
for PKG in jp.japanpost.jp_bank.bankbookapp jp.japanpost.jp_bank.FIDOapp; do
  adb shell dumpsys package "$PKG" | rg 'versionName|versionCode|firstInstallTime|lastUpdateTime|signingInfo'
  adb shell pm path "$PKG"
  mkdir -p "artifact/$PKG"
  while IFS= read -r LINE; do
    REMOTE=${LINE#package:}
    adb pull "$REMOTE" "artifact/$PKG/$(basename "$REMOTE")"
  done < <(adb shell pm path "$PKG")
done

sha256sum artifact/jp.japanpost.jp_bank.bankbookapp/*.apk
sha256sum artifact/jp.japanpost.jp_bank.FIDOapp/*.apk
for APK in artifact/jp.japanpost.jp_bank.bankbookapp/*.apk artifact/jp.japanpost.jp_bank.FIDOapp/*.apk; do
  apksigner verify --verbose --print-certs "$APK"
done
```

同一packageのbase/splitでsigner digestが一致することを確認する。2つのappが同一signerとは仮定しない。
package、versionName/versionCode、各split名/hash、signer certificate SHA-256、取得日時、Play install端末
だけをprovenance recordへ残し、APK/decompiled codeはGitや第三者cloudへuploadしない。

### manifest、host、schema、session/security inventory

```bash
jadx -d jadx-bankbook artifact/jp.japanpost.jp_bank.bankbookapp/*.apk
jadx -d jadx-fido artifact/jp.japanpost.jp_bank.FIDOapp/*.apk
apktool d -f artifact/jp.japanpost.jp_bank.bankbookapp/base.apk -o apktool-bankbook
apktool d -f artifact/jp.japanpost.jp_bank.FIDOapp/base.apk -o apktool-fido
aapt2 dump xmltree artifact/jp.japanpost.jp_bank.bankbookapp/base.apk AndroidManifest.xml
aapt2 dump xmltree artifact/jp.japanpost.jp_bank.FIDOapp/base.apk AndroidManifest.xml
rg -a -n 'https?://|wss://|jp-bank|direct[0-9]?|fidoap|redirect_uri|loginFuriwakeKubun|rawdata|okhttp|retrofit|webview|cookie|session|token|bearer|fido|webauthn|keystore|biometric|integrity|attestation|safetynet|certificate|pin' jadx-bankbook jadx-fido apktool-bankbook apktool-fido
```

static inventoryは次を分ける。

- manifest: exported component、permission、intent filter、custom scheme/app link、対象Android/ABI、
  backup/debuggable/profileable、network security config
- app間連携: 認証app/通帳appのpackage check、`fidoap` deep link、`redirect_uri`、
  `loginFuriwakeKubun`、FIDO `rawdata`の生成/受渡し境界
- transport/schema: host/path定数、WebView/native、OkHttp/Retrofit等、request method、serializer/model、
  balance/statement/fixed-deposit response field、CSV/download有無
- session: server session発行/refresh、cookie/token storage、Android Keystore/EncryptedSharedPreferences、
  app reinstall/機種変更時のinvalidation。秘密値は抽出しない
- security: FIDO library/profile、biometric key use、Play Integrity/SafetyNet/attestation、root/debug/instrumentation
  detection、signature self-check、certificate pinning候補。検出や判定は改変しない

R8/ProGuard/string encryptionのdeobfuscation、URL builder/serializerのstatic data-flow追跡は対象である。
ただしFIDO private key、生体template、account identifier、cookie/token、明細cacheの実値を抽出しない。
server response schemaとsession issuanceはstaticだけで確定しない。

### 本人操作のread-only runtime metadata観測

1. 正規install済み・既存登録済み端末を使い、新規登録、再登録、取引時認証への切替はしない。
2. 本人が通常操作で通帳appの現在高、入出金、既存担保定額/定期明細だけを開く。送金、払込、預入、
   払戻、住所/電話、限度額、Direct+切替へ遷移しない。
3. DNS/SNI、host、method、path template、status、content-type、field名だけを記録し、body値、header値、
   Cookie、token、FIDO assertion/QR/rawdata、account/残高/摘要を保存しない。
4. user-installed CAをappが通常受理する場合だけlocal proxyを使う。pinning/integrity/FIDO errorなら
   patch/hookで回避せず、encrypted metadata観測またはstatic analysisへ戻る。
5. runtime tracingはread画面のURL builder、OkHttp request metadata、serializer/model field名、WebView
   navigationに限定する。certificate verifier、trust manager、FIDO/Keystore、integrity verdictをhookしない。
6. 認証appは本人が既存のlogin承認だけを行い、observerはapp launch/return hostとstatusだけを見る。
   認証情報登録、eKYC、取引認証、取引code設定は行わない。
7. appとWebで同じ短期間を表示し、口座数、current/available balance field、明細件数/field、担保定額/
   定期lot coverageを値なしで比較する。appに公式CSV exportがないこともUIで再確認する。

Frida/Objection等のtracing自体を非目標にはしないが、正規appが通常起動する環境でread serializerを受動
観測できる場合に限る。root化、Gadget注入、signature repack、anti-instrumentation無効化、pinning/
integrity/FIDO bypassが必要になった時点で停止する。

## 第三者client

| 実装 | 最終更新/時期 | 方式 | 現在の扱い |
| --- | --- | --- | --- |
| [`kkosuge/bank_job`](https://github.com/kkosuge/bank_job/blob/0908e082d4c196a0fc8335351855874eb88b1549/lib/bank_job/strategies/bank_job_yucho.rb) | 実装commitは2014 | Ruby Mechanize。`U010101SCK.do`から4-4-5お客さま番号、合言葉、passwordをHTML form送信し、入出金tableをparse | 合言葉廃止前の旧実装。現在動作する根拠なし |
| [`toc/pogact`](https://github.com/toc/pogact/blob/83c82ef99197c960a4d22ad127dfa14a78a393e8/pogact/RPAbase/JPBankBase.py) | repoは2024更新、JPBank codeは旧画面 | Selenium。お客さま番号、合言葉、passwordを入力し、PhishWall案内をskipしてlogin | browser方式の参考。現行認証/app login未対応 |
| [`pocke/japan-post-bank-login`](https://github.com/pocke/japan-post-bank-login) | 2016 | Chrome extensionでお客さま番号3欄を自動入力 | 明細clientではない。login補助のみ |
| [`shinichy/get_statement`](https://github.com/shinichy/get_statement/blob/master/get_statement.py) | 2018 | Python Seleniumで各社CSV/PDFをdownload | ゆうちょ実装なし。対象listにもJP Bankはない |

古い `bank_job` はbrowserではなくcookie jar付きHTTP clientで、form action/eventを
JavaScript `onclick`から抽出し、HTML tableをparseしていた。これは当時の内部HTTPが
JSON APIではなくstateful server-side HTML formだったことを示す。現行loginは画像/合言葉
が廃止され、アプリFIDOとemail 2FAが追加されているため、endpoint名やfield名を再利用しない。

現行対応をうたうbank-only OSS client、公式SDK、個人用API wrapperは見つからなかった。
検索で見つかる家計簿/会計service連携は、銀行の参照系APIを契約利用するaggregatorであり、
本sourceの実装候補から除外する。

## 実行基盤の適性

| 基盤 | 適性 | 理由 |
| --- | --- | --- |
| ユーザー管理下の通常Chrome/Kuebiko | **高** | 正規browser、登録済み端末、app QR、人手認証、CSV downloadを扱える。初回観測とMVPに最適 |
| Cloudflare Workers | browser login **低**、API/orchestrator **高** | browser/app/FIDOを実行できず、日本国内ISP要件とshared egressも課題。正式API契約後のHTTP collectorには最適 |
| Cloudflare Containers | **中** | Playwright/Chromeとdownloadは可能。ただしpersistent profile、app QR人手、Akamai、国外/変動egressの検証が必要 |
| OCI VM/Container（Tokyo/Osaka） | **中～高** | 日本region、固定disk、通常Chrome、download暗号化を構成しやすい。login成功とISP要件適合はlive確認が必要 |
| OCI Kubernetes | **中** | CronJob、secret隔離、persistent volumeは使えるが、端末bound loginと1口座collectorには運用過剰。並行実行防止が必須 |

Cloudflare Workers単体は、CSV downloadを含むstateful HTML/browser flowと端末FIDOを扱えない。
Cloudflare Containerは技術的には可能だが、公式利用環境が「日本国内に所在するISP」を要求
するため、Sydney等の国外egressを使う構成は採用しない。Cloudflareの日本egressを安定して
保証できるかも未確認である。

OCI Tokyo/Osakaのpersistent VM/Containerは、通常Chrome profileを保持しやすく、最も現実的な
cloud browser候補である。ただしcloud datacenterが銀行のいうISP要件を満たすかは解釈せず、
1回のbounded loginとサポート/規定確認を行う。Kubernetesは複数sourceの共通browser runtimeが
必要になるまで導入しない。

## 推奨architecture

1. ユーザー管理下の通常Chrome profileで正規login入口を開く。既存sessionが有効なら再利用し、
   失効時だけ人に通常passwordまたは認証アプリQRを求める。
2. 初回はKuebikoで認証後のread-only navigationを受動captureする。home、現在高、入出金明細、
   CSV download、担保定額定期の明細一覧だけを開き、write formへ入らない。
3. CSVをprimary transaction artifact、現在高HTML/JSONをbalance、担保定額定期HTML/JSONをlot、
   ダイレクト＋の通帳イメージをaccount metadata evidenceとして保存する。
4. source-scoped session envelopeを暗号化し、collectorへ渡す場合もお客さま番号/password、app認証鍵、
   Bitwarden vaultは渡さない。login redirect、timeout、401/403で停止し、credential loginを自動retryしない。
5. 1 sourceにつき1 active runとし、アプリ登録とWeb loginを並行しない。Cloudflare Workerはschedule、
   lease、暗号化artifact受領、R2/D1 metadataに使い、browserはlocalまたは検証済みOCIで動かす。
6. 有通帳総合口座は2か月windowを失わないよう、月1回ではなく週1回程度CSVを重複取得する。
   ダイレクト＋は月次でよいが、同じ期間を再取得して訂正/順序差を検出する。
7. 正式API契約の事業要件が生じた時だけ、電子決済等代行業者trackを別initiativeとして評価する。

## 次のbounded検証

すべて本人名義口座・読み取り専用で行い、値は保存せず、field名、type、件数、shapeだけを
sanitized noteへ残す。

1. 既存Chrome tab/profileを確認し、正規URLで未認証/認証済み状態を判定する。
2. ユーザー申告のBitwarden itemが、ゆうちょ画面で通常password fill、passkey prompt、対象外の
   どれかだけを確認する。secret値、お客さま番号、vault item IDは記録しない。
3. ユーザーによる1回のloginで、通常password、email 2FA、認証アプリQRのどのflowになるかを確認する。
   認証設定は変更せず、失敗時に繰り返し試さない。
4. home/利用口座一覧から、口座科目、masked identifier、現在高/うち振替/引出可能のfield、最大10口座
   のpagingと、利用口座登録外の本人名義口座有無を確認する。
5. 短い同一期間をHTMLとCSVで1回ずつ取得し、encoding、header、全列、金額符号、同日順序、
   `入出金明細ID`のrestart、当日/前日含有、残高列、30,000件未満のpagingを比較する。
6. 通帳未記入分がある場合のみ、件数と合算rowのfield shapeを確認する。記帳や設定変更はしない。
7. ダイレクト＋を既に利用中なら、古い1か月のCSVと通帳イメージ表示を確認する。未利用なら切替せず、
   最大20年経路は公式仕様のみの確認に留める。
8. 担保定額/定期が存在する場合だけ、明細情報一覧と取引結果照会を開き、現在lot field、過去結果の
   件数/期間、CSV/PDFの有無を確認する。預入、払戻、変更buttonは押さない。
9. 認証後networkを受動観測し、server-side HTML form、XHR/JSON、CSV generation/downloadのrequest
   familyを分類する。auth request body、Cookie、FIDO payload、anti-bot telemetryは保存しない。
10. 同じpersistent profileで7日間、1日1回、homeと短い明細だけを取得し、session再利用、idle/absolute
    expiry、Akamai error、同時実行error、rate limitを測る。
11. local Chromeが安定した後だけ、同じread-only flowをOCI Tokyoのpersistent Chromeで1回試し、
    日本国内ISP要件、追加認証、blockの有無を確認する。Cloudflare Containerはその後の比較対象とする。
12. Google Playから正規install済みの管理Androidが用意できたら、通帳アプリ21.0.0と認証アプリ18.0.0
    のbase/all splitsを取得し、package/versionCode/signer/hashを確認してからstatic inventoryを作る。
13. 通帳アプリのread画面と認証アプリによる既存loginを本人が1回だけ操作し、host/method/path template/
    status/content-type/field名を値なしで観測する。Webとappのread coverage/sessionを比較する。
14. runtime tracingはread URL builder/serializer/WebViewに限定し、pinning/integrity/FIDO/Keystore判定を
    hookしない。appがinstrumentation、root、CAを拒否したら回避せず停止する。

成功判定は、write screenへ進まず、全登録口座のstable pseudonymous identifier、現在高、増分CSV、
担保定額定期lot、raw artifact hashを再現できること。中止条件は、認証設定変更、キャッシュカード
暗証番号/OTPの反復要求、account lock、アプリ再登録要求、root/pinning回避、利用停止の兆候である。

## 確認済み、推測、未確認

### 確認済み

- 通常/通常貯蓄/振替の現在高と入出金、担保定額定期の明細/結果を公式Webで照会できる。
- 有通帳総合口座2か月、振替15か月、ダイレクト＋最大20年（2021年3月以降）。
- CSVは3,000件/file、最大10 files・30,000件。画面は1回100件。
- CSVの入出金明細IDは出力内通し番号で、詳細1/2は画面摘要を分割する。
- 未記帳30行で合算し、ダイレクト＋/振替は未記帳照会を使わない。
- 通帳アプリは最大2口座、認証アプリは同一お客さま番号を1端末のみ。FIDO準拠。
- 参照系APIは現在高、入出金、担保定額定期等を提供し、利用同意は90日で再同意が必要。
- `www`/`direct`/`direct3`はAkamai `edgekey.net`へ解決される。
- 公開loginはStruts token/eventを持つHTML formで、password/app loginは`direct1`の別`.do` endpoint、
  appは`fidoap` linkから`U011401BLC.do`へ戻る。
- 公開login loadはAkamai系動的pathと`directss`へtelemetry POSTする。body値は取得していない。
- 公式Android packagesは通帳アプリ21.0.0と認証アプリ18.0.0で、公式配布はGoogle Play経由。

### 推測

- 登録済みpersistent Chromeで人手loginをbootstrapできれば、CSV収集は高い確率で自動化できる。
- 認証後flowは旧実装と同様のstateful HTML formを一部残しつつ、現行画面ではXHR/internal APIを
  併用している可能性がある。
- OCI Tokyoのpersistent browserはCloudflare国外/shared egressより追加認証が少ない可能性がある。
- 通帳アプリのlocal cacheは明細を保持するが、cloud主経路にするよりWeb CSVを使う方が安定する。

### 未確認

- ユーザーのゆうちょ口座が有通帳、ダイレクト＋、通常貯蓄、担保定額/定期のどれを含むか。
- Bitwardenのpasskey申告がゆうちょに関係するか。公式WebAuthn/passkey loginの有無。
- sessionのidle/absolute lifetime、再起動後再利用、並行session、logout invalidation。
- 現行CSVの全列、encoding、当日/前日、stable balance、訂正/重複の実例。
- 担保定額/定期のexact fields、過去結果保持期間、export有無。
- 認証後endpointがHTML formかJSONか、appとWebが同じbackend APIを使うか。
- AkamaiのWAF/bot製品、headless/datacenter判定、Cloudflare/OCIからのlogin可否。
- 通帳/認証appのversionCode、split、signer、host/path/schema、session issuance、WebView/native境界、
  FIDO profile、pinning/integrity、local DB schema/暗号化。
- ゆうIDが銀行明細loginへ統合される時期/方式。

## 主な根拠URL

- [ゆうちょダイレクト 公開login](https://direct.jp-bank.japanpost.jp/tp1web/U010101SCK.do)
- [ゆうちょダイレクト サービス内容・利用時間・環境](https://www.jp-bank.japanpost.jp/direct/pc/service/dr_pc_sv_index.html)
- [現在高照会の表示項目](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=2)
- [入出金明細の照会期間](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=96)
- [CSVの期間と最大30,000件](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=59)
- [CSV download方法](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=134)
- [CSVの入出金明細ID・詳細1・詳細2](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=132)
- [画面100件とCSV30,000件](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=17)
- [入出金明細操作guide](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_meisai.html)
- [ダイレクト＋](https://www.jp-bank.japanpost.jp/direct/pc/plus/dr_pc_pl_index.html)
- [通帳イメージ操作guide](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_bankbookimage.html)
- [担保定額・定期で可能な手続き](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=25)
- [担保定額・定期の明細情報一覧](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_ttharaimodosi_sp.html)
- [ゆうちょ通帳アプリ](https://www.jp-bank.japanpost.jp/app/app_tsucho.html)
- [通帳アプリ利用上の注意](https://www.jp-bank.japanpost.jp/app/app_goriyo.html)
- [通帳アプリ明細の起算日](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=10051)
- [通帳アプリの複数端末](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=2837)
- [通帳アプリ機種変更](https://faq.jp-bank.japanpost.jp/faq_detail.html?id=10671)
- [Web loginのsecurity/FIDO/2段階認証](https://www.jp-bank.japanpost.jp/direct/pc/security/dr_pc_sc_ds_drsecurity.html)
- [通常password login](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_normalloginguide.html)
- [認証アプリによるPC login](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_nshlogin.html)
- [通帳アプリによるPC login](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_tchlogin.html)
- [認証アプリの初回登録](https://www.jp-bank.japanpost.jp/direct/pc/guide/dr_pc_gd_nshtouroku.html)
- [参照系APIの提供範囲](https://www.jp-bank.japanpost.jp/aboutus/activity/api/abt_act_api_houshin.html)
- [API接続基準](https://www.jp-bank.japanpost.jp/aboutus/activity/api/abt_act_api_kijun.html)
- [API利用同意90日](https://www.jp-bank.japanpost.jp/direct/pc/drnews/2024/drnews_id000137.html)
- [電子決済等代行業者との契約一覧](https://www.jp-bank.japanpost.jp/aboutus/activity/api/abt_act_api_keiyaku.html)
- [Google Play: 通帳アプリ](https://play.google.com/store/apps/details?id=jp.japanpost.jp_bank.bankbookapp)
- [Google Play: 認証アプリ](https://play.google.com/store/apps/details?id=jp.japanpost.jp_bank.FIDOapp)

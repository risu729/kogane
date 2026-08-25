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

| 経路 | 入口 | 読み取り可能な主なデータ | 出力／自動化上の位置付け |
| --- | --- | --- | --- |
| 三菱UFJダイレクト（ブラウザ） | [公式トップ](https://direct.bk.mufg.jp/index.html)、[現在のPCログイン画面](https://directg.s.bk.mufg.jp/APL/LGP_P_01/PU/LG_0001/LG_0001_PC01) | 代表口座とサービス指定口座、残高、円入出金、定期預金明細、外貨預金、取引記録、直近の銀行ポイント加算実績 | **推奨**。CSV/PDF/印刷を持ち、Playwright等の通常ブラウザで観測しやすい。ログインはスマホ承認を要する可能性が高い。 |
| 公式「三菱UFJ銀行」アプリ | [Google Play (`jp.mufg.bk.applisp.app`)](https://play.google.com/store/apps/details?id=jp.mufg.bk.applisp.app&hl=ja)、[公式案内](https://direct.bk.mufg.jp/btm/banking/sp_appli.html) | 残高、入出金明細、定期預金、外貨預金等。スマホ版明細は最大200件 | 表示確認と認証発行元として重要。ただし円明細の印刷ボタンがなく、公式CSVもPCブラウザ限定。端末紐付け・root検知があり、主収集器には不向き。 |
| 三菱UFJダイレクト API | [サービス説明](https://direct.bk.mufg.jp/btm/ser_naiyo/api.html)、[利用規定](https://direct.bk.mufg.jp/btm/kitei/api.html)、[開発者ポータルFAQ](https://developer.portal.bk.mufg.jp/btmu/openapitrial/faq) | 口座情報、入出金明細、定期預金明細等。アクセストークン方式 | 公式かつ理想的だが、対象サービス提供会社との連携が前提。体験環境から個人用本番クライアントへ進む公開セルフサービス経路は確認できない。初期コスト **5/5**。 |
| Mable | [公式終了案内](https://www.bk.mufg.jp/tsukau/app/lp/mable/moneycanvas/index.html) | 旧家計管理・つかいわけ口座操作 | **2024-03-27終了**。既存ユーザーもアプリは利用不可。収集経路にしない。 |
| Money Canvas | [Mableとの差分・移行FAQ](https://faq01.bk.mufg.jp/faq/show/4980?site_domain=moneycanvas)、[更新遅延FAQ](https://faq01.bk.mufg.jp/faq/show/4979?site_domain=moneycanvas) | 資産・明細・推移。Mableデータの一部を移行可能 | 銀行提供サービスだが、金融機関明細は Moneytree サービスで取得する。つかいわけ口座操作・各種入出金通知も移行されない。aggregator 回避条件に反する。 |

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

## Androidアプリと静的解析

[Google Play](https://play.google.com/store/apps/details?id=jp.mufg.bk.applisp.app&hl=ja) で確認できる公式パッケージは
`jp.mufg.bk.applisp.app`、2026-08-05更新、`13.11.0`、500万件以上ダウンロードである。
銀行サイトからの独立した公式APK直配布は確認できず、公式導線はGoogle Playである。

Playの公開説明はroot化済み端末やroot化ツール導入端末で正常動作しない可能性、電話・位置情報権限、
生体認証・OTPを明記する。認可された自端末からAPK split一式を保存できれば、静的解析には次の価値がある。

- manifest、App Links／custom scheme、接続先hostname、WebView境界、REST/GraphQL候補を列挙する。
- Network Security Config、certificate pinning、難読化、Play Integrity/root検知の有無を確認する。
- 口座一覧・円明細・定期・外貨画面が共通Web/APIか、ネイティブ専用APIかを切り分ける。

ただし静的解析で端末鍵、生体認証、セッショントークンを再現できるとは考えない。root検知と1台紐付けのため
動的フックの実装コストは高く、公式Webが十分な間は後回しにする。APKを非公式配布サイトから取得しない。

## 公開クライアントの調査

現行・旧実装をコードで確認した結果、公開例は **ブラウザDOM操作または公式CSV** が中心で、
現行の認証済みinternal JSON APIを直接呼ぶ保守中クライアントは見つからなかった。

| 実装 | 最終確認 | 方式 | 評価 |
| --- | --- | --- | --- |
| [4noha/openmoney `plugins/mufg/scraper.py`](https://github.com/4noha/openmoney/blob/7fa001a411549f3b55ec766701dd4c07b45c8c98/plugins/mufg/scraper.py) | 対象ファイルのcommit 2026-05-09 | Playwrightで現行ログインURLを開き、契約番号・パスワードを入力。MUFGあんしんパスのQRをユーザーへ送り、承認待ち後に円明細画面を月別・最大25カ月、100件単位でDOM解析 | 現行方式の強い参考。完全無人ではなくスマホ承認を明示。残高・外貨・定期・CSV raw evidenceは未充足。 |
| [nakaomote/financial `ufj_download.py`](https://github.com/nakaomote/financial/blob/1565e12aab81c4ac08687e405869f5681ede20ca/ufj_download.py) | 対象ファイルのcommit 2025-04-20 | headless Seleniumでログインし、円明細CSVをダウンロード | あんしんパス導入前で、旧画面セレクタを含む。現在動作は未確認。 |
| [yusuke1225math2/my-finance `ufj_driver.py`](https://github.com/yusuke1225math2/my-finance/blob/ea552e35974d6c6efbf9936e88800eaf80c9a5ab/ufj/ufj_driver.py) | 対象ファイルのcommit 2024-05-30 | headless Selenium、過去30日CSV | 認証と画面変更に弱い旧例。 |
| [shinichy/get_statement `get_statement.py`](https://github.com/shinichy/get_statement/blob/6f9730162d72eb9d14fa950767fdbcc8836676c1/get_statement.py) | 2018-12-01 | Seleniumで旧画像ボタンを操作しCSV | 歴史資料のみ。 |
| [Finance::Bank::JP::MUFG](https://github.com/gitpan/Finance-Bank-JP-MUFG/blob/7a19f150108c58153167eda612ff44f54bee04e0/lib/Finance/Bank/JP/MUFG.pm) | 2012-10-21 | `WWW::Mechanize`でHTMLフォーム`_TRANID`を直接POSTし、口座・取引・CSVを解析 | ブラウザ不要HTTP clientの先例だが、現行認証・Angular UIよりはるかに古く再利用不可。 |
| [Zaim CSV Converter](https://github.com/yukihiko-shinoda/zaim-csv-converter) | repo更新 2026-08-20 | ユーザーが公式Webから落としたCSVをローカル変換 | CSV parser設計の参考。ログインもinternal APIも扱わない。 |

`openmoney` の実例は、MUFG銀行において「ログイン後のWeb画面取得」は現実的だが、あんしんパス承認を
人間ループから外せないことを示す。一方、internal APIの有無・request shape・session replay可否は公開コードでは
確定しないため、Kuebikoで認証済みの実通信を受動観測するのが次の最小検証である。

## 実行基盤の適性

| 基盤 | 適性 | 理由 |
| --- | --- | --- |
| Cloudflare Worker（isolate） | 低 | フルChromeもAndroidアプリも動かせない。認証後の単純HTTP APIが特定・再生可能になった場合のcoordinator／ingestには適する。 |
| Cloudflare Container | 中 | Linux Playwrightは動かせるが、短命コンテナ単体では登録スマホの生体承認を完結できない。まず承認済みセッションのimport/replayが通るかを試す。セッションが再生できる場合のみ収集器候補。 |
| OCI VM／Kubernetes | 中〜高 | 永続Chrome profile、固定実行環境、長い承認待ちを保ちやすい。完全無人化は保証しないが、スマホ承認を含むbrowser issuerにはContainerより扱いやすい。 |
| ローカルの可視Chrome | 高（初期） | ユーザーが登録スマホで承認しやすく、Bitwardenから秘密を安全に入力でき、Kuebikoで全通信を観測できる。最初のissuer／fallbackにする。 |

推奨分割は、可視Chromeを **session issuer**、短命Linux実行環境を **read-only consumer** とする構成である。
ただしsession replayが通らなければ、OCI等の永続ブラウザでユーザー承認付き半自動収集を採用し、
Cloudflareはraw evidence受信・保存だけに限定する。

## 実装コストと推奨順

| 経路 | コスト (1-5) | 自動化見込み | 採否 |
| --- | ---: | --- | --- |
| 手動ブラウザ + 公式CSV/PDF + Kuebiko | 2 | 定期操作は手動、取得後処理は高 | **今すぐ採用**。最も正確でraw evidenceを失わない。 |
| 可視Playwright + ユーザーのあんしんパス承認 + DOM/CSV | 4 | 半自動は高、完全無人は低〜中 | **第一PoC**。既存の2026年実装例あり。 |
| 承認済みWebセッションのinternal API replay | 3（発見後） | 成功すれば高 | **最優先の技術検証**。現時点ではendpoint未確認。 |
| 公式ダイレクトAPI | 5 | 契約できれば非常に高 | 外部サービス会社としての本番接続条件が重く、当面見送る。 |
| Android APKの静的／動的解析 | 5 | 低〜中 | Webで不足する口座や粒度が判明した場合だけ。 |
| Money Canvas/Moneytree | 2 | 高 | aggregator回避条件に反するため不採用。 |

## 次の検証手順

1. 可視Chromeで現在のログイン画面を開き、ユーザーのいう「passkey」が WebAuthn/Bitwarden なのか、
   MUFGあんしんパスの登録スマホ承認なのかをUIとWebAuthnイベントだけで確認する。秘密値は記録しない。
2. ユーザー承認で一度だけログインし、Kuebikoを受動captureにして、代表口座とサービス指定口座の種類だけを列挙する。
   口座番号・名義・残高はマスクし、普通／スーパー普通／つかいわけ／円定期／外貨普通・貯蓄・定期が
   どの画面に出るかだけを記録する。
3. 円明細を短い期間で表示し、公式CSVのヘッダー、文字コード、件数超過時の挙動、ページング、
   画面上のcurrent/pending表現を確認する。実明細ファイルはprivate capture領域にのみ置き、Gitへ入れない。
4. 円定期、外貨普通・貯蓄・定期、Eco通知、取引推移表PDFの各read-only画面を1回ずつ開き、
   response content type、内部API、ページング、更新時刻をcaptureする。取引開始ボタンは押さない。
5. ログイン直後のcookie jarを暗号化・source scoped envelopeにし、同一マシンの新規profile、WSL、OCIの順で
   残高トップだけを再生する。401/403/ログインredirect/スマホ再承認要求で止め、パスワード再試行しない。
6. replayが成功した場合のみ、Cloudflare Containerで同じread-only GET/内部APIを1回試す。
   失敗した場合はOCIの永続Chrome issuerへ戻し、anti-bot原因と断定しない。
7. internal APIが見つからない、またはCSVより情報量が少ない場合は、公式CSV/PDFを定期的に保存する半自動経路を
   正式ルートとする。APK解析は、Webで取得できない必須データが具体化してから着手する。

## 未確認事項

- 実契約で保有する全口座がサービス指定口座に登録済みか。特に古い円定期・外貨口座。
- 現行個人CSVの正確なヘッダー、文字コード、メモ／未記帳フラグ、1ファイルの改行・ファイル名。
- 円定期・外貨定期の画面フィールド（預入日、満期日、利率、満期取扱、円換算評価等）の完全な一覧。
- 外貨Eco通知の文書種別、PDF/HTML、保存期間、過去明細の欠落有無。
- 入出金CSVとお取引記録の間で、予約取引がいつledgerへ移るか、安定した取引IDがあるか。
- 認証後internal APIの存在、response schema、pagination、rate limit、CSRF、cookie/token期限。
- MUFGあんしんパスの承認済みセッションを別OS/IPへ安全に再生できるか。
- 認証POSTでAkamai Bot Manager/WAFが作動するか。公開DNSだけでは未確定。
- 三菱UFJダイレクト API の本番接続契約をKoganeが現実的に取得できるか。

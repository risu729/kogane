# ドコモSMTBネット銀行（旧 住信SBIネット銀行）一次調査

調査日: 2026-08-26

## 結論

Kogane のデータ源は、aggregator を経由せず、銀行自身の WEB サイトと公式 Android
アプリを対象にする。最初の実装は **公式 WEB を Playwright で操作し、残高ページと公式
CSV を取得する方式**が最も現実的である。公開されている第三者実装では
[`hirano00o/acctf`](https://github.com/hirano00o/acctf/tree/b79008d1b4ceed8eece5a24f61481a2e72216998/acctf/bank/sbi)
が現行画面に最も近く、代表口座・目的別口座・SBIハイブリッド預金の残高と履歴を
Playwright で取得している。ただし、取得後に公式 CSV を削除するため、そのまま Kogane
には採用しない。Kogane では CSV とレスポンスを raw evidence として保存する。

一次評価は次のとおり。

| 対象 | 実装コスト (1-5) | 自動化見込み | 主な理由 |
| --- | ---: | --- | --- |
| 現在残高（代表・目的別・ハイブリッド・円/外貨） | 2 | 高（ログイン後） | 一つの残高画面を DOM 解析する既存実装がある。 |
| 普通預金・SBIハイブリッド預金の入出金明細 | 3 | 高（ログイン後） | 公式 CSV、7年前の1月1日以降、1回999件。口座・通貨ごとの反復が必要。 |
| 円定期・外貨定期・仕組預金の契約/取引履歴 | 4 | 中 | 商品ごとに画面と保持期間が異なる。円/外貨定期取引履歴は15か月。 |
| スマプロポイント / dポイント | 4 | 中 | 銀行画面と dポイントクラブに情報が分散し、保持期間と粒度が異なる。 |
| 人手を含む定期実行 | 3 | 中〜高 | スマート認証NEOのログイン承認に人手を入れれば安定させやすい。 |
| 完全無人のクラウド定期実行 | 5 | 低〜中 | 端末紐付け/FIDO、ログイン承認、セッション寿命、Akamai 判定が未検証。 |

したがって「実装できるか」は肯定的だが、**残高・明細の収集自体より、ログイン状態を
安全に再利用できるかが主要なリスク**である。最初から内部 API の直呼びやクラウド完全
無人化を目標にしない。

## 調査範囲と安全境界

- 対象は、既存の資産インベントリに記載された個人口座
  「住信SBIネット銀行（ドコモSMTBネット銀行）」だけ。
- 代表口座、目的別口座、SBIハイブリッド預金、円/外貨預金、仕組預金、ポイントを対象にした。
- SBI証券、SBI新生銀行、NEOBANK提携支店、法人サービスは対象外。
- 銀行の公式 WEB / 公式アプリをデータ源とし、Money Forward 等の aggregator は使用しない。
- 調査中にログイン、振込、振替、ポイント連携、設定変更は行っていない。
- 秘密、口座番号、ユーザーネーム、個人名、残高は取得・保存していない。

既存の Google Sheet「資産・残高チェックリスト」は Drive コネクタから読み取り専用で確認した。
保有対象として代表口座、目的別口座、SBIハイブリッド預金、円定期/仕組預金、外貨預金、
ポイントが別々に列挙されていた。本書には個人値を転記しない。

## 現行の名称

2026年8月3日付で商号は **株式会社ドコモSMTBネット銀行**
（英名: DOCOMO SMTB Net Bank, Inc.）へ変更された。個人向けサービスブランドは
**「ドコモの銀行」**である。「住信SBIネット銀行」は旧商号であり、画面やアプリ内では
移行期間中に旧表示が残ることがある。

根拠:

- [ドコモSMTBネット銀行への社名変更について](https://www.netbk.co.jp/contents/lp/ci/)
- [会社概要](https://tneobank.netbk.co.jp/contents/company/about/organization/)
- [新サービスブランド「ドコモの銀行」発表](https://www.netbk.co.jp/contents/company/press/2026/0709_006011.html)

実装名・画面名・スキーマでは新商号を canonical name とし、旧商号を alias に残す。
ファイル名は既存の調査タスク指定に合わせて `sumishin-sbi-bank.md` としている。

## 公式の入口

| 入口 | 用途 | 自動化上の位置付け |
| --- | --- | --- |
| [公式 WEB](https://www.netbk.co.jp/contents/) | 残高、入出金明細、各商品、ポイント | 第一候補。長期間の明細と CSV/PDF がある。 |
| [公式 Android アプリ（Google Play、`jp.co.netbk`）](https://play.google.com/store/apps/details?id=jp.co.netbk&hl=ja) | 残高・明細・生体/FIDO・PC取引承認 | 認証器および仕様調査用。直接自動操作は後回し。 |
| [公式アプリ案内](https://www.netbk.co.jp/contents/lineup/sp-app/netbk/) | 機能・導入経路 | 銀行自身が Google Play / App Store を正規配布経路として案内。 |
| 公式の提携先向け API | 残高・入出金明細等 | 個人向け公開 API ではないため採用しない。 |

銀行は2016年から、電子決済等代行業者等の**提携先向け**に残高・入出金明細の参照 API
を提供している。しかし、公開ドキュメント、セルフサービスのクライアント登録、個人が
自分の口座用に発行できる token は見つからなかった。これは aggregator を避ける今回の
実装経路にはならない。

- [電子決済等代行業者との連携及び協働に関する情報](https://www.netbk.co.jp/contents/company/sitepolicy/api-policy/)
- [API接続サービス開始とマネーフォワード公式連携](https://www.netbk.co.jp/contents/company/press/2016/corp_news_20160325.html)

## 取得できるデータ

### 残高と口座構造

公式 WEB の残高照会では、代表口座・目的別口座ごとの残高を確認できる。公式アプリの
案内にも、円普通預金、目的別口座、外貨普通預金、SBIハイブリッド預金等の残高・明細が
主要機能として明記されている。

目的別口座は代表口座とは別の預金専用の区分で、同時利用は最大10個。円普通預金、円定期、
外貨普通、外貨定期を目的別口座に保有できる。目的別口座には外部振込用の口座番号がなく、
ATM・振込の直接入出金には使えない。目的別口座名は個人情報になり得るため raw evidence
では暗号化し、ログには出さない。

SBIハイブリッド預金は SBI証券の買付余力へ反映される円預金だが、残高と入出金明細は
銀行側の公式 WEB から取得できる。この調査では SBI証券側の画面・APIは使わない。

根拠:

- [円普通預金（残高照会・入出金明細）](https://www.netbk.co.jp/contents/lineup/yen/futsu/)
- [目的別口座](https://www.netbk.co.jp/wpl/NBGate/i900500CT/PD/shouhin_moku_01)
- [目的別口座は最大10個](https://help.netbk.co.jp/faq_detail.html?id=839)
- [公式アプリ](https://www.netbk.co.jp/contents/lineup/sp-app/netbk/)

### 普通預金・SBIハイブリッド預金の入出金明細

| 項目 | 公式仕様 |
| --- | --- |
| 対象 | 代表口座・目的別口座の円普通/外貨普通、SBIハイブリッド預金 |
| WEBの保持期間 | 7年前の1月1日以降 |
| 形式 | 画面、CSV、PDF |
| CSV/PDF 1回の上限 | 最大999件。多い場合は期間を絞る必要がある。 |
| 主な粒度 | 日付、内容、出金、入金、取引時残高、メモ（公式画面/CSV例による） |
| 失われるケース | 解約済み目的別口座、休止中のSBIハイブリッド預金は画面に出ない。 |

保持期間外は有料の取引明細書請求が必要になる。Kogane は初回取得時に可能な全期間を
口座・通貨・期間で分割し、その後は差分収集する。999件超の期間は自動的に短く分割する。
CSVの文字コードは既存実装と公式例から Shift_JIS が想定されるため、raw bytesを保存して
から UTF-8 正規化版を派生させる。

根拠:

- [入出金明細の照会可能期間](https://help.netbk.co.jp/faq_detail.html?id=831)
- [入出金明細のCSV/PDFダウンロード（最大999件）](https://help.netbk.co.jp/faq_detail.html?id=834)
- [入出金明細画面の機能改善](https://www.netbk.co.jp/contents/company/info/2021/mg_notice_211210_info.html)
- [明細画面のリニューアル](https://www.netbk.co.jp/contents/company/info/2024/0612_002662.html)
- [解約した目的別口座の明細は確認不可](https://help.netbk.co.jp/faq_detail.html?category=87&id=848&page=1)

### 円定期・外貨定期・仕組預金

普通預金の入出金明細だけでは契約単位の情報を再現できない。各商品の残高/取引履歴を
別コレクタとして扱う。

| 対象 | 粒度 | 期間/件数 | 評価 |
| --- | --- | --- | --- |
| 円定期預金 | 口座名、取引日、取引内容、金額等 | 取引履歴は過去15か月 | 早期に月次保存が必要。 |
| 外貨定期預金 取引履歴 | 取引日、契約番号、通貨・期間、新規/継続/満期/解約、元金等 | 過去15か月 | 契約単位。満期取扱変更は履歴に出ない。 |
| 外貨定期預金 注文明細 | 受付番号/日時、通貨・期間、注文方法・金額・レート、約定、状態 | 7年前の1月1日以降、1回200件 | 取引履歴より長いが意味が異なる。 |
| 仕組預金 | 残高照会と取引履歴が別画面 | 公式公開情報だけでは期間・件数未確認 | 実画面で確認する。 |

根拠:

- [円定期預金](https://www.netbk.co.jp/contents/lineup/yen/teiki/)
- [円定期預金の取引履歴は過去15か月](https://help.netbk.co.jp/faq_detail.html?id=5792)
- [外貨定期預金の取引履歴](https://help.netbk.co.jp/faq_detail.html?id=5467)
- [外貨定期預金の注文明細](https://help.netbk.co.jp/faq_detail.html?id=5465)
- [仕組預金 残高照会](https://www.netbk.co.jp/contents/pages/wpl050302/i050302CT/DI05030200?CallerScreen=2)

## ポイントの複数経路とトレードオフ

2026年8月20日から dアカウント連携が開始された。連携は任意で、連携後はスマプロ特典等が
dポイントで付与される。既存スマプロポイントを dポイントへ交換した後、スマプロポイントへ
戻すことはできない。一方、**dアカウント連携自体は解除・再連携できる**。既存シートの
「連携は不可逆」は、「スマプロポイントからdポイントへの交換が不可逆」と読み替えるのが正確。
Kogane の調査や収集のために連携状態を変更してはならない。

| 経路 | 得られるもの | 履歴/期限 | 自動化トレードオフ |
| --- | --- | --- | --- |
| 銀行ホーム/ポイント履歴 | 銀行画面内の保有ポイント、通常/限定ラベル、直近期限 | 銀行公開ページは履歴保持期間を明記していない。未連携通常ポイントは付与月の翌々年度3月末、限定は付与ごと。直近期限は最大3件。 | 銀行セッションだけで取れるため最も簡単。履歴期間と項目は実画面確認が必要。 |
| dアカウント連携済みの銀行画面 | dポイント残高と銀行取引由来のポイント表示 | 銀行画面の保持期間は未確認 | 残高スナップショット向け。dポイント全体の由来を網羅しない可能性がある。 |
| dポイントクラブ | dポイント全体の獲得/利用履歴 | 当月を含む最大13か月。反映日、利用日、取引ごとの有効期限等。 | 粒度は最も高いが別ログインが必要で、銀行以外のポイントも混ざる。説明/取引IDで dedupe が必要。 |

dポイント連携済みの場合、銀行画面は「銀行由来のポイント状態」の証拠、dポイントクラブは
「共通ポイント口座の最終台帳」として別々に保存する。同じ付与を合算して二重計上しない。
`provider`, `source_description`, `use_date`, `reflected_at`, `expires_at`, `amount`,
`limited` を照合キー候補にする。公式に一意IDが出るかは実画面で確認する。

根拠:

- [dアカウント連携開始](https://www.netbk.co.jp/contents/company/press/2026/0820_006233.html)
- [dアカウント連携（解除・再連携、交換後は戻せない）](https://www.netbk.co.jp/contents/lineup/daccount/)
- [銀行のポイント画面と有効期限](https://www.netbk.co.jp/contents/lineup/smartprogram/point/)
- [dポイントの獲得・利用履歴は最大13か月](https://dpoint.docomo.ne.jp/static/guide/faq/PointHyouji/PointHyouji01/)
- [dポイント履歴の項目](https://dpoint.docomo.ne.jp/guide/faq/PointHyouji/PointHyouji03.html)

## 認証

### 確認済み

- WEB とアプリは同じユーザーネーム/WEBログインパスワードを使う。
- スマート認証NEOはスマートフォンを1台だけ登録し、FIDO標準仕様に準拠する。
- 登録時は銀行登録電話番号と端末の電話番号が同じである必要があり、SMSまたは電話認証を行う。
- 生体認証または6桁PINをアプリログイン/承認に使う。
- PC/ブラウザのログイン承認をONにすると、登録スマートフォンの承認が必要になる。
- PCの振込等の最終承認は認証番号表からアプリ承認に置き換わる。読み取りコレクタは取引画面へ
  遷移しない。
- 公式ログインページの公開 JavaScript bundle は、同一サイト内部に `api.` / `authn.` 系の
  API base、`/auth/v1/request/authentication` 等の認証パス、JSON用ヘッダを持つ SPA である。
  したがって内部 API の存在は確認できるが、非公開・無保証である。

根拠:

- [スマート認証NEO](https://www.netbk.co.jp/contents/lineup/smartauth-neo/)
- [登録方法](https://www.netbk.co.jp/contents/lineup/smartauth-neo/register/)
- [PCでの利用方法](https://www.netbk.co.jp/contents/lineup/smartauth-neo/pc/)
- [QRコードログイン](https://www.netbk.co.jp/contents/lineup/smartauth-neo/qrcode-login/)
- [公式アプリ](https://www.netbk.co.jp/contents/lineup/sp-app/netbk/)

### 未確認

- 認証後 JSESSIONID のサーバ側有効期間、アイドルタイムアウト、再利用条件。
- ブラウザプロファイルを再起動したときにログイン状態が残るか。
- ログイン承認をONにした保有口座で、毎回の collector 起動に承認が必要か。
- dアカウント連携済みの場合に、銀行画面のポイント照会で追加認証が発生するか。

匿名アクセスでは `AWSALB` / `AWSALBCORS`（7日）と `JSESSIONID`（永続期限なし）を観測したが、
これは認証済みセッションの寿命を示さない。セッションを cookie の期限だけで「有効」と判断しない。

## Akamai / anti-bot

### 確認済み事実

- `www.netbk.co.jp` と `help.netbk.co.jp` は DNS で `*.akamaiedge.net` に解決した。
- 2026-08-26 の匿名 HEAD/GET 応答には `AKAMAI: <edge IP>` ヘッダがあった。
- オリジン側は `Server: Apache`、ロードバランサCookieとして `AWSALB` / `AWSALBCORS` を返した。
- 通常UAと `HeadlessChrome` を含むUAの匿名ログイン入口 GET はどちらも HTTP 200 で、
  CAPTCHA や Access Denied は返らなかった。
- 匿名応答では `_abck`, `bm_sz`, `ak_bmsc` は観測しなかった。

以上から **Akamai の edge/CDN を利用していることは確定**している。一方、Akamai Bot Manager、
Account Protector、ログインPOSTだけの追加ルールの有無は確認できない。公開GETが通ることは
認証自動化が通る証拠ではない。ログイン試験は別PRで、低頻度・人手付き・成功条件を明示して行う。

## Android APK と静的解析

公式 Android アプリは Google Play で `jp.co.netbk` として公開され、2026-07-24 更新、
100万件以上のダウンロードと表示されている。公式の動作保証は Android 8.0 以上。
銀行自身の案内は Google Play を配布経路としており、公式サイト上の単体 APK ダウンロードは
見つからなかった。

- [Google Play](https://play.google.com/store/apps/details?id=jp.co.netbk&hl=ja)
- [公式インストール手順](https://www.netbk.co.jp/contents/lineup/sp-app/netbk/install.html)
- [動作保証OS](https://www.netbk.co.jp/contents/lineup/sp-app/os-version.html)

静的解析は次の確認には有用である。

- API host、path、JSON/Protocol Buffer model、アプリ固有 User-Agent。
- FIDO/スマート認証NEO、端末鍵、certificate pinning、Play Integrity/端末改変検知。
- 残高/明細が WEB と同じ API か、アプリ固有 API か。
- app-only のポイント・外貨画面の endpoint と保持期間。

ただし、WEB の公開 bundle だけでも内部 API の存在は分かり、残高/CSV の実装参考もある。
したがって APK 解析は phase 2 とする。取得する場合はユーザー所有端末または正規 Play 配信から
split APK を保存し、署名証明書とハッシュを記録する。第三者 APK mirror を信頼源にしない。
端末紐付けの複製や認証回避は行わない。

## 第三者クライアントのコード確認

| 実装 | 更新状況/方式 | 銀行対応 | Kogane への評価 |
| --- | --- | --- | --- |
| [`hirano00o/acctf`](https://github.com/hirano00o/acctf/tree/b79008d1b4ceed8eece5a24f61481a2e72216998) | 2026-05、Python + Playwright | ユーザーネーム/パスワードで公式 WEB にログイン。残高DOMを解析。代表・ハイブリッド・目的別の履歴を公式CSVで取得。期間は7年前の1月1日以降に制限。 | 最有力の仕様参考。CSVを読み込んだ後 `os.remove` し、専用一時ディレクトリも削除するため、raw evidence を残す Kogane にはそのまま使わない。 |
| [`t-bucchi/accagg`](https://github.com/t-bucchi/accagg/blob/3bb5786a84387795ffaa1bdd4f0ab7d22bb72708/accagg/bank/sbinetbank.py) | 最終更新2020、Selenium Firefox + BeautifulSoup | 公式 WEB の普通預金（目的別を含む）と円定期を画面DOMからページ送りして取得。 | データモデル/画面遷移の参考。旧商号を title 条件にし、古い Selenium API/selector のため実行再利用は不可。 |
| [`shinichy/get_statement`](https://github.com/shinichy/get_statement/blob/6f9730162d72eb9d14fa950767fdbcc8836676c1/get_statement.py) | 最終更新2018、Selenium Chrome | `get_sbi_history` が旧 NBGate にログインし、固定URLからCSVをダウンロード。 | 旧 endpoint/selector の歴史資料。解析・raw保管・セッション再利用がない。 |
| [`azuki774/myscrapers`](https://github.com/azuki774/myscrapers/tree/e58339122eef9273fb2566f0a867057d3219b2f6) | 2026-08 | `sbi` は SBI証券。銀行クライアントではない。Money Forward collector は aggregator。 | この銀行には不採用。名称だけで混同しない。 |
| [`kuroro-31/stock-ai-api`](https://github.com/kuroro-31/stock-ai-api/blob/661c60d4669f253e855e150c46ab3d2659f8b30c/components/sbi/bank/login.py) | 2023、Selenium | 銀行ログインhelperのみ。残高/履歴collectorなし。 | 追加価値は低い。 |

GitHub code search で `www.netbk.co.jp` を参照する Python 実装を確認した範囲では、上記以外に
現行の銀行向け HTTP-only client は見つからなかった。`acctf` は内部 API を直接呼ばず、ブラウザで
公式画面を操作し CSV をダウンロードする。これは「公式サイトを直接データ源にする」方針に合う。

## 推奨実装

### Phase 1: 公式WEB + 公式CSV

1. ローカルの可視 Playwright persistent profile でログインする。
2. スマート認証NEOの承認が必要ならユーザーがアプリで承認する。Kogane は承認操作を自動化しない。
3. 認証済みの残高画面を保存し、代表/目的別/ハイブリッド/円・外貨の残高を正規化する。
4. 口座・通貨を切り替え、利用可能な最古日から当日まで期間を分割して公式CSVを取得する。
5. raw CSV bytes、取得時刻、対象画面、口座区分、通貨、開始/終了日、content hashを保存する。
6. 公式CSVから正規化イベントを生成する。CSVを削除しない。
7. 円定期・外貨定期・仕組預金・ポイントは別 endpoint/画面の collector として段階的に追加する。

すべての provider 操作は読取画面に allowlist し、振込・振替・解約・設定・dアカウント連携への
遷移を禁止する。ボタン名だけでなく URL/control ID と HTTP method も記録して拒否する。

### Phase 2: internal API の限定利用

Playwright の正常な読取操作を network trace し、残高・明細表示が呼ぶ同一サイト API を確認する。
セッション内の same-origin `fetch` で同じ結果が再現でき、rawレスポンスがCSV以上の粒度を持つ場合のみ、
表示用 API を collector に昇格する。ログイン/認証 API の再実装、FIDO回避、変更系 API は行わない。

### 失敗時の規則

- 401/403、ログイン画面への戻り、Akamai challenge、承認待ちで即停止する。
- パスワードログインを自動リトライしない。
- 既存セッションと取得済み raw evidence を破棄しない。
- 取得期間を短くする以外の回避策を自動で試さない。

## 実行基盤の適性

| 基盤 | 適性 | 評価 |
| --- | --- | --- |
| ローカル Windows/macOS + 可視ブラウザ | 最良（初期） | 実端末のスマート認証NEO承認と人手介入が容易。まずここで再現性を作る。 |
| OCI / Kubernetes CronJob | 良（Phase 2以降） | フル Chromium、永続ボリューム、固定NAT、暗号化profile、CSV保存を制御できる。ログイン承認とAkamai cloud egressは要検証。 |
| Cloudflare Containers | 条件付き | フル Linux container とブラウザを置けるため Workers より適する。ただし Akamai 判定、永続profile、スマホ承認、ダウンロード保存を検証する必要がある。 |
| Cloudflare Browser Run | PoC向け | CDP/Playwright接続と人手介入は可能だが、セッションは短時間で、銀行の長期profile issuerには不向き。 |
| 通常の Cloudflare Workers `fetch()` | 不適 | 初回ログイン、SPA、FIDO/承認、CSV download を単独では扱いにくい。認証済み read API replay が確認できた後の限定consumer候補。 |

Cloudflare Browser Run は CDP/Playwright をサポートし、セッションの keep-alive は60〜600秒。
これは一回の収集には使えても、ログイン済みブラウザprofileの長期保管には足りない。

- [Browser Run CDP](https://developers.cloudflare.com/browser-run/cdp/)
- [Browser Run Playwright](https://developers.cloudflare.com/browser-run/cdp/playwright/)
- [Browser Run Wrangler sessions](https://developers.cloudflare.com/browser-run/reference/wrangler-commands/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/)

推奨順は、ローカル可視ブラウザ → OCI/k8s の短期consumer → Cloudflare Container/Browser Run
比較である。Kogane の既存 authenticated collector 設計と同様に、session issuer と read-only
consumer を分ける余地はあるが、この銀行で session replay が確認されるまでは採用を確定しない。

## 次の検証手順

次PRでは、ユーザー立会いの読み取り専用セッションで以下だけを行う。

1. 公式WEBへ通常ログインし、ログイン承認の有無と必要操作を記録する。
2. 認証直後に storage state と network HAR を秘密を除外して取得する。
3. 残高画面で、現在保有する口座区分と商品区分だけを確認する。
4. 入出金明細で代表口座/目的別/ハイブリッド/外貨の selector、保持期間、999件分割を確認する。
5. 1か月のCSVを取得し、byte hash、encoding、header、row schemaを記録して raw を保存する。
6. ブラウザ再起動後に session reuse を1回だけ試す。失敗したらログインを自動再試行しない。
7. 銀行ポイント画面の列、履歴最古月、pagination、直近期限表示を確認する。
8. その後に限り、読取APIの same-origin replay と OCI/Cloudflare のセッションimportを比較する。

成功条件は「ログインできた」ではなく、raw evidence と正規化結果が一致し、再取得が冪等で、
書込み系画面/APIへ一度も遷移しないこととする。

## 未確認事項

- 保有口座で実際に存在する目的別口座、SBIハイブリッド預金、定期/外貨/仕組預金の有無。
- 現行WEBの残高画面で目的別口座内の定期・外貨がどの階層で返るか。
- 仕組預金取引履歴の保持期間・最大件数・CSV有無。
- 銀行のポイント履歴画面の保持期間、最大件数、一意ID、CSV/PDF有無。
- 認証済み cookie の寿命、profile再起動後の再利用、IP/UA拘束。
- ログインPOSTに Akamai Bot Manager 等の追加判定があるか。
- APKの難読化、certificate pinning、Play Integrity、API schema。
- OCI/k8s、Cloudflare Container、Browser Run の各 egress からログイン/セッションreplayが通るか。

これらは調査不足を推測で埋めず、次PRの検証項目として残す。

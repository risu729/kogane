# 三井住友銀行: SMBCダイレクト / Oliveの銀行口座側

調査日: 2026-08-26

## 結論

- **推奨データ源は公式WebのSMBCダイレクト**。普通預金のMVPは、公式Webが内部で使うフォームとJSONエンドポイントを読み取り専用で呼び出す方式が最短である。
- **Oliveは別の銀行APIではない**。銀行口座側はSMBCダイレクトとWeb通帳を含むパッケージであり、Olive専用画面よりもSMBCダイレクトの口座一覧・明細を正本とする。
- `pnsk-lab/mnie` の `provider-smbc-direct` は、普通預金1口座について、アプリ承認付きログイン、残高、期間指定の入出金明細、セッション再利用まで実装している。ブラウザを起動せず通常のHTTPリクエストで動くため、MVPの有力な土台になる。
- SMBCセーフティパス登録済みの契約では、登録端末での生体認証が**ログインの都度**必要になる。したがって現時点の自動化見込みは、**人がQR/アプリ承認した後の収集は自動化可能、期限切れ後の再ログインは有人**である。
- ログイン側の `direct.smbc.co.jp` と取引側の `direct3.smbc.co.jp` がAkamai edgeを使うことは確認できた。Bot Manager系の保護も有力だが、具体的なWAFポリシーと認証後エンドポイントでの判定条件は未確認である。
- 個人口座向け公式APIは存在するが、契約済みの電子決済等代行業者向けであり、個人開発者が自己口座用トークンを直接発行する公開経路は確認できなかった。本プロジェクトではaggregatorを避けるため採用しない。

総合評価は、**普通預金MVPの実装コスト 3/5、複数科目を含む堅牢な実装 4/5、完全無人ログインの見込み 1/5、有人承認後の自動収集 4/5**。

## スコープと非目標

対象は三井住友銀行の本人名義口座を、公式Webまたは公式アプリから読み取る経路に限る。

- 対象: SMBCダイレクト、三井住友銀行アプリ、Oliveアカウントの**銀行口座側**
- 取得候補: 口座一覧、残高、入出金明細、定期・外貨等の預入明細
- 非目標: Vpass、Oliveフレキシブルペイのカード明細、他行・証券連携、振込、振替、設定変更、電子決済等代行業者経由の集約
- 安全境界: 読み取り専用。振込先、振込手数料計算など、収集に不要な転送関連画面にも遷移しない

この調査ではログイン、実口座へのアクセス、APKの取得・実行、認証済みリクエストを行っていない。秘密、口座番号、氏名その他の個人識別子は記録していない。

## 調査方法

1. 三井住友銀行の公式サイト、公式FAQ、Google Playの公式掲載情報を確認した。
2. 2026-08-26に未認証のDNS・HTTPヘッダーを読み取り、公開ログイン入口の配信事業者とCookie名を確認した。
3. GitHub Code Searchで公開クライアントを調べ、`pnsk-lab/mnie` をコミット `c87e65c0a04c03c560962f8ead6e77415fb841f4` でコードレビューした。
4. 古いSelenium/Mechanize実装は、現在動作する根拠ではなく、過去に利用できた経路の参考としてのみ扱った。

## 公式の入口と取得粒度

### SMBCダイレクトWeb

- 入口: [SMBCダイレクト](https://www.smbc.co.jp/kojin/direct/) から [Webログイン](https://direct.smbc.co.jp/aib/aibgsjsw5001.jsp)
- ログインID: 店番号・普通預金口座番号、または契約者番号とログイン暗証
- 口座一覧: サービス利用口座として登録された普通、貯蓄、当座、定期、外貨、投資信託、住宅ローン等を表示する。[公式口座照会ヘルプ](https://www.smbc.co.jp/direct/sousa/help_kouza/4.html)
- 入出金は口座への反映後に残高・明細へ即時反映される。[公式残高・明細ヘルプ](https://www.smbc.co.jp/smartphone/help/help_kouza/10.html)
- Web通帳の入出金明細はCSVでダウンロードできる。**三井住友銀行アプリにはCSVダウンロード機能がない**。[公式FAQ](https://qa.smbc.co.jp/faq/show/720?site_domain=default)

### 三井住友銀行アプリ

- 公式Androidアプリ: [Google Play](https://play.google.com/store/apps/details?id=jp.co.smbc.direct)、パッケージ `jp.co.smbc.direct`
- SMBCダイレクトの一部機能をネイティブUIから利用する公式クライアントであり、口座一覧、残高、入出金明細、SMBCセーフティパス、ワンタイムパスワードをまとめている。[公式機能一覧](https://www.smbc.co.jp/kojin/spaplli/directapp/)
- アプリの残高照会対象は、普通、貯蓄、当座、定期、積立、外貨普通、パーソナル外貨定期、投資信託、財形、カードローン。入出金明細は普通、貯蓄、当座、カードローンが明記されている。
- アプリは人が日常確認するには使いやすいが、端末紐付け、生体認証、root化端末やUSBデバッグへの制限があるため、サーバー自動化の主経路には向かない。

### Oliveとの差

Oliveアカウントは、普通預金または残高別金利型普通預金、SMBCダイレクト、Web通帳、SMBC ID、Oliveフレキシブルペイ等を組み合わせたパッケージである。銀行口座の残高・入出金明細はSMBCダイレクトと三井住友銀行アプリに表示されるため、銀行口座収集についてOlive専用プロトコルを別途実装する理由はない。[公式SMBCダイレクト案内](https://www.smbc.co.jp/kojin/direct/)

SMBCダイレクトではOliveの対象普通預金が「残高別普通」「残高別普通（総合）」等と表示される。[公式口座照会ヘルプ](https://www.smbc.co.jp/direct/sousa/help_kouza/4.html) Kogane側では表示名に依存せず、支店・口座・科目コードから安定した口座IDを作る必要がある。

## 明細の粒度と履歴期間

通常サービス時間と、日曜21時から月曜7時の制限時間では表示範囲が異なる。制限時間中は日曜21時時点の普通、貯蓄、当座、カードローンのみ、前月1日以降の最大2か月・300件となる。[公式利用時間](https://www.smbc.co.jp/kojin/direct/jikan/)

| 科目 | 取得粒度 | 通常時の履歴・上限 | 備考 |
| --- | --- | --- | --- |
| 普通預金・Web通帳 | 現在残高、日付、入金/出金額、摘要、取引後残高 | 2019-01-01以降。最大30年、1照会2,000件 | 期間を短く分割すれば全件収集可能。未指定時は当月・前月のみ |
| 普通預金・紙通帳 | 同上 | 24か月前の1日以降。最大25か月、300件 | それ以前は店頭で有料発行 |
| 貯蓄・当座・カードローン | 残高、入出金明細 | 現行FAQでは前月1日以降 | 古い口座照会ヘルプには総合口座のWeb通帳貯蓄を30年とする記載もあり、実口座で要確認 |
| 外貨普通預金 | 通貨別現在残高、日付、入出金、摘要、取引後残高、条件により適用レート | 3か月前の1日以降から本日まで、最大4か月・300件 | CSVあり。外貨間振替や外国送金では相手・商品情報が省略される場合がある |
| 定期・積立 | 口座残高、預入明細、積立内容 | 公開ヘルプに一律の履歴保存期間は見当たらない | 取引イベント列ではなく預入ロット/満期情報としてモデル化するのが適切 |
| 投資信託 | 残高・取引明細 | 前年同月1日以降 | 本調査の実装対象外だが、口座一覧に現れる可能性がある |

期間の主根拠は2026-01-15公開の[公式FAQ](https://qa.smbc.co.jp/faq/show/1468?site_domain=default)。外貨の粒度と上限は[公式外貨入出金明細ヘルプ](https://www.smbc.co.jp/direct/sousa/help_gaikatorihiki/49.html)、定期は[公式サービス内容一覧](https://www.smbc.co.jp/direct/sousa/help_teiki/2.html)による。

普通預金のCSV/内部JSONで期待できる粒度は家計データとして十分高いが、摘要は銀行表示文字列であり、振込相手や購入商品の完全な構造化情報が必ず含まれるわけではない。rawレスポンスと表示摘要を改変せず保存し、正規化は後段で行う。

## 認証とセッション

### SMBCセーフティパス

- SMBCセーフティパスを登録すると、ログイン時に登録端末の生体認証が必須になる。
- 同じ登録端末のアプリでは、アプリ起動時に生体認証が立ち上がる。
- PCや別端末のWebからはQRコードを登録端末で読み取り、アプリで2回の承認と生体認証を行い、元のブラウザで完了操作を行う。
- 登録端末以外からのログインは**ログインの都度**登録端末が必要になる。[公式ログイン手順](https://www.smbc.co.jp/kojin/direct/securi/safetypass/login/)
- 初期登録・解除では、SMS、本人確認書類読取等が使われる。SMSは通常の定期収集ごとに使う認証ではない。[公式登録手順](https://www.smbc.co.jp/kojin/direct/securi/safetypass/touroku/)
- 機種変更や端末生体情報の変更では解除・再登録が必要になる。[公式機種変更手順](https://www.smbc.co.jp/kojin/direct/securi/safetypass/kishuhenko/)

従来のワンタイムパスワードはSMBCセーフティパスと併用できず、主に振込等の重要取引用である。セーフティパスを解除して資格情報だけの読み取りログインに寄せる案は、セキュリティを落とし、現行仕様で継続利用できる保証もないため推奨しない。

### セッション再利用

`mnie` は認証後のCookieとトップページのフォーム状態をexport/importし、口座一覧への遷移でフォームトークンを更新できる。これは「一度承認したセッション内の複数回収集」が可能である強い根拠になる。一方、次は未確認である。

- 無操作時のサーバー側セッション寿命
- keep-aliveを行った場合の最大寿命
- IP、TLSフィンガープリント、User-Agent、リージョン変更時の再認証条件
- 日跨ぎ、コンテナ再起動後、Cloudflare等の共有egressからの再利用可否

公式サイトは「本来想定された利用形態と異なる極端な利用」でSMBCダイレクトを停止する場合があると明記している。常時keep-aliveは避け、低頻度の同期と自然失効後の有人再承認を前提にする。[公式SMBCダイレクト案内](https://www.smbc.co.jp/kojin/direct/)

## Akamai / anti-bot

### 確認できた事実

2026-08-26の未認証観測では次を確認した。

- `direct.smbc.co.jp` と `direct3.smbc.co.jp` はそれぞれ `*.edgekey.net` を経て `*.akamaiedge.net` に解決された。
- `https://direct.smbc.co.jp/aib/aibgsjsw5001.jsp` は通常のブラウザUser-Agentによる単発GETへHTTP 200を返した。
- 応答に `X-Akamai-Transformed` と `AKAMAI` ヘッダー、および `_abck`、`bm_sz` Cookieが含まれた。
- 公開ログインHTMLはShift_JISで、未認証の単発GETにJavaScriptチャレンジやCAPTCHAは表示されなかった。

したがって、Akamai CDN/edgeの利用は確定である。AkamaiはBot ManagerがCookieとブラウザテレメトリを使って自動リクエストを識別する仕組みを提供している。[Akamai Bot Management docs](https://techdocs.akamai.com/security-ctr/docs/dimensions-new)

### 推測・未確認

- `_abck` と `bm_sz` の組合せから、Akamai Bot Managerまたは同系統の自動化判定が有効である可能性が高い。
- ただし、ログインPOSTや認証後AJAXに対する具体的なWAF/Bot Managerアクション、レート制限、データセンターIPの評価は外部から確定できない。
- `mnie` が通常の`fetch`とCookie jarだけで現行フローを実装しているため、少なくとも採取時点の本人操作を伴う低頻度フローでは、完全なブラウザ指紋生成が必須ではなかったと推定できる。実口座での再検証が必要である。

## APKと静的解析

公式の公開入手経路はGoogle Playであり、銀行サイトから直接配布される単体APKは確認できなかった。第三者ミラーには `jp.co.smbc.direct` のAPK情報があるが、取得する場合はPlay配布物との署名照合が必要で、ミラーを信頼して実行してはならない。

公式掲載は、root化履歴のある端末で正常動作しない場合があること、USBデバッグが有効だと起動しないことを明記している。よって動的解析は実機/エミュレータ検知、証明書ピンニング、難読化の影響を受ける可能性がある。

静的解析は次の限定目的なら有用である。

1. manifestのdeep link、exported component、ネットワーク設定の確認
2. `smbcdirectapp:///biometrics/ADBA` と関連パラメータの検証
3. 公式アプリが呼ぶホスト、REST/GraphQL等の文字列、証明書ピンニング設定の棚卸し
4. WebViewとネイティブAPIの境界確認

普通預金MVPはWebクライアントで成立する見込みが高く、APKの詳細解析は後回しにする。APK経路は、Webで外貨・定期等の内部エンドポイントが特定できない場合に再評価する。

## 3rd party client

### `pnsk-lab/mnie` の実装評価

確認対象: [`provider-smbc-direct/src/index.ts` at `c87e65c`](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-smbc-direct/src/index.ts)

実装方式:

1. 公開ログインページをGETし、フォームのフレームID、トークン等を抽出する。
2. 店番号、口座番号、ログイン暗証をSMBC DirectのフォームへPOSTし、Shift_JISの応答をデコードする。
3. 応答中の`userId`、`confirmationNumber`、`createdTime`から `smbcdirectapp:///biometrics/ADBA` deep link/QRを組み立てる。
4. 利用者が公式アプリで承認後、完了POSTを行い、`JSESSIONID`の変化を確認する。
5. トップページの`_TOKEN`、`_FORMID`とCookie jarを維持し、公式Webの内部AJAXを呼ぶ。

現在取得できるもの:

- ログインに使った普通預金1口座
- JPY現在残高
- 任意の開始日/終了日の入出金明細
- 明細ID、日付、入出金額、取引後残高、摘要、入出金種別
- 期間内の入金合計・出金合計
- 認証済みセッションのexport/importと口座一覧遷移による更新

制約とKoganeで直す点:

- 普通預金1口座と、HARで観測した既定科目コード `2206` に固定され、複数口座、定期、外貨は未対応。
- `getAccounts()` は実際の口座一覧を解析せず、ログイン資格情報から1口座を合成している。
- セッションexportに**ログイン暗証、Cookie、認証済みトップHTML**を含めている。Koganeでは暗証をセッションから除外し、Cookie/フォーム状態を暗号化保存、ログ・raw evidenceから認証情報とHTML hidden fieldを除外する必要がある。
- transfer recipient参照と手数料計算も実装されているが、本収集器では不要。転送関連capabilityとルートをビルドまたは許可リストから外す。
- 専用のproviderテストは見当たらず、サイト変更検出と固定fixtureによるparserテストを追加する必要がある。
- ブラウザ風User-Agentを固定しているため、長期運用ではAkamai判定とサイト更新の監視が必要。

### その他の公開実装

| 実装 | 最終関連更新 | 方式 | 評価 |
| --- | --- | --- | --- |
| [`yokwe/yokwe-root`](https://github.com/yokwe/yokwe-root/blob/70f8602122b5618480cd52d5b8c16ed0777b8860/yokwe-finance/src/main/java/yokwe/finance/account/smbc/UpdateAssetSMBC.java) | 2025-05-14 | Selenium/Safari、追加認証時に60秒待機、公式CSV保存 | 現行UIに近い参考。認証完了のポーリングが粗く、サーバー運用には重い |
| [`t-bucchi/accagg`](https://github.com/t-bucchi/accagg/blob/d28e0ec153b478ea1edf384c9b108a0c91faf027/accagg/bank/smbc.py) | 2019-09-23 | Selenium/Firefox、普通預金CSV | SMBCセーフティパス以前。セレクタとログイン方式は陳腐化 |
| [`shinichy/get_statement`](https://github.com/shinichy/get_statement/blob/6f9730162d72eb9d14fa950767fdbcc8836676c1/get_statement.py) | 2018-12-01 | Selenium/Chrome、前月CSV | 過去の経路確認のみ |
| [`kkosuge/bank_job`](https://github.com/kkosuge/bank_job/blob/0908e082d4c196a0fc8335351855874eb88b1549/lib/bank_job/strategies/bank_job_smbc.rb) | 2014-03-03 | Mechanize、HTML表解析 | 現行方式には使用不可 |

GitHub Code Searchでは、現行の `TPALTOPAjaxSavingBalance` と `LLDLDILnextPreTS` を実装する公開コードは`mnie`以外に見つからなかった。従って、現在再利用価値があるのは実質的に`mnie`で、他はCSV fallbackの設計資料である。

## 公式APIとaggregator回避

三井住友銀行は個人口座向けに、普通口座残高・明細、定期、外貨、債券、ポイント、住宅ローン等を提供するAPI基盤を整備している。ただし接続先は、銀行と契約し接続基準を満たした電子決済等代行業者に限定される。[公式連携方針](https://www.smbc.co.jp/collaboration/)

2026-03-31時点の契約先にはMoneytree、Money Forward、freee、Zaim等が含まれる。[公式契約先一覧](https://www.smbc.co.jp/collaboration/keiyakunaiyou.html) これは技術的には最も安定する経路だが、本プロジェクトの「aggregatorをできるだけ回避し、公式サイト/公式アプリを直接データ源とする」方針と合わない。個人開発者向けの公開セルフサービスAPIは確認できなかったため、現フェーズでは候補から外す。

## 実行環境の適性

| 環境 | 適性 | 理由 |
| --- | --- | --- |
| ユーザーのローカル端末 | 5/5 | QR/deep link承認が簡単で、通常の家庭・モバイル回線に近い。最初の実証に最適 |
| OCI VM / 単一コンテナ | 4/5 | 固定egress、Node/Bun、暗号化ストレージを用意しやすい。承認URL/QRを安全にユーザーへ返す必要がある |
| OCI Kubernetes | 3/5 | CronJobとSecret管理は可能だが、単一個人口座には過剰。Pod再配置でegressやセッション保存が変わらないよう設計が必要 |
| Cloudflare Containers | 4/5 | 現行のNode/Bun互換コードを載せやすい。人の承認待ちとセッション永続化を別の状態ストアで扱う必要がある |
| Cloudflare Workers | 2/5 | pure fetch自体は移植可能だが、現行実装は`Buffer`、`process.env`、`iconv-lite`を使う。Node互換設定、Shift_JIS、Cookie jar、承認待ち状態、暗号化保存、共有egressに対するAkamai判定を検証する必要がある |

初期実装はローカルまたはOCIの専用コンテナを推奨する。収集処理は1プロファイル1実行に直列化し、同じセッションを複数Podから同時使用しない。Akamai対策としてリクエスト頻度を人の通常操作に近い低頻度に保ち、固定egressと一貫したUser-Agentを使う。ブラウザ指紋の偽装を増やす前に、通常のHTTPフローでどこまで安定するかを測る。

## コストと自動化見込み

| 案 | 実装コスト | 自動化レベル | データ範囲 | 判断 |
| --- | ---: | --- | --- | --- |
| `mnie`を安全化して普通預金を取得 | 3/5 | 初回/再ログインは有人、認証後は自動 | 普通預金残高・期間明細 | **採用候補** |
| Webブラウザで公式CSVを取得 | 3/5 | アプリ承認は有人、その後は自動 | Web通帳普通・外貨等、画面が対応する科目 | 検算・fallbackとして有用 |
| Web内部プロトコルを複数口座・外貨・定期へ拡張 | 4/5 | 認証後は自動 | 口座一覧、複数科目、預入ロット | 普通預金MVP後に実施 |
| 公式アプリをUI自動化 | 5/5 | 生体認証で有人、端末保守も必要 | アプリ表示全般 | 非推奨 |
| APKからネイティブAPIを再実装 | 5/5 | 未知 | アプリ固有機能まで拡張可能性 | Webで不足した場合のみ |
| 契約済みaggregator API | Kogane側1/5 | 高い | 広い | 方針により不採用 |

## 推奨方針

1. `mnie`の普通預金フローを参考に、Kogane用の**読み取り専用**SMBCダイレクトクライアントを分離する。
2. ログイン資格情報をSecret Managerから都度読む。セッションartifactにはログイン暗証を含めない。
3. QR/deep linkをユーザーへ表示し、公式三井住友銀行アプリでの承認完了をポーリングする。承認が必要なら収集を失敗扱いにせず`interaction_required`にする。
4. 口座一覧、普通預金残高、期間指定明細だけを許可リスト化する。振込・振替・振込先・手数料画面は実装しない。
5. 公式CSVを同期間で取得し、件数、入出金合計、末尾残高を照合する。rawの公式JSON/CSVと取得時刻、対象期間を証拠として保存する。
6. サーバー側セッションを低頻度で再利用するが、常時keep-aliveはしない。失効時は再承認する。
7. 普通預金が安定してから、トップページの口座一覧解析、複数口座、外貨、定期預入明細を別PRで追加する。

## 次の検証手順

実装PRでは次を、読み取り専用かつ実口座情報をコミット・ログへ残さず検証する。

1. ユーザー操作でSMBCダイレクトWebへログインし、SMBCセーフティパスのQR承認手順と承認待ち時間を確認する。
2. Web通帳のCSVを1か月分だけ手動取得し、列、文字コード、明細ID相当の有無、摘要、残高粒度を確認する。
3. forkした`mnie`で、普通預金残高と同じ1か月の明細だけを取得する。振込関連メソッドはコードから無効化してから実行する。
4. JSONと公式CSVの件数、入金合計、出金合計、期末残高を照合する。
5. keep-aliveなしで、15分、1時間、翌日の順にexport/importの有効性を測る。失効を検知したら再ログイン要求へ落とす。
6. 同一セッションをローカルとOCIのそれぞれで新規作成し、AkamaiによるHTTP 403/429、チャレンジ、Cookie追加、IP変更時の失効を記録する。セッションを環境間で移動して検証しない。
7. 口座一覧に普通預金以外がある場合は、科目名とmasked identifierだけを記録し、次の専用PRで外貨・定期のread endpointを調査する。
8. Web経路で不足が判明した場合だけ、署名確認済みのPlay配布APKを静的解析し、manifestとホスト一覧までを別PRに記録する。

## 未確認事項

- 実契約がSMBCセーフティパスかワンタイムパスワードのどちらを使用しているか
- 現行セッションの無操作・最大寿命と、安全な同期頻度
- Akamaiが認証後のNode/Bun、Cloudflare、OCI egressをどう判定するか
- `mnie`の現行コードが実口座で再現するか、および既定科目コード `2206` が対象口座と一致するか
- 実際の複数サービス利用口座一覧を返す内部endpointと、安定した口座識別子
- 定期・積立の預入ロット項目と履歴保存期間
- 外貨CSV/内部JSONの通貨、小数桁、適用レート、取引後残高の正確なschema
- Web通帳の貯蓄預金について、現行FAQと旧ヘルプで異なる履歴期間の実挙動
- 公式Play配布物の分割APK構成、難読化、証明書ピンニング、アプリ用anti-bot SDK

# SBI証券: 公式データソース一次評価

- 調査日: 2026-08-26
- 対象: SBI証券の証券総合口座だけ
- 非対象: SBI新生銀行、住信SBIネット銀行、SBI VCトレード、家計簿・資産管理aggregator、注文の発注・訂正・取消
- 目的: 細かなAPI実装ではなく、実装コストと自動化可能性の一次評価

## 結論

SBI証券は **実装コスト4/5、条件付きで定期自動化可能（初期評価B、検証後Aを狙える）** と評価する。

推奨経路は、公式Webの `My資産` をデータ源とし、公式のパスキー認証でログインしたセッションから、資産管理画面が呼ぶ読取専用JSONを取得する方式である。最初の検証ではブラウザを使って正しい画面・通信・値を突合し、取得経路が固まったらHTTPクライアントへ縮退する。公式アプリの非公開通信は、Web経路だけで不足する買付余力・国内株式の詳細・米国株式詳細を補完する第2段階とする。

既存実装により、保存したパスキーを用いた無人ログインと、Web／アプリ内部通信の直接呼出しは技術的に実現済みである。一方で、2026年6月に認証方式が変更され、ログイン入口にはEverspin系の防御があり、HeadlessChromeを示すアクセスが保守ページへ送られるとの第三者実装上の観測もある。安定運用には、日本国内の固定的な実行元、ブラウザ同等の通信、セッション失効検知、公式画面との継続的な値照合が必要になる。

Koganeでは、取引機能を絶対に有効化しない。`pnsk-lab/mnie` のSBI providerは有用な仕様資料だが、注文発注・訂正・取消まで公開するため、そのまま依存・登録してはならない。読取部分だけを別パッケージへ抽出し、取引パスワードを設定・保管せず、注文系コードと宛先をビルドに含めない方針とする。

## 評価尺度

自動化レベルは次のように定義する。

- A: 初回登録後は原則無人で定期実行できる
- B: 定期実行できるが、認証変更・リスク判定・セッション失効時に手動復旧があり得る
- C: 毎回または頻繁に利用者操作が必要
- D: 現時点では実用的でない

SBI証券は現時点でB。国内固定IP、保存パスキーの安全な運用、複数日の連続試験に合格すればA相当まで上げられる可能性がある。

## 公式の入口と取得できる情報

一般個人向けの残高・保有・履歴をOAuth等で取得する公式公開APIは、今回確認したSBI証券の公式資料には見つからなかった。公式の「先物・オプションAPI」は存在するが、事前に外部ツール利用設定とAPIキー発行が必要な取引接続であり、証券総合口座の読取collectorには使わない。従って本評価でいうAPIは、公式Web／公式アプリ自身が使う非公開通信であり、公開仕様や互換性保証はない。

### 1. メインサイト（PC／スマートフォン）とMy資産

ログイン入口は `https://login.sbisec.co.jp/login/entry`、ログイン後のメインサイトは `ETGate` 系である。2025年10月以降、公開トップページのID／パスワード入力欄は廃止され、専用ログインドメインへ遷移する方式になった。

`My資産` はPCサイトとスマートフォンサイトの公式資産管理機能で、次のデータを横断表示する。

| 項目 | 粒度 | 期間・更新 | Koganeでの価値 |
| --- | --- | --- | --- |
| 現在資産 | 資産全体、商品分類、銘柄別 | 国内株は約定後・価格とも原則リアルタイム。投信・債券等は商品ごとの更新時刻 | 日次スナップショットの主経路 |
| 取得額・評価額・評価損益 | 全体、商品別、銘柄別 | 現在値と公式計算結果 | 取得価額の再現誤差を避けられる |
| 資産推移 | 全体・商品別。評価額、取得額、評価損益、損益率 | 2021-08以降。原則毎週土曜7:00基準 | 過去スナップショットの初期取込に有用。ただし日次ではない |
| 実現損益 | 銘柄別・商品別・預り区分別。約定日／受渡日指定 | 2021-08以降。任意期間指定可 | 売却後の損益を取引履歴から再計算せず取得可能 |
| 配当・分配金・利金 | 銘柄別・商品別・口座区分別、各回の単価等 | 2021-08-01以降 | キャッシュフローの詳細取得に有用 |
| 預り金 | 円・米ドル | 原則リアルタイム | 現金残高 |
| スィープ専用銀行口座 | 合計残高 | 原則リアルタイム | 買付原資。ただし銀行側の取引履歴とは別物 |

公式の対象商品は、国内株式（現物・信用）、米国株式（現物）、国内投資信託、外貨建MMF、円貨／米ドル建債券、SBIラップ、iDeCo、円／米ドル預り金、スィープ専用銀行口座。外貨建資産は公式資料上、米ドル建が中心である。

公開クライアントのコードでは、メインサイトの資産評価JSONから次を読めることが確認できる。

- 合計評価額、前日差・率、前月差・率、評価損益・率、取得額
- 預り金を含む／除く、iDeCoを含む／除く集計
- 商品カテゴリ別の同項目と構成比

同じコードには、円貨入出金明細の内部JSONから、日付、入出金区分、明細区分、摘要、金額、安定IDを取得する処理もある。ただし、現行実装が初期レスポンスだけで公式上の2年分すべてをページングできるかは未確認である。

### 2. 口座管理・取引履歴・電子交付

公式Webでは次の履歴を取得できる。

| 履歴 | 公式の保持・表示 | 粒度 |
| --- | --- | --- |
| 約定履歴 | 過去2年 | 取引明細。CSVダウンロード可 |
| 円貨入出金明細 | 過去2年 | 日付、区分、摘要、金額等 |
| 譲渡益税明細 | 過去2年 | 特定預りの個別明細、税額合計、損益合計。最大200件／ページ |
| 電子交付された取引報告書・取引残高報告書 | 原則過去5年 | PDF等の公式書面 |
| 開示請求 | 最大過去10年 | 自動収集ではなく請求手続き |
| 債券の注文履歴 | 過去2年 | 注文履歴 |
| 債券の取引・償還・利払概要 | 過去5年 | 概要。詳細は書面 |
| 外国株式 | 外貨建取引サイトの約定履歴・口座サマリー | 保有残高、約定、為替注文履歴。保持期間は今回未確定 |

初期バックフィルは、My資産（2021-08以降の週次資産・実現損益・配当等）と、2年CSV、5年電子交付書面を組み合わせるのがよい。CSVや書面は公式サイトから直接取得するためaggregatorには該当しない。

### 3. 買付余力・保有商品

公式Webと株アプリ系通信では、少なくとも次を取得できる。

- 現金買付余力、信用買付余力、出金可能額
- 代用有価証券評価、委託保証金率、SBIハイブリッド預金相当残高
- 国内現物: 銘柄、市場、預り区分、数量、売却可能数量、未約定数量、取得／平均単価、現在値、時価評価額、評価損益・率
- 国内信用: 建玉ID、売買区分、数量、決済可能数量、建単価、現在値、時価評価額、評価損益・率、建日、期日、諸費用
- 米国株式: 銘柄／ティッカー、数量、現地通貨と円換算の取得額・評価額・損益

公式表示の「取得単価」は、国内株では手数料を含む移動平均価格であり、一般預りの「参考単価」や特定口座の税務上の取得価額と常に同一ではない。Koganeは値の意味と出典画面を保存し、`取得単価`、`参考単価`、`平均取得価額`、`税務上取得価額`を同一フィールドへ潰さない。

## チャネル別のトレードオフ

| 経路 | 長所 | 短所 | コスト | 自動化見込み |
| --- | --- | --- | ---: | --- |
| PC／スマホのMy資産JSON | 公式横断集計、履歴が豊富、ブラウザから値を突合しやすい。公開実装でJSON取得例あり | ログインSSOと内部endpointは非公開。画面・認証変更の影響を受ける | 4/5 | B→A候補 |
| PCサイトのCSV／電子交付 | 公式エクスポート、過去データ、監査証跡として強い | CSV/PDFごとに取得・解析が必要。日次現在値には不向き | 3/5 | B |
| PC／スマホのブラウザスクレイピング | 既存Go実装が稼働例を持ち、初回検証が早い | Headless判定、DOM変更、Chromiumサイズ、待機時間 | 3/5 | B |
| SBI証券Plusアプリ | 資産・実現損益・配当等が読み取り中心でまとまる。PCのMy資産と近い機能 | API仕様未公開。APK／通信解析が必要。認証・アプリ更新追随が必要 | 4/5 | B（未検証） |
| SBI証券 株アプリ内部通信 | 買付余力、国内保有、板・価格等の粒度が高い。直接HTTP実装例あり | 固定長Shift-JIS独自プロトコル。注文機能と同じAPI面にあり隔離必須 | 4/5 | B→A候補 |
| 外国株式アプリ系REST／GraphQL | 米国株の保有・注文・約定の粒度が高い | 別SSO、別session、hash値等が必要。国内と実装が分かれる | 4/5 | B |

PCサイトとスマートフォンサイトのMy資産は公式上同じ対象・集計期間を持つ。画面幅の差より、内部JSONを取得できるかが重要である。SBI証券PlusはMy資産と近い横断情報を提供するため、APKを調べるなら取引中心の株アプリより先に見る価値がある。ただし、買付余力・国内株の詳細は株アプリ系通信の方が既存実装の裏付けが強い。

## 認証、端末、セッション

### 2026年8月時点の公式仕様

- パスキー認証は2026-06-30から原則必須。ただしユーザーネーム／ログインパスワードでのログインも残る。
- パスキーなら、パスワード入力とログイン時の追加認証なしでログインできる。
- PC／スマホのメインサイト、スマートフォン専用サイト、SBI証券Plusでパスワードログインした場合、リスク検知時にメール認証コードが必要。
- 従来のメールURL型「デバイス認証」は2026-06-13で終了。
- 株アプリ等のパスワードログインは、FIDOまたは電話番号認証が必要。
- 取引時には別のリスク判定があり、電話認証を求められる可能性がある。Koganeは取引を行わないため、この経路を起動しない。
- アプリの旧「自動ログイン」は継続可能だが、電話番号認証またはFIDOの追加認証が必要。定期収集には、パスキーによる新規セッション作成の方が構造が明確である。

### 公開実装から確認したセッション方式

`pnsk-lab/mnie` は、保存済みWebAuthn credentialから署名を生成し、FIDO challenge／assertion、アプリチャネルのSSO token取得、株アプリ系session確立までをブラウザなしで実装する。session export/importもあるが、メインサイトSSOの認証キャッシュは20分としている。長期間同じcookieを再利用する設計ではなく、必要時にパスキーから再認証できることを前提にするのが安全である。

`azuki774/myscrapers` は、保存済みpasskey private keyをChromiumの仮想WebAuthn authenticatorへ復元し、Playwrightで公式ログイン画面を通す。利用者操作なしでログインする実例ではあるが、passkey秘密鍵をサーバーへ持ち出す設計になるため、Koganeでは通常のパスワード以上に強い秘密として扱う必要がある。

サーバー用のpasskeyを新規登録するか、既存passkeyをエクスポートするかは未決定。口座設定を変更する操作なので、実装検証時に利用者が明示的に選択・実行する。credential ID、private key、user handle、session ID、cookie、口座番号、金融データをrepo、ログ、PRへ記録しない。

## WAF・anti-bot・配信基盤

### 確認できた事実

- `www.sbisec.co.jp` の公開レスポンスはCloudFront経由で、AWS ALB cookieと`JSESSIONID`を返した。
- `login.sbisec.co.jp` はDNS上 `*.sbi-everspin.com` へCNAMEされ、観測時のレスポンスは`server: evfw`、CloudFront／API Gateway経由だった。
- 公開静的画像は `sbisec.akamaized.net` から配信される。これはAkamai CDN利用の証拠だが、認証面がAkamai WAFで保護されている証拠ではない。
- SBI証券の公式資料は、株アプリ等にEVERSPIN技術を導入し、ログインごとに異なるtokenを割り当てて認証と通信環境を確認すると説明している。
- 認証なしの通常curlで公開トップは取得でき、CAPTCHA／reCAPTCHA／Turnstileの記述は見つからなかった。
- 調査時、ログインURLへの単純なHTTPアクセスは保守ページへ302された。ただし、実際の保守時間、UA判定、リクエスト不足のどれが原因かはこの観測だけでは確定できない。

### 第三者実装からの観測・推測

- `myscrapers` は、`HeadlessChrome` UAだとログインAPIが保守ページへ302するため通常Chrome UAを使う、とコードコメントで記録している。これは再現試験が必要な第三者観測である。
- CAPTCHA中心の防御より、Everspin token、ブラウザ／端末情報、リスクベース認証、実行元IP、チャネル別sessionの組合せが自動化コストの中心と推測する。
- 公式FAQは海外から一部サービスを停止する場合があるとしている。海外・可変egressより、日本国内の固定IPを優先する。

従って「Akamaiでログインが保護されている」とは結論しない。現時点の記録は、**静的assetはAkamai、公開／ログイン経路はCloudFront・AWS・Everspin、anti-botの詳細は未確認**である。

## APKと静的解析

Android版は公式Google Playから配信される。生の単一APKをSBI証券が公開していることは確認できず、公式入手経路はGoogle Playである。解析用ファイルは、利用者の端末へ正規インストールしたものから取得するか、Google Playの配信物を利用規約に沿って取得する。非公式APKミラーは信頼しない。

| 公式アプリ | package ID | 優先度 | 静的解析の狙い |
| --- | --- | ---: | --- |
| SBI証券Plus | `jp.co.sbisec.sbiapp` | 1 | My資産相当のendpoint、履歴・ページング、response schema、認証チャネル |
| SBI証券 株アプリ | `jp.co.sbisec.hyperkabu2` | 2 | MTS base URL、TR code、端末登録、買付余力・保有照会 |

APK解析は有用である。特に、`mnie` が環境変数として外出ししているauth／MTS／外国株式endpointの現行値、SBI証券Plusの履歴API、アプリ版のschemaを確認できる可能性が高い。一方、公式資料はEVERSPINによるソース暗号化、URL暗号化、改ざん検知を説明しており、静的解析だけでは完結しない可能性がある。詳細解析は後回しにし、まず文字列・manifest・network security config・ホスト名・read-only methodの存在だけを確認する。

TLS pinning、root／emulator検知、PlusアプリへのEVERSPIN適用範囲は未確認である。

## 3rd party clientのコード調査

### `pnsk-lab/mnie` (`c87e65c0a04c03c560962f8ead6e77415fb841f4`)

2026-08-05時点のTypeScript実装。aggregator経由ではなく、SBI証券の公式Web／公式アプリ内部通信へ直接接続する。

主な実装:

- WebAuthn challengeを取得し、保存credentialでassertionを生成
- アプリチャネル別SSO tokenを取得し、`/mtsmobile/ssologingate` でsession化
- `/mtsmobile/commgate` の固定長Shift-JISプロトコルで国内株の買付余力・保有・価格・注文等を取得
- メインサイトへSSOし、`/account/api/assets/valuations/current` のJSONを取得
- `member.c.sbisec.co.jp` の円貨入出金明細JSONを取得
- 外国株式系はREST／GraphQL、`Set-Session`、`Account-Id`等を利用
- browser cookie jar、session export/import、メインサイト認証の20分cache

問題点:

- provider capabilityに `investments:trade` を含み、現物・信用・IFD・テーマ投資・為替の発注、訂正、取消を実装している。
- 取引パスワード、device ID登録、取引時電話認証callbackを受け取れる。
- readとwriteが同じprovider・同じsession面に同居している。
- endpoint hostの一部は環境変数前提で、repoだけでは再現できない。

採用方針:

- コードをそのままKoganeへ登録しない。
- 読取メソッドとparsersだけを別moduleに移植またはforkする。
- 公開capabilityは `accounts:read`、`balances:read`、`transactions:read`、`investments:read`だけに固定する。
- `tradePassword`、取引認証callback、device registration、order payload builders、発注endpointを依存グラフと配布物から除外する。
- runtimeのegress allowlistとmethod allowlistで、既知のread-only宛先・操作だけを許可する。

### `azuki774/myscrapers` (`e58339122eef9273fb2566f0a867057d3219b2f6`)

2026-08-23時点のGo／Playwright実装。aggregatorを使わず、SBI証券の公式ログイン画面と5つの固定ページを読む。

主な実装:

- CDP `WebAuthn.addVirtualAuthenticator` と保存passkeyで非対話ログイン
- 通常Chrome UAを設定したheadless Chromium
- 公式のポートフォリオ、NISA、外国株保有、国内／外国口座サマリーを固定URLで巡回
- body textをparseして、現金、NISA／旧NISA、投信、国内／米国株、米ドル預り金をJSON化
- quantity、unit cost、unit price、評価額、評価損益、前日／前月差等を出力

制約:

- DOM／表示テキストparseであり、HTML変更に弱い。
- 実現損益、配当、取引履歴、入出金履歴を網羅しない。
- ChromiumとPlaywrightを必要とし、Workers isolateには載らない。
- passkey private keyを平文JSONとして読む設計で、秘密管理の改善が必要。
- repo内の旧Python Selenium版はパスワードログイン前提で実行経路も無効化されており、現行仕様の根拠にはしない。

この実装は「最短の疎通確認」と「公式画面との値照合」に向く。最終collectorは、画面から確認したread-only JSONへ縮退する方が保守費用を下げられる。

### その他

2017～2018年頃の`requests`／SeleniumによるSBI証券clientや注文botも公開されているが、旧ログインフォームと取引パスワードを前提にする。現行認証の実装資料としては古く、注文機能を持つためKoganeでは再利用しない。

## 読み取りと取引の厳格な分離

KoganeのSBI証券collectorは、次の条件をすべて満たすまで実装完了としない。

1. 取引パスワードを入力、保存、環境変数化、ログ出力しない。
2. 注文のpreview、place、replace、cancel、外貨交換を公開API・CLI・MCPに登録しない。
3. 注文系source fileをcollector image／bundleへ含めない。
4. runtime egressを公式の読取用hostとpathへallowlistする。`POST`が必要な読取protocolではpathとTR codeもallowlistする。
5. 取得対象routeのfixture／schema testで、注文系routeがゼロであることを検査する。
6. 実口座試験では、ログイン履歴と公式画面の値だけを確認し、取引画面へ遷移しない。
7. raw responseは暗号化保存し、repo／CI artifact／PRへ載せない。fixtureは構造を保った完全な合成データだけにする。

`POST`というHTTP methodだけで取引判定はできない。パスキーchallengeやMTSの読取照会もPOSTを使うため、host・path・TR code・capabilityの多層allowlistが必要である。

## 実行環境の適性

| 環境 | 適性 | 理由 |
| --- | --- | --- |
| OCI Tokyo等のk8s CronJob／小型VM | 高 | 日本国内固定IP、Chromiumまたは直接HTTP、永続secret／session、時刻制御が容易。最初の本番候補 |
| 一般OCI container | 高 | `mnie`型HTTP clientも`myscrapers`型Playwrightも動かせる。egress allowlistを付けやすい |
| Cloudflare Containers | 中 | Linux imageとoutbound制御が使え、Playwright経路も理論上可能。新しい基盤であり、固定的な日本egress、passkey秘密、起動／永続性を実機確認する必要がある |
| Cloudflare Workers | 低～中 | 純粋な`fetch`実装へ縮退できれば定期実行可能。ただしPlaywright不可。`mnie`の`child_process` fallbackはWorkersで実行できず、Web Crypto向け移植が必要。egress位置・リスク判定も不利 |
| Cloudflare Browser Rendering | 低～中 | CDP endpointはあるが、仮想WebAuthn credentialの利用可否と永続的な秘密管理を未確認。最初の実装先にはしない |

Workersの最新runtimeはNode.js API互換が進んでいるが、`node:child_process`は非機能stubである。`mnie`のOpenSSL subprocessを外し、Web Crypto／対応するNode cryptoだけでassertionとtoken復号を実装する必要がある。ブラウザ方式から始めるならOCI Tokyo、HTTP方式が十分に安定してからWorkers／Containersを比較する。

## 推奨アーキテクチャ

1. **公式Webを主データ源**: My資産の現在評価、週次資産推移、実現損益、配当・分配金を取得。
2. **公式WebのCSV／書面で補完**: 2年の取引・入出金CSV、5年の電子交付書面を初期バックフィルと監査証跡に利用。
3. **株アプリ系read-only通信で補完**: 買付余力、国内保有詳細などWebの横断JSONにない項目だけ取得。
4. **外国株式は別adapter**: REST／GraphQL sessionを国内adapterと混ぜず、米国株保有・約定を別sourceとして保存。
5. **公式値をそのままraw evidence化**: 取得単価、参考単価、評価額、損益の意味を出典とtimestamp付きで保存し、後段の正規化で統合。
6. **aggregatorは不使用**: Money Forward、Moneytree等をログイン・取得・fallbackに使わない。

## 次の検証手順

1. 利用者の通常ブラウザでSBI証券へ公式パスキー認証し、My資産、保有一覧、実現損益、配当・分配金、取引履歴、円貨入出金明細を順に開く。Network logはhost、path、method、status、schemaだけを記録し、token・cookie・口座番号・実データを保存しない。
2. SBI証券Plusを正規にGoogle Playから取得し、manifest、host名、network security config、My資産相当のread endpointだけを静的に確認する。株アプリは第2優先。
3. `myscrapers`方式でローカルの1回限りのread-only疎通試験を行い、公式画面の合計・銘柄数・取得時刻と一致するか確認する。passkey登録・exportは利用者操作で行い、秘密はOS keyringまたは専用secret storeに置く。
4. `mnie`から注文コードを完全に除いた最小prototypeを作り、My資産current JSON、買付余力、現物保有、円貨入出金だけをallowlistする。
5. 同一国内IP・同一UAで、日中／夜間／週末を含む7日以上の定期実行を試す。session寿命、パスキー再認証、メンテナンス判定、429／403／302、メール・電話追加認証の有無を記録する。
6. OCI Tokyoの固定egressでCronJob化し、重複実行禁止、指数backoff、失敗時のみ通知、raw暗号化、redacted schema logを実装する。
7. 安定後にCloudflare Containers、次にpure fetch化したWorkersを比較する。海外／可変egressで認証追加が増えるなら採用しない。
8. 2年CSV、5年電子交付、My資産の2021-08以降履歴を一度だけ取得し、重複と期間の穴を可視化する。

## 未確認事項

- 利用者の現口座で有効な認証設定（パスワード無効、電話番号認証、登録済みpasskey数）
- 現行My資産の全endpoint、ページング、rate limit、session寿命
- 円貨入出金内部APIがUI上の2年分を全件返す条件
- 外国株式の注文／約定／入出金履歴の正確なオンライン保持期間
- SBI証券Plusのendpointと、PC My資産backendとの共有範囲
- Plus／株アプリのTLS pinning、emulator／root検知、EVERSPIN適用範囲
- Cloudflare Containers／Browser Renderingからの日本egressとWebAuthn仮想認証器の実用性
- 保存passkeyをサーバーで利用する運用がSBI証券の最新規約・利用条件に適合するか
- 公式画面のメンテナンス時間帯と、単純HTTPアクセスが保守ページへ送られた直接原因

## 根拠

### SBI証券公式

- [パスキー認証の全チャネル対応とWEBサイトのログイン方式変更](https://www.sbisec.co.jp/ETGate/?OutSide=on&_ActionID=DefaultAID&_ControlID=WPLETmgR001Control&_PageID=WPLETmgR001Mdtl30&burl=search_home&cat1=home&cat2=info&dir=info&file=home_info260430_passkey.html&getFlg=on)
- [パスキー認証は必須になるか](https://faq.sbisec.co.jp/answer/6937e6e3b14749ed0cd6062a/)
- [WEBサイトへのログイン導線変更](https://www.sbisec.co.jp/ETGate/?OutSide=on&_ActionID=DefaultAID&_ControlID=WPLETmgR001Control&_DataStoreID=DSWPLETmgR001Control&_PageID=WPLETmgR001Mdtl20&burl=search_home&cat1=home&cat2=none&dir=info&file=home_info251022_login_modification.html&getFlg=on)
- [不正アクセスを防止するための対策](https://faq.sbisec.co.jp/answer/67e65898faf45f7a65208b67/)
- [取引や入出金の履歴](https://faq.sbisec.co.jp/answer/5eba63cc171ba70012b8feb0/)
- [過去2年を超える取引明細](https://faq.sbisec.co.jp/answer/5eba698b1149dd0011cbefa2/)
- [譲渡益税明細](https://faq.sbisec.co.jp/answer/5ee8737d144d40001145db62)
- [My資産提供開始資料](https://search.sbisec.co.jp/v2/popwin/info/home/irpress/prestory210826_011500.pdf)
- [SBI証券Plusでできること](https://search.sbisec.co.jp/v2/popwin/guide/tool/sbi_app/01_first/feature.html)
- [過去の資産推移](https://search.sbisec.co.jp/v2/popwin/guide/tool/sbi_app/04_assets/balance_02.html)
- [実現損益](https://search.sbisec.co.jp/v2/popwin/guide/tool/sbi_app/04_assets/profits_loss.html)
- [資産情報の更新タイミング](https://search.sbisec.co.jp/v2/popwin/guide/tool/assets/06_update/update_assets.html)
- [取得単価・参考単価](https://faq.sbisec.co.jp/answer/5eafd3ef171ba70012b8fb35/)
- [評価額・評価損益の計算](https://faq.sbisec.co.jp/answer/5f191f5329ee940011749926/)
- [外国株式の取引・残高](https://faq.sbisec.co.jp/answer/5ee9c598144d40001145dcc5/)
- [債券の取引・利払履歴](https://faq.sbisec.co.jp/answer/5ee1df0050df500012207449/)
- [先物・オプションAPI](https://www.sbisec.co.jp/ETGate/?OutSide=on&_ActionID=DefaultAID&_ControlID=WPLETmgR001Control&_PageID=WPLETmgR001Mdtl20&burl=search_op&cat1=op&cat2=none&dir=service&file=op_service_05.html&getFlg=on)
- [海外からの接続](https://faq.sbisec.co.jp/answer/5ecb87e7d31ea500111ec9e1)
- [SBI証券Plus Google Play](https://play.google.com/store/apps/details?id=jp.co.sbisec.sbiapp&hl=ja)
- [SBI証券 株アプリ Google Play](https://play.google.com/store/apps/details?id=jp.co.sbisec.hyperkabu2&hl=ja)
- [EVERSPIN導入の説明](https://www.sbisec.co.jp/ETGate/WPLETmgR001Control?OutSide=on&burl=search_home&cat1=home&cat2=none&dir=info&file=home_info201230_01.html&getFlg=on)

### 公開クライアント（仕様資料として参照）

- [`pnsk-lab/mnie` SBI provider](https://github.com/pnsk-lab/mnie/tree/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-sbi-sec)
- [`mnie` passkey session](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-sbi-sec/src/session/index.ts)
- [`mnie` read/write operations](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-sbi-sec/src/provider.ts)
- [`azuki774/myscrapers` SBI implementation](https://github.com/azuki774/myscrapers/tree/e58339122eef9273fb2566f0a867057d3219b2f6/myscraper/internal/sbi)
- [`myscrapers` Playwright passkey session](https://github.com/azuki774/myscrapers/blob/e58339122eef9273fb2566f0a867057d3219b2f6/myscraper/internal/sbi/session_playwright.go)
- [`myscrapers` fixed-page collector](https://github.com/azuki774/myscrapers/blob/e58339122eef9273fb2566f0a867057d3219b2f6/myscraper/internal/sbi/fetch.go)

### 実行基盤

- [Cloudflare Workers Node.js互換](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Cloudflare Containers outbound制御](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/)
- [Cloudflare Containers概要](https://developers.cloudflare.com/containers/get-started/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

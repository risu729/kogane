# SBI証券: 公式データソース一次評価

- 調査日: 2026-08-26
- 対象: SBI証券の証券総合口座だけ
- 非対象: SBI新生銀行、住信SBIネット銀行、SBI VCトレード、家計簿・資産管理aggregator、注文の発注・訂正・取消
- 目的: 細かなAPI実装ではなく、実装コストと自動化可能性の一次評価

## 結論

SBI証券は **実装コスト3/5、条件付きで定期自動化可能（現状B、連続検証後Aを狙える）** と評価する。現口座の実credentialで、ブラウザなしのWebAuthn challenge、assertion、SSO callback、access token復号、MTS session確立、国内現物保有のread-only取得まで成功した。認証から主要データ取得までの技術的不確実性は解消し、残る主な課題はsession寿命、連続実行、実行元変更、読取専用bundleへの縮小である。

推奨経路は、公式株アプリが使うMTS通信を、パスキー認証から直接ブラウザなしで呼ぶread-only clientである。現物保有を高頻度に取得する主経路とし、公式Webの `My資産` は商品横断の評価額・履歴・実現損益・配当を補完する第2経路にする。Koganeへ取り込む際は `mnie` 全体に依存せず、必要な認証、MTS login、読取TR codeだけを抽出する。

既存実装により、保存したパスキーを用いた無人ログインと、Web／アプリ内部通信の直接呼出しは技術的に実現済みである。2026-08-26の実口座試験では、Bitwarden CLIからSBI証券に必要な最小credentialだけをprocess内へ渡し、`mnie` の既存署名関数とpasskey sessionを接続した。entry 200、challenge 200、assertion 302、callback 200、MTS login 200、現物保有照会 200となり、server totalと解析件数が一致した。件数以外の口座データ、token、SID、credential識別子は記録していない。一方で、2026年6月に認証方式が変更され、ログイン入口にはEverspin系の防御がある。現時点ではブラウザなしのHTTP経路が受理されたが、安定運用にはsession失効検知、公式画面との継続的な値照合が必要になる。

Koganeでは、取引機能を絶対に有効化しない。`pnsk-lab/mnie` のSBI providerは有用な仕様資料だが、注文発注・訂正・取消まで公開するため、そのまま依存・登録してはならない。読取部分だけを別パッケージへ抽出し、取引パスワードを設定・保管せず、注文系コードと宛先をビルドに含めない方針とする。

## 評価尺度

自動化レベルは次のように定義する。

- A: 初回登録後は原則無人で定期実行できる
- B: 定期実行できるが、認証変更・リスク判定・セッション失効時に手動復旧があり得る
- C: 毎回または頻繁に利用者操作が必要
- D: 現時点では実用的でない

SBI証券は現時点でB。現口座でパスキー利用とBitwarden保管が確認できたため、A相当へ到達する見込みは初回評価より上がった。国内固定IP、ローカルissuerによる安全な利用、複数日の連続試験に合格すればA相当まで上げられる可能性がある。

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

### 現口座で確定したこと

- 利用者はSBI証券へのログインにパスキーを利用している。
- そのパスキーは利用者のBitwarden vaultに保存済みである。
- Bitwarden CLIは該当itemのFIDO2 credential metadataと秘密鍵を復号済みJSONとして返す。実値はログ、repo、PRへ出していない。
- 該当passkeyはECDSA P-256でdiscoverable属性を持ち、同一RPの候補は1件だった。RP ID、credential ID、user handle、counterの実値は記録しない。
- `mnie` の既存 `createBitwardenAssertion` が生成したassertionをSBI証券が受理し、SSO callbackと復号可能なaccess tokenを返した。
- 復号したtokenを株アプリのMTS loginへ渡してsession化し、read-only TR code `F2631` で国内現物保有一覧を取得できた。HTTPはいずれも200で、server totalと解析件数が一致した。
- ローカルPoC用に、ログインID、ログインパスワード、RP一致URI、単一passkeyだけをWSLのGit管理外へ保存した。取引パスワードとBitwarden custom fieldsは保存していない。ディレクトリは `0700`、fileは `0600` である。

従って、既存credentialのCLI exportability、ローカル署名、SBI証券とのWebAuthn互換性、MTS session、国内現物保有のread-only取得は確認済みである。未確認なのは、counterの連続利用時判定、assertion再利用拒否、session寿命、IP／UA変更、他のread-only TR codeである。

### 公開実装から確認したセッション方式

`pnsk-lab/mnie` は、保存済みWebAuthn credentialから署名を生成し、FIDO challenge／assertion、アプリチャネルのSSO token取得、株アプリ系session確立までをブラウザなしで実装する。session export/importもあるが、メインサイトSSOの認証キャッシュは20分としている。長期間同じcookieを再利用する設計ではなく、必要時にパスキーから再認証できることを前提にするのが安全である。

同repoの `auth-bitwarden` は、Bitwarden Desktopのローカル `data.json` をmaster passwordで復号し、PBKDF2-SHA256／Argon2idのKDF、item key、FIDO2 credentialを処理する。`createBitwardenPasskeyProvider` は、取得したchallengeに対し、完全一致するRP IDのcredentialを選び、指定originを含む `clientDataJSON` と `authenticatorData` を組み立て、秘密鍵で署名する。SBI providerは汎用 `PasskeyAssertionProvider` を受け取るため、このproviderを直接接続できる構造である。実口座PoCでは `data.json` を直接復号せず、公式Bitwarden CLIが返す復号済みitemを最小化して同じ署名関数へ渡した。

ただし実装上の注意がある。

- 同一RP IDに複数credentialがある場合は明示選択が必要で、曖昧な選択は拒否する。credential IDはローカル設定に閉じ、cloud、repo、通常ログへ送らない。
- `userVerification` optionはauthenticator dataのUV flagを設定するが、OSやBitwarden UIによる生体認証・利用者確認を実行するものではない。実口座ではこのassertionを1回受理したが、サーバー側がUVの実体をどう評価するか、連続利用や認証変更後も通るかは未確認である。
- counterは保存値が正なら既定で1増やして署名するが、更新値をvaultへ書き戻さない。連続ログインで同じ値になる可能性、保存値が0の場合の挙動、SBI証券側の判定を確認する必要がある。実値は記録しない。
- 現行のdefault `data.json` pathはmacOS向けである。WSL PoCはBitwarden CLI 2026.8.0を使うことで、このpathとvault形式への直接依存を回避した。
- 合成credential testに加え、SBI証券の実credentialでpasskey callback、access token復号、MTS session、国内現物保有取得まで確認した。注文、端末登録、取引passwordは呼んでいない。

`createBitwardenAuthManager().credentials()` はusername／passwordに加え、FIDO2秘密鍵をprivate JWKとして含む `portableCredential` を返せる。この汎用export経路はKoganeでは使用禁止とする。使うのは狭いassertion provider、またはそれを内包するSBI証券専用ローカルissuerだけであり、vault全体、master password、derived key、秘密鍵JWKをcloudへ置かない。

`azuki774/myscrapers` は、保存済みpasskey private keyをChromiumの仮想WebAuthn authenticatorへ復元し、Playwrightで公式ログイン画面を通す。利用者操作なしでログインする実例ではあるが、passkey秘密鍵をサーバーへ持ち出す設計になるため、Koganeでは通常のパスワード以上に強い秘密として扱う必要がある。

現時点の第一候補は、Bitwardenに保存済みの既存passkeyを利用者端末内で使う方式である。PoCでは利用者の明示許可によりSBI専用の最小credentialをWSLへ平文保存したが、cloud、container image、repo、CI artifactへは出さない。新しいサーバー用passkeyの登録や既存秘密鍵のcloud exportは前提にしない。credential ID、private key、user handle、session ID、cookie、口座番号、金融データを通常ログ、repo、PRへ記録しない。

### ローカルissuerとsource-scoped envelope

最も安全な構成は、スケジューラが利用者端末上のローカルagentへ収集要求を渡し、agentがBitwardenの復号、WebAuthn署名、SBI証券ログイン、read-only取得までを同じtrust boundary内で完結し、cloudへは暗号化した公式raw evidenceまたは正規化済み結果だけを送る方式である。この場合、vaultとSBI sessionはcloudへ出ない。

認証処理を分離する必要がある場合も、issuerをSBI証券専用にし、次を満たす。

1. 要求を `source=sbi-sec`、`purpose=read-only`、1回限りのnonce、短い有効期限、許可したRP ID／originへ固定する。
2. RP ID／originはSBI証券が返した実challengeと公式ログイン画面からローカルで検証し、推測値を固定しない。
3. assertionはchallengeへの応答としてローカルSBI auth componentだけへ渡し、永続化、cloud relay、通常ログ出力をしない。
4. sessionを渡す場合はcookieそのものではなく、ローカルagent内のopaque handleを参照する短寿命の `source-scoped session envelope` とする。envelopeはsource、read-only purpose、audience、発行／失効時刻、許可host／path／TR codeだけを持ち、取引routeを含めない。
5. cloud schedulerからローカルagentへの常時公開inboundを避け、agentが署名済みの短寿命jobをpullする。rate limit、単一実行、再利用拒否を設ける。
6. audit logには成功／失敗、source、時刻、失敗分類だけを残し、credential ID、user handle、challenge、assertion、cookie、金融データを残さない。

cloud側にassertionやsession cookieを渡す方式はfallbackにも推奨しない。Cloudflare Workers／Containers／OCI k8sはスケジュール、暗号化保管、正規化処理には使えるが、Bitwarden vault／derived keyの置き場所にはしない。

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

2026-08-26、株アプリpackageの配布copyを取得し、mirrorを単独で信用せずJAR署名を検証した。署名者名はSBI SECURITIESで、対象MTS hostのTLS証明書もSBI証券名義だった。JADX 1.5.6で、本番／試験環境tableにMTS originがあり、passkey login classが相対path `/mtsmobile/ssologingate` を結合することを確認した。実originそのものはrepoへ保存しない。

`mnie` に `SBI_MTS_BASE_URL` の実値がないのは未発見だからではない。同repoの `AGENTS.md` は実endpointのoriginをhardcodeせず、pathだけをsourceへ置くruleを明記する。アプリもoriginを環境table、MTS methodを相対pathとして分離しており、originはアプリ更新や環境切替で変わり得る。従って `.env.example` は空欄のままにし、実行時に現行公式配信物または通信から検証した値を注入する設計である。

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

`auth-bitwarden` のコードレベル評価:

- `vault.ts`／`crypto.ts` がBitwarden Desktopのローカルvaultを復号し、FIDO2 credentialをprocess内へ展開する。
- `provider.ts` がRP IDでcredentialを絞り込み、SBI providerが要求したchallengeへローカル署名する。複数候補を暗黙選択しない。
- `fido2.ts` がRP ID hash、UV／UP／BE／BS flags、counter、origin入りclient dataを生成する。
- `auth-manager.ts` は可搬private JWKを返す汎用機能を持つため採用しない。SBI証券専用のprovider／issuerだけを境界にする。
- 実装はassertion生成の技術的可能性を示すが、Bitwarden公式SDKではなく、現行vault形式への追随、master passwordの安全な入力、SBI証券側の受理はKogane側の責任で検証する。

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

実口座試験の再現用overlay、合成test、秘密管理境界は [`poc/sbi-securities/`](../../poc/sbi-securities/) に保存した。これは対象commitの `mnie/scripts/` へ配置して使うPoCであり、Koganeのproduction collectorではない。

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
| 利用者端末上のローカルagent | 高 | Bitwarden vault、derived key、assertion、SBI sessionを端末外へ出さずに署名・取得できる。第一候補 |
| OCI Tokyo等のk8s CronJob／小型VM | 中～高 | 日本国内固定IP、Chromiumまたは直接HTTP、時刻制御が容易。ただしvaultを配置せず、ローカルagentから暗号化済み結果を受けるscheduler／processorに限定する |
| 一般OCI container | 中 | `mnie`型HTTP clientも`myscrapers`型Playwrightも動かせるが、Bitwarden秘密を置かない。ローカルagentからsessionを渡す構成も原則避ける |
| Cloudflare Containers | 低～中 | Linux imageとoutbound制御が使えるが、固定的な日本egressと永続性を実機確認する必要がある。vault／derived key／passkeyを置かない |
| Cloudflare Workers | 低～中 | scheduler、署名済みjob、結果取込には使える。Playwright不可で、`mnie`の`child_process` fallbackも実行できない。Web Crypto移植以前に、認証をローカルへ閉じる |
| Cloudflare Browser Rendering | 低～中 | CDP endpointはあるが、仮想WebAuthn credentialの利用可否と永続的な秘密管理を未確認。最初の実装先にはしない |

Workersの最新runtimeはNode.js API互換が進んでいるが、`node:child_process`は非機能stubである。仮に `mnie` の暗号処理をWeb Cryptoへ移植できても、vaultをcloudへ置く構成は採用しない。まず利用者端末上のローカルagentでブラウザ方式／HTTP方式を検証し、安定後にWorkers／Containersをscheduler・結果処理層として比較する。

## 推奨アーキテクチャ

1. **認証・sessionはローカルに閉じる**: Bitwarden保存済みpasskeyはSBI証券専用ローカルissuerで使い、vault、derived key、assertion、cookieをcloudへ置かない。
2. **公式Webを主データ源**: My資産の現在評価、週次資産推移、実現損益、配当・分配金を取得。
3. **公式WebのCSV／書面で補完**: 2年の取引・入出金CSV、5年の電子交付書面を初期バックフィルと監査証跡に利用。
4. **株アプリ系read-only通信で補完**: 買付余力、国内保有詳細などWebの横断JSONにない項目だけ取得。
5. **外国株式は別adapter**: REST／GraphQL sessionを国内adapterと混ぜず、米国株保有・約定を別sourceとして保存。
6. **公式値をそのままraw evidence化**: 取得単価、参考単価、評価額、損益の意味を出典とtimestamp付きで保存し、後段の正規化で統合。
7. **aggregatorは不使用**: Money Forward、Moneytree等をログイン・取得・fallbackに使わない。

## 次の検証手順

1. 利用者の通常ブラウザでSBI証券へ公式パスキー認証し、My資産、保有一覧、実現損益、配当・分配金、取引履歴、円貨入出金明細を順に開く。Network logはhost、path、method、status、schemaだけを記録し、token・cookie・口座番号・実データを保存しない。
2. **完了**: 利用者端末内だけでBitwarden CLI 2026.8.0からSBI証券itemを取得し、秘密値を表示せず、RP一致・候補一意性・passkey metadataを検証した。
3. **完了**: 公式challengeから返るRP IDとBitwarden credentialを照合し、origin入りassertionを生成した。actual valueやcredential ID／user handleはrepoへ記録していない。
4. **完了**: 既存 `createBitwardenAssertion` とSBI providerを接続した1回限りのHTTP試験で、passkey callback、access token復号、MTS login、国内現物保有 `F2631` をすべてブラウザなしで実行した。server totalと解析件数は一致した。
5. HTTP assertionが受理されない場合のみ、Playwright／CDPのvirtual authenticatorをローカルで試す。resident／discoverable credential、user verification、conditional UI、`allowCredentials`指定、パスキーボタン経路の差を比較し、秘密鍵を平文fixtureへexportしない。
6. ログイン成功後、sessionのidle／absolute寿命、同時session、再起動後の再利用、IP／UA変更、日中／夜間／週末、429／403／302、メール・電話追加認証を7日以上観測する。session cookieや識別子は保存せず、寿命と失敗分類だけを記録する。
7. SBI証券Plusを正規にGoogle Playから取得し、manifest、host名、network security config、My資産相当のread endpointだけを静的に確認する。株アプリは第2優先。
8. `mnie`から注文コード、端末登録、取引passwordと汎用 `credentials()`／`portableCredential` exportを完全に除いた最小prototypeを作り、まずMTS loginと現物保有 `F2631` だけをallowlistする。その後、買付余力、My資産current JSON、円貨入出金を個別に追加する。
9. ローカルagentのpull型job、1回限りnonce、短寿命envelope、egress allowlist、重複実行禁止、指数backoff、失敗時のみ通知、raw暗号化、redacted schema logを実装する。OCI／Cloudflareへは暗号化済み結果だけを送る。
10. 安定後にCloudflare Containers、次にpure fetch化したWorkersをscheduler・結果処理層として比較する。海外／可変egressで認証追加が増えるなら採用しない。
11. 2年CSV、5年電子交付、My資産の2021-08以降履歴を一度だけ取得し、重複と期間の穴を可視化する。

## 未確認事項

- signature counterの連続利用時のサーバー側判定、assertion再利用拒否、認証方式変更後の互換性
- Bitwarden CLI更新時のFIDO2 credential JSON schema互換性
- パスワード無効化の有無、電話番号認証、conditional UIとパスキーボタン経路の差
- 現行sessionのidle／absolute寿命、再利用条件、IP／UA変更時の追加認証
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
- [`mnie` Bitwarden passkey provider](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/auth-bitwarden/src/provider.ts)
- [`mnie` Bitwarden WebAuthn assertion generation](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/auth-bitwarden/src/fido2.ts)
- [`mnie` Bitwarden vault decryption](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/auth-bitwarden/src/vault.ts)
- [`mnie` portable credential export path (Koganeでは不使用)](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/auth-bitwarden/src/auth-manager.ts)
- [`azuki774/myscrapers` SBI implementation](https://github.com/azuki774/myscrapers/tree/e58339122eef9273fb2566f0a867057d3219b2f6/myscraper/internal/sbi)
- [`myscrapers` Playwright passkey session](https://github.com/azuki774/myscrapers/blob/e58339122eef9273fb2566f0a867057d3219b2f6/myscraper/internal/sbi/session_playwright.go)
- [`myscrapers` fixed-page collector](https://github.com/azuki774/myscrapers/blob/e58339122eef9273fb2566f0a867057d3219b2f6/myscraper/internal/sbi/fetch.go)

### 実行基盤

- [Cloudflare Workers Node.js互換](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Cloudflare Containers outbound制御](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/)
- [Cloudflare Containers概要](https://developers.cloudflare.com/containers/get-started/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

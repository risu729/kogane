# 三井住友銀行: SMBCダイレクト / Oliveの銀行口座側

調査日: 2026-08-26、追試: 2026-08-31

## 結論

- **推奨データ源は公式WebのSMBCダイレクト**。普通預金のMVPは、公式Webが内部で使うフォームとJSONエンドポイントを読み取り専用で呼び出す方式が最短である。
- **Oliveは別の銀行APIではない**。銀行口座側はSMBCダイレクトとWeb通帳を含むパッケージであり、Olive専用画面よりもSMBCダイレクトの口座一覧・明細を正本とする。
- `pnsk-lab/mnie` の `provider-smbc-direct` は、普通預金1口座について、アプリ承認付きログイン、残高、期間指定の入出金明細、セッション再利用まで実装している。ブラウザを起動せず通常のHTTPリクエストで動くため、MVPの有力な土台になる。
- 2026-08-31の実口座追試では、WSLの通常`fetch`とCookie jarだけでログイン要求、Safety Pass承認、認証済みトップ、JPY残高取得まで成功した。ブラウザやTLS fingerprint偽装は不要だった。明細要求は日曜21時から月曜7時のサービス時間制限で拒否され、認証/Akamai失敗ではなかった。
- SMBCセーフティパス登録済みの契約では、登録端末での生体認証が**ログインの都度**必要になる。したがって現時点の自動化見込みは、**人がQR/アプリ承認した後の収集は自動化可能、期限切れ後の再ログインは有人**である。
- Safety Passは銀行側の登録受理、契約者番号と登録端末の紐付け、解除・失効状態を含む。Android 12.8.0候補の静的解析では、契約IDをaliasとするEC秘密鍵を`AndroidKeyStore`内で生成し、毎回のサーバーchallengeを`BiometricPrompt.CryptoObject`で生体認証後に署名する実装を確認した。秘密鍵exportはなく、profile/app dataのコピーでは移植できない。
- ログイン側の `direct.smbc.co.jp` と取引側の `direct3.smbc.co.jp` がAkamai edgeを使うことは確認できた。Bot Manager系の保護も有力だが、具体的なWAFポリシーと認証後エンドポイントでの判定条件は未確認である。
- 個人口座向け公式APIは存在するが、契約済みの電子決済等代行業者向けであり、個人開発者が自己口座用トークンを直接発行する公開経路は確認できなかった。本プロジェクトではaggregatorを避けるため採用しない。

総合評価は、**普通預金MVPの実装コスト 3/5、複数科目を含む堅牢な実装 4/5、完全無人ログインの見込み 1/5、有人承認後の自動収集 4/5**。

## スコープと非目標

対象は三井住友銀行の本人名義口座を、公式Webまたは公式アプリから読み取る経路に限る。

- 対象: SMBCダイレクト、三井住友銀行アプリ、Oliveアカウントの**銀行口座側**
- 取得候補: 口座一覧、残高、入出金明細、定期・外貨等の預入明細
- 非目標: Vpass、Oliveフレキシブルペイのカード明細、他行・証券連携、振込、振替、設定変更、電子決済等代行業者経由の集約
- 安全境界: 読み取り専用。振込先、振込手数料計算など、収集に不要な転送関連画面にも遷移しない。公式split APK/公開JSの静的解析、未改変公式アプリを本人が操作する際のruntime metadata観測、独自client再現難度の評価は対象とするが、秘密抽出、credential/署名/attestation偽造、pinning/integrity回避は行わない

2026-08-26の初回調査ではログインやAPK取得を行わなかった。2026-08-31の追試では、本人のSafety Pass承認を伴う読み取りログイン、残高、明細要求まで実行し、第三者再配布APK候補をオフライン静的解析した。資格情報、Cookie、challenge、認証済みHTML、残高、明細、口座番号、氏名その他の個人データは保存・コミットしていない。APKとJADX成果物は非公開アーカイブにだけ保存し、本リポジトリにはsanitize済みの結論だけを残す。

## 調査方法

1. 三井住友銀行の公式サイト、公式FAQ、Google Playの公式掲載情報を確認した。Google Playは package、developer、更新日までを公開面で再確認した。
2. 2026-08-26に未認証のDNS・HTTPヘッダー、公開login HTMLとversion付きJavaScriptを読み取り、Prettierで整形してroute/session/form-token/Caulis/RSA-AES補助資産を確認した。login POSTは行っていない。
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

### Safety Passの登録・失効に関する公式仕様

公式手順と[SMBCダイレクト利用規定](https://www.smbc.co.jp/kojin/direct/pdf/directkitei.pdf?version=260401)から確認できる範囲は次のとおりである。

- 登録は三井住友銀行アプリから申し込み、利用規定への同意、端末上の生体認証、本人確認を経て完了する。本人確認はSMS（目安約2分）、またはマイナンバーカード/運転免許証のIC読取と顔撮影（目安約5分）を選べる。[公式登録手順](https://www.smbc.co.jp/kojin/direct/securi/safetypass/touroku/)
- 銀行が申し込みを受け付け、SMBCダイレクトの契約者番号と、登録操作に用いた端末を紐付ける。生体情報は銀行へ送信されず、銀行サーバーにも保存されない。照合は端末の生体認証機能で行われる。
- 登録端末上のログインでは端末の生体認証を行う。PC/別端末では、ブラウザに表示されたQRまたはアプリへのリンクを登録端末で開き、登録端末に表示された内容を利用者本人が確認・承認し、生体認証を行った後、元のブラウザでログインを完了する。[公式ログイン手順](https://www.smbc.co.jp/kojin/direct/securi/safetypass/login/)
- 機種変更は旧端末で解除して新端末で再登録する。旧端末を利用できない場合は、新端末から公式の本人確認を伴う解除手続きを行う。[公式機種変更手順](https://www.smbc.co.jp/kojin/direct/securi/safetypass/kishuhenko/)
- Face ID/Touch ID等、端末の生体情報を変更した場合も解除・再登録が必要になる。[公式生体情報変更手順](https://www.smbc.co.jp/kojin/direct/securi/safetypass/seitaihenko/)
- 登録端末が使える場合はアプリ内で解除し、強制ログアウトされる。使えない場合は、本人確認書類のIC読取と顔撮影（目安約5分）、書類画像・SMS・顔撮影（目安約5営業日）、またはSMS（目安約5分）による解除経路がある。SMS解除後は振込等の一部機能が約1週間制限される。[公式解除手順](https://www.smbc.co.jp/kojin/direct/securi/safetypass/kaijyo/)

以上から、Safety Passは単なるローカル生体認証画面ではなく、少なくとも**銀行側が受理する登録、契約者番号と登録端末の紐付け、解除・失効状態**を含む認証機構である。なお、解除・再登録は設定変更に当たるため、本調査および読み取り専用の実装検証では実行しない。

### Safety Pass内部機構: 2026-08-31静的解析

#### 確認できた事実

- 利用規定は、生体情報の照合が端末内で行われ、生体情報自体は銀行に送信・保存されないと明記している。
- 銀行側には、申し込みの受理、契約者番号と登録端末の対応、解除・失効を管理する状態がある。
- PC/別端末ログインでは、登録端末に表示された情報を利用者が確認し、銀行所定の手続きと生体認証で承認する。
- `mnie` の公開コードでは、Web側が生成した `userId`、`confirmationNumber`、`createdTime` を `smbcdirectapp:///biometrics/ADBA` deep linkへ渡し、公式アプリ承認後にWebの完了処理を行う。
- 公式掲載は、root化履歴のある端末で正常動作しない場合があること、AndroidでUSBデバッグが有効だと起動しないことを明記している。
- Android 12.8.0候補には`BioPreConfirmationREQ/RES`、`BioLoginREQ`、`BCATA01/02/03`があり、QR承認と生体ログインの現行フローを構成する。
- `NewBioLoginApprovalFragment`はサーバーchallengeを受け取り、`BiometricUseCase.doSignature`を呼び、署名済みデータを結果APIへ渡す。
- `BiometricUseCase`は契約IDをaliasとしてEC署名鍵を`AndroidKeyStore`に生成し、公開鍵だけをexportする。秘密鍵export処理はない。
- 鍵はuser authentication必須で、Android 11以降の復元された呼び出しは`setUserAuthenticationParameters(0, BIOMETRIC_STRONG)`に対応する。署名用`Signature`は`BiometricPrompt.CryptoObject`へ渡され、生体認証成功後にchallengeへ署名する。
- 生体登録変更や鍵失効時の削除・再登録経路もある。したがってapp data、ブラウザprofile、公開鍵だけを別端末/サーバーへコピーしても承認は再現できない。
- アプリには別系統のTransmit Security pre/post loginとattestation payload、root検知も含まれる。エミュレータ案は生体UIだけでなくdevice-integrity層も扱う必要があり、Workers/Containersへ移す近道にはならない。

未確認なのは、鍵がTEE/StrongBoxでhardware-backedか、署名対象のcanonicalizationとalgorithm、server側の公開鍵登録payload、challengeの厳密な有効期限/一回性、Transmit attestationの適用条件である。これらは独自clientの完全無人化可否ではなく、拘束点の詳細を詰めるための事項である。

### Future work: 正規承認の支援と再現調査の境界

推奨する将来実装はSafety Passそのもののclone/bypassではなく、**未改変の公式アプリと利用者本人の承認を使った正規のsession issuanceを支援するorchestrator**である。

1. 公式Webへ通常のログイン要求を開始する。
2. 銀行が発行したQR/deep link、期限、対象ログインを利用者へそのまま表示する。
3. 利用者が登録端末の公式アプリで表示内容を確認し、生体認証して承認する。
4. 銀行指定の間隔で完了状態をpollし、承認後に正規発行されたWeb sessionだけを受領する。
5. sessionを暗号化保存し、許可リスト化した残高・明細のread endpointだけに使う。期限切れ時は再度有人承認を要求する。

この案は、生体認証の自動入力、登録端末credentialの抽出、challengeの偽造/再送、端末attestationの回避、Safety Passの登録・解除を行わない。これらの**実装**は禁止するが、公式APKと正常系runtimeから、使われるstandard API、署名対象、端末拘束、session handoff、独自client再現難度を調べることは禁止しない。

将来調査では次を事実・推測・不足に分ける。

| 論点 | 現在の事実 | 次に確認するもの | 難度への意味 |
| --- | --- | --- | --- |
| 生体認証 | 生体情報照合は端末内 | `BiometricPrompt`/CryptoObject等のcall-site | 標準APIだけならUI再現は比較的容易だが、鍵利用条件が別途残る |
| credential/鍵 | 銀行は契約者番号と登録端末を対応付ける | Keystore alias、key generation/import可否、hardware-backed/StrongBox、server登録payload | non-exportable keyや既存server登録必須なら別client移植は難しい |
| challenge/署名 | deep linkに `userId`, `confirmationNumber`, `createdTime` | nonce、canonicalization、署名algorithm、expiry、one-shot/replay処理 | 公開challengeでも登録鍵署名が必須ならtransport模倣だけでは足りない |
| app-to-Web handoff | 公式app承認後にWeb完了処理/JSESSIONID変化 | poll endpoint、承認状態schema、session rotation/cookie scope | 本人承認orchestratorは成立し得るが、完全無人化とは別 |
| integrity/attestation | root履歴/USB debugging制限を公式掲載 | Play Integrity/SafetyNet/独自SDK、requestへのattestation添付箇所 | server必須attestationなら独自client難度が高い |
| pinning | 未確認 | manifest network config、OkHttp/Cronet/WebView/native trust code | pinningがあっても存在確認は可能。解除はせずmetadata観測へ後退 |

#### 段階的な検証計画

| 段階 | 内容 | 予想コスト | リスク | 成功判定 | 中止・後退条件 |
| --- | --- | ---: | --- | --- | --- |
| 0. 文書・公開コードの状態機械化 | 公式手順、利用規定、`mnie`から登録済み/未登録、challenge発行、承認待ち、session発行、失効を図式化 | 1/5 | 低 | Webとアプリの責務、未確認事項、読み取り専用境界を説明できる | なし。個人情報を使わない |
| 1. 署名確認済みAPKの静的解析 | manifest、deep link、exported component、host、network security config、難読化/native library、Keystore API、Play Integrity/App Attest系SDKの参照を棚卸し | 2–3/5 | 低～中 | componentと保護機構の「候補」を特定し、事実/推測を更新できる | Play配布物との署名・来歴を確認できない場合。秘密鍵やtoken抽出が必要になった場合 |
| 2. 正常な実機でのblack-box観測 | 本人が未改変公式アプリを操作し、本人名義口座のログインだけを行う。deep link遷移、表示、時刻、期限、retry、session発行前後を記録 | 3/5 | 中 | challengeの寿命、承認待ち状態、session切替を、設定変更や取引なしで再現できる | 登録/解除、生体設定変更、振込・設定画面への遷移が必要になった場合 |
| 3. Kuebiko/受動proxy観測 | DNS/TLSの接続先、要求時刻等を観測し、アプリが通常のユーザーCAを受け入れる場合に限ってHTTP sequenceを確認 | 3–4/5 | 中 | login challengeからsession issuanceまでの要求順序を把握できる | pinning/integrity/anti-debugに阻止された時点。pinning解除、hook、root、Frida、trust manager改変、attestation回避へ進まない |
| 4. 正規承認orchestrator | QR/deep link表示、利用者通知、期限付きpoll、承認後sessionの暗号化保存、read endpoint実行 | 3/5 | 低～中 | 未改変公式アプリで本人承認した場合だけsessionを取得し、残高・明細だけ読める | 無人化にcredential抽出、challenge replay/forge、保護機構回避が必要と判明した場合 |
| 独自client再現難度評価 | 登録credential、署名challenge、attestation、session handoffの標準性/端末拘束を実物から評価 | 4–5/5 | 中～高 | 標準機構、server-bound state、移植不能要素を根拠付きで分類できる | 秘密抽出、偽造、pinning/integrity/attestation回避が必要になった時点で実装せず観測結果を記録 |

APK静的解析で分かるのは、宣言されたcomponent、文字列/host、SDK参照、network security設定、Keystore API使用箇所等であり、hardware-backed秘密鍵、実際の銀行側登録状態、サーバーのrisk ruleは分からない。難読化されていれば、参照の存在だけで採用方式を確定してはならない。

実機観測とKuebiko/受動proxyでは、アプリlifecycle、deep link routing、接続先、要求順序、承認前後のsession変化を調べられる。ただし、通常の端末・未改変アプリ・本人操作・読み取りログインの範囲に限る。証明書ピンニングで内容を見られない場合は、それ自体を確認結果として記録して中止する。利用規定が禁じる端末の偽造・改変、第三者による承認、表示内容を確認しない承認に当たる方法は採用しない。

運用実装の成功判定は、**公式アプリの有人承認を維持したまま、正規発行sessionを安定して受け取り、読み取り処理へ安全に引き渡せること**とする。研究の成功判定は別に、server-bound key、attestation、pinning、session issuanceのうち何が標準機構で何が端末/銀行登録に拘束され、独自client再現にどのauthorityと実験が不足するかを説明できることである。拘束が確認されても調査を打ち切らず、回避せずに難度根拠として記録する。

### セッション再利用

`mnie` は認証後のCookieとトップページのフォーム状態をexport/importし、口座一覧への遷移でフォームトークンを更新できる。これは「一度承認したセッション内の複数回収集」が可能である強い根拠になる。一方、次は未確認である。

- 無操作時のサーバー側セッション寿命
- keep-aliveを行った場合の最大寿命
- IP、TLSフィンガープリント、User-Agent、リージョン変更時の再認証条件
- 日跨ぎ、コンテナ再起動後、Cloudflare等の共有egressからの再利用可否

公式サイトは「本来想定された利用形態と異なる極端な利用」でSMBCダイレクトを停止する場合があると明記している。常時keep-aliveは避け、低頻度の同期と自然失効後の有人再承認を前提にする。[公式SMBCダイレクト案内](https://www.smbc.co.jp/kojin/direct/)

Koganeで保存するsession capsuleは、`mnie`のexportをそのまま使わない。暗号化したCookieと継続に必要な最小フォーム状態、発行/最終成功時刻、固定User-Agentだけを含め、ログイン暗証、契約番号、認証済みトップHTMLを除外する。同一sessionの処理は直列化し、自然失効時は`interaction_required`へ遷移する。1回の承認後に複数回収集できる可能性は高いが、公式ガイドは無操作で自動終了するとしており、無期限keep-aliveを回避策にしない。

## Akamai / anti-bot

### 確認できた事実

2026-08-26の未認証観測では次を確認した。

- `direct.smbc.co.jp` と `direct3.smbc.co.jp` はそれぞれ `*.edgekey.net` を経て `*.akamaiedge.net` に解決された。
- `https://direct.smbc.co.jp/aib/aibgsjsw5001.jsp` は通常のブラウザUser-Agentによる単発GETへHTTP 200を返した。
- 応答に `X-Akamai-Transformed` と `AKAMAI` ヘッダー、および `_abck`、`bm_sz` Cookieが含まれた。
- 公開ログインHTMLはShift_JISで、未認証の単発GETにJavaScriptチャレンジやCAPTCHAは表示されなかった。
- 公開loginは `JSESSIONID` (`Secure; HttpOnly`)、`DIRECTUUID`、hidden `_TOKEN`/`_FORMID`/`_FRAMEID` を発行し、login pre-stepとして `/loginlogout/LLDLDILnextPreTS` を使う。cookie/tokenの値は保存していない。
- login pageは [Caulis](https://static.fraud-alert.net/Caulis.smbc_v2.min.js) を読み込み、同assetは `p.fraud-alert.net`/`sb.fraud-alert.net`、local session ID、CORS/XHR送信を含む。また `ib.smbc.co.jp` から公開の [RSA](https://ib.smbc.co.jp/js/rsa.js)、[AES](https://ib.smbc.co.jp/js/aes.js)、[password-loader](https://ib.smbc.co.jp/js/pwcload.js) を動的loadする。Safety Pass以前にもsession、anti-bot/risk、credential protectionが別層で存在する。
- 2026-08-31の実口座追試では、WSL/LinuxからNode系の通常`fetch`、Cookie jar、Linux Chrome型User-AgentだけでSafety Pass承認後のログインと残高取得に成功した。ブラウザ実行、Akamai sensor生成、TLS fingerprint偽装、住宅回線egressは使っていない。

したがって、Akamai CDN/edgeの利用は確定である。AkamaiはBot ManagerがCookieとブラウザテレメトリを使って自動リクエストを識別する仕組みを提供している。[Akamai Bot Management docs](https://techdocs.akamai.com/security-ctr/docs/dimensions-new)

### 推測・未確認

- `_abck` と `bm_sz` の組合せから、Akamai Bot Managerまたは同系統の自動化判定が有効である可能性が高い。
- ただし、ログインPOSTや認証後AJAXに対する具体的なWAF/Bot Managerアクション、レート制限、データセンターIPの評価は外部から確定できない。
- 同じ低頻度フローがCloudflare Workers/ContainersやOCIのegressでも継続的に通るか、IP/セッション移動に反応するかは未確認である。ローカルで通ったため、最初からChrome/TLS impersonationを組み込む根拠はない。

## APKと静的解析

公式の公開入手経路はGoogle Playであり、銀行サイトから直接配布される単体APKは確認できなかった。[公式Playページ](https://play.google.com/store/apps/details?id=jp.co.smbc.direct) は package `jp.co.smbc.direct`、developer `SUMITOMO MITSUI BANKING CORPORATION`、更新日 2026-08-12 を表示した。

2026-08-31に第三者APKPure再配布の12.8.0 (`versionCode 593`)候補を取得し、実行せず静的解析した。base、ARM64、MDPI splitは同一SMBC signerでv2/v3署名を検証できた。Google source-stamp metadataは存在したがローカル`apksig`ではverifiedにならず、現行Google Play配布物とのbyte identityは未確認である。この来歴の限界を維持し、実行用の公式物とは扱わない。

JADX 1.5.6は28,925 classを処理し514 error、34,920 source fileを生成した。Safety PassのDTO、QR承認fragment、Keystore/BiometricPrompt署名use case、Transmit Security pre/post login、attestation payload、root検知は読めた。apktool 2.7.0-dirtyはtarget SDK 36のresource table decodeを大量に誤り中止したため、partial treeを成果物にしていない。

候補XAPK、split hash、signer、再構成/再解析手順、JADX出力はprivate `risu729/android-app-decompiled`の`android/smbc/12.8.0/`に保存した。資格情報、認証済み通信、account dataは含まない。次のprovenance強化は、所有端末のPlay配布splitを`adb pull`し、version、hash、signerを候補と照合することである。

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

### Kogane Workers PoC live result（2026-09-01）

`poc/smbc-direct-backfill-worker`へ、`mnie`をruntime dependencyにせず必要なread-only login、円普通預金残高、月次明細、logoutだけを分離した。Cloudflare AccessでUIを保護し、QR challengeと認証済みsessionをDurable ObjectへAES-256-GCM暗号化保存、raw Shift_JIS JSON・normalized JSON・manifestをprivate R2へ保存する。開始日/終了日はclientから受け付けず、Web通帳の最古日2019-01-01から日本時間の実行当日までを常に月単位で走査する。

同一code・credentialsでegressだけを比較した結果:

| Egress | Login pre-step | 判定 |
| --- | --- | --- |
| 通常のWorkers `fetch()` | HTTP 200だがSMBC `ERRINFO` form | Safety Pass challengeへ進めない |
| 既存TAMIA Tunnelを直接指定したVPC bindingの`fetch()` | `BCATBCA` formとSafety Pass QR生成 | 採用 |

`direct.smbc.co.jp`と`direct3.smbc.co.jp`だけをcode上のexact allowlistに固定して`TAMIA.fetch()`へ渡す。任意host、client指定destination、Tailscale、hostname route、Container、Browser Renderingは使わない。これは通常のWorkers TLS/HTTP fingerprintを家庭回線側へ移す経路であり、Chrome fingerprintを保存するopaque TCP bridgeではないが、SMBC Directの今回のHTTP flowには十分だった。

実口座では最初のSafety Pass sessionが48/93か月で`TPALTOP` formを失い、3回のbounded retry後にpartialとなった。取得済み48か月、188明細、98 artifactはR2に残した。新しいQR承認後、同じRun IDとartifact集合を保って49か月目から再開し、最終的に次をR2 manifestで確認した。

- status `success`
- 93/93 monthly chunks（2019-01-01から2026-09-01）
- 1,069 transactions
- 188 data artifacts + manifest
- failure code 0
- official logout success

したがって、1回のSafety Pass承認で30年相当を必ず完走できるとは扱わず、partial stateを保持して次の手動QR承認から未取得月を再開する必要がある。再開時に既存month objectを再取得・上書きせず、全chunk完了後だけ最終statusをsuccessにする。

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
| Cloudflare Workers + TAMIA VPC binding | 5/5 | Node互換、Shift_JIS、Cookie jar、暗号化DO、R2、Access、QR再承認後resumeを実口座で完走確認。通常Workers egressだけではSMBC `ERRINFO` |

採用PoCはCloudflare Workers + 既存TAMIA VPC bindingである。収集処理は1 Access identity・1 Durable Object・1実行に直列化し、同じセッションを複数runから同時使用しない。通常Workers egress失敗とTAMIA成功のA/Bが取れたため、2つのSMBC hostだけをTAMIAへ固定する。

## コストと自動化見込み

| 案 | 実装コスト | 自動化レベル | データ範囲 | 判断 |
| --- | ---: | --- | --- | --- |
| `mnie`を安全化して普通預金を取得 | 3/5 | 初回/再ログインは有人、認証後は自動 | 普通預金残高・期間明細 | **採用候補** |
| Safety Pass正規承認orchestrator | 3/5 | QR提示・完了pollは自動、生体承認は常に有人 | 認証済みWeb session | **推奨**。公式アプリを変更しない |
| Webブラウザで公式CSVを取得 | 3/5 | アプリ承認は有人、その後は自動 | Web通帳普通・外貨等、画面が対応する科目 | 検算・fallbackとして有用 |
| Web内部プロトコルを複数口座・外貨・定期へ拡張 | 4/5 | 認証後は自動 | 口座一覧、複数科目、預入ロット | 普通預金MVP後に実施 |
| 公式アプリをUI自動化 | 5/5 | 生体認証で有人、端末保守も必要 | アプリ表示全般 | 非推奨 |
| Safety Passを公式手順で解除 | 1/5 | 資格情報ログインが継続する間は完全無人 | Webで読める範囲 | 唯一の直接的な完全無人案だが、明示的なsecurity downgradeと設定変更。既定では不採用 |
| Safety Pass登録端末/profileをコピー | 5/5以上 | 不成立 | 認証機構 | Keystore秘密鍵がnon-exportableかつ毎回生体認証。**不採用** |
| 専用Android emulator | 5/5以上 | 生体/attestationで無人化できない | アプリ表示全般 | Keystore、BiometricPrompt、Transmit attestation、root検知があり、serverless経路にならない |
| 契約済みaggregator API | Kogane側1/5 | 高い | 広い | 方針により不採用 |
| 個人向け公式外部連携token | Kogane側1/5 | 高い | 残高・明細等 | 仕組みは理想的だが、production接続は契約済み電子決済等代行業者に限定。self-service tokenなし |
| [LINE残高照会](https://www.smbc.co.jp/sns/line/service.html) | 2/5 | 初回連携後は一定期間無人 | 主口座、直近1週間・最大100件という公開仕様 | 現行提供をlive確認してから補助候補。完全ledger/backfillには不足 |
| [店番号・口座・キャッシュカード暗証の残高照会](https://direct3.smbc.co.jp/aib/aibgsjsw1k12.jsp) | 1/5 | 高い | 現在残高のみ | 一部利用者は制限、明細なし。暗証保存を増やすため不採用 |
| [メール/push通知](https://www.smbc.co.jp/kojin/direct/service/resources/pdf/goriyou_tebiki.pdf?version=260601)の取込 | 2/5 | 高い | 振込入金や引落予定など一部event | Global Service/SMBC Debit等の除外があり補助sourceに限定 |

## 推奨方針

1. `mnie`の普通預金フローを参考に、Kogane用の**読み取り専用**SMBCダイレクトクライアントを分離する。
2. ログイン資格情報をSecret Managerから都度読む。セッションartifactにはログイン暗証を含めない。
3. QR/deep linkをユーザーへ表示し、公式三井住友銀行アプリでの承認完了をポーリングする。承認が必要なら収集を失敗扱いにせず`interaction_required`にする。
4. 口座一覧、普通預金残高、期間指定明細だけを許可リスト化する。振込・振替・振込先・手数料画面は実装しない。
5. 公式CSVを同期間で取得し、件数、入出金合計、末尾残高を照合する。rawの公式JSON/CSVと取得時刻、対象期間を証拠として保存する。
6. サーバー側セッションを低頻度で再利用するが、常時keep-aliveはしない。失効時は再承認する。
7. 普通預金が安定してから、トップページの口座一覧解析、複数口座、外貨、定期預入明細を別PRで追加する。

完全無人を必須にする場合の選択肢は、ユーザーが明示的にSafety Passを解除するか、方針を変更して契約済みaggregatorを利用するかの実質2つである。前者は設定変更とsecurity downgrade、後者は第三者依存であるため、現方針では**有人承認を稀なinteractionとして扱い、その間の同期をsession再利用で自動化する**。

## 次の検証手順

実装PRでは次を、読み取り専用かつ実口座情報をコミット・ログへ残さず検証する。

1. 7時以降の通常サービス時間に、2026-08-31と同じ読み取り専用フローで1か月明細が取得できることを確認する。ログインとJPY残高までは確認済み。
2. Web通帳のCSVを1か月分だけ手動取得し、列、文字コード、明細ID相当の有無、摘要、残高粒度を確認する。
3. Kogane用isolated clientへ、確認済みのlogin、Safety Pass poll、残高、明細だけを移植する。`mnie` packageを依存または再利用せず、振込関連routeを含めない。
4. JSONと公式CSVの件数、入金合計、出金合計、期末残高を照合する。
5. keep-aliveなしで、15分、1時間、翌日の順にexport/importの有効性を測る。失効を検知したら再ログイン要求へ落とす。
6. 同一セッションをローカルとOCIのそれぞれで新規作成し、AkamaiによるHTTP 403/429、チャレンジ、Cookie追加、IP変更時の失効を記録する。セッションを環境間で移動して検証しない。
7. 口座一覧に普通預金以外がある場合は、科目名とmasked identifierだけを記録し、次の専用PRで外貨・定期のread endpointを調査する。
8. 所有端末のPlay配布splitを正規取得し、12.8.0候補のversion/hash/signerと照合する。第三者候補の静的解析自体は完了済み。
9. 本人が未改変公式appで既存Safety Pass loginを行う間だけ、read-only runtime metadataを観測し、challenge発行、app承認、Web poll、session rotationの順序を値なしで記録する。write endpoint、登録/解除、取引承認へ遷移しない。
10. static/runtimeの結果から「標準Android APIで再現可能」「銀行側登録またはnon-exportable keyに拘束」「server attestationで拘束」「不明」をcomponent単位で判定し、次に必要な正規実験を列挙する。回避実験へは進まない。

## 未確認事項

- 現行セッションの無操作・絶対時間上限と、48か月地点の失効が時間・request数・別条件のどれに依存するか
- TAMIA経由での日次増分取得を長期運用した場合の429、追加認証、session寿命
- 実際の複数サービス利用口座一覧を返す内部endpointと、安定した口座識別子
- 定期・積立の預入ロット項目と履歴保存期間
- 外貨CSV/内部JSONの通貨、小数桁、適用レート、取引後残高の正確なschema
- Web通帳の貯蓄預金について、現行FAQと旧ヘルプで異なる履歴期間の実挙動
- 公式Play配布物と12.8.0第三者候補のbyte/hash identity
- Safety Pass EC鍵がTEE/StrongBoxでhardware-backedか、銀行側の公開鍵登録payload
- challenge-responseの署名algorithm/canonicalization、有効期限、一回性、リプレイ防止、鍵rotation
- Transmit Security attestationの適用条件と、Google Play Integrity等の追加層の有無
